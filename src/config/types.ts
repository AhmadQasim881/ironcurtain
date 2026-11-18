import type { ResolvedUserConfig } from './user-config.js';
import type { SandboxAvailabilityPolicy } from './sandbox-policy.js';
import type { ReadOnlyWorkspace } from '../types/read-only-workspace.js';

/**
 * Auth kinds an adapter may receive. Subset of `AuthMethod['kind']` from
 * `docker/oauth-credentials.ts` minus `'none'`: by the time an adapter is
 * consulted, a credential has been resolved.
 */
export type DockerAuthKind = 'oauth' | 'apikey';

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
 * Invariant: `allowWrite` and `allowRead` always include the session
 * sandbox directory (injected at runtime, not specified here). Paths listed
 * here are *additional* directories beyond the sandbox; relative entries
 * resolve against it.
 *
 * Reads are allowed by default except for a baseline that every sandboxed
 * server gets whatever `denyRead` says: the IronCurtain home and the
 * per-user credential stores (see `BASELINE_CREDENTIAL_DENY_READ` in
 * `trusted-process/sandbox-integration.ts`). Use `denyRead` to block more.
 */
export interface SandboxFilesystemConfig {
  /** Additional directories the server may write to, beyond the session sandbox. Never inside the IronCurtain home. */
  readonly allowWrite?: string[];
  /**
   * Paths re-allowed for reads within denied regions (e.g., ~/.nvm within
   * denyRead: ["~"]). Naming a baseline credential-store entry exactly (e.g.
   * "~/.aws") opts the server out of that entry. Never inside the
   * IronCurtain home: such an entry is refused.
   */
  readonly allowRead?: string[];
  /**
   * Paths the server may not read, in addition to the baseline (unioned,
   * never replacing it). Defaults to ~/.ssh, ~/.gnupg and ~/.aws.
   */
  readonly denyRead?: string[];
  /** Directories the server may not write to, even within allowed paths. */
  readonly denyWrite?: string[];
  /**
   * Confine the server to its MCP roots (see
   * `trusted-process/roots-confinement.ts`). On top of the baseline, the
   * user's home directory, the temporary directories and the per-user
   * runtime directory are hidden from it; only its current roots (the
   * session sandbox, the policy's `paths.within` directories and roots
   * added after approved escalations) are exposed again, readable and
   * writable, together with what is needed to run its program. The relay
   * restarts the server with a new profile whenever its roots change,
   * because an OS sandbox cannot be widened from outside once it runs.
   *
   * For servers that reopen paths by name after validating them, such as
   * `@modelcontextprotocol/server-filesystem`: a directory swapped for a
   * symlink between the check and the use then cannot lead anywhere the
   * roots do not reach.
   */
  readonly confineToRoots?: boolean;
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
  /** Human-readable one-line description for tool discovery. */
  description?: string;
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
 * Defined in `sandbox-policy.ts`, which also holds the resolution rules.
 */
export type { SandboxAvailabilityPolicy };

export interface IronCurtainConfig {
  auditLogPath: string;
  /**
   * Audit logs the session's coordinator replays after `auditLogPath` to
   * restore taint when taint escalation is enabled
   * (`userConfig.taintEscalation`; see `trusted-process/taint-policy.ts`):
   * the audit logs of the bundles a resumed workflow run's earlier legs
   * minted. Set only by the workflow orchestrator's bundle factory.
   */
  taintReplayAuditLogPaths?: readonly string[];
  allowedDirectory: string;
  mcpServers: Record<string, MCPServerConfig>;
  protectedPaths: string[];
  generatedDir: string;
  /**
   * Directory for tool-annotations.json. When per-job policy is used
   * (cron mode), generatedDir points to the job-specific dir while
   * toolAnnotationsDir always points to the global annotations.
   * Defaults to generatedDir when not set. A file here that is not the
   * package's own is a user overlay, layered per server over the package
   * annotations by `loadGeneratedPolicy`.
   */
  toolAnnotationsDir?: string;
  /**
   * Task scope (`--task-scoped`): a task-scope directory (see
   * `config/task-scope-policy.ts`) whose compiled policy the coordinator
   * intersects with the policy in `generatedDir`. Set only by
   * `buildSessionConfig` (after validating it) and by the workflow bundle
   * factory; absent for an unscoped session. A directory that cannot be
   * loaded refuses the session rather than running it unscoped.
   */
  taskPolicyDir?: string;
  constitutionPath: string;
  /** Per-session escalation directory for file-based IPC with the proxy. Optional for backward compatibility. */
  escalationDir?: string;
  /** Per-session log file path for capturing child process output. Optional for backward compatibility. */
  sessionLogPath?: string;
  /**
   * Per-session LLM interaction log path. When set, the agent's LLM calls are
   * logged to this JSONL file as `userConfig.observability.llmInteractionLog`
   * says ('off' writes nothing).
   */
  llmLogPath?: string;
  /**
   * Per-session auto-approver LLM log path. When set, auto-approver LLM calls
   * are logged to this JSONL file, following the same setting.
   */
  autoApproveLlmLogPath?: string;
  /** AI SDK model ID for the interactive agent (e.g. 'anthropic:claude-sonnet-4-6'). */
  agentModelId: string;
  /** Escalation timeout in seconds (30-600). Controls how long to wait for human approval. */
  escalationTimeoutSeconds: number;
  /**
   * Bound for one backend MCP tool call in seconds. The relay subprocess
   * times the call out (resetting on progress notifications) and the
   * coordinator waits slightly longer for the relay. Optional: defaults to
   * `DEFAULT_BACKEND_CALL_TIMEOUT_MS` (see `trusted-process/call-timeouts.ts`);
   * not yet exposed through the user config file.
   */
  backendCallTimeoutSeconds?: number;
  /** Resolved user configuration. Provides API keys for model resolution. */
  userConfig: ResolvedUserConfig;
  /**
   * Controls behavior when OS-level sandboxing is unavailable for a server
   * that asks for it. `loadConfig()` always sets the resolved value
   * (environment override > config file > platform default). Configs built
   * by hand may omit it; readers use `effectiveSandboxPolicy()`, which then
   * falls back to the same resolution, never to a weaker mode.
   */
  sandboxPolicy?: SandboxAvailabilityPolicy;
  /**
   * Docker session authentication method.
   * Set by prepareDockerInfrastructure() after detecting credentials.
   * Adapters use this to choose between OAuth and API key env vars.
   */
  dockerAuth?: { readonly kind: DockerAuthKind };
  /**
   * The resolved provider profile active for this session. Stamped as the
   * FIRST step of prepareDockerInfrastructure() (before auth detection), from
   * the resolved modelProviders registry + the per-session providerProfileName.
   * When absent or `type: 'native'`, OpenRouter routing is not installed
   * (byte-identical to today). See docs/designs/openrouter-integration.md §9.
   */
  activeProviderProfile?: import('./user-config.js').ResolvedProviderProfile;
  /**
   * Read-only workspace confinement (a read-only workflow state or container
   * scope): Docker Agent Mode mounts the workspace read-only and runs without
   * nested Docker, and the coordinator's policy engine denies every change
   * outside `writablePaths`, whatever the compiled policy says. Set only
   * through `applyReadOnlyWorkspace` (`src/config/read-only-workspace.ts`),
   * which keeps those settings together. See `src/types/read-only-workspace.ts`.
   */
  readOnlyWorkspace?: ReadOnlyWorkspace;
  /**
   * Whether this is a PTY session. When true, the coordinator's
   * auto-approver trusts user-context.json only when the trusted host
   * front-end wrote it (source "mux-trusted-input", fresh timestamp).
   * Passed to the coordinator as `ToolCallCoordinatorOptions.isPtySession`;
   * no environment variable carries it. Set by PTY session orchestration
   * code.
   */
  isPtySession?: boolean;
  /**
   * Address of the MITM control API for dynamic domain management.
   * Format: "unix:///path/to/socket" or "http://127.0.0.1:PORT".
   * Only set in Docker Agent Mode sessions.
   */
  mitmControlAddr?: string;
  /**
   * Per-bundle bearer token the MITM control API requires on every request.
   * Minted by the MITM proxy at startup; set together with `mitmControlAddr`
   * and handed only to the control-API clients (never to the container).
   */
  mitmControlToken?: string;
  /**
   * Constitution scope that this session's human approvals are recorded under
   * in the host-side approval history (policy learning): `global`,
   * `persona:<name>` or `job:<id>` (see `src/audit/approval-history.ts`). Set
   * by the session layer from the policy it loads; unset means approvals are
   * not recorded (for example a session on the read-only policy). Passed to
   * the coordinator as `ToolCallCoordinatorOptions.approvalHistoryScope`.
   */
  approvalHistoryScope?: string;
}
