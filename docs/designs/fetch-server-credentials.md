# Fetch Server & User Credentials

**Status (2026-11-14):** Implemented: the fetch server (`src/servers/fetch-server.ts`, with web search and the connect-time destination guard in `src/servers/guarded-fetch.ts`) and per-server credentials (`serverCredentials`).

**Date:** 2026-02-19
**Author:** IronCurtain Engineering
**Depends on:** TB1a (Git Server Integration & Role Extensibility)

## 1. Executive Summary

This continues the multi-server buildout started in `multi-server-onboarding.md` (phases 1–3). Where the initial onboarding added git server integration with role extensibility and domain-based policy evaluation, this design adds two capabilities: (a) a custom HTTP fetch MCP server for retrieving web content with inspectable URL arguments, and (b) per-server user credential configuration so secrets stay out of source-controlled files.

The `fetch-url` role (defined in `multi-server-onboarding.md`) is exercised by the fetch server. User credentials enable token-based auth for git push. Constitution customization is covered in `constitution-customizer.md`.

## 2. Fetch MCP Server

### 2.1 Design Decision: Custom Server

Build a minimal custom server (`src/servers/fetch-server.ts`) rather than depending on the official Python fetch server or community alternatives.

**Rationale:**

- Full control over tool schema (inspectable arguments for policy)
- No Python runtime dependency
- Single file (~100 lines) using `@modelcontextprotocol/sdk`
- Consistent with the Node.js/TypeScript codebase

### 2.2 Tool Schema

Single `http_fetch` tool (GET-only):

```typescript
{
  name: 'http_fetch',
  description: 'Fetch content from a URL via HTTP GET',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch' },
      headers: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'HTTP headers',
      },
      max_length: {
        type: 'number',
        default: 5000,
        description: 'Maximum response body length in characters',
      },
      raw_html: {
        type: 'boolean',
        default: false,
        description: 'When true, return raw HTML instead of converting to markdown',
      },
    },
    required: ['url'],
  },
}
```

**Implementation:** Uses undici's own `fetch` with a per-call undici `Agent` (the npm `undici` package, not Node's global `fetch`, which bundles a different undici that must not be mixed with an npm dispatcher); see Section 2.4. Does not execute JavaScript — serves static content only. A Playwright-based browser server can be added separately if JS rendering is needed in the future.

Response includes status code, the final URL (`url`), the same-origin redirects followed (`redirects`), headers (selected), and body (truncated to `max_length`). By default, HTML responses are converted to markdown using `turndown` for readability. The shipped tool replaced `raw_html` with `format: "markdown" | "text" | "html"`; `format: "html"` returns the original HTML. If `turndown` throws on malformed input, the server falls back to returning the raw HTML body. See Section 2.9 for decoding and binary content.

The `headers` parameter is annotated with role `none` — the policy engine does not inspect header values. Header-level controls (e.g., blocking `Authorization` headers) are deferred.

The fetch server injects a `User-Agent` header on every request: `IronCurtain/0.1 (AI Agent Runtime)`. This is applied _after_ merging agent-provided headers, so the agent cannot override it. Server operators can use this to identify, rate-limit, or block AI agent traffic.

### 2.3 Server Configuration

```jsonc
// src/config/mcp-servers.json
"fetch": {
  "command": "npx",
  "args": ["tsx", "./src/servers/fetch-server.ts"],
  "sandbox": {
    "network": {
      "allowedDomains": ["*"]
    }
  }
}
```

`allowedDomains: ["*"]` means no OS-level network restriction. The policy engine controls what the agent is ALLOWED to fetch (semantic intent). The sandbox layer controls what the process CAN reach (containment). These are separate concerns — `"*"` at the sandbox level means the untrusted domain gate passes all domain-name URLs through to compiled rule evaluation. However, IP-address hostnames are **not** matched by `"*"` (see Section 2.4).

**As shipped:** the fetch entry is `"sandbox": false` (srt's network sandbox blocks the Unix domain sockets tsx needs in dev mode), so the fetch server runs on the host without OS-level containment. With no `allowedDomains`, the policy engine gates fetch with its default `['*']` (Section 2.4): names pass to the compiled rules, IP literals escalate, and local or cloud-metadata hosts are denied structurally. The policy layer still sees only the requested URL and resolves no names, so the connect-time SSRF defence lives in the fetch server itself (Section 2.4).

### 2.4 SSRF Protection (Structural Invariant)

Raw IP addresses in URLs are treated as a structural invariant in the untrusted domain gate: **any URL whose hostname is an IP address (IPv4 or IPv6) requires explicit allowlist permission**. Domain wildcards like `"*"` do not match IP addresses.

This blocks SSRF attacks targeting internal infrastructure (127.0.0.1, 10.x.x.x, 169.254.169.254, etc.) without maintaining a blocklist. Legitimate IP-based access can be enabled via the server's `allowedDomains` in `mcp-servers.json`:

```jsonc
"allowedDomains": ["*", "192.168.1.100"]  // domain wildcard + explicit IP
```

**Implementation — two changes to existing code:**

1. **`extractServerDomainAllowlists()`** (`src/config/index.ts`) — stop filtering `*` from the allowlist. Currently, `["*"]` is filtered to `[]` which produces no map entry, causing the untrusted domain gate to be skipped entirely. With this change, `["*"]` produces an allowlist entry of `["*"]` so the untrusted domain gate fires.

2. **`domainMatchesAllowlist()`** (`src/trusted-process/policy-engine.ts`) — when the pattern is `*`, check whether the domain is an IP address. If so, skip the wildcard match:

```typescript
function isIpAddress(domain: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(domain) || domain.includes(':');
}

// In domainMatchesAllowlist:
if (pattern === '*') return !isIpAddress(domain); // was: return true
```

`isIpAddress()` now delegates to `classifyHostLiteral()` in `src/net/address-policy.ts`, so every spelling the resolver or URL parser accepts counts as an IP: the inet_aton forms (`2130706433`, `127.1`, `0x7f000001`, `0177.0.0.1`), IPv6 bracketed or not, zone-scoped IPv6, and malformed literals. The regex above missed all but the dotted quad. Git remote hosts are canonicalized the same way before matching (see multi-server-onboarding.md section 4.2).

**Resulting behavior by allowlist configuration:**

| `allowedDomains`         | Domain URL                            | IP URL                               | IP in explicit list               |
| ------------------------ | ------------------------------------- | ------------------------------------ | --------------------------------- |
| `["*"]`                  | domain gate pass → compiled rules     | **escalate**                         | n/a                               |
| `["*", "192.168.1.100"]` | domain gate pass → compiled rules     | **escalate** (unless explicit match) | domain gate pass → compiled rules |
| `["github.com"]`         | escalate (unless match)               | **escalate**                         | n/a                               |
| not configured           | default `["*"]` gate → compiled rules | **escalate**                         | n/a                               |

**Default gate.** A server whose entry has no `allowedDomains` is gated by the engine's default `["*"]` (`DEFAULT_DOMAIN_GATE` in `policy-engine.ts`), so the table's first row applies to it: a compiled "allow" rule without a `domains` condition never admits an address literal. This replaced the config-load-time warning originally planned for a server with `fetch-url` or `git-remote-url` roles and no `allowedDomains`; the shipped fetch server has none (Section 2.3). A `fetch-url` value that is not an http(s) URL with a host (`file:///etc/passwd`, a bare `host:port`) is unverifiable and escalates on the gate.

**Local and metadata destinations are denied, not escalated.** Whatever the allowlist or the compiled rules say, a `fetch-url` whose host is `localhost`, `*.localhost`, `*.local`, `*.internal` (including `metadata.google.internal`), another local name (`isLocalOrMetadataHostname` in `src/net/address-policy.ts`) or a metadata IP literal in any spelling (`169.254.169.254`, `fd00:ec2::254`, `100.100.100.200`, ...) is denied structurally (`structural-local-destination-deny`, `isLocalOrMetadataHost` in `domain-utils.ts`). Such a fetch reads credentials or unauthenticated local services, never web content, so no human approval is offered. Other private IP literals (`127.0.0.1`, `10.0.0.1`) only escalate, because `fetch.allowPrivateNetworks` (below) can legitimately admit a literal a human approves; `localhost` itself stays denied at the policy layer, so with the opt-in a loopback service is fetched by its IP literal.

**Known limitation:** DNS rebinding (a domain resolving to a private IP) is not detected at the policy layer, which never resolves names. For the fetch server it is handled at connect time, below.

#### Connect-time destination guard (`src/servers/guarded-fetch.ts`)

Because the policy layer sees only the URL string, the fetch server screens every destination itself, on every request including the first:

- **Names** resolve through `createGuardedLookup` (`src/net/address-policy.ts`), installed as the undici `Agent`'s `connect.lookup`. The whole answer set must be public and contain no metadata address (`isMetadataAddress`); any loopback, RFC 1918, CGNAT, link-local, metadata, ULA, multicast, documentation or IPv4-mapped/embedded private answer fails the lookup, and so does Azure's WireServer `168.63.129.16`, which is public. The socket connects to an address that passed the check, so DNS rebinding cannot swap it in between.
- **IP literals** never reach a lookup (Node connects to them directly), so the URL host is screened with `screenIpLiteral` and `isMetadataAddress` before the request. WHATWG URL parsing has already canonicalized decimal, octal, hex and short IPv4 forms and IPv4-mapped IPv6.
- **Local and metadata names** (`localhost`, `*.local`, `*.internal`, `metadata.google.internal`, ...) are refused before any lookup by `isLocalOrMetadataHostname`.

**Private networks opt-in.** `fetch.allowPrivateNetworks: true` in `~/.ironcurtain/config.json` (default `false`) admits private destinations that the requested, policy-evaluated URL names literally: a private IP literal (RFC 1918, CGNAT, loopback, IPv6 ULA) or `localhost` / `*.localhost`, which the server pins to `127.0.0.1` / `::1` without a lookup. Link-local and metadata addresses (including the documented metadata and credential endpoints that sit inside the admitted ULA and CGNAT ranges: AWS's `fd00:ec2::254` and `fd00:ec2::23`, Google Cloud's `fd20:ce::254`, Oracle's `fd00:c1::a9fe:a9fe`, Akamai's `fd00:a9fe:a9fe::1`, Scaleway's `fd00:42::42` and Alibaba Cloud's `100.100.100.200`), metadata names, other local names and DNS answers in private ranges stay blocked even then, and redirects can never reach a different host (Section 2.5). The flag reaches the fetch server process only through its environment: `loadConfig()` always writes `IRONCURTAIN_FETCH_ALLOW_PRIVATE_NETWORKS` (`1` or `0`) into `mcpServers.fetch.env`, so the config file decides, and a server spawned without the variable blocks every non-public destination. No tool argument can change it. Tests use the same variable when they spawn the server.

### 2.5 Redirect Handling

> **Superseded.** The original design followed redirects with no per-hop policy re-evaluation and accepted that an allowed domain could redirect anywhere. In practice the `maxRedirections` hop cap was silently ignored by `fetch` (it followed up to the Fetch-spec limit of 20), agent-supplied headers survived cross-origin hops, and an allow-listed domain hosting user content or an open redirect could bounce a host-side fetch into loopback services or cloud metadata. The behaviour below replaces it.

Requests use `redirect: 'manual'`, and the fetch server decides each hop itself:

- **Same-origin redirects** (same scheme, host and port) are followed, at most 5 per call; a 6th is refused with a `REDIRECT_LIMIT` error. Each hop is re-validated (scheme, credentials, destination screen) and goes through the same connect-time guard. Because the origin is unchanged, the destination is still the one the policy evaluated, and agent-supplied headers go with it.
- **Cross-origin redirects** are never followed. The result carries the 3xx status, an empty body and `redirect: { location, followed: false, reason: "cross-origin" }`, with the `Location` resolved to an absolute URL. If the agent wants the target, it calls `http_fetch` again, and that call is policy-evaluated, escalatable and audited like any other. Agent-supplied headers therefore never leave the evaluated origin.
- Every result reports `url` (the URL whose response is returned) and `redirects` (each followed hop's status, URL and location), and errors raised mid-chain report the same, so the redirect path is visible to the agent and, for errors, in the audit log.

This costs an extra tool call for common cross-origin redirects (`http` to `https`, apex to `www`) in exchange for every contacted origin being one the policy evaluated.

### 2.6 Response Limits

Beyond `max_length` (character truncation of the response body), the fetch server enforces:

- **Hard response size limit:** 10 MB maximum raw response body. Responses exceeding this are aborted mid-stream.
- **Request timeout:** 30 seconds by default; the agent may choose 1–60 seconds with the `timeout` argument. The deadline covers the whole call: every redirect hop and the body.

These prevent resource exhaustion from streaming endpoints or slow servers.

### 2.7 Constitution Updates

```markdown
- The agent may fetch web content via HTTP GET from any domain for reading purposes.
```

### 2.8 Handwritten Scenarios

```typescript
'Fetch GET from any domain -- allow';
'Fetch with raw IP address URL -- escalate (SSRF protection)';
'Unknown fetch tool -- deny (structural invariant)';
```

### 2.9 Response Decoding and Binary Content

Implemented in `src/servers/fetch-content.ts`:

- **Classification** by the `Content-Type` essence: `text/html` and `application/xhtml+xml` are HTML (converted per `format`); `text/*`, `*+json`, `*+xml` and the common textual `application/*` types are text; a missing type or `application/octet-stream` is sniffed (binary if the first bytes contain a byte that never occurs in text, or look like a PDF); everything else (images, audio, video, fonts, PDFs, archives) is binary.
- **Binary** responses are never decoded. A body whose declared type is binary is not even downloaded; a sniffed one has been read (within the 10 MB cap). The result has an empty body and `binary: { contentType, size }`, where `size` is the bytes received when the body was sniffed, else the declared `Content-Length`, else `null`.
- **Charset**: a byte order mark wins, then the `Content-Type` `charset` parameter, then the document's own declaration (`<meta charset>` or `<meta http-equiv="Content-Type" content="...; charset=...">` in the first 1024 bytes for HTML, the XML declaration for XML types), then UTF-8. Labels are resolved with `TextDecoder`, so `iso-8859-1` decodes as windows-1252 as in browsers; an unknown label falls back instead of failing.

## 3. User Credential Configuration

### 3.1 Problem

Credentials for MCP servers (git tokens, API keys) must not live in source-controlled files (`mcp-servers.json`). Users need a way to inject per-server secrets.

### 3.2 Design: serverCredentials in User Config

Extend `~/.ironcurtain/config.json` with a `serverCredentials` section:

```jsonc
{
  "agentModelId": "anthropic:claude-sonnet-4-6",
  "policyModelId": "anthropic:claude-sonnet-4-6",
  "anthropicApiKey": "sk-ant-...",

  "serverCredentials": {
    "git": {
      "GH_TOKEN": "ghp_xxxxxxxxxxxx",
    },
    "fetch": {
      "FETCH_API_KEY": "key_xxxxxxxxxxxx",
    },
  },
}
```

### 3.3 Merge Order

When spawning an MCP server, environment variables are merged:

1. `process.env` (system environment)
2. `mcp-servers.json` `env` field (static per-server config)
3. `config.json` `serverCredentials[serverName]` (user-specific secrets)

Later values override earlier ones. A user can override a default env var from `mcp-servers.json` with their own credential.

### 3.4 Type Definitions

```typescript
// src/config/user-config.ts
const userConfigSchema = z.object({
  // ... existing fields ...
  serverCredentials: z.record(z.string(), z.record(z.string(), z.string().min(1))).optional(),
});

export interface ResolvedUserConfig {
  // ... existing fields ...
  readonly serverCredentials: Readonly<Record<string, Readonly<Record<string, string>>>>;
}
```

Inner values use `.min(1)` to reject empty strings that would silently fail to authenticate. `serverCredentials` is added to `SENSITIVE_FIELDS` (see 3.8).

In `mergeWithDefaults()`, `serverCredentials` defaults to `{}` when absent from the config file, so `ResolvedUserConfig.serverCredentials` is always a non-optional record.

### 3.5 Proxy Integration

The proxy runs as a separate child process (one per backend server via `SERVER_FILTER`). Server credentials flow through a carefully scoped pipeline:

**Data path:** `config.userConfig.serverCredentials` -> `Sandbox.initialize()` -> per-server `SERVER_CREDENTIALS` in that relay's environment block (`buildServerRelayEnv()`) -> the relay's backend environment (`buildBackendEnv()`).

```typescript
// sandbox/index.ts (connectBackendSubprocesses) -- one relay per server,
// each given ONLY its own server's config and credentials
const relays = relayServerNames(config, osSandboxPlan).map((serverName) => {
  const serverCreds = config.userConfig.serverCredentials[serverName];
  return {
    serverName,
    config: {
      command: PROXY_COMMAND,
      args: [...PROXY_ARGS],
      // buildServerRelayEnv(): the host values of this server's `-e NAME`
      // arguments, the shared proxyEnv block, then
      //   MCP_SERVERS_CONFIG: JSON.stringify({ [serverName]: serverConfig }),
      //   SERVER_FILTER: serverName,
      //   SERVER_CREDENTIALS: JSON.stringify(serverCreds)   (when set)
      env: buildServerRelayEnv(proxyEnv, serverName, config.mcpServers[serverName], serverCreds),
      sandbox: false,
    },
  };
});
// The relays start concurrently (RELAY_CONNECT_CONCURRENCY at a time) via
// manager.connect(); MCPClientManager.connect() adds only the allowlist of
// trusted-process/child-env.ts, never the host's process.env.

// mcp-proxy-server.ts -- parse flat credential map, scrub from process.env
const serverCredentials: Record<string, string> = process.env.SERVER_CREDENTIALS
  ? JSON.parse(process.env.SERVER_CREDENTIALS)
  : {};
delete process.env.SERVER_CREDENTIALS; // Prevent leakage to MCP server children

// When spawning each MCP server (buildBackendEnv):
const spawnEnv = {
  ...inheritedEnv(process.env, { passthroughNames: passthroughEnvNames(config.args), sshAgent: isGitBackend(serverName) }),
  GIT_CEILING_DIRECTORIES: gitCeilingDirectories(serverCwd),
  ...(config.env ?? {}),
  ...serverCredentials, // flat map since we filtered per-server in sandbox
  ...oauthEnv,
};
```

**Security invariants:**

1. Each proxy process receives credentials ONLY for its own server (least privilege), and only its own server's configuration in `MCP_SERVERS_CONFIG`.
2. `SERVER_CREDENTIALS` is deleted from `process.env` immediately after parsing, before any MCP server children are spawned.
3. Credentials are merged after the inherited allowlist and the server's `env` block, so they override both system env and static `mcp-servers.json` values. One exception (2026-11): for the git backend the hardened git environment (`hardenGitBackendEnv`, `src/trusted-process/git-backend-env.ts`) is applied last, after the credentials, so no merged value can weaken it (`buildBackendEnv` in `src/trusted-process/mcp-proxy-server.ts`).
4. Neither the relay nor the backend inherits the host environment: both get the allowlist of `src/trusted-process/child-env.ts` (system variables such as `PATH`, `HOME`, locale, temp, proxy and npm settings), plus, for a docker-style `-e NAME` argument, that one host variable. Provider API keys and other servers' tokens never reach a backend.
5. A `-e NAME` variable counts as present when it is set in the host environment, the server's `env` block or its stored credentials (`isEnvVarProvided()`), so a server whose token exists only in `serverCredentials` starts instead of being skipped -- the same rule `ironcurtain doctor` reports.

### 3.6 Config File Permissions

`~/.ironcurtain/config.json` contains secrets (`anthropicApiKey`, `serverCredentials`). The `readOrCreateConfigFile()` function must set file permissions to `0o600` on creation, and `loadUserConfig()` should warn if the file is group- or world-readable.

### 3.7 Server Name Validation

After both `loadUserConfig()` and `mcp-servers.json` are loaded in `loadConfig()`, warn if any `serverCredentials` key does not match a server name in `mcp-servers.json`. This check cannot happen in `loadUserConfig()` because it does not have access to server names. This catches typos (e.g., `"Git"` instead of `"git"`) that would otherwise silently fail to inject credentials.

### 3.8 Schema Changes

Add `serverCredentials` to `SENSITIVE_FIELDS` to prevent the backfill mechanism from writing a default value into `config.json`. The Zod schema should enforce non-empty credential values:

```typescript
const userConfigSchema = z.object({
  // ...existing fields...
  serverCredentials: z.record(z.string(), z.record(z.string(), z.string().min(1))).optional(),
});
```

### 3.9 Credential Masking

MCP server stderr lines are scanned for known credential values before writing to the session log. Matching substrings are replaced with `***REDACTED***`, longest value first. The values are the server's stored credentials, the OAuth variables the relay prepared for it, and each value of at least 8 characters that its environment holds for a variable its `-e NAME` arguments forward (a token exported in the shell, such as `GITHUB_PERSONAL_ACCESS_TOKEN`). This is plain string replacement, built per backend by `backendStderrRedactor()` in the relay (`src/trusted-process/mcp-proxy-server.ts`) and applied to streamed lines and to the startup stderr a failed connection quotes alike. Streamed stderr is redacted in whole lines (`lineBufferedText()`): a pipe can deliver one write in several chunks, and a value split between two of them would otherwise reach the log in two unmasked halves. Text after the last newline waits for the rest of its line, for the end of the stream, or until it exceeds 64 KiB.

This design left the audit log unredacted: the path from credential to tool argument is indirect (server echoes credential in response → enters LLM context → agent passes as argument) and unreliable to catch via string matching. As implemented since, audit entries are redacted too, on by default (`auditRedaction.enabled`): `src/trusted-process/audit-redactor.ts` masks well-known key and token formats, and the exact credential values IronCurtain holds, collected by `src/trusted-process/audit-secrets.ts` (configured server credentials, provider API keys, OAuth tokens), are replaced wherever they appear in tool arguments and results. See `docs/SECURITY_CONCERNS.md` §8 for the threat analysis and the residual risk (a credential echoed in a tool response still reaches the LLM context unmasked).

## 4. Implementation Phases

Phase numbering continues from TB1a (phases 1–3).

### Phase 4: Fetch Server

**New files:**

- `src/servers/fetch-server.ts` -- minimal fetch MCP server using Node built-in `fetch` + `turndown`

**New dependency:**

- `turndown` -- HTML-to-markdown conversion (optional, controlled by `raw_html` parameter)

**Files changed:**

- `src/config/mcp-servers.json` -- add fetch server entry
- `src/config/index.ts` -- stop filtering `*` in `extractServerDomainAllowlists()`
- `src/config/constitution.md` -- add fetch-specific guidance
- `src/pipeline/handwritten-scenarios.ts` -- add fetch scenarios
- `src/trusted-process/policy-engine.ts` -- modify `domainMatchesAllowlist()` so `*` does not match IP addresses

**Pipeline run:** `npm run compile-policy` with filesystem + git + fetch.

### Phase 5: User Credential Configuration

**Files changed:**

- `src/config/user-config.ts` -- add `serverCredentials` to schema, `ResolvedUserConfig`, `SENSITIVE_FIELDS`, and `mergeWithDefaults()` (default `{}`); set 0o600 permissions on config file creation; warn on world-readable permissions
- `src/config/index.ts` -- validate `serverCredentials` keys against `mcp-servers.json` server names in `loadConfig()` (after both configs are loaded)
- `src/trusted-process/mcp-proxy-server.ts` -- read `SERVER_CREDENTIALS` env var (flat per-server map), delete from `process.env` before spawning children, merge into spawn env; inline credential masking in stderr handler
- `src/sandbox/index.ts` -- pass per-server credentials (not all credentials) to each proxy via `SERVER_CREDENTIALS`

## 5. Test Strategy

### Fetch Server Tests

- Server starts and responds to MCP protocol
- `http_fetch` tool listed with correct schema
- GET request returns status, headers, body
- `User-Agent` header is always `IronCurtain/0.1 (AI Agent Runtime)`, even when agent sets a custom `User-Agent`
- `max_length` truncation works
- Invalid URL returns structured error
- HTML-to-markdown conversion via turndown (default)
- Malformed HTML falls back to raw content when turndown throws
- `raw_html: true` returns original HTML without conversion
- Response exceeding 10 MB hard limit is aborted
- Request timeout fires after configured duration
- Same-origin redirects followed up to 5 hops and reported; a 6th hop is refused
- Cross-origin redirect returned (status and `location`), not followed; the target is never contacted
- SSRF: redirects to 127.0.0.1 and 169.254.169.254 are not followed, and direct requests to them are refused
- SSRF: a hostname resolving to loopback (or a mixed public/private answer set) is refused at connect time
- SSRF: loopback, private, link-local and metadata IP literals in every textual form are refused; with `fetch.allowPrivateNetworks`, private literals and `localhost` are allowed but metadata stays refused
- Agent-supplied `User-Agent` in any spelling is replaced
- Latin-1 page decoded by `Content-Type` charset and by `<meta charset>`; XHTML treated as HTML; binary response returns metadata
- SSRF: IP-address URLs escalated by policy engine (structural invariant)
- SSRF: `*` wildcard does not match IP-address hostnames
- SSRF: explicit IP in allowlist passes policy

### User Credentials Tests

- `serverCredentials` parsed from user config
- Merge order: system env < server env < user credentials
- Missing `serverCredentials` defaults to empty
- `SERVER_CREDENTIALS` env var round-trips through JSON serialization
- Each per-server proxy receives ONLY its own credentials (not other servers')
- `SERVER_CREDENTIALS` deleted from `process.env` before child MCP server spawn
- Config file created with 0o600 permissions
- Warning emitted for group/world-readable config file
- Warning emitted for `serverCredentials` keys not matching any server in `mcp-servers.json`
- Empty credential values rejected by schema validation
- `serverCredentials` not backfilled into config file (in `SENSITIVE_FIELDS`)
- Known credential values in session log stderr lines are replaced with `***REDACTED***`

### Integration Tests

- All three servers (filesystem, git, fetch) connect and list tools
- Full compile-policy produces coherent artifacts for all servers
- Cross-server policy evaluation (read file → commit → push → fetch) works correctly
