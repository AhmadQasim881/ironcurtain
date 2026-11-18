/**
 * Destination-bound HTTP(S) transport for MITM and registry upstreams.
 *
 * Callers supply a trusted destination separately from request headers. The
 * transport owns Host/SNI, applies a public-only policy by default, and permits
 * private destinations only for an explicit trusted provider override. It
 * resolves and screens every destination name locally, never follows redirects,
 * and can route through one fixed parent HTTP proxy without exposing a
 * caller-selected CONNECT primitive.
 *
 * ## The child is the address authority
 *
 * Both transports enforce the same destination-address policy in *this*
 * process, before any byte reaches the network: a literal destination is
 * screened against the request's address policy, and a destination *name* is
 * resolved through a guarded resolver that rejects the entire answer set if
 * any answer violates that policy.
 *
 * The parent-proxy transport cannot delegate that check upward. A parent cannot
 * re-derive a derived-CDN authority: such a host is authorized only as the
 * immediate `Location` of one specific authorized response, so a parent
 * registry-egress listener would see a *client-initiated* request to an unlisted
 * host and fail closed, and a standard-mode parent would simply 403 the CONNECT.
 * The child is therefore the only place the address policy can be enforced, and
 * {@link OutboundTransport.addressGuard} publishes that property so a caller
 * whose destination is attacker-influenced (registry-egress redirect following)
 * can *require* it instead of assuming it.
 *
 * The direct transport keeps one keep-alive pool per address policy and passes
 * it on every request, because the guarded resolver only screens the sockets a
 * pool opens: a socket opened for a trusted private provider gateway must never
 * serve a public-only request for the same name and port.
 *
 * ## Accepted residual: no address pinning through the parent
 *
 * On the direct path the screened answer set is also the answer set used to
 * connect, so the check and the connection cannot diverge. Through the parent,
 * the child screens the name and the parent then re-resolves it, so the guarded
 * resolver restores the *policy* check but not direct mode's *pinning*
 * property: a TTL-0 DNS rebind landing between the two resolutions can still
 * reach a private address. Pinning by sending the resolved literal as the
 * CONNECT authority is not an option — that authority is also the SNI and
 * certificate-validation identity, and the provider/registry paths require the
 * real name (see `servername` below). The residual is accepted under this
 * project's trusted-host model (an IronCurtain-owned parent on a trusted host,
 * reaching a reviewed frozen set of origins) and is recorded here rather than
 * left implied.
 *
 * ## Not yet wired: the parent-proxy transport
 *
 * Production uses only {@link createDirectOutboundTransport}: the provider MITM
 * creates one by default and shares it with the registry proxy, the nested
 * registry-egress listener is handed one, and package egress refuses an
 * injected transport. {@link createParentProxyOutboundTransport} has no
 * production caller. It is the transport an inner IronCurtain coordinator
 * would select from trusted parent-bootstrap state in the
 * IronCurtain-in-IronCurtain slice, which is reserved and not scheduled
 * (docs/designs/ironcurtain-in-ironcurtain-hermetic-slice.md). It is kept,
 * with its tests, as that slice's foundation, and is never a user-configurable
 * parent-proxy setting.
 *
 * The address classifiers and the guarded resolver live in the shared leaf
 * `src/net/address-policy.ts`; they are re-exported here for existing callers.
 */

import * as dns from 'node:dns';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as tls from 'node:tls';
import type { Duplex } from 'node:stream';

import {
  canonicalizeHostname,
  createGuardedLookup,
  isAddressAllowed,
  isLocalOrMetadataHostname,
  isMetadataHostname,
  type AddressPolicy,
} from '../net/address-policy.js';

export { createGuardedLookup, isPublicAddress } from '../net/address-policy.js';

export type OutboundProtocol = 'http:' | 'https:';
export type OutboundAddressPolicy = AddressPolicy;

export interface OutboundDestination {
  readonly protocol: OutboundProtocol;
  readonly hostname: string;
  readonly port: number;
}

export interface DestinationBoundRequest {
  readonly destination: OutboundDestination;
  /**
   * Public-only by default. The trusted provider-routing branch may opt into a
   * host-configured private gateway; untrusted passthrough, redirects, build,
   * and registry callers must never set this.
   */
  readonly addressPolicy?: OutboundAddressPolicy;
  readonly method: string | undefined;
  readonly path: string;
  readonly headers?: http.OutgoingHttpHeaders;
}

/**
 * Where the destination-address policy is enforced for this transport.
 *
 * - `local-resolver`: this process resolves the destination name and refuses a
 *   non-public answer before any I/O — the guarantee callers can rely on.
 * - `delegated`: some other hop is assumed to apply the policy. A caller that
 *   forwards an attacker-influenced destination (e.g. a derived redirect) must
 *   refuse such a transport rather than assume the assumption holds.
 */
export type OutboundAddressGuard = 'local-resolver' | 'delegated';

export interface OutboundTransport {
  readonly kind: 'direct' | 'fixed-parent-proxy';
  /** Checked capability, not an assumption; see {@link OutboundAddressGuard}. */
  readonly addressGuard: OutboundAddressGuard;
  request(request: DestinationBoundRequest, onResponse?: (response: http.IncomingMessage) => void): http.ClientRequest;
  /** Drop the transport's pooled idle connections. Its owner calls this when it stops using the transport. */
  close?(): void;
}

export interface DirectOutboundTransportOptions {
  /** Test seam. Production uses node:dns.lookup. */
  readonly lookup?: typeof dns.lookup;
  /** Test-only escape hatch for loopback fake upstreams. */
  readonly allowPrivateDestinationsForTests?: boolean;
}

export type FixedParentProxyEndpoint =
  | { readonly socketPath: string; readonly hostname?: never; readonly port?: never }
  | { readonly socketPath?: never; readonly hostname: string; readonly port: number };

export interface ParentProxyOutboundTransportOptions {
  readonly proxy: FixedParentProxyEndpoint;
  /** Extra public CA material for the TLS connection inside CONNECT. */
  readonly ca?: string | readonly string[];
  /** Test seam. Production uses node:dns.lookup. */
  readonly lookup?: typeof dns.lookup;
  /** Test-only escape hatch for loopback fake upstreams. */
  readonly allowPrivateDestinationsForTests?: boolean;
}

/**
 * One keep-alive pool per address policy. The guarded resolver runs only when a
 * pool opens a new socket, and Node keys pooled sockets by host and port (plus
 * TLS options), never by resolver. A single shared pool, such as Node's global
 * agents, would therefore hand a socket that the trusted-provider lookup opened
 * to a private gateway to a later public-only request for the same name and
 * port (an approved passthrough host, a plain-HTTP or `ws://` passthrough),
 * skipping that request's address screen.
 */
interface AddressPolicyPool {
  readonly lookup: typeof dns.lookup;
  readonly http: http.Agent;
  readonly https: https.Agent;
}

function createAddressPolicyPool(lookup: typeof dns.lookup): AddressPolicyPool {
  // The same pooling behavior as Node's global agents.
  const agentOptions = { keepAlive: true, scheduling: 'lifo', timeout: 5_000, lookup } as const;
  return { lookup, http: new http.Agent(agentOptions), https: new https.Agent(agentOptions) };
}

export function createDirectOutboundTransport(options: DirectOutboundTransportOptions = {}): OutboundTransport {
  const resolver = options.lookup ?? dns.lookup;
  const publicPool = createAddressPolicyPool(createGuardedLookup(resolver, false));
  const trustedPrivatePool = createAddressPolicyPool(createGuardedLookup(resolver, true));
  const allowPrivateForEveryRequest = options.allowPrivateDestinationsForTests === true;
  return {
    kind: 'direct',
    addressGuard: 'local-resolver',
    request(request, onResponse) {
      const allowPrivate = allowPrivateForEveryRequest || request.addressPolicy === 'trusted-provider-override';
      const normalized = normalizeRequest(request, allowPrivate);
      // Every request names its policy's pool explicitly: no request, including
      // the passthrough WebSocket bridge, falls back to a shared global agent.
      const pool = allowPrivate ? trustedPrivatePool : publicPool;
      const requestOptions: http.RequestOptions = {
        hostname: normalized.destination.hostname,
        port: normalized.destination.port,
        method: normalized.method,
        path: normalized.path,
        headers: normalized.headers,
        lookup: pool.lookup,
      };
      return normalized.destination.protocol === 'https:'
        ? https.request({ ...requestOptions, agent: pool.https }, onResponse)
        : http.request({ ...requestOptions, agent: pool.http }, onResponse);
    },
    close() {
      for (const pool of [publicPool, trustedPrivatePool]) {
        pool.http.destroy();
        pool.https.destroy();
      }
    },
  };
}

/**
 * Route every request through one fixed parent HTTP proxy. Not yet wired: no
 * production path calls this; it is reserved for the IronCurtain-in-IronCurtain
 * slice (see the module comment).
 */
export function createParentProxyOutboundTransport(options: ParentProxyOutboundTransportOptions): OutboundTransport {
  const proxy = normalizeProxyEndpoint(options.proxy);
  const resolver = options.lookup ?? dns.lookup;
  const publicScreen = createDestinationScreen(resolver, false);
  const trustedPrivateScreen = createDestinationScreen(resolver, true);
  const publicHttpsAgent = new FixedParentProxyHttpsAgent(proxy, options.ca, publicScreen);
  const publicHttpAgent = new FixedParentProxyHttpAgent(proxy, publicScreen);
  const trustedPrivateHttpsAgent = new FixedParentProxyHttpsAgent(proxy, options.ca, trustedPrivateScreen);
  const trustedPrivateHttpAgent = new FixedParentProxyHttpAgent(proxy, trustedPrivateScreen);
  const allowPrivateForEveryRequest = options.allowPrivateDestinationsForTests === true;
  return {
    kind: 'fixed-parent-proxy',
    addressGuard: 'local-resolver',
    request(request, onResponse) {
      // This child is the address authority: the parent cannot re-derive a
      // derived-CDN authority, so it cannot be the place the address policy is
      // applied. Literal/local destinations are refused here, and both agents
      // screen the destination *name* against the guarded resolver before any
      // CONNECT authority or absolute-form target is written to the parent.
      const allowPrivate = allowPrivateForEveryRequest || request.addressPolicy === 'trusted-provider-override';
      const normalized = normalizeRequest(request, allowPrivate);
      if (normalized.destination.protocol === 'http:') {
        const absolutePath =
          `http://${formatAuthority(normalized.destination.hostname, normalized.destination.port, 'http:')}` +
          normalized.path;
        return http.request(
          {
            hostname: normalized.destination.hostname,
            port: normalized.destination.port,
            method: normalized.method,
            path: absolutePath,
            headers: normalized.headers,
            agent: allowPrivate ? trustedPrivateHttpAgent : publicHttpAgent,
          },
          onResponse,
        );
      }
      return https.request(
        {
          hostname: normalized.destination.hostname,
          port: normalized.destination.port,
          method: normalized.method,
          path: normalized.path,
          headers: normalized.headers,
          agent: allowPrivate ? trustedPrivateHttpsAgent : publicHttpsAgent,
        },
        onResponse,
      );
    },
  };
}

/**
 * Screen one destination *name* by resolving it through the shared guarded
 * resolver and discarding the answer. A literal destination has already been
 * screened by {@link assertHostnameIsEligible}, so it needs no resolution (and
 * `net.connect` would not resolve it either).
 */
type DestinationScreen = (hostname: string, done: (error: Error | null) => void) => void;

function createDestinationScreen(lookup: typeof dns.lookup, allowPrivate: boolean): DestinationScreen {
  const guarded = createGuardedLookup(lookup, allowPrivate);
  return (hostname, done) => {
    if (net.isIP(hostname) !== 0) {
      done(null);
      return;
    }
    guarded(hostname, { all: true }, (error) => done(error ?? null));
  };
}

/**
 * Reaches the fixed parent proxy for a plain-HTTP (absolute-form) request.
 *
 * The destination screen lives in `createConnection` — the same place the HTTPS
 * agent screens before writing its CONNECT authority — so both branches share
 * one control, an asynchronous check never makes `request()` asynchronous, and
 * no absolute-form target for a rejected destination is ever written to the
 * parent.
 */
class FixedParentProxyHttpAgent extends http.Agent {
  constructor(
    private readonly proxy: http.RequestOptions,
    private readonly screenDestination: DestinationScreen,
  ) {
    super({ keepAlive: false });
  }

  override createConnection(
    options: http.ClientRequestArgs,
    callback: (error: Error | null, stream?: Duplex) => void,
  ): Duplex | null | undefined {
    const hostname = normalizeHostname(options.hostname ?? options.host ?? '');
    this.screenDestination(hostname, (error) => {
      if (error) {
        callback(error);
        return;
      }
      callback(null, net.connect(parentConnectOptions(this.proxy)));
    });
    return undefined;
  }
}

class FixedParentProxyHttpsAgent extends https.Agent {
  constructor(
    private readonly proxy: http.RequestOptions,
    private readonly extraCa: string | readonly string[] | undefined,
    private readonly screenDestination: DestinationScreen,
  ) {
    super({ keepAlive: false });
  }

  override createConnection(
    options: https.RequestOptions,
    callback: (error: Error | null, stream?: Duplex) => void,
  ): Duplex | null | undefined {
    const hostname = normalizeHostname(options.hostname ?? options.host ?? '');
    const port = normalizePort(Number(options.port ?? 443));
    // CONNECT always carries an explicit port, including the default 443.
    // Unlike an HTTP Host header, the authority-form request target has no
    // surrounding scheme from which a proxy could infer a missing port.
    const authority = formatConnectAuthority(hostname, port);
    let settled = false;
    const done = (error: Error | null, stream?: Duplex): void => {
      if (settled) return;
      settled = true;
      callback(error, stream);
    };
    // Screen before the CONNECT authority reaches the parent: a name resolving
    // to a non-public address must fail here, not become a parent request.
    this.screenDestination(hostname, (screenError) => {
      if (screenError) {
        done(screenError);
        return;
      }
      const connectRequest = http.request({
        ...this.proxy,
        method: 'CONNECT',
        path: authority,
        headers: { host: authority },
      });
      connectRequest.once('connect', (response, socket, head) => {
        if (response.statusCode !== 200) {
          socket.destroy();
          done(new Error(`fixed parent proxy refused ${authority} with status ${response.statusCode ?? 'unknown'}`));
          return;
        }
        if (head.length > 0) socket.unshift(head);
        const connectionOptions: tls.ConnectionOptions = {
          socket,
          // SNI and certificate validation bind to the NAME, never to a
          // resolved literal — that is why the parent path cannot pin.
          servername: net.isIP(hostname) === 0 ? hostname : undefined,
        };
        if (this.extraCa !== undefined) {
          connectionOptions.ca = typeof this.extraCa === 'string' ? this.extraCa : [...this.extraCa];
        }
        const secureSocket = tls.connect(connectionOptions);
        secureSocket.once('secureConnect', () => done(null, secureSocket));
        secureSocket.once('error', (error) => done(error));
      });
      connectRequest.once('error', (error) => done(error));
      connectRequest.end();
    });
    return undefined;
  }
}

function normalizeRequest(request: DestinationBoundRequest, allowPrivate: boolean): DestinationBoundRequest {
  const destination = {
    protocol: request.destination.protocol,
    hostname: normalizeHostname(request.destination.hostname),
    port: normalizePort(request.destination.port),
  } as const;
  assertHostnameIsEligible(destination.hostname, allowPrivate);
  if (!request.path.startsWith('/') || /[\r\n]/u.test(request.path) || /^\/\//u.test(request.path)) {
    throw new Error('destination-bound request path must be origin-form');
  }
  const method = (request.method ?? 'GET').toUpperCase();
  if (!/^[A-Z][A-Z0-9-]{0,31}$/u.test(method)) throw new Error(`invalid outbound method: ${method}`);
  if (method === 'CONNECT') {
    throw new Error('destination-bound transport does not expose generic CONNECT');
  }
  return {
    destination,
    method,
    path: request.path,
    headers: normalizeHeaders(request.headers, destination),
  };
}

function normalizeHeaders(
  headers: http.OutgoingHttpHeaders | undefined,
  destination: OutboundDestination,
): http.OutgoingHttpHeaders {
  const result: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase();
    // This is the final destination-bound transport, not a general forwarding
    // proxy: its callers own message framing and strip the request-direction
    // hop-by-hop set themselves (`stripHopByHopRequestHeaders`, which keeps a
    // streamed body's framing headers). It deliberately strips only the
    // proxy-routing headers and rewrites `host` — stripping `transfer-encoding`
    // here would corrupt the chunked LLM request bodies streamed through it
    // (mitm-proxy `forwardRequest`).
    if (lower === 'host' || lower === 'proxy-authorization' || lower === 'proxy-connection') continue;
    const invalidValue =
      (typeof value === 'string' && /[\r\n]/u.test(value)) ||
      (Array.isArray(value) && value.some((entry) => /[\r\n]/u.test(entry)));
    // RFC 9110 §5.6.2 token characters, the backtick included.
    if (name === '' || /[^!#$%&'*+.^_`a-z0-9|~-]/iu.test(name) || invalidValue) {
      throw new Error(`invalid outbound header: ${name}`);
    }
    if (value !== undefined) result[lower] = value;
  }
  result.host = formatAuthority(destination.hostname, destination.port, destination.protocol);
  return result;
}

/**
 * The shared canonical spelling (lowercase, no trailing dot, IDNA ASCII), so
 * a destination is screened and connected under exactly the name the MITM
 * proxy's allowlists are keyed by. IPv6 literals are refused here as before:
 * the transports take IPv4 literals and names only.
 */
function normalizeHostname(value: string): string {
  const ascii = canonicalizeHostname(value);
  if (ascii === undefined) throw new Error(`invalid outbound hostname: ${value}`);
  return ascii;
}

function normalizePort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`invalid outbound port: ${port}`);
  return port;
}

function assertHostnameIsEligible(hostname: string, allowPrivate: boolean): void {
  // Metadata names are refused under every policy, including the trusted
  // provider override; other local names only under public-only.
  if (isMetadataHostname(hostname)) {
    throw new Error(`outbound destination is metadata-scoped: ${hostname}`);
  }
  if (!allowPrivate && isLocalOrMetadataHostname(hostname)) {
    throw new Error(`outbound destination is local or metadata-scoped: ${hostname}`);
  }
  if (net.isIP(hostname) !== 0 && !isAddressAllowed(hostname, allowPrivate)) {
    throw new Error(
      allowPrivate
        ? `outbound destination address is not allowed by its address policy: ${hostname}`
        : `outbound destination address is not public: ${hostname}`,
    );
  }
}

function formatAuthority(hostname: string, port: number, protocol: OutboundProtocol): string {
  const host = net.isIP(hostname) === 6 ? `[${hostname}]` : hostname;
  const standard = (protocol === 'https:' && port === 443) || (protocol === 'http:' && port === 80);
  return standard ? host : `${host}:${port}`;
}

function formatConnectAuthority(hostname: string, port: number): string {
  const host = net.isIP(hostname) === 6 ? `[${hostname}]` : hostname;
  return `${host}:${port}`;
}

function normalizeProxyEndpoint(endpoint: FixedParentProxyEndpoint): http.RequestOptions {
  if (endpoint.socketPath !== undefined) {
    if (!endpoint.socketPath.startsWith('/') || /[\r\n\0]/u.test(endpoint.socketPath)) {
      throw new Error('fixed parent proxy socketPath must be absolute');
    }
    return { socketPath: endpoint.socketPath };
  }
  const hostname = normalizeHostname(endpoint.hostname);
  const port = normalizePort(endpoint.port);
  return { hostname, port };
}

/** The already-normalized fixed parent endpoint as raw socket options. */
function parentConnectOptions(proxy: http.RequestOptions): net.NetConnectOpts {
  if (proxy.socketPath !== undefined) return { path: proxy.socketPath };
  return { host: proxy.hostname ?? undefined, port: Number(proxy.port) };
}
