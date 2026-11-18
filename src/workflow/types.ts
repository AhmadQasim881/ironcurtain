import { randomUUID } from 'node:crypto';
import type { DockerAgent, ResolvedResourceBudgetConfig } from '../config/user-config.js';
import type { WorkflowBudget } from './resource-budget.js';
import type { WorkflowUsage } from './workflow-usage.js';
import type { AgentConversationId } from '../session/types.js';
import type { WhitelistCandidateIpc } from '../trusted-process/approval-whitelist.js';
import type { TrustedUserMessage } from '../trusted-process/escalation-context.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Directory name for workflow artifacts inside the agent workspace.
 * All artifact subdirectories (plan/, code/, reviews/, etc.) live under this.
 */
export const WORKFLOW_ARTIFACT_DIR = '.workflow';

/**
 * Reserved persona alias meaning "use the global policy".
 * When a workflow state specifies this as its persona, the session
 * factory strips the persona field (same as undefined), so the
 * session uses the default global compiled policy and memory.
 *
 * Any other persona value is passed through to `createSession()`,
 * which resolves it to a per-persona policy, memory, and prompt.
 */
export const GLOBAL_PERSONA = 'global';

/**
 * Sentinel value for an agent state's `skills:` field meaning "no skills
 * of any kind". Strictly stronger than `[]` (which still loads
 * user-global + persona skills); this disables every layer.
 */
export const SKILLS_NONE = 'none';

/**
 * Translate an agent state's `skills:` field into the subset of
 * `WorkflowBorrowOptions` that controls skill resolution. `disableAllSkills`
 * is mutually exclusive with `skillsDir` / `skillFilter`: when the sentinel
 * is present, only `disableAllSkills: true` is set; otherwise `skillsDir`
 * and `skillFilter` may co-occur. Used by both the orchestrator and the
 * run-state CLI so the invariant lives in one place.
 */
export function resolveWorkflowSkillsOptions(
  skills: readonly string[] | typeof SKILLS_NONE | undefined,
  skillsDir: string | undefined,
): {
  skillsDir?: string;
  skillFilter?: ReadonlySet<string>;
  disableAllSkills?: true;
} {
  if (skills === SKILLS_NONE) return { disableAllSkills: true };
  const result: { skillsDir?: string; skillFilter?: ReadonlySet<string> } = {};
  if (skillsDir !== undefined) result.skillsDir = skillsDir;
  if (Array.isArray(skills)) result.skillFilter = new Set(skills);
  return result;
}

/**
 * Default `containerScope` value assigned to agent states that do not
 * declare one explicitly. Every such state shares the workflow's primary
 * bundle. The orchestrator's scope-lookup path resolves
 * `stateConfig.containerScope ?? DEFAULT_CONTAINER_SCOPE` before dispatch.
 *
 * Scope strings are opaque Map lookup keys — they are never embedded in
 * filesystem paths (bundle directory names use the UUID `bundleId`).
 *
 * See `docs/designs/workflow-session-identity.md` §2.4 / §6.
 */
export const DEFAULT_CONTAINER_SCOPE = 'primary';

/** Reserved deterministic result verdict emitted when a declared result file cannot be read or parsed. */
export const DETERMINISTIC_RESULT_ERROR_VERDICT = 'result_file_error';

/**
 * Largest deterministic `timeoutMs` the schema accepts: the largest delay
 * Node's timers honour. Both runners (host process group, `docker exec`)
 * arm a timer with it, and a longer delay would fire after 1 ms.
 */
export const MAX_DETERMINISTIC_TIMEOUT_MS = 2_147_483_647;

/**
 * Gate idle timeout of a run that holds a shared container at a gate when
 * the workflow sets no `gateIdleTimeoutMinutes` (4 hours).
 */
export const DEFAULT_GATE_IDLE_TIMEOUT_MINUTES = 240;

/**
 * Largest `gateIdleTimeoutMinutes` the schema accepts (14 days), well below
 * the ~24.8-day limit of a Node timer delay.
 */
export const MAX_GATE_IDLE_TIMEOUT_MINUTES = 20_160;

// ---------------------------------------------------------------------------
// Branded identifiers
// ---------------------------------------------------------------------------

/**
 * Unique identifier for a workflow instance. Branded to prevent accidental
 * mixing with other string identifiers.
 */
export type WorkflowId = string & { readonly __brand: 'WorkflowId' };

/** Creates a new unique WorkflowId. */
export function createWorkflowId(): WorkflowId {
  return randomUUID() as WorkflowId;
}

/**
 * Every workflow id names a directory under a base directory
 * (`<baseDir>/<workflowId>/`), so an id must be one plain path segment.
 * Minted ids are UUIDs; imported legacy run directories may use any
 * letters, digits, `_` and `-`. Nothing else is accepted anywhere an id
 * arrives from outside (RPC params, CLI arguments, directory scans), so
 * `../x` can never reach a path join.
 */
export const WORKFLOW_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** True when `value` is a workflow id that is safe to use as a path segment. */
export function isSafeWorkflowId(value: unknown): value is WorkflowId {
  return typeof value === 'string' && WORKFLOW_ID_PATTERN.test(value);
}

/**
 * Thrown when a workflow id is not a single safe path segment. `code` is the
 * discriminant for catchers in other modules.
 */
export class InvalidWorkflowIdError extends Error {
  readonly code = 'WORKFLOW_INVALID_ID' as const;

  constructor(value: unknown) {
    super(`Invalid workflow ID ${JSON.stringify(value)}: use 1-128 letters, digits, "_" or "-"`);
    this.name = 'InvalidWorkflowIdError';
  }
}

/** Returns `value` as a {@link WorkflowId}, or throws {@link InvalidWorkflowIdError}. */
export function assertSafeWorkflowId(value: unknown): WorkflowId {
  if (!isSafeWorkflowId(value)) throw new InvalidWorkflowIdError(value);
  return value;
}

// ---------------------------------------------------------------------------
// Workflow definition types
// ---------------------------------------------------------------------------

export interface WorkflowDefinition {
  readonly name: string;
  readonly description: string;
  /**
   * When true, the workflow is omitted from the web UI — both the start
   * picker and the active/past-run tables. The CLI `workflow list` still
   * shows it. Use for smoke-test / fixture workflows that should remain
   * runnable from the CLI without cluttering the UI. Default: false.
   */
  readonly hidden?: boolean;
  readonly initial: string;
  readonly states: Record<string, WorkflowStateDefinition>;
  readonly settings?: WorkflowSettings;
}

export interface WorkflowSettings {
  /** Session mode. Default: 'docker'. */
  readonly mode?: 'docker' | 'builtin';
  /**
   * Default agent harness for Docker-mode agent states: one of
   * `DOCKER_AGENTS` (`claude-code`, `goose`, `codex`), checked at load
   * time. Default: 'claude-code'. A state's own `dockerAgent` overrides it;
   * see agent-harness.ts.
   */
  readonly dockerAgent?: DockerAgent;
  /**
   * Bound for the `isRoundLimitReached` guard. Default: 4. The guard is
   * workflow-wide: it fires once ANY state's visit count reaches this value,
   * so loops elsewhere in the workflow (a plan revised at a gate, say) spend
   * the same budget unless a transition resets their counts
   * (`resetVisitCounts`). For a per-state bound use `maxVisits` with
   * `isStateVisitLimitReached`.
   */
  readonly maxRounds?: number;
  /**
   * Legacy and ignored: git worktree management was never implemented, so no
   * code reads this path. Still accepted so existing manifests load; lint
   * WF017 warns.
   */
  readonly gitRepoPath?: string;
  /**
   * Number of synchronous evolve workers (concurrent lanes of a
   * `count: 'workers'` fan-out). Default: 1. At most `MAX_FAN_OUT_LANES`
   * (16, a validation error above it); lint warns above 4 (WF019). In a
   * shared container all lanes share one container's CPU and memory
   * ceiling, so cap this to that budget.
   */
  readonly workers?: number;
  /**
   * Optional system prompt text appended to the base system prompt
   * for ALL agent states in this workflow. Use for workspace
   * conventions, project-level context, or shared instructions.
   * Sent via --append-system-prompt.
   */
  readonly systemPrompt?: string;
  /**
   * Per-turn wall-clock timeout in seconds for agent sessions.
   * Overrides the global resourceBudget.maxSessionSeconds for this workflow.
   * Legacy alias for resourceBudget.maxSessionSeconds. Null disables the timeout.
   */
  readonly maxSessionSeconds?: number | null;
  /**
   * Partial resource limits: missing fields inherit global settings; null disables a limit.
   * Each agent session gets these limits on its own, so they do not bound the run as a
   * whole; `workflowBudget` does. In shared-container mode the token and cost limits also
   * bound each container as a whole: its MITM budget gate counts every state and lane of
   * the scope together (`docker/budget-gate.ts`).
   */
  readonly resourceBudget?: Partial<ResolvedResourceBudgetConfig>;
  /** Run-wide spend ceiling over every agent session, lane and resume of the run. */
  readonly workflowBudget?: WorkflowBudgetSettings;
  /** Output artifact names excluded from versioning (e.g., append-only journals). */
  readonly unversionedArtifacts?: readonly string[];
  /**
   * Default model ID for all agent states in this workflow.
   * Format: "provider:model-name" (e.g., "anthropic:claude-sonnet-4-6").
   * Can be overridden per state via `states.<name>.model`.
   * Takes precedence over `agentModelId` from user config but is
   * overridden by the `--model` CLI flag.
   */
  readonly model?: string;
  /**
   * When true, the workflow runs in shared-container mode: the engine
   * creates one DockerInfrastructure bundle at workflow start and
   * reuses it across all states. When false (default), each state
   * gets a fresh container (today's behavior).
   *
   * Shared-container mode is the prerequisite for policy hot-swap at
   * state transitions. See docs/designs/workflow-container-lifecycle.md.
   *
   * Ignored for builtin workflows (no Docker infrastructure to share).
   */
  readonly sharedContainer?: boolean;
  /**
   * Shared-container mode treats each `containerScope` as ONE trust domain.
   * Every state in a scope runs in the same container: processes an earlier
   * state leaves running, the read-write `~/.claude` (or `~/.codex`) state
   * mount and the pre-trusted `/workspace` (whose `.claude/settings.json`
   * hooks the agent CLI honours) all carry over into later states, and any
   * process in the container can reach the scope's MCP proxy socket, whose
   * calls are evaluated and audited under whichever persona is currently
   * loaded. A low-privilege persona that reads untrusted content can
   * therefore act with a later persona's policy.
   *
   * So validation rejects agent states of different personas in one scope
   * unless this flag is `true`, which states that the author accepts the
   * scope as a single trust domain (effectively the union of its personas'
   * policies). Give each persona its own `containerScope` instead to keep
   * their containers apart; the workspace itself stays shared by every state,
   * so files one state writes there still reach later ones. Only valid with
   * an effective shared container (`sharedContainer: true` in docker mode).
   * Default: false.
   */
  readonly allowMixedPersonas?: boolean;
  /**
   * When true, an aborted or failed shared-container workflow snapshots each
   * live container's writable layer on stop so resume can recreate the scope
   * from the recorded immutable image digest. Default: false.
   */
  readonly snapshotOnStop?: boolean;
  /**
   * Minutes a human gate may wait for a decision before the run is stopped
   * through the ordinary abort path: a `snapshotOnStop` snapshot, a
   * resumable checkpoint that re-raises the same gate on
   * `workflow resume`, and its containers and proxies released. A positive
   * number (fractions allowed) up to {@link MAX_GATE_IDLE_TIMEOUT_MINUTES};
   * `null` never stops a waiting run. When omitted, a run that holds a
   * shared container at the gate is stopped after
   * {@link DEFAULT_GATE_IDLE_TIMEOUT_MINUTES} and any other run waits
   * indefinitely (it holds nothing to release).
   */
  readonly gateIdleTimeoutMinutes?: number | null;
}

/**
 * `settings.workflowBudget`: a ceiling on what the whole run may use, summed
 * over every agent session of every state and fan-out lane and carried across
 * resumes (`WorkflowCheckpoint.usage`). An omitted or null field sets no
 * ceiling for that dimension.
 *
 * The orchestrator checks the ceiling before each state and each fan-out lane
 * step starts, so a run can pass it by at most what the state or step already
 * running uses (each session is still bounded by `resourceBudget`). A breach
 * ends the run in a resumable `aborted` terminal: raise the limit in the run's
 * `definition.json` copy and resume to continue.
 */
export interface WorkflowBudgetSettings {
  /**
   * Total tokens (input including cache reads and writes, plus output). Fails
   * closed: when some agent session's token usage cannot be observed (LLM
   * statistics disabled, or a provider route without usage observation), the
   * run stops at the next state instead of comparing against an undercount.
   */
  readonly maxTotalTokens?: number | null;
  /**
   * Summed host-derived cost of every agent session, in USD: the cost the
   * host observed for a Docker session's traffic, the price table estimate for
   * a builtin one. A Docker agent's own cost report is display-only and never
   * counted, so traffic the host does not price adds nothing.
   */
  readonly maxEstimatedCostUsd?: number | null;
  /**
   * Seconds the run spends running states. Time waiting at a human gate, and
   * time between an abort and a resume, does not count.
   */
  readonly maxWallClockSeconds?: number | null;
}

/**
 * State definition. Discriminated on `type`.
 */
export type WorkflowStateDefinition =
  AgentStateDefinition | HumanGateStateDefinition | DeterministicStateDefinition | TerminalStateDefinition;

export interface FanOutDefinition {
  /**
   * Lane multiplicity. `'workers'` defers to `settings.workers`; the
   * `number` branch is a per-state override for workflows that want a
   * fixed-width segment independent of the global worker count. Bounded
   * like `settings.workers` (`MAX_FAN_OUT_LANES`).
   */
  readonly count: 'workers' | number;
  /**
   * Join discipline. Only barrier joins are supported today (every lane
   * must complete before the segment exits); async joins are a future,
   * deliberately reviewed extension.
   */
  readonly join: 'barrier';
}

export interface LaneResourceRequest {
  readonly cpu?: number;
  readonly mem?: string;
  readonly gpu?: number;
}

export interface StateScheduleDefinition {
  readonly pool: 'eval' | 'agent';
  readonly resources?: LaneResourceRequest;
}

/** What an agent state may do to the workspace (`AgentStateDefinition.workspaceAccess`). */
export type WorkspaceAccess = 'read-write' | 'read-only';

/** Accepted `workspaceAccess` values, for the schema and error messages. */
export const WORKSPACE_ACCESS_VALUES: readonly [WorkspaceAccess, ...WorkspaceAccess[]] = ['read-write', 'read-only'];

export interface AgentStateDefinition {
  readonly type: 'agent';
  readonly description: string;
  readonly persona: string;
  /**
   * Role instructions for the agent. Embedded in the full prompt assembled
   * by the orchestrator; see `buildFirstVisitPrompt` / `buildReVisitPrompt`
   * in prompt-builder.ts for the section layout. The role prompt is
   * positioned for recency bias on first visit; re-invocations reuse the
   * conversation history via `--continue`.
   */
  readonly prompt: string;
  /**
   * Input artifact names assembled into the agent's command.
   * Trailing `?` marks optional inputs (no error if absent).
   */
  readonly inputs: readonly string[];
  /** Output artifact names the agent is expected to produce. */
  readonly outputs: readonly string[];
  /**
   * Opt-in fallback for non-routing producer states. When status recovery is
   * exhausted, the orchestrator may hand off to the sole validator edge only
   * if every listed non-empty regular file exists under a declared output.
   */
  readonly artifactHandoff?: {
    readonly requiredFiles: readonly string[];
  };
  /** Transitions evaluated in order; first match wins. */
  readonly transitions: readonly AgentTransitionDefinition[];
  /**
   * Legacy field from the old per-instance parallel model (one git
   * worktree per parallel instance). Ignored: no git worktree is ever
   * created, and native fan-out lanes are scheduled by the pump, not by
   * per-state worktree opt-in. Retained for backward compatibility with
   * existing manifests (lint WF017 warns); do not wire new behavior to it.
   */
  readonly worktree?: boolean;
  /**
   * Marks this state as a member of a parent fan-out segment. Parent fan-out
   * states factor these members into child round machines at runtime.
   */
  readonly fanOutMember?: boolean;
  /** Fan-out topology metadata for a parent segment driver state. */
  readonly fanOut?: FanOutDefinition;
  /** Ordered fan-out segment member state IDs. */
  readonly segment?: readonly string[];
  /**
   * Scheduling metadata for lane-local execution. Schema-only until Phase 8
   * (the evaluation-slot pool): nothing reads it, so neither the pool nor
   * `resources` has any effect yet. Lint WF018 warns.
   */
  readonly schedule?: StateScheduleDefinition;
  /**
   * When false, re-invocations of this state resume the previous agent
   * session via --continue, receiving an abbreviated re-visit prompt.
   * Use this for iterative refinement loops where the agent benefits
   * from retaining its prior reasoning (e.g., harness design/build after
   * critique feedback).
   *
   * Default: true (each invocation starts a fresh session, bootstrapping
   * from artifacts on disk).
   */
  readonly freshSession?: boolean;
  /**
   * Per-state model override. Format: "provider:model-name".
   * Takes precedence over `settings.model` at the workflow level.
   * Overridden only by the `--model` CLI flag.
   */
  readonly model?: string;
  /**
   * Per-state agent harness (Docker mode): one of `DOCKER_AGENTS`. Takes
   * precedence over `settings.dockerAgent`, so a workflow can run its coder
   * on one harness and its reviewer on another. Under `sharedContainer:
   * true` the harness belongs to the container scope (one container, built
   * from one harness image): every agent state in a scope must resolve to
   * the same harness, so a state on a different harness needs its own
   * `containerScope`. Rejected in builtin mode, which runs no container.
   * Resolution lives in agent-harness.ts.
   */
  readonly dockerAgent?: DockerAgent;
  /**
   * Per-state visit cap. When set, the `isStateVisitLimitReached` guard
   * returns true once `context.visitCounts[stateId] >= maxVisits`. Use
   * this to bound an iterative loop (e.g., harness_design_review) and
   * route to a human gate once the cap is reached. Independent of the
   * workflow-level `maxRounds` setting.
   *
   * Because visit counts are incremented on state entry (before
   * `invoke`), the guard fires on the onDone transitions of the Nth
   * visit — i.e., after the Nth invocation completes.
   *
   * Only that guard on this state's own transitions reads the cap, so
   * without such a transition (or on a fan-out parent, which counts no
   * visits) it has no effect; lint WF016 warns.
   */
  readonly maxVisits?: number;
  /**
   * Container scope label. States sharing a scope share a bundle (one
   * container, one coordinator, one audit log, one control socket);
   * states with different scopes live in different bundles. When unset,
   * defaults to `"primary"`, so every state lands on the workflow's
   * primary bundle by default.
   *
   * Meaningful only under `sharedContainer: true`. Under
   * `sharedContainer: false` (legacy default, one container per state)
   * declaring a `containerScope` is a validation error — silent no-ops
   * are footguns; we reject at validate.ts.
   *
   * Charset: `/^[a-zA-Z0-9_-]+$/`. Scope strings are opaque Map lookup
   * keys — they are NEVER embedded in filesystem paths; the on-disk
   * bundle directory name is the UUID `bundleId`, not the scope.
   *
   * See `docs/designs/workflow-session-identity.md` §2.4.
   */
  readonly containerScope?: string;
  /**
   * Least privilege for states that only judge others' work (reviewers,
   * critics, validators). Default `read-write`.
   *
   * `read-only`: the state may read the whole workspace but change nothing
   * except its declared output directories (`.workflow/<output>/` for each
   * name in `outputs`), whatever its persona's policy allows:
   *
   * - Docker mode mounts `/workspace` read-only and runs the state without
   *   nested Docker, so the agent's own tools cannot change it. It writes its
   *   outputs through the filesystem MCP tool instead (the prompt says how).
   * - In every mode the policy engine denies each MCP call that would write,
   *   delete or rewrite git history outside those directories, and every
   *   git call that would change a repository (git acts on the repository
   *   that contains its path), before the compiled rules, so no rule,
   *   approval or whitelist can allow it.
   *
   * In shared-container mode the read-only mount belongs to the scope's one
   * container, so every agent state of a `containerScope` must have the same
   * access: give read-only states their own scope. Not allowed on fan-out
   * states, and output names must be plain relative paths (validate.ts).
   * The confinement covers the workspace and the host filesystem; calls to
   * remote services (GitHub, mail) stay governed by the persona's policy.
   */
  readonly workspaceAccess?: WorkspaceAccess;
  /**
   * Per-state filter on workflow-package skills (`<workflow-pkg>/skills/`).
   * When omitted (default), the state receives every workflow-package
   * skill. When set to an array, only the named entries from the
   * workflow package are layered in — referenced names that do not
   * exist as `<workflow-pkg>/skills/<name>/SKILL.md` fail validation at
   * workflow load. User-global skills always apply regardless of this
   * field. The literal sentinel `'none'` is a true off-switch: no skills
   * of any kind (workflow-package, user-global, or persona) are loaded
   * for the state.
   */
  readonly skills?: readonly string[] | typeof SKILLS_NONE;
}

export interface HumanGateStateDefinition {
  readonly type: 'human_gate';
  readonly description: string;
  /** Event types this gate accepts. Each maps to a HUMAN_* WorkflowEvent. */
  readonly acceptedEvents: readonly HumanGateEventType[];
  /** Artifact names to present to the human for review. */
  readonly present?: readonly string[];
  /**
   * Transitions keyed by accepted event type.
   * Each transition specifies which event triggers it and where to go.
   */
  readonly transitions: readonly HumanGateTransitionDefinition[];
}

export interface DeterministicStateDefinition {
  readonly type: 'deterministic';
  readonly description: string;
  /**
   * Commands to execute. Each command is an array of [binary, ...args].
   * Never a shell string -- per CLAUDE.md safe coding rules.
   */
  readonly run: readonly (readonly string[])[];
  /**
   * When true, execute the command arrays inside the workflow's shared
   * Docker container via docker exec (requires `mode: docker` and
   * `settings.sharedContainer: true`). Otherwise they run on the host, which
   * requires `host: true`.
   */
  readonly container?: boolean;
  /**
   * Explicit acknowledgement that this state's commands run on the host.
   * Validation rejects a non-container deterministic state that runs a
   * command unless it sets `host: true`; it is mutually exclusive with
   * `container: true`.
   *
   * Host commands run as the user running IronCurtain, with that user's
   * network access and environment, outside the container and the policy
   * engine, with the run workspace as their working directory. Agents can
   * write that workspace, and toolchains such as npm, pytest, make, cargo
   * and git execute code and configuration from it (package.json scripts,
   * conftest.py, Makefiles, .git/config and hooks), so an agent can run code
   * on the host through such a state. Prefer `container: true`; builtin mode
   * has no container, so host execution is its only option.
   */
  readonly host?: boolean;
  /**
   * Shared-container scope to exec into when `container` is true. Defaults
   * to DEFAULT_CONTAINER_SCOPE.
   */
  readonly containerScope?: string;
  /**
   * Per-command timeout in milliseconds, on the host and in the container.
   * A command still running when it expires is killed (on the host, with its
   * whole process group; in the container, by coreutils `timeout` and a sweep
   * of the processes it started) and the state fails. Undefined uses the
   * 10-minute default (`DEFAULT_EXEC_TIMEOUT_MS`).
   */
  readonly timeoutMs?: number;
  /**
   * Workspace-relative JSON result file written by a containerized helper.
   * Container-only; see validate.ts for path and routing constraints.
   */
  readonly resultFile?: string;
  /** Fan-out topology metadata for a parent segment driver state. */
  readonly fanOut?: FanOutDefinition;
  /** Ordered fan-out segment member state IDs. */
  readonly segment?: readonly string[];
  /** Marks this state as a member of a parent fan-out segment. */
  readonly fanOutMember?: boolean;
  /**
   * Scheduling metadata for lane-local execution. Schema-only until Phase 8
   * (the evaluation-slot pool): nothing reads it yet. Lint WF018 warns.
   */
  readonly schedule?: StateScheduleDefinition;
  readonly transitions: readonly AgentTransitionDefinition[];
}

export interface TerminalStateDefinition {
  readonly type: 'terminal';
  readonly description: string;
  readonly outputs?: readonly string[];
  /**
   * Legacy and ignored: terminal cleanup was never implemented, so these
   * commands are never run. Still accepted so existing manifests load; lint
   * WF017 warns. Put cleanup in a deterministic state before the terminal.
   */
  readonly cleanup?: readonly (readonly string[])[];
}

// ---------------------------------------------------------------------------
// Transition definitions
// ---------------------------------------------------------------------------

/** Allowed value types in a `when` clause. Matches AgentOutput field types. */
export type WhenValue = string | number | boolean | null;

/**
 * Per-key typed shape for `when` clauses. Using a mapped type here
 * enforces compile-time validation of both key names (must be in
 * AgentOutput) and value types (must match the field's type, e.g.
 * `completed` must be boolean, `verdict` must be a valid union member).
 *
 * Prefer this type over `Readonly<Record<string, WhenValue>>` when
 * writing workflow definitions in TypeScript.
 */
export type WhenClause = { readonly [K in keyof AgentOutput]?: AgentOutput[K] };

/**
 * Action executed on a transition, in addition to the default context
 * update actions (updateContextFromAgentResult / ...). Discriminated on
 * `type`. Implementations live in `machine-builder.ts` — this is a
 * closed set, not an open extension point.
 *
 * Today there is only a single variant, but the discriminated-union
 * shape is retained so new action types can be added without changing
 * the surrounding shape of transition definitions.
 */
export type WorkflowTransitionAction = {
  readonly type: 'resetVisitCounts';
  readonly stateIds: readonly string[];
};

export interface AgentTransitionDefinition {
  readonly to: string;
  /**
   * Guard name matching a registered XState guard. No translation
   * layer -- use names directly: isRoundLimitReached, isStalled, isPassed,
   * isStateVisitLimitReached. For verdict-based routing, prefer `when`
   * clauses instead. Mutually exclusive with `when`.
   */
  readonly guard?: string;
  /**
   * Declarative field-match condition on AgentOutput.
   * Keys must be valid AgentOutput field names and values must match
   * the field's type (enforced at compile time via the mapped type).
   * All entries must match (AND semantics).
   * Mutually exclusive with `guard`.
   */
  readonly when?: WhenClause;
  /**
   * Optional ordered list of actions to run on this transition, in
   * addition to the default context-update action. Actions execute
   * in the order listed.
   */
  readonly actions?: readonly WorkflowTransitionAction[];
}

export interface HumanGateTransitionDefinition {
  readonly to: string;
  /** The accepted event type that triggers this transition. */
  readonly event: HumanGateEventType;
  /**
   * Optional ordered list of actions to run on this transition, in
   * addition to the default gate context-update actions (storeHumanPrompt,
   * clearError). Actions execute in the order listed.
   */
  readonly actions?: readonly WorkflowTransitionAction[];
}

export type HumanGateEventType = 'APPROVE' | 'FORCE_REVISION' | 'REPLAN' | 'ABORT';

// ---------------------------------------------------------------------------
// Agent output
// ---------------------------------------------------------------------------

export const CONFIDENCE_VALUES = ['high', 'medium', 'low'] as const;
export type Confidence = (typeof CONFIDENCE_VALUES)[number];

/** Structured output parsed from the agent's response text. */
export interface AgentOutput {
  /**
   * @deprecated Maintained for backward compatibility. Defaults to `true`
   * at parse time. Workflows should use free-form `verdict` strings for
   * routing decisions instead of relying on this boolean.
   */
  readonly completed: boolean;
  /** Free-form verdict string. Well-known values: approved, rejected, blocked, spec_flaw. Workflows may define custom verdicts for direct routing. */
  readonly verdict: string;
  /**
   * @deprecated Maintained for backward compatibility. Defaults to `'high'`
   * at parse time. Should not be relied upon for routing decisions; use
   * `verdict` and `notes` instead.
   */
  readonly confidence: Confidence;
  /**
   * @deprecated Maintained for backward compatibility. Defaults to `null`
   * at parse time. Use `notes` for inter-agent context instead.
   */
  readonly escalation: string | null;
  /**
   * @deprecated Maintained for backward compatibility. Defaults to `null`
   * at parse time. Should not be relied upon for routing decisions.
   */
  readonly testCount: number | null;
  readonly notes: string | null;
}

/** Valid keys for `when` clauses. Must match AgentOutput field names. */
export const AGENT_OUTPUT_FIELDS = [
  'completed',
  'verdict',
  'confidence',
  'escalation',
  'testCount',
  'notes',
] as const satisfies readonly (keyof AgentOutput)[];

// ---------------------------------------------------------------------------
// Workflow events (XState event discriminated union)
// ---------------------------------------------------------------------------

export type WorkflowEvent =
  | { readonly type: 'AGENT_COMPLETED'; readonly output: AgentOutput }
  | { readonly type: 'VALIDATION_PASSED'; readonly testCount: number }
  | { readonly type: 'VALIDATION_FAILED'; readonly errors: string }
  | { readonly type: 'HUMAN_APPROVE'; readonly prompt?: string }
  | { readonly type: 'HUMAN_FORCE_REVISION'; readonly prompt?: string }
  | { readonly type: 'HUMAN_REPLAN'; readonly prompt?: string }
  | { readonly type: 'HUMAN_ABORT' };

// ---------------------------------------------------------------------------
// Workflow context (XState context)
// ---------------------------------------------------------------------------

export interface WorkflowLanePreparedResult {
  readonly passed: boolean;
  readonly testCount?: number;
  readonly errors?: string;
  readonly verdict?: string;
  readonly payload?: Record<string, unknown>;
}

export interface WorkflowLaneContext {
  readonly id: number;
  /** Container-absolute lane scratch directory, e.g. /workspace/.evolve_runs/main/current/lane_0. */
  readonly dir: string;
  /** Workspace-relative lane scratch directory, e.g. .evolve_runs/main/current/lane_0. */
  readonly relativeDir: string;
  /** Deterministic results prepared by the fan-out barrier before the child actor starts. */
  readonly preparedResults?: Readonly<Record<string, WorkflowLanePreparedResult>>;
}

export interface WorkflowContext {
  readonly taskDescription: string;
  readonly lane?: WorkflowLaneContext;
  readonly artifacts: Record<string, string>;
  readonly round: number;
  readonly maxRounds: number;
  /** Per-role output hash for stall detection. */
  readonly previousOutputHashes: Record<string, string>;
  readonly previousTestCount: number | null;
  readonly lastDeterministicResult?: {
    readonly verdict?: string;
    readonly payload?: Record<string, unknown>;
  };
  readonly humanPrompt: string | null;
  readonly reviewHistory: readonly string[];
  /**
   * Run-wide total tokens (input, cache and output) when the last agent state
   * or fan-out batch finished; `WorkflowCheckpoint.usage` holds the live
   * breakdown and its tracking status. Checkpoints written before that record
   * existed counted only output tokens here.
   */
  readonly totalTokens: number;
  readonly lastError: string | null;
  /**
   * Maps a stateId to the agent-CLI conversation id assigned on the last
   * successful invocation of that state. Consumed by `freshSession: false`
   * re-entries so the CLI can `--resume` the prior conversation.
   *
   * See `docs/designs/workflow-session-identity.md` §2.4.
   */
  readonly agentConversationsByState: Record<string, AgentConversationId>;
  /**
   * Output of the last completed agent state: the `handoff` of its
   * `workflow_commit` when it gave one, otherwise its final response text
   * with any `agent_status` YAML block stripped. Truncated at 32KB. Used as
   * the "body" portion of the "Scoping from the previous agent" section in
   * the next agent's prompt — carries the full directive, not just the
   * summary.
   */
  readonly previousAgentOutput: string | null;
  /**
   * The `notes` of the last agent's commit (its `workflow_commit` call, or
   * its `agent_status` block under the YAML protocol). Rendered as the
   * "Notes" sub-section under "Scoping from the previous agent". When the
   * orchestrator writes a bare status with no directive, this is often the
   * only surviving scoping signal.
   */
  readonly previousAgentNotes: string | null;
  /**
   * The state name that produced `previousAgentOutput`. Used to
   * label the output in the next agent's prompt.
   */
  readonly previousStateName: string | null;
  /**
   * Per-state visit counter. Maps state ID to the number of times
   * that state has been entered. Used for first-visit vs re-visit
   * prompt selection and per-state round limit checking.
   */
  readonly visitCounts: Readonly<Record<string, number>>;
}

// ---------------------------------------------------------------------------
// Workflow status (exposed to TUI and tests)
// ---------------------------------------------------------------------------

export type WorkflowStatus =
  | { readonly phase: 'running'; readonly currentState: string; readonly activeAgents: readonly AgentSlot[] }
  | { readonly phase: 'waiting_human'; readonly gate: HumanGateRequest }
  | { readonly phase: 'completed'; readonly result: WorkflowResult }
  | { readonly phase: 'failed'; readonly error: string; readonly lastState: string }
  | { readonly phase: 'aborted'; readonly reason: string };

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

export interface AgentSlot {
  readonly stateId: string;
  readonly persona: string;
}

export interface WorkflowResult {
  readonly finalArtifacts: Record<string, string>;
}

export interface HumanGateRequest {
  /**
   * Per-raise identifier. Every entry into a gate state mints a fresh id
   * (`<workflowId>-<stateName>-<visit>-<random suffix>`, see
   * `gate-binding.ts`), so two visits to the same gate never share one. The
   * id is stable while the gate is up: status polls, no-op machine
   * snapshots and a daemon restart (the id is checkpointed) all report the
   * same value. A decision must quote it (`HumanGateEvent.gateId`) and is
   * rejected when it names any other raise.
   */
  readonly gateId: string;
  readonly workflowId: string;
  readonly stateName: string;
  /**
   * Events a decision for this raise may carry: the gate's declared
   * `acceptedEvents` that also have a transition (`acceptedGateEvents` in
   * `gate-binding.ts`). Any other event is refused with EVENT_NOT_ACCEPTED.
   */
  readonly acceptedEvents: readonly HumanGateEventType[];
  readonly presentedArtifacts: ReadonlyMap<string, string>;
  readonly summary: string;
}

/**
 * JSON-serializable view of HumanGateRequest. The domain type's
 * `presentedArtifacts` is a `ReadonlyMap` which doesn't JSON-encode;
 * the DTO replaces it with the artifact names as a plain array.
 */
export interface HumanGateRequestDto {
  readonly gateId: string;
  readonly workflowId: string;
  readonly stateName: string;
  readonly acceptedEvents: readonly string[];
  /** Artifact names only (not content). */
  readonly presentedArtifacts: readonly string[];
  readonly summary: string;
}

export function toHumanGateRequestDto(gate: HumanGateRequest): HumanGateRequestDto {
  return {
    gateId: gate.gateId,
    workflowId: gate.workflowId,
    stateName: gate.stateName,
    acceptedEvents: gate.acceptedEvents,
    presentedArtifacts: Array.from(gate.presentedArtifacts.keys()),
    summary: gate.summary,
  };
}

/**
 * Channel a gate decision arrived through. Every daemon client shares one
 * bearer token, so this is the channel the client *declares*, not an
 * authenticated identity; it is recorded in the `gate_resolved` log entry so
 * the audit trail can tell a browser click from the agent-driven CLI.
 *
 * - `web-ui`: the browser SPA.
 * - `cli`: `ironcurtain workflow gate` (agent-driven) or the interactive
 *   `workflow start` prompt.
 * - `signal`: a Signal-bot decider.
 * - `rpc`: a JSON-RPC caller that declared no channel.
 */
export type GateResolutionChannel = 'web-ui' | 'cli' | 'signal' | 'rpc';

export interface HumanGateEvent {
  /**
   * `HumanGateRequest.gateId` of the raise this decision was made against.
   * Binds the decision to one gate instance: a decision minted while the
   * first visit of a gate was shown cannot land on its second visit, or on
   * a different gate, because each raise has its own id.
   */
  readonly gateId: string;
  readonly type: HumanGateEventType;
  readonly prompt?: string;
  /** Declared submission channel; recorded in the message log. */
  readonly resolvedBy: GateResolutionChannel;
}

// ---------------------------------------------------------------------------
// Tool-call escalations (policy `escalate` decisions inside a workflow run)
// ---------------------------------------------------------------------------

/**
 * A tool call that policy escalated during a workflow agent state and that
 * now waits for a human decision. Unlike a {@link HumanGateRequest} this is
 * not an FSM state: the agent is blocked inside one tool call until the
 * escalation is approved, denied, or expires at the configured escalation
 * timeout. JSON-serializable as-is, so it doubles as the wire DTO.
 */
export interface WorkflowToolCallEscalation {
  /** Coordinator escalation id; the key for `resolveToolCallEscalation`. */
  readonly escalationId: string;
  readonly workflowId: string;
  /** FSM state the workflow was in when the call escalated (a fan-out state for lanes). */
  readonly stateId: string;
  /** Persona whose policy escalated the call, when known. */
  readonly persona?: string;
  readonly serverName: string;
  readonly toolName: string;
  readonly arguments: Record<string, unknown>;
  readonly reason: string;
  readonly context?: Readonly<Record<string, string>>;
  readonly whitelistCandidates?: readonly WhitelistCandidateIpc[];
  /**
   * Set when the call must be decided by a human one at a time
   * (`EvaluationResult.humanOnly`, e.g. opening a passthrough domain): the
   * pipeline offers no whitelist candidate for it and any whitelist
   * selection is ignored, so an approval approves this call once.
   */
  readonly humanOnly?: true;
  /**
   * TRUSTED: the human's most recent message to the session, when the
   * pipeline found one (workflow state turns are system-generated, so this
   * is usually absent). See `EscalationRequest.lastTrustedUserMessage`.
   */
  readonly lastTrustedUserMessage?: TrustedUserMessage;
  /** TRUSTED: the workflow's task, as the human started the run with it. */
  readonly taskSummary?: string;
  /**
   * UNTRUSTED: the agent's own justification for the `execute_code` chain
   * that issued the call. Display only, labelled as the agent's; it never
   * authorizes anything. See `EscalationRequest.agentJustification`.
   */
  readonly agentJustification?: string;
  /** ISO timestamp at which the escalation was raised. */
  readonly receivedAt: string;
}

/**
 * How a workflow tool-call escalation ended. `expired` covers both the
 * escalation timeout and a cancellation (session teardown, policy swap):
 * in neither case did a human decide.
 */
export type WorkflowToolCallEscalationOutcome = 'approved' | 'denied' | 'expired';

/** A human decision for a workflow tool-call escalation. */
export interface WorkflowToolCallEscalationDecision {
  readonly decision: 'approved' | 'denied';
  /**
   * Index into the escalation's `whitelistCandidates` to whitelist. The
   * pattern lasts while the policy that escalated the call stays loaded: it
   * is dropped when the agent's persona changes (a workflow policy swap) or
   * its coordinator shuts down.
   */
  readonly whitelistSelection?: number;
}

// ---------------------------------------------------------------------------
// Checkpoint and history
// ---------------------------------------------------------------------------

export interface WorkflowCheckpoint {
  /**
   * On-disk format version, stamped by `FileCheckpointStore.save`
   * (`CHECKPOINT_SCHEMA_VERSION`). Absent on checkpoints written before
   * versioning (format 1). A reader refuses a version newer than its own
   * with `WORKFLOW_CHECKPOINT_TOO_NEW` instead of misreading it.
   */
  readonly schemaVersion?: number;
  /** IronCurtain version that wrote the file, stamped with `schemaVersion` (diagnostics only). */
  readonly writerVersion?: string;
  /**
   * Absolute run directory (`<baseDir>/<workflowId>`) of the run when this
   * checkpoint was built. Recorded paths inside it (the default workspace,
   * the staged skills and scripts) are run-local: a reader rebases them onto
   * the run directory it actually found the run in (`rebaseRunLocalPaths`),
   * so a moved IronCurtain home resumes in place instead of recreating the
   * old paths. Absent on older checkpoints, where it is inferred from the
   * `<runDir>/workspace` shape of `workspacePath`.
   */
  readonly runDir?: string;
  /** Effective settings fixed at run start (absent on legacy checkpoints). */
  readonly resourceBudget?: WorkflowBudget;
  /**
   * Run-wide usage when the checkpoint was written: tokens by kind, cost,
   * active time and how complete the token figures are. Resume continues
   * from it, so the totals and the `settings.workflowBudget` ceiling span
   * every leg of the run. Absent on checkpoints written before it existed;
   * those runs restart from `context.totalTokens` as a lower bound.
   */
  readonly usage?: WorkflowUsage;
  /** Teardown had not settled all charges when this provisional terminal was saved. */
  readonly usageSettlementPending?: boolean;
  /** Serialized XState snapshot.value (string or nested object). */
  readonly machineState: unknown;
  readonly context: WorkflowContext;
  readonly timestamp: string;
  readonly transitionHistory: readonly TransitionRecord[];
  readonly definitionPath: string;
  /** Workspace root directory. Used on resume to reconstruct artifactDir. */
  readonly workspacePath?: string;
  /**
   * Per-run staged copy of the workflow package's `skills/` tree (when
   * the package shipped one). The orchestrator copies this at start
   * under `<baseDir>/<workflowId>/workflow-skills/` so the run is
   * self-contained: resume reads from the staged copy regardless of
   * whether the original package path is still on disk. Absent when
   * the workflow ships no skills, and absent on legacy checkpoints
   * written before this field existed (resume falls back to re-staging
   * from `definitionPath`'s package dir).
   */
  readonly workflowSkillsDir?: string;
  /**
   * Per-run staged copy of the workflow package's `scripts/` tree (when
   * the package shipped one). Mounted read-only at /workflow-scripts for
   * shared-container deterministic states.
   */
  readonly workflowScriptsDir?: string;
  /**
   * Task-scope directory of a `--task-scoped` run (canonical). Resume keeps
   * the run under the same task scope and refuses when it no longer
   * validates. Absent for an unscoped run and on older checkpoints.
   */
  readonly taskPolicyDir?: string;
  /**
   * Per-containerScope Docker image snapshots captured at an aborted or failed stop.
   * `image` is the immutable sha256 image id and is the source of truth;
   * `tag` is cosmetic only.
   */
  readonly containerSnapshots?: Readonly<Record<string, ContainerSnapshotRef>>;
  /**
   * Terminal-phase status, populated only when the workflow has reached a terminal
   * phase (completed / aborted / failed / waiting_human). Absent for mid-run
   * checkpoints and for legacy retained checkpoints written before this field existed.
   */
  readonly finalStatus?: WorkflowStatus;
  /**
   * Per-raise id of the human gate that was active when the checkpoint was
   * written (`machineState` names a `human_gate` state). Resume restores it
   * so the gate re-raised after a restart keeps the id a decider already
   * read; a decision made against it stays valid. Absent away from gates
   * and on checkpoints written before per-raise gate ids existed. Resume
   * mints (and persists) a fresh id when it is absent or was not minted for
   * the gate in `machineState` (`isGateIdFor` in `gate-binding.ts`).
   */
  readonly activeGateId?: string;
}

export interface ContainerSnapshotRef {
  readonly image: string;
  readonly tag?: string;
  /**
   * Build hash of the agent image the snapshotted container ran. Resume uses
   * the snapshot only when the scope's bundle resolves the same build; absent
   * on snapshots committed before it was recorded, which are never resumed.
   */
  readonly agentBuildHash?: string;
  /**
   * Whether the snapshotted container's agent had passwordless sudo (the
   * bundle's `agentSudo` plan). A bundle planned with `agentSudo: false`
   * resumes only a snapshot recorded as `false`: a sudo-off agent takes its
   * groups from the image, which an agent with root could have changed. Absent
   * on snapshots committed before it was recorded, which count as sudo on.
   */
  readonly agentSudo?: boolean;
  /** IronCurtain version that committed the snapshot (informational). */
  readonly ironcurtainVersion?: string;
}

export interface TransitionRecord {
  readonly from: string;
  readonly to: string;
  readonly event: string;
  readonly timestamp: string;
  readonly duration_ms: number;
  /** Summary of the agent's output that produced this transition (if any). */
  readonly agentMessage?: string;
}
