# MCP Roots Integration Design

**Status (2026-11-14):** Implemented (`src/trusted-process/roots-expansion.ts`, `src/trusted-process/policy-roots.ts`); approved roots are canonical, verified and never agent-writable (WP-12).

## Problem

The compiled policy (`src/config/generated/compiled-policy.json`) grants access to directories beyond the sandbox -- for example, `~/Downloads` for read/write/delete and `~/Documents` for read-only. However, the filesystem MCP server is launched with only the sandbox directory as a CLI argument:

```json
{
  "filesystem": {
    "command": "node",
    "args": ["node_modules/@modelcontextprotocol/server-filesystem/dist/index.js", "/tmp/ironcurtain-sandbox"]
  }
}
```

(The server is the exact-pinned runtime dependency, launched with `node` from IronCurtain's package root rather than through `npx`; the allowed directory is always the last argument.)

The filesystem server rejects any request targeting a path outside its configured directories _before_ IronCurtain's policy engine can evaluate it. This means the policy rules for `~/Downloads` and `~/Documents` are dead code -- they can never match because the server-side check fires first.

Additionally, the compiled policy includes a catch-all `escalate-read-outside-permitted-areas` rule that escalates reads outside all permitted areas to a human for approval. Even when a human approves, the filesystem server rejects the call because the target directory was never in its allowed list.

## Solution

Use the MCP Roots protocol to dynamically communicate policy-referenced directories to the filesystem MCP server. At connection time, roots are seeded from the compiled policy. When a human approves an escalation for a path outside the current roots, the containing directory is added as a new root and the server is notified via `notifications/roots/list_changed` before the call is forwarded.

This creates defense in depth: the MCP server enforces broad directory boundaries, and the policy engine enforces fine-grained per-role rules within those boundaries.

## Key Design Decisions

1. **Extract directories from compiled policy, not the constitution.** The compiled policy is the canonical source of truth at runtime. Parsing the constitution's prose would be fragile and redundant since the pipeline already distills it into structured rules.

2. **Standalone extraction function, not a PolicyEngine method.** Directory extraction is a startup concern, not a per-request concern. It operates on the `CompiledPolicyFile` data structure directly. Putting it in PolicyEngine would conflate construction-time setup with the evaluation interface.

3. **Always include the sandbox directory.** The `ALLOWED_DIRECTORY` is the unconditional baseline that the structural invariant auto-allows. Even if no compiled rule references it explicitly, it must be a root.

4. **Each process computes its own roots from the compiled policy.** Both the proxy (`mcp-proxy-server.ts`) and the in-process mode (`TrustedProcess`) already load the compiled policy at startup. Each computes its initial roots directly -- no env var needed to pass pre-computed roots between processes.

5. **Keep CLI args as fallback.** If the filesystem server does not support the roots protocol, the CLI arg still provides the sandbox directory. When roots are provided, the filesystem server ignores CLI args entirely, so there is no conflict.

6. **Dynamic root expansion on escalation approval.** When an escalation is approved (by a human, the auto-approver or the session whitelist), the directory each escalated path needs is added as a new root and the filesystem server is notified via `notifications/roots/list_changed`. The `listChanged` capability is declared as `true` at connection time to signal that root updates may occur. The implementation must ensure the server has processed the updated roots before forwarding the approved call. Because a root is a persistent widening that the server re-resolves on every refresh, only canonical, approved roots that the agent cannot redirect are added; see [Approved roots: canonical, verified, not agent-writable](#approved-roots-canonical-verified-not-agent-writable).

## Extraction and Conversion Functions

### `src/trusted-process/policy-roots.ts`

A new module with pure functions for root extraction, conversion, and path-to-directory mapping.

```typescript
import { resolve, dirname } from 'node:path';
import type { CompiledPolicyFile } from '../pipeline/types.js';

/**
 * Root entry for the MCP Roots protocol.
 * Mirrors the MCP SDK's Root type without importing it directly,
 * keeping this module free of SDK dependencies.
 */
export interface PolicyRoot {
  /** Absolute directory path (not a file:// URI yet -- callers convert). */
  readonly path: string;
  /** Human-readable label for debugging and audit logs. */
  readonly name: string;
}

/**
 * Extracts the set of directories that the compiled policy references
 * in `allow` or `escalate` rules with `paths.within` conditions.
 * These directories, plus the sandbox, form the initial roots that
 * MCP servers should accept.
 *
 * `deny` rules are excluded -- they never grant access, so exposing
 * denied directories as roots would widen the server-side boundary
 * without purpose.
 *
 * Catch-all rules without `paths.within` (like
 * `escalate-read-outside-permitted-areas`) are also excluded from
 * initial roots. Those are handled dynamically: when a human approves
 * an escalation, the target directory is added as a root at that time.
 *
 * @param compiledPolicy - The loaded compiled policy artifact.
 * @param allowedDirectory - The sandbox directory (always included).
 * @returns Deduplicated array of PolicyRoot entries, sandbox first.
 */
export function extractPolicyRoots(compiledPolicy: CompiledPolicyFile, allowedDirectory: string): PolicyRoot[] {
  const seen = new Set<string>();
  const roots: PolicyRoot[] = [];

  // Sandbox is always the first root.
  const resolvedSandbox = resolve(allowedDirectory);
  seen.add(resolvedSandbox);
  roots.push({ path: resolvedSandbox, name: 'sandbox' });

  for (const rule of compiledPolicy.rules) {
    if (rule.then === 'deny') continue;
    if (!rule.if.paths?.within) continue;

    const dir = resolve(rule.if.paths.within);
    if (seen.has(dir)) continue;

    seen.add(dir);
    roots.push({ path: dir, name: rule.name });
  }

  return roots;
}

/**
 * Converts PolicyRoot entries to MCP Root objects with `file://` URIs.
 * URIs are built with `pathToFileURL` (see rootUriForPath below).
 */
export function toMcpRoots(policyRoots: PolicyRoot[]): Array<{ uri: string; name: string }> {
  return policyRoots.map((r) => ({
    uri: rootUriForPath(r.path),
    name: r.name,
  }));
}

/**
 * `pathToFileURL(directory).href`. A plain `file://${path}` would let a
 * directory named `/home/u/x#y` reach the server as `/home/u/x` (the
 * rest parses as a URL fragment). `pathForRootUri` is the inverse.
 */
export function rootUriForPath(directory: string): string;

/**
 * Absolute canonical path of an approved path argument. Relative paths
 * resolve against the sandbox (the base the policy engine uses), never
 * against the process working directory; without a base they yield
 * undefined.
 */
export function resolveApprovedPath(filePath: string, baseDirectory?: string): string | undefined;

/**
 * The root a canonical approved path needs: the path itself when it is
 * an existing directory (lstat, never following a final symlink),
 * otherwise its parent (a file, or a path the call will create).
 */
export function rootDirectoryForCanonicalPath(canonicalPath: string): string;

/** resolveApprovedPath followed by rootDirectoryForCanonicalPath. */
export function directoryForPath(filePath: string, baseDirectory?: string): string | undefined;
```

### Design notes on the extraction logic

- **`resolve()` before deduplication.** Two rules might reference the same directory with different relative/absolute forms. Resolving first ensures deduplication is reliable.
- **`deny` rules excluded.** A `deny` rule for a directory does not imply the server should accept files from that directory. Only `allow` and `escalate` rules indicate that file operations in those directories are potentially valid.
- **Catch-all escalation rules excluded from initial roots.** Rules like `escalate-read-outside-permitted-areas` have no `paths.within` condition -- they match _any_ path. Including them would mean "allow access everywhere", defeating the purpose of roots. Instead, these are handled dynamically when a human approves the escalation.
- **Sandbox always first.** The sandbox is the primary working directory. Listing it first makes log output easier to scan.

## Changes to MCPClientManager

The `connect` method gains an optional `roots` parameter. When provided, the client declares the `roots` capability with `listChanged: true` and registers a handler for the `roots/list` request. The roots array is mutable -- new roots can be added after connection via `addRoot()`.

```typescript
// src/trusted-process/mcp-client-manager.ts

import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export interface McpRoot {
  uri: string;
  name: string;
}

interface ManagedServer {
  client: Client;
  transport: StdioClientTransport;
  roots?: McpRoot[]; // Mutable roots list (if roots enabled)
  rootsRefreshed?: () => void; // Resolves when server fetches updated roots
}

export class MCPClientManager {
  private servers = new Map<string, ManagedServer>();

  async connect(name: string, config: MCPServerConfig, roots?: McpRoot[]): Promise<void> {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      // Never the host environment: the allowlist of
      // trusted-process/child-env.ts plus the server's own `env` block.
      env: { ...inheritedEnv(process.env, { passthroughNames: passthroughEnvNames(config.args) }), ...config.env },
    });

    const capabilities: Record<string, unknown> = {};
    if (roots) {
      capabilities.roots = { listChanged: true };
    }

    const client = new Client({ name: 'ironcurtain', version: '0.1.0' }, { capabilities });

    // Mutable copy -- addRoot() pushes to this array.
    const mutableRoots = roots ? [...roots] : undefined;
    const managed: ManagedServer = { client, transport, roots: mutableRoots };

    // When the server asks for roots, return the current set.
    // If a rootsRefreshed callback is registered (from addRoot),
    // resolve it so the caller knows the server has the latest roots.
    if (mutableRoots) {
      client.setRequestHandler(ListRootsRequestSchema, async () => {
        if (managed.rootsRefreshed) {
          managed.rootsRefreshed();
          managed.rootsRefreshed = undefined;
        }
        return { roots: mutableRoots };
      });
    }

    await client.connect(transport);
    this.servers.set(name, managed);
  }

  /**
   * Adds a root directory to a connected server and waits for the
   * server to fetch the updated root list. This ensures the server's
   * allowed directories include the new root before any tool call
   * that depends on it is forwarded.
   *
   * No-op if the root URI is already present.
   */
  async addRoot(serverName: string, root: McpRoot): Promise<void> {
    const server = this.servers.get(serverName);
    if (!server?.roots) return;

    // Deduplicate
    if (server.roots.some((r) => r.uri === root.uri)) return;
    server.roots.push(root);

    // Wait for the server to call roots/list after we notify it.
    const refreshed = new Promise<void>((resolve) => {
      server.rootsRefreshed = resolve;
    });
    await server.client.sendRootsListChanged();
    await refreshed;
  }

  // ... listTools, callTool, closeAll unchanged
}
```

### Synchronization: why `addRoot` awaits acknowledgment

After calling `sendRootsListChanged()`, the server asynchronously sends a `roots/list` request to fetch the updated roots. If we forward the tool call immediately, the server might process it before the roots update completes. By waiting for our `roots/list` handler to fire, we know the server has received the updated root set before we send the tool call.

## Changes to Proxy Mode (mcp-proxy-server.ts)

The proxy already loads the compiled policy and has `ALLOWED_DIRECTORY` in its environment. It computes roots directly -- no additional env var from the sandbox needed.

### Initialization

```typescript
// In mcp-proxy-server.ts main(), after loading policy:

const { compiledPolicy, toolAnnotations } = loadGeneratedPolicy(generatedDir);

// Compute initial roots from compiled policy
import { extractPolicyRoots, toMcpRoots, directoryForPath } from './policy-roots.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const policyRoots = extractPolicyRoots(compiledPolicy, allowedDirectory ?? '/tmp');
const mcpRoots = toMcpRoots(policyRoots);

// Track per-client mutable roots and acknowledgment callbacks
interface ClientState {
  client: Client;
  roots: Array<{ uri: string; name: string }>;
  rootsRefreshed?: () => void;
}
const clientStates = new Map<string, ClientState>();
```

### Client connection with roots

```typescript
for (const [serverName, config] of Object.entries(serversConfig)) {
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    // buildBackendEnv(): the allowlist of child-env.ts, the server's `env`,
    // credentials and OAuth variables -- never the relay's process.env.
    env: buildBackendEnv(serverName, config, { sandboxed, serverCredentials, oauthEnv, allowedDirectory, serverCwd }),
    stderr: 'pipe',
  });

  // ... existing stderr handling ...

  const roots = [...mcpRoots]; // Mutable copy per client
  const state: ClientState = { client: undefined!, roots };

  const client = new Client(
    { name: 'ironcurtain-proxy', version: '0.1.0' },
    { capabilities: { roots: { listChanged: true } } },
  );
  state.client = client;

  client.setRequestHandler(ListRootsRequestSchema, async () => {
    if (state.rootsRefreshed) {
      state.rootsRefreshed();
      state.rootsRefreshed = undefined;
    }
    return { roots: state.roots };
  });

  await client.connect(transport);
  clientStates.set(serverName, state);

  // ... existing tool listing ...
}
```

### Escalation-triggered root expansion

Escalation handling, and with it root expansion, now lives in the coordinator's security pipeline (`handleCallTool` in `tool-call-pipeline.ts`, primitives in `roots-expansion.ts`); the relay only bridges `roots/list_changed` to its backends. In the escalation branch:

```typescript
if (evaluation.decision === 'escalate') {
  // T0, before any approval: canonical form of every path argument as
  // evaluated, plus the root each escalated path would need.
  const approvedPaths = captureApprovedPaths({
    args: argsForPolicy,
    annotation,
    escalatedRoles: evaluation.escalatedRoles,
    allowedDirectory,
  });

  // ... whitelist match, auto-approval or human escalation ...

  // T1, after the wait: any path that now resolves differently denies the call.
  if (findChangedApprovedPaths(approvedPaths, allowedDirectory).length > 0) {
    return deny('approved-path-changed');
  }

  // Canonical roots outside the sandbox and the IronCurtain home, not
  // already covered by a root; one roots/list_changed for all of them.
  const directories = selectRootsToAdd({ approvedPaths, existingRoots: state.roots, allowedDirectory });
  await addRootsToClient(state, directories);

  // Read the server's effective roots back; drop the connection on mismatch.
  if (serverExposes('list_allowed_directories')) {
    const verification = await verifyBackendRoots(state.client, state.roots, directories);
    if (verification.status !== 'verified') return dropConnectionAndDeny('roots-verification-failed');
  }
}
```

## Changes to In-Process Mode (TrustedProcess)

The `TrustedProcess` class computes roots in its constructor and passes them through the updated `connect` signature. After escalation approval, it calls `addRoot` before forwarding.

```typescript
// In src/trusted-process/index.ts

import { extractPolicyRoots, toMcpRoots, directoryForPath } from './policy-roots.js';
import type { McpRoot } from './mcp-client-manager.js';

export class TrustedProcess {
  // ... existing fields ...
  private mcpRoots: McpRoot[];

  constructor(
    private config: IronCurtainConfig,
    options?: TrustedProcessOptions,
  ) {
    const { compiledPolicy, toolAnnotations } = loadGeneratedPolicy(config.generatedDir);
    this.policyEngine = new PolicyEngine(
      compiledPolicy,
      toolAnnotations,
      config.protectedPaths,
      config.allowedDirectory,
    );

    const policyRoots = extractPolicyRoots(compiledPolicy, config.allowedDirectory);
    this.mcpRoots = toMcpRoots(policyRoots);

    this.mcpManager = new MCPClientManager();
    this.auditLog = new AuditLog(config.auditLogPath);
    this.escalation = new EscalationHandler();
    this.onEscalation = options?.onEscalation;
  }

  async initialize(): Promise<void> {
    for (const [name, serverConfig] of Object.entries(this.config.mcpServers)) {
      logger.info(`Connecting to MCP server: ${name}...`);
      await this.mcpManager.connect(name, serverConfig, this.mcpRoots);
      logger.info(`Connected to MCP server: ${name}`);
    }
  }

  async handleToolCall(request: ToolCallRequest): Promise<ToolCallResult> {
    // ... existing policy evaluation and escalation handling ...

    // After escalation is approved, expand roots before forwarding:
    if (escalationResult === 'approved') {
      const paths = Object.values(transportRequest.arguments).filter((v): v is string => typeof v === 'string');
      for (const p of paths) {
        const dir = directoryForPath(p);
        await this.mcpManager.addRoot(transportRequest.serverName, {
          uri: `file://${dir}`,
          name: 'escalation-approved',
        });
      }
    }

    // ... existing forwarding logic ...
  }
}
```

## Changes to Configuration

### Keep CLI args unchanged

The filesystem server CLI args continue to include the sandbox directory. This serves as a fallback for MCP servers that do not support the roots protocol. When roots are provided, the filesystem server ignores CLI args entirely, so there is no conflict.

### No changes to `mcp-servers.json` or `loadConfig()`

The static config remains the same. The dynamic roots overlay is computed at runtime from the compiled policy. This keeps the configuration layered: static defaults in JSON, dynamic policy-derived roots computed at startup.

### No changes to `src/sandbox/index.ts`

The proxy computes its own roots from the compiled policy it already loads. No additional env var or data passing is needed.

## Component Flow

### Startup

```
Process startup (proxy or in-process)
    |
    v
loadGeneratedPolicy(generatedDir)
    |
    v
extractPolicyRoots(compiledPolicy, allowedDirectory)
    |  Returns: [{ path: ".../sandbox", name: "sandbox" },
    |            { path: "/home/provos/Downloads", name: "allow-rwd-downloads" },
    |            { path: "/home/provos/Documents", name: "allow-read-documents" }]
    v
toMcpRoots(policyRoots)
    |  Returns: [{ uri: "file:///.../sandbox", name: "sandbox" },
    |            { uri: "file:///home/provos/Downloads", name: "..." },
    |            { uri: "file:///home/provos/Documents", name: "..." }]
    v
Client({ capabilities: { roots: { listChanged: true } } })
client.setRequestHandler(ListRootsRequestSchema, () => ({ roots }))
client.connect(transport)
    |
    v
Filesystem MCP server calls roots/list
    |
    v
Server receives [sandbox, ~/Downloads, ~/Documents]
Server accepts files within any of those directories
```

### Escalation with dynamic root expansion

```
Agent requests read_file({ path: "/etc/hosts" })
    |
    v
PolicyEngine.evaluate() → escalate (catch-all rule), escalatedRoles [read-path]
    |
    v
captureApprovedPaths: "/etc/hosts" (canonical), root candidate "/etc"
    |
    v
Human prompted → approves
    |
    v
findChangedApprovedPaths: "/etc/hosts" still resolves to "/etc/hosts"
    |
    v
selectRootsToAdd → ["/etc"] (canonical directory, not under the sandbox
                   or the IronCurtain home, not covered by a root)
    |
    v
roots.push({ uri: "file:///etc", name: "escalation-approved" })
client.sendRootsListChanged() → server calls roots/list (acknowledged)
    |
    v
Server realpaths every root and replaces its allowed directories
    |
    v
verifyBackendRoots: list_allowed_directories ⊆ intended roots and
                    contains "/etc" → verified
    |
    v
client.callTool("read_file", { path: "/etc/hosts" })
    |
    v
Server accepts (path within /etc root) → returns file content
```

## Defense in Depth

After this change, three layers enforce directory boundaries:

1. **Filesystem MCP server** (roots-based): Rejects requests to paths outside the declared roots. This is the broadest gate. Roots expand over time as escalations are approved.
2. **PolicyEngine structural invariants**: Protected path checks. Auto-allows all paths within the sandbox.
3. **PolicyEngine compiled rules**: Fine-grained per-role decisions (e.g., allow reads in `~/Documents` but deny writes).

### Example: write to ~/Documents (denied)

A request to write to `~/Documents/secret.txt` would:

- Pass the filesystem server (root includes `~/Documents`)
- Pass the structural invariants (not a protected path, not in sandbox)
- Hit compiled rule evaluation: `allow-read-documents` does not match (wrong role: `write-path` not in `["read-path"]`)
- Hit `deny-write-outside-permitted-areas` and be denied

### Example: read outside all permitted areas (escalated, then approved)

A request to read `/etc/hosts` would:

- Policy engine evaluates → `escalate-read-outside-permitted-areas` matches
- Human is prompted and approves
- `/etc/hosts` is re-canonicalized and still resolves to itself
- `/etc` is added as a root; the relay fetches the new list (the acknowledgment) and restarts the confined server under a profile that also exposes `/etc`
- The server's allowed directories are read back and match the approved set
- Call is forwarded to filesystem server, which now accepts paths within `/etc`
- File content returned to agent

## Approved roots: canonical, verified, not agent-writable

`@modelcontextprotocol/server-filesystem` runs on the host under an OS sandbox confined to its roots (see [filesystem-server-confinement.md](filesystem-server-confinement.md)), and its relay restarts it with a profile that exposes a new root when one is added. On every `notifications/roots/list_changed` (and when it starts) the server fetches the root list, runs `fs.realpath` on each root URI and replaces its allowed directories with the result. An approved root is therefore a persistent widening of the server's own containment, and of its OS confinement, and whatever a root URI resolves to at any later refresh becomes allowed. Without the rules below, an agent that can write the workspace could swap an approved directory (or a component of it) for a symlink while the approver decides, and the server would install the symlink target, for example `/` or `$HOME`, as an allowed directory for the rest of the session.

The rules live in `src/trusted-process/roots-expansion.ts` and run in `handleCallTool` (`tool-call-pipeline.ts`):

1. **Only escalated paths.** Root candidates are the values of the path roles in `EvaluationResult.escalatedRoles`. Paths the call carries for other roles never become roots. Without `escalatedRoles`, no root is added.
2. **Canonical at evaluation time.** Each candidate's root is taken from the canonical path the policy engine evaluated (the `argsForPolicy` value, which `prepareToolArgs` already canonicalized), never from a fresh resolution of it: the path itself when it is an existing directory, otherwise its parent. A value that no longer resolves to itself when the approved paths are captured (T0, right after evaluation) yields no root, because an agent shell running concurrently can swap a directory component for a symlink between the policy check and the capture. Relative paths resolve against the sandbox, never the process working directory. Approving `list_directory ~/Downloads` adds `~/Downloads`, not the whole home directory.
3. **Re-checked after the approval wait.** Every path argument of the call is canonicalized again after the wait (T1). If any no longer resolves to the path that was evaluated, the call is denied with rule `approved-path-changed` and no root is added. This closes the swap during the approval wait; it is not a defense against the per-call race between the server's own validation and its use of a path, which the server's OS confinement to its roots handles. If `resolveRealPath` cannot canonicalize anything (it throws `PathResolutionError`) while the approved paths are captured (T0) or re-checked (T1), or while root selection resolves the sandbox and the IronCurtain home, the call is denied and audited with rule `structural-unresolvable-path`, as it is before evaluation, and no root is added.
4. **Never agent-writable.** No root is added at or under the sandbox/workspace or the IronCurtain home (which holds every other agent-writable mount). The sandbox root already covers those paths, and a root there would hand the agent a permanent handle it could redirect at any later refresh.
5. **Covered, existing, stable.** A candidate already inside an existing root (containment, not exact URI match) is skipped. A candidate must be an existing directory whose realpath is itself right before it is sent, and its name must survive the server's normalization (no trailing whitespace or quote, no control characters). URIs are built with `pathToFileURL`, so `#`, `?` and `%` in names cannot truncate or alter the root.
   The server resolves roots with the native realpath(3), which reports the on-disk spelling. `resolveRealPath` uses the native realpath on macOS as well, so IronCurtain's canonical paths normally carry the same spelling; a path canonicalized with the JS `realpathSync`, which keeps the caller's spelling of each component, can still differ from it in case or Unicode normalization on a case-insensitive volume (the macOS default). A root is therefore sent in the server's spelling, the sandbox, IronCurtain-home and covered-root checks compare both spellings, and verification (rule 6) accepts the server spelling of an intended root. A path gets a server spelling only while no component of it is a symlink, so a redirected root never matches.
6. **Verified after the refresh.** All new roots go out in one `roots/list_changed`. When the server exposes `list_allowed_directories`, its effective allowed directories are polled until the new roots appear and must be a subset of the intended canonical set (the client's root list). For a server confined to its roots the relay restarts it instead of notifying it, so the poll gets `CONFINED_ROOTS_VERIFY_TIMEOUT_MS` (30 s) instead of `ROOTS_REFRESH_TIMEOUT_MS` (5 s). A directory outside that set, a timeout, or an unreadable listing fails verification: the pipeline closes the server's client (ending the relay and backend), removes it from the coordinator, and denies the call with rule `roots-verification-failed`. Every later call to that server is refused with `no-client-connection`. A verified refresh has no roots race left, so the one-shot roots-race retry runs only for servers that cannot report their roots.
7. **Roots-race retry for per-file errors.** For servers that cannot be verified, the retry also covers read-only calls whose successful result carries per-file `Access denied - ... outside allowed directories` errors, which `read_multiple_files` reports without `isError`. Calls that may write are never replayed on such text.
8. **Only roots the confinement can expose.** For a server confined to its roots, a candidate that lies in or contains the IronCurtain home or a credential store, that contains the home directory, a temporary directory or the runtime directory, or whose path contains `*`, `?`, `[` or `]` (which srt would read as a pattern), can never be exposed by its OS profile (`rootExposureRefusal` in `roots-confinement.ts`). The approved call is then denied with rule `root-not-exposable`, naming the directory, before any root is sent. Approving a file directly in the home directory, whose root would be `~`, is refused this way.

### Example: read outside all permitted areas (escalated, then denied)

A request to read `/etc/shadow` would:

- Policy engine evaluates → `escalate-read-outside-permitted-areas` matches
- Human is prompted and denies
- No root expansion occurs
- Call is rejected; filesystem server never sees it

## Testing Strategy

### Unit tests for `extractPolicyRoots`

Test the extraction function in isolation with synthetic `CompiledPolicyFile` data.

```typescript
// test/policy-roots.test.ts

describe('extractPolicyRoots', () => {
  it('always includes the sandbox directory as the first root', () => {
    const policy = makePolicyFile([]); // no rules
    const roots = extractPolicyRoots(policy, '/tmp/sandbox');
    expect(roots).toEqual([{ path: '/tmp/sandbox', name: 'sandbox' }]);
  });

  it('extracts directories from allow rules with paths.within', () => {
    const policy = makePolicyFile([
      makeRule({ then: 'allow', paths: { roles: ['read-path'], within: '/home/user/Downloads' } }),
    ]);
    const roots = extractPolicyRoots(policy, '/tmp/sandbox');
    expect(roots).toHaveLength(2);
    expect(roots[1].path).toBe('/home/user/Downloads');
  });

  it('extracts directories from escalate rules with paths.within', () => {
    const policy = makePolicyFile([
      makeRule({ then: 'escalate', paths: { roles: ['read-path'], within: '/home/user/Desktop' } }),
    ]);
    const roots = extractPolicyRoots(policy, '/tmp/sandbox');
    expect(roots).toHaveLength(2);
  });

  it('excludes deny rules', () => {
    const policy = makePolicyFile([
      makeRule({ then: 'deny', paths: { roles: ['delete-path'], within: '/home/user/important' } }),
    ]);
    const roots = extractPolicyRoots(policy, '/tmp/sandbox');
    expect(roots).toHaveLength(1); // sandbox only
  });

  it('excludes catch-all rules without paths.within', () => {
    const policy = makePolicyFile([
      makeRule({ then: 'escalate' }), // no paths condition -- catch-all
    ]);
    const roots = extractPolicyRoots(policy, '/tmp/sandbox');
    expect(roots).toHaveLength(1); // sandbox only
  });

  it('deduplicates directories referenced by multiple rules', () => {
    const policy = makePolicyFile([
      makeRule({ then: 'allow', paths: { roles: ['read-path'], within: '/home/user/Downloads' } }),
      makeRule({ then: 'allow', paths: { roles: ['write-path'], within: '/home/user/Downloads' } }),
    ]);
    const roots = extractPolicyRoots(policy, '/tmp/sandbox');
    expect(roots).toHaveLength(2); // sandbox + Downloads (once)
  });
});
```

### Unit tests for `toMcpRoots`

```typescript
describe('toMcpRoots', () => {
  it('converts paths to file:// URIs', () => {
    const mcpRoots = toMcpRoots([
      { path: '/tmp/sandbox', name: 'sandbox' },
      { path: '/home/user/Downloads', name: 'downloads' },
    ]);
    expect(mcpRoots).toEqual([
      { uri: 'file:///tmp/sandbox', name: 'sandbox' },
      { uri: 'file:///home/user/Downloads', name: 'downloads' },
    ]);
  });
});
```

### Unit tests for `directoryForPath`

```typescript
describe('directoryForPath', () => {
  it('returns dirname for a file path', () => {
    expect(directoryForPath('/etc/hosts')).toBe('/etc');
  });

  it('returns an existing directory itself, not its parent', () => {
    expect(directoryForPath('/home/user/Documents')).toBe('/home/user/Documents');
  });

  it('resolves relative paths against the base directory', () => {
    expect(directoryForPath('relative/file.txt', sandboxDir)).toBe(join(sandboxDir, 'relative'));
  });

  it('never resolves a relative path against the process working directory', () => {
    expect(directoryForPath('relative/file.txt')).toBeUndefined();
  });
});
```

The approved-roots rules are covered by `test/roots-expansion.test.ts` (unit) and `test/roots-toctou.test.ts` (pipeline, with a fake backend that re-resolves roots like server-filesystem and with the real server).

### Unit tests for `MCPClientManager.addRoot`

```typescript
describe('MCPClientManager.addRoot', () => {
  it('deduplicates roots with the same URI', async () => {
    // After connecting with initial roots, adding a duplicate should be a no-op
  });

  it('notifies the server and waits for roots/list before returning', async () => {
    // Verify sendRootsListChanged is called and addRoot blocks
    // until the roots/list handler fires
  });
});
```

### Integration test

A new integration test should verify the end-to-end flow with a real filesystem server. Create two temp directories: one as the sandbox (passed as CLI arg and ALLOWED_DIRECTORY) and one as an "external" directory. Configure a compiled policy that allows reads in the external directory. Verify that `read_file` on a file in the external directory succeeds -- confirming roots were communicated to the server.

A second integration test should verify escalation-triggered root expansion: configure a policy where reads outside permitted areas escalate, approve the escalation, and verify the file read succeeds after root expansion.

## Migration Notes

### Files to modify

| File                                        | Change                                                                                                                                                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/trusted-process/policy-roots.ts`       | **New.** `extractPolicyRoots()`, `toMcpRoots()`, `directoryForPath()`.                                                                                                                         |
| `src/trusted-process/mcp-client-manager.ts` | Add optional `roots` parameter to `connect()`. Declare `roots` capability with `listChanged: true`. Register `roots/list` handler. Add `addRoot()` method with acknowledgment synchronization. |
| `src/trusted-process/mcp-proxy-server.ts`   | Compute roots from own compiled policy. Declare `roots` capability on downstream clients. Expand roots on escalation approval before forwarding.                                               |
| `src/trusted-process/index.ts`              | Compute roots in constructor. Pass to `MCPClientManager.connect()`. Call `addRoot()` after escalation approval.                                                                                |
| `test/policy-roots.test.ts`                 | **New.** Unit tests for extraction, conversion, and directory extraction.                                                                                                                      |

### Files unchanged

| File                                   | Reason                                                                           |
| -------------------------------------- | -------------------------------------------------------------------------------- |
| `src/sandbox/index.ts`                 | Proxy computes its own roots. No env var needed.                                 |
| `src/config/index.ts`                  | No changes to `loadConfig()` or `loadGeneratedPolicy()`.                         |
| `src/config/mcp-servers.json`          | CLI args retained as fallback.                                                   |
| `src/trusted-process/policy-engine.ts` | Evaluation logic unchanged. Roots are a transport concern, not a policy concern. |
| `src/pipeline/*`                       | Compilation pipeline unchanged. No new artifacts.                                |
| `src/config/constitution.md`           | Constitution unchanged.                                                          |

### Migration order

This is a single self-contained change. All modifications can land in one PR. The roots capability is additive -- it does not break existing behavior when the filesystem server does not support roots (the server would simply not call `roots/list`), and when it does support roots, the CLI args become redundant but harmless.

### Risks

- **Filesystem server version.** The `@modelcontextprotocol/server-filesystem` package must support the Roots protocol. If the installed version predates roots support, the server will never call `roots/list` and behavior falls back to CLI args only. This is safe but means the policy-allowed directories outside the sandbox remain unreachable. The version is exact-pinned in `package.json` (the one `tool-annotations.json` describes), so upgrading means changing the pin and re-running `ironcurtain annotate-tools --server filesystem`.
- **Path format on non-POSIX systems.** Root URIs are built with `pathToFileURL`, which also produces the `file:///C:/Users/...` form on Windows; the containment and verification logic assumes POSIX paths and is not exercised on Windows.
- **Escalation root granularity.** When a human approves an escalation for `/etc/hosts`, the entire `/etc` directory becomes a root (for a file at the filesystem root, `/` itself). This is broader than the single file, but the policy engine still controls what operations are allowed within that directory. An approved directory path is its own root, not its parent. The MCP Roots protocol operates at directory level.
- **Root accumulation.** Escalation-approved roots persist for the lifetime of the session. They are not revoked. This is acceptable because each escalation required explicit approval, roots are never added where the agent could redirect them, and the policy engine continues to enforce rules regardless of root state.
- **Unverifiable servers.** Backend verification needs `list_allowed_directories`. Servers without it get the canonical, re-checked roots but no read-back, and keep the one-shot roots-race retry.
- **Server re-resolution.** The server realpaths every root on each refresh. Roots outside agent-writable areas resolve the same way unless something else on the host changes them; any difference is caught at the next verified refresh and drops the connection.
