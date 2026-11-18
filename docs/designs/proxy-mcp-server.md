# Proxy MCP Server Design

**Status (2026-11-14):** Implemented (`src/docker/proxy-tools.ts`): the virtual `proxy` server and its domain tools. The nested (fixed-parent) passthrough path in decision 2 is reserved: no production path selects the fixed-parent transport.

## Overview

The Proxy MCP Server gives the agent runtime control over which internet domains the MITM proxy allows through. Today, the MITM proxy's host allowlist is fixed at session start (derived from provider configs). This design adds a dynamic layer: the agent can request access to additional domains -- subject to human approval via the escalation flow -- and the MITM proxy will accept CONNECT requests to those domains at runtime.

The proxy tools run in a **dedicated `mcp-proxy-server.ts` instance** spawned with `SERVER_FILTER=proxy`. Unlike other proxy instances (which each connect to a real backend MCP server), the `proxy` instance runs in "virtual-only" mode: it has no backend connection and serves only the three proxy domain tools. The sandbox sees `proxy` as just another MCP server, so tool calls like `proxy.add_proxy_domain()` route naturally through the existing UTCP plumbing. This is a **Docker Agent Mode-only** feature -- Code Mode sessions use the policy engine's domain allowlists and the fetch server.

## Key Design Decisions

1. **One host on one port (`host:port`).** An approval covers exactly one host and one port: `api.example.com` means `api.example.com:443`, and plain HTTP must be requested explicitly as `api.example.com:80`. No other port can be approved, so an approval never opens SSH, SMTP or a database port on the same host. The tool-call pipeline qualifies the argument before policy evaluation (`qualifyPassthroughTarget`), so the human reviewing the escalation, the audit log and the approval whitelist all see the exact scope (`api.example.com:443`), and a whitelist entry for `:443` never admits a later `:80` request. The MITM proxy stores approvals as `host:port` keys (`passthroughHosts`), refuses a CONNECT, plain-HTTP or `ws://` request to any other port of an approved host, and `list_proxy_domains` reports approvals as `host:port`. (Earlier versions approved bare domains on every port.)

2. **Passthrough mode for dynamically added domains.** Approved targets are "passthrough": no fake-key-to-real-key swapping and no endpoint filtering; the agent's own credentials are forwarded unchanged. How the bytes travel depends on the port and the outbound transport:
   - **`host:443`, direct mode:** a raw TCP tunnel, relayed only after the proxy has read the client's TLS ClientHello (`src/docker/tls-client-hello.ts`) and found the SNI equal to the approved host. Bytes that are not TLS, a missing SNI and any other SNI close the tunnel before a byte reaches the upstream, so one approval cannot reach other tenants of a shared CDN edge by naming them in the SNI (domain fronting). The ClientHello read is bounded (64 KiB, 64 handshake records, 10 s). Residuals the pin cannot see: the Host header inside the encrypted session (a CDN that still routes on a Host/SNI mismatch), and Encrypted ClientHello. With ECH the SNI is only the outer name, so a client that deliberately uses ECH with the approved host as its outer name can reach another tenant of an ECH-enabled edge. ECH hellos are relayed, not refused, because the GREASE ECH that Chromium (preinstalled in the agent image) sends on every connection is indistinguishable from real ECH on the wire; the proxy logs every pinned tunnel whose ClientHello offers ECH. Only the first ClientHello of a tunnel is inspected.
   - **`host:80`, direct and nested mode:** the CONNECT tunnel is served by an in-process HTTP server rather than relayed raw. Every request is re-originated to the approved host through the destination-bound transport, which owns the Host header, so Host-header fronting is impossible; `ws://` upgrades are bridged the same way; bytes that are not HTTP get `400`. Absolute-form `GET http://host/...` proxy requests and `ws://` upgrades sent to the proxy directly take the same route.
   - **`host:443`, nested (fixed-parent) mode:** TLS is terminated and each request re-originated through the fixed parent transport; the TLS SNI must equal the approved host.

   Every tunnel is bounded per bundle like the rest of the proxy (`tls-terminating-api-proxy.md`, "Timeout Handling and Resource Bounds"): raw and SNI-pinned tunnels, port-80 tunnels and `ws://` bridges share one tunnel ceiling (64; a CONNECT or upgrade over it gets `503`); a raw tunnel or bridge closes after 10 minutes without a byte either way; a port-80 tunnel gets the request-head (60 s) and idle (15 min) deadlines of a decrypted connection, and each request in it counts against the bundle's request ceiling.

   Requests to statically configured provider domains always go through the provider path (with endpoint filtering and the provider credential gate, which refuses any credential other than the session sentinel; see "Provider credential gate" below); the passthrough path only applies to genuinely new domains.

3. **Provider and registry domains cannot be added as passthrough.** When `addHost()` is called with a domain that is already a static provider or a package registry (or one of its mirrors), it returns `false`. The tool response says the domain is already accessible. The provider path (key swap, endpoint filtering) and the registry path (package validation, audit) handle those domains; an approval cannot route around them.

4. **All domain additions require a human.** Adding a domain is a security-sensitive operation that expands the container's network perimeter: an approved `host:port` becomes a passthrough tunnel with no credential swap or endpoint filtering (decision 2). The policy engine always escalates `add_proxy_domain` calls, and the hardcoded rule is marked `humanOnly` (`CompiledRule.humanOnly`, carried as `EvaluationResult.humanOnly`): the LLM auto-approver is never consulted for it, no `/approve+` whitelist pattern is offered or matched, and the escalation request is flagged so `/approve all` in the mux and the escalation listener leaves it pending for an explicit `/approve N`. The domain argument is parsed as a passthrough target (`validateProxyToolArguments` -> `parsePassthroughTarget`: the host as `validateDomain` checks it, and a port of 443 or 80) during argument validation, before policy evaluation, so neither the policy engine nor a reviewer sees a target the MITM proxy would reject (`invalid-arguments`); the accepted value is then qualified with its port (decision 1).

5. **Communication via HTTP control API on a separate socket.** The `mcp-proxy-server.ts` child process communicates domain changes to the parent's MITM proxy via HTTP requests to a separate control socket. Node.js IPC (`process.send`/`process.on('message')`) is not feasible because `mcp-proxy-server.ts` is spawned by UTCP's `CodeModeUtcpClient.registerManual()`, which uses `StdioClientTransport` internally -- we do not control the `spawn()` call and cannot add an IPC channel. The control socket is NOT mounted into the container, preventing direct access by the agent. Every control request must also carry a per-bundle bearer token (`Authorization: Bearer <token>`) that the MITM proxy mints at startup (`MitmProxyAddress.controlToken`). The token reaches only the in-process control client and the virtual proxy-tool relay (`config.mitmControlToken`, `MITM_CONTROL_TOKEN`), never the container; without it the API answers `401`. In TCP mode the control port is a loopback listener that any local process, and through Docker Desktop's host gateway any container, could otherwise reach.

6. **Dedicated proxy process via `SERVER_FILTER=proxy`.** The sandbox registers `proxy` as a virtual MCP server entry that spawns `mcp-proxy-server.ts` with `SERVER_FILTER=proxy`. When this filter is set and there is no matching entry in the MCP servers config, the proxy enters "virtual-only" mode: no backend MCP client, only the three proxy tools. This follows the existing one-process-per-server pattern and avoids injecting virtual tools into every proxy instance.

7. **The `proxy` server name is reserved.** User-configured MCP servers cannot use the name `proxy`. This prevents collisions with the virtual proxy tools. (`network`, the policy namespace of MITM egress decisions, is reserved for the same reason; see decision 10.)

8. **Wildcard subdomains are not supported in dynamic additions.** Dynamically added domains must be exact hostnames. This prevents an agent from requesting `*.com` and bypassing the allowlist.

9. **Block `*.docker.internal` and every other local or metadata name.** Domain validation rejects any domain ending in `.docker.internal`, not just the exact hostname `host.docker.internal`, and every other local or metadata-scoped name (`*.localhost`, `*.local`, `*.internal`, `*.localdomain`, `*.home.arpa`, `metadata.google.internal`, ...) via `isLocalOrMetadataHostname`. This prevents the agent from reaching Docker's internal DNS names or host-local services through an approval, before a human is ever asked.

10. **Policy-evaluated egress (opt-in) decides unknown destinations; approvals settle its escalations.** With `egressPolicy.enabled` in `~/.ironcurtain/config.json`, every destination that is neither a provider nor a registry is decided by the session's policy engine as a call to the virtual `network/request` tool: a CONNECT at host:port, every request the proxy can read at path granularity (see [`mitm-egress-policy.md`](mitm-egress-policy.md)). An approval (from `add_proxy_domain`, or a human approving an egress escalation, which lands in the same `passthroughHosts` set) then admits nothing on its own: it settles a later escalation for the same `host:port` without asking again (escalate-once), never a policy deny. `list_proxy_domains` and `remove_proxy_domain` see and revoke egress approvals like any other. The deprecated `IRONCURTAIN_MITM_ALLOW_ALL_HOSTS` escape hatch is ignored while the opt-in is on; without it the variable still works and every proxy start warns that it is deprecated.

## Tool Interface Definitions

### `add_proxy_domain`

```typescript
{
  name: 'add_proxy_domain',
  description:
    'Request access to an additional internet domain through the network proxy. ' +
    'This will be reviewed by a human before being granted. ' +
    'Access is granted to one host on one port: HTTPS (443) unless the domain names port 80 explicitly. ' +
    'Provide a clear justification for why the domain is needed.',
  inputSchema: {
    type: 'object',
    properties: {
      domain: {
        type: 'string',
        description:
          'The exact domain name to allow (e.g., "api.example.com"), optionally with a port ' +
          '("api.example.com:80"). Only ports 443 (the default) and 80 can be requested. No wildcards.',
      },
      justification: {
        type: 'string',
        description:
          'Explanation of why this domain is needed for the current task. ' +
          'This text is shown to the human reviewer.',
      },
    },
    required: ['domain', 'justification'],
  },
}
```

**Policy:** Always escalate, human-only. The auto-approver is never consulted, the escalation cannot be whitelisted, and bulk approval skips it; only an explicit human approval of this escalation adds the domain. An invalid domain (IP literal, wildcard, `localhost`, `*.docker.internal`, malformed text) is denied as `invalid-arguments` before policy evaluation.

### `remove_proxy_domain`

```typescript
{
  name: 'remove_proxy_domain',
  description:
    'Remove a previously approved domain from the proxy allowlist. ' +
    'Only dynamically added domains can be removed; built-in provider domains cannot. ' +
    'Live tunnels to the removed host and port are closed.',
  inputSchema: {
    type: 'object',
    properties: {
      domain: {
        type: 'string',
        description: 'The domain name to remove, with the same optional port it was approved with (default 443).',
      },
    },
    required: ['domain'],
  },
}
```

**Policy:** Allow. Removing access can only reduce the attack surface.

### `list_proxy_domains`

```typescript
{
  name: 'list_proxy_domains',
  description:
    'List all domains currently accessible through the network proxy. ' +
    'Includes both built-in provider domains and dynamically added domains.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
}
```

**Policy:** Allow. Read-only, no side effects.

## Component Architecture

```
                                                   Host Process
  +------------------------------------------------------------------------------+
  |                                                                              |
  |  +-------------------+                                                       |
  |  |  CodeModeProxy    |                                                       |
  |  |  (execute_code)   |                                                       |
  |  +--------+----------+                                                       |
  |           |                                                                  |
  |           |  Sandbox.executeCode()                                           |
  |           v                                                                  |
  |  +--------------------+ proxy.add_proxy_domain({domain, justification})      |
  |  |  V8 Sandbox (UTCP) |                                                     |
  |  +--------+-----------+                                                     |
  |           |                                                                  |
  |           | MCP call (stdio) -- routed by UTCP to the `proxy` server entry   |
  |           v                                                                  |
  |  +---------------------------------------+                                   |
  |  |  mcp-proxy-server.ts                  | (child process, SERVER_FILTER=proxy)
  |  |  *** VIRTUAL-ONLY MODE ***            | No backend MCP client connection  |
  |  |  +-- PolicyEngine.evaluate()          | -> escalate -> human approves     |
  |  |  +-- Virtual tool handler             |                                   |
  |  |  |   +-- HTTP POST to control socket -+------+                            |
  |  |  +-- AuditLog.append()               |      |                            |
  |  +---------------------------------------+      |                            |
  |                                                 |                            |
  |  +---------------------------------------+      |                            |
  |  |  mcp-proxy-server.ts                  |      |  (separate proxy instances |
  |  |  (SERVER_FILTER=filesystem)           |      |   for real backend servers |
  |  |  +-- PolicyEngine + backend client    |      |   have NO virtual tools    |
  |  +---------------------------------------+      |   and NO MITM_CONTROL_ADDR)|
  |                                                 |                            |
  |                                                 v                            |
  |                              +----------------------+                        |
  |                              | Control API Server    | (separate UDS/TCP)    |
  |                              | /__ironcurtain/       | NOT mounted in        |
  |                              |    domains/*          | container             |
  |                              +----------+-----------+                        |
  |                                         |                                    |
  |                                         v                                    |
  |                              +----------------------+                        |
  |                              |     MITM Proxy        |                       |
  |                              |  providersByHost      | (static, key swap)    |
  |                              |  passthroughHosts <---+ (dynamic, passthru)   |
  |                              +----------------------+                        |
  |                                                                              |
  +------------------------------------------------------------------------------+
              ^
              | execute_code (MCP over UDS/TCP)
  +-----------+-------------+
  |  Docker Container       |
  |  (--network=none or     |
  |   --internal bridge)    |
  |                         |
  |  Agent -> HTTPS_PROXY   |---- CONNECT api.example.com:443 ---->
  |                         |
  +-------------------------+
```

**Key difference from other proxy instances:** The `proxy` server entry spawns `mcp-proxy-server.ts` with `SERVER_FILTER=proxy` and `MITM_CONTROL_ADDR` in its env. Since `proxy` is not in `allServersConfig` (the MCP servers config), the process enters virtual-only mode. Other proxy instances (e.g., `SERVER_FILTER=filesystem`) do NOT receive `MITM_CONTROL_ADDR` and have no virtual tools.

## Sandbox Integration

### Registration in `src/sandbox/index.ts`

After the existing loop (lines 371-385) that creates one `mcpServers` entry per backend server, add a `proxy` entry:

```typescript
// Register one proxy per backend server so UTCP names them cleanly:
//   tools.<serverName>_<toolName>(...)
// Each proxy gets a SERVER_FILTER env var to connect only to its server.
const mcpServers: Record<string, { ... }> = {};
for (const serverName of Object.keys(config.mcpServers)) {
  // ... existing per-server loop (lines 371-385) ...
  mcpServers[serverName] = {
    transport: 'stdio',
    command: PROXY_COMMAND,
    args: [...PROXY_ARGS],
    env: {
      ...proxyEnv,
      SERVER_FILTER: serverName,
      ...(serverCreds ? { SERVER_CREDENTIALS: JSON.stringify(serverCreds) } : {}),
    },
    timeout: timeoutSeconds,
  };
}

// Add a dedicated proxy instance for virtual proxy tools (domain management).
// This entry spawns mcp-proxy-server.ts with SERVER_FILTER=proxy and no
// matching backend server, so it enters virtual-only mode.
// MITM_CONTROL_ADDR is ONLY passed to this entry, not to other server instances.
if (config.mitmControlAddr) {
  mcpServers['proxy'] = {
    transport: 'stdio',
    command: PROXY_COMMAND,
    args: [...PROXY_ARGS],
    env: {
      ...proxyEnv,
      SERVER_FILTER: 'proxy',
      MITM_CONTROL_ADDR: config.mitmControlAddr,
    },
    timeout: timeoutSeconds,
  };
}
```

UTCP sees `proxy` as just another server. Tool routing follows the existing pattern:
- `tools.proxy.add_proxy_domain({...})` in user code
- UTCP routes to the `proxy` stdio process
- The proxy process handles it locally (no backend forwarding)

### Virtual-Only Mode in `mcp-proxy-server.ts`

When `SERVER_FILTER=proxy` and there is no matching entry in `allServersConfig`, instead of exiting with an error (current line 496-498), the proxy enters virtual-only mode:

```typescript
const serverFilter = process.env.SERVER_FILTER;
const mitmControlAddr = process.env.MITM_CONTROL_ADDR;
const isVirtualOnly = serverFilter === 'proxy' && !allServersConfig[serverFilter];

if (serverFilter && !allServersConfig[serverFilter] && !isVirtualOnly) {
  process.stderr.write(`SERVER_FILTER: unknown server "${serverFilter}"\n`);
  process.exit(1);
}

// In virtual-only mode:
// - No backend MCP client connections (clientStates map is empty)
// - Only proxy tools are listed in ListToolsRequestSchema
// - CallToolRequestSchema routes to local virtual tool handlers
// - PolicyEngine still evaluates all calls (for escalation on add_proxy_domain)
```

### Virtual Tool Handling in `handleCallTool`

The `handleCallTool` function currently forwards all allowed calls to a backend MCP server via `clientStates.get(toolInfo.serverName)`. For virtual tools, the call must be handled locally before reaching the forwarding path.

After policy evaluation succeeds (the call is allowed/escalated-and-approved), check if the tool is a virtual proxy tool:

```typescript
// After policy evaluation, before forwarding to backend:
if (toolInfo.serverName === 'proxy') {
  // Virtual tool -- handle locally, no backend forwarding.
  // Write-ahead audit record first: an unwritable audit log throws here
  // and the tool never runs (the same contract as a backend dispatch).
  logAudit({ status: 'dispatching' }, 0);
  const result = await handleVirtualProxyTool(toolInfo.name, argsForTransport, controlApiClient);
  logAudit({ status: 'success' }, Date.now() - startTime);
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}

// Existing forwarding path:
const clientState = deps.clientStates.get(toolInfo.serverName);
if (!clientState) {
  // ... error: no client connection ...
}
```

The `handleVirtualProxyTool` function dispatches by tool name:

```typescript
async function handleVirtualProxyTool(
  toolName: string,
  args: Record<string, unknown>,
  client: ControlApiClient,
): Promise<unknown> {
  switch (toolName) {
    case 'add_proxy_domain': {
      const domain = args.domain as string;
      const result = await client.addDomain(domain);
      if (!result.added) {
        return { status: 'already_accessible', message: 'Domain is already accessible (built-in provider)' };
      }
      return { status: 'added', domain };
    }
    case 'remove_proxy_domain': {
      const domain = args.domain as string;
      const result = await client.removeDomain(domain);
      return { status: result.removed ? 'removed' : 'not_found', domain };
    }
    case 'list_proxy_domains':
      return client.listDomains();
    default:
      throw new Error(`Unknown virtual proxy tool: ${toolName}`);
  }
}
```

### Annotation and Rule Injection

The proxy annotations and policy rules are merged into the PolicyEngine at startup, regardless of whether the proxy is in virtual-only mode or not (other proxy instances also need the annotations for the `proxy` server so that `getAnnotation()` can resolve them during structural checks if a tool call somehow arrives at the wrong instance):

```typescript
// In mcp-proxy-server.ts startup, after loading generated artifacts:
// Merge proxy annotations into tool annotations under the 'proxy' server key
toolAnnotations.servers.proxy = {
  tools: proxyAnnotations,
};

// Prepend proxy policy rules to compiled policy
compiledPolicy.rules = [...proxyPolicyRules, ...compiledPolicy.rules];

// Construct PolicyEngine with merged artifacts
const policyEngine = new PolicyEngine(compiledPolicy, toolAnnotations, ...);
```

## Interface Definitions

### `DynamicHostController` (new, in `src/docker/mitm-proxy.ts`)

```typescript
/**
 * Runtime control surface for the MITM proxy's host allowlist.
 *
 * Dynamically added hosts are passthrough-only: TLS is terminated
 * for auditability, but no credential replacement or endpoint
 * filtering is performed. The agent's own headers are forwarded
 * as-is to the upstream server.
 *
 * Provider domains that are already statically configured cannot be
 * added as passthrough. addHost() returns false for these domains,
 * and the tool handler surfaces a clear message to the agent.
 */
export interface DynamicHostController {
  /**
   * Add a domain to the passthrough allowlist.
   * Validates the domain format (no wildcards, no IP addresses,
   * no *.docker.internal, max 253 chars).
   *
   * @throws Error if the domain fails validation.
   * @returns true if the domain was newly added, false if already present
   *          (either as a static provider or a previous dynamic addition).
   */
  addHost(domain: string): boolean;

  /**
   * Remove a domain from the passthrough allowlist.
   * Cannot remove statically configured providers.
   *
   * @returns true if the domain was removed, false if not found or static.
   */
  removeHost(domain: string): boolean;

  /**
   * List all currently allowed hosts, grouped by type.
   */
  listHosts(): DomainListing;
}

export interface DomainListing {
  /** Statically configured LLM provider hosts (with key swap). */
  readonly providers: readonly string[];
  /** Dynamically added passthrough hosts (no key swap). */
  readonly dynamic: readonly string[];
}
```

### `MitmProxy` (extended return type)

```typescript
export interface MitmProxy {
  start(): Promise<{ socketPath?: string; port?: number }>;
  stop(): Promise<void>;
  /** Runtime control for the dynamic host allowlist. */
  readonly hosts: DynamicHostController;
}
```

### `MitmProxyOptions` (extended)

```typescript
export interface MitmProxyOptions {
  // ... existing fields ...
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
}
```

### `IronCurtainConfig` (extended)

```typescript
// In src/config/types.ts or wherever IronCurtainConfig is defined:
export interface IronCurtainConfig {
  // ... existing fields ...
  /**
   * Address of the MITM control API for dynamic domain management.
   * Format: "unix:///path/to/socket" or "http://127.0.0.1:PORT".
   * Only set in Docker Agent Mode sessions.
   */
  readonly mitmControlAddr?: string;
}
```

## MITM Proxy Changes

### Provider credential gate (supersedes the `validateAndSwapApiKey` modification below)

The passthrough change recorded below let a non-sentinel key on a **provider** route reach the provider. That let a compromised agent send workspace contents to an allowlisted completion endpoint authenticated as an account it chose, whose owner could read stored requests back (for example OpenAI Responses `store`). It was reverted: `validateAndSwapApiKey` is replaced by `applyProviderCredential` in `src/docker/provider-credentials.ts`. On every provider-route request it:

- strips every credential carrier: `authorization`, `x-api-key`, `x-goog-api-key`, `api-key`, `anthropic-api-key` and the provider's own key header, cookies, and the `key`, `api_key`, `api-key`, `apikey`, `access_token` and `oauth_token` query parameters (the carrier lists live in `src/docker/credential-carriers.ts`);
- accepts the session sentinel in any of them and injects the real key in the provider's configured location only (nothing at all when the real key is empty, as for a keyless gateway);
- answers any other credential with a local 401 (JSON body readable by the Anthropic and OpenAI SDKs) and sends nothing upstream;
- forwards a request that presents no credential, without one, only to an endpoint in the provider's `unauthenticatedEndpoints` (for Claude Code: `/api/hello`, the MCP registry, telemetry batches and GrowthBook evaluation; for Claude Platform: `/v1/oauth/hello`; for ChatGPT: the agent-identity key sets). Anywhere else it is a local 401.

The 401 retry is enabled only for a sentinel request, and a refreshed OAuth token is injected only into one. Dynamically added passthrough domains are unaffected: they still carry the agent's own headers.

The original modification, kept for history:

The current `validateAndSwapApiKey` returns `{ valid: false }` when a key is present but doesn't match the sentinel. This must change to allow non-sentinel keys (the agent's own credentials) to pass through:

```typescript
/** Result of fake key validation. */
type KeyValidationResult =
  | { valid: true; hadKey: true; swapped: true }   // fake key matched -> swapped to real key
  | { valid: true; hadKey: true; swapped: false }   // key present but not sentinel -> pass through
  | { valid: true; hadKey: false; swapped: false }   // no key sent (unauthenticated endpoint)
  ;
// The { valid: false } case is removed entirely.
// Any key present in the request is either the sentinel (swap it) or the
// agent's own credential (pass it through unchanged).
```

Updated implementation:

```typescript
function validateAndSwapApiKey(
  headers: Record<string, string | string[] | undefined>,
  provider: ProviderKeyMapping,
): KeyValidationResult {
  const { keyInjection } = provider.config;

  switch (keyInjection.type) {
    case 'header': {
      const headerName = keyInjection.headerName.toLowerCase();
      const currentValue = headers[headerName];
      if (currentValue === undefined) return { valid: true, hadKey: false, swapped: false };
      if (currentValue === provider.fakeKey) {
        headers[headerName] = provider.realKey;
        return { valid: true, hadKey: true, swapped: true };
      }
      // Non-sentinel key present -- agent's own credential, pass through
      return { valid: true, hadKey: true, swapped: false };
    }
    case 'bearer': {
      const authHeader = headers['authorization'];
      if (authHeader === undefined) return { valid: true, hadKey: false, swapped: false };
      if (authHeader === `Bearer ${provider.fakeKey}`) {
        headers['authorization'] = `Bearer ${provider.realKey}`;
        return { valid: true, hadKey: true, swapped: true };
      }
      // Non-sentinel bearer token -- agent's own credential, pass through
      return { valid: true, hadKey: true, swapped: false };
    }
  }
}
```

The call site in the inner server's request handler no longer needs the `if (!keyResult.valid)` rejection branch. That branch is removed entirely. The `canRetryAuth` logic changes to only retry when the sentinel was actually swapped:

```typescript
// 401 retry only makes sense when we swapped our own managed credential
const canRetryAuth = keyResult.swapped && !!provider.tokenManager;
```

The same `swapped` test gates the proactive OAuth refresh: when `getValidAccessToken()` returns a rotated token, only a request that presented the sentinel gets the new real token injected. Gating that on `hadKey` (any key at all) used to hand the user's freshly refreshed token to the first request after a rotation, even one carrying a junk key.

**Endpoint filtering for provider domains:** `isEndpointAllowed()` continues to apply for all requests routed through the provider path. Requests to provider domains always take the provider path (whether the key is sentinel or the agent's own). The passthrough path (no endpoint filtering) is only for genuinely new domains that are not in `providersByHost`.

### CONNECT Handler Change

```typescript
// Existing:
const provider = providersByHost.get(host);
if (!provider) { /* DENIED */ }

// New:
const provider = providersByHost.get(host);
const isPassthrough = passthroughHosts.has(host);
if (!provider && !isPassthrough) {
  logger.info(`[mitm-proxy] #${connId} DENIED CONNECT ${host}:${port}`);
  clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
  clientSocket.destroy();
  return;
}

const connType = provider ? 'provider' : 'passthrough';
```

### ConnectionMeta Extension

```typescript
interface ConnectionMeta {
  readonly provider?: ProviderKeyMapping;
  readonly passthrough: boolean;  // new field
  readonly host: string;
  readonly port: number;
}
```

### Passthrough Request Forwarding

For passthrough connections (no static provider), the inner HTTP server routes to a new `forwardPassthrough` function:

```typescript
// In innerServer 'request' handler, after provider checks:
if (!meta.provider) {
  // Passthrough: forward request as-is, no key swap, no endpoint filter
  forwardPassthrough(clientReq, clientRes, meta.host, meta.port);
  return;
}
```

```typescript
function forwardPassthrough(
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
  host: string,
  port: number,
): void {
  const { method, url: path, headers } = clientReq;

  logger.info(`[mitm-proxy] ${method} ${host}${path} -> PASSTHROUGH`);

  const forwardHeaders = { ...headers, host };

  const upstreamReq = https.request(
    { hostname: host, port, method, path, headers: forwardHeaders },
    (upstreamRes) => {
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
    },
  );

  activeUpstreamRequests.add(upstreamReq);
  upstreamReq.on('close', () => activeUpstreamRequests.delete(upstreamReq));

  upstreamReq.on('error', (err) => {
    const log = isConnectionReset(err) ? logger.debug : logger.info;
    log(`[mitm-proxy] upstream error (passthrough): ${err.message}`);
    activeUpstreamRequests.delete(upstreamReq);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
      clientRes.end(`Upstream error: ${err.message}`);
    } else {
      clientRes.socket?.destroy();
    }
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
```

### DynamicHostController Implementation

```typescript
// Domain validation: must look like a hostname, no wildcards, no paths, no IPs
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
const IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const DOCKER_INTERNAL_SUFFIX = '.docker.internal';

function validateDomain(domain: string): void {
  if (domain.length > 253) throw new Error(`Domain too long (${domain.length} > 253)`);
  if (!DOMAIN_RE.test(domain)) throw new Error(`Invalid domain format: "${domain}"`);
  if (IP_RE.test(domain)) throw new Error(`IP addresses are not allowed: "${domain}"`);
  if (domain.toLowerCase() === 'localhost') {
    throw new Error(`Blocked host: "${domain}"`);
  }
  if (domain.toLowerCase().endsWith(DOCKER_INTERNAL_SUFFIX)) {
    throw new Error(`Blocked host: "${domain}" (*.docker.internal is not allowed)`);
  }
}

// Inside createMitmProxy():
const passthroughHosts = new Set<string>();

const controller: DynamicHostController = {
  addHost(domain: string): boolean {
    validateDomain(domain);
    if (providersByHost.has(domain)) return false;
    if (passthroughHosts.has(domain)) return false;
    passthroughHosts.add(domain);
    // No leaf is minted here: a direct proxy tunnels passthrough hosts raw,
    // and a nested one mints on the first CONNECT to the host.
    return true;
  },

  removeHost(domain: string): boolean {
    return passthroughHosts.delete(domain);
  },

  listHosts(): DomainListing {
    return {
      providers: [...providersByHost.keys()],
      dynamic: [...passthroughHosts],
    };
  },
};
```

## HTTP Control API

The control API runs on a **separate** HTTP server, listening on a socket that is NOT mounted into the Docker container.

```typescript
// In createMitmProxy():
const controlServer = http.createServer((req, res) => {
  const url = req.url ?? '';

  if (url === '/__ironcurtain/domains' && req.method === 'GET') {
    const listing = controller.listHosts();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(listing));
    return;
  }

  if (url === '/__ironcurtain/domains/add' && req.method === 'POST') {
    bufferRequestBody(req, 4096)
      .then((body) => {
        const { domain } = JSON.parse(body.toString()) as { domain: string };
        if (typeof domain !== 'string' || !domain) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing required field: domain' }));
          return;
        }
        try {
          const added = controller.addHost(domain);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ added }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      })
      .catch((err) => {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end(err instanceof Error ? err.message : String(err));
      });
    return;
  }

  if (url === '/__ironcurtain/domains/remove' && req.method === 'POST') {
    bufferRequestBody(req, 4096)
      .then((body) => {
        const { domain } = JSON.parse(body.toString()) as { domain: string };
        if (typeof domain !== 'string' || !domain) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing required field: domain' }));
          return;
        }
        const removed = controller.removeHost(domain);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ removed }));
      })
      .catch((err) => {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end(err instanceof Error ? err.message : String(err));
      });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});
```

The control server starts/stops alongside the MITM proxy. Its address is passed to the `proxy` server entry (only) via the `MITM_CONTROL_ADDR` env var, together with the per-bundle bearer token in `MITM_CONTROL_TOKEN`:
- UDS mode: `unix:///path/to/mitm-control.sock`
- TCP mode: `http://127.0.0.1:PORT`

The sketch above predates two additions in `createMitmProxy()`: every request is first checked for `Authorization: Bearer <token>` (constant-time comparison; `401` otherwise), and the add/remove bodies carry an optional integer `port` (default 443; `addHost` refuses anything but 443 and 80). Revoking an approval also destroys every live tunnel, WebSocket bridge, port-80 HTTP tunnel and TLS-terminated (nested) passthrough connection opened under it; a nested keep-alive connection also re-checks its approval on every request.

**Security:** The control socket path is in `sessionDir` (not `sessionDir/sockets/`). Only the `sockets/` subdirectory is mounted into the container, so the control API is inaccessible from inside the container. In TCP mode, the socat sidecar only forwards specific ports (MCP proxy and MITM proxy), not the control port, and the control port binds `127.0.0.1`. Because a loopback port is still reachable by every local process (and, through Docker Desktop's host gateway, by other containers), the bearer token is what actually authorizes a change.

## Policy Rules

The proxy tools need hardcoded annotations and compiled rules (not generated by the LLM pipeline, since the tools have known, fixed semantics). This follows the pattern used for internal servers like the memory server, except the proxy tools need policy evaluation (not trusted-server bypass).

### Tool Annotations (hardcoded in `src/docker/proxy-tools.ts`)

```typescript
const proxyAnnotations: Record<string, ToolAnnotation> = {
  add_proxy_domain: {
    sideEffects: true,
    description: 'Add a domain to the MITM proxy allowlist',
    args: {
      domain: { roles: ['opaque'] },
      justification: { roles: ['opaque'] },
    },
  },
  remove_proxy_domain: {
    sideEffects: true,
    description: 'Remove a domain from the MITM proxy allowlist',
    args: {
      domain: { roles: ['opaque'] },
    },
  },
  list_proxy_domains: {
    sideEffects: false,
    description: 'List currently allowed proxy domains',
    args: {},
  },
};
```

### Compiled Policy Rules (hardcoded)

Using the actual `CompiledRule` schema from `src/pipeline/types.ts`:

```typescript
import type { CompiledRule } from '../pipeline/types.js';

const proxyPolicyRules: CompiledRule[] = [
  {
    name: 'proxy-add-domain-escalate',
    description: 'Adding network domains requires human review',
    principle: 'Human oversight',
    if: { server: ['proxy'], tool: ['add_proxy_domain'] },
    then: 'escalate',
    reason: 'Adding network domains expands the container attack surface and requires human review',
  },
  {
    name: 'proxy-remove-domain-allow',
    description: 'Removing domains reduces attack surface',
    principle: 'Least privilege',
    if: { server: ['proxy'], tool: ['remove_proxy_domain'] },
    then: 'allow',
    reason: 'Removing domains reduces the attack surface',
  },
  {
    name: 'proxy-list-domains-allow',
    description: 'Listing domains is a read-only operation',
    principle: 'Least privilege',
    if: { server: ['proxy'], tool: ['list_proxy_domains'] },
    then: 'allow',
    reason: 'Read-only operation with no side effects',
  },
];
```

These are prepended to the compiled policy rules at startup in `mcp-proxy-server.ts`, and the annotations are merged into the tool annotations map for the `proxy` server.

## Reserving the `proxy` Server Name

The `proxy` server name must be reserved to prevent collisions with user-configured MCP servers. Add validation in `loadConfig()` or at the MCP server registration point:

```typescript
const RESERVED_SERVER_NAMES = new Set(['proxy']);

// In config loading or sandbox initialization:
for (const name of Object.keys(config.mcpServers)) {
  if (RESERVED_SERVER_NAMES.has(name)) {
    throw new Error(
      `MCP server name "${name}" is reserved for internal use. ` +
      `Please choose a different name in mcp-servers.json.`
    );
  }
}
```

## Orientation / Help System

The proxy tools must appear in the help system so the agent knows they exist. In `docker-infrastructure.ts`, after building the `helpData` from the sandbox, add the proxy server:

```typescript
// After extracting helpData from proxy.getHelpData():
const serverListings = Object.entries(helpData.serverDescriptions).map(([name, description]) => ({
  name,
  description,
}));

// Add the proxy server listing
serverListings.push({
  name: 'proxy',
  description: 'Network proxy domain management (add/remove/list allowed domains)',
});
```

The sandbox's tool catalog will already include the proxy tools (since they are listed by `mcp-proxy-server.ts` in the `ListToolsRequestSchema` response), so the help data is automatically populated when the sandbox discovers tools.

## Client Module for Control API

```typescript
// In src/docker/proxy-tools.ts:

import * as http from 'node:http';

interface ControlApiClient {
  addDomain(domain: string): Promise<{ added: boolean }>;
  removeDomain(domain: string): Promise<{ removed: boolean }>;
  listDomains(): Promise<DomainListing>;
}

function createControlApiClient(controlAddr: string): ControlApiClient {
  const isUnix = controlAddr.startsWith('unix://');
  const socketPath = isUnix ? controlAddr.slice('unix://'.length) : undefined;
  const baseUrl = isUnix ? 'http://localhost' : controlAddr;

  function request(method: string, path: string, body?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const url = new URL(path, baseUrl);
      const opts: http.RequestOptions = {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: { 'Content-Type': 'application/json' },
        ...(socketPath ? { socketPath } : {}),
      };

      const req = http.request(opts, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`Control API ${res.statusCode}: ${text}`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch {
            resolve(text);
          }
        });
        res.on('error', reject);
      });

      req.on('error', reject);
      if (body !== undefined) {
        req.end(JSON.stringify(body));
      } else {
        req.end();
      }
    });
  }

  return {
    async addDomain(domain: string): Promise<{ added: boolean }> {
      return (await request('POST', '/__ironcurtain/domains/add', { domain })) as { added: boolean };
    },
    async removeDomain(domain: string): Promise<{ removed: boolean }> {
      return (await request('POST', '/__ironcurtain/domains/remove', { domain })) as { removed: boolean };
    },
    async listDomains(): Promise<DomainListing> {
      return (await request('GET', '/__ironcurtain/domains')) as DomainListing;
    },
  };
}
```

## Integration: `docker-infrastructure.ts` Changes

```typescript
// In prepareDockerInfrastructure():

// After creating mitmProxy:
const mitmProxy = useTcp
  ? createMitmProxy({
      listenPort: 0,
      ca,
      providers: providerMappings,
      controlPort: 0,  // OS-assigned
    })
  : createMitmProxy({
      socketPath: resolve(socketsDir, 'mitm-proxy.sock'),
      ca,
      providers: providerMappings,
      controlSocketPath: resolve(sessionDir, 'mitm-control.sock'),  // NOT in sockets/
    });

const mitmAddr = await mitmProxy.start();
// mitmAddr now also has controlPort or controlSocketPath

// Pass control address to the IronCurtainConfig so Sandbox.initialize()
// can include it in the `proxy` server entry's env vars.
const controlAddr = mitmAddr.controlPort !== undefined
  ? `http://127.0.0.1:${mitmAddr.controlPort}`
  : `unix://${mitmAddr.controlSocketPath}`;

// Set on config -- only the proxy server entry receives this
config.mitmControlAddr = controlAddr;
```

The `MitmProxy.start()` return type is extended:

```typescript
start(): Promise<{
  socketPath?: string;
  port?: number;
  controlSocketPath?: string;
  controlPort?: number;
}>;
```

## File Layout

```
src/sandbox/
  index.ts                   # Modified: add 'proxy' entry to mcpServers dict
                              #   when config.mitmControlAddr is set

src/docker/
  mitm-proxy.ts              # Modified: add DynamicHostController, passthrough handling,
                              #   control API server, validateAndSwapApiKey changes,
                              #   *.docker.internal blocking in validateDomain()
  docker-infrastructure.ts   # Modified: create control socket, set mitmControlAddr on config,
                              #   add proxy to server listings
  docker-agent-session.ts    # Modified: manage control server lifecycle

src/docker/proxy-tools.ts    # New: tool definitions, annotations, policy rules,
                              #   control API client, handleVirtualProxyTool()

src/trusted-process/
  mcp-proxy-server.ts        # Modified: virtual-only mode when SERVER_FILTER=proxy
                              #   with no backend; import proxy tools/annotations/rules;
                              #   intercept proxy__ calls before backend forwarding

src/config/
  types.ts                   # Modified: add mitmControlAddr to IronCurtainConfig,
                              #   add RESERVED_SERVER_NAMES validation
```

## Edge Cases and Security Considerations

### 1. Domain validation (in `addHost()`)
- Reject wildcards (`*`), IP addresses, localhost, all `*.docker.internal` hostnames and every other local or metadata-scoped name
- Reject every port except 443 (the default) and 80
- Maximum domain length: 253 characters (DNS limit)
- Reject empty labels, leading/trailing hyphens
- Validation happens in `addHost()` itself, not just in the MCP tool handler

### 2. Provider and registry domains are not passthrough
- Provider and package-registry domains (mirrors included) CANNOT be added via `add_proxy_domain` as passthrough. If the domain is already a static provider or registry, `addHost()` returns false and the tool response says the domain is already accessible. An approved registry host would otherwise route its plain-HTTP traffic around package validation.
- The existing provider path (with key swap and endpoint filtering) handles those domains exclusively.
- The provider credential gate (`applyProviderCredential` in `src/docker/provider-credentials.ts`, which replaced `validateAndSwapApiKey`) swaps the sentinel for the real key and answers any other credential with a local 401; a request without a credential is forwarded, without one, only to the provider's `unauthenticatedEndpoints` (see "Provider credential gate" above). Endpoint filtering always applies on the provider path.

### 3. Race conditions
- The control API is synchronous (add/remove from a Set). No race conditions.
- If two `add_proxy_domain` calls race through escalation for the same domain, the second becomes a no-op.

### 4. Persistence
- Dynamic domains are **session-scoped**. They do not persist across sessions.
- Within a session, domains persist across turns (the MITM proxy runs for the session's lifetime).

### 5. Audit logging
- All domain changes flow through `mcp-proxy-server.ts`'s standard policy engine and audit log.
- The justification text from `add_proxy_domain` is captured in the audit entry's tool arguments.
- Like a backend dispatch, a virtual tool call is preceded by a write-ahead audit record (`result.status: 'dispatching'`) and followed by its outcome record; if the audit log cannot be written, the tool is not run and the coordinator stops admitting tool calls (see `AuditLog` in `src/trusted-process/audit-log.ts`).

### 6. Auto-approver interaction
- The auto-approver never approves domain additions, even when the user's message names the domain (e.g., "deploy to api.example.com"). Opening an uninspected tunnel is the one decision that is never delegated: the hardcoded rule is `humanOnly`, the pipeline skips the auto-approver and the whitelist for it, and the escalation request carries `humanOnly: true` so bulk approval leaves it for an explicit `/approve N`.

### 7. SSRF via passthrough
- IP addresses are rejected at the domain validation layer in every spelling the resolver or the URL parser reads as an address (`127.1`, `0x7f.1`, `8.8.2056`, not only the dotted quad), so a human is never asked to approve an address dressed up as a domain.
- All `*.docker.internal` hostnames, and every other local or metadata name, are blocked, preventing access to Docker's internal networking.
- The CONNECT authority is parsed strictly before anything is acknowledged (`src/docker/proxy-authority.ts`): a canonical host (lowercase, no trailing dot, IDNA ASCII; delimiters, percent escapes and whitespace refused rather than folded), a decimal port 1-65535, IPv6 only in brackets. Anything else gets `400` and the socket is dropped. The former `lastIndexOf(':')` + `parseInt` split let `host:99999` throw `ERR_SOCKET_BAD_PORT` out of the server's `connect` listener and end the whole process.
- The same canonical spelling keys the provider, registry and passthrough lookups on the CONNECT, plain-HTTP and upgrade paths, so `api.anthropic.com.` (trailing dot) takes the provider path instead of an "unknown host" tunnel.
- A raw tunnel resolves names through the guarded resolver, which refuses private, loopback, link-local and metadata answers. IP literals never reach a resolver, so under the deprecated `IRONCURTAIN_MITM_ALLOW_ALL_HOSTS` they are screened at the CONNECT boundary (`screenIpLiteral`) and every non-public literal (`127.0.0.1`, `[::1]`, `169.254.169.254`, `10.0.0.1`, `127.1`, ...) is refused with `403`, and the tunnel's dial screens any literal again. Local and metadata names are refused there too. A "name" is never allowed to canonicalize into a literal: `canonicalizeHostname` drops the trailing dot only after the URL host parser ran (which drops one itself when it reads IPv4), because stripping one beforehand turned `127.0.0.1..`, a name to every classifier, into `127.0.0.1` and reached host loopback through the wildcard tunnel.
- See decision 2 for the SNI pin on 443 and the Host pin on 80, which keep an approval from reaching other tenants of a shared CDN edge.

### 8. HTTP (non-TLS) to passthrough domains
- Plain HTTP needs its own approval (`host:80`). Absolute-form proxy requests, `ws://` upgrades and CONNECT tunnels to port 80 are all forwarded through the destination-bound transport with the Host header pinned to the approved host.

### 9. Control API isolation
- UDS mode: control socket is in `sessionDir` (not `sessionDir/sockets/`). Only `sockets/` is mounted into the container.
- TCP mode: the socat sidecar only forwards the MCP proxy and MITM proxy ports, not the control port, which binds `127.0.0.1`.
- Both modes: every request needs the per-bundle bearer token (decision 5).

### 10. Virtual-only mode safety
- When `SERVER_FILTER=proxy` and no backend exists, the `clientStates` map is empty. The virtual tool handler intercepts calls before the forwarding path, so the "no client connection" error is never reached for proxy tools.
- If somehow a non-proxy tool name arrives at the proxy instance (should be impossible given UTCP routing), it fails with "Unknown tool" because it is not in the `toolMap`.

### 11. Listener exposure in TCP mode (macOS Docker Desktop)
- The MITM proxy binds `127.0.0.1` in the `tcp-sidecar` topology (`MitmProxyOptions.listenHost`, default loopback), like the Code Mode proxy: Docker Desktop delivers `host.docker.internal` traffic to the host as loopback. It used to bind `0.0.0.0` with no source guard, which made it an open proxy for every LAN peer. A loopback-only connection-source guard stays on as defense in depth, and only the retained `tcp-hostonly` topology binds `0.0.0.0`, always with its subnet guard (`createMitmProxy` refuses a non-loopback bind without one). The nested registry and package egress listeners bind loopback as well.

### 12. Containment of per-connection failures
- Every per-connection listener body (outer `request`/`connect`/`upgrade`, inner `request`/`upgrade`, the port-80 tunnel server and the control API) runs inside a guard that logs and drops only the offending connection: a synchronous throw inside an `http.Server` event handler would otherwise be an uncaught exception and, in daemon mode, end every session at once. The TLS-terminated passthrough forwarder answers a synchronous transport rejection with `502`.

## Testing Strategy

### Unit tests

1. **DynamicHostController**: Test add/remove/list operations, attempts to remove static hosts, domain validation (wildcards, IPs, too-long, unicode, blocked hosts including `*.docker.internal`).
2. **validateAndSwapApiKey**: Test sentinel swap, non-sentinel passthrough, and no-key cases. Verify endpoint filtering still applies for non-sentinel keys.
3. **Control API**: Test HTTP request/response for add/remove/list endpoints, including validation error responses.
4. **Policy rules**: Test that `add_proxy_domain` escalates, `remove_proxy_domain` allows, `list_proxy_domains` allows.
5. **Reserved server names**: Test that configuring an MCP server named `proxy` is rejected.
6. **Virtual-only mode**: Test that `mcp-proxy-server.ts` starts successfully with `SERVER_FILTER=proxy` and no matching backend config. Verify tool listing includes only proxy tools. Verify calls are handled locally.
7. **handleVirtualProxyTool**: Test dispatch for each tool name. Test that `addHost()` returning false produces the "already accessible" message.

### Integration tests

1. **End-to-end passthrough**: Start MITM proxy, add a domain via control API, verify CONNECT to that domain succeeds.
2. **Passthrough credential forwarding**: Verify that requests to passthrough domains carry the agent's original headers unchanged.
3. **Provider domain rejection**: Verify that `add_proxy_domain` for a static provider domain returns "already accessible" (not added as passthrough).
4. **Control API isolation**: Verify the control API is not reachable from the data socket/port.
5. **Sandbox tool routing**: Verify that UTCP routes `proxy.add_proxy_domain()` to the proxy server instance and receives a response.

### Mocking strategy

- `DynamicHostController` is an interface -- mock it for tool handler tests.
- The HTTP control API can be tested with a real HTTP server on a temp UDS.
- PolicyEngine can be configured with the hardcoded proxy annotations for isolated tests.
- For virtual-only mode tests, spawn `mcp-proxy-server.ts` with `SERVER_FILTER=proxy` and no matching server config; connect via `StdioClientTransport` and exercise `ListTools`/`CallTool`.

## Migration Plan

### Phase 1: MITM proxy changes
- Modify `validateAndSwapApiKey` to return `swapped` field and remove the `{ valid: false }` case
- Add `passthroughHosts` set, `DynamicHostController` interface, and passthrough forwarding
- Update `validateDomain` to block `*.docker.internal` suffix (not just exact `host.docker.internal`)
- Add control API on separate socket
- Export `DynamicHostController` and `DomainListing` types
- Add unit tests for domain management, passthrough forwarding, and updated key validation

### Phase 2: Tool definitions and policy
- Create `src/docker/proxy-tools.ts` with tool schemas, annotations, policy rules, control API client, and `handleVirtualProxyTool()`
- Add `proxy` to reserved server names
- Add unit tests

### Phase 3: Virtual-only mode in mcp-proxy-server.ts
- Change the `SERVER_FILTER` check: when filter is `proxy` and no backend exists, enter virtual-only mode instead of exiting with error
- Import and merge proxy annotations and policy rules into PolicyEngine at startup
- Add virtual tool interception in `handleCallTool`: check `toolInfo.serverName === 'proxy'` before the backend forwarding path
- Add proxy tool definitions to `allTools` and `toolMap` when in virtual-only mode
- Read `MITM_CONTROL_ADDR` from env, create `ControlApiClient`
- Add unit and integration tests for virtual-only mode

### Phase 4: Sandbox and infrastructure wiring
- Add `mitmControlAddr` to `IronCurtainConfig`
- In `src/sandbox/index.ts`: after the per-server loop, add a `proxy` entry to `mcpServers` when `config.mitmControlAddr` is set, passing `MITM_CONTROL_ADDR` only to that entry
- Update `docker-infrastructure.ts` to create control socket and set `mitmControlAddr` on config
- Update orientation/help system to include proxy server
- End-to-end testing

---

## Appendix A: Why Not Node.js IPC

The review suggested using Node.js parent-child IPC (`process.send`/`process.on('message')`) instead of the HTTP control API. This would be simpler if feasible, but it is not.

**The problem:** `mcp-proxy-server.ts` is not spawned directly by our code. The spawning chain is:

1. `Sandbox.initialize()` calls `CodeModeUtcpClient.registerManual()` with `{ transport: 'stdio', command, args, env }`
2. UTCP's `CodeModeUtcpClient` internally creates a `StdioClientTransport` with those parameters
3. `StdioClientTransport` calls `child_process.spawn()` with `stdio: ['pipe', 'pipe', 'pipe']`

We do not control step 3. The `StdioClientTransport` from the MCP SDK does not expose an option to add an IPC channel (`stdio: ['pipe', 'pipe', 'pipe', 'ipc']`). Without an IPC channel, `process.send()` is undefined in the child process.

To use Node.js IPC, we would need to either:
- Fork the MCP SDK's `StdioClientTransport` to add IPC support (fragile, maintenance burden)
- Spawn `mcp-proxy-server.ts` ourselves and bridge stdio to UTCP (architectural inversion)

Neither is justified for this feature. The HTTP control API on a separate socket is simple, secure, and uses patterns already established in the codebase.

## Appendix B: Architecture Exploration History

During the design process, several alternative architectures were considered and rejected:

1. **Separate MCP server process.** Running a standalone `ProxyMcpServer` that the proxy connects to as a backend requires UDS/TCP client transport in `mcp-proxy-server.ts`, which currently only supports `StdioClientTransport`. Non-trivial transport gap.

2. **Embed tools in CodeModeProxy.** The CodeModeProxy handles `execute_code` for the container. Adding proxy tools there bypasses the PolicyEngine (which lives in `mcp-proxy-server.ts` child processes), so escalation would not work.

3. **File-based IPC (like escalation).** Writing request/response files for synchronous domain add/remove operations is unnecessarily complex for what should be a simple request-response exchange.

4. **Shared mutable reference.** The design doc initially proposed `DynamicHostController` as a shared in-process reference. This works for the MITM proxy internals but not for the parent-child process boundary between `mcp-proxy-server.ts` and the MITM proxy.

5. **Inject virtual tools into every proxy instance.** The original design said "inject virtual proxy tools into mcp-proxy-server.ts" without specifying which instance(s). Injecting into all instances would mean every per-server proxy process (filesystem, git, etc.) would list and handle proxy tools, creating redundancy and confusion. A dedicated `proxy` instance is cleaner: one process, one responsibility.

The **dedicated proxy process + HTTP control API** approach was chosen because:
- The `proxy` server entry follows the existing one-process-per-server pattern
- UTCP routes `proxy.*` tool calls to the right process automatically
- Virtual tools in `mcp-proxy-server.ts` get free PolicyEngine evaluation, audit logging, and escalation handling
- The HTTP control API is a clean, language-agnostic IPC mechanism
- The separate control socket prevents container access
- `MITM_CONTROL_ADDR` is scoped to only the proxy instance, not leaked to all server processes
- No new dependencies or transport types are needed
