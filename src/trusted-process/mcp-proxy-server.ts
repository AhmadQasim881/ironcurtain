/**
 * MCP Proxy Server -- Standalone MCP subprocess for Code Mode.
 *
 * Runs as a child process spawned by MCPClientManager. Acts as a pure
 * MCP pass-through relay: connects to real MCP backend servers and
 * forwards tool calls without any policy evaluation. The coordinator
 * in the parent process owns the full security pipeline.
 *
 * Responsibilities:
 *   - MCP transport setup (stdio/UDS/TCP)
 *   - Backend MCP server connection (StdioClientTransport)
 *   - OAuth credential injection and TokenFileRefresher
 *   - Sandbox-runtime wrapping (srt)
 *   - A private working directory per backend, sandboxed or not, so no
 *     backend inherits the relay's cwd or runs below a world-writable
 *     directory (see spawn-cwd.ts)
 *   - An allowlisted environment per backend (child-env.ts): the system
 *     variables a server needs, its own `env`, credentials and OAuth
 *     variables, and the host variables its `-e NAME` arguments forward --
 *     never the relay's configuration or anything else the host holds
 *     (see buildBackendEnv)
 *   - ListTools handler (raw pass-through)
 *   - CallTool handler (pure forward to backend)
 *   - Virtual proxy tools (MITM_CONTROL_ADDR)
 *   - Tool description hints injection
 *   - Roots bridging: on `notifications/roots/list_changed` from the
 *     coordinator, fetch fresh roots via `server.listRoots()`, update
 *     the shared `relayRoots` array, and notify each backend client so
 *     they re-query their `roots/list` handlers with the new set.
 *   - Roots confinement: a backend confined to its roots
 *     (`sandbox.filesystem.confineToRoots`, the filesystem server) runs
 *     under an srt profile that exposes only its roots, and is restarted
 *     with a new profile when the directories its roots expose change,
 *     instead of being notified (see roots-confinement.ts).
 *
 * Configuration via environment variables. The parent sets these on top of
 * the allowlist in child-env.ts, which is all of the host environment the
 * relay inherits; the session parent runs one relay per server and gives
 * each relay only its own server's config and credentials, plus the host
 * values that server's `-e NAME` arguments forward.
 *   MCP_SERVERS_CONFIG -- JSON object of the MCP server configs to proxy
 *   GENERATED_DIR      -- path to the generated artifacts directory
 *   PROTECTED_PATHS    -- JSON array of protected paths
 *   ALLOWED_DIRECTORY  -- (optional) sandbox directory; must be absolute
 *   IRONCURTAIN_HOME   -- (optional) IronCurtain home; must be absolute
 *   SESSION_LOG_PATH   -- (optional) path for capturing child process stderr
 *   SANDBOX_POLICY     -- (optional) "enforce" | "warn"; IRONCURTAIN_SANDBOX_POLICY
 *                         takes precedence. The session parent sets both to its
 *                         resolved policy. Default: platform default ("enforce"
 *                         on Linux/macOS). Invalid values exit non-zero.
 *   OS_SANDBOX_AVAILABILITY -- (optional) JSON of the OS-sandbox availability
 *                         the parent planned with, its srt smoke run included
 *                         (sandbox-integration.ts). The relay narrows it with
 *                         its own dependency check and does not run srt again.
 *                         Unset: the relay runs the smoke test itself when one
 *                         of its servers asks for an OS sandbox. Invalid values
 *                         exit non-zero.
 *   SERVER_FILTER      -- (optional) only connect to this single server name
 *   BACKEND_CALL_TIMEOUT_MS -- (optional) bound for one backend tool call in
 *                         milliseconds, reset on progress notifications up
 *                         to an absolute ceiling (see backendCallRequestOptions).
 *                         Default: DEFAULT_BACKEND_CALL_TIMEOUT_MS (300 s).
 *                         Invalid values exit non-zero.
 *   PROXY_TCP_PORT    -- (legacy, optional) loopback-only TCP listener port;
 *                         requires IRONCURTAIN_MCP_TCP_TOKEN as 64 lowercase
 *                         hexadecimal characters before any backend starts.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ARGUMENT_BUDGET_DENY_RESULT, hasBoundedArgumentStructure } from './argument-budget.js';
import { relayDiagnosticText, StartupStderrCapture } from './relay-diagnostics.js';
import { SANDBOX_CREDENTIAL_PATHS_ENV, parseSandboxCredentialPaths } from './sandbox-credential-paths.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { guardStdioStreamErrors } from '../utils/stdio-guard.js';
import { UdsServerTransport } from './uds-server-transport.js';
import { TcpServerTransport } from './tcp-server-transport.js';
import { resolveContainerSpawnCommand } from './container-command.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
  CallToolRequestSchema,
  CompatibilityCallToolResultSchema,
  ListToolsRequestSchema,
  ListRootsRequestSchema,
  RootsListChangedNotificationSchema,
  type Progress,
} from '@modelcontextprotocol/sdk/types.js';
import { BACKEND_CALL_TIMEOUT_ENV, maxTotalBackendCallMs, parseBackendCallTimeoutMs } from './call-timeouts.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { appendFileSync, mkdtempSync, writeFileSync, writeSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { loadGeneratedPolicy, getPackageGeneratedDir } from '../config/index.js';
import { extractPolicyRoots, toMcpRoots } from './policy-roots.js';
import {
  getOsSandboxAvailability,
  narrowOsSandboxAvailability,
  parseOsSandboxAvailabilityEnv,
  planServerSandboxing,
  resolveOsSandboxAvailability,
  describeOsSandboxProblems,
  formatSandboxRefusal,
  writeServerSettings,
  wrapServerCommand,
  cleanupSettingsFiles,
  discoverNodePaths,
  rewriteServerSettings,
  OS_SANDBOX_AVAILABILITY_ENV,
  type OsSandboxAvailability,
  type OsSandboxSmokeResult,
  type ResolvedSandboxConfig,
  type ResolvedSandboxParams,
} from './sandbox-integration.js';
import {
  ConfinedBackendSupervisor,
  InFlightCalls,
  confinedRootDirectories,
  confinedSandboxParams,
  resolveConfinedLaunch,
  type ConfinedLaunch,
} from './roots-confinement.js';
import type { McpRoot } from './mcp-client-manager.js';
import { resolveSandboxPolicy } from '../config/sandbox-policy.js';
import { createPrivateRunDir, createServerCwd, ensurePrivateScratchRoot, gitCeilingDirectories } from './spawn-cwd.js';
import { getIronCurtainHome } from '../config/paths.js';
import { extractMcpErrorMessage } from './mcp-error-utils.js';
import { hardenGitBackendEnv, isGitBackend } from './git-backend-env.js';
import { inheritedEnv, missingPassthroughEnvVars, passthroughEnvNames } from './child-env.js';
import { MIN_SECRET_LENGTH, REDACTED_SECRET } from './audit-redactor.js';
import { permissiveJsonSchemaValidator } from './permissive-output-validator.js';
import type { MCPServerConfig, SandboxAvailabilityPolicy } from '../config/types.js';
import { VERSION } from '../version.js';
import { loadToolDescriptionHints, applyToolDescriptionHints } from './tool-description-hints.js';
import { getProviderForServer } from '../auth/oauth-registry.js';
import { loadClientCredentials } from '../auth/oauth-provider.js';
import { OAuthTokenProvider } from '../auth/oauth-token-provider.js';
import { loadOAuthToken } from '../auth/oauth-token-store.js';
import { writeGWorkspaceCredentialFile } from './gworkspace-credentials.js';
import { TokenFileRefresher } from './token-file-refresher.js';
import {
  proxyAnnotations,
  proxyPolicyRules,
  proxyToolDefinitions,
  handleVirtualProxyTool,
  createControlApiClient,
  type ControlApiClient,
} from '../docker/proxy-tools.js';

import { type ProxiedTool, type ClientState, buildToolMap, assertUniqueToolNames } from './tool-call-pipeline.js';

// ---------------------------------------------------------------------------
// Subprocess helpers
// ---------------------------------------------------------------------------

/** Appends a timestamped line to the session log file. */
function logToSessionFile(sessionLogPath: string, message: string): void {
  const timestamp = new Date().toISOString();
  try {
    appendFileSync(sessionLogPath, `${timestamp} INFO  ${message}\n`);
  } catch {
    /* ignore write failures */
  }
}

/**
 * Replaces known credential values in a string with `***REDACTED***`, in
 * the order given. Prevents credential leakage in session log files.
 */
function redactCredentials(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const value of secrets) {
    if (value.length > 0 && result.includes(value)) {
      result = result.replaceAll(value, REDACTED_SECRET);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Exported subprocess utilities
// ---------------------------------------------------------------------------

/** Parsed environment configuration for the proxy server. */
export interface ProxyEnvConfig {
  credentialPaths: string[];
  serversConfig: Record<string, MCPServerConfig>;
  generatedDir: string;
  /** Directory for tool-annotations.json. Defaults to generatedDir if unset. */
  toolAnnotationsDir: string;
  protectedPaths: string[];
  sessionLogPath: string | undefined;
  allowedDirectory: string | undefined;
  serverCredentials: Record<string, string>;
  sandboxPolicy: SandboxAvailabilityPolicy;
  /** Raw `SERVER_FILTER` env value (e.g., backend name, "proxy", or undefined). */
  serverFilter: string | undefined;
  /** Bound for one backend `callTool`, from `BACKEND_CALL_TIMEOUT_MS` (default 300 s). */
  backendCallTimeoutMs: number;
  /** The parent's OS-sandbox availability, from `OS_SANDBOX_AVAILABILITY` (undefined when unset). */
  osSandboxAvailability: OsSandboxAvailability | undefined;
}

/** Result of sandbox availability validation. */
export interface SandboxValidationResult {
  sandboxAvailable: boolean;
  /** Full availability, including the problems that make it unavailable. */
  availability: OsSandboxAvailability;
}

/**
 * True when this proxy subprocess is in a viable serving state -- either
 * virtual-only mode (no backends configured) or at least one configured
 * backend connected. Returning false means the parent should treat this
 * subprocess as failed; otherwise it would register zero tools for the
 * server and trigger a misleading "stale annotations" warning in the
 * coordinator's drift check.
 */
export function proxyCanServe(serversConfig: Record<string, MCPServerConfig>, connectedBackendCount: number): boolean {
  return Object.keys(serversConfig).length === 0 || connectedBackendCount > 0;
}

/**
 * Writes a diagnostic line to stderr and (if configured) the proxy session log.
 *
 * Uses `fs.writeSync` so the bytes reach the OS before the function returns
 * even when stderr is a pipe (parent-spawned subprocess). `process.stderr.write`
 * is asynchronous in that case, which would let a follow-up `process.exit(1)`
 * truncate the diagnostic before delivery.
 */
export function emitProxyDiagnostic(
  level: 'WARNING' | 'ERROR',
  message: string,
  sessionLogPath: string | undefined,
): void {
  writeSync(2, `${level}: ${relayDiagnosticText(message)}\n`);
  if (sessionLogPath) logToSessionFile(sessionLogPath, `[proxy] ${message}`);
}

/**
 * Reads and validates proxy environment variables.
 * Returns a typed config object or calls process.exit(1) on missing required vars.
 */
export function parseProxyEnvConfig(): ProxyEnvConfig {
  let credentialPaths: string[];
  try {
    credentialPaths = parseSandboxCredentialPaths(process.env[SANDBOX_CREDENTIAL_PATHS_ENV]);
  } catch {
    process.stderr.write('Invalid sandbox credential path metadata\n');
    process.exit(1);
  }
  const serversConfigJson = process.env.MCP_SERVERS_CONFIG;
  const generatedDir = process.env.GENERATED_DIR;
  const protectedPathsJson = process.env.PROTECTED_PATHS ?? '[]';
  const sessionLogPath = process.env.SESSION_LOG_PATH;
  const allowedDirectory = process.env.ALLOWED_DIRECTORY;

  if (!serversConfigJson) {
    process.stderr.write('MCP_SERVERS_CONFIG environment variable is required\n');
    process.exit(1);
  }

  if (!generatedDir) {
    process.stderr.write('GENERATED_DIR environment variable is required\n');
    process.exit(1);
  }

  // The relay runs from IronCurtain's package root, not from the directory
  // the parent was started in, so a relative sandbox path would name a
  // different directory here (and in the roots advertised to backends)
  // than in the parent's policy engine. The parent always passes an
  // absolute path; refuse anything else rather than guess.
  if (allowedDirectory !== undefined && !isAbsolute(allowedDirectory)) {
    process.stderr.write('ALLOWED_DIRECTORY must be an absolute path\n');
    process.exit(1);
  }
  // Same for the IronCurtain home: OAuth tokens are read from it and the
  // backends' private working directories are created under it, so a
  // relative value must not be resolved against the package root.
  const ironCurtainHome = process.env.IRONCURTAIN_HOME;
  if (ironCurtainHome !== undefined && !isAbsolute(ironCurtainHome)) {
    process.stderr.write('IRONCURTAIN_HOME must be an absolute path\n');
    process.exit(1);
  }

  // Parse per-server credentials and immediately scrub from process.env
  // so they are not inherited by child MCP server processes.
  const serverCredentials: Record<string, string> = process.env.SERVER_CREDENTIALS
    ? (JSON.parse(process.env.SERVER_CREDENTIALS) as Record<string, string>)
    : {};
  delete process.env.SERVER_CREDENTIALS;

  // Validated, same precedence as the session parent. A value that is not
  // "enforce" or "warn" (e.g. "ENFORCE " is accepted, "enfroce" is not)
  // aborts instead of silently weakening to "warn".
  let sandboxPolicy: SandboxAvailabilityPolicy;
  try {
    sandboxPolicy = resolveSandboxPolicy(undefined, process.env);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  const allServersConfig = JSON.parse(serversConfigJson) as Record<string, MCPServerConfig>;
  const protectedPaths = JSON.parse(protectedPathsJson) as string[];

  // When SERVER_FILTER is set, only connect to that single backend server.
  // Special case: SERVER_FILTER=proxy with no matching backend enters virtual-only mode.
  const serverFilter = process.env.SERVER_FILTER;
  const isVirtualOnly = serverFilter === 'proxy' && !allServersConfig[serverFilter];
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- isVirtualOnly is defensive; TS can't prove it's false at runtime
  const serversConfig: Record<string, MCPServerConfig> = isVirtualOnly
    ? {}
    : serverFilter
      ? { [serverFilter]: allServersConfig[serverFilter] }
      : allServersConfig;

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: Record index may be undefined at runtime
  if (serverFilter && !allServersConfig[serverFilter] && !isVirtualOnly) {
    process.stderr.write(`SERVER_FILTER: unknown server "${serverFilter}"\n`);
    process.exit(1);
  }

  // When TOOL_ANNOTATIONS_DIR is set, annotations come from there.
  // Otherwise they default to the same directory as compiled policy.
  const toolAnnotationsDir = process.env.TOOL_ANNOTATIONS_DIR ?? generatedDir;

  // The parent sets the backend call bound explicitly; a malformed value
  // stops the relay rather than silently running with a different deadline.
  let backendCallTimeoutMs: number;
  try {
    backendCallTimeoutMs = parseBackendCallTimeoutMs(process.env[BACKEND_CALL_TIMEOUT_ENV]);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  // The parent's verdict, its srt smoke run included. A damaged value stops
  // the relay: guessing could run a server unconfined.
  let osSandboxAvailability: OsSandboxAvailability | undefined;
  try {
    osSandboxAvailability = parseOsSandboxAvailabilityEnv(process.env[OS_SANDBOX_AVAILABILITY_ENV]);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  return {
    serversConfig,
    credentialPaths,
    generatedDir,
    toolAnnotationsDir,
    protectedPaths,
    sessionLogPath,
    allowedDirectory,
    serverCredentials,
    sandboxPolicy,
    serverFilter,
    backendCallTimeoutMs,
    osSandboxAvailability,
  };
}

/** What {@link validateSandboxAvailability} decides from besides the relay's own dependency check. */
export interface RelaySandboxAvailabilityInputs {
  /**
   * The parent's verdict (`OS_SANDBOX_AVAILABILITY`), its srt smoke run
   * included. The relay narrows it with its own dependency check and does
   * not run srt again, so it plans its servers exactly as the parent did.
   */
  readonly fromParent?: OsSandboxAvailability;
  /**
   * The relay's servers. Without a parent verdict, the relay runs the srt
   * smoke test itself when one of them asks for an OS sandbox.
   */
  readonly servers?: Readonly<Record<string, MCPServerConfig>>;
  /** The srt smoke run (tests). Default: once per process. */
  readonly smokeTest?: () => Promise<OsSandboxSmokeResult>;
}

/**
 * Decides OS sandbox availability for this relay and records it in the
 * session log: the parent's verdict narrowed by the relay's own dependency
 * check, or, when the parent passed none, the dependency check confirmed by
 * an srt smoke run (see {@link resolveOsSandboxAvailability}).
 *
 * Never throws: the policy is applied per server by
 * {@link resolveServerSandboxConfigs}, so a relay whose servers opt out of
 * sandboxing (fetch, github) keeps working under "enforce" on a host
 * without bubblewrap/socat/ripgrep. The user-facing notice is printed once
 * by the session parent, not by every relay.
 */
export async function validateSandboxAvailability(
  sandboxPolicy: SandboxAvailabilityPolicy,
  sessionLogPath: string | undefined,
  platform: string,
  inputs: RelaySandboxAvailabilityInputs = {},
): Promise<SandboxValidationResult> {
  const own = getOsSandboxAvailability(undefined, platform);
  const availability =
    inputs.fromParent !== undefined
      ? narrowOsSandboxAvailability(inputs.fromParent, own)
      : await resolveOsSandboxAvailability(inputs.servers ?? {}, { dependencies: own, smokeTest: inputs.smokeTest });

  if (sessionLogPath) {
    for (const warning of availability.warnings) {
      logToSessionFile(sessionLogPath, `[sandbox] WARNING: ${warning}`);
    }
    if (!availability.available) {
      const consequence =
        sandboxPolicy === 'enforce'
          ? 'Servers that require it will not start (sandboxPolicy "enforce").'
          : 'Servers that require it will run without OS containment (sandboxPolicy "warn"). ' +
            'Set sandboxPolicy (or IRONCURTAIN_SANDBOX_POLICY) to "enforce" to refuse them instead.';
      logToSessionFile(
        sessionLogPath,
        `[sandbox] WARNING: OS-level sandboxing unavailable (${describeOsSandboxProblems(availability)}). ${consequence}`,
      );
    }
  }

  return { sandboxAvailable: availability.available, availability };
}

/**
 * Applies the availability policy per server and writes srt settings files
 * for sandboxed servers. Servers that need an unavailable sandbox under
 * "enforce" are returned in `refusedServers` (name -> message) instead of
 * throwing, so the remaining servers in the same relay still start.
 *
 * Also returns a private working directory for EVERY server that may
 * start, and every scratch directory created (the relay removes them all
 * on exit). A backend must never inherit the relay's cwd: npx would
 * resolve `node_modules/.bin` and `.npmrc` from it, tsx its
 * `tsconfig.json`, git-mcp-server its `.env` and relative tool paths.
 * Those lookups also walk UP from the cwd, so where the private directory
 * lives matters (see spawn-cwd.ts):
 *   - sandboxed servers: `<settingsDir>/<server>.cwd`, next to their srt
 *     settings and listed in srt's `allowWrite` and `allowRead`. The
 *     settings directory is a fresh `srt-XXXXXX` inside the per-user
 *     scratch root (`ensurePrivateScratchRoot`, `<os.tmpdir()>/ironcurtain-<uid>`,
 *     mode 0700, owner-checked), which every sandboxed server has in its
 *     `denyRead` baseline: an OAuth server's access-token file written next
 *     to its settings is readable by that server alone, not by every other
 *     sandboxed server with access to a shared `/tmp`;
 *   - unsandboxed servers -- `sandbox: false` opt-outs and servers that
 *     run unconfined because srt is unavailable under the "warn" policy --
 *     `<IronCurtain home>/run/mcp-cwd/relay-*` `/<server>.cwd`, never below
 *     `os.tmpdir()` (on Linux usually the world-writable /tmp).
 * Refused servers get none. If a directory cannot be created, everything
 * created so far is removed and the error propagates (the relay exits
 * non-zero and no backend starts).
 *
 * Throws `SandboxConfigError` (from {@link planServerSandboxing}) when
 * a sandboxed server's config would re-expose the IronCurtain home, and
 * whatever `ensurePrivateScratchRoot` throws when the scratch root cannot
 * be trusted; the relay then exits non-zero and no backend starts.
 */
export function resolveServerSandboxConfigs(
  serversConfig: Record<string, MCPServerConfig>,
  allowedDirectory: string | undefined,
  availability: OsSandboxAvailability,
  sandboxPolicy: SandboxAvailabilityPolicy,
  ironCurtainHome: string = getIronCurtainHome(),
  credentialPaths: readonly string[] = [],
): {
  resolvedSandboxConfigs: Map<string, ResolvedSandboxConfig>;
  refusedServers: Map<string, string>;
  settingsDir: string;
  serverCwdPaths: Map<string, string>;
  scratchDirs: string[];
} {
  // Resolved (and validated) before any settings directory is created, so a
  // config error leaves nothing behind. Each server is named in errors.
  const plan = planServerSandboxing(serversConfig, allowedDirectory, availability, sandboxPolicy, credentialPaths);
  const refusedServers = new Map(plan.refused.map((name) => [name, formatSandboxRefusal(name, availability)]));
  const serverCwdPaths = new Map<string, string>();
  const settingsDir = mkdtempSync(join(ensurePrivateScratchRoot(), 'srt-'));
  const scratchDirs = [settingsDir];
  let privateRunDir: string | undefined;

  try {
    for (const [serverName, resolved] of plan.resolved) {
      if (resolved.sandboxed) {
        // Only the git backend may reach the ssh-agent socket: it is also
        // the only backend buildBackendEnv hands SSH_AUTH_SOCK.
        const { cwdPath } = writeServerSettings(serverName, resolved.config, settingsDir, {
          sshAgent: isGitBackend(serverName),
        });
        serverCwdPaths.set(serverName, cwdPath);
      } else {
        if (privateRunDir === undefined) {
          privateRunDir = createPrivateRunDir(ironCurtainHome);
          scratchDirs.push(privateRunDir);
        }
        serverCwdPaths.set(serverName, createServerCwd(privateRunDir, serverName));
      }
    }
  } catch (err) {
    for (const dir of scratchDirs) cleanupSettingsFiles(dir);
    throw err;
  }

  return { resolvedSandboxConfigs: plan.resolved, refusedServers, settingsDir, serverCwdPaths, scratchDirs };
}

/** Per-server inputs to {@link buildBackendEnv}. */
export interface BackendEnvInputs {
  /**
   * The relay's own environment, of which the backend inherits the
   * allowlisted part (`inheritedEnv` in child-env.ts). Default `process.env`.
   */
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  /**
   * Whether the backend runs under srt. It no longer changes the
   * environment: sandboxed and unsandboxed backends get the same allowlist,
   * which never carries NODE_OPTIONS (it used to be blanked for sandboxed
   * backends only).
   */
  readonly sandboxed: boolean;
  readonly serverCredentials: Readonly<Record<string, string>>;
  readonly oauthEnv: Readonly<Record<string, string>>;
  /** `ALLOWED_DIRECTORY`: git repository discovery never climbs above it. */
  readonly allowedDirectory: string | undefined;
  /**
   * The backend's private working directory (from
   * {@link resolveServerSandboxConfigs}): git never climbs above the
   * directory holding it.
   */
  readonly serverCwd: string;
}

/**
 * Builds the environment a backend MCP server is spawned with: the
 * allowlisted part of the relay's environment (`inheritedEnv`, child-env.ts:
 * PATH, HOME, locale, temp and proxy settings and the like, plus the host
 * values the server's own `-e NAME` arguments forward, and SSH_AUTH_SOCK for
 * the git backend only), a `GIT_CEILING_DIRECTORIES` entry for the directory
 * holding the backend's private working directory
 * ({@link gitCeilingDirectories}, so git never adopts a repository above
 * that directory, such as `~/.git` or a versioned IronCurtain home), the
 * server's configured `env`, its credentials and its OAuth variables.
 *
 * Nothing else the relay holds reaches a backend: not its own configuration
 * (MCP_SERVERS_CONFIG, GENERATED_DIR, SESSION_LOG_PATH, SERVER_FILTER,
 * MITM_CONTROL_ADDR, ...), not NODE_OPTIONS or NODE_PATH (which run code in
 * every Node.js child; the IDE debugger preloads they used to carry also
 * referenced paths under `~` that `denyRead` blocks), not LD_* or DYLD_*,
 * and not any host variable the allowlist does not name. The relay's own
 * environment is already allowlisted by its parent, so this is the second
 * of two filters on the way from the host to a third-party server.
 *
 * The git backend ({@link isGitBackend}) also gets a hardened git environment
 * ({@link hardenGitBackendEnv}), applied last so that nothing merged above can
 * weaken it. That server runs host git with the agent's repository as its
 * working directory, and the repository is agent-writable: Code Mode agents
 * can write it through the filesystem server, Docker agents through the
 * bind-mounted workspace. Its `.git/config`, hooks and `.gitattributes` are
 * therefore attacker-controlled configuration for a host process. The server
 * builds its own git argv, so the relay cannot pass `-c` flags; it hardens the
 * environment the server copies into every git invocation instead:
 *
 * - Command-scope config (`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/
 *   `GIT_CONFIG_VALUE_n`) outranks repository and included config and pins
 *   the fixed-name keys that run a program: `core.fsmonitor`,
 *   `core.hooksPath` (no hook in `.git/hooks` runs), pager and editors,
 *   `core.sshCommand` (the user's trusted global value, or plain `ssh`),
 *   askpass (none), credential helpers (reset, then the user's own system and
 *   global helpers re-added in order), and the alternate-refs, signing,
 *   archive filter and automatic maintenance commands. User identity and
 *   credential configuration stay in effect: `GIT_CONFIG_GLOBAL` and
 *   `GIT_CONFIG_SYSTEM` are deliberately left alone.
 * - `GIT_ALLOW_PROTOCOL=https:ssh`: a planted `ext::` or `fd::` remote never
 *   runs, and `file://` URLs and local paths are refused for clone, fetch,
 *   pull and push alike, which also keeps a planted
 *   `remote.<name>.uploadpack` from running.
 * - `GIT_CEILING_DIRECTORIES` at the parent of the allowed directory's real
 *   path: discovery never enters that directory, so a call on a directory
 *   with no repository of its own never reaches one rooted above the
 *   workspace (at `$HOME`, say). A repository rooted at the allowed directory
 *   still works; a workspace nested inside a larger checkout is no longer
 *   treated as part of it. It is added to the private-cwd ceiling every
 *   backend gets, never in place of it.
 *
 * The srt wrapper, when present, appends its own `safe.directory` entries
 * after these, continuing the `GIT_CONFIG_COUNT` numbering.
 *
 * Residual risk this environment cannot remove:
 *
 * - Driver-keyed configuration is named by repository content, so no fixed
 *   key list can pin it: `filter.<driver>.clean`/`smudge`/`process`,
 *   `diff.<driver>.textconv`/`command` and `merge.<driver>.driver`, selected
 *   by an agent-written `.gitattributes` or `.git/info/attributes`, defined in
 *   `.git/config` or pulled in through `include.path`/`includeIf`. Ordinary
 *   operations run them (add, status and diff run clean filters, checkout runs
 *   smudge filters, diff, show and log patches run textconv, merges run merge
 *   drivers). `diff.external` belongs here too: the server never passes
 *   `--no-ext-diff`, and an empty override makes `git diff` fail rather than
 *   disabling it. Gitfile, `commondir` and `core.worktree` redirects run no
 *   command but point git at directories outside the allowed one. Containing
 *   all of this is the job of OS-level confinement of this server (srt) and
 *   of policy checks on `.git` writes and repository configuration, not of
 *   this environment.
 * - Only git run by this backend is hardened. With `--workspace` the agent
 *   writes the user's own repository; hooks and configuration it plants there
 *   persist after the session and run the next time the user, an IDE or any
 *   other tool runs git in that repository.
 *
 * Throws when the git hardening cannot be built; the caller must then skip
 * the backend.
 */
export function buildBackendEnv(
  serverName: string,
  config: MCPServerConfig,
  inputs: BackendEnvInputs,
): Record<string, string> {
  const gitBackend = isGitBackend(serverName);
  const inherited = inheritedEnv(inputs.baseEnv ?? process.env, {
    passthroughNames: passthroughEnvNames(config.args),
    sshAgent: gitBackend,
  });
  const env: Record<string, string> = {
    ...inherited,
    // git must not walk up out of the private cwd into a repository above
    // it (see spawn-cwd.ts). Throws for a directory git cannot take as a
    // ceiling; the caller then skips the backend. (The allowlist carries no
    // inherited ceilings; the git backend adds its own below.)
    GIT_CEILING_DIRECTORIES: gitCeilingDirectories(inputs.serverCwd),
    ...(config.env ?? {}),
    ...inputs.serverCredentials,
    ...inputs.oauthEnv,
  };
  return gitBackend ? hardenGitBackendEnv(env, inputs.allowedDirectory) : env;
}

/**
 * The redaction the relay applies to a backend's stderr before it reaches
 * the session log, for the lines it streams there and the startup stderr a
 * failed connection quotes alike. It masks, as `***REDACTED***`:
 *
 * - every value of the server's stored credentials (`serverCredentials`)
 *   and of the OAuth variables the relay prepared for it (`oauthEnv`);
 * - the value its environment (`backendEnv`, from {@link buildBackendEnv})
 *   holds for each variable its docker-style `-e NAME` arguments forward:
 *   a token the user exported in the shell, such as
 *   GITHUB_PERSONAL_ACCESS_TOKEN for the github server, reaches the backend
 *   that way without being a stored credential. Only values of at least
 *   `MIN_SECRET_LENGTH` characters: a shorter value is no credential any
 *   provider issues, and masking it everywhere would mangle the log.
 *
 * Longer values are replaced first, so one that contains another is masked
 * whole.
 */
export function backendStderrRedactor(
  config: MCPServerConfig,
  backendEnv: Readonly<Record<string, string>>,
  serverCredentials: Readonly<Record<string, string>>,
  oauthEnv: Readonly<Record<string, string>>,
): (text: string) => string {
  const forwarded = passthroughEnvNames(config.args).flatMap((name) => {
    const value = Object.hasOwn(backendEnv, name) ? backendEnv[name] : '';
    return value.length >= MIN_SECRET_LENGTH ? [value] : [];
  });
  const secrets = [...new Set([...Object.values(serverCredentials), ...Object.values(oauthEnv), ...forwarded])]
    .filter((value) => value.length > 0)
    .sort((a, b) => b.length - a.length);
  return (text: string): string => redactCredentials(text, secrets);
}

/** Text after the last newline that {@link lineBufferedText} holds back at most, in characters. */
const MAX_PENDING_STDERR_CHARS = 64 * 1024;

/**
 * Hands text that arrives in arbitrary chunks to `emit` in whole lines: each
 * call to `emit` receives one or more complete lines (with their newlines).
 * Text after the last newline is held until a later chunk completes the
 * line, until {@link flush} (the stream ended), or until it grows beyond
 * `maxPendingChars`, when it is handed on as it is.
 *
 * The relay redacts a backend's stderr through this. A pipe can deliver one
 * write in several chunks (a write larger than the pipe's atomic size is
 * read in pieces), and redaction that looks at one chunk at a time misses a
 * credential split across two of them: the session log would get both
 * halves, one entry each. Exported for tests.
 */
export function lineBufferedText(
  emit: (lines: string) => void,
  maxPendingChars: number = MAX_PENDING_STDERR_CHARS,
): { push(text: string): void; flush(): void } {
  let pending = '';
  const flush = (): void => {
    if (pending === '') return;
    const rest = pending;
    pending = '';
    emit(rest);
  };
  return {
    push(text: string): void {
      pending += text;
      const end = pending.lastIndexOf('\n') + 1;
      if (end > 0) {
        const lines = pending.slice(0, end);
        pending = pending.slice(end);
        emit(lines);
      }
      if (pending.length > maxPendingChars) flush();
    },
    flush,
  };
}

/**
 * Selects and validates the proxy transport based on environment variables.
 * Returns 'tcp', 'uds', or 'stdio' along with the transport options.
 */
export function selectTransportConfig():
  | {
      kind: 'tcp';
      host: '127.0.0.1';
      port: number;
      requiredToken: string;
      portFilePath: string | undefined;
    }
  | {
      kind: 'uds';
      socketPath: string;
    }
  | {
      kind: 'stdio';
    } {
  const proxyTcpPort = process.env.PROXY_TCP_PORT;
  const proxySocketPath = process.env.PROXY_SOCKET_PATH;

  if (proxyTcpPort) {
    const parsedPort = parseInt(proxyTcpPort, 10);
    if (!Number.isFinite(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
      throw new Error(`Invalid PROXY_TCP_PORT value "${proxyTcpPort}". Expected an integer between 0 and 65535.`);
    }
    const requiredToken = process.env.IRONCURTAIN_MCP_TCP_TOKEN;
    if (requiredToken === undefined || !/^[a-f0-9]{64}$/u.test(requiredToken)) {
      throw new Error('PROXY_TCP_PORT requires IRONCURTAIN_MCP_TCP_TOKEN as 64 lowercase hexadecimal characters');
    }
    return {
      kind: 'tcp',
      host: '127.0.0.1',
      port: parsedPort,
      requiredToken,
      portFilePath: process.env.PROXY_PORT_FILE,
    };
  }

  if (proxySocketPath) {
    return { kind: 'uds', socketPath: proxySocketPath };
  }

  return { kind: 'stdio' };
}

/**
 * Request options for one relayed backend `callTool`.
 *
 * Without an explicit `timeout` the MCP SDK cuts every call at its 60 s
 * default while the coordinator keeps waiting, so slow tools (a clone, an
 * export, a fetch with a long timeout) failed inside the relay. The bound is
 * `backendCallTimeoutMs` from the parent (`BACKEND_CALL_TIMEOUT_MS`), reset
 * whenever the backend reports progress, with an absolute ceiling
 * (`maxTotalBackendCallMs`) so a backend that reports progress forever is
 * still cut off.
 *
 * `onprogress` is always set: the SDK only attaches a progress token to the
 * request, and so only lets the backend report progress and reset the
 * timer, when it is. Each report goes to `forwardProgress` when the caller
 * asked for progress itself (its own request carried a token), so the
 * coordinator's timer resets too and a long-running tool is bounded by the
 * relay alone. `signal` is the caller's request signal: when the
 * coordinator gives up (or disconnects) the backend call is cancelled
 * instead of running on unobserved.
 */
export function backendCallRequestOptions(
  backendCallTimeoutMs: number,
  forwardProgress: ((progress: Progress) => void) | undefined,
  signal?: AbortSignal,
): RequestOptions {
  return {
    timeout: backendCallTimeoutMs,
    resetTimeoutOnProgress: true,
    maxTotalTimeout: maxTotalBackendCallMs(backendCallTimeoutMs),
    onprogress: (progress: Progress) => forwardProgress?.(progress),
    ...(signal ? { signal } : {}),
  };
}

/** What the relay spawns for one backend, after any srt wrapping. */
interface BackendSpawn {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
  readonly cwd: string;
}

/**
 * Spawns one backend MCP server and connects a client to it. The client
 * answers `roots/list` with `roots`, the relay's live root list shared by
 * every backend, so a coordinator-driven roots update reaches it. The
 * backend's stderr goes to the session log in whole lines with `redact`
 * applied.
 *
 * Throws when the backend cannot be connected, after closing whatever was
 * spawned (a half-started backend must not leak a child process); the
 * message names the command and carries the start of the backend's
 * redacted stderr.
 */
async function connectBackendClient(
  serverName: string,
  spawn: BackendSpawn,
  roots: McpRoot[],
  sessionLogPath: string | undefined,
  redact: (text: string) => string,
): Promise<ClientState> {
  const transport = new StdioClientTransport({
    command: spawn.command,
    args: [...spawn.args],
    env: spawn.env,
    stderr: 'pipe',
    // Every backend runs in its own private, empty directory -- never the
    // relay's cwd, and not the session sandbox. That keeps the launcher
    // (npx, tsx), dotenv and relative tool paths away from any directory
    // an agent or a checkout controls, including for unsandboxed servers
    // and the srt-unavailable fallback (whose directories live under the
    // IronCurtain home, not below a world-writable os.tmpdir(), because
    // those lookups walk up); for sandboxed servers it also keeps
    // srt/bwrap ghost dotfiles out of the sandbox directory.
    cwd: spawn.cwd,
  });

  // Kept until the connection is up, for the failure message below.
  const startup = new StartupStderrCapture();
  if (transport.stderr) {
    const stderr = transport.stderr;
    // Whole lines only, so a credential split across two chunks is still
    // redacted (see lineBufferedText); the decoder keeps a multi-byte
    // character split across chunks intact.
    const decoder = new StringDecoder('utf8');
    const sessionLogLines = lineBufferedText((text) => {
      const lines = text.trimEnd();
      if (sessionLogPath && lines) logToSessionFile(sessionLogPath, `[mcp:${serverName}] ${redact(lines)}`);
    });
    const take = (text: string): void => {
      startup.append(text);
      sessionLogLines.push(text);
    };
    stderr.on('data', (chunk: Buffer) => take(decoder.write(chunk)));
    stderr.on('end', () => {
      take(decoder.end());
      sessionLogLines.flush();
    });
  }

  // See permissive-output-validator.ts for why this is needed.
  const client = new Client(
    { name: 'ironcurtain-proxy', version: VERSION },
    {
      capabilities: { roots: { listChanged: true } },
      jsonSchemaValidator: permissiveJsonSchemaValidator,
    },
  );

  // All backend clients share the single `roots` array so a
  // coordinator-driven roots update (see the proxy server's
  // `roots/list_changed` handler in main()) is visible to every backend
  // on its next `roots/list` request.
  const state: ClientState = { client, roots };

  client.setRequestHandler(ListRootsRequestSchema, () => {
    if (state.rootsRefreshed) {
      state.rootsRefreshed();
      state.rootsRefreshed = undefined;
    }
    return { roots: state.roots };
  });

  try {
    await client.connect(transport);
  } catch (err) {
    // `client.connect` may have spawned the backend subprocess (via
    // StdioClientTransport) before failing; close it so a half-started
    // backend doesn't leak a child process for the relay's lifetime.
    await client.close().catch(() => {});
    const cmd = `${spawn.command} ${spawn.args.join(' ')}`;
    const captured = startup.finish();
    const redactedStderr = captured === undefined ? '' : redact(captured);
    const stderrSnippet =
      captured === undefined
        ? ' Server stderr omitted because its startup capture exceeded the limit.'
        : redactedStderr
          ? ` Server stderr: ${redactedStderr.substring(0, 1000)}`
          : '';
    throw new Error(`failed to connect (${cmd}): ${err instanceof Error ? err.message : String(err)}${stderrSnippet}`, {
      cause: err,
    });
  }
  startup.finish();
  return state;
}

/** Per-server inputs for (re)starting a backend confined to its roots. */
interface ConfinedBackendSpec {
  /** Its resolved srt parameters (hidden regions included, roots not yet). */
  readonly params: ResolvedSandboxParams;
  /** Program, arguments and the read paths it needs (see roots-confinement.ts). */
  readonly launch: ConfinedLaunch;
  /** Extra srt entries the relay adds for it (Node.js paths, an OAuth credential directory). */
  readonly extraAllowRead: readonly string[];
  readonly extraAllowWrite: readonly string[];
  readonly env: Record<string, string>;
  readonly cwd: string;
  readonly redact: (text: string) => string;
}

/**
 * Writes a confined backend's srt settings for `rootDirectories` and
 * starts it: every launch, the first one and each restart, goes through
 * here, so a restarted server gets exactly the profile a fresh one would.
 */
async function launchConfinedBackend(
  serverName: string,
  spec: ConfinedBackendSpec,
  rootDirectories: readonly string[],
  settingsDir: string,
  roots: McpRoot[],
  sessionLogPath: string | undefined,
): Promise<ClientState> {
  const base: ResolvedSandboxParams = {
    ...spec.params,
    allowWrite: [...new Set([...spec.params.allowWrite, ...spec.extraAllowWrite])],
  };
  const params = confinedSandboxParams(base, rootDirectories, [...spec.launch.readPaths, ...spec.extraAllowRead]);
  writeServerSettings(serverName, params, settingsDir, { sshAgent: isGitBackend(serverName) });
  const wrapped = wrapServerCommand(
    serverName,
    spec.launch.command,
    spec.launch.args,
    { sandboxed: true, config: params },
    settingsDir,
  );
  if (sessionLogPath) {
    logToSessionFile(
      sessionLogPath,
      `[proxy] "${serverName}": confined to ${rootDirectories.length} root director(ies): ${rootDirectories.join(', ')}`,
    );
  }
  return connectBackendClient(
    serverName,
    { command: wrapped.command, args: wrapped.args, env: spec.env, cwd: spec.cwd },
    roots,
    sessionLogPath,
    spec.redact,
  );
}

// ── main() -- thin orchestrator ────────────────────────────────────────

async function main(): Promise<void> {
  // Reject an uncredentialed legacy listener before config, sandbox planning
  // or any backend process/credential work. Ordinary sessions use stdio.
  const transportConfig = selectTransportConfig();
  const envConfig = parseProxyEnvConfig();
  const {
    serversConfig,
    credentialPaths,
    generatedDir,
    toolAnnotationsDir,
    sessionLogPath,
    allowedDirectory,
    serverCredentials,
    sandboxPolicy,
    serverFilter,
    backendCallTimeoutMs,
    osSandboxAvailability,
  } = envConfig;

  // Load compiled policy + annotations to derive MCP roots advertised
  // to backend MCP servers at connection time (the backend still uses
  // Roots to authorize filesystem access).
  const { compiledPolicy, toolAnnotations } = loadGeneratedPolicy({
    policyDir: generatedDir,
    toolAnnotationsDir,
    fallbackDir: getPackageGeneratedDir(),
  });

  // Merge proxy tool annotations and policy rules so roots derivation
  // includes any paths referenced by proxy policy rules.
  toolAnnotations.servers.proxy = {
    inputHash: 'hardcoded',
    tools: proxyAnnotations,
  };
  compiledPolicy.rules = [...proxyPolicyRules, ...compiledPolicy.rules];

  const policyRoots = extractPolicyRoots(compiledPolicy, allowedDirectory ?? '/tmp');
  const mcpRoots = toMcpRoots(policyRoots);

  // Shared mutable roots array bridged to the coordinator. The proxy
  // server's `notifications/roots/list_changed` handler (registered
  // below) refreshes this in place via `server.listRoots()`, and each
  // backend client's `roots/list` handler returns it. All backends
  // observe the same authoritative set.
  const relayRoots: { uri: string; name: string }[] = [...mcpRoots];

  // ── Sandbox availability & config resolution ──────────────────────
  // The parent's verdict (its srt smoke run included) when it passed one,
  // so this relay plans its servers exactly as the parent did.
  const { availability } = await validateSandboxAvailability(sandboxPolicy, sessionLogPath, process.platform, {
    fromParent: osSandboxAvailability,
    servers: serversConfig,
  });
  let sandboxConfigs: ReturnType<typeof resolveServerSandboxConfigs>;
  try {
    sandboxConfigs = resolveServerSandboxConfigs(
      serversConfig,
      allowedDirectory,
      availability,
      sandboxPolicy,
      undefined,
      credentialPaths,
    );
  } catch (err) {
    // Fail closed, and say why in the session log as well: a server config
    // that would re-expose the IronCurtain home, or a per-user scratch root
    // that cannot be trusted (another user's, a symlink, open to others),
    // stops every backend of this relay.
    emitProxyDiagnostic('ERROR', err instanceof Error ? err.message : String(err), sessionLogPath);
    process.exit(1);
  }
  const { resolvedSandboxConfigs, refusedServers, settingsDir, serverCwdPaths, scratchDirs } = sandboxConfigs;

  // Node/npm installation paths, re-exposed through allowRead for every
  // sandboxed server: macOS re-allows reads inside a denied region (e.g.
  // denyRead: ["~"]) only through allowRead. discoverNodePaths() never
  // returns a path inside the IronCurtain home, which stays denied.
  const dynamicNodePaths = discoverNodePaths();

  // ── Connect to real MCP servers ───────────────────────────────────
  const clientStates = new Map<string, ClientState>();
  const allTools: ProxiedTool[] = [];
  const tokenRefreshers = new Map<string, TokenFileRefresher>();

  // Backends confined to their roots: started (and restarted whenever the
  // directories their roots expose change) through launchConfinedBackend.
  const sessionSandboxDir = allowedDirectory ?? '/tmp';
  const confinedSpecs = new Map<string, ConfinedBackendSpec>();
  // Calls each backend client is serving: a confined backend replaced by a
  // restart finishes them before it is closed.
  const inFlightCalls = new InFlightCalls();
  const confinedBackends = new ConfinedBackendSupervisor(
    clientStates,
    {
      launch: (serverName, rootDirectories) => {
        const spec = confinedSpecs.get(serverName);
        if (spec === undefined) return Promise.reject(new Error(`no launch spec for "${serverName}"`));
        return launchConfinedBackend(serverName, spec, rootDirectories, settingsDir, relayRoots, sessionLogPath);
      },
      close: async (state) => {
        await inFlightCalls.drain(state);
        try {
          await state.client.close();
        } catch {
          /* ignore */
        }
      },
    },
    (message) => {
      if (sessionLogPath) logToSessionFile(sessionLogPath, `[proxy] ${message}`);
    },
  );

  for (const [serverName, config] of Object.entries(serversConfig)) {
    // Fail closed per server: a server that needs an OS sandbox this host
    // cannot provide never starts under "enforce". Checked before OAuth so
    // no credentials are prepared for it.
    const refusal = refusedServers.get(serverName);
    if (refusal !== undefined) {
      emitProxyDiagnostic('ERROR', refusal, sessionLogPath);
      continue;
    }

    // Skip servers whose args reference env vars (Docker -e VAR_NAME syntax)
    // that are set nowhere -- the server would fail to start without them.
    // A value in the relay's environment (forwarded from the host by the
    // parent), the server's own `env` or its stored credentials (the
    // SERVER_CREDENTIALS channel, config.json's serverCredentials) all
    // count, since buildBackendEnv injects every one of them.
    const missingEnvVars = missingPassthroughEnvVars(config.args, {
      env: process.env,
      configEnv: config.env,
      credentials: serverCredentials,
    });
    if (missingEnvVars.length > 0) {
      emitProxyDiagnostic(
        'WARNING',
        `Skipping MCP server "${serverName}": missing environment variable(s) ${missingEnvVars.join(', ')}`,
        sessionLogPath,
      );
      continue;
    }

    const resolved = resolvedSandboxConfigs.get(serverName);
    if (!resolved) throw new Error(`Missing sandbox config for server "${serverName}"`);
    const confined = resolved.sandboxed && resolved.config.confineToRoots === true;

    // srt entries the relay adds beyond the resolved config (an OAuth
    // server's per-session credential directory).
    const extraAllowRead: string[] = [];
    const extraAllowWrite: string[] = [];

    // ── OAuth token injection for servers backed by OAuth providers ──
    const oauthEnv: Record<string, string> = {};
    const oauthProvider = getProviderForServer(serverName);
    if (oauthProvider) {
      // A malformed credentials file throws. Skip just this server, as for a
      // missing one: the pipeline runs every server in one relay, so letting
      // the error escape would take the others down with it.
      let clientCreds: ReturnType<typeof loadClientCredentials>;
      try {
        clientCreds = loadClientCredentials(oauthProvider);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emitProxyDiagnostic(
          'WARNING',
          `Skipping MCP server "${serverName}": its OAuth credentials could not be loaded: ${message}. Re-import them with 'ironcurtain auth import ${oauthProvider.id} <file>'`,
          sessionLogPath,
        );
        continue;
      }
      if (!clientCreds) {
        emitProxyDiagnostic(
          'WARNING',
          `Skipping MCP server "${serverName}": no OAuth credentials. Run 'ironcurtain auth import ${oauthProvider.id} <file>'`,
          sessionLogPath,
        );
        continue;
      }

      const tokenProvider = new OAuthTokenProvider(oauthProvider, clientCreds);
      if (!tokenProvider.isAuthorized()) {
        emitProxyDiagnostic(
          'WARNING',
          `Skipping MCP server "${serverName}": not authorized. Run 'ironcurtain auth ${oauthProvider.id}'`,
          sessionLogPath,
        );
        continue;
      }

      try {
        const accessToken = await tokenProvider.getValidAccessToken();
        const storedToken = loadOAuthToken(oauthProvider.id);
        if (!storedToken) {
          throw new Error(`Token file disappeared after validation for "${oauthProvider.id}"`);
        }

        // Create per-session credential directory
        const credsDir = join(settingsDir, `${serverName}-creds`);
        writeGWorkspaceCredentialFile(credsDir, accessToken, storedToken.expiresAt, storedToken.scopes);

        // Inject env vars for the MCP server
        oauthEnv.GWORKSPACE_CREDS_DIR = credsDir;
        oauthEnv.CLIENT_ID = clientCreds.clientId;
        oauthEnv.CLIENT_SECRET = clientCreds.clientSecret;

        // Redirect npm cache into the credential directory for npx sandbox compatibility
        oauthEnv.npm_config_cache = join(credsDir, '.npm-cache');

        // Start proactive token refresh
        const refresher = new TokenFileRefresher(
          {
            providerId: oauthProvider.id,
            getAccessToken: async () => {
              // Force refresh: match the refresher's 10-min threshold
              // (getValidAccessToken's 5-min threshold would skip near-expiry tokens)
              const token = await tokenProvider.forceRefresh();
              const stored = loadOAuthToken(oauthProvider.id);
              if (!stored) {
                throw new Error(`Token file missing for "${oauthProvider.id}"`);
              }
              return { accessToken: token, expiresAt: stored.expiresAt, scopes: stored.scopes };
            },
            writeCredentialFile: (token, expiry, scopes) => {
              writeGWorkspaceCredentialFile(credsDir, token, expiry, scopes);
            },
            logToSession: sessionLogPath ? (msg) => logToSessionFile(sessionLogPath, msg) : undefined,
          },
          storedToken.expiresAt,
        );
        refresher.start();
        tokenRefreshers.set(serverName, refresher);

        // The sandboxed server must read and write the credential directory.
        extraAllowRead.push(credsDir);
        extraAllowWrite.push(credsDir);

        if (sessionLogPath) {
          logToSessionFile(
            sessionLogPath,
            `[proxy] OAuth token prepared for "${serverName}" (provider: ${oauthProvider.id})`,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emitProxyDiagnostic(
          'WARNING',
          `Skipping MCP server "${serverName}": OAuth token error: ${message}. Run 'ironcurtain auth ${oauthProvider.id}'`,
          sessionLogPath,
        );
        continue;
      }
    }

    // Node paths (and an OAuth credential directory) in one rewrite of the
    // settings resolveServerSandboxConfigs wrote. A confined server's
    // settings are written whole on every launch instead (below).
    if (resolved.sandboxed && !confined) {
      const allowRead = [...dynamicNodePaths, ...extraAllowRead];
      if (allowRead.length > 0 || extraAllowWrite.length > 0) {
        const settingsPath = join(settingsDir, `${serverName}.srt-settings.json`);
        rewriteServerSettings(settingsPath, { allowRead, allowWrite: extraAllowWrite });
      }
    }

    // Docker-based servers (e.g. github) run under the Apple `container`
    // CLI on machines that have that runtime instead of Docker.
    const spawnSpec = resolveContainerSpawnCommand(config.command, config.args);
    if (spawnSpec.translated) {
      emitProxyDiagnostic(
        'WARNING',
        `MCP server "${serverName}": docker not found; running via the Apple container CLI instead`,
        sessionLogPath,
      );
    }

    const serverCwd = serverCwdPaths.get(serverName);
    if (!serverCwd) throw new Error(`Missing working directory for server "${serverName}"`);

    let backendEnv: Record<string, string>;
    try {
      backendEnv = buildBackendEnv(serverName, config, {
        sandboxed: resolved.sandboxed,
        serverCredentials,
        oauthEnv,
        allowedDirectory,
        serverCwd,
      });
    } catch (err) {
      // Fail closed: a backend whose required hardening cannot be built is
      // never started, so its tools stay unregistered and calls are denied.
      emitProxyDiagnostic(
        'WARNING',
        `Skipping MCP server "${serverName}": cannot build its hardened environment: ${err instanceof Error ? err.message : String(err)}`,
        sessionLogPath,
      );
      tokenRefreshers.get(serverName)?.stop();
      tokenRefreshers.delete(serverName);
      continue;
    }
    if (isGitBackend(serverName) && sessionLogPath) {
      const ceiling = 'GIT_CEILING_DIRECTORIES' in backendEnv ? backendEnv.GIT_CEILING_DIRECTORIES : '<unset>';
      logToSessionFile(
        sessionLogPath,
        `[proxy] "${serverName}": hardened git environment ` +
          `(GIT_ALLOW_PROTOCOL=${backendEnv.GIT_ALLOW_PROTOCOL}, GIT_CEILING_DIRECTORIES=${ceiling})`,
      );
    }

    // Redact credentials, OAuth env and the host values the server's `-e NAME`
    // arguments forward from the backend's stderr before it reaches the
    // session log (streamed lines and failure diagnostics).
    const redact = backendStderrRedactor(config, backendEnv, serverCredentials, oauthEnv);

    let state: ClientState;
    try {
      if (confined) {
        // Launched with its program resolved here and every path canonical,
        // under a profile for the current roots; the supervisor restarts it
        // when they change.
        const launch = resolveConfinedLaunch(spawnSpec.command, spawnSpec.args, backendEnv);
        const spec: ConfinedBackendSpec = {
          params: resolved.config,
          launch,
          extraAllowRead: [...dynamicNodePaths, ...extraAllowRead],
          extraAllowWrite,
          env: launch.pathEnv === undefined ? backendEnv : { ...backendEnv, PATH: launch.pathEnv },
          cwd: serverCwd,
          redact,
        };
        confinedSpecs.set(serverName, spec);
        const rootDirectories = confinedRootDirectories(relayRoots, sessionSandboxDir);
        state = await launchConfinedBackend(serverName, spec, rootDirectories, settingsDir, relayRoots, sessionLogPath);
        confinedBackends.register(serverName, rootDirectories);
      } else {
        const wrapped = wrapServerCommand(serverName, spawnSpec.command, spawnSpec.args, resolved, settingsDir);
        state = await connectBackendClient(
          serverName,
          { command: wrapped.command, args: wrapped.args, env: backendEnv, cwd: serverCwd },
          relayRoots,
          sessionLogPath,
          redact,
        );
      }
    } catch (err) {
      // Per-server graceful degradation: an unconnectable backend (binary
      // missing, container runtime down, server crash on startup, an OS
      // sandbox that cannot start) is skipped with a diagnostic, like the
      // missing-env-var and OAuth paths above. When this leaves the relay
      // with zero backends, the proxyCanServe guard below exits non-zero
      // and the parent skips the relay — a startup failure never silently
      // widens or narrows policy, since unregistered tools are denied by
      // default. connectBackendClient already redacted the stderr it quotes.
      emitProxyDiagnostic(
        'WARNING',
        `Skipping MCP server "${serverName}": ${err instanceof Error ? err.message : String(err)}`,
        sessionLogPath,
      );
      confinedSpecs.delete(serverName);
      // This server is being skipped; stop the OAuth refresher started for it
      // above so it does not keep running force-refresh loops for a backend
      // that never connected (shutdown-time cleanup would otherwise be the
      // only thing that stops it).
      const orphanedRefresher = tokenRefreshers.get(serverName);
      if (orphanedRefresher) {
        orphanedRefresher.stop();
        tokenRefreshers.delete(serverName);
      }
      continue;
    }
    clientStates.set(serverName, state);

    const result = await state.client.listTools();
    for (const tool of result.tools) {
      allTools.push({
        serverName,
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
    }
  }

  // Exit non-zero so the parent's `MCPClientManager.connect()` fails the
  // handshake -- the existing try/catch in `connectBackendSubprocesses`
  // skips the server without reaching `registerTools`.
  if (!proxyCanServe(serversConfig, clientStates.size)) {
    const serverNames = Object.keys(serversConfig).join(', ');
    emitProxyDiagnostic(
      'ERROR',
      `proxy subprocess for SERVER_FILTER="${serverFilter ?? '<unset>'}" has no connected backend (configured: ${serverNames}); exiting`,
      sessionLogPath,
    );
    for (const refresher of tokenRefreshers.values()) {
      refresher.stop();
    }
    for (const dir of scratchDirs) cleanupSettingsFiles(dir);
    process.exit(1);
  }

  // In virtual-only mode (SERVER_FILTER=proxy), register proxy tool definitions
  // and create the control API client for communicating with the MITM proxy.
  const isVirtualOnlyMode = serverFilter === 'proxy' && Object.keys(serversConfig).length === 0;
  let controlApiClient: ControlApiClient | null = null;

  if (isVirtualOnlyMode) {
    for (const toolDef of proxyToolDefinitions) {
      allTools.push({
        serverName: 'proxy',
        name: toolDef.name,
        description: toolDef.description,
        inputSchema: toolDef.inputSchema,
      });
    }

    const mitmControlAddr = process.env.MITM_CONTROL_ADDR;
    if (!mitmControlAddr) {
      throw new Error(
        'MITM_CONTROL_ADDR must be set when running in virtual-only proxy mode ' +
          '(SERVER_FILTER=proxy with no other MCP servers).',
      );
    }
    controlApiClient = createControlApiClient(mitmControlAddr, { token: process.env.MITM_CONTROL_TOKEN });
  }

  // Defense-in-depth: the relay's CallTool handler routes by bare
  // tool name, so two backends exposing the same tool name would
  // silently collide and route to the wrong server. Fail fast if we
  // ever end up with such a collision in the loaded tool set.
  assertUniqueToolNames(allTools);

  const toolMap = buildToolMap(allTools);
  const toolDescriptionHints = loadToolDescriptionHints();
  const hintedTools = applyToolDescriptionHints(allTools, toolDescriptionHints);
  const listToolsResponse = {
    tools: hintedTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  };

  // ── Create the proxy MCP server ───────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- intentional use of low-level Server for raw JSON schema passthrough
  const server = new Server({ name: 'ironcurtain-proxy', version: VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, () => listToolsResponse);

  // ── Roots bridging (coordinator → relay → backends) ───────────────
  // The coordinator in the parent process is the authoritative source
  // of MCP roots. On escalation approval it expands its roots and
  // sends `notifications/roots/list_changed` to this relay. We fetch
  // the fresh list from the coordinator via `server.listRoots()`,
  // replace `relayRoots` in place, and propagate the notification to
  // every backend client so they re-query via their `roots/list`
  // handlers (registered in connectBackendClient). A backend confined
  // to its roots is restarted instead when the directories its OS
  // profile must expose changed (ConfinedBackendSupervisor); the
  // coordinator's roots verification then reads the new server's
  // allowed directories (tool calls wait for the restart, see below).
  server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
    try {
      const { roots: updatedRoots } = await server.listRoots();
      // Replace contents in-place so all backend clientStates -- which
      // share the same array reference as `relayRoots` -- see the new
      // set on their next `roots/list` call. MCP `Root.name` is
      // optional in the spec; fall back to the URI so our internal
      // `name: string` contract holds.
      relayRoots.length = 0;
      for (const r of updatedRoots) {
        relayRoots.push({ uri: r.uri, name: r.name ?? r.uri });
      }
    } catch (err) {
      if (sessionLogPath) {
        const msg = err instanceof Error ? err.message : String(err);
        logToSessionFile(sessionLogPath, `[proxy] Failed to fetch roots from coordinator: ${msg}`);
      }
      return;
    }

    const confinedRoots = confinedRootDirectories(relayRoots, sessionSandboxDir);
    await Promise.all(
      [...clientStates.entries()].map(async ([backendName, state]) => {
        if (confinedBackends.manages(backendName)) {
          const outcome = await confinedBackends.applyRoots(backendName, confinedRoots);
          if (outcome === 'stopped') {
            emitProxyDiagnostic(
              'ERROR',
              `MCP server "${backendName}" was stopped: it could not be restarted under an OS sandbox for its new roots`,
              sessionLogPath,
            );
          }
          return;
        }
        try {
          await state.client.sendRootsListChanged();
        } catch (err) {
          if (sessionLogPath) {
            const msg = err instanceof Error ? err.message : String(err);
            logToSessionFile(sessionLogPath, `[proxy] sendRootsListChanged to backend failed: ${msg}`);
          }
        }
      }),
    );
  });

  // Pass-through CallTool handler: forward to the backend client,
  // return the raw result. No policy evaluation -- the coordinator
  // in the parent process handles that.
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const toolInfo = toolMap.get(req.params.name);
    if (!toolInfo) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }],
        isError: true,
      };
    }

    // Virtual proxy tools stay local -- they speak to the MITM control
    // socket via the ControlApiClient and never reach a backend MCP server.
    const rawArgs = req.params.arguments ?? {};
    if (!hasBoundedArgumentStructure(rawArgs)) {
      return { content: [{ type: 'text', text: ARGUMENT_BUDGET_DENY_RESULT.reason }], isError: true };
    }
    if (toolInfo.serverName === 'proxy' && controlApiClient) {
      try {
        const result = await handleVirtualProxyTool(toolInfo.name, rawArgs, controlApiClient);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `Error: ${errorMessage}` }], isError: true };
      }
    }

    // A confined backend being restarted for new roots is waited for, so
    // the call reaches the server whose OS profile matches the roots.
    await confinedBackends.settled(toolInfo.serverName);
    const clientState = clientStates.get(toolInfo.serverName);
    if (!clientState) {
      return {
        content: [{ type: 'text', text: `Internal error: no client connection for server "${toolInfo.serverName}"` }],
        isError: true,
      };
    }

    // Bound the backend call explicitly and relay its progress back to the
    // coordinator when the coordinator asked for progress (see
    // backendCallRequestOptions).
    const progressToken = req.params._meta?.progressToken;
    const forwardProgress =
      progressToken !== undefined
        ? (progress: Progress): void => {
            extra
              .sendNotification({ method: 'notifications/progress', params: { ...progress, progressToken } })
              .catch(() => {
                /* the coordinator is gone; the call result reports that */
              });
          }
        : undefined;
    const callOptions = backendCallRequestOptions(backendCallTimeoutMs, forwardProgress, extra.signal);
    try {
      const result = await inFlightCalls.track(
        clientState,
        clientState.client.callTool(
          { name: toolInfo.name, arguments: rawArgs },
          CompatibilityCallToolResultSchema,
          callOptions,
        ),
      );
      // The backend's structuredContent travels with its content: the relay
      // forwards what the server said and leaves to the coordinator (and the
      // Code Mode bridge) what reaches the agent.
      return {
        content: result.content,
        ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
        ...(result.isError ? { isError: true } : {}),
      };
    } catch (err) {
      const errorMessage = extractMcpErrorMessage(err);
      return { content: [{ type: 'text', text: `Error: ${errorMessage}` }], isError: true };
    }
  });

  // ── Transport selection ───────────────────────────────────────────
  let shuttingDown = false;
  let transport: Transport;
  if (transportConfig.kind === 'tcp') {
    const tcpTransport = new TcpServerTransport(transportConfig.host, transportConfig.port, {
      requiredToken: transportConfig.requiredToken,
    });
    transport = tcpTransport;
    await tcpTransport.start();
    if (transportConfig.portFilePath) {
      writeFileSync(transportConfig.portFilePath, String(tcpTransport.port));
    }
    if (sessionLogPath) {
      logToSessionFile(sessionLogPath, `MCP proxy listening on 127.0.0.1:${tcpTransport.port}`);
    }
  } else if (transportConfig.kind === 'uds') {
    transport = new UdsServerTransport(transportConfig.socketPath);
  } else {
    guardStdioStreamErrors();
    transport = new StdioServerTransport();
    // Stdio is the relay's ownership channel. A graceful parent close and an
    // uncatchable parent crash both surface as EOF here; route either through
    // the same teardown that signals and reaps every backend subprocess.
    // Register before connect() starts reading so an already-buffered EOF
    // cannot race the listener installation.
    process.stdin.once('end', () => void shutdown());
    process.stdin.once('close', () => void shutdown());
  }
  await server.connect(transport);

  // ── Shutdown handler ──────────────────────────────────────────────
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    // A confined backend that finishes restarting from here on is closed
    // at once instead of being swapped in.
    confinedBackends.close();

    // Stop token refreshers before closing clients
    for (const refresher of tokenRefreshers.values()) {
      refresher.stop();
    }
    tokenRefreshers.clear();

    for (const state of clientStates.values()) {
      try {
        await state.client.close();
      } catch {
        /* ignore */
      }
    }
    for (const dir of scratchDirs) cleanupSettingsFiles(dir);
    try {
      await server.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  }

  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
}

// Only run main() when this module is the entry point (not when imported for testing)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`MCP Proxy Server fatal error: ${String(err)}\n`);
    process.exit(1);
  });
}
