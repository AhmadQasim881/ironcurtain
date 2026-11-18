# TB0: Execution Containment Design Specification

**Status (2026-11-14):** Implemented (`src/trusted-process/sandbox-integration.ts`): one `srt` process per sandboxed server. Since this design, `sandboxPolicy` (`enforce` by default on Linux and macOS) decides what happens when the sandbox tools are missing or srt cannot start a sandbox on the host (one srt test run per process), the offline tool listings launch servers as their relays do, every sandboxed server gets a read-deny baseline for the IronCurtain home, the credential stores the policy engine protects (all but `~/.netrc`, and of `~/.ssh` only the default-named private keys; see `docs/MISSING_FEATURES.md`) and the shell startup files, and the filesystem server is sandboxed too, confined to its MCP roots (`filesystem-server-confinement.md`).

## Overview

IronCurtain's policy engine operates at the MCP protocol layer: it inspects structured tool-call arguments and makes allow/deny/escalate decisions. This is effective for tools with semantically inspectable arguments (filesystem reads, git operations) but insufficient for exec-like tools where the agent writes code and then runs it. A test runner tool call looks legitimate (`run_tests(path: "/sandbox/repo")`) even when the test file contains `curl` exfiltration or `rm -rf /`.

Execution containment adds a second security layer using `@anthropic-ai/sandbox-runtime` to wrap MCP server processes in OS-level sandboxes. The sandbox restricts what side effects a running process can have: filesystem scope, network access, and process isolation. This is the hard boundary that catches everything the policy engine cannot see -- compromised MCP servers, indirect code execution, symlink race conditions, and network exfiltration.

The integration happens in the MCP proxy server (`mcp-proxy-server.ts`), which is the process that actually spawns real MCP server child processes. Each sandboxed server is spawned via a separate `srt` CLI process with its own settings file, giving each server fully independent sandbox infrastructure (filesystem restrictions, network proxy, and process isolation).

## Key Design Decisions

1. **Sandbox wrapping in the proxy process, not the parent.** The MCP proxy server (`mcp-proxy-server.ts`) is the process that spawns real MCP servers via `StdioClientTransport`. It writes per-server settings files and spawns each sandboxed server via the `srt` CLI. The parent session process does not interact with sandbox-runtime at all. This keeps the security boundary self-contained in the proxy.

2. **Per-server `srt` process for true network isolation.** `SandboxManager` is a singleton per Node.js process — its network proxy infrastructure (HTTP + SOCKS5) is process-wide. Empirical testing confirmed that `customConfig.network` in `wrapWithSandbox()` does NOT provide per-command network isolation. Each sandboxed MCP server therefore gets its own `srt` process with independent proxy infrastructure. This trades memory (~50 MB per `srt` process) for correct per-server network isolation. The proxy process itself never calls `SandboxManager.initialize()` — it only uses the stateless `isSupportedPlatform()` and `checkDependencies()` methods for the availability check.

3. **Sandbox-by-default with explicit opt-out.** When the `sandbox` field is omitted from an MCP server config, the server runs sandboxed with restrictive defaults: write access only to the session sandbox directory, no network. Servers must explicitly set `"sandbox": false` to opt out. This matches the secure-by-default principle: the dangerous state (no sandbox) requires deliberate action.

4. **Shell escaping via `shell-quote` for command string construction.** MCP server configs store `command` and `args` separately (e.g., `"command": "node"`, `"args": ["./servers/exec server.js"]`). Both `wrapWithSandbox()` and the `srt` CLI need a single shell-safe command string. Arguments may contain spaces, shell metacharacters (`$`, `` ` ``, `!`, `*`), or quotes. We use `shell-quote` (already a transitive dependency via `@anthropic-ai/sandbox-runtime`) to join command + args into a properly escaped string. The `srt` CLI also accepts a `-c` flag for pre-escaped command strings, which we use to avoid double-escaping. Before quoting, `wrapServerCommand` makes absolute only the arguments that are clearly relative paths, because a sandboxed server runs with a per-server temp directory as its cwd: ones starting with `./` or `../`, and ones containing `/` or `.` that exist on disk relative to the relay's cwd. Flags, npm specifiers (`@`), URLs (`://`), assignments and version pins (`=`), and dotted or slashed literals that are not on disk (`1.5`, `api.example.com`, `pkg.module`, inline code) pass through unchanged.

   ```typescript
   import { quote } from 'shell-quote';

   // Safe: produces 'node ./servers/exec\ server.js'
   const cmdString = quote([config.command, ...config.args]);

   // Pass to srt with -c to avoid srt's own join-with-spaces behavior
   // srt -s <settings> -c <cmdString>
   ```

   `StdioClientTransport` uses `cross-spawn` with `shell: false`, taking `command` and `args` separately. The integration spawns the `srt` CLI directly: `command = 'srt'`, `args = ['-s', settingsPath, '-c', cmdString]`. This preserves stdio passthrough for MCP's JSON-RPC protocol while letting `srt` handle sandbox setup internally.

5. **Fail closed per server, with a configurable escape hatch.** When sandbox-runtime cannot sandbox a server that asks for it (unsupported platform, bubblewrap, socat or ripgrep missing on Linux, or srt unable to start a sandbox on the host, which one srt test run per process checks), the `sandboxPolicy` setting (`"enforce" | "warn"`) decides, **per server**: `"enforce"` (the default on Linux and macOS) does not start that server, while servers that opt out (`"sandbox": false`) keep running; `"warn"` (the default elsewhere) starts it without OS containment and prints a warning. See [Availability Policy](#availability-policy-sandboxpolicy).

6. **Session sandbox directory auto-mapped to `allowWrite`.** Each session already creates `~/.ironcurtain/sessions/{sessionId}/sandbox/`. The sandbox wrapper automatically includes this directory in `allowWrite` for all sandboxed servers. Additional `allowWrite` paths from the server config are appended. This means zero configuration for the common case while still allowing custom profiles for specialized servers like git.

7. **Sandbox-blocked operations annotated in MCP error responses.** When a sandboxed MCP server attempts an OS operation the sandbox blocks, the server process receives an EPERM error and returns it as an MCP error response. The proxy detects sandbox-characteristic error patterns (EPERM/EACCES after the policy engine allowed the call) and prefixes the error text with `[SANDBOX BLOCKED]` before returning it to the agent. This gives the LLM a clear signal that the operation was blocked by OS-level containment (not a server bug), discouraging retries. The audit log records `sandboxed: true` on the entry for forensic filtering.

## Interface Definitions

### Configuration Schema

```typescript
// src/config/types.ts

/**
 * Network access configuration for a sandboxed MCP server.
 *
 * Invariant: when `allowedDomains` is empty, no network access is permitted.
 * `deniedDomains` takes precedence and is checked first.
 */
export interface SandboxNetworkConfig {
  /** Domains the server may connect to. Supports wildcards (e.g., "*.github.com"). */
  readonly allowedDomains: string[];
  /** Domains explicitly blocked even if they match an allowed pattern. */
  readonly deniedDomains?: string[];
}

/**
 * Filesystem access configuration for a sandboxed MCP server.
 *
 * Invariant: `allowWrite` always includes the session sandbox directory
 * (injected at runtime, not specified here). Paths listed here are
 * *additional* write-allowed directories beyond the sandbox.
 *
 * Reads are allowed by default. Use `denyRead` to block sensitive
 * paths like ~/.ssh or ~/.gnupg.
 */
export interface SandboxFilesystemConfig {
  /** Additional directories the server may write to, beyond the session sandbox. */
  readonly allowWrite?: string[];
  /** Directories the server may not read. */
  readonly denyRead?: string[];
  /** Directories the server may not write to, even within allowed paths. */
  readonly denyWrite?: string[];
}

/**
 * Per-server sandbox configuration.
 *
 * Discriminated on presence/shape:
 * - `false`: server opts out of sandboxing entirely
 * - `object`: server is sandboxed with the specified overrides
 * - `undefined` (omitted): server is sandboxed with restrictive defaults
 *   (session sandbox write-only, no network)
 */
export type ServerSandboxConfig =
  | false
  | {
      /** Filesystem restrictions beyond the automatic session sandbox directory. */
      readonly filesystem?: SandboxFilesystemConfig;
      /**
       * Network access. `false` means no network (default).
       * An object specifies allowed/denied domains.
       */
      readonly network?: false | SandboxNetworkConfig;
    };

export interface MCPServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** OS-level sandbox configuration. Omit for restrictive defaults, `false` to opt out. */
  sandbox?: ServerSandboxConfig;
}

/**
 * Controls behavior when sandbox-runtime cannot sandbox a server that asks
 * for it (unsupported platform, or bubblewrap/socat/ripgrep missing).
 *
 * - "enforce": that server does not start; other servers keep running
 *   (default on Linux and macOS)
 * - "warn": that server starts without OS containment and the session
 *   prints a warning (default elsewhere)
 *
 * Defined in src/config/sandbox-policy.ts with the resolution rules.
 */
export type SandboxAvailabilityPolicy = 'enforce' | 'warn';

export interface IronCurtainConfig {
  auditLogPath: string;
  allowedDirectory: string;
  mcpServers: Record<string, MCPServerConfig>;
  protectedPaths: string[];
  generatedDir: string;
  constitutionPath: string;
  escalationDir?: string;
  sessionLogPath?: string;
  llmLogPath?: string;
  agentModelId: string;
  escalationTimeoutSeconds: number;
  userConfig: ResolvedUserConfig;
  /**
   * Resolved by loadConfig(): IRONCURTAIN_SANDBOX_POLICY / SANDBOX_POLICY
   * env override > `sandboxPolicy` in ~/.ironcurtain/config.json >
   * platform default. Hand-built configs may omit it; readers use
   * effectiveSandboxPolicy(), which falls back to the same resolution.
   */
  sandboxPolicy?: SandboxAvailabilityPolicy;
}
```

### mcp-servers.json Schema Examples

```jsonc
{
  "filesystem": {
    // Exact-pinned runtime dependency; node_modules/ resolves from IronCurtain's
    // package root. Never npx (see "Working Directories" below).
    "command": "node",
    "args": ["node_modules/@modelcontextprotocol/server-filesystem/dist/index.js", "/tmp/ironcurtain-sandbox"],
    // Confined to its MCP roots: home, temp and runtime directories hidden,
    // only the roots exposed; the relay restarts it when the roots change
    // (see filesystem-server-confinement.md)
    "sandbox": {
      "filesystem": { "confineToRoots": true },
      "network": false,
    },
  },
  "exec": {
    "command": "node",
    "args": ["./servers/exec-server.js"],
    // Explicit strict sandbox: no network, write only to session sandbox
    "sandbox": {
      "network": false,
    },
    // filesystem.allowWrite is empty -> only session sandbox dir (auto-injected)
  },
  "git": {
    "command": "node",
    "args": ["./servers/git-server.js"],
    "sandbox": {
      "filesystem": {
        "allowWrite": [".git"], // Relative paths resolved against session sandbox
      },
      "network": {
        "allowedDomains": ["github.com", "*.github.com"],
      },
    },
  },
  "test-runner": {
    "command": "node",
    "args": ["./servers/test-runner.js"],
    // sandbox omitted -> restrictive defaults (sandbox-dir only, no network)
  },
}
```

### Sandbox Integration Module

```typescript
// src/trusted-process/sandbox-integration.ts

import type { MCPServerConfig, ServerSandboxConfig, SandboxAvailabilityPolicy } from '../config/types.js';

/**
 * Result of resolving a server's sandbox configuration.
 * Discriminated union: sandboxed servers carry the resolved config,
 * unsandboxed servers carry the reason they were exempted.
 */
export type ResolvedSandboxConfig =
  | { readonly sandboxed: true; readonly config: ResolvedSandboxParams }
  | { readonly sandboxed: false; readonly reason: 'opt-out' | 'platform-unavailable' };

/**
 * Fully resolved sandbox parameters ready for SandboxManager.wrapWithSandbox().
 * All relative paths have been resolved to absolute paths.
 * The session sandbox directory has been injected into allowWrite.
 */
export interface ResolvedSandboxParams {
  readonly allowWrite: readonly string[];
  readonly denyRead: readonly string[];
  readonly denyWrite: readonly string[];
  readonly network: false | { readonly allowedDomains: readonly string[]; readonly deniedDomains: readonly string[] };
}

/**
 * Resolves the effective sandbox configuration for a single MCP server.
 *
 * Applies defaults when `sandbox` is omitted, injects the session
 * sandbox directory into allowWrite, and resolves relative paths.
 *
 * @param serverConfig - The MCP server configuration from mcp-servers.json
 * @param sessionSandboxDir - Absolute path to the session's sandbox directory
 * @param platformAvailable - Whether sandbox-runtime is available on this platform
 * @param policy - How to handle unavailable sandboxes
 * @returns Resolved configuration indicating whether the server will be sandboxed
 */
export function resolveSandboxConfig(
  serverConfig: MCPServerConfig,
  sessionSandboxDir: string,
  platformAvailable: boolean,
  policy: SandboxAvailabilityPolicy,
): ResolvedSandboxConfig;

/**
 * Transforms a server's spawn parameters (command + args) into a
 * sandbox-wrapped command suitable for StdioClientTransport.
 *
 * For sandboxed servers: writes a per-server srt settings file to a
 * temp directory, shell-escapes command+args via `shell-quote`, and
 * returns `{ command: 'srt', args: ['-s', settingsPath, '-c', escapedCmd] }`.
 *
 * For unsandboxed servers: returns the original command/args unchanged.
 *
 * Shell escaping uses the `quote()` function from `shell-quote`
 * (transitive dependency via @anthropic-ai/sandbox-runtime) to safely
 * handle args containing spaces, shell metacharacters ($, `, !, *),
 * and quotes.
 *
 * @returns New command and args for StdioClientTransport, or the
 *   originals if the server is not sandboxed.
 */
export function wrapServerCommand(
  serverName: string,
  command: string,
  args: readonly string[],
  sandboxConfig: ResolvedSandboxConfig,
  settingsDir: string,
): { command: string; args: string[] };

/**
 * Writes a per-server srt settings JSON file.
 *
 * Each sandboxed server gets its own settings file at
 * `{settingsDir}/{serverName}.srt-settings.json` containing:
 * - network.allowedDomains / deniedDomains
 * - filesystem.allowWrite / denyRead / denyWrite
 *
 * Returns the absolute path to the written file.
 */
export function writeServerSettings(serverName: string, config: ResolvedSandboxParams, settingsDir: string): string;

/**
 * Checks sandbox dependencies and returns a structured result.
 *
 * Wraps SandboxManager.isSupportedPlatform() and checkDependencies()
 * into a single call. Does NOT throw — callers inspect the result and
 * decide based on sandboxPolicy.
 */
export function checkSandboxAvailability(): {
  platformSupported: boolean;
  errors: string[];
  warnings: string[];
};

/**
 * Cleans up per-server settings files created by writeServerSettings().
 * Called during proxy shutdown. Safe to call even if no files were written.
 */
export function cleanupSettingsFiles(settingsDir: string): void;
```

### Audit Entry Extension

```typescript
// Addition to src/types/audit.ts AuditEntry

export interface AuditEntry {
  // ... existing fields ...
  /**
   * true: the server runs inside an OS sandbox. false: it asked for one but
   * runs without it ("warn" with sandbox-runtime unavailable). Absent: the
   * server opted out or the status is unknown. Never true unless the plan
   * found sandboxing available (platform supported AND no dependency errors).
   */
  sandboxed?: boolean;
}
```

## Component Diagram

```
Session Factory (createSession)
  |
  |-- Creates session config with sandboxDir, passes to Sandbox
  |
  v
Sandbox (src/sandbox/index.ts)
  |
  |-- Spawns MCP proxy server as child process via UTCP Code Mode
  |   (cwd = IronCurtain's package root, never the session's own cwd)
  |-- Passes MCP_SERVERS_CONFIG (including sandbox fields) as env var
  |-- Passes ALLOWED_DIRECTORY (session sandbox dir, absolute) as env var
  |
  v
MCP Proxy Server (src/trusted-process/mcp-proxy-server.ts)
  |
  |-- main() startup:
  |   1. Parse MCP_SERVERS_CONFIG from env
  |   2. checkSandboxAvailability() -> { platformSupported, errors, warnings }
  |   3. If enforce + errors: throw fatal (proxy refuses to start)
  |   4. For each server: resolveSandboxConfig(serverConfig, allowedDirectory, ...)
  |   5. For sandboxed servers: writeServerSettings() -> per-server .srt-settings.json
  |      and private cwd <settingsDir>/<server>.cwd
  |      For unsandboxed servers: private cwd
  |      <IronCurtain home>/run/mcp-cwd/relay-XXXX/<server>.cwd
  |   6. For each server: wrapServerCommand() -> { command, args }
  |      (confineToRoots: settings rewritten for the current roots first;
  |      restarted when the roots change, see filesystem-server-confinement.md)
  |   7. new StdioClientTransport({ command, args, env: buildBackendEnv(...), cwd, ... })
  |      (the allowlisted part of the relay's env plus the server's env,
  |      credentials and OAuth variables; see "Environment Variable Passing")
  |
  |-- Policy evaluation (unchanged)
  |-- Tool call forwarding (unchanged)
  |
  |-- shutdown():
  |   1. Close all MCP client connections
  |   2. cleanupSettingsFiles()  // remove per-server settings
  |   3. Close audit log
  |
  v
MCP Servers (filesystem, exec, git, etc.)
  |
  |-- Unsandboxed: spawned directly as today
  |-- Sandboxed: spawned via `srt -s <settings> -c <escaped-cmd>`
      |-- Each srt process has its own SandboxManager + proxy infrastructure
      |-- Filesystem: kernel-enforced allowWrite/denyRead (per-server)
      |-- Network: proxy-filtered allowed domains (per-server, truly isolated)
      |-- Process: namespace isolation (Linux), seccomp-bpf
```

### Data Flow for Sandbox Configuration

```
mcp-servers.json           Session Factory
      |                         |
      v                         v
  MCPServerConfig         sessionSandboxDir
  (with .sandbox field)         |
      |                         |
      +-----------+-------------+
                  |
                  v
        resolveSandboxConfig()
                  |
                  v
        ResolvedSandboxConfig
         /                  \
  sandboxed: true      sandboxed: false
       |                    |
       v                    v
  writeServerSettings()  pass original
       |                 command/args
       v
  {serverName}.srt-settings.json
       |
       v
  wrapServerCommand()
       |
       +-- quote([command, ...args])   // shell-quote escaping
       |
       v
  { command: 'srt', args: ['-s', settingsPath, '-c', escapedCmd] }
       |
       v
  StdioClientTransport({
    command, args,
    env: buildBackendEnv(...),  // inheritedEnv() allowlist + GIT_CEILING_DIRECTORIES + config.env + credentials
    stderr: 'pipe',
    cwd: '<settingsDir>/<server>.cwd'  // unsandboxed: <home>/run/mcp-cwd/relay-XXXX/<server>.cwd
  })
```

## Detailed Integration: MCP Proxy Server Changes

The proxy server (`mcp-proxy-server.ts`) is the primary integration point. Here is the modified server-connection loop (pseudocode showing the structural changes, not a literal diff):

```typescript
import { quote } from 'shell-quote';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Policy from the parent (validated; an invalid value exits non-zero)
const sandboxPolicy = resolveSandboxPolicy(undefined, process.env);

// Phase 1: Check sandbox availability (once for all servers). Available
// means platform supported AND no dependency errors AND srt can start a
// sandbox: the parent's verdict (OS_SANDBOX_AVAILABILITY, its srt smoke run
// included) narrowed by this relay's own dependency check, or without one an
// srt smoke run of the relay's own. Never throws.
const { availability } = await validateSandboxAvailability(sandboxPolicy, sessionLogPath, process.platform, {
  fromParent: parseOsSandboxAvailabilityEnv(process.env.OS_SANDBOX_AVAILABILITY),
  servers: serversConfig,
});

// Phase 2: Apply the policy per server. Under "enforce", a server that needs
// an unavailable sandbox is refused (it gets an ERROR diagnostic and is
// skipped); the other servers in the relay still start.
const { resolvedSandboxConfigs, refusedServers } = resolveServerSandboxConfigs(
  serversConfig,
  allowedDirectory,
  availability,
  sandboxPolicy,
);

// Phase 3: Write per-server srt settings files (a fresh directory inside the
// per-user scratch root <os.tmpdir()>/ironcurtain-<uid>, mode 0700 and
// owner-checked by ensurePrivateScratchRoot(); cleaned up on shutdown) and
// give EVERY server a private working directory: <settingsDir>/<server>.cwd
// for sandboxed servers, <IronCurtain home>/run/mcp-cwd/relay-XXXX/<server>.cwd
// for unsandboxed ones (never below os.tmpdir(); see "Working Directories")
const settingsDir = mkdtempSync(join(ensurePrivateScratchRoot(), 'srt-'));
const scratchDirs = [settingsDir]; // all removed on shutdown
const serverCwdPaths = new Map<string, string>();
let privateRunDir: string | undefined;

for (const [serverName, resolved] of resolvedSandboxConfigs) {
  if (resolved.sandboxed) {
    const { cwdPath } = writeServerSettings(serverName, resolved.config, settingsDir);
    serverCwdPaths.set(serverName, cwdPath);
  } else {
    if (privateRunDir === undefined) {
      privateRunDir = createPrivateRunDir(getIronCurtainHome());
      scratchDirs.push(privateRunDir);
    }
    serverCwdPaths.set(serverName, createServerCwd(privateRunDir, serverName));
  }
}

// Phase 4: Connect to MCP servers, wrapping commands for sandboxed ones
for (const [serverName, config] of Object.entries(serversConfig)) {
  const resolved = resolvedSandboxConfigs.get(serverName)!;
  const { command, args } = wrapServerCommand(serverName, config.command, config.args, resolved, settingsDir);

  const transport = new StdioClientTransport({
    command,
    args,
    // NEVER the relay's full process.env: buildBackendEnv() starts from the
    // allowlist in child-env.ts (the SDK defaults plus the system variables a
    // server needs, the host values this server's own `-e NAME` arguments
    // forward, SSH_AUTH_SOCK for the git backend only) and layers on
    // GIT_CEILING_DIRECTORIES at the private cwd's parent (see "Working
    // Directories"), config.env, credentials, OAuth variables, and for the
    // git backend the hardened git environment, applied last. NODE_OPTIONS,
    // NODE_PATH, LD_*/DYLD_* and the relay's own configuration never reach it.
    env: buildBackendEnv(serverName, config, { sandboxed, serverCredentials, oauthEnv, allowedDirectory, serverCwd }),
    stderr: 'pipe',
    // Never the relay's own cwd, sandboxed or not (see "Working Directories")
    cwd: serverCwd, // serverCwdPaths.get(serverName)
  });

  // ... rest of connection logic unchanged ...
}

// Shutdown addition:
async function shutdown(): Promise<void> {
  for (const state of clientStates.values()) {
    try {
      await state.client.close();
    } catch {
      /* ignore */
    }
  }
  // Each srt process cleans up its own proxy infrastructure when its child exits.
  // We just need to remove our temp settings files and private run directory.
  for (const dir of scratchDirs) cleanupSettingsFiles(dir);
  try {
    await server.close();
  } catch {
    /* ignore */
  }
  await auditLog.close();
  process.exit(0);
}
```

## Per-Server Network Isolation via `srt` CLI

### The Singleton Problem (Empirically Validated)

`SandboxManager` is a module-level singleton. Its network proxy infrastructure (HTTP proxy + SOCKS5) is process-wide: one set of allowed domains. Different servers need different network access (exec: none, git: github.com only).

**We validated empirically** (see `test/sandbox-exploration.ts`) that `customConfig.network` in `wrapWithSandbox()` does NOT provide per-command network isolation:

- Test: `SandboxManager.initialize()` with `allowedDomains: ['example.com']`, then `wrapWithSandbox(curlGithub, undefined, { network: { allowedDomains: [] } })`
- Result: curl to github.com **succeeded** through the proxy (EXIT:0)
- Root cause: The proxy's domain filter is set once at `initialize()` time. `customConfig.network` is ignored — the proxy infrastructure doesn't restart per command.

The union-of-domains approach (previously proposed) was rejected because it is a security compromise: a sandboxed exec server running agent-written code could discover the socat bridge socket and reach domains intended only for the git server. This is exactly the class of attack that sandboxing exists to prevent.

### Solution: Per-Server `srt` Processes

Each sandboxed MCP server is spawned via the `srt` CLI with its own settings file:

```
srt -s /tmp/ironcurtain-1000/srt-XXXX/exec.srt-settings.json -c "node ./servers/exec-server.js"
srt -s /tmp/ironcurtain-1000/srt-XXXX/git.srt-settings.json -c "node ./servers/git-server.js"
```

Each `srt` process:

1. Loads its own `SandboxRuntimeConfig` from the settings file
2. Calls `SandboxManager.initialize()` internally (starts its own HTTP+SOCKS proxies on random ports)
3. Wraps the command with `wrapWithSandbox()` using its config
4. Spawns the sandboxed child with `stdio: 'inherit'` (transparent to MCP JSON-RPC)
5. Cleans up its own proxy infrastructure when the child exits

**Consequence**: An exec server with `network: { allowedDomains: [] }` gets an `srt` process with zero allowed domains. Its socat bridges go nowhere. Even if the sandboxed process discovers the Unix socket, the proxy rejects all connections. The git server's separate `srt` process allows `github.com` on entirely separate proxy ports.

### Memory/Process Overhead

Each `srt` process adds:

- One Node.js process (~30-50 MB RSS)
- One HTTP proxy server on a random localhost port
- One SOCKS5 proxy server on a random localhost port
- Two socat bridge processes (Linux) forwarding Unix sockets

For a typical 2-3 sandboxed server deployment, this is ~100-150 MB additional memory. This is acceptable for a security boundary. Unsandboxed servers (`"sandbox": false`) have zero overhead.

### Per-Server Settings Files

Settings files are written by the proxy at startup into a fresh `srt-XXXX` directory inside the per-user scratch root `<os.tmpdir()>/ironcurtain-<uid>` (`ensurePrivateScratchRoot()` in spawn-cwd.ts: created mode 0700, refused unless it is a directory this user owns that no other user can enter). Every `denyRead` starts with the read-containment baseline (see [Session Sandbox Directory Mapping](#session-sandbox-directory-mapping)), which includes that scratch root (with no opt-out: `resolveSandboxConfig()` refuses an `allowRead`/`allowWrite` entry, glob or session sandbox that would re-open any part of it), so a server never reads another relay's settings, working directories or OAuth access-token files; the session sandbox and the server's own cwd are in both `allowWrite` and `allowRead`:

```json
// /tmp/ironcurtain-1000/srt-XXXX/exec.srt-settings.json (no sandbox config: default own denyRead)
{
  "network": {
    "allowedDomains": [],
    "deniedDomains": []
  },
  "filesystem": {
    "denyRead": [
      "/home/user/.ironcurtain",
      "/tmp/ironcurtain-1000",
      "/home/user/.ssh/id_*",
      "/home/user/.aws",
      "/home/user/.gnupg",
      "/home/user/.config/gcloud",
      "/home/user/.docker/config.json",
      "/home/user/.git-credentials",
      "/home/user/.npmrc",
      "/home/user/.config/gh",
      "/home/user/.kube/config",
      "/home/user/.claude/.credentials.json",
      "/home/user/.codex/auth.json",
      "/home/user/.bashrc",
      "/home/user/.bash_profile",
      "/home/user/.bash_login",
      "/home/user/.profile",
      "/home/user/.zshrc",
      "/home/user/.zshenv",
      "/home/user/.zprofile",
      "/home/user/.config/fish",
      "/home/user/.config/anthropic/credentials",
      "/usr/lib/node_modules/@provos/ironcurtain/.env",
      "/home/user/.ssh"
    ],
    "allowRead": ["/home/user/.ironcurtain/sessions/abc/sandbox", "/tmp/ironcurtain-1000/srt-XXXX/exec.cwd"],
    "allowWrite": ["/home/user/.ironcurtain/sessions/abc/sandbox", "/tmp/ironcurtain-1000/srt-XXXX/exec.cwd"],
    "denyWrite": []
  }
}
```

```json
// /tmp/ironcurtain-1000/srt-XXXX/git.srt-settings.json (own denyRead: ~/.gnupg, ~/.aws)
{
  "network": {
    "allowedDomains": ["github.com", "*.github.com", "gitlab.com", "*.gitlab.com"],
    "deniedDomains": []
  },
  "filesystem": {
    "denyRead": [
      "/home/user/.ironcurtain",
      "/tmp/ironcurtain-1000",
      "/home/user/.ssh/id_*",
      "...the rest of the baseline..."
    ],
    "allowRead": ["/home/user/.ironcurtain/sessions/abc/sandbox", "/tmp/ironcurtain-1000/srt-XXXX/git.cwd"],
    "allowWrite": ["/home/user/.ironcurtain/sessions/abc/sandbox", "/tmp/ironcurtain-1000/srt-XXXX/git.cwd"],
    "denyWrite": []
  }
}
```

Git's own list leaves `~/.ssh` out, so it reads `known_hosts` and `config` but not the private keys (it authenticates through ssh-agent). When `SSH_AUTH_SOCK` is set, git's settings, and no other server's, also carry `network.allowUnixSockets` with the canonical socket path. The generated macOS Seatbelt profile scopes its Unix-socket connection rule to that path; Linux srt ignores the list and blocks creating Unix sockets with seccomp. The relay passes `writeServerSettings(name, params, settingsDir, { sshAgent: isGitBackend(name) })`, the rule that also gives the git backend alone `SSH_AUTH_SOCK` in its environment, and `ironcurtain doctor` does the same. The relay later adds the discovered Node.js installation paths (and, for OAuth servers, the per-session credential directory) to `allowRead` with `rewriteServerSettings()`.

The proxy cleans up this temp directory, and its private run directory under the IronCurtain home, on shutdown. On crash, OS temp cleanup handles the temp directory; a leftover `~/.ironcurtain/run/mcp-cwd/relay-XXXX/` holds only empty working directories (or whatever its backends wrote there) and is safe to delete.

### Working Directories

No relay or backend inherits the working directory IronCurtain was started from. That directory can be agent-writable (`cd project && ironcurtain start -w .`) or an untrusted checkout, and launchers read code and configuration from their cwd: npx resolves `node_modules/.bin` and the project `.npmrc` (e.g. `node-options=--require=<file>`), tsx reads `tsconfig.json` (whose `paths` can redirect imports), git-mcp-server loads `.env`, and git-mcp-server resolves relative tool paths against its cwd while the policy engine resolves them against the allowed directory. `src/trusted-process/spawn-cwd.ts` owns the two trusted choices:

- **Relays and one-shot spawns** run from IronCurtain's package root (`getTrustedSpawnCwd()`): `MCPClientManager.connect()` (every session relay), the pipeline's list-resolution relays, and the tool-listing spawns of `annotate-tools`, compile-policy, `mcp add` and `doctor` for servers that run without srt. Under tsx this makes the project's own `tsconfig.json` the one that applies. Those tool listings start a server that gets an OS sandbox as its relay would (`src/trusted-process/tool-listing-launch.ts`), so that one runs from a private `<server>.cwd` next to its srt settings (below).
- **Backends** spawned by the relay each run in a private, empty `<server>.cwd` directory (`createServerCwd()`, mode 0700), whether sandboxed, opted out with `"sandbox": false`, or running unsandboxed because srt is unavailable under `"warn"`. A server refused under `"enforce"` gets none.

Most of those lookups walk _up_ from the cwd: npm takes the nearest ancestor with a `package.json` or `node_modules` (or a further ancestor whose `package.json` claims it as a workspace) as the project root and uses its `.npmrc` and `node_modules`; tsx uses the nearest `tsconfig.json`; git the nearest repository. So every directory above a backend's cwd must be trusted too, and `os.tmpdir()` is not: on Linux it is usually the world-writable `/tmp`, where any local user (or an agent whose workspace is `/tmp`) can plant those files. Hence:

- **Unsandboxed backends** get their directory inside a fresh `<IronCurtain home>/run/mcp-cwd/relay-XXXX/` (`createPrivateRunDir()`, mode 0700), whose ancestors are the user's own. The IronCurtain home is a protected path, and its agent-writable subdirectories (the managed session, persona, job and workflow-run workspaces that `validateWorkspacePath()` admits) are never ancestors of it.
- **Sandboxed backends** keep theirs next to their srt settings, `<settingsDir>/<server>.cwd`, listed in srt's `allowWrite` and `allowRead`. The settings directory is a fresh `srt-XXXX` inside the per-user scratch root `<os.tmpdir()>/ironcurtain-<uid>` (`ensurePrivateScratchRoot()`: mode 0700, refused unless this user owns it and nobody else can enter it), and that root is in every sandboxed server's `denyRead` baseline. So an OAuth server's access-token file, written next to its settings, is readable by that server alone, not by every other sandboxed server with access to a shared `/tmp`; and what a backend could pick up from `/tmp` above the root runs inside the sandbox.
- **Every backend** gets `GIT_CEILING_DIRECTORIES` set to the directory holding its cwd (`gitCeilingDirectories()`; a ceiling list from the user's shell is not inherited: of the `GIT_*` variables only git's config-file selection is), so git never adopts a repository above it (such as `~/.git` or a versioned `~/.ironcurtain`) for a cwd-relative path that the policy engine resolved against the allowed directory. The git backend's hardened environment (`buildBackendEnv()`) adds its allowed-directory ceiling to this one, never in place of it. A backend whose ceiling cannot be expressed is skipped, like one whose git hardening cannot be built.

Because the relay no longer shares the parent's cwd, every path it receives is absolute. `buildProxySubprocessEnv()`, the list resolver's `buildRelayEnv()` and `applyAllowedDirectoryToMcpArgs()` resolve them against the parent's cwd, the same base the parent's policy engine uses, even where `loadConfig()` and the workspace validators already produce absolute paths, so a caller that sets one some other way cannot give the relay a different directory. The relay exits on a relative `ALLOWED_DIRECTORY` or `IRONCURTAIN_HOME` rather than derive different roots, or create its private directories somewhere other than the parent intended. The filesystem server is the exact-pinned runtime dependency launched as `node <package root>/node_modules/@modelcontextprotocol/server-filesystem/dist/index.js <dir>`, never through npx.

## Lifecycle Management

### Initialization Sequence

```
1. Proxy process starts (spawned by Code Mode)
2. Resolve the policy from IRONCURTAIN_SANDBOX_POLICY / SANDBOX_POLICY
   (validated; default: platform default, "enforce" on Linux/macOS)
3. getOsSandboxAvailability() -> { available, problems, warnings }
4. Log warnings and unavailability to the session log (never fatal)
5. planServerSandboxing() over MCP_SERVERS_CONFIG:
   a. "sandbox": false -> unsandboxed (opt-out)
   b. needs a sandbox, available -> sandboxed
   c. needs a sandbox, unavailable -> refused ("enforce": ERROR diagnostic,
      server skipped) or unconfined ("warn": platform-unavailable)
6. For each server that may start:
   a. its ResolvedSandboxConfig from the plan
7. Create the settings dir: mkdtempSync() inside the per-user scratch root
   (ensurePrivateScratchRoot(): <os.tmpdir()>/ironcurtain-<uid>, mode 0700,
   owner-checked; the relay exits non-zero if it cannot be trusted)
8. For each server that may start: create its private cwd
   a. sandboxed servers: <settingsDir>/<server>.cwd; writeServerSettings()
      also writes the per-server .srt-settings.json and adds the cwd to
      allowWrite and allowRead
   b. unsandboxed servers: <IronCurtain home>/run/mcp-cwd/relay-XXXX/<server>.cwd
      (one createPrivateRunDir() per relay)
   (if a directory cannot be created, everything created so far is removed
   and the relay exits non-zero)
9. For each server:
   a. wrapServerCommand() -> { command, args }
      (sandboxed: command='srt', args=['-s', settingsPath, '-c', escapedCmd])
      (unsandboxed: original command/args)
   b. new StdioClientTransport({ command, args, env: buildBackendEnv(..., serverCwd), cwd })
      (env: the allowlisted part of the relay's environment -- child-env.ts
      inheritedEnv(), with this server's `-e NAME` passthroughs -- plus the
      layers buildBackendEnv() adds, among them the private-cwd
      GIT_CEILING_DIRECTORIES entry, config.env, credentials and OAuth variables)
   c. client.connect(transport)
10. Proxy enters normal MCP server mode
```

Note: The proxy process does NOT call `SandboxManager.initialize()` itself. Each `srt` child process handles its own initialization independently. The proxy only needs `SandboxManager.isSupportedPlatform()` and `checkDependencies()` (which are synchronous, stateless checks).

### Shutdown Sequence

```
1. Proxy receives SIGINT or SIGTERM
2. Close all MCP client connections (existing behavior)
   -> This closes stdio to each srt process
   -> Each srt process sees its child exit and runs its own cleanup
3. cleanupSettingsFiles() — remove the temp settings directory and the
   private run directory (<IronCurtain home>/run/mcp-cwd/relay-XXXX)
4. Close audit log
5. process.exit(0)
```

### Crash Recovery

If the proxy process crashes without calling `cleanupSettingsFiles()`:

- Each `srt` process detects its stdin closing (the pipe from the proxy). The MCP server child exits, `srt` receives the exit event, and runs `SandboxManager.cleanupAfterCommand()` + `process.exit()`. Each `srt` process cleans up its own proxy infrastructure.
- Settings files in `<os.tmpdir()>/ironcurtain-<uid>/srt-XXXX/` are cleaned up by OS temp directory rotation (the per-user root itself is meant to persist; it holds nothing once no relay is running). The unsandboxed backends' `~/.ironcurtain/run/mcp-cwd/relay-XXXX/` is not; it holds only their working directories and can be deleted once no relay is running.
- Sandboxed child processes (the actual MCP servers) are killed when their parent `srt` process dies because the stdio pipe closes.

## Platform Graceful Degradation

### Detection

At proxy startup, check platform support and dependencies before resolving any sandbox configs. `checkDependencies()` returns `{ warnings: string[], errors: string[] }` (not a boolean — errors make sandboxing unavailable, warnings are advisory). `getOsSandboxAvailability()` folds both into `available = platformSupported && errors.length === 0`; the session parent uses the same function, so its audit stamps match what the relay does.

```typescript
// At proxy startup — checked ONCE, result shared across all servers
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';

const platformAvailable = SandboxManager.isSupportedPlatform();
let dependencyErrors: string[] = [];
let dependencyWarnings: string[] = [];

if (platformAvailable) {
  const check = SandboxManager.checkDependencies();
  // sandbox-runtime 0.0.77 on Linux: ripgrep is required, not optional
  dependencyErrors = check.errors; // e.g., ["ripgrep (rg) not found", "bubblewrap (bwrap) not installed", "socat not installed"]
  dependencyWarnings = check.warnings; // e.g., ["seccomp not available - unix socket access not restricted"]
}
```

### Behavior by Policy

Applies to servers that ask for an OS sandbox (`sandbox` omitted or an object; by default filesystem, git and google-workspace). Servers with `"sandbox": false` always start, unsandboxed.

| Platform        | bubblewrap+socat+ripgrep | sandboxPolicy       | Behavior                                                                     |
| --------------- | ------------------------ | ------------------- | ---------------------------------------------------------------------------- |
| Linux           | installed, srt works     | any                 | Sandbox active                                                               |
| Linux           | installed, srt fails     | any                 | As if one were missing (next two rows); the notice names the srt failure     |
| Linux           | any missing              | "enforce" (default) | **Server refused**, other servers start; one-line stderr notice              |
| Linux           | any missing              | "warn"              | Server starts unsandboxed; one-line stderr warning; audit `sandboxed: false` |
| macOS           | n/a                      | any                 | Sandbox active (uses Seatbelt)                                               |
| Windows / other | n/a                      | "enforce"           | **Server refused**, other servers start                                      |
| Windows / other | n/a                      | "warn" (default)    | Server starts unsandboxed with a warning                                     |

### Error Paths for `enforce` Policy

Enforcement is **per server**; an unavailable sandbox never aborts a whole relay or session (a `SandboxConfigError`, see [Session Sandbox Directory Mapping](#session-sandbox-directory-mapping), is a configuration error and does):

1. **Session parent (`src/sandbox/index.ts`).** `resolveSessionOsSandboxPlan()` resolves the availability once (`resolveOsSandboxAvailability()`: the dependency check and, when it passes and a server asks for a sandbox, one srt smoke run per process, so a host where srt cannot start a sandbox is unavailable) and runs `planServerSandboxing()` once (`planSessionOsSandbox()`). Refused servers get no relay subprocess, their tools are never registered (so default-deny applies), and the session continues with the remaining servers. `TrustedProcess` (in-process mode, which never wraps servers) plans with "always unavailable", so it refuses sandbox-requesting servers under "enforce".
2. **Relay (`mcp-proxy-server.ts`).** `resolveServerSandboxConfigs()` returns refused servers instead of throwing; each gets an `ERROR:` diagnostic (stderr + session log) naming the missing tools and both remedies, and is skipped. With zero servers left, `proxyCanServe` exits the relay non-zero.
3. **`resolveSandboxConfig()`** still throws `SandboxUnavailableError` (`code: 'SANDBOX_UNAVAILABLE'`) for enforce + unavailable as defense in depth; the planners never reach it.

**The key invariant**: a server that asks for an OS sandbox either runs inside one or does not start, unless the operator chose `"warn"`. When the parent found sandboxing available it hands relays `"enforce"` regardless of the session policy, so a relay that finds it unavailable refuses the server instead of running it unconfined under a `sandboxed: true` audit stamp. Every relay also receives the availability the parent planned with (`OS_SANDBOX_AVAILABILITY`, a relay-internal variable) and narrows it with its own dependency check without running srt again, so on a host where srt cannot start a sandbox a `"warn"` relay runs the server unconfined, as the parent's plan and its `sandboxed: false` stamp say, instead of wrapping it in an srt that fails.

### Warning Format

At session start the parent prints one line to stderr (written to the stream directly, because the session logger swallows `console.*`) and logs it to the session log. Examples:

```
IronCurtain: OS sandbox unavailable (ripgrep (rg) not found); not starting MCP server(s) that require it: git, google-workspace (sandboxPolicy "enforce"). To fix, install bubblewrap, socat and ripgrep (e.g. `sudo apt-get install -y bubblewrap socat ripgrep`), or set sandboxPolicy to "warn" (`ironcurtain config` > Security, or IRONCURTAIN_SANDBOX_POLICY=warn) to run them without OS containment.

IronCurtain: WARNING: OS sandbox unavailable (ripgrep (rg) not found); MCP server(s) running WITHOUT OS containment: git, google-workspace (sandboxPolicy "warn"). To fix, install bubblewrap, socat and ripgrep (e.g. `sudo apt-get install -y bubblewrap socat ripgrep`), or run `ironcurtain doctor`.
```

The install command is suggested only when sandbox-runtime reports a missing or unusable bubblewrap, socat or ripgrep (`isOsSandboxFixableByInstall()`). Other problems carry their own remedy or point at `ironcurtain doctor`: an unsupported platform, Windows' `srt-win`, or bubblewrap refusing a user namespace when running as root without CAP_SETFCAP. The doctor check and the first-start wizard apply the same rule.

In PTY sessions the line lands in the terminal (mux and the web UI). Web-UI PTY sessions also carry it as `SessionDto.osSandboxWarning`, computed by the daemon when the session is created.

## Availability Policy (`sandboxPolicy`)

`src/config/sandbox-policy.ts` holds the definition. Resolution, applied once by `loadUserConfig()`:

1. `IRONCURTAIN_SANDBOX_POLICY`, then `SANDBOX_POLICY` (trimmed, case-insensitive; any value other than `enforce`/`warn` is an error, not a silent fallback);
2. `sandboxPolicy` in `~/.ironcurtain/config.json` (validated by the Zod schema; not backfilled, so the platform default is not frozen into the file);
3. the platform default: `"enforce"` on Linux and macOS, `"warn"` elsewhere.

`loadConfig()` copies the result to `IronCurtainConfig.sandboxPolicy`. Users change it with `ironcurtain config` > Security > OS sandbox policy, which edits the value saved in config.json (`loadSavedSandboxPolicy()`) and names an active environment override, so the value an override currently forces can still be saved; the first-start wizard checks availability as a session does and offers `"warn"` (default answer: keep `"enforce"`) when the sandbox is unavailable. Availability means the platform is supported, no dependency is missing and srt can start a sandbox: the dependency check alone cannot prove that bubblewrap and seccomp work on the host (AppArmor-restricted user namespaces, a seccomp helper the host will not run), so session start, the list resolver, the first-start wizard and the offline tool listings run an srt smoke test (`true` inside a restrictive sandbox, wrapped exactly like an MCP server, with the relays' allowlisted environment) when the dependencies pass and a server asks for a sandbox (`resolveOsSandboxAvailability()`). It runs once per process (`runOsSandboxSmokeTestOnce()`: a pass is kept, a failure is re-checked after five minutes, so a long-running daemon notices a fixed host), and a failure makes the sandbox unavailable with the srt output as the problem. A run that has not finished after 20 seconds is a failure too, even though srt then exits 0: it forwards the deadline's SIGTERM to its command and treats a command ended that way as a clean stop (`runSmokeCommand()`). `ironcurtain doctor` has an **OS sandbox** check: it lists what sandbox-runtime reports missing (bubblewrap, socat, ripgrep, or an unsupported platform) or, with the dependencies present, runs the smoke test afresh and reports its failure the same way; it fails under `"enforce"` and warns under `"warn"` when servers that need a sandbox exist. Servers the check refuses are skipped by the liveness probes. The liveness probes start every other server the way its relay does, through the launcher they share with the pipeline's tool discovery (`src/trusted-process/tool-listing-launch.ts`, used by `src/doctor/mcp-liveness.ts` and by `src/pipeline/live-tools.ts` for `annotate-tools`, compile-policy's drift check and `mcp add`, which point the filesystem server at an empty temporary directory and never start an OAuth-backed server): the same `planServerSandboxing()` plan, srt settings from `writeServerSettings()` plus the Node.js read paths, `wrapServerCommand()` with relative arguments resolved against the package root (the relay's cwd; doctor itself runs wherever the user started it, so it passes `argsBaseDir`), the confined launch for a server confined to its roots, and the relay's `buildBackendEnv()`, so a sandbox that cannot start a server is reported for that server instead of only in a session log. The settings and the sandboxed servers' working directories live in a fresh `doctor-XXXX` directory below the per-user scratch root, removed when the run ends; doctor writes nothing in the IronCurtain home, and when the configured allowed directory does not exist yet it probes the filesystem server against a temporary empty directory instead of creating it. A server whose container image is not pulled, or cannot be told from its `run` arguments, or whose pinned npx package is not in the npx cache is skipped rather than given time to download it, an unpinned npx package is never started, and a server backed by an IronCurtain OAuth provider is not started (a session hands it a fresh access token and its own npm cache). Local servers get 10 s for connect plus `tools/list`; container and npx servers get 30 s. A failure's stderr is quoted with the server's stored credentials and the host values its `-e NAME` arguments forward blanked.

## Session Sandbox Directory Mapping

Each session creates `~/.ironcurtain/sessions/{sessionId}/sandbox/` as the `ALLOWED_DIRECTORY`. This maps to sandbox-runtime as follows:

```typescript
function resolveSandboxConfig(
  serverConfig: MCPServerConfig,
  sessionSandboxDir: string,
  // ...
): ResolvedSandboxConfig {
  if (serverConfig.sandbox === false) {
    return { sandboxed: false, reason: 'opt-out' };
  }

  const sandboxConfig = serverConfig.sandbox ?? {};
  const fsConfig = sandboxConfig.filesystem ?? {};

  // Configured paths; relative ones resolve against the session sandbox.
  // An entry that would re-expose the IronCurtain home throws.
  const configuredAllowWrite = (fsConfig.allowWrite ?? []).map((p) => resolve(sessionSandboxDir, p));
  const configuredAllowRead = (fsConfig.allowRead ?? []).map((p) => resolve(sessionSandboxDir, expandTilde(p)));

  // Session sandbox dir is always writable, and readable for macOS; also
  // spelled under its canonical parent when a symlink is on the way to it
  const sandboxSpellings = sessionSandboxSpellings(sessionSandboxDir);
  const allowWrite = unique([...sandboxSpellings, ...configuredAllowWrite]);
  const allowRead = unique([...sandboxSpellings, ...configuredAllowRead]);

  // Baseline (IronCurtain home + credential stores) unioned with the
  // server's own list, never replaced by it; each entry also canonical
  const denyRead = buildDenyRead(fsConfig.denyRead ?? DEFAULT_DENY_READ, configuredAllowRead, homeSpellings);

  // ... resolve denyWrite, network ...

  return {
    sandboxed: true,
    config: { allowWrite, allowRead, denyRead, denyWrite, network },
  };
}
```

Key behaviors:

- Relative paths in `allowWrite` and `allowRead` are resolved against the session sandbox directory; absolute paths are normalized (for cases like `/tmp`).
- The session sandbox directory itself is always included in `allowWrite` and `allowRead`, even if both are empty.
- `denyRead` always starts with a baseline: the IronCurtain home (the absolute `getIronCurtainHome()`, so `IRONCURTAIN_HOME` is honoured) and the entries below (`BASELINE_CREDENTIAL_DENY_READ`, plus the files `credentialStorePaths()` locates at runtime):
  - Every extended credential store the policy engine protects (`EXTENDED_CREDENTIAL_STORE_IDS` in `src/config/credential-stores.ts`, at the locations `extendedCredentialStoreHomePaths()` gives), so a store added there is hidden from sandboxed servers too: `~/.aws`, `~/.gnupg`, `~/.config/gcloud`, `~/.docker/config.json`, `~/.git-credentials`, `~/.npmrc`, `~/.config/gh` and `~/.kube/config`. Two exceptions: for `ssh` only the private keys `~/.ssh/id_*`, and `~/.netrc` not at all (git over HTTPS may authenticate with it, and the built-in git server's `allowRead` cannot be adjusted; see `docs/MISSING_FEATURES.md`).
  - The default locations of the OAuth credential files IronCurtain itself reads, `~/.claude/.credentials.json` and `~/.codex/auth.json`, plus `$CODEX_HOME/auth.json` and every Anthropic CLI credentials-directory candidate: `$ANTHROPIC_CONFIG_DIR/credentials`, `$XDG_CONFIG_HOME/anthropic/credentials`, and `~/.config/anthropic/credentials`, where configured. Moving a store leaves the default candidate protected too.
  - Every `credentialProtection.extraPaths` entry, expanded to an absolute path, and each trusted environment-file path, including an explicit `IRONCURTAIN_ENV_FILE`. Computing this list reads paths only, without opening the credential or environment files.
  - The shell startup files where API keys are commonly exported: `~/.bashrc`, `~/.bash_profile`, `~/.bash_login`, `~/.profile`, `~/.zshrc`, `~/.zshenv`, `~/.zprofile`, and all of `~/.config/fish` (its `fish_variables` holds `set -Ux` exports). srt runs a server's command with a non-login, non-interactive `bash -c`, which reads none of them.
  - A `.env` in IronCurtain's package root (`getTrustedSpawnCwd()`, the relays' working directory), where a source checkout kept its API keys before they moved to the IronCurtain home.

  The server's own `denyRead` (default `~/.ssh`, `~/.gnupg`, `~/.aws`) is unioned with it.

- Every absolute deny entry is followed by its canonical (symlink-resolved) path when that differs; for a glob, the canonical form of its static base directory. Seatbelt matches the kernel's canonical path and srt keeps a symlinked spelling it judges to leave its own tree (a symlinked IronCurtain home, a dotfile manager's `~/.npmrc -> ~/dotfiles/npmrc`), so on macOS a deny naming only the link would match nothing. Linux srt resolves deny paths itself, so there the extra spelling changes nothing.
- For the same reason the session sandbox is also passed as its canonical parent directory joined with its own name when a symlink sits on the way to it (`/home -> /var/home`, a symlinked IronCurtain home). Without that, macOS would hide the sandbox under the canonical home deny, and Linux srt refuses to bind the linked spelling writable. The last component is deliberately not resolved, so a sandbox directory that is itself a link stays subject to srt's own link check.
- A server opts out of one credential-store entry by naming it exactly in its own `allowRead` (e.g. `"~/.aws"` for an AWS server, `"~/.bashrc"`, or the absolute path for the IronCurtain-read files and the package-root `.env`); both spellings of the entry are then dropped. A partial carve-out such as `"~/.aws/config"` keeps the entry and re-allows only that path, by srt's allow-within-deny rule.
- The IronCurtain home has no opt-out. `resolveSandboxConfig` throws `SandboxConfigError` (`code: 'SANDBOX_CONFIG_INVALID'`) for an `allowRead`/`allowWrite` entry whose path or canonical (symlink-resolved) path is the home or inside it, or a glob that could match inside it, unless the entry lies inside a session sandbox that itself sits in the home. An entry that merely contains the home is accepted: srt keeps the nested deny on both platforms. A session sandbox directory that is the home itself is refused. `planServerSandboxing()` resolves every server that gets a sandbox this way, naming it in the error, in the session parent and in each relay alike: such a config stops the session before any relay is spawned (the pipeline's list resolver fails the same way, and a relay handed one exits non-zero). Unlike a server refused for an unavailable sandbox, it is not skipped per server. A server that gets no sandbox (refused under `"enforce"`, or unconfined under `"warn"`) never has srt settings, so its paths are not checked; `ironcurtain doctor`, which plans only in that case, reports rather than throws.

- A server whose config sets `filesystem.confineToRoots` (the filesystem server) also gets the user's home directory, `os.tmpdir()`, `/tmp`, `/var/tmp` and `$XDG_RUNTIME_DIR` in `denyRead` (`confinementHiddenRegions()`); its resolved config carries `confineToRoots: true`. The relay adds the server's MCP roots (`allowRead` and `allowWrite`) and the paths its program needs (`allowRead`) each time it launches it, and restarts it when the roots change. See [filesystem-server-confinement.md](filesystem-server-confinement.md).

Why the session sandbox must also be in `allowRead`: on Linux srt mounts a tmpfs over each read-denied directory and then re-binds the `allowWrite` and `allowRead` paths beneath it, but on macOS Seatbelt re-allows reads inside a denied region only through `allowRead` (`file-write*` does not imply `file-read*`). The same applies to the per-server cwd (`writeServerSettings`) and the discovered Node.js installation paths (added for every sandboxed server by the relay; `discoverNodePaths()` never returns a path inside the IronCurtain home).

## Error Handling: Sandbox-Blocked Operations

### The Disagreement Problem

The policy engine and sandbox can disagree:

- Policy allows `read_file("/home/user/.bashrc")` (not a protected path)
- Sandbox blocks it (`.bashrc` is in the read-containment baseline)

The MCP server process receives `EPERM` from the kernel. It returns an MCP error response. The proxy logs this as a normal tool-call error.

### Detection and Annotation

After a tool call that the policy engine allowed but the MCP server returned an error, the proxy checks if the error pattern suggests a sandbox block and annotates the response:

```typescript
function annotateSandboxViolation(policyDecision: 'allow', errorMessage: string, serverSandboxed: boolean): string {
  if (!serverSandboxed) return errorMessage;
  // Common patterns from sandbox-blocked operations
  const isSandboxBlock = /EACCES|EPERM|Operation not permitted|Permission denied/i.test(errorMessage);
  if (!isSandboxBlock) return errorMessage;
  return `[SANDBOX BLOCKED] ${errorMessage}`;
}
```

The `[SANDBOX BLOCKED]` prefix serves two purposes:

1. **For the LLM**: a clear signal that this is OS-level containment, not a server bug — discourages retrying the same operation.
2. **For the operator**: visible in the audit log and session log without needing a separate diagnostic event or IPC mechanism.

This is a heuristic, not definitive (a legitimate EPERM unrelated to sandboxing would also be annotated). The audit log records `sandboxed: true` on the entry so operators can filter precisely.

No `DiagnosticEvent` crosses the process boundary. The proxy communicates only through MCP JSON-RPC responses, and the annotation travels through the normal error path.

### No Automatic Retry or Override

When the sandbox blocks an operation, we do **not** retry without the sandbox or automatically widen permissions. The sandbox is the hard boundary. If the policy engine and sandbox disagree, the sandbox wins and the operator must adjust configuration.

## Environment Variable Passing

### Proxy-Level Env Vars

The proxy receives its configuration via environment variables (set by `src/sandbox/index.ts`). New env vars for sandbox support:

```typescript
// In src/sandbox/index.ts buildProxySubprocessEnv(): the session's resolved
// policy under both names, so the relay's own resolution cannot pick up a
// different inherited value; "enforce" when the parent found sandboxing
// available (see the key invariant above).
...sandboxPolicyEnv(plan.availability.available ? 'enforce' : plan.policy),
// MCP_SERVERS_CONFIG is added per relay by buildServerRelayEnv() and holds
// that relay's server config only, sandbox fields included
```

The offline list resolver (`src/pipeline/proxy-mcp-connections.ts`) applies the same plan to the servers its data-backed lists name: it drops refused servers before spawning any relay (it spawns one per server), prints the same notice, and passes the user's resolved policy to each relay under both names.

The `sandbox` field on each server config is already part of `MCP_SERVERS_CONFIG` (the JSON-serialized config of the one server the relay runs). No additional env var is needed for per-server sandbox config. A relay never receives another server's configuration or credentials: `buildProxySubprocessEnv()` builds the block shared by every relay of a session, and `buildServerRelayEnv()` adds `MCP_SERVERS_CONFIG` (that server only), `SERVER_FILTER`, `SERVER_CREDENTIALS` (that server's stored credentials only) and the host values that server's `-e NAME` arguments forward.

### MCP Server Spawn Env: Allowlisted, Never the Host Environment

The host process holds the user's whole environment: provider API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, ...), cloud credentials, other servers' tokens. Relays used to be spawned with `{ ...process.env, ...config.env }` and spawned their backends the same way, so every backend -- third-party npm packages fetched with npx, the git server that runs host git against an agent-writable repository, the Docker CLI -- received all of it, plus the relay-internal variables (every server's configuration in `MCP_SERVERS_CONFIG`, `SESSION_LOG_PATH`, `MITM_CONTROL_ADDR`).

**Rule**: no child inherits the host environment. `src/trusted-process/child-env.ts` is the single place that decides what a child may inherit, and every spawn site uses it:

- `MCPClientManager.connect()` (session relays; real backends in the in-process `TrustedProcess`), the list resolver's `buildRelayEnv()`, the relay's `buildBackendEnv()` (which the doctor's liveness probe also uses) and `annotate-tools` spawn with `inheritedEnv()` / `mcpServerSpawnEnv()`: the MCP SDK's default set (`HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER`), locale and time zone (`LANG`, `LANGUAGE`, `LC_*`, `TZ`), the temporary directory (`TMPDIR`, `TMP`, `TEMP`), the XDG base directories, proxy and trust-anchor settings (`HTTP(S)_PROXY`, `NO_PROXY`, `ALL_PROXY`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`), `npm_config_*` (minus registry credentials, secrets, the TLS `key` and `node-options`), Docker CLI connection settings (`DOCKER_HOST`, `DOCKER_CONFIG`, `DOCKER_CONTEXT`, `DOCKER_CERT_PATH`, `DOCKER_TLS_VERIFY`), git's config-file selection (`GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_NOSYSTEM`: the policy engine resolves where a git remote connects from those files, so the git a backend runs must read the same ones; no other `GIT_*` variable is inherited), Node.js version-manager roots (`NVM_DIR`, `VOLTA_HOME`, `ASDF_DIR`, `ASDF_DATA_DIR`, `FNM_DIR`, `FNM_MULTISHELL_PATH`), `IRONCURTAIN_HOME`, `IRONCURTAIN_CONTAINER_RUNTIME` and `TSX_*`; plus, per server, the host values its own docker-style `-e NAME` arguments forward (`GITHUB_PERSONAL_ACCESS_TOKEN` for the shipped github server, so a token exported in the shell still reaches exactly the server that declares it) and, for the git backend only, `SSH_AUTH_SOCK`. On top come the server's own `env` block, its stored credentials (`serverCredentials`, carried to its relay in `SERVER_CREDENTIALS`) and the OAuth variables the relay prepares.
- `NODE_OPTIONS`, `NODE_PATH`, `LD_*` and `DYLD_*` are never inherited, not even when a `-e` argument names them, and a `-e` argument cannot forward the relay's own configuration (`RELAY_INTERNAL_ENV_NAMES`) or replace a value the relay is configured with; exported shell functions are dropped as the SDK drops them.
- A server's `-e NAME` variable counts as present -- so the server is started rather than skipped -- when it has a value in the spawning process's environment, the server's `env` block or its stored credentials (`isEnvVarProvided()`, used by `missingPassthroughEnvVars()`), the same rule `ironcurtain doctor` applies. The relay and the in-process `TrustedProcess` both inject the credentials they accept.
- IronCurtain's own interactive child, `ironcurtain start --pty` under the mux and the web UI, runs at the parent's trust level and reads the user's credentials from the environment, so it gets the host environment minus the code-injection and relay-internal variables (`ironcurtainSubprocessEnv()`). The preflight `isolated-vm` check gets the bare allowlist.

What the `srt` CLI process needs is covered: `PATH` (to locate `bwrap`, `socat` and the server binary), `HOME`, `TMPDIR`, the proxy variables and the Node.js installation paths. sandbox-runtime embeds its own proxy variables into the bwrap command string, so the sandboxed server never depends on inheriting them. The relay is itself spawned through the same allowlist, so its own environment is the first of two filters between the host and a third-party server. Its explicit block (`buildProxySubprocessEnv()`, the list resolver's `buildRelayEnv()`) adds the host settings it reads for itself and never passes on (`relayHostSettings()`): `ANTHROPIC_CONFIG_DIR` and `CODEX_HOME`. It also passes a bounded, path-only `SANDBOX_CREDENTIAL_PATHS` array computed from the trusted configuration. The relay rejects malformed metadata before starting a backend, and the reserved name is excluded from backend environments and trusted credential-file keys. Session planning, relays, pipeline tool discovery, list resolution and doctor liveness probes all carry the same configured path additions into the read-deny baseline. The memory server's LLM key travels through `SERVER_CREDENTIALS` rather than its server config, and so never appears in `MCP_SERVERS_CONFIG` or session metadata.

## Extension Points

### Custom Sandbox Profiles

The `ServerSandboxConfig` type is an object with optional `filesystem` and `network` fields. New restriction types (e.g., process limits, IPC restrictions) can be added as optional fields without breaking existing configs.

### Runtime Sandbox Expansion

Sandbox restrictions are fixed for the lifetime of a server process: sandbox-runtime cannot update the profile of a child that is already wrapped. A server confined to its MCP roots (`sandbox.filesystem.confineToRoots`, the filesystem server) is therefore restarted by its relay with a new profile whenever the directories its roots expose change, for example after an approved escalation adds a root. See [filesystem-server-confinement.md](filesystem-server-confinement.md). Other sandboxed servers keep a static profile.

### Per-Server Network Isolation — IMPLEMENTED

Per-server network isolation is the current design (not a future extension). Each sandboxed MCP server runs in its own `srt` process with independent proxy infrastructure. See "Per-Server Network Isolation via `srt` CLI" section above.

If sandbox-runtime later adds per-command network restriction to `customConfig` (eliminating the need for separate processes), `wrapServerCommand()` can be updated to use the library API directly instead of the `srt` CLI. The abstraction boundary (returning command/args) hides this implementation detail from the proxy code.

### Violation Monitoring

sandbox-runtime exposes `SandboxViolationStore` for collecting violation events. A future extension could pipe these into the audit log for richer forensics. The current design captures violations indirectly through MCP error responses.

## Testing Strategy

### Unit Tests: Configuration Resolution

Test `resolveSandboxConfig()` in isolation:

```typescript
// test/sandbox-integration.test.ts

describe('resolveSandboxConfig', () => {
  it('returns opt-out for sandbox: false', () => {
    const result = resolveSandboxConfig(
      { command: 'npx', args: ['server'], sandbox: false },
      '/sessions/abc/sandbox',
      true,
      'warn',
    );
    expect(result).toEqual({ sandboxed: false, reason: 'opt-out' });
  });

  it('applies restrictive defaults when sandbox is omitted', () => {
    const result = resolveSandboxConfig(
      { command: 'node', args: ['server.js'] },
      '/sessions/abc/sandbox',
      true,
      'warn',
    );
    expect(result.sandboxed).toBe(true);
    if (result.sandboxed) {
      expect(result.config.allowWrite).toContain('/sessions/abc/sandbox');
      expect(result.config.network).toBe(false);
    }
  });

  it('resolves relative allowWrite paths against session sandbox', () => {
    const result = resolveSandboxConfig(
      { command: 'node', args: ['server.js'], sandbox: { filesystem: { allowWrite: ['.git'] } } },
      '/sessions/abc/sandbox',
      true,
      'warn',
    );
    if (result.sandboxed) {
      expect(result.config.allowWrite).toContain('/sessions/abc/sandbox/.git');
    }
  });

  it('degrades gracefully when platform unavailable and policy is warn', () => {
    const result = resolveSandboxConfig(
      { command: 'node', args: ['server.js'] },
      '/sessions/abc/sandbox',
      false,
      'warn',
    );
    expect(result).toEqual({ sandboxed: false, reason: 'platform-unavailable' });
  });

  it('throws when platform unavailable and policy is enforce', () => {
    expect(() =>
      resolveSandboxConfig({ command: 'node', args: ['server.js'] }, '/sessions/abc/sandbox', false, 'enforce'),
    ).toThrow();
  });
});
```

### Unit Tests: Settings File Writing

```typescript
describe('writeServerSettings', () => {
  it('writes valid SandboxRuntimeConfig JSON', () => {
    const settingsDir = mkdtempSync(join(tmpdir(), 'test-srt-'));
    const path = writeServerSettings(
      'exec',
      {
        allowWrite: ['/sandbox'],
        denyRead: ['~/.ssh'],
        denyWrite: [],
        network: false,
      },
      settingsDir,
    );

    const content = JSON.parse(readFileSync(path, 'utf-8'));
    expect(content.network.allowedDomains).toEqual([]);
    expect(content.filesystem.allowWrite).toContain('/sandbox');
    expect(content.filesystem.denyRead).toContain('~/.ssh');
    rmSync(settingsDir, { recursive: true });
  });

  it('maps network: false to empty allowedDomains', () => {
    // ...
  });

  it('passes through allowedDomains/deniedDomains for network configs', () => {
    // ...
  });
});
```

### Unit Tests: Command Wrapping and Shell Escaping

```typescript
describe('wrapServerCommand', () => {
  it('passes through unsandboxed servers', () => {
    const result = wrapServerCommand(
      'exec',
      'npx',
      ['server'],
      { sandboxed: false, reason: 'opt-out' },
      '/tmp/settings',
    );
    expect(result).toEqual({ command: 'npx', args: ['server'] });
  });

  it('wraps sandboxed servers with srt -s -c', () => {
    const result = wrapServerCommand(
      'exec',
      'node',
      ['server.js'],
      { sandboxed: true, config: { allowWrite: ['/sandbox'], denyRead: [], denyWrite: [], network: false } },
      '/tmp/settings',
    );
    expect(result.command).toBe('srt');
    expect(result.args[0]).toBe('-s');
    expect(result.args[1]).toBe('/tmp/settings/exec.srt-settings.json');
    expect(result.args[2]).toBe('-c');
    expect(result.args[3]).toContain('server.js');
  });

  it('shell-escapes args with spaces', () => {
    const result = wrapServerCommand(
      'exec',
      'node',
      ['./servers/exec server.js', '--flag=value with spaces'],
      { sandboxed: true, config: { allowWrite: ['/sandbox'], denyRead: [], denyWrite: [], network: false } },
      '/tmp/settings',
    );
    // The -c argument should be a properly escaped shell string
    const cmdString = result.args[3];
    expect(cmdString).toContain("'./servers/exec server.js'");
    expect(cmdString).toContain("'--flag=value with spaces'");
  });

  it('shell-escapes args with shell metacharacters', () => {
    const result = wrapServerCommand(
      'exec',
      'node',
      ['--pattern=$HOME/*.txt'],
      { sandboxed: true, config: { allowWrite: ['/sandbox'], denyRead: [], denyWrite: [], network: false } },
      '/tmp/settings',
    );
    const cmdString = result.args[3];
    // shell-quote should escape the $ and * to prevent shell expansion
    expect(cmdString).not.toContain('$HOME'); // should be escaped
  });
});
```

### Integration Tests

Integration tests for sandbox wrapping require a Linux system with bubblewrap installed. These tests should:

1. Be gated behind a `SANDBOX_INTEGRATION` environment variable or vitest tag
2. Spawn a minimal MCP server inside a sandbox wrapper
3. Verify that:
   - Stdio communication (JSON-RPC) works through the sandbox
   - File writes outside `allowWrite` fail
   - Network access fails when `network: false`
   - Reads of `denyRead` paths fail
4. Verify graceful degradation:
   - On platforms without bubblewrap, tests with `sandboxPolicy: 'warn'` succeed without sandbox
   - On platforms without bubblewrap, tests with `sandboxPolicy: 'enforce'` fail cleanly

```typescript
// test/sandbox-integration.test.ts (gated)
describe.skipIf(!process.env.SANDBOX_INTEGRATION)('sandbox integration', () => {
  it('blocks writes outside allowed directory', async () => {
    // Start a minimal echo MCP server inside sandbox
    // Attempt write_file to /tmp/outside -> EPERM
  });

  it('blocks network when configured', async () => {
    // Start a server that attempts fetch -> connection refused
  });

  it('passes stdio through for MCP JSON-RPC', async () => {
    // Full tool call roundtrip through sandboxed server
  });
});
```

## Migration Notes

### Phase 1: Add sandbox-integration module and types (no behavioral change)

1. Add `SandboxNetworkConfig`, `SandboxFilesystemConfig`, `ServerSandboxConfig`, and `SandboxAvailabilityPolicy` to `src/config/types.ts`.
2. Create `src/trusted-process/sandbox-integration.ts` with `resolveSandboxConfig()`, `writeServerSettings()`, `wrapServerCommand()`, `checkSandboxAvailability()`, `cleanupSettingsFiles()`.
3. Add `sandboxed?: boolean` to `AuditEntry` in `src/types/audit.ts`.
4. Add unit tests for all new functions (including shell escaping edge cases).
5. `@anthropic-ai/sandbox-runtime` is already installed as a regular dependency.

**No existing behavior changes.** All existing servers have no `sandbox` field, so `resolveSandboxConfig()` would sandbox them by default -- but nothing calls it yet.

### Phase 2: Integrate into MCP proxy server

1. Modify `mcp-proxy-server.ts` startup to call `checkSandboxAvailability()`, `resolveSandboxConfig()` for each server, `writeServerSettings()`, and `wrapServerCommand()`.
2. Add `cleanupSettingsFiles()` to shutdown.
3. Add `SANDBOX_POLICY` env var handling with enforce error paths.
4. Update `src/sandbox/index.ts` to pass `SANDBOX_POLICY` env var.
5. **Fix env passing**: change `StdioClientTransport` to always use `{ ...process.env, ...config.env }` instead of `undefined` fallback.
6. Add `sandboxed` field to audit log entries.
7. Update `mcp-servers.json` to set `"sandbox": false` on the filesystem server.

**This is the behavioral change.** The filesystem server explicitly opts out. Any new servers added without a `sandbox` field will be sandboxed by default. (Superseded: the filesystem server reopens validated paths by name, which a concurrent symlink swap exploits, so it now runs confined to its MCP roots; see [filesystem-server-confinement.md](filesystem-server-confinement.md).)

### Phase 3: Sandbox violation annotation

1. Add `annotateSandboxViolation()` heuristic to the proxy's tool-call error handler.
2. Annotate MCP error responses with `[SANDBOX BLOCKED]` prefix when the heuristic matches.
3. Log annotated violations to audit log with `sandboxed: true`.

### Phase 4: Integration tests

1. Add gated integration tests that verify sandbox wrapping with real bubblewrap/Seatbelt.
2. CI pipeline runs these on Linux with bubblewrap installed.

## Open Questions (for implementation)

1. ~~**`customConfig` network support**~~ **RESOLVED**: sandbox-runtime's `customConfig.network` does NOT provide per-command network isolation. Empirically validated — the proxy infrastructure is process-wide. Solution: per-server `srt` processes (see "Per-Server Network Isolation via `srt` CLI" section).

2. ~~**Default `denyRead` list**~~ **RESOLVED**: every sandboxed server gets a baseline `denyRead` that its own list is unioned with: the whole IronCurtain home (no opt-out) plus the credential stores and shell startup files listed under [Session Sandbox Directory Mapping](#session-sandbox-directory-mapping) (per-entry opt-out through `allowRead`). sandbox-runtime's hardcoded protections for `.gitconfig`, `.bashrc` and `.git/` are write protections and do not cover reads; the baseline's own entries do.

3. ~~**Optional vs required dependency**~~ **RESOLVED**: `@anthropic-ai/sandbox-runtime` is a regular dependency. It includes platform detection (`isSupportedPlatform()`) and the `warn` policy handles unavailable platforms gracefully. The `srt` CLI binary is installed with the package.

4. **macOS `sandbox-exec` deprecation**: Apple has deprecated `sandbox-exec` though it still works. sandbox-runtime's macOS support depends on it. Monitor for breakage in future macOS versions.
