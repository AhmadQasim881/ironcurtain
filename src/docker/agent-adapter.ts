/**
 * Agent adapter interface and supporting types.
 *
 * Each supported external agent (Claude Code, Goose, etc.) has an adapter
 * that handles its specific configuration needs: Docker image, MCP client
 * config format, system prompt injection, and output parsing.
 */

import type { DockerAuthKind, IronCurtainConfig } from '../config/types.js';
import { USER_CONFIG_DEFAULTS, type ResolvedResourceBudgetConfig } from '../config/user-config.js';
import type { DockerWorkloadNetworkAccess } from '../docker-workload/config.js';
import type { ProviderConfig } from './provider-config.js';
import type { ServerListing } from '../types/server-listing.js';
import type { AuthMethod } from './oauth-credentials.js';
import type { AgentCliVersionSupport } from './agent-cli-version.js';

/**
 * The workspace directory inside Docker containers. The host sandbox
 * directory is bind-mounted at this path. Used for path rewriting
 * between container and host in both directions.
 */
export { CONTAINER_WORKSPACE_DIR } from './container-workspace.js';

/** Workflow package helper scripts are mounted read-only at this path. */
export const CONTAINER_SCRIPTS_DIR = '/workflow-scripts';

/**
 * Structured response from an agent adapter, carrying both the
 * text response and optional cost/usage metadata reported by the agent.
 */
export interface AgentResponse {
  /** The agent's text response. */
  readonly text: string;
  /** Cumulative session cost in USD, if reported by the agent. */
  readonly costUsd?: number;
  /**
   * Set when the agent process was killed or crashed before producing
   * any output (e.g., upstream provider closed the stream mid-generation).
   * Signals to callers that a retry with a fresh conversation id is
   * appropriate; a reprompt against the same id will fail because the
   * agent CLI considers the id consumed.
   */
  readonly hardFailure?: boolean;
  /**
   * Set when the adapter detected that the agent aborted because of
   * upstream quota exhaustion — the kind the agent CLI's own retry loop
   * cannot recover from within a reasonable window (e.g. a multi-hour
   * provider usage-limit reset, surfaced by Claude Code as an
   * `api_error_status: 429` JSON envelope with a human-readable
   * "limit will reset at ..." message).
   *
   * Adapters MUST populate this whenever their CLI surfaces such a
   * signal. The orchestrator will neither retry nor spend further
   * budget on a turn that sets it — it throws a dedicated error class
   * so the workflow can be paused and resumed once the quota window
   * opens instead of aborting. Leaving this undefined causes the
   * orchestrator to fall through to the generic abort path — acceptable
   * only when the adapter's CLI has no machine-readable quota signal.
   *
   * `rawMessage` is the original provider/CLI text, preserved for
   * diagnostics and CLI output. `resetAt` is optional because not every
   * provider emits a parseable timestamp; when absent the caller picks
   * a conservative default pause.
   */
  readonly quotaExhausted?: {
    readonly resetAt?: Date;
    readonly rawMessage: string;
  };
  /**
   * Set when the adapter detected a transient upstream failure that
   * produced a syntactically-valid envelope with no usable content —
   * for instance, a sustained LiteLLM/Z.AI stall surfaced by Claude Code
   * as `usage.output_tokens === 0` AND `stop_reason === null` while
   * `result` contains only the agent's preamble. The CLI exits 0 and
   * its JSON parses, but no assistant message was generated.
   *
   * Shaped as a discriminated union (`kind`) so future detected shapes
   * (`'connection_reset'`, etc.) can extend without a breaking change.
   * Current kinds:
   *   - `'degenerate_response'`: exit=0, output_tokens=0, stop_reason=null
   *     (sustained LiteLLM/Z.AI stall surfaced as an empty completion).
   *   - `'upstream_5xx'`: Claude Code's `api_error_status: 5xx` envelope,
   *     emitted after the SDK exhausts its internal retries against a
   *     transient provider 5xx (e.g. mid-SSE-stream abort during an
   *     Anthropic outage). The CLI exits non-zero with a synthetic
   *     `result` string ("API Error: 500 Internal server error. ...").
   *
   * Mirrors the contract of `quotaExhausted`: the orchestrator MUST
   * treat this as terminal-but-resumable, MUST NOT retry the turn (the
   * in-loop reprompt against a stalled upstream is hopeless), and MUST
   * preserve the checkpoint so `workflow resume` can re-enter the
   * failing state once the upstream is healthy.
   *
   * `rawMessage` is the original envelope/stdout, preserved for
   * diagnostics. Adapters that cannot produce this signal must leave
   * the field undefined; falling through to the generic abort path is
   * acceptable when the CLI offers no machine-readable transient
   * signal.
   */
  readonly transientFailure?: {
    readonly kind: TransientFailureKind;
    readonly rawMessage: string;
  };
  /**
   * The agent CLI's own identifier for the conversation this turn ran in,
   * for CLIs that mint one instead of accepting the caller's
   * `buildCommand` `sessionId` (Codex reports it as the `thread_id` of its
   * `thread.started` event). Adapters validate its shape before reporting it.
   *
   * The session records it against its agent conversation id (see
   * `recordStoredConversation` in `conversation-state.ts`) and hands it back
   * as `buildCommand` `agentThreadId` so later turns, and later sessions that
   * continue the same conversation, resume that thread. Agent-controlled
   * output: it can only select a conversation inside the same agent's state.
   */
  readonly agentThreadId?: string;
}

/**
 * Discriminant for the `transientFailure.kind` field. Exported as a single
 * source of truth so adding a new kind only requires editing one file.
 */
export type TransientFailureKind = 'degenerate_response' | 'upstream_5xx' | 'upstream_api_error';

/**
 * Maps the per-turn step budget to the agent CLI's own agentic-turn cap
 * (`claude -p --max-turns`, `GOOSE_MAX_TURNS`). `null` (operator disabled
 * the step limit) yields undefined so no cap is passed. A session config
 * always carries a resolved budget; a partially built one (hand-assembled by
 * a caller or a test) falls back to the shipped default rather than to
 * "uncapped".
 */
export function resolveMaxAgentTurns(config: {
  readonly userConfig?: { readonly resourceBudget?: Pick<ResolvedResourceBudgetConfig, 'maxSteps'> };
}): number | undefined {
  const resourceBudget = config.userConfig?.resourceBudget;
  const maxSteps =
    resourceBudget === undefined ? USER_CONFIG_DEFAULTS.resourceBudget.maxSteps : resourceBudget.maxSteps;
  if (maxSteps === null) return undefined;
  if (!Number.isSafeInteger(maxSteps) || maxSteps <= 0) {
    throw new Error(`resourceBudget.maxSteps must be a positive integer, got ${String(maxSteps)}`);
  }
  return maxSteps;
}

/**
 * Human-readable description of a transient-failure kind, used in
 * user-facing terminal-status text and error messages. Centralized so
 * adding a new kind forces an exhaustive switch update (TypeScript
 * errors here if the kind is unhandled).
 */
export function describeTransientFailureKind(kind: TransientFailureKind): string {
  switch (kind) {
    case 'degenerate_response':
      return 'agent returned no content (output_tokens=0, stop_reason=null)';
    case 'upstream_5xx':
      return 'upstream returned a 5xx error after SDK retries exhausted';
    case 'upstream_api_error':
      return "agent's API layer aborted the turn after internal retries (stalled stream or failed connection)";
  }
}

/**
 * Branded agent identifier to prevent mixing with other string types.
 */
export type AgentId = string & { readonly __brand: 'AgentId' };

/**
 * Where an agent CLI keeps its conversation transcripts inside the mounted
 * conversation-state directory. The host decides from the transcripts
 * themselves whether a conversation exists (a PTY snapshot's `resumable`, a
 * batch turn's resume-or-start choice), never from whether the directory is
 * non-empty: the seeds and settings files make every directory non-empty.
 * The probes live in `conversation-state.ts`.
 *
 *   - `'claude-projects'`: Claude Code, `projects/<cwd-hash>/<conversation-id>.jsonl`.
 *     The CLI accepts the caller's conversation id (`--session-id`).
 *   - `'codex-rollouts'`: Codex, `sessions/YYYY/MM/DD/rollout-<timestamp>-<thread-id>.jsonl`.
 *     The CLI mints the thread id and reports it in `thread.started`.
 *   - `'goose-sessions'`: Goose, the session store (`sessions.db`, or the
 *     `.jsonl` files of older releases) under `~/.local/share/goose/sessions/`.
 *     Sessions are named by the caller (`--name`).
 */
export type ConversationTranscriptLayout = 'claude-projects' | 'codex-rollouts' | 'goose-sessions';

/**
 * Configuration for persisting an agent's conversation state across
 * container restarts, enabling session resume.
 *
 * Each adapter that supports resume returns this from
 * `getConversationStateConfig()`. The generic infrastructure uses it
 * to create/mount a host-side state directory and to append resume
 * flags on subsequent runs.
 */
export interface ConversationStateConfig {
  /** Host-side subdirectory name within sessionDir (e.g., 'claude-state'). */
  readonly hostDirName: string;

  /** Container-side mount target (e.g., '/root/.claude/'). */
  readonly containerMountPath: string;

  /**
   * Files/directories to pre-populate on first session start.
   * Paths are relative to the host-side directory.
   *
   * When `content` is a string, a file is created with that content.
   * An empty string creates a directory instead.
   * When `content` is a function, it is called to produce the content;
   * returning `undefined` skips creation of that entry.
   */
  readonly seed: ReadonlyArray<{
    readonly path: string;
    readonly content: string | (() => string | undefined);
  }>;

  /**
   * CLI flag(s) the agent uses to continue a previous conversation.
   * Passed to the PTY start script on resume (`IRONCURTAIN_RESUME_FLAGS`,
   * e.g. ['--continue']). Each must match `--[a-z0-9-]+`. Empty when the
   * script resumes by id instead (Codex: `IRONCURTAIN_RESUME_ID`).
   */
  readonly resumeFlags: readonly string[];

  /** Where the CLI keeps transcripts in this directory (see {@link ConversationTranscriptLayout}). */
  readonly transcriptLayout: ConversationTranscriptLayout;
}

/**
 * A file to write into the container's orientation or config directory.
 */
export interface AgentConfigFile {
  /** Path relative to the orientation directory (or absolute in the container). */
  readonly path: string;
  /** File content. */
  readonly content: string;
  /** Optional file mode (e.g. 0o755 for executable scripts). */
  readonly mode?: number;
}

/**
 * Context passed to the adapter for generating orientation content.
 */
export interface OrientationContext {
  /** The sandbox directory path inside the container. */
  readonly workspaceDir: string;
  /** Server listings for progressive tool disclosure. */
  readonly serverListings: ServerListing[];
  /** Domains the agent may access via fetch MCP tool. */
  readonly allowedDomains: string[];
  /** Container network mode: 'none' (Linux UDS) or 'bridge' (macOS TCP). */
  readonly networkMode: 'none' | 'bridge';
  /**
   * True when the workspace is mounted read-only (a read-only workflow state
   * or scope, `IronCurtainConfig.readOnlyWorkspace`): the agent reads it with
   * its own tools and writes its declared outputs through the filesystem MCP
   * tool, which policy confines to them.
   */
  readonly workspaceReadOnly?: boolean;
  /**
   * Admitted nested-Docker capability for this session. Absent for ordinary
   * sessions and for configured workloads that failed admission.
   */
  readonly nestedDocker?: {
    /** Bundle-local managed network used for sibling service discovery. */
    readonly networkName: string;
    /** Admitted network authority for image resolution and fixed package repositories. */
    readonly networkAccess: DockerWorkloadNetworkAccess;
  };
}

/** Per-turn options for {@link AgentAdapter.buildCommand}; each field is described there. */
export interface AgentCommandOptions {
  readonly sessionId: string;
  readonly firstTurn: boolean;
  readonly agentThreadId?: string;
  readonly agentModelId?: string;
  readonly modelOverride?: string;
  readonly providerProfile?: import('../config/user-config.js').ResolvedProviderProfile;
  readonly maxAgentTurns?: number;
}

/**
 * An agent adapter encapsulates the differences between external agents.
 *
 * Each adapter knows:
 * - What Docker image to use
 * - How to configure MCP server discovery for the agent
 * - How to construct the docker exec command
 * - How to collect the agent's response
 */
export interface AgentAdapter {
  /** Unique identifier for this agent type. */
  readonly id: AgentId;

  /** Human-readable name for display. */
  readonly displayName: string;

  /**
   * Returns the Docker image to use for this agent.
   * May trigger a build if the image doesn't exist yet.
   */
  getImage(): Promise<string>;

  /**
   * Command that prints the installed agent CLI version, run against the built
   * image via {@link ContainerRuntime.probeImageVersion} (e.g.
   * `['claude', '--version']`). Infra prep checks the result once per image
   * build against {@link cliVersion} and logs it, as a warning when it is
   * outside the qualified range (a CLI bump can change semantics: issue #367).
   * Omit to skip the check for this adapter.
   */
  readonly versionProbe?: readonly string[];

  /**
   * The Dockerfile build arg that pins this agent's CLI, the pinned version and
   * the range qualified with this release (see `agent-cli-version.ts`). The
   * `agentCliVersions` config override, where the adapter allows one, selects
   * another version through the same build arg.
   */
  readonly cliVersion?: AgentCliVersionSupport;

  /**
   * Generates the MCP client configuration file that tells
   * the agent how to connect to IronCurtain's proxy.
   *
   * @param socketPath - container-side UDS path (e.g., /run/ironcurtain/proxy.sock)
   * @param config - per-session config. Codex reads `config.activeProviderProfile`
   *   to decide whether to emit the OpenRouter TOML root keys + provider table
   *   (§9.2). The profile MUST come from the per-session stamped `config`, never
   *   from a factory-captured value (§9 F1).
   */
  generateMcpConfig(socketPath: string, config: IronCurtainConfig): AgentConfigFile[];

  /**
   * Generates orientation documents that teach the agent about
   * the MCP-mediated environment.
   */
  generateOrientationFiles(context: OrientationContext): AgentConfigFile[];

  /**
   * Constructs the docker exec command for a turn.
   *
   * @param message - the user's message for this turn
   * @param systemPrompt - the orientation prompt
   * @param options - per-turn options:
   *   - sessionId: stable identifier for the conversation (e.g., for
   *     `claude --session-id <uuid>` / `--resume <uuid>`). Typically
   *     the session's UUID.
   *   - firstTurn: true when this is the first turn of a fresh
   *     conversation state; false when resuming an existing
   *     conversation. Adapters that don't distinguish may ignore.
   *   - agentThreadId: the CLI-minted conversation id an earlier turn
   *     reported for `sessionId` (see `AgentResponse.agentThreadId`), when
   *     one was recorded. Only adapters whose CLI mints its own id (Codex)
   *     read it; they resume it only when `firstTurn` is false.
   *   - agentModelId: the per-session config's qualified agent model
   *     (`config.agentModelId`: `--model`, a workflow model, the persona's
   *     `agentModelId` or the global one, as `buildSessionConfig` resolved
   *     it), the session default when no `modelOverride` applies. Passed
   *     per call because the registry keeps one adapter instance per
   *     process while a daemon reloads config for every session: adapters
   *     never capture config at construction (one persona's model must not
   *     leak into a later session of the same daemon).
   *     Adapters whose CLI does not take IronCurtain's agent model (Codex
   *     and Goose choose theirs through their own config) ignore it.
   *   - modelOverride: qualified model ID ("provider:model-name") to use
   *     for this turn instead of the session default. Adapters
   *     that cannot switch models per-turn (e.g., Goose reads `GOOSE_MODEL`
   *     at container start) must document their limitation.
   *   - maxAgentTurns: upper bound on agentic turns (LLM round-trips) for
   *     this one invocation, derived from `resourceBudget.maxSteps` via
   *     {@link resolveMaxAgentTurns}. Defence in depth only: a compromised
   *     agent can call the proxy directly, so the host still enforces the
   *     wall clock and the between-turn budget. Adapters whose CLI has no
   *     native cap ignore it.
   */
  buildCommand(message: string, systemPrompt: string, options: AgentCommandOptions): readonly string[];

  /**
   * Builds the system prompt to append to the agent's default system prompt.
   */
  buildSystemPrompt(context: OrientationContext): string;

  /**
   * Returns LLM provider configurations for this agent.
   * The MITM proxy uses these to build the host allowlist,
   * generate fake API keys, swap keys in requests, and filter endpoints.
   *
   * @param config - per-session config. Adapters read `config.activeProviderProfile`
   *   to decide whether to return the OpenRouter provider or the native providers.
   *   The profile MUST come from the per-session stamped `config`, never from a
   *   factory-captured value (§9 F1).
   * @param authKind - When 'oauth', returns providers configured for bearer
   *   token injection instead of header-based API key injection.
   */
  getProviders(config: IronCurtainConfig, authKind?: DockerAuthKind): readonly ProviderConfig[];

  /**
   * Constructs environment variables for the container.
   * Receives fake keys instead of real keys -- the real keys never
   * enter the container.
   *
   * @param fakeKeys - map of provider host -> fake sentinel key
   */
  buildEnv(config: IronCurtainConfig, fakeKeys: ReadonlyMap<string, string>): Readonly<Record<string, string>>;

  /**
   * Constructs additional environment variables for batch-mode containers.
   *
   * These variables are merged on top of {@link buildEnv} only for the
   * one-shot execution path driven by {@link buildCommand}. Interactive PTY
   * sessions intentionally do not receive them.
   */
  buildBatchEnv?(config: IronCurtainConfig, fakeKeys: ReadonlyMap<string, string>): Readonly<Record<string, string>>;

  /**
   * Parses the agent's output to extract the response and optional cost.
   *
   * IMPORTANT: adapters are the sole place where CLI-specific error
   * envelopes are translated into structured signals for the workflow
   * engine. In particular, when the underlying CLI exposes a
   * quota-exhaustion / rate-limit-exceeded signal (e.g. Claude Code's
   * `api_error_status: 429` JSON envelope), the adapter MUST surface
   * it via `AgentResponse.quotaExhausted`. See the Claude Code adapter
   * (`adapters/claude-code.ts`) for the canonical implementation.
   * Failing to surface this signal causes the orchestrator to treat
   * quota exhaustion as a generic abort, wasting the workflow run.
   *
   * @param exitCode - the container's exit code
   * @param stdout - captured stdout from the container
   * @param stderr - captured stderr from the container, useful for CLIs that
   *   report non-zero errors there instead of stdout
   */
  extractResponse(exitCode: number, stdout: string, stderr?: string): AgentResponse;

  /**
   * Returns the Docker container command for PTY mode.
   * When provided, the container runs this command directly instead of
   * `sleep infinity`, and the host attaches via a PTY proxy.
   *
   * Adapters that do not implement this method do not support PTY mode.
   *
   * @param systemPrompt - the orientation prompt (written to a file, not embedded in shell)
   * @param ptySockPath - the UDS path for the PTY listener (Linux), or undefined for TCP mode
   * @param ptyPort - the TCP port for the PTY listener (macOS), or undefined for UDS mode
   */
  buildPtyCommand?(
    systemPrompt: string,
    ptySockPath: string | undefined,
    ptyPort: number | undefined,
  ): readonly string[];

  /**
   * Returns the agent command for a runtime-native interactive exec.
   * Apple Container uses this instead of exposing a guest socat listener;
   * runtimes without native PTY exec continue to use {@link buildPtyCommand}.
   */
  buildPtyExecCommand?(): readonly string[];

  /**
   * Detects available credentials for this agent.
   *
   * When not implemented — OR when it returns `undefined` —
   * prepareDockerInfrastructure() falls back to detectAuthMethod()
   * (Anthropic OAuth + API key detection). Returning `undefined` lets an
   * adapter handle only a subset of cases (e.g. Claude Code returns an
   * api-key AuthMethod for an OpenRouter-only profile via B2a, but returns
   * `undefined` for a native profile to preserve today's OAuth+API-key
   * detection path). Returning `{ kind: 'none' }` is a DEFINITIVE "no
   * credentials" that makes infra prep throw — distinct from the
   * fall-through `undefined`.
   */
  detectCredential?(config: IronCurtainConfig): AuthMethod | undefined;

  /**
   * Error message to show when no credentials are detected, for the
   * per-session config (Goose names the session's configured provider).
   * When not set, the default Anthropic-oriented message is used.
   */
  credentialHelpText?(config: IronCurtainConfig): string;

  /**
   * Returns the conversation state configuration for this agent.
   * If undefined, the agent does not support conversation persistence
   * and sessions will not be marked as resumable.
   */
  getConversationStateConfig?(): ConversationStateConfig;

  /**
   * Skill-staging configuration. Absent on adapters that don't support
   * skills at all; when present, the bind mount is established and the
   * batch / PTY hooks fire.
   *
   * Grouped under one optional record so the all-or-nothing relationship
   * is type-enforced: callers need only check `adapter.skills` before
   * accessing `containerPath` / `batchArgs` / `ptyEnv`, and the required
   * inner `containerPath` makes the "batchArgs without containerPath"
   * shape unrepresentable.
   */
  readonly skills?: AgentSkillsConfig;
}

/**
 * Adapter-supplied configuration for skill staging.
 *
 * Set via {@link AgentAdapter.skills}. The required `containerPath` field
 * doubles as the gate: when absent (i.e. the whole `skills` field is
 * undefined on the adapter), no bind mount is established and the
 * optional `batchArgs` / `ptyEnv` fields are not consumed.
 */
export interface AgentSkillsConfig {
  /**
   * Absolute container path used as the bind-mount target for the
   * skills staging directory.
   *
   * Architectural invariant: this path MUST NOT nest under any other
   * mount target (e.g. a conversation-state mount). Nested bind mounts
   * are unreliable on Docker Desktop / macOS (silent empty inner
   * mount on 4.67.x; known Lima/Colima overlapping-mount bugs). Pick
   * a sibling path that is otherwise unused inside the container.
   *
   * The mount is established read-only; the agent cannot modify
   * skills mid-session (preserves the cached-stager assumption and
   * the per-state filter's correctness).
   *
   * Adapters whose native discovery expects a specific layout under
   * this path (e.g. Claude Code looks for `<add-dir>/.claude/skills/`)
   * should advertise the relevant prefix here and use
   * {@link batchArgs} / {@link ptyEnv} to point the CLI at the parent.
   */
  readonly containerPath: string;

  /**
   * Extra CLI tokens to append to batch-mode {@link AgentAdapter.buildCommand}
   * output when skills are mounted (e.g. Claude Code's
   * `['--add-dir', '<parent>']`).
   *
   * Treated opaquely by the session driver: the array is passed through
   * verbatim with no parsing or shape assumptions. Empty / undefined for
   * adapters that auto-discover skills from a fixed path (Goose).
   *
   * Setting this does NOT itself mount the skills dir — the bind mount
   * is created by docker-infrastructure when {@link containerPath} is
   * set; this hook only adjusts the agent CLI invocation.
   */
  readonly batchArgs?: readonly string[];

  /**
   * Environment variables the PTY-mode startup script reads to pick up
   * skill-discovery configuration. Merged opaquely into the container's
   * env when skills are mounted; the script (returned by the adapter's
   * {@link AgentAdapter.buildPtyCommand}) decides how to consume them.
   *
   * Kept separate from {@link batchArgs} because PTY mode runs a shell
   * script (not a direct exec), and pre-formatted CLI tokens don't
   * round-trip through env vars cleanly. Adapters that need both batch
   * args and PTY env (Claude Code uses `--add-dir <parent>` either way)
   * are responsible for keeping the two in sync.
   */
  readonly ptyEnv?: Readonly<Record<string, string>>;
}
