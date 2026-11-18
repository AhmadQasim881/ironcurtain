/**
 * TLS-terminating MITM proxy for Docker agent sessions.
 *
 * Replaces the passthrough CONNECT proxy with one that:
 * 1. Terminates TLS using per-host certs signed by the IronCurtain CA
 * 2. Filters HTTP requests to allowed LLM API endpoints only
 * 3. Swaps fake sentinel API keys for real ones before forwarding, strips
 *    every other credential carrier, and answers a request that presents a
 *    credential other than the sentinel (or none, on an endpoint that needs
 *    one) with a local 401 (see ./provider-credentials.ts)
 * 4. Sanitizes completion request bodies (provider-hosted tools, connectors,
 *    URL-sourced content; see ./request-sanitizers), decoding a compressed
 *    body first, and answers a body it cannot sanitize locally instead of
 *    forwarding it
 * 5. Streams SSE responses without buffering, relaying no hop-by-hop or
 *    `Set-Cookie` response header
 * 6. Admits every completion request against the bundle's host-enforced
 *    token and cost budget before forwarding it (see ./budget-gate.ts)
 * 7. With policy-evaluated egress (opt-in `egressPolicy`), asks the session's
 *    policy engine about every destination that is not a provider or a
 *    registry, as an audited `network/request` decision (see
 *    docs/designs/mitm-egress-policy.md); otherwise admits only approved
 *    passthrough targets (or, under the deprecated
 *    IRONCURTAIN_MITM_ALLOW_ALL_HOSTS, every unknown host)
 *
 * Architecture:
 * - Outer server: http.createServer on UDS, handles CONNECT
 * - Inner server: shared http.createServer (not listening), receives
 *   decrypted connections via emit('connection', tlsSocket)
 */

import * as dns from 'node:dns';
import { ZAI_HOST } from '../config/zai.js';
import * as http from 'node:http';
import * as https from 'node:https';
import * as tls from 'node:tls';
import * as net from 'node:net';
import type { Socket } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { createLeafSecureContextCache, prepareLeafIssuance, type CertificateAuthority } from './ca.js';
import {
  armUpstreamDeadlines,
  assertRequestBodyLimit,
  BufferedBodyBudget,
  createSerialRunner,
  DecryptedConnectionMonitor,
  DEFAULT_MAX_REQUEST_BODY_BYTES,
  describeByteSize,
  drainRequestBody,
  isUpstreamTimeoutError,
  readRequestBody,
  resolveMitmResourceLimits,
  writeRequestRefusal,
  type MitmResourceLimits,
  type RequestBodyRead,
} from './mitm-resource-limits.js';
import {
  isCapturableEndpoint,
  isEndpointAllowed,
  resolveProviderCompletionEndpoint,
  resolveRequestSanitizer,
  shouldRewriteBody,
  validateUnauthenticatedEndpoints,
  type AgentKind,
  type ProviderConfig,
} from './provider-config.js';
import {
  applyProviderCredential,
  credentialRejectionBody,
  injectRealKey,
  redactCredentialQuery,
} from './provider-credentials.js';
import {
  clearContentEncoding,
  decodeRequestBody,
  describeLabels,
  isDecodeBudgetExhaustedError,
  isRequestRejectedError,
  parseJsonObjectBody,
  parseRequestContentCoding,
  processParsedRequestBody,
  rejectionResponseBody,
  sanitizeRequestHeaders,
  type ProcessedRequestBody,
  type RequestContentCoding,
  type RequestRejectedError,
} from './request-sanitizers/index.js';
import type { OAuthTokenManager } from './oauth-token-manager.js';
import type { RegistryConfig, PackageValidator, AllowedVersionCache } from './package-types.js';
import { DENY_ALL_VALIDATOR } from './package-validator.js';
import { RegistryMetadataBudget } from './registry-metadata-budget.js';
import { NpmPublishTimeCache } from './registry-metadata.js';
import {
  DEFAULT_PASSTHROUGH_PORT,
  formatPassthroughTarget,
  validateDomain,
  validatePassthroughPort,
  type DomainListing,
} from './proxy-tools.js';
import {
  canonicalizeHostname,
  classifyHostLiteral,
  isLocalOrMetadataHostname,
  isMetadataHostname,
  screenIpLiteral,
} from '../net/address-policy.js';
import { parseConnectAuthority, parseProxyRequestTarget, type ConnectAuthority } from './proxy-authority.js';
import { isClientHelloError, readClientHello } from './tls-client-hello.js';
import { PassThrough } from 'node:stream';
import { createStreamDelayTransform, parseStreamDelayConfig } from './stream-delay.js';
import { getTokenStreamBus } from './token-stream-bus.js';
import type { SseProvider } from './token-stream-types.js';
import { createTokenStreamConsumer } from './sse-extractor.js';
import * as logger from '../logger.js';
import { OPENROUTER_HOST } from '../config/user-config.js';
import { openRouterWireForPath } from './openrouter.js';
import type { TrajectoryCaptureWriter } from './trajectory-capture.js';
import { beginCaptureExchange, createResponseCaptureInlet, type CaptureExchangeHandle } from './trajectory-tap.js';
import { createDirectOutboundTransport, createGuardedLookup, type OutboundTransport } from './outbound-transport.js';
import {
  connectionNominatedHeaderNames,
  HOP_BY_HOP_HEADERS,
  stripHopByHopRequestHeaders,
} from './hop-by-hop-headers.js';
import { sanitizeResponseHeaders } from './egress-forwarding.js';
import { guardUpstreamResponse, isValidUpstreamStatus } from './upstream-response.js';
import {
  handleRegistryEgressRequest,
  type RegistryEgressGuard,
  type RegistryPullProvenance,
} from './registry-egress-proxy.js';
import { consumeProxyAuthorization, proxyAuthorizedUrl } from './proxy-authorization.js';
import {
  MetricsAttributionRegistry,
  parseMetricsProxyAuthorization,
  type MetricsAttributionHandle,
  type MetricsInvocationContext,
  type MetricsInvocationLease,
} from '../llm-metrics/attribution-registry.js';
import {
  ResponseObservationHub,
  type ResponseObservationConsumer,
} from './llm-observation/response-observation-hub.js';
import { LlmMetricsExchangeObserver } from '../llm-metrics/exchange-observer.js';
import { createBuiltInProtocolRegistry } from '../llm-metrics/protocol-registry.js';
import { getLlmMetricsEventBus } from '../llm-metrics/event-bus.js';
import { DirectGatewayAdapter } from '../llm-metrics/gateways/direct.js';
import { OpaqueGatewayAdapter } from '../llm-metrics/gateways/opaque.js';
import { OpenRouterGatewayAdapter } from '../llm-metrics/gateways/openrouter.js';
import { IronCurtainGatewayAdapter } from '../llm-metrics/gateways/ironcurtain.js';
import type {
  LlmExchangeAttribution,
  LlmExchangeCompleted,
  LlmExchangeRoute,
  LlmGatewayAdapter,
  LlmProtocolId,
} from '../llm-metrics/types.js';
import { validateCompletionEndpoints, type CompletionEndpoint } from './llm-observation/completion-endpoint.js';
import {
  budgetRefusalResponse,
  requestedChoiceCount,
  requestedOutputCap,
  requestedSpeed,
  type BudgetGate,
  type BudgetRefusal,
  type BudgetTicket,
} from './budget-gate.js';
import type { EgressAuthorizer, EgressDecision, EgressRequest } from '../trusted-process/egress-policy.js';

/**
 * Runtime control surface for the MITM proxy's host allowlist.
 *
 * Dynamically approved targets are passthrough-only: no credential
 * replacement and no endpoint filtering. Each approval is scoped to one
 * host AND one port (`host:443` by default, `host:80` on request): a CONNECT
 * or plain-HTTP request to any other port on that host is refused. A 443
 * tunnel is relayed only once the client's TLS ClientHello names the
 * approved host in its SNI, and a port-80 tunnel is served as HTTP with the
 * Host header pinned to the approved host, so an approval cannot be turned
 * into a channel to other tenants of the same CDN edge.
 *
 * Provider and package-registry domains that are already statically
 * configured cannot be added as passthrough. addHost() returns false for
 * these domains, and the tool handler surfaces a clear message to the agent.
 *
 * Under policy-evaluated egress (`MitmProxyOptions.policyEvaluatedEgress`)
 * an approval no longer admits a destination on its own: the session's
 * policy is asked about every request, and an approval (from
 * add_proxy_domain, or a human approving an egress escalation, which lands
 * here too) settles only an escalation (escalate-once), never a policy deny.
 */
export interface DynamicHostController {
  /**
   * Approve a domain for passthrough on one port (default 443; 80 is the
   * only other allowed value). Validates the domain format (no wildcards,
   * no IP addresses, no *.docker.internal, max 253 chars).
   *
   * @throws Error if the domain or the port fails validation.
   * @returns true if the approval was newly added, false if the host is a
   *          static provider or registry, or the approval already exists.
   */
  addHost(domain: string, port?: number): boolean;

  /**
   * Revoke a passthrough approval (default port 443) and destroy every
   * tunnel that was opened under it. Cannot remove statically configured
   * providers or registries.
   *
   * @returns true if the approval was removed, false if not found or static.
   */
  removeHost(domain: string, port?: number): boolean;

  /**
   * List all currently allowed hosts, grouped by type. Dynamic approvals
   * are listed as `host:port`.
   */
  listHosts(): DomainListing;
}

/** Where a started proxy listens, and how its control API is reached. */
export interface MitmProxyAddress {
  socketPath?: string;
  port?: number;
  /** Bound TCP address (TCP mode only): `127.0.0.1` unless `listenHost` said otherwise. */
  host?: string;
  controlSocketPath?: string;
  controlPort?: number;
  /**
   * Per-bundle bearer token every control API request must carry
   * (`Authorization: Bearer <token>`). Present whenever a control endpoint
   * was started; it never leaves the host process except to the virtual
   * proxy-tool relay.
   */
  controlToken?: string;
}

/**
 * Dialer for the raw passthrough tunnel. Production always uses
 * `net.connect`; tests substitute a dialer that reaches a local fixture.
 */
export type TunnelDialer = (options: net.TcpNetConnectOpts) => Socket;

export interface MitmProxy {
  /** Start listening on the UDS or TCP port. Leaf certs are minted lazily on first CONNECT. */
  start(): Promise<MitmProxyAddress>;
  /** Stop the proxy and close all connections. */
  stop(): Promise<void>;
  /** Runtime control for the dynamic host allowlist. */
  readonly hosts: DynamicHostController;
  /**
   * Set (or clear) the session ID that token-stream events extracted from
   * LLM API responses are routed under.
   *
   * The MITM proxy is long-lived in shared-container workflow mode, where
   * multiple per-state agent sessions share a single proxy instance. Token
   * events for the active agent must be labeled with that agent's session
   * ID, not with any static workflow-wide ID. Callers flip this value
   * around each agent run: set to the session's ID before the agent runs,
   * reset to `undefined` when the session ends.
   *
   * When the current session ID is `undefined`, extraction sites skip the
   * `bus.push()` entirely — no events are emitted under a sentinel value.
   */
  setTokenSessionId(id: import('../session/types.js').SessionId | undefined): void;

  /**
   * Internal capture-attribution setter. Sets the session ID stamped on
   * subsequent captured ExchangeRecords. Decoupled from
   * `setTokenSessionId` because token-stream-bus and capture are
   * different code paths that must not corrupt each other.
   *
   * Not called directly by orchestrator code — wrapped by
   * `DockerInfrastructure.beginCaptureSession()` / `endCaptureSession()`.
   * Exposed for unit-testing the proxy in isolation.
   *
   * When `undefined`, no capture record is produced for incoming
   * exchanges (the per-handler snapshot is `undefined`).
   */
  setCaptureSessionId(id: import('../session/types.js').SessionId | undefined): void;

  /**
   * Internal capture-attribution setter. Sets the persona stamped on
   * subsequent captured ExchangeRecords. Wrapped by
   * `DockerInfrastructure.beginCaptureSession()`.
   */
  setCapturePersona(persona: string | undefined): void;

  /** Bind an immutable metrics context to a short-lived proxy credential. */
  beginMetricsInvocation(baseProxyUrl: string, context: MetricsInvocationContext): MetricsInvocationLease;

  /**
   * Attach (or detach) the decider for policy-evaluated egress: the
   * session's coordinator, through `DockerProxy.getEgressAuthorizer()`. Only
   * meaningful with `MitmProxyOptions.policyEvaluatedEgress`; until one is
   * attached, every destination that needs a decision is refused.
   */
  setEgressAuthorizer(authorizer: EgressAuthorizer | undefined): void;
}

export interface MitmProxyOptions {
  /** Absolute path for the Unix domain socket (UDS mode). Omit for TCP mode. */
  readonly socketPath?: string;
  /** TCP port to listen on (0 for OS-assigned). Omit for UDS mode. */
  readonly listenPort?: number;
  /**
   * TCP bind address. Defaults to loopback (`127.0.0.1`): Docker Desktop
   * forwards `host.docker.internal` traffic to the host as loopback, so the
   * tcp-sidecar topology needs nothing wider, and a wider bind would hand
   * every LAN peer the session's proxy. The retained tcp-hostonly topology
   * binds `0.0.0.0` (the vmnet gateway interface does not exist until the
   * first container attaches) and MUST pair that with `allowRemoteAddress`;
   * construction fails closed when a non-loopback bind has no source guard.
   * Ignored in UDS mode.
   */
  readonly listenHost?: string;
  /** CA certificate and key for signing per-host certs. */
  readonly ca: CertificateAuthority;
  /**
   * Provider configurations with real API keys.
   * The proxy uses these for host allowlisting, key swapping, and endpoint filtering.
   */
  readonly providers: readonly ProviderKeyMapping[];

  /**
   * Package registry configurations.
   * When present, the proxy allows CONNECT to registry hosts and
   * validates/filters package metadata and tarball downloads.
   */
  readonly registries?: readonly RegistryConfig[];

  /**
   * Package validation configuration.
   * Only meaningful when registries is non-empty.
   */
  readonly packageValidation?: {
    readonly validator: PackageValidator;
    readonly auditLogPath?: string;
  };
  /**
   * Separate control socket path for domain management API.
   * Must NOT be in a directory mounted into the container.
   */
  readonly controlSocketPath?: string;
  /**
   * Separate control TCP port. Used in TCP mode (macOS).
   * 0 for OS-assigned.
   */
  readonly controlPort?: number;
  /**
   * Custom DNS lookup function for outbound connections.
   * Used in tests to avoid real DNS resolution.
   *
   * Supplying a resolver does NOT relax the destination-address policy: the
   * answers it returns are screened exactly like real ones. A fixture that
   * resolves to loopback must also set `allowPrivateDestinationsForTests`.
   */
  readonly dnsLookup?: http.RequestOptions['lookup'];
  /**
   * Destination-bound upstream transport. Defaults to a direct transport, and
   * every production caller uses a direct one. The fixed parent-proxy
   * implementation is not yet wired: it is reserved for an inner IronCurtain
   * coordinator (docs/designs/ironcurtain-in-ironcurtain-hermetic-slice.md),
   * which would inject it so no request can fall back to direct egress or
   * acquire a caller-selected generic CONNECT tunnel.
   */
  readonly outboundTransport?: OutboundTransport;
  /** Test-only escape hatch for loopback provider and registry fixtures. */
  readonly allowPrivateDestinationsForTests?: boolean;
  /**
   * Test-only dialer for the raw passthrough tunnel, so a fixture on an
   * ephemeral loopback port can stand in for `host:443`. Production always
   * dials with `net.connect`; the option is rejected outside NODE_ENV=test.
   */
  readonly tunnelDialForTests?: TunnelDialer;
  /**
   * Public workload-image registry-egress mode (§6.4). When present, this proxy
   * serves ONLY the nested bundle's `public-registry` image-pull path: it has no LLM
   * providers, package registries, or dynamic passthrough. Every CONNECT is
   * TLS-terminated and every decrypted request is authorized against the frozen
   * registry manifest via the guard, then streamed through `outboundTransport` under
   * per-request / per-session transfer ceilings. Workload image content is untrusted
   * bundle state and is never hashed or verified (§16.6); authority is constrained by
   * URL/operation gating, exact derived-redirect authorization, credential handling,
   * and the ceilings. See `registry-egress-proxy.ts` for the seam design.
   * Production constructs it only for an admitted
   * `public-registry` session; a
   * `preloaded-only` session sets no guard, so registry traffic has no route.
   */
  readonly registryEgress?: {
    readonly guard: RegistryEgressGuard;
    /** Durable provenance sink for completed pulls (the admitted lease's append-only log). */
    readonly recordProvenance?: (record: RegistryPullProvenance) => void;
  };
  /**
   * Connection-source filter for TCP mode. When set, sockets whose
   * remote address fails the predicate are destroyed before any request
   * parsing. Required by the tcp-hostonly topology, where the proxy listens
   * on 0.0.0.0 and only the agent VM's host-only subnet may connect
   * (see src/docker/network-topology.ts); the tcp-sidecar topology pairs
   * its loopback bind with a loopback-only guard as defense in depth. No
   * effect in UDS mode.
   */
  readonly allowRemoteAddress?: (remoteAddress: string | undefined) => boolean;
  /** Exact per-bundle credential required on Docker Desktop's shared host-gateway hop. */
  readonly requiredProxyAuthorization?: string;
  /** Verified sidecar-to-host hop; agent clients still use their internal HTTP proxy. */
  readonly transportTls?: tls.TlsOptions;
  /**
   * Initial session ID for token stream routing. When provided, token
   * events extracted from LLM API endpoints are published into the
   * module-scoped singleton bus (see `getTokenStreamBus`) under this ID.
   *
   * The value is mutable at runtime via `MitmProxy.setTokenSessionId()`:
   * long-lived proxies (shared-container workflows) flip this around each
   * agent so the active agent's session ID is used. When no session ID
   * is set (initial value `undefined` AND no subsequent `setTokenSessionId`
   * call), extraction sites skip publishing entirely.
   *
   * Routinely stale in workflow shared-container mode where the
   * orchestrator overrides via `setTokenSessionId`; the seed is only
   * meaningful in single-session standalone mode.
   */
  readonly initialTokenSessionId?: import('../session/types.js').SessionId;

  /**
   * Execution mode driving this proxy, used by request-body rewriters to
   * apply mode-conditional transforms (currently: stripping the schedule
   * built-in skill's tools for one-shot `batch` and `workflow` agents while
   * preserving them for `pty`). Immutable over the proxy's lifetime — a
   * single bundle serves a single execution mode. `undefined` means rewriters
   * fall back to the most conservative behavior.
   */
  readonly agentKind?: AgentKind;

  /**
   * Trajectory-capture dispatcher. When set, the proxy taps decrypted
   * request and response bytes on allowed LLM API endpoints and hands
   * complete `ExchangeRecord`s to the writer. When `undefined`, no taps
   * are installed and capture is zero-cost. See
   * docs/designs/mitm-token-trajectory-capture.md.
   */
  readonly capture?: TrajectoryCaptureWriter;

  /**
   * Human-readable agent name (e.g. `'claude-code'`) stamped onto every
   * captured ExchangeRecord. Distinct from `agentKind`, which identifies the
   * execution mode used by the request rewriter.
   */
  readonly recordedAgentName?: string;

  /** Workflow-run ID stamped onto every captured ExchangeRecord (when present). */
  readonly workflowRunId?: string;

  /** Bundle ID stamped onto every captured ExchangeRecord (when present). */
  readonly bundleId?: string;

  /** Stable selected provider-profile identity for statistics attribution. */
  readonly providerProfileId?: string;

  /** Injectable for tests; a proxy owns its registry by default. */
  readonly metricsAttributionRegistry?: MetricsAttributionRegistry;

  /** Enables passive in-memory statistics observation/publication. */
  readonly statisticsEnabled?: boolean;

  /**
   * Host-enforced token and cost budget of this proxy's bundle (see
   * `budget-gate.ts`). Every completion request is admitted against it
   * before it is forwarded, whatever proxy credential it carries, and its
   * usage is observed for the gate whether or not `statisticsEnabled` is set
   * (exchange records reach the statistics bus only when it is). Absent: no
   * budget (proxies built directly, as in tests).
   */
  readonly budgetGate?: BudgetGate;

  /**
   * Overrides for this proxy's per-bundle resource ceilings and deadlines
   * (see `DEFAULT_MITM_RESOURCE_LIMITS` in mitm-resource-limits.ts). Production
   * uses the defaults; tests shrink them to exercise the limits quickly.
   */
  readonly resourceLimits?: Partial<MitmResourceLimits>;

  /**
   * Policy-evaluated egress (opt-in `egressPolicy.enabled`; see
   * docs/designs/mitm-egress-policy.md). Every destination that is neither
   * a configured provider nor a package registry is decided by the
   * attached {@link EgressAuthorizer} (the session's policy engine, as a
   * `network/request` call): a CONNECT at host:port, every request the
   * proxy can read (absolute-form plain HTTP, `ws://` upgrades, requests
   * inside a port-80 tunnel or a TLS-terminated nested passthrough) at path
   * granularity. Each decision is audited by the coordinator. Admitted 443
   * tunnels stay SNI-pinned and port-80 tunnels Host-pinned.
   * `IRONCURTAIN_MITM_ALLOW_ALL_HOSTS` is ignored while this is on. Only the
   * standard listener mode has passthrough, so the egress listener modes
   * ignore it.
   */
  readonly policyEvaluatedEgress?: boolean;
}

export interface ProviderKeyMapping {
  readonly config: ProviderConfig;
  /** The fake sentinel key given to the container. */
  readonly fakeKey: string;
  /** The real API key to inject in upstream requests. Mutable for token refresh. */
  realKey: string;
  /** Optional token manager for OAuth providers — enables proactive refresh and 401 retry. */
  readonly tokenManager?: OAuthTokenManager;
}

/**
 * The single mode this proxy's listener operates in for its entire lifetime.
 *
 * `createMitmProxy` resolves exactly one of these once at construction (see
 * `resolveListenerMode`) and reads it from the closure at every dispatch site.
 * Connection metadata does not echo the mode — the listener-level mode is
 * fixed, so per-connection routing only distinguishes hosts within `standard`.
 *
 * - `standard`: normal proxy; per-connection routing picks provider /
 *   package-registry / dynamic-passthrough by host.
 * - `registry-egress`: serves ONLY the `public-registry` image-pull path;
 *   TLS-terminates every host and authorizes decrypted pulls via `guard`.
 */
type ListenerMode =
  | { readonly kind: 'standard' }
  | {
      readonly kind: 'registry-egress';
      readonly guard: RegistryEgressGuard;
      readonly recordProvenance?: (record: RegistryPullProvenance) => void;
    };

/**
 * Resolve the single listener mode from the proxy options. A proxy without the
 * registry-only mode runs standard provider / package-registry / passthrough routing.
 */
function resolveListenerMode(options: MitmProxyOptions): ListenerMode {
  if (options.registryEgress) {
    return {
      kind: 'registry-egress',
      guard: options.registryEgress.guard,
      ...(options.registryEgress.recordProvenance === undefined
        ? {}
        : { recordProvenance: options.registryEgress.recordProvenance }),
    };
  }
  return { kind: 'standard' };
}

/** Connection reset errors are routine during proxy shutdown or client disconnect. */
function isConnectionReset(err: NodeJS.ErrnoException): boolean {
  return err.code === 'ECONNRESET' || err.code === 'EPIPE';
}

/** TCP bind used unless `MitmProxyOptions.listenHost` says otherwise. */
export const DEFAULT_MITM_LISTEN_HOST = '127.0.0.1';

/** True for a bind address only the host itself can reach. */
function isLoopbackListenHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || (net.isIPv4(host) && host.startsWith('127.'));
}

/** The only port a plain-HTTP passthrough approval can name (see ALLOWED_PASSTHROUGH_PORTS). */
const PLAIN_HTTP_PASSTHROUGH_PORT = 80;

/**
 * How long a client of an SNI-pinned passthrough tunnel has to present a
 * complete TLS ClientHello after the CONNECT was acknowledged. Mirrors the
 * MITM path's TLS handshake timeout.
 */
const CLIENT_HELLO_TIMEOUT_MS = 10_000;

/** Attacker-controlled text for a log line: escaped, bounded, never raw. */
function describeForLog(value: string): string {
  return JSON.stringify(value.length > 200 ? `${value.slice(0, 200)}…` : value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Answer the client for an upstream request that failed: 504 when the proxy
 * aborted it on a deadline, 502 otherwise. Once the response has started the
 * only honest signal left is to drop the connection.
 */
function answerUpstreamFailure(clientRes: http.ServerResponse, err: Error): void {
  if (clientRes.headersSent) {
    clientRes.socket?.destroy();
    return;
  }
  const timedOut = isUpstreamTimeoutError(err);
  const body = `${timedOut ? 'Upstream timeout' : 'Upstream error'}: ${err.message}`;
  clientRes.writeHead(timedOut ? 504 : 502, {
    'Content-Type': 'text/plain',
    'Content-Length': Buffer.byteLength(body),
  });
  clientRes.end(body);
}

/** Release hooks for the per-bundle resources one admitted exchange holds. */
interface ExchangeScope {
  /** True once the exchange has ended: its response was sent, or the client went away. */
  readonly ended: boolean;
  /** Run `callback` when the exchange ends (at once if it already has). */
  onEnd(callback: () => void): void;
}

/**
 * The scope of one exchange, which ends when its response closes: after it is
 * sent, or when the connection drops (Node emits `close` on a queued pipelined
 * response too). A hook registered after that runs at once, so a resource
 * acquired late (after an await) is still released.
 */
function exchangeScope(clientRes: http.ServerResponse): ExchangeScope {
  const callbacks: (() => void)[] = [];
  let ended = clientRes.destroyed;
  clientRes.once('close', () => {
    ended = true;
    for (const callback of callbacks.splice(0)) callback();
  });
  return {
    get ended() {
      return ended;
    },
    onEnd(callback) {
      if (ended) callback();
      else callbacks.push(callback);
    },
  };
}

/** Max Content-Length for which we buffer solely for 401 retry (1 MB). */
const MAX_RETRY_BODY_BYTES = 1 * 1024 * 1024;
/** Raw-socket answer to a CONNECT or upgrade refused at a per-bundle connection ceiling. */
const RAW_SERVICE_UNAVAILABLE = 'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n';
/** Retry-After hint on a request refused at a per-bundle ceiling; the condition clears as exchanges finish. */
const BUSY_RETRY_AFTER_SECONDS = 1;
const MAX_METRICS_REQUEST_OBSERVATION_BYTES = 8 * 1024 * 1024;

/** A response header as one string (repeated values comma-joined), '' when absent. */
function headerText(value: string | readonly string[] | undefined): string {
  return typeof value === 'string' ? value : (value?.join(',') ?? '');
}

/**
 * Response observation could not be set up for this exchange. Metrics
 * failures stay local to metrics: the response is forwarded unchanged and the
 * record settles as explicitly partial.
 */
function failMetricsResponseSetup(observer: LlmMetricsExchangeObserver, status: number): void {
  try {
    observer.markResponseObservationUnavailable(status, 'response_observer_setup_failed');
  } catch {
    observer.abort('response_observer_setup_failed');
  }
}

interface MetricsGatewaySelection {
  readonly adapter: LlmGatewayAdapter;
  readonly kind: LlmExchangeRoute['gatewayKind'];
}

function normalizeMetricsHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, '');
}

function officialProviderForOrigin(protocol: LlmProtocolId, host: string): string | null {
  const normalized = normalizeMetricsHost(host);
  if (
    normalized === ZAI_HOST &&
    ['anthropic-messages', 'openai-chat-completions', 'openai-responses'].includes(protocol)
  )
    return 'zai';
  if (protocol === 'anthropic-messages' && normalized === 'api.anthropic.com') return 'anthropic';
  if (protocol === 'openai-responses' && (normalized === 'api.openai.com' || normalized === 'chatgpt.com')) {
    return 'openai';
  }
  if (protocol === 'openai-chat-completions' && normalized === 'api.openai.com') return 'openai';
  if (protocol === 'google-generate-content' && normalized === 'generativelanguage.googleapis.com') return 'google';
  return null;
}

function selectMetricsGateway(
  config: ProviderConfig,
  protocol: LlmProtocolId,
  clientHost: string,
): MetricsGatewaySelection {
  // Generic base-URL overrides are opaque even when they preserve the client
  // protocol. A future trusted route must be an explicit provider config, not
  // inferred from its hostname or response claims.
  if (config.upstreamTarget) return { adapter: new OpaqueGatewayAdapter(), kind: 'opaque' };
  if (config.gatewayAdapterId === 'openrouter' && normalizeMetricsHost(clientHost) === OPENROUTER_HOST) {
    return { adapter: new OpenRouterGatewayAdapter(), kind: 'openrouter' };
  }
  if (config.gatewayAdapterId === 'zai' && normalizeMetricsHost(clientHost) === ZAI_HOST)
    return { adapter: new DirectGatewayAdapter({ providerId: 'zai', officialOrigin: true }), kind: 'direct' };
  if (config.gatewayAdapterId === 'ironcurtain') {
    return { adapter: new IronCurtainGatewayAdapter(), kind: 'ironcurtain' };
  }
  const officialProvider = officialProviderForOrigin(protocol, clientHost);
  if (config.gatewayAdapterId === 'direct' && officialProvider !== null) {
    return {
      adapter: new DirectGatewayAdapter({ providerId: officialProvider, officialOrigin: true }),
      kind: 'direct',
    };
  }
  return { adapter: new OpaqueGatewayAdapter(), kind: 'opaque' };
}

function fallbackMetricsAttribution(bundleId: string | undefined): LlmExchangeAttribution {
  return Object.freeze({
    sessionId: null,
    agentConversationId: null,
    turnId: null,
    bundleId: bundleId ?? null,
    workflowRunId: null,
    stateId: null,
    personaId: null,
    agentId: null,
    quality: bundleId ? 'bundle_only' : 'unattributed',
  });
}

/** A small JSON body parsed for read-only facts, or undefined when it is not JSON. */
function parseJsonOrUndefined(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Tells the budget ticket when an upstream attempt's connection is
 * established, so the request may have reached the provider. A request that
 * fails before that (DNS, address policy, connection refused, TLS handshake)
 * reached no provider and is not charged. A reused keep-alive socket, or one a
 * custom agent hands over already connected, counts at once.
 */
function trackUpstreamDelivery(request: http.ClientRequest, ticket: BudgetTicket, useTls: boolean): void {
  request.once('socket', (socket: Socket) => {
    if (request.reusedSocket || !socket.connecting) {
      ticket.markDelivered();
      return;
    }
    socket.once(useTls ? 'secureConnect' : 'connect', () => ticket.markDelivered());
  });
}

/**
 * Buffers the entire request body into a single Buffer.
 * Rejects (and destroys the request) if the body exceeds maxBytes.
 *
 * Used only by the host-side control API (4 KiB cap), where destroying the
 * connection on overflow is fine. Agent-facing requests are read with
 * `readRequestBody` (mitm-resource-limits.ts), which answers a clean 413.
 */
function bufferRequestBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error(`Request body exceeds ${maxBytes} bytes`));
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Maps a target hostname (and, for OpenRouter, request path) to the SSE
 * provider for token stream parsing. Anthropic and OpenAI hosts classify by
 * host alone; `openrouter.ai` serves three wire formats depending on path, so
 * `/api/v1/messages` (the Anthropic skin) is 'anthropic' and every other path
 * is 'openai'. Everything else falls back to 'unknown'.
 */
export function resolveSseProvider(hostname: string, path?: string): SseProvider {
  if (hostname === 'api.anthropic.com' || hostname === 'platform.claude.com') {
    return 'anthropic';
  }
  if (hostname === 'api.openai.com') {
    return 'openai';
  }
  if (hostname === ZAI_HOST) return path?.split('?')[0].endsWith('/v1/messages') ? 'anthropic' : 'openai';
  if (hostname === OPENROUTER_HOST) {
    return openRouterWireForPath(path) === 'anthropic' ? 'anthropic' : 'openai';
  }
  return 'unknown';
}

/** Maximum characters for tool_result content before truncation. */
const MAX_TOOL_RESULT_CONTENT_LEN = 500;

/**
 * Upstream port for registry forwarding. The registry proxy always re-originates
 * TLS to the real mirror (`forwardReadOnly` and its metadata fetches request
 * `https:`), so registry traffic reaches upstream over HTTPS regardless of the
 * client-side transport. apt speaks plain HTTP on :80, but the upstream fetch
 * must still target :443 — forwarding the client's :80 here would point the TLS
 * request at a non-TLS port and 502 every allowed package and metadata request.
 */
const REGISTRY_UPSTREAM_HTTPS_PORT = 443;

/**
 * Registry mode accepts only a canonical DNS `host:decimal-port` authority
 * (no IP literals, no IDNA mapping). The ordinary proxy uses the strict
 * `parseConnectAuthority` instead; both boundaries run before any CONNECT
 * acknowledgement or certificate generation.
 */
function parseRegistryConnectAuthority(authority: string): ConnectAuthority | undefined {
  const match = /^([^:]+):([1-9][0-9]{0,4})$/u.exec(authority);
  if (match === null) return undefined;
  const hostname = match[1];
  if (hostname.length > 253) return undefined;
  const labels = hostname.split('.');
  if (labels.some((label) => label.length > 63 || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(label))) {
    return undefined;
  }
  const port = Number(match[2]);
  if (!Number.isSafeInteger(port) || port > 65_535) return undefined;
  return { host: hostname.toLowerCase(), port, isIpLiteral: false };
}

/** Truncate tool result content to MAX_TOOL_RESULT_CONTENT_LEN, appending ellipsis if needed. */
function truncateToolResult(text: string): string {
  return text.length > MAX_TOOL_RESULT_CONTENT_LEN ? text.slice(0, MAX_TOOL_RESULT_CONTENT_LEN) + '\u2026' : text;
}

/** Returns true for LLM messages endpoints that carry multi-turn request bodies. */
function isLlmMessagesEndpoint(path: string): boolean {
  const p = path.split('?')[0];
  return (
    p === '/api/anthropic/v1/messages' ||
    p === '/api/paas/v4/chat/completions' ||
    p === '/api/coding/paas/v4/chat/completions' ||
    p === '/v1/messages' ||
    p === '/v1/chat/completions' ||
    // OpenRouter paths (one host, three wire formats — §11.3).
    p === '/api/v1/messages' ||
    p === '/api/v1/chat/completions' ||
    p === '/api/v1/responses'
  );
}

/**
 * Extract tool_result blocks from a parsed Anthropic/OpenAI request body
 * and push them as TokenStreamEvents to the bus.
 *
 * Anthropic format: messages[].role === 'user', content[].type === 'tool_result'
 * OpenAI format: messages[].role === 'tool', with tool_call_id
 *
 * Only extracts from the trailing user/tool messages to avoid re-emitting
 * historical tool results (the full conversation history is sent with every request).
 */
function extractTrailingToolMessages(messages: unknown[]): unknown[] {
  // Walk backward from the end to find the contiguous block of
  // user (with tool_result) and tool messages at the tail.
  const trailing: unknown[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (typeof msg !== 'object' || msg === null) break;
    const role = (msg as Record<string, unknown>)['role'];
    if (role === 'user' || role === 'tool') {
      trailing.push(msg);
    } else {
      break;
    }
  }
  trailing.reverse();
  return trailing;
}

export function extractToolResults(
  parsed: Record<string, unknown>,
  sessionId: import('../session/types.js').SessionId,
): void {
  const messages = parsed['messages'];
  if (!Array.isArray(messages)) return;

  // Fetch the singleton bus lazily so `resetTokenStreamBus()` between tests
  // is honored at call time (not import time).
  const bus = getTokenStreamBus();
  const now = Date.now();

  // Only extract from the LAST user/tool messages to avoid re-emitting
  // historical tool results from earlier turns (the full conversation
  // history is sent with every API request).
  const lastMessages = extractTrailingToolMessages(messages);

  for (const msg of lastMessages) {
    if (typeof msg !== 'object' || msg === null) continue;
    const record = msg as Record<string, unknown>;

    // Anthropic format: role=user, content array with tool_result blocks
    if (record['role'] === 'user') {
      const content = record['content'];
      if (!Array.isArray(content)) continue;

      for (const block of content) {
        if (typeof block !== 'object' || block === null) continue;
        const b = block as Record<string, unknown>;
        if (b['type'] !== 'tool_result') continue;

        const toolUseId = typeof b['tool_use_id'] === 'string' ? b['tool_use_id'] : '';
        const isError = b['is_error'] === true;
        const rawContent = b['content'];
        let text = '';
        if (typeof rawContent === 'string') {
          text = rawContent;
        } else if (Array.isArray(rawContent)) {
          // Content can be an array of {type: 'text', text: '...'} blocks
          const parts: string[] = [];
          for (const part of rawContent) {
            if (typeof part === 'object' && part !== null && (part as Record<string, unknown>)['type'] === 'text') {
              const t = (part as Record<string, unknown>)['text'];
              if (typeof t === 'string') parts.push(t);
            }
          }
          text = parts.join('\n');
        }

        text = truncateToolResult(text);

        bus.push(sessionId, {
          kind: 'tool_result',
          toolUseId,
          toolName: '',
          content: text,
          isError,
          timestamp: now,
        });
      }
      continue;
    }

    // OpenAI format: role=tool, content is a string
    if (record['role'] === 'tool') {
      const toolCallId = typeof record['tool_call_id'] === 'string' ? record['tool_call_id'] : '';
      let text = typeof record['content'] === 'string' ? record['content'] : '';
      const isError = false; // OpenAI doesn't have an is_error field

      text = truncateToolResult(text);

      bus.push(sessionId, {
        kind: 'tool_result',
        toolUseId: toolCallId,
        toolName: '',
        content: text,
        isError,
        timestamp: now,
      });
    }
  }
}

export function createMitmProxy(options: MitmProxyOptions): MitmProxy {
  for (const provider of options.providers) {
    validateCompletionEndpoints(provider.config.completionEndpoints ?? [], provider.config.allowedEndpoints);
    if (provider.config.maxRequestBodyBytes !== undefined) {
      assertRequestBodyLimit(provider.config.maxRequestBodyBytes, `${provider.config.host} maxRequestBodyBytes`);
    }
    validateUnauthenticatedEndpoints(provider.config);
  }
  // Per-bundle resource ceilings (MITM-14); one proxy instance serves one bundle.
  const limits = resolveMitmResourceLimits(options.resourceLimits);

  const metricsAttributionRegistry = options.metricsAttributionRegistry ?? new MetricsAttributionRegistry();
  const metricsProtocolRegistry = createBuiltInProtocolRegistry();
  const statisticsEnabled = options.statisticsEnabled === true;
  const budgetGate = options.budgetGate;
  // Token stream extractor installation is gated on `tokenSessionId`.
  // This is a mutable per-proxy value that callers flip around each
  // active agent (see `setTokenSessionId` on the returned handle). When
  // `undefined`, all extractor-install sites skip `bus.push()` entirely
  // — no sentinel value is published. The module-scoped singleton bus is
  // fetched lazily at each push site so `resetTokenStreamBus()` between
  // tests is honored.
  let tokenSessionId: import('../session/types.js').SessionId | undefined = options.initialTokenSessionId;

  /**
   * Capture-attribution session ID. Decoupled from `tokenSessionId` so
   * a future extractor-related flip cannot reattribute in-flight
   * captured exchanges. See §11 in the capture design.
   */
  let captureSessionId: import('../session/types.js').SessionId | undefined;
  /** Persona stamped onto subsequent captured ExchangeRecords. */
  let capturePersona: string | undefined;

  const agentKind: AgentKind | undefined = options.agentKind;
  const listenerMode = resolveListenerMode(options);
  const captureWriter = options.capture;
  const captureRecordedAgentName = options.recordedAgentName;
  const captureWorkflowRunId = options.workflowRunId;
  const captureBundleId = options.bundleId;
  // The resolver seam and the address policy are independent options: a test
  // may substitute a resolver without silently disabling the check that its
  // answers are public. Relaxing the policy takes its own explicit opt-in.
  const allowPrivateDestinations = options.allowPrivateDestinationsForTests === true;
  const dnsLookup = options.dnsLookup as typeof dns.lookup | undefined;
  const outboundTransport =
    options.outboundTransport ??
    createDirectOutboundTransport({
      lookup: dnsLookup,
      allowPrivateDestinationsForTests: allowPrivateDestinations,
    });
  // A transport this proxy creates is closed with it (its keep-alive pools); an
  // injected one belongs to the caller.
  const ownsOutboundTransport = options.outboundTransport === undefined;
  /**
   * Address screen for the raw passthrough tunnel, which bypasses the
   * destination-bound transport entirely. Without it a passthrough host that
   * resolves to a private or link-local address would be tunneled straight
   * into the host network.
   */
  const passthroughLookup = createGuardedLookup(dnsLookup ?? dns.lookup, allowPrivateDestinations);
  if (options.tunnelDialForTests !== undefined && process.env.NODE_ENV !== 'test') {
    throw new Error('MitmProxyOptions.tunnelDialForTests is only available under NODE_ENV=test');
  }
  const tunnelDial: TunnelDialer = options.tunnelDialForTests ?? ((connectOptions) => net.connect(connectOptions));

  // Hostnames are case-insensitive (RFC 1035 §2.3.3, RFC 7230 §5.4) and have
  // several equivalent spellings (trailing dot, IDNA). One canonical form
  // (`canonicalizeHostname`: lowercase, no trailing dot, ASCII) is used at
  // every storage and lookup site so the allowlist cannot be bypassed by a
  // spelling variant: `CONNECT API.TEST.COM:443` or `api.test.com.:443` while
  // the provider is registered as `api.test.com` must still take the provider
  // path, never an "unknown host" passthrough tunnel. An IP literal keys by
  // its canonical unbracketed address, exactly as the CONNECT parser reports
  // it. Configured hosts that do not canonicalize (which the parsers would
  // refuse anyway) fall back to a lowercase key so construction never fails
  // on them.
  function canonicalHostKey(hostname: string): string {
    const literal = classifyHostLiteral(hostname.trim());
    if (literal.kind === 'ip') return literal.address;
    return canonicalizeHostname(hostname) ?? hostname.trim().toLowerCase();
  }

  // Build host → provider lookup
  const providersByHost = new Map<string, ProviderKeyMapping>();
  for (const mapping of options.providers) {
    providersByHost.set(canonicalHostKey(mapping.config.host), mapping);
  }

  // Dynamically approved passthrough targets, keyed `host:port` (see
  // DynamicHostController): no key swap, no endpoint filtering.
  const passthroughHosts = new Set<string>();

  /**
   * Passthrough is a `standard`-mode-only mechanism, because it forwards
   * without ever consulting a guard. The egress listener modes have no
   * providers and no registries, so `isKnownStaticHost` is false for *every*
   * host there: under `IRONCURTAIN_MITM_ALLOW_ALL_HOSTS` that would make every
   * host wildcard-eligible and hand the nested daemon a raw tunnel around the
   * frozen manifest. Those modes TLS-terminate instead, so an unlisted host
   * reaches the guard and is refused there. No effect on standard mode.
   */
  const passthroughEligible = listenerMode.kind === 'standard';

  /**
   * Policy-evaluated egress (see `MitmProxyOptions.policyEvaluatedEgress`):
   * every passthrough destination is decided by `egressAuthorizer`, and
   * approvals only settle escalations. Standard mode only.
   */
  const policyEgress = options.policyEvaluatedEgress === true && passthroughEligible;
  /** The decider for {@link policyEgress}; undefined until attached, and then every such destination is refused. */
  let egressAuthorizer: EgressAuthorizer | undefined;
  /**
   * Escalate-once memory for human denials, keyed `host:port` like the
   * approvals in `passthroughHosts` (where human approvals land). Cleared
   * for a target an explicit `addHost` approves. Bundle-scoped, like the
   * approvals.
   */
  const deniedEgress = new Set<string>();

  // Deprecated escape hatch: when IRONCURTAIN_MITM_ALLOW_ALL_HOSTS is "1" or
  // "true", any host that is NOT a configured provider or registry is treated
  // as a passthrough tunnel. Known providers/registries still flow through the
  // normal MITM path (TLS termination, credential swap, endpoint filtering) —
  // this flag only widens the catch-all for unknown destinations. Defeats
  // egress filtering for unknown hosts; only use in trusted environments.
  // Superseded by policy-evaluated egress (allowedHosts wildcards, audited,
  // escalate-once), which ignores it; start() prints a deprecation warning
  // either way (on a listener with passthrough, the only kind it affects).
  const allowAllHostsRequested =
    process.env.IRONCURTAIN_MITM_ALLOW_ALL_HOSTS === '1' || process.env.IRONCURTAIN_MITM_ALLOW_ALL_HOSTS === 'true';
  const allowAllHosts = allowAllHostsRequested && !policyEgress;

  // DEBUG (issue #367): optional stream-delay injection config, parsed once.
  // Null (zero-cost) unless IRONCURTAIN_MITM_STREAM_DELAY_MS is set.
  const streamDelayConfig = parseStreamDelayConfig();

  const getOrCreateSecureContext = createLeafSecureContextCache(options.ca);

  // Build host → registry lookup (including mirror hosts)
  const registriesByHost = new Map<string, RegistryConfig>();
  if (options.registries) {
    for (const reg of options.registries) {
      registriesByHost.set(canonicalHostKey(reg.host), reg);
      if (reg.mirrorHosts) {
        for (const mirror of reg.mirrorHosts) {
          registriesByHost.set(canonicalHostKey(mirror), reg);
        }
      }
    }
  }

  // True when a host is statically known to the proxy. Gates the wildcard
  // escape hatch so known providers/registries always follow their dedicated
  // MITM/registry path, never the passthrough tunnel. Accepts the hostname
  // as given (case may vary on the wire); normalization happens here so all
  // callers can trust the result regardless of input case.
  function isKnownStaticHost(hostname: string): boolean {
    const h = canonicalHostKey(hostname);
    return providersByHost.has(h) || registriesByHost.has(h);
  }

  // AllowedVersionCache for tarball backstop
  const allowedVersionCache: AllowedVersionCache = new Map();
  // Per-proxy bounds on registry metadata work (concurrency, buffered bytes,
  // deadlines) and npm publish times for the tarball backstop (EGR-4).
  const registryMetadataBudget = new RegistryMetadataBudget();
  const npmPublishTimeCache = new NpmPublishTimeCache();

  // Connection tracking
  interface ConnectionMeta {
    readonly provider?: ProviderKeyMapping;
    readonly registry?: RegistryConfig;
    readonly passthrough: boolean;
    /**
     * The `host:port` approval a TLS-terminated (nested) passthrough
     * connection was opened under; undefined for the wildcard escape hatch,
     * for a destination the egress policy admitted by rule, and for provider
     * and registry connections. Every request re-checks it, and revoking the
     * approval destroys the connection.
     */
    readonly approvalKey?: string;
    /**
     * A passthrough connection admitted by policy-evaluated egress: every
     * request on it is decided again, at path granularity.
     */
    readonly policyEvaluated?: boolean;
    readonly host: string;
    readonly port: number;
    /** Opaque correlation token copied from the CONNECT request. */
    readonly metricsLeaseToken?: string;
  }
  const activeClientSockets = new Set<Socket>();
  const activeTlsSockets = new Set<tls.TLSSocket>();
  const activeUpstreamRequests = new Set<http.ClientRequest>();
  const activeMetricsObservers = new Set<LlmMetricsExchangeObserver>();
  /**
   * Live raw tunnels and WebSocket bridges. `approvalKey` names the
   * `host:port` approval a passthrough tunnel was opened under, so revoking
   * that approval tears the tunnel down instead of leaving it up.
   */
  interface TunnelPair {
    readonly client: Socket;
    readonly upstream: Socket;
    readonly approvalKey?: string;
  }
  const activeTunnelPairs = new Set<TunnelPair>();
  const socketMetadata = new WeakMap<tls.TLSSocket, ConnectionMeta>();

  let connectionId = 0;

  /**
   * Last-resort containment for a per-connection listener. A synchronous
   * throw inside an `http.Server` event handler propagates as an
   * uncaughtException and takes the whole process down, and in daemon mode
   * that is every session and workflow at once (MITM-3). Every input is
   * validated before it can throw, so this only ever catches a defect; it
   * logs, answers the offending client when it still can, and destroys that
   * one connection.
   */
  function guardListener<Args extends unknown[]>(
    label: string,
    handler: (...args: Args) => void,
    onFailure: (...args: Args) => void,
  ): (...args: Args) => void {
    return (...args: Args): void => {
      try {
        handler(...args);
      } catch (error) {
        logger.warn(`[mitm-proxy] ${label} handler failed: ${errorMessage(error)}`);
        try {
          onFailure(...args);
        } catch {
          // The connection is already gone; nothing left to answer.
        }
      }
    };
  }

  function guardRequestListener(
    label: string,
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  ): (req: http.IncomingMessage, res: http.ServerResponse) => void {
    return guardListener(label, handler, (_req, res) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain', Connection: 'close' });
        res.end('Internal proxy error');
      } else {
        res.destroy();
      }
    });
  }

  function guardSocketListener(
    label: string,
    handler: (req: http.IncomingMessage, socket: Socket, head: Buffer) => void,
  ): (req: http.IncomingMessage, socket: Socket, head: Buffer) => void {
    return guardListener(label, handler, (_req, socket) => {
      socket.destroy();
    });
  }

  // ── Per-bundle resource bounds (MITM-14) ───────────────────────────
  // The proxy shares the daemon's event loop, memory and descriptors with
  // every other session; these keep one compromised agent from pinning them.

  /** Requests being handled (decrypted, or plain HTTP through the outer listener). */
  let inFlightRequests = 0;
  /** Bytes held by buffered request bodies across this proxy. */
  const bufferedBodyBudget = new BufferedBodyBudget(limits.maxBufferedBodyBytes);
  /**
   * Request-head and idle deadlines for the connections this proxy serves
   * through an HTTP server that never listens: decrypted (TLS-terminated)
   * connections on the inner server, and approved port-80 tunnels on the
   * plain-tunnel server. Node applies neither its headersTimeout nor its
   * requestTimeout to them, and it rewrites a socket's own timeout around
   * every keep-alive request; the monitor tracks both deadlines itself.
   */
  const decryptedConnections = new DecryptedConnectionMonitor(limits, (socket, reason) => {
    logger.info(
      `[mitm-proxy] closing ${socket instanceof tls.TLSSocket ? 'decrypted connection' : 'plain-HTTP tunnel'}: ${
        reason === 'idle'
          ? `idle for ${limits.connectionIdleTimeoutMs} ms`
          : `no complete request head within ${limits.requestHeadersTimeoutMs} ms`
      }`,
    );
    socket.destroy();
  });
  const drainLimits = { maxBytes: limits.refusedBodyDrainBytes, timeoutMs: limits.refusedBodyDrainTimeoutMs };

  /**
   * Compressed request bodies are decoded one at a time per bundle. Each decode
   * charges its output to `bufferedBodyBudget` as it goes, so interleaved
   * decodes race for the budget and can fail together where, run in turn, each
   * would fit; one at a time also keeps a bundle from occupying more than one
   * libuv thread-pool thread (shared with fs, DNS and crypto for every session
   * in the process) with decompression. A queued decode whose client has gone
   * stops at its first chunk: its exchange ended, so its account is closed.
   */
  const decodeInTurn = createSerialRunner();

  /**
   * Admit one request against the per-bundle concurrency ceiling, or answer it
   * with a 503 (draining its body so the client can read the error) and return
   * undefined. An admitted request holds its slot until its exchange ends; the
   * returned scope releases anything else the exchange acquires at that point.
   */
  function admitRequest(
    clientReq: http.IncomingMessage,
    clientRes: http.ServerResponse,
    target: string,
  ): ExchangeScope | undefined {
    if (inFlightRequests >= limits.maxConcurrentRequests) {
      logger.warn(
        `[mitm-proxy] 503 ${clientReq.method ?? ''} ${target} - ${limits.maxConcurrentRequests} requests already in flight`,
      );
      writeRequestRefusal(
        clientRes,
        {
          status: 503,
          errorType: 'overloaded_error',
          message: `too many concurrent requests (limit ${limits.maxConcurrentRequests})`,
          retryAfterSeconds: BUSY_RETRY_AFTER_SECONDS,
        },
        drainRequestBody(clientReq, drainLimits),
      );
      return undefined;
    }
    inFlightRequests += 1;
    const scope = exchangeScope(clientRes);
    scope.onEnd(() => {
      inFlightRequests -= 1;
    });
    // A request on a monitored connection (decrypted, or a port-80 tunnel)
    // suspends that connection's request-head deadline until it ends. The
    // monitor ignores a socket it does not track (the outer listener's own
    // connections, which Node times out itself).
    const socket = clientReq.socket;
    decryptedConnections.requestStarted(socket);
    scope.onEnd(() => decryptedConnections.requestFinished(socket));
    return scope;
  }

  /** Passthrough CONNECT tunnels (raw or port-80 HTTP) and WebSocket bridges open (or being opened) now. */
  let openTunnels = 0;

  /**
   * Admit one passthrough tunnel or WebSocket bridge against the per-bundle
   * ceiling, or answer 503 on the raw socket and return false. An admitted
   * tunnel holds its slot until its client socket closes, so a WebSocket
   * bridged inside a port-80 tunnel needs no slot of its own.
   */
  function admitTunnel(clientSocket: Socket, label: string): boolean {
    if (openTunnels >= limits.maxConcurrentTunnels) {
      logger.warn(`[mitm-proxy] REFUSED ${label} - ${limits.maxConcurrentTunnels} tunnels already open`);
      clientSocket.end(RAW_SERVICE_UNAVAILABLE);
      return false;
    }
    openTunnels += 1;
    clientSocket.once('close', () => {
      openTunnels -= 1;
    });
    return true;
  }

  /** Close a raw tunnel pair after `tunnelIdleTimeoutMs` without bytes in either direction. */
  function armTunnelIdleTimeout(clientSocket: Socket, upstreamSocket: Socket, label: string, close: () => void): void {
    const onIdle = (): void => {
      logger.info(`[mitm-proxy] ${label} idle for ${limits.tunnelIdleTimeoutMs} ms, closing`);
      close();
    };
    // Each socket's timer rearms on its own reads and writes, so traffic in
    // either direction keeps both alive.
    clientSocket.setTimeout(limits.tunnelIdleTimeoutMs, onIdle);
    upstreamSocket.setTimeout(limits.tunnelIdleTimeoutMs, onIdle);
  }

  // Inner HTTP server - shared across all decrypted connections
  const innerServer = http.createServer();

  // Handle HTTP parse errors on decrypted connections
  innerServer.on('clientError', (err, socket) => {
    const log = isConnectionReset(err) ? logger.debug : logger.info;
    log(`[mitm-proxy] client HTTP parse error: ${err.message}`);
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    }
  });

  // Fast-reject WebSocket upgrades on TLS-intercepted provider hosts.
  //
  // Codex CLI ≥ 0.142 prefers to talk to its inference endpoint over
  // `wss://chatgpt.com/backend-api/codex/responses` (HTTP `GET` with
  // `Upgrade: websocket`) and only falls back to the legacy `POST` + SSE
  // path when the WS connection fails at the TRANSPORT level. Without this
  // listener Node delivers the upgrade request to the `'request'` handler
  // below, which forwards it via `https.request()`; the upstream's `101
  // Switching Protocols` is then dropped on the floor (Node fires only
  // `'close'` on a client request with no `'upgrade'` listener), and the
  // agent's WS client sits on an open socket until its ~15s connect
  // timeout, retrying ~7× (~112s) before falling back.
  //
  // We deliberately DESTROY the socket rather than replying with an HTTP
  // 4xx/5xx: tungstenite surfaces a non-101 HTTP response as a fatal
  // handshake error to the Codex turn (observed: `turn.failed` with the
  // body text), whereas a connection-level failure (reset / EOF before
  // handshake) is treated as a retryable transport error and triggers the
  // POST/SSE fallback — the same path the timeout used to reach, just in
  // milliseconds instead of ~15s per attempt.
  //
  // WebSockets are never bridged on provider hosts, by design: a bridge would
  // carry inference traffic past the request sanitizers, the credential gate,
  // trajectory capture, token-stream extraction and LLM metrics, which all
  // work on HTTP requests and SSE responses. The Codex adapter instead turns
  // WebSockets off in the config it generates (`supports_websockets = false`
  // on every route, including a provider binding that replaces Codex's
  // built-in ChatGPT provider), so Codex sends POST + SSE from the start. This
  // listener stays as the enforcement point for any client that still tries
  // an upgrade, for example an agent that re-enabled WebSockets in its own
  // config: it pays its own retry backoff and then falls back to HTTP.
  innerServer.on(
    'upgrade',
    guardSocketListener('inner upgrade', (req: http.IncomingMessage, socket: Socket) => {
      const meta = socketMetadata.get(req.socket as tls.TLSSocket);
      const targetHost = meta?.host ?? 'unknown';
      // A WebSocket URL can carry a credential query parameter (`?key=`), like any provider path.
      logger.info(
        `[mitm-proxy] REJECTED ${req.headers.upgrade ?? 'upgrade'} ${targetHost}${redactCredentialQuery(req.url ?? '')} ` +
          '(WebSocket not bridged for MITM provider hosts; agent should fall back to HTTP)',
      );
      socket.on('error', () => {
        /* swallow — socket is being torn down */
      });
      socket.destroy();
    }),
  );

  // Lazy-loaded registry handler to avoid circular imports.
  // Cached after first import so subsequent calls are synchronous.
  let registryHandlerModule: typeof import('./registry-proxy.js') | undefined;

  function dispatchRegistryRequest(
    registry: RegistryConfig,
    clientReq: http.IncomingMessage,
    clientRes: http.ServerResponse,
    host: string,
    port: number,
  ): void {
    const doDispatch = (mod: typeof import('./registry-proxy.js')): void => {
      mod
        .handleRegistryRequest(registry, clientReq, clientRes, host, port, {
          validator: options.packageValidation?.validator ?? DENY_ALL_VALIDATOR,
          cache: allowedVersionCache,
          auditLogPath: options.packageValidation?.auditLogPath,
          outboundTransport,
          metadataBudget: registryMetadataBudget,
          publishTimeCache: npmPublishTimeCache,
        })
        .catch((err: unknown) => {
          logger.info(`[mitm-proxy] registry request error: ${err instanceof Error ? err.message : String(err)}`);
          if (!clientRes.headersSent) {
            clientRes.writeHead(500, { 'Content-Type': 'text/plain' });
            clientRes.end('Internal proxy error');
          }
        });
    };

    if (registryHandlerModule) {
      doDispatch(registryHandlerModule);
    } else {
      import('./registry-proxy.js')
        .then((mod) => {
          registryHandlerModule = mod;
          doDispatch(mod);
        })
        .catch((err: unknown) => {
          logger.info(
            `[mitm-proxy] failed to load registry-proxy: ${err instanceof Error ? err.message : String(err)}`,
          );
          if (!clientRes.headersSent) {
            clientRes.writeHead(500, { 'Content-Type': 'text/plain' });
            clientRes.end('Internal proxy error');
          }
        });
    }
  }

  innerServer.on(
    'request',
    guardRequestListener('inner request', (clientReq: http.IncomingMessage, clientRes: http.ServerResponse) => {
      const tlsSock = clientReq.socket as tls.TLSSocket;
      const meta = socketMetadata.get(tlsSock);
      if (!meta) {
        clientRes.writeHead(500);
        clientRes.end('Internal error: unknown connection');
        return;
      }
      // The refusal log names the target without the value of a credential query parameter.
      const admitted = admitRequest(clientReq, clientRes, `${meta.host}${redactCredentialQuery(clientReq.url ?? '')}`);
      if (admitted === undefined) return;
      const exchange: ExchangeScope = admitted;

      const { host: targetHost, port: targetPort } = meta;

      // Listener-level egress modes short-circuit here; standard mode falls
      // through to the per-host provider / registry / passthrough dispatch below.
      // A future ListenerMode kind is a compile error at the `default` guard.
      switch (listenerMode.kind) {
        case 'registry-egress':
          // Authorize each decrypted pull against the frozen registry manifest and
          // stream it through the destination-bound transport under the per-request
          // / per-session ceilings (content is not hashed — §16.6). Registry v2 is
          // https-only, so there is no plain-HTTP registry path.
          handleRegistryEgressRequest(clientReq, clientRes, {
            guard: listenerMode.guard,
            transport: outboundTransport,
            scheme: 'https:',
            targetHost,
            targetPort,
            requestTarget: clientReq.url ?? '/',
            ...(listenerMode.recordProvenance === undefined ? {} : { recordProvenance: listenerMode.recordProvenance }),
          });
          return;
        case 'standard':
          break;
        default: {
          const _exhaustive: never = listenerMode;
          throw new Error(`Unknown listener mode: ${String(_exhaustive)}`);
        }
      }

      // Dispatch: registry connections are handled separately from provider connections
      if (meta.registry) {
        dispatchRegistryRequest(meta.registry, clientReq, clientRes, targetHost, targetPort);
        return;
      }

      // Passthrough connections: forward as-is, no key swap, no endpoint filtering
      if (meta.passthrough) {
        // A keep-alive connection outlives its CONNECT: the approval it was
        // opened under must still stand for every request on it.
        if (meta.approvalKey !== undefined && !passthroughHosts.has(meta.approvalKey)) {
          logger.info(`[mitm-proxy] DENIED ${clientReq.method ?? 'GET'} on revoked passthrough ${meta.approvalKey}`);
          clientRes.writeHead(403, { 'Content-Type': 'text/plain', Connection: 'close' });
          clientRes.end('Forbidden');
          return;
        }
        if (meta.policyEvaluated === true) {
          // The request is readable here, so policy decides it at path
          // granularity before anything is forwarded.
          authorizeReadableRequest(clientReq, clientRes, targetHost, targetPort, clientReq.url ?? '/', () =>
            forwardPassthrough(clientReq, clientRes, targetHost, targetPort),
          );
          return;
        }
        forwardPassthrough(clientReq, clientRes, targetHost, targetPort);
        return;
      }

      if (!meta.provider) {
        clientRes.writeHead(500);
        clientRes.end('Internal error: no provider or registry for connection');
        return;
      }
      const provider = meta.provider;
      const { method, url, headers } = clientReq;
      // Node always sets `url` on a server request; the fallback only satisfies the type.
      const path = url ?? '/';
      // Logs and capture records never show the value of a credential query parameter.
      const displayPath = redactCredentialQuery(path);
      // The provider's documented request limit (MITM-10). It bounds a buffered
      // body, raw and once decoded, and the capture tee of a streamed one.
      const maxBodyBytes = provider.config.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES;

      // Per-handler capture-attribution snapshot. Reading once at handler
      // entry keeps every captured byte tied to the session active when
      // the request arrived, even if `setCaptureSessionId(...)` flips
      // mid-exchange. The snapshot is per-closure so HTTP keep-alive
      // concurrent exchanges on the same TLS socket get independent
      // attribution (§11 parallel-keep-alive correctness).
      const sidAtCapture = captureSessionId;
      let captureHandle: CaptureExchangeHandle | undefined;
      // Capture-endpoint gate: only training-relevant completion endpoints are
      // recorded. Host-shared housekeeping traffic (registry pagination,
      // telemetry batches, settings/eval pings) is excluded so it never
      // pollutes the corpus. Strictly subtractive — when capture is off or the
      // endpoint isn't capturable, `captureHandle` stays undefined and
      // `attachCaptureBranch` is a no-op; forwarding, key swap, and the
      // 401-retry path are unaffected. The `captureWriter` short-circuit keeps
      // a disabled proxy at zero per-request cost (no header clone, no glob
      // match). See §3 integration point 4 of the capture design doc.
      if (captureWriter && sidAtCapture && isCapturableEndpoint(provider.config, method, path)) {
        // Snapshot the original (pre-key-swap) headers for the capture
        // record. `modifiedHeaders` (below) gets the real key injected by
        // `applyProviderCredential` — we must capture from `headers`, not
        // `modifiedHeaders`. The writer applies a second redaction pass
        // defensively.
        const captureRequestHeaders = { ...headers };
        captureHandle = beginCaptureExchange({
          writer: captureWriter,
          sessionId: sidAtCapture,
          persona: capturePersona,
          workflowRunId: captureWorkflowRunId,
          bundleId: captureBundleId,
          recordedAgentName: captureRecordedAgentName,
          host: targetHost,
          path: displayPath,
          method: String(method),
          requestHeaders: captureRequestHeaders,
          requestContentEncoding: clientReq.headers['content-encoding']?.toLowerCase(),
          requestStartedAt: Date.now(),
          maxRequestBytes: maxBodyBytes,
        });
      }

      // 1. Endpoint filtering
      if (!isEndpointAllowed(provider.config, method, path)) {
        logger.info(`[mitm-proxy] BLOCKED ${method} ${targetHost}${displayPath}`);
        clientRes.writeHead(403, { 'Content-Type': 'text/plain' });
        clientRes.end(`Blocked: ${method} ${displayPath} is not an allowed endpoint.`);
        return;
      }

      // 2. Credentials. The agent's hop-by-hop headers never steer the pooled
      // upstream connection, then every credential carrier (headers, cookies,
      // query parameters) is stripped. The real key is injected only for the
      // session sentinel; any other credential, or none on an endpoint that
      // needs one, is answered here and nothing leaves the proxy.
      const modifiedHeaders = stripHopByHopRequestHeaders(headers);
      const credential = applyProviderCredential(modifiedHeaders, method, path, provider);
      if (credential.kind === 'rejected') {
        logger.warn(`[mitm-proxy] REJECTED ${method} ${targetHost}${displayPath} - ${credential.message}`);
        const payload = credentialRejectionBody(credential);
        clientRes.writeHead(credential.status, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        });
        clientRes.end(payload);
        return;
      }
      // The path forwarded upstream: the request path minus its credential query parameters.
      const forwardPath = credential.path;

      // Completion classification (for statistics and the budget gate) is
      // resolved only after forwarding authorization. A completion descriptor
      // can classify an allowed route; it can never grant network access.
      // Unsupported descriptors are never parsed for usage.
      let completionEndpoint: CompletionEndpoint | undefined;
      let completionUnclassified = false;
      if (statisticsEnabled || budgetGate !== undefined) {
        try {
          completionEndpoint = resolveProviderCompletionEndpoint(provider.config, method, path);
        } catch (error) {
          // Bad observability configuration must not alter an authorized
          // request; the budget gate still counts it as a completion.
          completionUnclassified = true;
          logger.warn(
            `[mitm-proxy] completion descriptor unavailable: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const requestPath = path.split('?')[0] ?? '';

      // Every completion request is admitted against the bundle's budget,
      // whatever metrics lease (proxy credential) it carries (budget-gate.ts).
      // The cheap check runs before the body is read, so a request refused
      // because the budget is spent, or because no agent turn is running, is
      // never buffered; the admission proper, which pre-charges the request's
      // output cap, runs just before forwarding.
      const requestGate =
        budgetGate !== undefined && (completionEndpoint !== undefined || completionUnclassified)
          ? budgetGate
          : undefined;
      let budgetTicket: BudgetTicket | undefined;
      if (requestGate) {
        const refusal = requestGate.precheck();
        if (refusal) {
          answerBudgetRefusal(refusal, drainRequestBody(clientReq, drainLimits));
          return;
        }
      }

      // Route-level negotiation is stable whether statistics are enabled or
      // disabled, so toggling local observation cannot change provider output.
      if (provider.config.gatewayAdapterId === 'openrouter' && canonicalHostKey(targetHost) === OPENROUTER_HOST) {
        modifiedHeaders['x-openrouter-metadata'] = 'enabled';
      }

      // Resolve upstream target: use custom gateway if configured, otherwise the original host.
      const upstream = provider.config.upstreamTarget;
      const upstreamHost = upstream?.hostname ?? targetHost;
      const upstreamPort = upstream?.port ?? targetPort;
      const upstreamPathPrefix = upstream?.pathPrefix ?? '';
      const upstreamUseTls = upstream?.useTls ?? true;

      let metricsAttribution: MetricsAttributionHandle | undefined;
      let metricsObserver: LlmMetricsExchangeObserver | undefined;
      let metricsResponseAttached = false;
      if (completionEndpoint && completionEndpoint.capabilities.metricsSupport !== 'unsupported') {
        const protocolAdapter = metricsProtocolRegistry.get(completionEndpoint.protocol);
        if (protocolAdapter) {
          // Revalidate the CONNECT credential for every inner request. Missing,
          // invalid, or revoked leases never borrow another invocation.
          metricsAttribution = metricsAttributionRegistry.acquire(meta.metricsLeaseToken);
          try {
            const attribution = metricsAttribution?.attribution ?? fallbackMetricsAttribution(options.bundleId);
            const gateway = selectMetricsGateway(provider.config, completionEndpoint.protocol, targetHost);
            const logicalProvider = provider.config.id ?? 'unknown';
            const publicClientOrigin =
              officialProviderForOrigin(completionEndpoint.protocol, targetHost) !== null ||
              (gateway.kind === 'openrouter' && canonicalHostKey(targetHost) === OPENROUTER_HOST);
            const stableConfiguredRoute = provider.config.id ?? null;
            const route: LlmExchangeRoute = Object.freeze({
              logicalProvider,
              providerProfileId: options.providerProfileId ?? null,
              protocol: completionEndpoint.protocol,
              gatewayKind: gateway.kind,
              clientRouteId: publicClientOrigin ? targetHost : stableConfiguredRoute,
              upstreamRouteId: upstream
                ? stableConfiguredRoute === null
                  ? null
                  : `${stableConfiguredRoute}:override`
                : publicClientOrigin
                  ? targetHost
                  : stableConfiguredRoute,
            });
            metricsObserver = new LlmMetricsExchangeObserver({
              endpoint: completionEndpoint,
              attribution,
              route,
              protocolAdapter,
              gatewayAdapter: gateway.adapter,
              requestPath,
              onCompleted: (completed) => {
                if (metricsObserver) activeMetricsObservers.delete(metricsObserver);
                try {
                  // The budget charge never depends on statistics being on.
                  settleBudgetTicket(completed);
                  if (statisticsEnabled) getLlmMetricsEventBus().publish(completed);
                } finally {
                  metricsAttribution?.release();
                }
              },
            });
            activeMetricsObservers.add(metricsObserver);
          } catch (error) {
            metricsAttribution?.release();
            metricsAttribution = undefined;
            logger.warn(
              `[mitm-proxy] metrics observer unavailable: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }

      if (metricsObserver) {
        const observer = metricsObserver;
        const settleClientDelivery = (aborted: boolean): void => {
          if (!metricsResponseAttached) {
            observer.markObservationUnavailable(
              clientRes.headersSent ? clientRes.statusCode : null,
              'response_body_not_observed',
            );
          }
          observer.markClientDeliveryEnd(aborted);
        };
        clientRes.once('finish', () => settleClientDelivery(false));
        clientRes.once('close', () => settleClientDelivery(!clientRes.writableFinished));
      }

      let metricsRequestChunks: Buffer[] = [];
      let metricsRequestBytes = 0;
      let metricsRequestOverflowed = false;
      let metricsRequestFinished = false;
      const markMetricsRequestFailure = (): void => {
        metricsRequestOverflowed = true;
        metricsRequestChunks = [];
        metricsRequestBytes = 0;
        try {
          metricsObserver?.markQualityFlag('request_observation_failure');
        } catch {
          // Passive observation cannot escape into request forwarding.
        }
      };
      const pushMetricsRequestChunk = (chunk: Buffer): void => {
        if (!metricsObserver || metricsRequestFinished || metricsRequestOverflowed) return;
        if (metricsRequestBytes + chunk.length > MAX_METRICS_REQUEST_OBSERVATION_BYTES) {
          metricsRequestOverflowed = true;
          metricsRequestChunks = [];
          metricsRequestBytes = 0;
          metricsObserver.markQualityFlag('request_observation_byte_limit');
          return;
        }
        try {
          metricsRequestChunks.push(Buffer.from(chunk));
          metricsRequestBytes += chunk.length;
        } catch {
          markMetricsRequestFailure();
        }
      };
      const finishStreamedMetricsRequest = (): void => {
        if (!metricsObserver || metricsRequestFinished) return;
        metricsRequestFinished = true;
        try {
          if (!metricsRequestOverflowed) {
            const body = Buffer.concat(metricsRequestChunks, metricsRequestBytes);
            metricsObserver.observeUnchangedRequest(body);
          }
        } catch {
          markMetricsRequestFailure();
        }
        metricsRequestChunks = [];
        metricsRequestBytes = 0;
        try {
          metricsObserver.markRequestBodyComplete();
        } catch {
          // Passive observation cannot escape into request forwarding.
        }
      };
      const observeBufferedMetricsRequest = (originalBody: Buffer, forwardedBody: Buffer): void => {
        if (!metricsObserver || metricsRequestFinished) return;
        metricsRequestFinished = true;
        try {
          if (
            originalBody.length <= MAX_METRICS_REQUEST_OBSERVATION_BYTES &&
            forwardedBody.length <= MAX_METRICS_REQUEST_OBSERVATION_BYTES
          ) {
            if (originalBody === forwardedBody) metricsObserver.observeUnchangedRequest(originalBody);
            else {
              metricsObserver.observeOriginalRequest(originalBody);
              metricsObserver.observeForwardedRequest(forwardedBody);
            }
          } else {
            metricsObserver.markQualityFlag('request_observation_byte_limit');
          }
          metricsObserver.markRequestBodyComplete();
        } catch {
          markMetricsRequestFailure();
        }
      };

      // Set Host header to match the upstream target so the gateway receives
      // the correct virtual-host. Include port only when non-standard.
      const isStandardPort = (upstreamUseTls && upstreamPort === 443) || (!upstreamUseTls && upstreamPort === 80);
      modifiedHeaders.host = isStandardPort ? upstreamHost : `${upstreamHost}:${upstreamPort}`;

      // 3. Forward to real API - either direct pipe or buffer+rewrite.
      // Only enable 401 retry if the request actually carried the fake key —
      // unauthenticated requests should not have credentials injected on retry.
      const needsRewrite = shouldRewriteBody(provider.config, method, path);
      // Sanitized endpoints are buffered and sanitized for every request that
      // gets this far, sentinel or (on an unauthenticated endpoint) anonymous.
      const sanitizer = resolveRequestSanitizer(provider.config, method, path);
      const needsBodyTransform = needsRewrite || sanitizer !== undefined;
      // 401 retry only makes sense when we swapped our own managed credential
      const canRetryAuth = credential.kind === 'sentinel' && !!provider.tokenManager;
      // Only buffer for retry when the body is absent or small enough (known
      // Content-Length under 1MB). Large or chunked bodies stream through without
      // retry support to avoid memory overhead and 413 rejections on large
      // payloads. Bodyless requests (notably Codex's model-list GET) still need
      // the OAuth 401 refresh path.
      const contentLength = parseInt(clientReq.headers['content-length'] ?? '', 10);
      const hasNoRequestBody =
        clientReq.headers['content-length'] === undefined && clientReq.headers['transfer-encoding'] === undefined;
      const retryBufferOk =
        canRetryAuth && (hasNoRequestBody || (Number.isFinite(contentLength) && contentLength <= MAX_RETRY_BODY_BYTES));
      const needsBuffer = needsBodyTransform || retryBufferOk;

      /**
       * Sends the request upstream with optional body override and 401 retry.
       * When a tokenManager is present and the upstream returns 401, it consumes
       * the error response, refreshes the token, and retries once.
       */
      function forwardRequest(bodyOverride?: Buffer, isRetry?: boolean): void {
        const routeInfo = upstream ? ` (via ${upstreamHost}:${upstreamPort})` : '';
        logger.info(
          `[mitm-proxy] ${method} ${targetHost}${displayPath} → FORWARDED${routeInfo}${isRetry ? ' (retry)' : ''}`,
        );

        const finalHeaders = { ...modifiedHeaders };
        if (bodyOverride) {
          // When we've buffered the body, set the definitive content-length and
          // remove transfer-encoding to avoid sending both (which is an invalid
          // HTTP request and a request-smuggling vector per RFC 7230 §3.3.3).
          finalHeaders['content-length'] = bodyOverride.length.toString();
          delete finalHeaders['transfer-encoding'];
        }

        // Route to custom upstream gateway when configured; path prefix is
        // prepended AFTER endpoint filtering (which runs on the original path).
        // The forwarded path has no credential query parameters.
        const upstreamPath = upstreamPathPrefix ? `${upstreamPathPrefix}${forwardPath}` : forwardPath;
        const metricsAttempt = metricsObserver?.beginTransportAttempt();
        budgetTicket?.beginAttempt();
        const upstreamReq = outboundTransport.request(
          {
            destination: {
              protocol: upstreamUseTls ? 'https:' : 'http:',
              hostname: upstreamHost,
              port: upstreamPort,
            },
            // `upstream` is resolved exclusively from trusted host provider
            // configuration (for example ANTHROPIC_BASE_URL). It may name a
            // loopback/private LiteLLM gateway. Agent-selected passthrough and
            // redirect destinations never receive this policy.
            addressPolicy: upstream === undefined ? 'public-only' : 'trusted-provider-override',
            method,
            path: upstreamPath,
            headers: finalHeaders,
          },
          guardUpstreamResponse(
            clientRes,
            (upstreamRes) => {
              // The provider answered this attempt; its status decides whether
              // the budget charges it (an error response is not billed).
              if (upstreamRes.statusCode !== undefined) budgetTicket?.markUpstreamStatus(upstreamRes.statusCode);
              upstreamRes.on('error', (err) => {
                const log = isConnectionReset(err) ? logger.debug : logger.info;
                log(`[mitm-proxy] upstream response error: ${err.message}`);
                if (!clientRes.headersSent) {
                  clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
                  clientRes.end(`Upstream response error: ${err.message}`);
                } else {
                  clientRes.socket?.destroy();
                }
              });

              // 401 retry: requires a buffered body (bodyOverride), an authenticated
              // request (canRetryAuth), and not already a retry.
              const { tokenManager } = provider;
              if (upstreamRes.statusCode === 401 && tokenManager && canRetryAuth && bodyOverride && !isRetry) {
                // Consume the 401 response body to free the connection, then retry.
                // Guard against the upstream closing/aborting before 'end' fires —
                // without this the client request would hang indefinitely.
                let handled = false;
                const onDrained = (): void => {
                  if (handled) return;
                  handled = true;
                  metricsAttempt?.complete({ responseStatus: 401, outcome: 'auth_retry' });
                  retryWithRefreshedToken(
                    tokenManager,
                    provider,
                    modifiedHeaders,
                    bodyOverride,
                    clientRes,
                    forwardRequest,
                  );
                };
                const onAborted = (): void => {
                  if (handled) return;
                  handled = true;
                  metricsAttempt?.complete({ responseStatus: 401, outcome: 'aborted' });
                  if (!clientRes.headersSent) {
                    clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
                    clientRes.end('Upstream connection closed during auth retry.');
                  }
                };
                upstreamRes.resume();
                upstreamRes.on('end', onDrained);
                upstreamRes.on('close', onAborted);
                return;
              }

              const finalStatus = upstreamRes.statusCode ?? 502;
              const responseContentType = headerText(upstreamRes.headers['content-type']).toLowerCase();
              const isEventStream = responseContentType.includes('text/event-stream');
              // Codex's chatgpt.com Responses stream is SSE without a content-type.
              const frameSse =
                isEventStream || (responseContentType === '' && completionEndpoint?.protocol === 'openai-responses');
              // Pin this response's token events to the id active when it
              // started, so an orchestrator mid-flight flip can't split one stream.
              const sidAtAttach = tokenSessionId;

              // Passive response observation. LLM metrics and the token stream
              // are consumers of ONE ResponseObservationHub, which copies the raw
              // upstream bytes off the forwarding path, decodes them (gzip,
              // deflate, br) and frames SSE once. Neither sits in the
              // upstream→client pipe below, so an observer can never delay,
              // alter or break what the agent receives.
              const observationConsumers: ResponseObservationConsumer[] = [];
              let metricsConsumer = false;
              if (metricsObserver) {
                try {
                  metricsObserver.observeResponseHeaders(finalStatus, upstreamRes.headers);
                  observationConsumers.push(metricsObserver.responseConsumer(frameSse));
                  metricsConsumer = true;
                } catch {
                  failMetricsResponseSetup(metricsObserver, finalStatus);
                }
              }
              if (sidAtAttach) {
                const tokenJson =
                  !frameSse && isLlmMessagesEndpoint(path) && responseContentType.includes('application/json');
                if (isEventStream || tokenJson) {
                  observationConsumers.push(
                    createTokenStreamConsumer({
                      id: 'token-stream',
                      provider: resolveSseProvider(targetHost, path),
                      streaming: isEventStream,
                      // The bus is fetched per push so `resetTokenStreamBus()` between tests is honored.
                      onEvent: (event) => getTokenStreamBus().push(sidAtAttach, event),
                    }),
                  );
                }
              }
              let observationHub: ResponseObservationHub | undefined;
              if (observationConsumers.length > 0) {
                const observer = metricsConsumer ? metricsObserver : undefined;
                try {
                  const hub = new ResponseObservationHub({
                    contentEncoding: upstreamRes.headers['content-encoding'],
                    frameSse,
                    consumers: observationConsumers,
                    ...(observer ? { onDecoderFailure: (failure) => observer.markQualityFlag(failure.reason) } : {}),
                  });
                  observationHub = hub;
                  metricsResponseAttached = observer !== undefined;
                  upstreamRes.on('data', (chunk: Buffer) => {
                    observer?.markFirstUpstreamBodyByte();
                    hub.write(chunk);
                  });
                } catch {
                  // Observation failures are local to observation. Forward the
                  // original upstream response and settle an explicitly partial record.
                  if (observer) failMetricsResponseSetup(observer, finalStatus);
                }
              }
              if (metricsObserver || observationHub) {
                const observer = metricsObserver;
                const hub = observationHub;
                let upstreamSettled = false;
                const finishObservedUpstream = (aborted: boolean): void => {
                  if (upstreamSettled) return;
                  upstreamSettled = true;
                  metricsAttempt?.complete({ responseStatus: finalStatus, outcome: aborted ? 'aborted' : 'response' });
                  if (aborted) hub?.abort('upstream_response_aborted');
                  else hub?.end();
                  observer?.markUpstreamResponseEnd();
                };
                upstreamRes.once('end', () => finishObservedUpstream(false));
                upstreamRes.once('aborted', () => finishObservedUpstream(true));
                upstreamRes.once('error', () => finishObservedUpstream(true));
                upstreamRes.once('close', () => {
                  if (!upstreamRes.complete) finishObservedUpstream(true);
                });
              }

              // Hop-by-hop and connection-nominated headers belong to the upstream
              // connection, and `Set-Cookie` could hand the agent a session the
              // provider issued to the user's real credential: none is relayed.
              // This is the one place a provider response reaches the agent, the
              // refreshed retry after a 401 included. `content-length` and
              // `content-encoding` stay because the body is relayed raw; without a
              // `transfer-encoding` header Node re-frames the body itself.
              clientRes.writeHead(finalStatus, sanitizeResponseHeaders(upstreamRes.headers));
              clientRes.flushHeaders();
              clientRes.socket?.setNoDelay(true);

              // Trajectory-capture response branch. The 401 refresh-retry
              // path above already returned before reaching here, so the
              // captureTap is bound only to the SUCCESSFUL upstream
              // response — never the drained 401 (§5 "401 refresh-retry
              // semantics").
              //
              // The capture branch is FANNED OUT from the upstream response
              // (it does NOT sit in-series on the forwarding pipeline).
              // Anthropic serves `/v1/messages` SSE with `content-encoding:
              // gzip` by default; the forwarding path must continue to
              // deliver the raw compressed bytes to the agent (its SDK
              // decompresses transparently), while the capture path needs
              // decompressed bytes so the reassembler can parse SSE events.
              // See §3 and §6 invariant 6 of the design doc.
              attachCaptureBranch(upstreamRes, captureHandle, sidAtCapture);

              // DEBUG (issue #367): optionally insert an idle gap into the
              // agent-facing forwarding stream to reproduce / test Claude Code's
              // streaming idle watchdog behind the MITM. Zero-cost unless
              // IRONCURTAIN_MITM_STREAM_DELAY_MS is set. Applies only to LLM
              // completion endpoints; sits at the tail of the forwarding pipe.
              // Captured trajectory CONTENT stays byte-faithful — this only
              // re-times delivery. (In stall modes the held callback backpressures
              // upstreamRes, which also pauses the capture tee; the captured bytes
              // are still identical, only their capture timing shifts.)
              let clientSink: NodeJS.WritableStream = clientRes;
              if (
                streamDelayConfig &&
                isLlmMessagesEndpoint(path) &&
                (!streamDelayConfig.hostFilter || targetHost.includes(streamDelayConfig.hostFilter))
              ) {
                const delay = createStreamDelayTransform(streamDelayConfig);
                delay.pipe(clientRes);
                clientSink = delay;
                // `.pipe()` does not destroy the source on a downstream close, so a
                // premature client disconnect would otherwise leave the transform's
                // pending timer/interval running. Tear it down explicitly.
                clientRes.on('close', () => {
                  if (!delay.destroyed) delay.destroy();
                });
                logger.info(
                  `[mitm-proxy] DEBUG stream-delay: applying ${streamDelayConfig.mode} ` +
                    `(${streamDelayConfig.delayMs}ms) to ${targetHost}${displayPath}`,
                );
              }

              // Forwarding: the raw upstream bytes, unmodified (observation is
              // fanned out above and capture by `attachCaptureBranch`).
              upstreamRes.pipe(clientSink);

              /**
               * Attach the trajectory capture branch to `upstreamRes` via a
               * fan-out tee. Bytes the agent receives are unaffected. When
               * `content-encoding` is supported we decompress before feeding
               * the captureTap; unsupported encodings poison the session
               * with `unsupported-encoding`.
               */
              function attachCaptureBranch(
                upstream: http.IncomingMessage,
                handle: CaptureExchangeHandle | undefined,
                sessionId: import('../session/types.js').SessionId | undefined,
              ): void {
                if (!handle || !sessionId) return;
                const captureTap = handle.attachResponse({
                  statusCode: upstream.statusCode ?? 502,
                  headers: upstream.headers,
                });
                const inlet = createResponseCaptureInlet({
                  captureTap,
                  contentEncoding: upstream.headers['content-encoding'],
                  captureHandle: handle,
                  onPoison: (reason) => {
                    try {
                      captureWriter?.markSessionPoisoned(sessionId, reason);
                    } catch {
                      /* swallow — capture must never disturb forwarding */
                    }
                  },
                });
                // Tee upstream bytes into the capture inlet via data
                // listeners. This pattern coexists with the sibling
                // `upstreamRes.pipe(...)` for forwarding because Node
                // broadcasts `data` events to all listeners, and pipe is
                // implemented on top of the same event. Errors / aborts on
                // the upstream stream are propagated to the inlet so the
                // captureTap can settle cleanly (or surface a poison).
                upstream.on('data', (chunk: Buffer) => {
                  if (!inlet.writableEnded && !inlet.destroyed) {
                    inlet.write(chunk);
                  }
                });
                upstream.on('end', () => {
                  if (!inlet.writableEnded && !inlet.destroyed) {
                    inlet.end();
                  }
                });
                upstream.on('error', () => {
                  // On upstream 'error'/'aborted' a terminal event may already
                  // be buffered in a decompressor inlet. Prefer a graceful
                  // `inlet.end()` flush (NOT destroy) so zlib `_flush` emits the
                  // buffered tail and the tap's `canFinalize()` can recover a
                  // complete-but-aborted stream; `canFinalize()` is the primary
                  // recovery mechanism (codex is uncompressed, so the inlet is
                  // the captureTap itself and `end()` simply triggers finalize).
                  // Genuine decompressor corruption surfaces as a zlib 'error'
                  // on the inlet, which poisons `reassembly-failure` via
                  // `createResponseCaptureInlet`'s own handler. Reserve
                  // `inlet.destroy()` for the case where the inlet cannot be
                  // ended (already errored).
                  if (!inlet.writableEnded && !inlet.destroyed) {
                    inlet.end();
                  }
                });
                upstream.on('close', () => {
                  // If `end` already fired, the inlet has been ended. If we
                  // got here without `end` and without an `error`, this is a
                  // graceful close-after-data (e.g. the client disconnected
                  // after the completion). Call `inlet.end()` — NOT
                  // `inlet.destroy()` — so a decompressor inlet runs zlib
                  // `_flush`, emits its buffered tail + `end` to the
                  // captureTap, and the reassembler sees its terminal event.
                  // `inlet.destroy(err)` is reserved for genuine upstream
                  // `error` (handled above), which would discard the
                  // decompressor's pending tail. The tap's `canFinalize()`
                  // lifecycle then writes a faithful record for a
                  // complete-but-socket-aborted stream, or poisons
                  // mid-stream-abort only if the terminal event never landed.
                  if (!inlet.writableEnded && !inlet.destroyed) {
                    inlet.end();
                  }
                });
              }
            },
            () => {
              metricsAttempt?.complete({ responseStatus: null, outcome: 'error' });
            },
          ),
        );

        activeUpstreamRequests.add(upstreamReq);
        upstreamReq.on('close', () => activeUpstreamRequests.delete(upstreamReq));
        // A stalled upstream no longer lives until the client gives up (MITM-14).
        armUpstreamDeadlines(upstreamReq, limits);
        if (budgetTicket) trackUpstreamDelivery(upstreamReq, budgetTicket, upstreamUseTls);

        upstreamReq.on('error', (err) => {
          metricsAttempt?.complete({ responseStatus: null, outcome: 'error' });
          const log = isConnectionReset(err) ? logger.debug : logger.info;
          log(`[mitm-proxy] upstream error: ${err.message}`);
          activeUpstreamRequests.delete(upstreamReq);
          answerUpstreamFailure(clientRes, err);
        });

        clientRes.on('close', () => {
          if (!upstreamReq.destroyed) {
            upstreamReq.destroy();
          }
        });

        if (bodyOverride) {
          upstreamReq.end(bodyOverride);
        } else {
          clientReq.on('error', (err) => {
            const log = isConnectionReset(err) ? logger.debug : logger.info;
            log(`[mitm-proxy] client request error: ${err.message}`);
            upstreamReq.destroy();
          });
          // Trajectory-capture tee: when capture is active and we are NOT
          // buffering for rewrite/retry, install a PassThrough between
          // clientReq and upstreamReq so we can observe each request chunk
          // on the way through. The tap's data listener never modifies
          // bytes; the forwarding pipe stays line-rate. Adding a 'data'
          // listener directly to clientReq would flip it to flowing mode
          // and race the upstream pipe — the PassThrough avoids that.
          if (captureHandle || metricsObserver) {
            const reqTap = new PassThrough();
            const handle = captureHandle;
            reqTap.on('data', (chunk: Buffer) => {
              handle?.pushRequestChunk(chunk);
              pushMetricsRequestChunk(chunk);
            });
            reqTap.on('end', () => {
              handle?.finishRequest();
              finishStreamedMetricsRequest();
            });
            clientReq.pipe(reqTap).pipe(upstreamReq);
          } else {
            clientReq.pipe(upstreamReq);
          }
          // A body that streams through unread is sized for the budget gate's
          // input estimate as it passes (the listener never alters the bytes).
          const ticket = budgetTicket;
          if (ticket) clientReq.on('data', (chunk: Buffer) => ticket.addRequestBytes(chunk.length));
        }
      }

      /**
       * Answers a completion request the budget gate refused, locally, with a
       * non-retryable JSON error carrying the gate's marker (budget-gate.ts).
       * Nothing is sent upstream. With `drained`, the body has not been read:
       * the response is ended only once the upload is drained, so a client
       * that reads after writing still receives the error.
       */
      function answerBudgetRefusal(refusal: BudgetRefusal, drained?: Promise<void>): void {
        logger.warn(`[mitm-proxy] REFUSED ${method} ${targetHost}${displayPath} - budget gate: ${refusal.message}`);
        if (clientRes.headersSent) {
          clientRes.destroy();
          return;
        }
        const response = budgetRefusalResponse(refusal);
        clientRes.writeHead(response.status, response.headers);
        if (drained === undefined) {
          clientRes.end(response.body);
          return;
        }
        clientRes.write(response.body);
        void drained.then(() => {
          if (!clientRes.writableEnded) clientRes.end();
        });
      }

      /**
       * Admits a budgeted completion request just before it is forwarded,
       * pre-charging its output cap, or answers the gate's refusal and returns
       * false. `forwarded` is the request body as it will be forwarded
       * (undefined when the body streams through uninspected, which takes the
       * default output estimate) and `forwardedBytes` its size (undefined when
       * it streams through; `forwardRequest` then counts it); `bodyUnread` is
       * set when the body has not been read and must be drained before the
       * refusal ends.
       */
      function admitToBudget(forwarded: unknown, forwardedBytes: number | undefined, bodyUnread: boolean): boolean {
        if (!requestGate) return true;
        // The client went away while the request was being prepared (for
        // example while its body was decoded). Its exchange has ended, so the
        // response observer may already have settled without a ticket and
        // nothing would stop the upstream request: forwarding it now would
        // leave the provider's bill uncharged. Nobody is left to answer.
        if (exchange.ended) {
          logger.info(
            `[mitm-proxy] ${method} ${targetHost}${displayPath} not forwarded: the client closed the connection`,
          );
          return false;
        }
        const protocol = completionEndpoint?.protocol ?? null;
        const admission = requestGate.admit({
          protocol,
          model: requestedModelOf(protocol, forwarded),
          outputCapTokens: requestedOutputCap(protocol, forwarded),
          choices: requestedChoiceCount(protocol, forwarded),
          // Fast mode bills at the model's fast-mode price (llm-metrics/pricing.ts).
          speed: requestedSpeed(forwarded),
          ...(forwardedBytes !== undefined ? { requestBytes: forwardedBytes } : {}),
        });
        if (!admission.admitted) {
          answerBudgetRefusal(admission.refusal, bodyUnread ? drainRequestBody(clientReq, drainLimits) : undefined);
          return false;
        }
        budgetTicket = admission.ticket;
        // An exchange whose response is parsed settles from its usage record
        // (the observer's onCompleted); any other settles, without usage,
        // when it ends.
        if (!metricsObserver) exchange.onEnd(() => settleBudgetTicket(undefined));
        return true;
      }

      /** The model a completion request names, for pricing its reservation. */
      function requestedModelOf(protocol: string | null, forwarded: unknown): string | null {
        try {
          const adapter = protocol !== null ? metricsProtocolRegistry.get(protocol) : undefined;
          if (adapter) return adapter.inspectRequest(forwarded, { path: requestPath }).requestedModel;
        } catch {
          // Inspection is best effort; an unnamed model prices fail-closed.
        }
        const model =
          typeof forwarded === 'object' && forwarded !== null ? (forwarded as Record<string, unknown>)['model'] : null;
        return typeof model === 'string' && model.length > 0 && model.length <= 256 ? model : null;
      }

      /** Settles this exchange's budget ticket; accounting never disturbs forwarding. */
      function settleBudgetTicket(completed: LlmExchangeCompleted | undefined): void {
        try {
          budgetTicket?.settle(completed);
        } catch (error) {
          logger.warn(`[mitm-proxy] budget settlement failed: ${errorMessage(error)}`);
        }
      }

      /**
       * Answers a request the body pipeline refused (see request-sanitizers)
       * locally, with a JSON error both the Anthropic and OpenAI SDKs surface.
       * Nothing is sent upstream.
       */
      function answerRejectedRequest(err: RequestRejectedError): void {
        logger.warn(`[mitm-proxy] REJECTED ${method} ${targetHost}${displayPath} - ${err.message}`);
        const payload = rejectionResponseBody(err);
        clientRes.writeHead(err.status, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        });
        clientRes.end(payload);
      }

      /**
       * Answers a request whose body was not buffered (MITM-10, MITM-14): 413
       * over the provider's limit, 503 when the bundle's buffered-body budget is
       * spent, 408 for a stalled body. The JSON error names the limit and is
       * written at once with `Connection: close`, but the socket is not
       * destroyed under the upload: the response ends (closing the connection)
       * only after the rest of a refused body is drained, so a client that reads
       * only after it finishes writing still gets the error, not a reset.
       */
      function answerUnbufferedBody(read: Exclude<RequestBodyRead, { kind: 'complete' }>): void {
        const route = `${method} ${targetHost}${displayPath}`;
        switch (read.kind) {
          case 'too-large': {
            const size =
              read.declaredBytes !== undefined ? `${read.declaredBytes} bytes declared` : `over ${maxBodyBytes} bytes`;
            logger.warn(
              `[mitm-proxy] 413 ${route} - request body (${size}) exceeds the ${describeByteSize(maxBodyBytes)} limit`,
            );
            writeRequestRefusal(
              clientRes,
              {
                status: 413,
                errorType: 'request_too_large',
                message: `request body exceeds the ${describeByteSize(maxBodyBytes)} limit for ${targetHost}`,
              },
              read.drained,
            );
            return;
          }
          case 'over-budget':
            logger.warn(
              `[mitm-proxy] 503 ${route} - buffered request bodies reached the ` +
                `${describeByteSize(limits.maxBufferedBodyBytes)} limit`,
            );
            writeRequestRefusal(
              clientRes,
              {
                status: 503,
                errorType: 'overloaded_error',
                message: `too many request bodies buffered at once (limit ${describeByteSize(limits.maxBufferedBodyBytes)})`,
                retryAfterSeconds: BUSY_RETRY_AFTER_SECONDS,
              },
              read.drained,
            );
            return;
          case 'timeout':
            logger.warn(`[mitm-proxy] 408 ${route} - request body stalled`);
            writeRequestRefusal(clientRes, {
              status: 408,
              errorType: 'timeout_error',
              message: `request body not received in time (idle limit ${limits.requestBodyIdleTimeoutMs} ms)`,
            });
            return;
          case 'failed':
            // The client went away mid-upload: nothing to forward, nobody to answer.
            logger.info(`[mitm-proxy] request body read error ${route}: ${read.error.message}`);
            if (!clientRes.headersSent && !clientRes.destroyed) {
              clientRes.writeHead(400, { 'Content-Type': 'text/plain', Connection: 'close' });
              clientRes.end('Request body read error');
            }
            return;
          default: {
            const _exhaustive: never = read;
            throw new Error(`Unknown request body outcome: ${String(_exhaustive)}`);
          }
        }
      }

      /**
       * Handles proactive token refresh, body buffering/rewriting, and forwarding.
       * Async to support the token manager's getValidAccessToken() call.
       */
      async function processRequest(): Promise<void> {
        // Proactive token refresh: ensure the real key is fresh before forwarding.
        // Only a request that presented the sentinel carries the real key; an
        // anonymous request never gets one.
        if (provider.tokenManager) {
          try {
            const freshToken = await provider.tokenManager.getValidAccessToken();
            if (freshToken !== provider.realKey) {
              provider.realKey = freshToken;
              // Only a request that presented the sentinel receives the
              // refreshed real token. Re-injecting into any other request
              // would hand the user's real token to a caller that never
              // presented the session credential.
              if (credential.kind === 'sentinel') {
                injectRealKey(modifiedHeaders, provider.config.keyInjection, provider.realKey);
              }
            }
          } catch (err) {
            logger.warn(
              `[mitm-proxy] Proactive token refresh failed: ${err instanceof Error ? err.message : String(err)}`,
            );
            // Continue with existing token — it may still work
          }
        }

        if (needsBuffer) {
          // A sanitized or rewritten endpoint must never forward bytes it could
          // not inspect. A coding the proxy can decode (gzip, deflate, br, zstd)
          // is decoded below; any other coding is refused (415) before the body
          // is buffered.
          let contentCoding: RequestContentCoding | undefined;
          if (needsBodyTransform) {
            try {
              contentCoding = parseRequestContentCoding(clientReq.headers['content-encoding']);
            } catch (err: unknown) {
              if (!isRequestRejectedError(err)) throw err;
              answerRejectedRequest(err);
              return;
            }
          }

          // The provider's request limit bounds the raw body (MITM-10), and every
          // buffered byte is charged to the bundle's budget until this exchange
          // ends (MITM-14): the forwarded body stays referenced for the 401 retry
          // while the response streams.
          const account = bufferedBodyBudget.openAccount();
          exchange.onEnd(() => account.release());
          const read = await readRequestBody(clientReq, {
            maxBytes: maxBodyBytes,
            account,
            idleTimeoutMs: limits.requestBodyIdleTimeoutMs,
            totalTimeoutMs: limits.requestBodyTimeoutMs,
            drain: drainLimits,
          });
          if (read.kind !== 'complete') {
            answerUnbufferedBody(read);
            return;
          }
          const rawBody = read.body;

          // Trajectory-capture: feed the buffered raw body into the
          // capture record. This is the pre-rewrite, pre-key-swap body —
          // exactly what the agent emitted (still compressed, with its
          // Content-Encoding recorded). See §3 / §6 invariant #2.
          captureHandle?.setRequestBody(rawBody);

          // The request as the agent meant it: decoded on a transformed route,
          // so observers and the pipeline below see JSON, never compressed bytes.
          let requestBody = rawBody;
          if (needsBodyTransform && contentCoding !== undefined) {
            try {
              // The same limit bounds the decoded body: past it, a 413. Each
              // decoded chunk is charged to this exchange's budget account as
              // the decoder produces it, so concurrent decompression bombs that
              // each stay under the limit cannot together hold more than the
              // bundle's budget, even while they decode (MITM-14).
              const coding = contentCoding;
              requestBody = await decodeInTurn(() =>
                decodeRequestBody(rawBody, coding, maxBodyBytes, (bytes) => account.charge(bytes)),
              );
            } catch (err: unknown) {
              if (isDecodeBudgetExhaustedError(err)) {
                logger.warn(
                  `[mitm-proxy] 503 ${method} ${targetHost}${displayPath} - decoding the ${contentCoding} body would exceed the ` +
                    `${describeByteSize(limits.maxBufferedBodyBytes)} buffered-body limit`,
                );
                writeRequestRefusal(clientRes, {
                  status: 503,
                  errorType: 'overloaded_error',
                  message: `too many request bodies buffered at once (limit ${describeByteSize(limits.maxBufferedBodyBytes)})`,
                  retryAfterSeconds: BUSY_RETRY_AFTER_SECONDS,
                });
                return;
              }
              if (!isRequestRejectedError(err)) throw err;
              answerRejectedRequest(err);
              return;
            }
          }

          let finalBody = requestBody;
          let forwardedObject: Readonly<Record<string, unknown>> | undefined;

          // Parse the (decoded) body once and share the object between the
          // token-stream tool-result extraction and the rewrite/sanitize pipeline
          // (MITM-10): parsing a body near the limit is the most expensive
          // synchronous step on the shared event loop. `parseJsonObjectBody`
          // parses strictly and throws for a body that must not be forwarded; on
          // a transformed route that refusal is answered here, before anything
          // reaches the upstream.
          let parsedBody: Record<string, unknown> | undefined;
          if (needsBodyTransform) {
            try {
              parsedBody = parseJsonObjectBody(requestBody);
            } catch (err: unknown) {
              if (!isRequestRejectedError(err)) throw err;
              answerRejectedRequest(err);
              return;
            }
          }

          // Extract tool_result events from the request body for token stream observation.
          // Snapshot here (before rewrite) so a concurrent setTokenSessionId
          // flip can't split this request's events across two ids.
          const sidForToolResults = tokenSessionId;
          if (sidForToolResults && isLlmMessagesEndpoint(path)) {
            try {
              // Reuse the parsed object on a transformed route; a body buffered
              // only for the 401 retry (at most 1 MB) is parsed here just for this.
              const bodyParsed = parsedBody ?? (JSON.parse(requestBody.toString()) as Record<string, unknown>);
              extractToolResults(bodyParsed, sidForToolResults);
            } catch {
              // Extraction is best-effort observation; it never affects forwarding.
            }
          }

          if (needsBodyTransform && parsedBody !== undefined) {
            // Fail closed: a body that cannot be parsed or sanitized is answered
            // here and never reaches the upstream (see request-sanitizers).
            let processed: ProcessedRequestBody;
            try {
              processed = processParsedRequestBody(
                parsedBody,
                requestBody,
                { rewriter: needsRewrite ? provider.config.requestRewriter : undefined, sanitizer },
                // Reuse the pre-rewrite tokenSessionId snapshot as the stable
                // per-conversation cacheKey so a concurrent setTokenSessionId flip
                // cannot split this request's session_id injection (§7.2).
                // The sanitizer checks the path that leaves the proxy.
                { method: String(method), path: forwardPath, agentKind, cacheKey: sidForToolResults },
              );
            } catch (err: unknown) {
              if (!isRequestRejectedError(err)) throw err;
              answerRejectedRequest(err);
              return;
            }
            finalBody = processed.body;
            forwardedObject = processed.forwardedJson;
            if (contentCoding !== undefined) {
              // The forwarded body is the decoded JSON; the 401 retry reuses these headers.
              clearContentEncoding(modifiedHeaders);
              logger.info(
                `[mitm-proxy] POST ${targetHost}${displayPath} - decoded ${contentCoding} request body ` +
                  `(${rawBody.length} -> ${requestBody.length} bytes)`,
              );
            }
            if (processed.rewritten.length > 0) {
              logger.info(
                `[mitm-proxy] POST ${targetHost}${displayPath} - rewrote: ${describeLabels(processed.rewritten)}`,
              );
            }
            // Headers are edited in place, so the 401 retry reuses them too. The
            // forwarded Content-Type is pinned to the canonical JSON body.
            const removed = [
              ...(sanitizer ? sanitizeRequestHeaders(sanitizer, modifiedHeaders) : []),
              ...processed.removed,
            ];
            if (removed.length > 0) {
              logger.warn(
                `[mitm-proxy] POST ${targetHost}${displayPath} - ${sanitizer?.protocol ?? 'request'} sanitizer removed: ${describeLabels(removed)}`,
              );
            }
          }

          if (requestGate) {
            // The facts the gate prices come from the body as forwarded: after
            // the rewriter (which may map the model) and the sanitizer.
            // A body buffered only for the 401 retry (at most 1 MB) is parsed here.
            const forwardedJson =
              forwardedObject ??
              (finalBody.length <= MAX_RETRY_BODY_BYTES ? parseJsonOrUndefined(finalBody) : undefined);
            if (!admitToBudget(forwardedJson, finalBody.length, false)) return;
          }
          observeBufferedMetricsRequest(requestBody, finalBody);
          forwardRequest(finalBody);
        } else {
          if (!admitToBudget(undefined, undefined, true)) return;
          forwardRequest();
        }
      }

      processRequest().catch((err: unknown) => {
        logger.info(`[mitm-proxy] request processing error: ${err instanceof Error ? err.message : String(err)}`);
        if (!clientRes.headersSent) {
          clientRes.writeHead(500, { 'Content-Type': 'text/plain' });
          clientRes.end('Internal proxy error');
        }
      });
    }),
  );

  // ── Plain HTTP proxy forwarding ──────────────────────────────────
  // When a client uses HTTP_PROXY for plain HTTP requests, it sends
  // e.g. "GET http://host:port/path" — an absolute URL as the request target.
  // Parse the absolute URL and return host/port/path, or null if not a proxy request.

  /**
   * Which passthrough rule, if any, admits a host:port that is neither a
   * provider nor a registry: an approval (`approved`), the deprecated
   * wildcard escape hatch (`wildcard`), or policy-evaluated egress
   * (`policy`; `approvalKey` is set when a human approval, earlier or just
   * now, settled it, so revoking the approval tears the tunnel down).
   */
  type PassthroughRoute =
    | { readonly kind: 'approved'; readonly approvalKey: string }
    | { readonly kind: 'wildcard' }
    | { readonly kind: 'policy'; readonly approvalKey?: string }
    | { readonly kind: 'denied'; readonly reason?: string };

  /** The approval a route was admitted under, if any (revocation tears its tunnels down). */
  function routeApprovalKey(route: PassthroughRoute): string | undefined {
    return route.kind === 'approved' || route.kind === 'policy' ? route.approvalKey : undefined;
  }

  /**
   * Resolve the passthrough route for a canonical host and port on the
   * CONNECT, plain-HTTP and WebSocket paths alike, without policy-evaluated
   * egress. An approval admits exactly its own `host:port`; the deprecated
   * IRONCURTAIN_MITM_ALLOW_ALL_HOSTS escape hatch admits any port of any
   * non-static host. Either way the address screen
   * ({@link screenPassthroughAddress}) applies before any tunnel is
   * acknowledged.
   */
  function resolvePassthroughRoute(host: string, port: number, isIpLiteral: boolean): PassthroughRoute {
    if (!passthroughEligible) return { kind: 'denied' };
    const approvalKey = formatPassthroughTarget(host, port);
    const approved = passthroughHosts.has(approvalKey);
    const wildcard = allowAllHosts && !isKnownStaticHost(host);
    if (!approved && !wildcard) return { kind: 'denied' };
    const refusal = screenPassthroughAddress(host, isIpLiteral);
    if (refusal !== undefined) return { kind: 'denied', reason: refusal };
    return approved ? { kind: 'approved', approvalKey } : { kind: 'wildcard' };
  }

  /**
   * The address screen every passthrough destination passes, whatever
   * admitted it. IP literals never reach a resolver, so the guarded lookup
   * that screens passthrough names cannot see them: they are screened here,
   * before any tunnel is acknowledged, and a loopback, link-local, private or
   * metadata literal is refused. Local and metadata-scoped names
   * (`localhost`, `*.internal`, `*.local`, ...) are refused here too,
   * mirroring the destination-bound transport's screen, so the raw tunnel
   * does not rely on the resolver alone for them. Returns the refusal reason,
   * or undefined when the destination may be dialed.
   */
  function screenPassthroughAddress(host: string, isIpLiteral: boolean): string | undefined {
    // Judge the canonical host itself, not only the parser's flag: whatever
    // text is about to be dialed as an address is screened as one.
    const literal = isIpLiteral || net.isIP(host) !== 0;
    if (literal && !isTunnelableLiteral(host)) return 'non-public IP literal';
    if (!literal && isLocalOrMetadataName(host)) return 'local or metadata name';
    return undefined;
  }

  // ── Policy-evaluated egress ──────────────────────────────────────────
  // With `policyEgress`, the session's coordinator decides every passthrough
  // destination (`egressAuthorizer.authorizeEgress`, a `network/request`
  // policy evaluation, audited). The proxy holds the escalate-once memory:
  // human approvals land in `passthroughHosts` (so list/remove_proxy_domain
  // see and revoke them, and SNI/Host pinning applies), human denials in
  // `deniedEgress`, and either is passed back as `prior` with the next
  // request to the same host:port.

  /**
   * The tail of the decisions queued for each `host:port`. Decisions for one
   * target run one at a time, so concurrent requests to a destination that
   * escalates raise one human escalation: the requests queued behind it are
   * decided after it, with its answer as `prior`. Different targets are
   * decided concurrently.
   */
  const egressDecisionTails = new Map<string, Promise<void>>();

  function serializeEgressDecision<T>(key: string, decide: () => Promise<T>): Promise<T> {
    const previous = egressDecisionTails.get(key) ?? Promise.resolve();
    const decision = previous.then(decide);
    const tail = decision.then(
      () => undefined,
      () => undefined,
    );
    egressDecisionTails.set(key, tail);
    void tail.then(() => {
      if (egressDecisionTails.get(key) === tail) egressDecisionTails.delete(key);
    });
    return decision;
  }

  /** One destination as the proxy asks about it (`method` is `CONNECT` for a tunnel). */
  type EgressTarget = Omit<EgressRequest, 'prior'>;

  /** A target for a log line; the path is agent-chosen, so it is escaped and bounded. */
  function describeEgressTarget(target: EgressTarget): string {
    const path = target.path === undefined ? '' : ` ${describeForLog(target.path)}`;
    return `${target.method} ${target.host}:${target.port}${path}`;
  }

  /**
   * Decide one passthrough destination under policy-evaluated egress. The
   * route is `denied` when no decider is attached, when it cannot decide
   * (closed coordinator, lost audit log), when policy or a human refuses,
   * and when the address screen refuses what policy allowed (defense in
   * depth: the coordinator's structural screen is stricter). Never rejects
   * for a refusal; callers still guard against defects.
   */
  function decideEgressRoute(target: EgressTarget, isIpLiteral: boolean): Promise<PassthroughRoute> {
    const approvalKey = formatPassthroughTarget(target.host, target.port);
    return serializeEgressDecision(approvalKey, async (): Promise<PassthroughRoute> => {
      const authorizer = egressAuthorizer;
      if (authorizer === undefined) {
        logger.warn(`[mitm-proxy] DENIED ${describeEgressTarget(target)}: no egress policy decider is attached`);
        return { kind: 'denied', reason: 'egress policy unavailable' };
      }
      const prior = passthroughHosts.has(approvalKey)
        ? 'approved'
        : deniedEgress.has(approvalKey)
          ? 'denied'
          : undefined;
      let decision: EgressDecision;
      try {
        decision = await authorizer.authorizeEgress({ ...target, ...(prior === undefined ? {} : { prior }) });
      } catch (error) {
        logger.warn(
          `[mitm-proxy] DENIED ${describeEgressTarget(target)}: egress policy failed: ${errorMessage(error)}`,
        );
        return { kind: 'denied', reason: 'egress policy unavailable' };
      }
      logger.info(
        `[mitm-proxy] egress ${describeEgressTarget(target)} -> ${decision.allowed ? 'ALLOWED' : 'DENIED'} ` +
          `(${decision.settledBy}, ${decision.rule})`,
      );
      if (decision.settledBy === 'human') recordHumanEgressDecision(target.host, target.port, decision.allowed);
      if (!decision.allowed) return { kind: 'denied', reason: decision.reason };
      const refusal = screenPassthroughAddress(target.host, isIpLiteral);
      if (refusal !== undefined) return { kind: 'denied', reason: refusal };
      if (decision.settledBy === 'policy') return { kind: 'policy' };
      // Settled by an approval: the route runs under it, so revoking the
      // approval (remove_proxy_domain) tears the tunnel down. One revoked
      // while this request waited admits nothing.
      if (!passthroughHosts.has(approvalKey)) return { kind: 'denied', reason: 'the approval was revoked' };
      return { kind: 'policy', approvalKey };
    });
  }

  /**
   * Escalate-once: remember a human's decision for `host:port`. An approval
   * becomes a passthrough approval (listed and revocable like one granted
   * through add_proxy_domain); a denial is remembered until an explicit
   * `addHost` approves the target.
   */
  function recordHumanEgressDecision(host: string, port: number, allowed: boolean): void {
    const approvalKey = formatPassthroughTarget(host, port);
    if (!allowed) {
      deniedEgress.add(approvalKey);
      return;
    }
    deniedEgress.delete(approvalKey);
    try {
      // The coordinator screened the target already; the same checks as
      // addHost keep the approval set to valid passthrough targets.
      validateDomain(host);
      validatePassthroughPort(port);
    } catch (error) {
      logger.warn(`[mitm-proxy] not recording the egress approval for ${approvalKey}: ${errorMessage(error)}`);
      return;
    }
    if (!isKnownStaticHost(host)) passthroughHosts.add(approvalKey);
  }

  /**
   * Under policy-evaluated egress, decide one request the proxy can read
   * (method and origin-form path) before `forward` runs; answer 403 when
   * policy refuses. The exchange was already admitted.
   */
  function authorizeReadableRequest(
    clientReq: http.IncomingMessage,
    clientRes: http.ServerResponse,
    host: string,
    port: number,
    path: string,
    forward: () => void,
  ): void {
    decideEgressRoute({ method: clientReq.method ?? 'GET', host, port, path }, net.isIP(host) !== 0)
      .then((route) => {
        // The client may have gone while the decision was pending (a human
        // can take minutes): nothing is forwarded for it then.
        if (clientRes.writableEnded || clientRes.destroyed || clientReq.socket.destroyed) return;
        if (route.kind === 'denied') {
          writeEgressRefusal(clientRes, route.reason);
          return;
        }
        forward();
      })
      .catch((error: unknown) => {
        logger.warn(`[mitm-proxy] egress decision failed for ${host}:${port}: ${errorMessage(error)}`);
        if (!clientRes.headersSent) {
          clientRes.writeHead(500, { 'Content-Type': 'text/plain', Connection: 'close' });
          clientRes.end('Internal proxy error');
        } else {
          clientRes.destroy();
        }
      });
  }

  /** 403 for a request the egress policy refused, with its reason (fixed rule text and canonical host only). */
  function writeEgressRefusal(clientRes: http.ServerResponse, reason: string | undefined): void {
    clientRes.writeHead(403, { 'Content-Type': 'text/plain', Connection: 'close' });
    clientRes.end(`Forbidden by egress policy${reason === undefined ? '' : `: ${reason}`}\n`);
  }

  /** Metadata names under every policy; other local names unless the test-only private opt-in is set. */
  function isLocalOrMetadataName(host: string): boolean {
    return isMetadataHostname(host) || (!allowPrivateDestinations && isLocalOrMetadataHostname(host));
  }

  /** The address policy for a literal destination (names go through `passthroughLookup`). */
  function isTunnelableLiteral(host: string): boolean {
    try {
      screenIpLiteral(host, { allowPrivate: allowPrivateDestinations });
      return true;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === 'ADDRESS_NOT_ALLOWED' || code === 'INVALID_IP_LITERAL') return false;
      throw error;
    }
  }

  function forwardPlainHttpPassthrough(
    clientReq: http.IncomingMessage,
    clientRes: http.ServerResponse,
    host: string,
    port: number,
    path: string,
  ): void {
    const { method, headers } = clientReq;

    logger.info(`[mitm-proxy] ${method} http://${host}:${port}${path} -> PASSTHROUGH (plain HTTP)`);

    // Strip proxy-only and hop-by-hop headers so they are not leaked upstream
    const hopByHop = new Set(HOP_BY_HOP_HEADERS);
    // Also strip any headers named in the Connection header
    for (const name of connectionNominatedHeaderNames(headers.connection)) hopByHop.add(name);
    // The Host header names the approved destination, never what the client
    // wrote: a client-chosen Host would address another site served from the
    // same address (the destination-bound transport enforces this as well).
    const forwardHeaders: Record<string, string | string[] | undefined> = {
      host: port === 80 ? host : `${host}:${port}`,
    };
    for (const [key, value] of Object.entries(headers)) {
      if (key !== 'host' && !hopByHop.has(key)) {
        forwardHeaders[key] = value;
      }
    }

    let upstreamReq: http.ClientRequest;
    try {
      upstreamReq = outboundTransport.request(
        {
          destination: { protocol: 'http:', hostname: host, port },
          method,
          path,
          headers: forwardHeaders,
        },
        guardUpstreamResponse(clientRes, (upstreamRes) => {
          upstreamRes.on('error', (err) => {
            const log = isConnectionReset(err) ? logger.debug : logger.info;
            log(`[mitm-proxy] upstream response error (plain HTTP passthrough): ${err.message}`);
            if (!clientRes.headersSent) {
              clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
              clientRes.end(`Upstream response error: ${err.message}`);
            } else {
              clientRes.socket?.destroy();
            }
          });

          clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          clientRes.flushHeaders();
          clientRes.socket?.setNoDelay(true);
          upstreamRes.pipe(clientRes);
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.info(`[mitm-proxy] upstream request rejected (plain HTTP passthrough): ${message}`);
      clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
      clientRes.end(`Upstream request rejected: ${message}`);
      return;
    }

    activeUpstreamRequests.add(upstreamReq);
    upstreamReq.on('close', () => activeUpstreamRequests.delete(upstreamReq));
    armUpstreamDeadlines(upstreamReq, limits);

    upstreamReq.on('error', (err) => {
      const log = isConnectionReset(err) ? logger.debug : logger.info;
      log(`[mitm-proxy] upstream error (plain HTTP passthrough): ${err.message}`);
      activeUpstreamRequests.delete(upstreamReq);
      answerUpstreamFailure(clientRes, err);
    });

    clientRes.on('close', () => {
      if (!upstreamReq.destroyed) {
        upstreamReq.destroy();
      }
    });

    clientReq.on('error', (err) => {
      const log = isConnectionReset(err) ? logger.debug : logger.info;
      log(`[mitm-proxy] client request error (plain HTTP passthrough): ${err.message}`);
      upstreamReq.destroy();
    });

    clientReq.pipe(upstreamReq);
  }

  // Outer server - UDS listener, handles CONNECT and plain HTTP proxy requests.
  // Every agent-side socket of this bundle arrives here, so `maxConnections`
  // is the backstop on how many it can hold open at once (MITM-14); the
  // per-kind ceilings below answer a clean 503 well before it is reached.
  const outerServer = options.transportTls ? https.createServer(options.transportTls) : http.createServer();
  outerServer.maxConnections = limits.maxClientConnections;
  // Include pre-HTTP TLS handshakes so stop() never waits for their deadline.
  outerServer.on('connection', (socket: Socket) => {
    activeClientSockets.add(socket);
    socket.once('close', () => activeClientSockets.delete(socket));
  });

  // Connection-source guard (tcp-hostonly topology): destroy sockets from
  // outside the allowed subnet before any HTTP parsing happens. Covers
  // plain requests, CONNECT, and WebSocket upgrades alike since all ride
  // on the same TCP connections.
  if (options.allowRemoteAddress) {
    const allowRemoteAddress = options.allowRemoteAddress;
    outerServer.on('connection', (socket) => {
      if (!allowRemoteAddress(socket.remoteAddress)) {
        socket.destroy();
      }
    });
  }

  outerServer.on(
    'request',
    guardRequestListener('outer request', (req, res) => {
      if (!consumeProxyAuthorization(req, options.requiredProxyAuthorization)) {
        res.writeHead(407, { 'Content-Type': 'text/plain', Connection: 'close' });
        res.end('Proxy Authentication Required');
        return;
      }
      // Side-effect-free round-trip probe for the macOS Docker sidecar. This
      // proves that traffic reached the host proxy, not merely the sidecar's
      // listening socket. The reserved host is never forwarded upstream.
      if (req.method === 'GET' && req.url === 'http://ironcurtain.invalid/__ironcurtain/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain', Connection: 'close' });
        res.end('IRONCURTAIN_OK/1\n');
        return;
      }
      // Handle plain HTTP proxy requests. HTTP proxy clients send absolute URLs:
      // "GET http://host:port/path HTTP/1.1". The target is parsed strictly
      // (canonical host, port 1-65535, IP literals classified) into hostname,
      // port, and origin-form path before dispatching; a malformed target is a
      // 400, never a forwarded request.
      //
      // Debian (apt) uses plain HTTP, so Debian registry hosts are intercepted
      // here and routed through the same registry-validation / audit-log path
      // as HTTPS CONNECT traffic. The absolute URL is rewritten to origin-form
      // (req.url = target.path) before dispatching because handleRegistryRequest
      // and its helpers read clientReq.url as a path.
      //
      // Approved passthrough targets (host:port) and wildcard-eligible hosts
      // are forwarded without content inspection (no package validation, no
      // credential swap).
      const target = parseProxyRequestTarget(req.url ?? '');
      if (target.kind === 'invalid') {
        logger.info(
          `[mitm-proxy] DENIED malformed proxy request target ${describeForLog(req.url ?? '')}: ${target.reason}`,
        );
        res.writeHead(400, { 'Content-Type': 'text/plain', Connection: 'close' });
        res.end('Bad Request');
        return;
      }
      if (target.kind === 'not-proxy') {
        // Not a proxy request (relative URL) — reject
        res.writeHead(405, { 'Content-Type': 'text/plain' });
        res.end('Method Not Allowed');
        return;
      }

      // Debian registry: route through package validation and audit logging.
      // Rewrite absolute URL to origin-form path so registry handlers can read it.
      // Forward to the HTTPS upstream port (not the client's plain-HTTP :80) — see
      // REGISTRY_UPSTREAM_HTTPS_PORT: the registry proxy always re-originates TLS.
      const debianRegistry = registriesByHost.get(target.host);
      if (debianRegistry?.type === 'debian') {
        if (admitRequest(req, res, `http://${target.host}${target.path}`) === undefined) return;
        req.url = target.path;
        dispatchRegistryRequest(debianRegistry, req, res, target.host, REGISTRY_UPSTREAM_HTTPS_PORT);
        return;
      }

      // Policy-evaluated egress decides every other host (a provider or
      // registry over plain HTTP stays refused below), per request and path.
      if (policyEgress && !isKnownStaticHost(target.host)) {
        if (admitRequest(req, res, `http://${target.host}:${target.port}${target.path}`) === undefined) return;
        authorizeReadableRequest(req, res, target.host, target.port, target.path, () =>
          forwardPlainHttpPassthrough(req, res, target.host, target.port, target.path),
        );
        return;
      }

      const route = resolvePassthroughRoute(target.host, target.port, target.isIpLiteral);
      if (route.kind !== 'denied') {
        if (admitRequest(req, res, `http://${target.host}:${target.port}${target.path}`) === undefined) return;
        forwardPlainHttpPassthrough(req, res, target.host, target.port, target.path);
        return;
      }
      // Valid proxy request but the host:port is not in any allowlist
      logger.info(
        `[mitm-proxy] DENIED ${req.method ?? 'GET'} http://${target.host}:${target.port}${route.reason ? ` (${route.reason})` : ''}`,
      );
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
    }),
  );

  interface PassthroughTunnelParams {
    readonly connId: number;
    readonly clientSocket: Socket;
    readonly head: Buffer;
    readonly host: string;
    readonly port: number;
    /** The `host:port` approval this tunnel runs under; undefined for the wildcard escape hatch. */
    readonly approvalKey: string | undefined;
    /** Relay only once the client's TLS ClientHello names `host` in its SNI. */
    readonly pinSni: boolean;
  }

  /**
   * Open the raw TCP tunnel for a passthrough CONNECT. The CONNECT is
   * acknowledged immediately per standard proxy behavior; the client
   * discovers upstream failures itself once it tries to send data.
   *
   * With `pinSni` the relay first reads the client's TLS ClientHello and
   * refuses the tunnel unless its SNI equals the approved host (and unless
   * the bytes are TLS at all), so an approval for `example.com:443` cannot be
   * used to reach other tenants behind the same address by sending a
   * different SNI inside the tunnel. A client that sends no SNI is refused.
   * The pin cannot see past Encrypted ClientHello: an ECH hello whose outer
   * name is the approved host is relayed (Chromium sends indistinguishable
   * GREASE ECH on every connection), and is logged as such; see
   * tls-client-hello.ts. Host-header fronting inside the encrypted session
   * is likewise invisible here and is left to the origin's own SNI/Host
   * consistency checks.
   */
  function openPassthroughTunnel(params: PassthroughTunnelParams): void {
    const { connId, clientSocket, head, host, port, approvalKey, pinSni } = params;
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

    const dial = (initialBytes: Buffer): void => {
      if (clientSocket.destroyed) return;
      // The tunnel bypasses the destination-bound transport, so it carries its
      // own copy of the address policy: a passthrough name resolving to a
      // private or link-local address is refused, not relayed. IP literals
      // never reach this lookup; they were screened before the 200, and are
      // screened again here so the dial itself never depends on how the
      // authority was parsed.
      if (net.isIP(host) !== 0 && !isTunnelableLiteral(host)) {
        logger.info(`[mitm-proxy] #${connId} CONNECT tunnel refused non-public literal ${host}:${port}`);
        clientSocket.destroy();
        return;
      }
      let upstreamSocket: Socket;
      try {
        upstreamSocket = tunnelDial({ host, port, lookup: passthroughLookup });
      } catch (error) {
        // Backstop only: the authority was validated before the tunnel was
        // acknowledged, so a synchronous dial failure here is a defect, and
        // it must still cost no more than this one connection.
        logger.info(`[mitm-proxy] #${connId} CONNECT tunnel dial rejected: ${errorMessage(error)}`);
        clientSocket.destroy();
        return;
      }

      // Track for cleanup (stop() and approval revocation)
      const pair: TunnelPair = { client: clientSocket, upstream: upstreamSocket, approvalKey };
      activeTunnelPairs.add(pair);

      const cleanup = (): void => {
        activeTunnelPairs.delete(pair);
        if (!clientSocket.destroyed) clientSocket.destroy();
        if (!upstreamSocket.destroyed) upstreamSocket.destroy();
      };

      upstreamSocket.once('connect', () => {
        // Replay the bytes already read from the client (the CONNECT head and,
        // for a pinned tunnel, the ClientHello), then pipe both directions.
        if (initialBytes.length > 0) {
          upstreamSocket.write(initialBytes);
        }
        clientSocket.pipe(upstreamSocket);
        upstreamSocket.pipe(clientSocket);
      });

      clientSocket.on('error', (err) => {
        const log = isConnectionReset(err) ? logger.debug : logger.info;
        log(`[mitm-proxy] #${connId} CONNECT tunnel client error: ${err.message}`);
        cleanup();
      });
      clientSocket.on('close', cleanup);
      upstreamSocket.on('error', (err) => {
        const log = isConnectionReset(err) ? logger.debug : logger.info;
        log(`[mitm-proxy] #${connId} CONNECT tunnel upstream error: ${err.message}`);
        cleanup();
      });
      upstreamSocket.on('close', cleanup);

      // Close the tunnel after a stretch with no bytes either way (MITM-14):
      // an idle tunnel to an approved domain no longer stays open
      // indefinitely. Traffic and WebSocket keep-alives keep it alive.
      armTunnelIdleTimeout(clientSocket, upstreamSocket, `#${connId} CONNECT tunnel ${host}:${port}`, cleanup);
    };

    if (!pinSni) {
      dial(head);
      return;
    }

    readClientHello(clientSocket, head, { timeoutMs: CLIENT_HELLO_TIMEOUT_MS })
      .then(({ serverName, encryptedClientHello, bytes }) => {
        // Exact match, ASCII case aside. The SNI is relayed to the origin
        // verbatim, so no other spelling (trailing dot, percent or Unicode
        // forms the URL host parser would fold) is accepted as "the same
        // name": the origin must see exactly the approved host.
        if (serverName?.toLowerCase() !== host) {
          logger.info(
            `[mitm-proxy] #${connId} DENIED passthrough ${host}:${port}: TLS SNI ` +
              `${serverName === undefined ? 'absent' : describeForLog(serverName)} does not name the approved host`,
          );
          clientSocket.destroy();
          return;
        }
        if (encryptedClientHello) {
          // Audit signal only (see openPassthroughTunnel): real ECH and the
          // GREASE ECH every Chromium sends look the same on the wire.
          logger.info(
            `[mitm-proxy] #${connId} passthrough ${host}:${port}: ClientHello offers Encrypted ClientHello; ` +
              'the outer SNI matches, the inner name is not visible to the proxy',
          );
        }
        dial(bytes);
      })
      .catch((error: unknown) => {
        const reason = isClientHelloError(error) ? `${error.code}: ${error.message}` : errorMessage(error);
        logger.info(`[mitm-proxy] #${connId} DENIED passthrough ${host}:${port}: ${reason}`);
        clientSocket.destroy();
      });
  }

  // ── Plain-HTTP passthrough tunnels (port-80 approvals) ─────────────
  // A CONNECT to an approved `host:80` is not relayed as opaque bytes:
  // inside a raw tunnel the Host header could name any other site served
  // from the same address (Host-header fronting on a shared CDN edge, the
  // plain-HTTP twin of the SNI fronting the 443 tunnel refuses). The
  // acknowledged tunnel is handed to this in-process HTTP server instead.
  // Every request in it is re-originated to the approved host:80 through the
  // destination-bound transport, which owns the Host header, exactly like
  // an absolute-form plain-HTTP proxy request, and WebSocket upgrades are
  // bridged the same way. Bytes that are not HTTP get a 400, and a nested
  // CONNECT closes the tunnel (this server has no 'connect' listener).

  interface PlainHttpTunnel {
    readonly socket: Socket;
    readonly host: string;
    readonly port: number;
    /**
     * The `host:80` approval the tunnel was opened under; undefined for a
     * tunnel the egress policy admitted by rule, which has none to revoke.
     */
    readonly approvalKey?: string;
    /** Admitted by policy-evaluated egress: every request in it is decided again, at path granularity. */
    readonly policyEvaluated: boolean;
  }
  const plainHttpTunnelBySocket = new WeakMap<Socket, PlainHttpTunnel>();
  const activePlainHttpTunnels = new Set<PlainHttpTunnel>();

  const plainTunnelServer = http.createServer();

  /**
   * The tunnel a request arrived on, while the approval it was opened under
   * still stands (a tunnel the egress policy admitted by rule has no
   * approval; policy decides each of its requests instead).
   */
  function livePlainHttpTunnel(socket: Socket): PlainHttpTunnel | undefined {
    const tunnel = plainHttpTunnelBySocket.get(socket);
    if (tunnel === undefined) return undefined;
    if (tunnel.approvalKey === undefined) return tunnel.policyEvaluated ? tunnel : undefined;
    return passthroughHosts.has(tunnel.approvalKey) ? tunnel : undefined;
  }

  /** Only origin-form belongs inside a tunnel: the tunnel already names its destination. */
  function isOriginFormPath(path: string): boolean {
    return path.startsWith('/') && !path.startsWith('//');
  }

  plainTunnelServer.on('clientError', (err, socket) => {
    const log = isConnectionReset(err) ? logger.debug : logger.info;
    log(`[mitm-proxy] plain-HTTP tunnel parse error: ${err.message}`);
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n', () => socket.destroy());
    } else {
      socket.destroy();
    }
  });

  plainTunnelServer.on(
    'request',
    guardRequestListener('plain tunnel request', (req, res) => {
      const tunnel = livePlainHttpTunnel(req.socket);
      if (tunnel === undefined) {
        res.writeHead(403, { 'Content-Type': 'text/plain', Connection: 'close' });
        res.end('Forbidden');
        return;
      }
      const path = req.url ?? '';
      if (!isOriginFormPath(path)) {
        logger.info(`[mitm-proxy] DENIED non-origin-form target in tunnel to ${tunnel.host}: ${describeForLog(path)}`);
        res.writeHead(400, { 'Content-Type': 'text/plain', Connection: 'close' });
        res.end('Bad Request');
        return;
      }
      if (admitRequest(req, res, `http://${tunnel.host}:${tunnel.port}${path}`) === undefined) return;
      if (tunnel.policyEvaluated) {
        authorizeReadableRequest(req, res, tunnel.host, tunnel.port, path, () =>
          forwardPlainHttpPassthrough(req, res, tunnel.host, tunnel.port, path),
        );
        return;
      }
      forwardPlainHttpPassthrough(req, res, tunnel.host, tunnel.port, path);
    }),
  );

  plainTunnelServer.on(
    'upgrade',
    guardSocketListener('plain tunnel upgrade', (req: http.IncomingMessage, socket: Socket, head: Buffer) => {
      const tunnel = livePlainHttpTunnel(socket);
      const path = req.url ?? '';
      if (tunnel === undefined || !isOriginFormPath(path)) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      // The socket stops being an HTTP connection here: the bridge's own
      // handshake and idle timeouts replace the request-head and idle
      // deadlines, which would otherwise close a live WebSocket that sends no
      // further request head (or one waiting for an egress decision). The
      // tunnel's slot already covers the bridge.
      decryptedConnections.untrack(socket);
      const bridge = (approvalKey: string | undefined): void => {
        logger.info(`[mitm-proxy] WebSocket upgrade ws://${tunnel.host}:${tunnel.port}${path} → PASSTHROUGH (tunnel)`);
        bridgeWebSocketUpgrade(socket, head, tunnel.host, tunnel.port, path, req.headers, approvalKey);
      };
      if (!tunnel.policyEvaluated) {
        bridge(tunnel.approvalKey);
        return;
      }
      decideEgressRoute({ method: req.method ?? 'GET', host: tunnel.host, port: tunnel.port, path }, false)
        .then((route) => {
          if (socket.destroyed) return;
          if (route.kind === 'denied') {
            socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
            return;
          }
          // The bridge runs under the approval that settled it, if any.
          bridge(routeApprovalKey(route) ?? tunnel.approvalKey);
        })
        .catch((error: unknown) => {
          logger.warn(`[mitm-proxy] egress decision failed for a tunnel upgrade: ${errorMessage(error)}`);
          socket.destroy();
        });
    }),
  );

  /** Acknowledge a CONNECT to an admitted `host:80` and serve it as HTTP (see above). */
  function openPlainHttpTunnel(
    clientSocket: Socket,
    head: Buffer,
    host: string,
    port: number,
    admission: { readonly approvalKey?: string; readonly policyEvaluated: boolean },
  ): void {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) clientSocket.unshift(head);
    const tunnel: PlainHttpTunnel = { socket: clientSocket, host, port, ...admission };
    plainHttpTunnelBySocket.set(clientSocket, tunnel);
    activePlainHttpTunnels.add(tunnel);
    clientSocket.once('close', () => activePlainHttpTunnels.delete(tunnel));
    // The tunnel server never listens either, so the request-head and idle
    // deadlines of the decrypted connections apply to the tunnel (MITM-14).
    decryptedConnections.track(clientSocket);
    plainTunnelServer.emit('connection', clientSocket);
  }

  outerServer.on(
    'connect',
    guardSocketListener('connect', (req: http.IncomingMessage, clientSocket: Socket, head: Buffer) => {
      if (!consumeProxyAuthorization(req, options.requiredProxyAuthorization)) {
        clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\n\r\n');
        return;
      }
      const url = req.url ?? '';
      const connId = ++connectionId;
      const metricsLeaseToken = parseMetricsProxyAuthorization(req.headers['proxy-authorization']);

      // Handle client socket errors early to prevent uncaught 'error' events
      clientSocket.on('error', (err) => {
        const log = isConnectionReset(err) ? logger.debug : logger.info;
        log(`[mitm-proxy] #${connId} client socket error: ${err.message}`);
        clientSocket.destroy();
      });

      // Track raw client socket for cleanup during stop()
      activeClientSockets.add(clientSocket);
      clientSocket.on('close', () => activeClientSockets.delete(clientSocket));

      /** Refuse before any tunnel is acknowledged: a status line, then the socket is dropped. */
      const refuse = (status: string, why: string): void => {
        logger.info(`[mitm-proxy] #${connId} DENIED ${why}`);
        clientSocket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
        clientSocket.destroy();
      };

      // Parse the authority strictly BEFORE anything else happens: canonical
      // host (lowercase, no trailing dot, IDNA), decimal port 1-65535, IPv6 only
      // in brackets. The former `lastIndexOf(':')` + parseInt split accepted
      // `host:99999`, `host:abc`, `host:-1`, `host:0` and `host:443junk`, and
      // Node then threw ERR_SOCKET_BAD_PORT synchronously out of this listener
      // (killing the process) when the tunnel dialed. Canonicalizing here is
      // also what keeps `CONNECT API.TEST.COM:443` and `api.test.com.:443` on
      // the provider path instead of an "unknown host" passthrough tunnel.
      const authority =
        listenerMode.kind === 'registry-egress' ? parseRegistryConnectAuthority(url) : parseConnectAuthority(url);
      if (authority === undefined) {
        refuse(
          listenerMode.kind === 'registry-egress' ? '403 Forbidden' : '400 Bad Request',
          `malformed CONNECT authority ${describeForLog(url)}`,
        );
        return;
      }
      const { host, port, isIpLiteral } = authority;

      // 1. Check allowlist (providers, registries, and dynamic passthrough).
      // Build-egress and registry-egress modes have none of these — every host is
      // TLS-terminated so the request layer can authorize it against the frozen
      // manifest (or 403 it).
      const provider = providersByHost.get(host);
      const registry = registriesByHost.get(host);

      /** Steps 2-4: open what the admitted route calls for. */
      const dispatchConnect = (passthroughRoute: PassthroughRoute): void => {
        const isPassthrough = passthroughRoute.kind !== 'denied';
        // An approval or a policy decision names one host on one port; the
        // wildcard escape hatch names none.
        const pinnedRoute = passthroughRoute.kind === 'approved' || passthroughRoute.kind === 'policy';
        const approvalKey = routeApprovalKey(passthroughRoute);
        const passthroughKind =
          passthroughRoute.kind === 'approved'
            ? 'passthrough'
            : passthroughRoute.kind === 'policy'
              ? 'passthrough-policy'
              : 'passthrough-wildcard';
        const connType =
          listenerMode.kind === 'standard'
            ? provider
              ? 'provider'
              : registry
                ? 'registry'
                : passthroughKind
            : listenerMode.kind;

        // 2. An admitted plain-HTTP target (`host:80`) is served by the
        //    HTTP-aware tunnel in direct and nested mode alike: every request is
        //    re-originated to the admitted host through the destination-bound
        //    transport, which owns the Host header (see openPlainHttpTunnel).
        if (pinnedRoute && port === PLAIN_HTTP_PASSTHROUGH_PORT) {
          // A port-80 tunnel holds a client connection open like a raw tunnel
          // does, so it counts against the same ceiling (MITM-14).
          if (!admitTunnel(clientSocket, `#${connId} CONNECT ${host}:${port}`)) return;
          logger.info(`[mitm-proxy] #${connId} CONNECT ${host}:${port} → HTTP TUNNEL (${connType}, Host-pinned)`);
          openPlainHttpTunnel(clientSocket, head, host, port, {
            ...(approvalKey === undefined ? {} : { approvalKey }),
            policyEvaluated: passthroughRoute.kind === 'policy',
          });
          return;
        }

        // 3. Direct outer proxies may use a raw TCP tunnel for passthrough
        //    domains, and only in `standard` mode: the tunnel never consults a
        //    guard, so an egress listener must never reach it (`passthroughEligible`).
        //    Nested proxies must not expose a caller-selected CONNECT
        //    primitive through the fixed parent transport, so they terminate TLS
        //    below and re-originate HTTP(S) with the destination bound separately
        //    from request headers. WSS on that nested path is intentionally
        //    rejected by innerServer's upgrade handler.
        if (listenerMode.kind === 'standard' && isPassthrough && outboundTransport.kind === 'direct') {
          // Bound the raw tunnels this bundle holds open at once (MITM-14).
          if (!admitTunnel(clientSocket, `#${connId} CONNECT ${host}:${port}`)) return;
          // An approval (or an egress-policy decision) covers one host on one
          // port. On 443 the tunnel is relayed only once the ClientHello names
          // that host (SNI pinning). Under the wildcard escape hatch egress
          // filtering is off for unknown hosts by definition, so its tunnels
          // stay raw; only the address screen applies there.
          const pinSni = pinnedRoute && port === DEFAULT_PASSTHROUGH_PORT;
          logger.info(
            `[mitm-proxy] #${connId} CONNECT ${host}:${port} → TUNNEL (${connType}${pinSni ? ', SNI-pinned' : ''})`,
          );
          openPassthroughTunnel({ connId, clientSocket, head, host, port, approvalKey, pinSni });
          return;
        }

        // 4. For provider/registry connections (and nested passthrough), MITM with TLS termination.

        // Bound the TLS-terminated connections this bundle holds open (MITM-14).
        if (activeTlsSockets.size >= limits.maxConcurrentTlsConnections) {
          logger.warn(
            `[mitm-proxy] #${connId} REFUSED CONNECT ${host}:${port} - ` +
              `${limits.maxConcurrentTlsConnections} TLS connections already open`,
          );
          clientSocket.end(RAW_SERVICE_UNAVAILABLE);
          return;
        }

        // The leaf is the one for the admitted CONNECT host, minted (or reused)
        // before the CONNECT is acknowledged so a host no leaf can be issued for
        // is refused cleanly (MITM-7). A peer-chosen SNI name is never minted: a
        // compromised agent looping CONNECT with a fresh random SNI used to cost
        // ~50 ms of blocked event loop and a cache entry per name.
        let hostSecureContext: tls.SecureContext;
        try {
          hostSecureContext = getOrCreateSecureContext(host);
        } catch (err) {
          refuse('403 Forbidden', `CONNECT ${host}:${port} — cannot issue leaf: ${errorMessage(err)}`);
          return;
        }
        logger.info(`[mitm-proxy] #${connId} CONNECT ${host}:${port} → MITM (${connType})`);

        // Acknowledge the CONNECT
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

        // Push back any bytes that arrived after the CONNECT request line
        if (head.length > 0) {
          clientSocket.unshift(head);
        }

        // Upgrade to TLS (MITM). The CONNECT host's leaf is the default context
        // (served when the ClientHello carries no SNI); a ClientHello naming any
        // other host is refused in every listener mode.
        const tlsSocket = new tls.TLSSocket(clientSocket, {
          isServer: true,
          secureContext: hostSecureContext,
          SNICallback: (servername, cb) => {
            const sni = canonicalizeHostname(servername);
            if (sni === undefined) {
              cb(new Error('TLS SNI is not a valid hostname'));
              return;
            }
            // Only the admitted CONNECT host's leaf is ever served, in every
            // listener mode (MITM-7): a certificate for any other name would let
            // the client address a different tenant inside the tunnel, and a
            // mint per peer-chosen name would hand the peer the event loop and
            // the leaf cache.
            if (sni !== host) {
              cb(new Error(`TLS SNI must match the authorized CONNECT host ${host}`));
              return;
            }
            cb(null, hostSecureContext);
          },
        });

        // TLS handshake timeout - if the handshake completes, the 'secure'
        // event clears this timer. If it fires, the handshake never completed.
        const handshakeTimeout = setTimeout(() => {
          logger.info(`[mitm-proxy] #${connId} TLS handshake timeout`);
          tlsSocket.destroy();
        }, 10_000);
        tlsSocket.once('secure', () => clearTimeout(handshakeTimeout));

        // Request-head and idle deadlines (MITM-14); see `decryptedConnections`.
        decryptedConnections.track(tlsSocket);

        // Track the connection
        activeTlsSockets.add(tlsSocket);
        socketMetadata.set(tlsSocket, {
          provider: provider ?? undefined,
          registry,
          passthrough: isPassthrough,
          approvalKey,
          policyEvaluated: passthroughRoute.kind === 'policy',
          host,
          port,
          metricsLeaseToken,
        });

        tlsSocket.on('error', (err) => {
          const log = isConnectionReset(err) ? logger.debug : logger.info;
          log(`[mitm-proxy] #${connId} TLS error: ${err.message}`);
          tlsSocket.destroy();
        });
        tlsSocket.on('close', () => {
          clearTimeout(handshakeTimeout);
          activeTlsSockets.delete(tlsSocket);
        });

        // Emit into shared inner HTTP server
        innerServer.emit('connection', tlsSocket);
      };

      // Policy-evaluated egress: the session's policy decides every
      // destination that is neither a provider nor a registry, at host:port,
      // before the CONNECT is answered. The client waits meanwhile (possibly
      // for a human); its socket is not read until the tunnel opens.
      if (policyEgress && !provider && !registry) {
        decideEgressRoute({ method: 'CONNECT', host, port }, isIpLiteral)
          .then((route) => {
            if (clientSocket.destroyed) return;
            if (route.kind === 'denied') {
              refuse(
                '403 Forbidden',
                `CONNECT ${host}:${port} (egress policy${route.reason === undefined ? '' : `: ${route.reason}`})`,
              );
              return;
            }
            dispatchConnect(route);
          })
          .catch((error: unknown) => {
            // Contained like a listener throw: this one connection only.
            logger.warn(
              `[mitm-proxy] #${connId} CONNECT ${host}:${port}: egress decision failed: ${errorMessage(error)}`,
            );
            clientSocket.destroy();
          });
        return;
      }

      const passthroughRoute: PassthroughRoute =
        !provider && !registry ? resolvePassthroughRoute(host, port, isIpLiteral) : { kind: 'denied' };
      if (listenerMode.kind === 'standard' && !provider && !registry && passthroughRoute.kind === 'denied') {
        refuse(
          '403 Forbidden',
          `CONNECT ${host}:${port}${passthroughRoute.reason ? ` (${passthroughRoute.reason})` : ''}`,
        );
        return;
      }
      if (
        listenerMode.kind === 'registry-egress' &&
        !listenerMode.guard.manifest?.origins.some((origin) => origin.hostname === host && origin.port === port)
      ) {
        refuse('403 Forbidden', `registry-egress CONNECT ${host}:${port}`);
        return;
      }
      dispatchConnect(passthroughRoute);
    }),
  );

  // ── Plain HTTP WebSocket upgrade ──────────────────────────────────
  // When a client sends "GET http://host/path" with Upgrade: websocket
  // through the proxy, the outer server emits an 'upgrade' event instead
  // of routing through the normal 'request' handler.
  outerServer.on(
    'upgrade',
    guardSocketListener('upgrade', (req: http.IncomingMessage, clientSocket: Socket, head: Buffer) => {
      if (!consumeProxyAuthorization(req, options.requiredProxyAuthorization)) {
        clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\n\r\n');
        return;
      }
      const parsed = parseProxyRequestTarget(req.url ?? '');
      if (parsed.kind === 'invalid') {
        clientSocket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      const forbidden = (): void => {
        clientSocket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      };
      if (parsed.kind !== 'proxy') {
        forbidden();
        return;
      }
      const target = parsed;

      clientSocket.on('error', (err) => {
        const log = isConnectionReset(err) ? logger.debug : logger.info;
        log(`[mitm-proxy] WebSocket client socket error: ${err.message}`);
      });

      // Track the raw client socket for cleanup during stop(), like a CONNECT
      // socket. An upgraded socket is no HTTP connection of the outer server
      // any more: closeAllConnections() skips it, and while an egress decision
      // is pending (a human can take minutes) nothing reads it, so not even
      // its client leaving ends it. Untracked, it held outerServer.close()
      // until the decision landed, and a late admit then bridged upstream
      // after the proxy had stopped.
      activeClientSockets.add(clientSocket);
      clientSocket.once('close', () => activeClientSockets.delete(clientSocket));

      const bridge = (route: PassthroughRoute): void => {
        // A WebSocket bridge holds a tunnel pair for as long as the raw CONNECT
        // tunnels do, so it counts against the same ceiling (MITM-14).
        if (!admitTunnel(clientSocket, `WebSocket ws://${target.host}:${target.port}`)) return;
        logger.info(`[mitm-proxy] WebSocket upgrade ws://${target.host}:${target.port}${target.path} → PASSTHROUGH`);
        bridgeWebSocketUpgrade(
          clientSocket,
          head,
          target.host,
          target.port,
          target.path,
          req.headers,
          routeApprovalKey(route),
        );
      };

      // Policy-evaluated egress decides the upgrade request like any other
      // readable request: method, host, port and path.
      if (policyEgress && !isKnownStaticHost(target.host)) {
        decideEgressRoute(
          { method: req.method ?? 'GET', host: target.host, port: target.port, path: target.path },
          target.isIpLiteral,
        )
          .then((route) => {
            if (clientSocket.destroyed) return;
            if (route.kind === 'denied') {
              forbidden();
              return;
            }
            bridge(route);
          })
          .catch((error: unknown) => {
            logger.warn(`[mitm-proxy] egress decision failed for a WebSocket upgrade: ${errorMessage(error)}`);
            clientSocket.destroy();
          });
        return;
      }

      const route = resolvePassthroughRoute(target.host, target.port, target.isIpLiteral);
      if (route.kind === 'denied') {
        forbidden();
        return;
      }
      bridge(route);
    }),
  );

  // ── Passthrough request forwarding ──────────────────────────────────
  // For dynamically added domains: forward requests as-is with no
  // credential replacement or endpoint filtering.

  function forwardPassthrough(
    clientReq: http.IncomingMessage,
    clientRes: http.ServerResponse,
    host: string,
    port: number,
  ): void {
    const { method, url: path, headers } = clientReq;

    // Default to HTTPS; use HTTP only for well-known cleartext ports
    const useHttps = port !== 80 && port !== 8080;
    const proto = useHttps ? 'https' : 'http';
    logger.info(`[mitm-proxy] ${method} ${proto}://${host}:${port}${path} -> PASSTHROUGH`);

    // Strip hop-by-hop headers (and any the client nominated in Connection)
    // so connection-level directives never cross the proxy boundary; the
    // transport re-frames the body that is piped into it. The Host header is
    // the approved host, never the client's (see forwardPlainHttpPassthrough).
    const hopByHop = new Set(HOP_BY_HOP_HEADERS);
    for (const name of connectionNominatedHeaderNames(headers.connection)) hopByHop.add(name);
    const forwardHeaders: Record<string, string | string[] | undefined> = { host };
    for (const [key, value] of Object.entries(headers)) {
      if (key !== 'host' && !hopByHop.has(key)) {
        forwardHeaders[key] = value;
      }
    }

    let upstreamReq: http.ClientRequest;
    try {
      upstreamReq = outboundTransport.request(
        {
          destination: { protocol: useHttps ? 'https:' : 'http:', hostname: host, port },
          method,
          path: path ?? '/',
          headers: forwardHeaders,
        },
        guardUpstreamResponse(clientRes, (upstreamRes) => {
          upstreamRes.on('error', (err) => {
            const log = isConnectionReset(err) ? logger.debug : logger.info;
            log(`[mitm-proxy] upstream response error (passthrough): ${err.message}`);
            if (!clientRes.headersSent) {
              clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
              clientRes.end(`Upstream response error: ${err.message}`);
            } else {
              clientRes.socket?.destroy();
            }
          });

          clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          clientRes.flushHeaders();
          clientRes.socket?.setNoDelay(true);
          upstreamRes.pipe(clientRes);
        }),
      );
    } catch (error) {
      // The destination-bound transport rejects synchronously (an
      // absolute-form path, a header it cannot forward, a destination its
      // address policy refuses). Contained here like the plain-HTTP and
      // WebSocket paths: thrown out of this listener it would end the process.
      const message = errorMessage(error);
      logger.info(`[mitm-proxy] upstream request rejected (passthrough): ${message}`);
      clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
      clientRes.end(`Upstream request rejected: ${message}`);
      return;
    }

    activeUpstreamRequests.add(upstreamReq);
    upstreamReq.on('close', () => activeUpstreamRequests.delete(upstreamReq));
    armUpstreamDeadlines(upstreamReq, limits);

    upstreamReq.on('error', (err) => {
      const log = isConnectionReset(err) ? logger.debug : logger.info;
      log(`[mitm-proxy] upstream error (passthrough): ${err.message}`);
      activeUpstreamRequests.delete(upstreamReq);
      answerUpstreamFailure(clientRes, err);
    });

    clientRes.on('close', () => {
      if (!upstreamReq.destroyed) {
        upstreamReq.destroy();
      }
    });

    clientReq.on('error', (err) => {
      const log = isConnectionReset(err) ? logger.debug : logger.info;
      log(`[mitm-proxy] client request error (passthrough): ${err.message}`);
      upstreamReq.destroy();
    });

    clientReq.pipe(upstreamReq);
  }

  /** Format an HTTP response line + headers for writing to a raw socket. */
  function formatRawHttpResponse(res: http.IncomingMessage): string {
    const statusLine = `HTTP/${res.httpVersion} ${res.statusCode} ${res.statusMessage}`;
    const headerLines = Object.entries(res.headers)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
      .join('\r\n');
    return `${statusLine}\r\n${headerLines}\r\n\r\n`;
  }

  // ── WebSocket upgrade bridging ───────────────────────────────────

  /**
   * Bridges a WebSocket upgrade from the client socket to an upstream server.
   * Preserves WebSocket-specific headers and pipes both sockets bidirectionally.
   */
  function bridgeWebSocketUpgrade(
    clientSocket: Socket,
    head: Buffer,
    targetHost: string,
    targetPort: number,
    path: string,
    requestHeaders: http.IncomingHttpHeaders,
    approvalKey?: string,
  ): void {
    // Build headers: preserve WebSocket headers, strip other hop-by-hop
    const forwardHeaders: Record<string, string | string[] | undefined> = {
      host: targetPort === 80 ? targetHost : `${targetHost}:${targetPort}`,
    };
    for (const [key, value] of Object.entries(requestHeaders)) {
      const lower = key.toLowerCase();
      if (lower === 'host') continue;

      // Strip hop-by-hop and proxy-only headers, but preserve Connection/Upgrade
      // (and Sec-WebSocket-*) so the upgrade handshake reaches the upstream.
      if (lower !== 'connection' && lower !== 'upgrade' && HOP_BY_HOP_HEADERS.has(lower)) {
        continue;
      }

      forwardHeaders[key] = value;
    }

    let upstreamReq: http.ClientRequest;
    try {
      upstreamReq = outboundTransport.request({
        destination: { protocol: 'http:', hostname: targetHost, port: targetPort },
        method: 'GET',
        path,
        headers: forwardHeaders,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.info(`[mitm-proxy] WebSocket upgrade request rejected: ${message}`);
      if (!clientSocket.destroyed) {
        clientSocket.end(
          'HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
        );
      }
      return;
    }
    upstreamReq.setTimeout(30_000);
    activeUpstreamRequests.add(upstreamReq);

    // Raw WebSocket responses do not use ServerResponse, but must satisfy
    // the same status contract and contain failures at this exchange.
    const writeUpgradeResponse = (response: http.IncomingMessage, upstreamSocket?: Socket): boolean => {
      try {
        if (!isValidUpstreamStatus(response.statusCode)) throw new Error('Invalid upstream status');
        clientSocket.write(formatRawHttpResponse(response));
        return true;
      } catch {
        for (const stream of [response, upstreamSocket, upstreamReq]) {
          try {
            stream?.destroy();
          } catch {
            // A cleanup failure must remain local to this handshake too.
          }
        }
        try {
          if (!clientSocket.destroyed && !clientSocket.writableEnded) {
            clientSocket.end(
              'HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
            );
          }
        } catch {
          try {
            clientSocket.destroy();
          } catch {
            // Nothing else can safely be written to this client.
          }
        }
        return false;
      }
    };

    upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
      activeUpstreamRequests.delete(upstreamReq);
      if (!writeUpgradeResponse(upstreamRes, upstreamSocket)) return;

      // The 30 s handshake timeout belongs to the upgrade request, not to the
      // bridged stream: drop it (and its 504 writer, which would otherwise
      // inject an HTTP status line into the WebSocket stream) before the
      // tunnel's own idle timeout takes over.
      upstreamReq.removeAllListeners('timeout');
      upstreamSocket.removeAllListeners('timeout');

      // Track the pair for cleanup (stop() and approval revocation)
      const pair: TunnelPair = { client: clientSocket, upstream: upstreamSocket, approvalKey };
      activeTunnelPairs.add(pair);

      const cleanup = (): void => {
        activeTunnelPairs.delete(pair);
        if (!clientSocket.destroyed) clientSocket.destroy();
        if (!upstreamSocket.destroyed) upstreamSocket.destroy();
      };

      clientSocket.on('error', cleanup);
      clientSocket.on('close', cleanup);
      upstreamSocket.on('error', cleanup);
      upstreamSocket.on('close', cleanup);

      // Close the bridge after a stretch with no frames either way (MITM-14);
      // traffic and WebSocket pings keep it open.
      armTunnelIdleTimeout(clientSocket, upstreamSocket, `WebSocket ${targetHost}:${targetPort}`, cleanup);

      // Write any buffered data from the upgrade
      if (upstreamHead.length > 0) {
        clientSocket.write(upstreamHead);
      }
      if (head.length > 0) {
        upstreamSocket.write(head);
      }

      // Bidirectional pipe
      clientSocket.pipe(upstreamSocket);
      upstreamSocket.pipe(clientSocket);
    });

    upstreamReq.on('response', (res) => {
      activeUpstreamRequests.delete(upstreamReq);
      if (!writeUpgradeResponse(res)) return;
      res.pipe(clientSocket);
      clientSocket.on('close', () => upstreamReq.destroy());
    });

    upstreamReq.on('error', (err) => {
      activeUpstreamRequests.delete(upstreamReq);
      const log = isConnectionReset(err) ? logger.debug : logger.info;
      log(`[mitm-proxy] WebSocket upgrade upstream error: ${err.message}`);
      if (!clientSocket.destroyed) {
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      }
    });

    upstreamReq.on('timeout', () => {
      logger.info(`[mitm-proxy] WebSocket upgrade timeout for ${targetHost}:${targetPort}${path}`);
      upstreamReq.destroy();
      if (!clientSocket.destroyed) {
        clientSocket.end('HTTP/1.1 504 Gateway Timeout\r\n\r\n');
      }
    });

    upstreamReq.end();
  }

  // ── DynamicHostController ─────────────────────────────────────────

  const hostController: DynamicHostController = {
    addHost(domain: string, port: number = DEFAULT_PASSTHROUGH_PORT): boolean {
      validateDomain(domain);
      validatePassthroughPort(port);
      const host = canonicalHostKey(domain);
      // Statically configured hosts keep their dedicated path. A registry
      // host approved as passthrough would route its plain-HTTP traffic
      // around package validation, exactly like a provider would lose its
      // key swap and endpoint filtering.
      if (providersByHost.has(host) || registriesByHost.has(host)) return false;
      const approvalKey = formatPassthroughTarget(host, port);
      // An explicit approval overrides a remembered egress denial for the
      // same target (a human approved add_proxy_domain for it).
      deniedEgress.delete(approvalKey);
      if (passthroughHosts.has(approvalKey)) return false;
      passthroughHosts.add(approvalKey);
      // No leaf is minted here: a direct proxy tunnels passthrough hosts raw,
      // and a nested one mints on the first CONNECT to the host (MITM-7).
      return true;
    },

    removeHost(domain: string, port: number = DEFAULT_PASSTHROUGH_PORT): boolean {
      const approvalKey = formatPassthroughTarget(canonicalHostKey(domain), port);
      if (!passthroughHosts.delete(approvalKey)) return false;
      // Revocation is immediate: tunnels opened under this approval go too.
      for (const pair of activeTunnelPairs) {
        if (pair.approvalKey !== approvalKey) continue;
        activeTunnelPairs.delete(pair);
        if (!pair.client.destroyed) pair.client.destroy();
        if (!pair.upstream.destroyed) pair.upstream.destroy();
      }
      for (const tunnel of activePlainHttpTunnels) {
        if (tunnel.approvalKey !== approvalKey) continue;
        activePlainHttpTunnels.delete(tunnel);
        if (!tunnel.socket.destroyed) tunnel.socket.destroy();
      }
      // TLS-terminated (nested) passthrough connections opened under it.
      for (const tlsSocket of activeTlsSockets) {
        if (socketMetadata.get(tlsSocket)?.approvalKey !== approvalKey) continue;
        if (!tlsSocket.destroyed) tlsSocket.destroy();
      }
      return true;
    },

    listHosts(): DomainListing {
      return {
        providers: [...providersByHost.keys()],
        dynamic: [...passthroughHosts],
      };
    },
  };

  // ── HTTP Control API server ───────────────────────────────────────
  // Runs on a separate socket, NOT mounted into the container, and requires
  // a per-bundle bearer token minted here: in TCP mode the control port is
  // a loopback TCP listener that any local process (or, through Docker
  // Desktop's host gateway, any container on the host) could otherwise use
  // to approve domains without an escalation. The token travels only to the
  // in-process control client and the virtual proxy-tool relay.

  const controlToken = randomBytes(32).toString('base64url');
  const expectedControlAuthorization = Buffer.from(`Bearer ${controlToken}`, 'utf8');

  function isAuthorizedControlRequest(req: http.IncomingMessage): boolean {
    const header = req.headers.authorization;
    if (typeof header !== 'string') return false;
    const actual = Buffer.from(header, 'utf8');
    return (
      actual.length === expectedControlAuthorization.length && timingSafeEqual(actual, expectedControlAuthorization)
    );
  }

  /** Body of an add/remove request: a domain plus an optional port (default 443). */
  function parseControlTarget(body: Buffer): { domain: string; port: number } | { error: string } {
    const parsed: unknown = JSON.parse(body.toString());
    if (typeof parsed !== 'object' || parsed === null) return { error: 'Request body must be a JSON object' };
    const { domain, port } = parsed as { domain?: unknown; port?: unknown };
    if (typeof domain !== 'string' || !domain) return { error: 'Missing required field: domain' };
    if (port === undefined) return { domain, port: DEFAULT_PASSTHROUGH_PORT };
    if (typeof port !== 'number' || !Number.isInteger(port)) return { error: 'Field port must be an integer' };
    return { domain, port };
  }

  const controlServer = http.createServer();
  controlServer.on('request', guardRequestListener('control request', handleControlRequest));

  function handleControlRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url ?? '';

    if (!isAuthorizedControlRequest(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer', Connection: 'close' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    if (url === '/__ironcurtain/domains' && req.method === 'GET') {
      const listing = hostController.listHosts();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(listing));
      return;
    }

    if (url === '/__ironcurtain/domains/add' && req.method === 'POST') {
      bufferRequestBody(req, 4096)
        .then((body) => {
          const target = parseControlTarget(body);
          if ('error' in target) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: target.error }));
            return;
          }
          try {
            const added = hostController.addHost(target.domain, target.port);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ added }));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
          }
        })
        .catch((err: unknown) => {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end(err instanceof Error ? err.message : String(err));
        });
      return;
    }

    if (url === '/__ironcurtain/domains/remove' && req.method === 'POST') {
      bufferRequestBody(req, 4096)
        .then((body) => {
          const target = parseControlTarget(body);
          if ('error' in target) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: target.error }));
            return;
          }
          const removed = hostController.removeHost(target.domain, target.port);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ removed }));
        })
        .catch((err: unknown) => {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end(err instanceof Error ? err.message : String(err));
        });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }

  const useTcp = options.listenPort !== undefined;
  if (!useTcp && !options.socketPath) {
    throw new Error('MitmProxyOptions: either socketPath or listenPort must be provided');
  }
  const listenHost = options.listenHost ?? DEFAULT_MITM_LISTEN_HOST;
  if (useTcp && !isLoopbackListenHost(listenHost) && options.allowRemoteAddress === undefined) {
    // Fail closed: a listener reachable from other interfaces must have a
    // connection-source guard, or every LAN peer gets the session's proxy.
    throw new Error(
      `MitmProxyOptions: binding the MITM listener to ${listenHost} requires allowRemoteAddress ` +
        '(a non-loopback listener must have a connection-source guard)',
    );
  }

  /** Starts the control API server and returns its address info. */
  async function startControlServer(): Promise<
    Pick<MitmProxyAddress, 'controlSocketPath' | 'controlPort' | 'controlToken'>
  > {
    if (useTcp && options.controlPort !== undefined) {
      return new Promise((resolve, reject) => {
        const onError = reject;
        controlServer.listen(options.controlPort, '127.0.0.1', () => {
          controlServer.removeListener('error', onError);
          const addr = controlServer.address();
          const port = addr && typeof addr === 'object' ? addr.port : (options.controlPort ?? 0);
          resolve({ controlPort: port, controlToken });
        });
        controlServer.once('error', onError);
      });
    }

    if (options.controlSocketPath) {
      if (existsSync(options.controlSocketPath)) {
        unlinkSync(options.controlSocketPath);
      }
      return new Promise((resolve, reject) => {
        const onError = reject;
        controlServer.listen(options.controlSocketPath, () => {
          controlServer.removeListener('error', onError);
          resolve({ controlSocketPath: options.controlSocketPath, controlToken });
        });
        controlServer.once('error', onError);
      });
    }

    // No control socket configured -- return empty
    return {};
  }

  return {
    hosts: hostController,

    setTokenSessionId(id: import('../session/types.js').SessionId | undefined): void {
      tokenSessionId = id;
    },

    setCaptureSessionId(id: import('../session/types.js').SessionId | undefined): void {
      captureSessionId = id;
    },

    setCapturePersona(persona: string | undefined): void {
      capturePersona = persona;
    },

    beginMetricsInvocation(baseProxyUrl: string, context: MetricsInvocationContext): MetricsInvocationLease {
      const lease = metricsAttributionRegistry.createLease(baseProxyUrl, context);
      if (options.requiredProxyAuthorization === undefined) return lease;
      return Object.freeze({
        ...lease,
        proxyUrl: proxyAuthorizedUrl(
          lease.proxyUrl,
          { header: options.requiredProxyAuthorization },
          decodeURIComponent(new URL(lease.proxyUrl).password),
        ),
      });
    },

    setEgressAuthorizer(authorizer: EgressAuthorizer | undefined): void {
      egressAuthorizer = authorizer;
    },

    async start() {
      // Emit the egress-filter downgrade notice once per actual listening
      // proxy. Construction-time logging would fire even for proxies that
      // are created and discarded (tests, aborted setup).
      // Only a listener with passthrough honors the variable at all; an
      // egress listener (which starts first in a Docker-workload bundle)
      // would otherwise put the "filtering DISABLED" variant on the terminal
      // even while policy-evaluated egress makes the bundle ignore it.
      if (allowAllHostsRequested && passthroughEligible) noteAllowAllHostsDeprecated(policyEgress);
      if (streamDelayConfig) {
        logger.warn(
          `[mitm-proxy] DEBUG IRONCURTAIN_MITM_STREAM_DELAY_MS is set — injecting ${streamDelayConfig.delayMs}ms ` +
            `(${streamDelayConfig.mode}) idle gaps into LLM completion responses` +
            `${streamDelayConfig.hostFilter ? ` for hosts matching "${streamDelayConfig.hostFilter}"` : ''}. NOT FOR PRODUCTION.`,
        );
      }

      // Leaves are minted lazily, on the first CONNECT to each host (MITM-7).
      // A mint is one native signature with the process's shared leaf key
      // pair; generating that key pair is the only expensive step, and it runs
      // here, off the event loop, before the proxy accepts a connection. (This
      // replaces the synchronous pre-mint of every provider and registry host,
      // about 0.6 s of blocked event loop per bundle start.)
      await prepareLeafIssuance(options.ca);
      decryptedConnections.start();

      const controlResult = await startControlServer();

      if (useTcp) {
        // TCP mode: bind loopback unless the topology asked for (and guards) a
        // wider address; see MitmProxyOptions.listenHost.
        return new Promise((resolve, reject) => {
          const onError = reject;
          outerServer.listen(options.listenPort, listenHost, () => {
            outerServer.removeListener('error', onError);
            const addr = outerServer.address();
            const port = addr && typeof addr === 'object' ? addr.port : (options.listenPort ?? 0);
            const host = addr && typeof addr === 'object' ? addr.address : listenHost;
            resolve({ port, host, ...controlResult });
          });
          outerServer.once('error', onError);
        });
      }

      // UDS mode: listen on socket path
      const socketPath = options.socketPath ?? '';
      if (existsSync(socketPath)) {
        unlinkSync(socketPath);
      }

      return new Promise((resolve, reject) => {
        const onError = reject;
        outerServer.listen(socketPath, () => {
          outerServer.removeListener('error', onError);
          resolve({ socketPath, ...controlResult });
        });
        outerServer.once('error', onError);
      });
    },

    async stop() {
      decryptedConnections.stop();
      // Finalize partial observations before tearing transports down so exact
      // attribution leases cannot remain held behind asynchronous decoders.
      for (const observer of [...activeMetricsObservers]) {
        observer.abort('proxy_stopped');
      }
      activeMetricsObservers.clear();

      // 1. Destroy active tunnel pairs (CONNECT passthrough + WebSocket bridges)
      //    and the HTTP-aware port-80 tunnels.
      for (const pair of activeTunnelPairs) {
        if (!pair.client.destroyed) pair.client.destroy();
        if (!pair.upstream.destroyed) pair.upstream.destroy();
      }
      activeTunnelPairs.clear();
      for (const tunnel of activePlainHttpTunnels) {
        if (!tunnel.socket.destroyed) tunnel.socket.destroy();
      }
      activePlainHttpTunnels.clear();

      // 2. Abort all in-flight upstream requests, then drop the idle
      // keep-alive connections of a transport this proxy created.
      for (const req of activeUpstreamRequests) {
        req.destroy();
      }
      activeUpstreamRequests.clear();
      if (ownsOutboundTransport) outboundTransport.close?.();

      // 3. Destroy all active TLS sockets and raw client sockets.
      // Must happen before outerServer.close() because the raw sockets
      // are still tracked by the underlying net.Server, and close()
      // waits for all TCP connections to end.
      for (const sock of activeTlsSockets) {
        sock.destroy();
      }
      activeTlsSockets.clear();
      for (const sock of activeClientSockets) {
        sock.destroy();
      }
      activeClientSockets.clear();

      // 4. Close outer server - stop accepting new connections.
      // closeAllConnections() handles any non-upgraded HTTP connections.
      outerServer.closeAllConnections();
      await new Promise<void>((resolve) => {
        outerServer.close(() => resolve());
      });

      // 5. Close the inner HTTP servers (decrypted connections, port-80 tunnels).
      innerServer.closeAllConnections();
      innerServer.close();
      plainTunnelServer.closeAllConnections();
      plainTunnelServer.close();

      // 6. Close the control API server.
      controlServer.closeAllConnections();
      await new Promise<void>((resolve) => {
        controlServer.close(() => resolve());
      });

      // 7. Clean up socket files (UDS mode only)
      if (!useTcp && options.socketPath) {
        try {
          if (existsSync(options.socketPath)) {
            unlinkSync(options.socketPath);
          }
        } catch {
          // Ignore cleanup errors
        }
      }
      if (options.controlSocketPath) {
        try {
          if (existsSync(options.controlSocketPath)) {
            unlinkSync(options.controlSocketPath);
          }
        } catch {
          // Ignore cleanup errors
        }
      }
    },
  };
}

/** Set once the ALLOW_ALL_HOSTS deprecation notice reached stderr in this process. */
let allowAllHostsNoticePrinted = false;

/**
 * IRONCURTAIN_MITM_ALLOW_ALL_HOSTS is deprecated (owner decision, WP-118):
 * policy-evaluated egress (`egressPolicy` in config.json: allowedHosts
 * wildcards, every decision audited, other hosts escalated once per host and
 * port) replaces it. The variable still works without that opt-in, and is
 * ignored with it. Every proxy start logs the warning to the session log;
 * the terminal gets it once per process (a daemon starts many proxies).
 */
function noteAllowAllHostsDeprecated(ignored: boolean): void {
  const notice = ignored
    ? 'IRONCURTAIN_MITM_ALLOW_ALL_HOSTS is deprecated and ignored: policy-evaluated egress (egressPolicy.enabled) decides unknown hosts'
    : 'IRONCURTAIN_MITM_ALLOW_ALL_HOSTS is deprecated and will be removed: unknown hosts are tunneled with egress filtering DISABLED. ' +
      'Use egressPolicy (enabled, allowedHosts wildcards) in ~/.ironcurtain/config.json instead';
  logger.warn(`[mitm-proxy] ${notice}`);
  if (allowAllHostsNoticePrinted) return;
  allowAllHostsNoticePrinted = true;
  const lead = process.stderr.isTTY ? '\r\x1b[K' : '';
  process.stderr.write(`${lead}Warning: ${notice}\n`);
}

/**
 * Attempts to refresh the OAuth token and retry the request.
 * Called when upstream returns 401 and a token manager is available.
 */
function retryWithRefreshedToken(
  tokenManager: OAuthTokenManager,
  provider: ProviderKeyMapping,
  headers: Record<string, string | string[] | undefined>,
  body: Buffer,
  clientRes: http.ServerResponse,
  forwardRequest: (bodyOverride?: Buffer, isRetry?: boolean) => void,
): void {
  tokenManager
    .handleAuthFailure()
    .then((newToken) => {
      if (newToken) {
        provider.realKey = newToken;
        injectRealKey(headers, provider.config.keyInjection, provider.realKey);
        forwardRequest(body, true);
      } else if (!clientRes.headersSent) {
        clientRes.writeHead(401, { 'Content-Type': 'text/plain' });
        clientRes.end('Authentication failed: unable to refresh OAuth token.');
      }
    })
    .catch(() => {
      if (!clientRes.headersSent) {
        clientRes.writeHead(401, { 'Content-Type': 'text/plain' });
        clientRes.end('Authentication failed: token refresh error.');
      }
    });
}
