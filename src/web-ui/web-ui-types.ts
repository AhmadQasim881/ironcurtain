/**
 * Shared types for the daemon web UI: JSON-RPC frame protocol, DTOs, and events.
 */

import type { SessionSource } from '../session/session-manager.js';
import type { BudgetCostSource, SessionStatus, DiagnosticEvent, ConversationTurn } from '../session/types.js';
import type { JobDefinition, RunRecord } from '../cron/types.js';
import type { WhitelistCandidateIpc } from '../trusted-process/approval-whitelist.js';
import type { EscalationDisplayFields } from '../escalation/escalation-review.js';
import type { WorkflowId, HumanGateRequestDto, WorkflowToolCallEscalation } from '../workflow/types.js';
import type { MessageLogEntry } from '../workflow/message-log.js';
import type { ResolvedResourceBudgetConfig } from '../config/user-config.js';
import type { WorkflowBudget } from '../workflow/resource-budget.js';
import type { WorkflowUsage } from '../workflow/workflow-usage.js';
// TYPE-ONLY import of the 9-value pipeline phase union. The import-boundary
// rule (test/pipeline-import-boundary.test.ts + ESLint no-restricted-imports)
// forbids VALUE imports from pipeline/* on the live path; `import type` is the
// sanctioned contract import and creates no runtime edge.
import type { CompilationPhase } from '../pipeline/pipeline-shared.js';
import type { DockerWorkloadNetworkAccess } from '../docker-workload/config.js';
import type { PolicyStaleReason } from '../config/constitution-hash.js';

// Re-export the phase union so the frontend mirror and event consumers can name
// it without reaching into the pipeline package directly.
export type { CompilationPhase } from '../pipeline/pipeline-shared.js';

// Re-export MessageLogEntry so frontends can import it from the wire-types
// module without reaching into the workflow domain package directly.
export type { MessageLogEntry } from '../workflow/message-log.js';

// ---------------------------------------------------------------------------
// JSON-RPC Frame Protocol
// ---------------------------------------------------------------------------

/** Literal union of all valid JSON-RPC method names. */
export type MethodName =
  | 'status'
  | 'jobs.list'
  | 'jobs.remove'
  | 'jobs.enable'
  | 'jobs.disable'
  | 'jobs.recompile'
  // Re-resolves the job policy's dynamic lists (refresh-lists --job).
  | 'jobs.refreshLists'
  | 'jobs.reload'
  | 'jobs.run'
  | 'jobs.logs'
  | 'sessions.list'
  | 'sessions.listResumable'
  | 'sessions.get'
  | 'sessions.create'
  | 'sessions.resume'
  | 'sessions.end'
  | 'sessions.send'
  | 'sessions.budget'
  | 'sessions.history'
  | 'sessions.diagnostics'
  | 'sessions.subscribeTokenStream'
  | 'sessions.unsubscribeTokenStream'
  | 'sessions.subscribeAllTokenStreams'
  | 'sessions.unsubscribeAllTokenStreams'
  // Docker-agent PTY terminal streaming (web-pty session kind). Attach/detach
  // manage per-client subscription to a session's terminal stream; input/resize
  // forward keystrokes and the browser xterm's size to the child PTY.
  | 'sessions.ptyAttach'
  | 'sessions.ptyDetach'
  | 'sessions.ptyInput'
  | 'sessions.ptyResize'
  | 'sessions.ptyPrompt'
  | 'escalations.list'
  | 'escalations.resolve'
  // Approves every member of one whitelist-pattern group, after the UI listed
  // them for confirmation; refused unless the ids are exactly the group.
  | 'escalations.approveGroup'
  | 'personas.list'
  | 'workflows.list'
  | 'workflows.get'
  | 'workflows.getBudget'
  | 'workflows.getBudgetPreview'
  | 'workflows.start'
  | 'workflows.import'
  | 'workflows.resume'
  | 'workflows.abort'
  | 'workflows.resolveGate'
  | 'workflows.resolveEscalation'
  | 'workflows.inspect'
  | 'workflows.fileTree'
  | 'workflows.fileContent'
  | 'workflows.artifacts'
  | 'workflows.artifactFile'
  | 'workflows.listDefinitions'
  | 'workflows.listResumable'
  | 'workflows.messageLog'
  | 'workflows.messageLogEntry'
  | 'workflows.readme'
  | 'personas.get'
  // Phase 1b: streamed long-running compile (fire-and-return) + its read methods.
  | 'personas.compileStream'
  | 'personas.getCompile'
  | 'personas.listCompiles'
  // Phase 1c: full persona CRUD (all mutation methods; require the
  // `--allow-policy-mutation` kill switch, else POLICY_MUTATION_FORBIDDEN).
  | 'personas.create'
  | 'personas.editConstitution'
  | 'personas.setMemory'
  | 'personas.delete'
  | 'personas.setBroadPolicyOptIn'
  // Persona lifecycle. clone / rename / restoreTrash / purgeTrash are
  // mutations (gated like the CRUD methods above); listTrash is a read.
  | 'personas.clone'
  | 'personas.rename'
  | 'personas.listTrash'
  | 'personas.restoreTrash'
  | 'personas.purgeTrash'
  // The configured MCP servers a persona's allowlist may name (the create
  // form's server picker). A read, ungated.
  | 'personas.listServers'
  // Config reads are ungated; mutations are gated on the daemon's
  // `--allow-policy-mutation` kill switch (POLICY_MUTATION_FORBIDDEN).
  | 'config.getModelProviders'
  | 'config.setModelProviders'
  | 'config.getDockerWorkload'
  | 'config.setDockerWorkload'
  | 'config.getStatistics'
  | 'config.getResourceBudget'
  | 'config.setResourceBudget'
  | 'config.setStatistics'
  // OpenRouter model-slug catalog for autocomplete/validation. Ungated read of
  // PUBLIC data (mirrors `config.getModelProviders`); no secret, no mutation.
  | 'config.listOpenrouterModels'
  | 'config.listProviderModels'
  | 'statistics.capabilities'
  | 'statistics.summary'
  | 'statistics.series'
  | 'statistics.distribution'
  | 'statistics.exchanges'
  | 'statistics.dimensions';

/** Browser -> Daemon request frame. */
export interface RequestFrame {
  readonly id: string;
  readonly method: MethodName;
  readonly params?: Record<string, unknown>;
}

/** Daemon -> Browser response to a specific request. */
export type ResponseFrame =
  | { readonly id: string; readonly ok: true; readonly payload?: unknown }
  | {
      readonly id: string;
      readonly ok: false;
      readonly error: { readonly code: ErrorCode; readonly message: string; readonly data?: unknown };
    };

/** Daemon -> Browser unsolicited push event. */
export interface EventFrame {
  readonly event: string;
  readonly payload: unknown;
  readonly seq: number;
}

/** Error codes for ResponseFrame errors. */
export type ErrorCode =
  | 'AUTH_REQUIRED'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_NOT_RESUMABLE'
  | 'JOB_NOT_FOUND'
  // `jobs.run` while a run of the job (scheduled, CLI or web) has not finished.
  | 'JOB_ALREADY_RUNNING'
  | 'ESCALATION_NOT_FOUND'
  | 'ESCALATION_EXPIRED'
  // `escalations.approveGroup`: the ids sent are not exactly the group's
  // pending members any more (one arrived, expired or was resolved).
  | 'ESCALATION_GROUP_CHANGED'
  | 'SESSION_BUSY'
  | 'WORKFLOW_NOT_FOUND'
  | 'WORKFLOW_CORRUPTED'
  | 'WORKFLOW_ALREADY_ACTIVE'
  | 'WORKFLOW_CHECKPOINT_NOT_FOUND'
  // The checkpoint or definition copy was written by a newer IronCurtain.
  | 'WORKFLOW_CHECKPOINT_TOO_NEW'
  | 'WORKFLOW_NOT_RESUMABLE'
  // The run's recorded workspace no longer exists (resume never recreates it).
  | 'WORKFLOW_WORKSPACE_MISSING'
  // An imported run's definition runs host commands and `trust` was not given.
  | 'WORKFLOW_IMPORT_UNTRUSTED'
  | 'WORKFLOW_NOT_AT_GATE'
  // Gate-decision binding (`workflows.resolveGate`): the decision named a gate
  // id other than the active raise, or an event the gate does not transition on.
  | 'GATE_MISMATCH'
  | 'EVENT_NOT_ACCEPTED'
  | 'ARTIFACT_NOT_FOUND'
  | 'README_NOT_FOUND'
  | 'PERSONA_NOT_FOUND'
  | 'FILE_TOO_LARGE'
  | 'INVALID_PARAMS'
  | 'RATE_LIMITED'
  // The serialized reply exceeded the per-response cap or the connection's
  // send buffer; the request failed but the socket stays open (see
  // `WebUiServer.sendResponse`).
  | 'RESPONSE_TOO_LARGE'
  | 'METHOD_NOT_FOUND'
  | 'LINT_FAILED'
  | 'INTERNAL_ERROR'
  // Phase 1b persona-compile error codes.
  | 'COMPILE_IN_PROGRESS'
  | 'COMPILE_QUEUE_FULL'
  | 'CREDENTIALS_MISSING'
  | 'LIST_REQUIRES_MCP'
  | 'POLICY_MUTATION_FORBIDDEN'
  // The merged policy failed the deterministic policy lint (the pipeline's
  // PolicyLintError), so nothing was written; the message names the first
  // findings. Surfaced terminally via the `persona.compile.failed` event.
  | 'POLICY_LINT_FAILED'
  // Phase 1c persona-CRUD error codes.
  // PERSONA_EXISTS: `personas.create` against an existing persona dir (after branding).
  // BROAD_POLICY_REJECTED: the broad-policy validator rejected a compiled policy
  //   (an allow rule with a broad wildcard domain/list, an out-of-workspace
  //   path, or an unconstrained resource argument) without `allowBroadPolicy`;
  //   surfaced terminally via the `persona.compile.failed` event.
  | 'PERSONA_EXISTS'
  | 'BROAD_POLICY_REJECTED'
  // PERSONA_INVALID: the persona's persona.json exists but cannot be used (not
  //   JSON, a field of the wrong type or unknown, or a `name` other than its
  //   directory's, as in a persona directory copied by hand; for
  //   `personas.clone`, also a malformed agentModelId or resourceBudget).
  | 'PERSONA_INVALID'
  | 'STATISTICS_UNAVAILABLE'
  // A well-formed statistics query asked for more than one request may
  // compute (range, matched rows, groups, buckets, response size). `data`
  // carries `{ limit, maximum }`; a shorter range or fewer groups succeeds.
  | 'STATISTICS_LIMIT';

// ---------------------------------------------------------------------------
// DTO Types
// ---------------------------------------------------------------------------

/** Session snapshot for the sessions list. */
export interface SessionDto {
  readonly label: number;
  readonly source: SessionSource;
  readonly status: SessionStatus;
  readonly turnCount: number;
  readonly createdAt: string;
  readonly hasPendingEscalation: boolean;
  readonly messageInFlight: boolean;
  readonly budget: BudgetSummaryDto;
  readonly persona?: string;
  /**
   * ISO 8601 timestamp of the most recent browser attach. Populated only for
   * `web-pty` sessions (see `toPtySessionDto`) so the operator can spot an
   * abandoned-but-alive terminal in the session list; absent for all other
   * kinds. Additive/optional — existing consumers ignore it.
   */
  readonly lastAttachedAt?: string;
  /**
   * One-line warning for a `web-pty` session when configured MCP servers
   * that ask for an OS sandbox will not get one on the daemon host (they are
   * refused under sandboxPolicy "enforce" or run unconfined under "warn").
   * Computed by the daemon from its full server configuration when the
   * session is created, so it may name a server this session's policy never
   * starts. Absent when every such server is sandboxed. Additive/optional.
   */
  readonly osSandboxWarning?: string;
}

/** Persisted Docker-agent session that can be resumed into a new web PTY. */
export interface ResumableSessionDto {
  readonly sessionId: string;
  readonly displayName: string;
  readonly agent: string;
  readonly status: 'completed' | 'crashed' | 'auth-failure' | 'user-exit';
  readonly lastActivity: string;
  readonly workspaceLabel?: string;
  readonly persona?: string;
  readonly providerProfileName?: string;
}

/**
 * Session budget summary. Consumption fields are session totals (active
 * seconds for `elapsedSeconds`); `limits` are the per-turn limits.
 */
export interface BudgetSummaryDto {
  readonly totalTokens: number;
  readonly stepCount: number;
  readonly elapsedSeconds: number;
  readonly estimatedCostUsd: number;
  /** Where the cost comes from; `unknown` renders as "unknown", never $0.00. */
  readonly costSource?: BudgetCostSource;
  readonly tokenTrackingAvailable: boolean;
  readonly tokenTrackingStatus?: 'complete' | 'partial' | 'unavailable';
  readonly observedExchanges?: number;
  readonly incompleteExchanges?: number;
  readonly limits: {
    readonly maxTotalTokens: number | null;
    readonly maxSteps: number | null;
    readonly maxSessionSeconds: number | null;
    readonly maxEstimatedCostUsd: number | null;
  };
}

/** Global resource limits; null explicitly disables a numeric limit. */
export type ResourceBudgetConfigDto = ResolvedResourceBudgetConfig;

export type WorkflowBudgetDto = WorkflowBudget;

/** Detailed session info including conversation history. */
export interface SessionDetailDto extends SessionDto {
  readonly history: readonly ConversationTurn[];
  readonly diagnosticLog: readonly DiagnosticEvent[];
}

/**
 * Pending escalation for the escalation dashboard. The reviewer-context
 * fields (`EscalationDisplayFields`) carry the human's last message and the
 * session's task (trusted) and the agent's justification (untrusted: the UI
 * shows it set apart and labelled as the agent's); `groupKey` names the
 * whitelist-pattern group the escalation belongs to, for "approve group".
 */
export interface EscalationDto extends EscalationDisplayFields {
  /** Complete arguments were too large to show; browser approval is forbidden. */
  readonly reviewUnavailable?: true;
  readonly escalationId: string;
  readonly sessionLabel: number;
  readonly sessionSource: SessionSource;
  readonly toolName: string;
  readonly serverName: string;
  readonly arguments: Record<string, unknown>;
  readonly reason: string;
  readonly context?: Readonly<Record<string, string>>;
  readonly whitelistCandidates?: readonly WhitelistCandidateIpc[];
  readonly receivedAt: string;
}

/**
 * Result of `escalations.approveGroup`: the members approved, and those
 * whose approval failed (expired meanwhile, session gone), with the reason.
 */
export interface EscalationGroupApprovalDto {
  readonly approved: readonly string[];
  readonly failed: readonly { readonly escalationId: string; readonly code: ErrorCode; readonly message: string }[];
}

/** Daemon status snapshot (JSON-serialized form). */
export interface DaemonStatusDto {
  readonly uptimeSeconds: number;
  /** `failing`: jobs whose latest run ended in an error. */
  readonly jobs: { total: number; enabled: number; running: number; failing: number };
  readonly signalConnected: boolean;
  readonly webUiListening: boolean;
  readonly activeSessions: number;
  readonly nextFireTime: string | null;
  /**
   * Whether the daemon was launched with `--allow-policy-mutation` (Phase 1c).
   * Populated by `buildStatusDto` from `ctx.allowPolicyMutation`. The frontend
   * uses this to HIDE all persona-mutation controls when the kill switch is
   * off — when off, every mutation method returns POLICY_MUTATION_FORBIDDEN.
   * Off by default, CLI-only, not config-persisted.
   */
  readonly allowPolicyMutation: boolean;
  /**
   * The daemon's process-global session mode. `container` → new sessions are
   * `web-pty` live terminals that accept launch options (workspace / provider
   * profile / model) and mediate trusted input; `builtin` → legacy
   * daemon-managed sessions. Populated by `buildStatusDto`, which maps the
   * internal Docker-agent discriminator to the public runtime-neutral label.
   */
  readonly sessionMode: 'builtin' | 'container';
}

/** Job list entry with scheduling and last-run info. */
export interface JobListDto {
  readonly job: JobDefinition;
  readonly nextRun: string | null;
  readonly lastRun: RunRecord | null;
  /** True from the moment a run is reserved (before its git sync and session start) until its record is written. */
  readonly isRunning: boolean;
  /** Runs in a row, newest first, that ended in an error; 0 when the latest did not. */
  readonly consecutiveFailures: number;
}

// ---------------------------------------------------------------------------
// Workflow DTO Types
// ---------------------------------------------------------------------------

/**
 * Phases that appear only on past-run records loaded from disk.
 * `running_elsewhere`: no live instance in this daemon, but the run's lock is
 * held by another live IronCurtain process (a CLI `workflow start`, another
 * daemon), so it is running there and cannot be resumed from here.
 */
export type PastRunPhase = 'completed' | 'failed' | 'aborted' | 'waiting_human' | 'interrupted' | 'running_elsewhere';

/** Phases reported by the orchestrator for a workflow currently tracked in memory. */
export type LiveWorkflowPhase = 'running' | 'waiting_human' | 'completed' | 'failed' | 'aborted';

/**
 * Latest verdict observed for a workflow.
 *
 * On a completed/failed/aborted workflow this is the final verdict; on a live
 * workflow it is the most recently emitted one.
 */
export interface LatestVerdictDto {
  readonly stateId: string;
  readonly verdict: string;
  readonly confidence?: number;
}

/**
 * Shared fields for any workflow card-style record (live summaries and past runs).
 *
 * `phase` is typed as the wide union of live and past-run phases on the base.
 * Subtypes may tighten it (e.g. `WorkflowSummaryDto` keeps the live-only union,
 * `PastRunDto` narrows to `PastRunPhase`).
 */
export interface WorkflowCardDto {
  readonly workflowId: WorkflowId;
  readonly name: string;
  readonly phase: LiveWorkflowPhase | PastRunPhase;
  readonly currentState: string;
  readonly taskDescription: string;
  readonly round: number;
  readonly maxRounds: number;
  readonly totalTokens: number;
  readonly latestVerdict?: LatestVerdictDto;
  readonly error?: string;
}

/** Slim summary returned by `workflows.list`. */
export type WorkflowSummaryDto = WorkflowCardDto & {
  readonly phase: LiveWorkflowPhase;
  readonly startedAt: string;
};

/**
 * Full detail returned by `workflows.get`.
 *
 * Extends {@link WorkflowCardDto} (not `WorkflowSummaryDto`) so that the wide
 * `phase` union — including the `'interrupted'` value synthesized for past runs
 * loaded from disk — is preserved here. Live-path responses still emit a
 * `LiveWorkflowPhase` value; only the disk-fallback path can emit `'interrupted'`.
 */
export type WorkflowDetailDto = WorkflowCardDto & {
  readonly budget?: WorkflowBudgetDto;
  /** Run-wide usage (tokens by kind, cost, running time, tracking status). */
  readonly usage?: WorkflowUsage;
  readonly startedAt: string;
  readonly description: string;
  readonly stateGraph: StateGraphDto;
  readonly transitionHistory: readonly TransitionRecordDto[];
  readonly context: WorkflowContextDto;
  readonly gate?: HumanGateRequestDto;
  /**
   * Tool-call escalations waiting for a human decision. Present (non-empty)
   * only on a live `running` workflow whose agent is blocked inside an
   * escalated tool call; resolve one with `workflows.resolveEscalation`.
   */
  readonly escalations?: readonly WorkflowEscalationDto[];
  readonly workspacePath: string;
  /** True when the workflow's source package ships a `README.md` (lazily fetched via `workflows.readme`). */
  readonly hasReadme: boolean;
};

/** Wire form of a workflow tool-call escalation (already JSON-serializable). */
export type WorkflowEscalationDto = WorkflowToolCallEscalation & { readonly reviewUnavailable?: true };

/** Minimal representation of the state machine graph for frontend rendering. */
export interface StateGraphDto {
  readonly states: readonly StateNodeDto[];
  readonly transitions: readonly TransitionEdgeDto[];
}

export interface StateNodeDto {
  readonly id: string;
  readonly type: 'agent' | 'human_gate' | 'deterministic' | 'terminal';
  readonly persona?: string;
  readonly label: string;
  readonly description?: string;
}

export interface TransitionEdgeDto {
  readonly from: string;
  readonly to: string;
  readonly guard?: string;
  readonly event?: string;
  readonly label: string;
}

export interface TransitionRecordDto {
  readonly from: string;
  readonly to: string;
  readonly event: string;
  readonly timestamp: string;
  readonly durationMs: number;
  /** Summary of the agent output that produced this transition. */
  readonly agentMessage?: string;
}

export interface WorkflowContextDto {
  readonly taskDescription: string;
  readonly round: number;
  readonly maxRounds: number;
  readonly totalTokens: number;
  readonly visitCounts: Record<string, number>;
}

// ---------------------------------------------------------------------------
// File browser DTO Types
// ---------------------------------------------------------------------------

/** Entry in a directory listing returned by `workflows.fileTree`. */
export interface FileTreeEntryDto {
  readonly name: string;
  readonly type: 'file' | 'directory';
  readonly size?: number;
}

/**
 * Response from `workflows.fileTree`. A listing stops after 2,000 entries
 * (directories and regular files only; symlinks, FIFOs, sockets and devices
 * are never listed) and then reports `truncated: true`.
 */
export interface FileTreeResponseDto {
  readonly entries: readonly FileTreeEntryDto[];
  readonly truncated?: boolean;
}

/**
 * Response from `workflows.fileContent` and `workflows.artifactFile`. Exactly
 * one of `content`, `binary` or `error` is set: `error` carries a short
 * display message such as "File too large to display (>1MB)" or "Not a
 * regular file" (the path is a FIFO, socket, device or symlink).
 */
export interface FileContentResponseDto {
  readonly content?: string;
  readonly language?: string;
  readonly binary?: boolean;
  readonly error?: string;
}

/** A single file in an artifact listing: its `/`-separated path below the artifact directory and its size in bytes. */
export interface ArtifactFileDto {
  readonly path: string;
  readonly size: number;
}

/**
 * Response from `workflows.artifacts`: the artifact's regular files (names and
 * sizes only). File contents are fetched one at a time through
 * `workflows.artifactFile`, so a reply never carries file bodies. The walk
 * stops at 2,000 files, 8 directory levels or 1 MiB of listed paths and then
 * reports `truncated: true`.
 */
export interface ArtifactContentDto {
  readonly files: readonly ArtifactFileDto[];
  readonly truncated: boolean;
}

// ---------------------------------------------------------------------------
// Workflow Definition DTO Types
// ---------------------------------------------------------------------------

/**
 * Past-run record returned by `workflows.listResumable`.
 *
 * Covers terminal runs (completed/failed/aborted), runs paused at a human gate
 * (`waiting_human`), runs whose checkpoint exists on disk with no live
 * orchestrator instance and no recorded `finalStatus` (`interrupted` — typically
 * a daemon crash mid-run; the phase is synthesized at the DTO boundary), and
 * runs live in another process (`running_elsewhere`).
 */
export type PastRunDto = WorkflowCardDto & {
  readonly phase: PastRunPhase;
  readonly timestamp: string;
  readonly lastState: string;
  readonly durationMs?: number;
  readonly workspacePath?: string;
};

/**
 * @deprecated Use {@link PastRunDto} instead. This alias is preserved for one
 * release to avoid an abrupt RPC return-type rename for `workflows.listResumable`.
 */
export type ResumableWorkflowDto = PastRunDto;

/**
 * A {@link MessageLogEntry} as it appears in a `workflows.messageLog` page.
 * String fields longer than 8,192 characters are cut to that length in the
 * page and the entry carries `truncated: true` plus an opaque `ref` that
 * `workflows.messageLogEntry` accepts to fetch the full entry.
 */
export type MessageLogEntryDto = MessageLogEntry & {
  readonly truncated?: boolean;
  readonly ref?: string;
};

/**
 * Response from `workflows.messageLog`: a page of {@link MessageLogEntryDto}
 * records for a workflow, sorted newest-first by `ts`.
 *
 * Cursor pagination per design decision D5: callers fetch the next page by
 * passing the last entry's `ts` as the next request's `before` parameter.
 * `hasMore` is true iff the returned page is full *and* at least one strictly
 * older entry exists on disk; otherwise false. A page is full at `limit`
 * entries or at 1 MiB of log lines, whichever comes first.
 */
export interface MessageLogResponseDto {
  readonly entries: readonly MessageLogEntryDto[];
  readonly hasMore: boolean;
}

/** Response from `workflows.messageLogEntry`: one complete entry addressed by a page entry's `ref`. */
export interface MessageLogEntryResponseDto {
  readonly entry: MessageLogEntry;
}

/** Available workflow definition returned by `workflows.listDefinitions`. */
export interface WorkflowDefinitionDto {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly source: 'bundled' | 'user' | 'custom';
  /** True when the package ships a `README.md` (fetch with `workflows.readme`). */
  readonly hasReadme: boolean;
}

/** README markdown for a workflow, returned by `workflows.readme`. */
export interface WorkflowReadmeDto {
  /** Raw markdown source; the client renders + sanitizes it. */
  readonly content: string;
}

// ---------------------------------------------------------------------------
// Persona DTO Types
// ---------------------------------------------------------------------------

/** Detail for a single persona returned by `personas.get`. */
export interface PersonaDetailDto {
  readonly name: string;
  readonly description: string;
  readonly createdAt: string;
  readonly constitution: string;
  readonly servers?: readonly string[];
  readonly hasPolicy: boolean;
  readonly policyRuleCount?: number;
  /**
   * Present when the compiled policy exists but no longer matches the
   * persona's constitution (`'constitution'`), or was built for another
   * policy-engine generation (`'engine'`, reserved). Recomputed from disk on
   * every read. Sessions refuse a stale persona unless the user explicitly
   * overrides on the CLI, so the UI must show it as needing a recompile.
   */
  readonly stale?: PolicyStaleReason;
  /**
   * Whether persistent memory is enabled for this persona
   * (persona.memory?.enabled ?? true). Added in Phase 1a; additive and
   * backward-compatible — existing callers ignore unknown fields.
   */
  readonly memory: boolean;
  /**
   * Whether this persona is authorized to compile a "broad" policy
   * (persona.allowBroadPolicy ?? false). When false, the broad-policy
   * validator rejects compiled policies with an `allow` rule that has a broad
   * wildcard domain/list (`'*'`, `'*.com'`, `'*.github.io'`), an
   * out-of-workspace `paths.within`, or an unconstrained resource argument.
   * Set ONLY via the gated
   * `personas.setBroadPolicyOptIn` method — never inferred from the
   * constitution. Added in Phase 1c. (Source: src/persona/types.ts
   * PersonaDefinition.allowBroadPolicy.)
   */
  readonly allowBroadPolicy: boolean;
}

/**
 * Slim list-row returned by `personas.list` (canonical scanner output).
 *
 * Promoted from a local definition in persona-service.ts (Phase 1a follow-up)
 * so backend and frontend build against one declaration. `memory` is carried
 * per row per the design (§5).
 */
export interface PersonaListDto {
  readonly name: string;
  readonly description: string;
  /** Whether a compiled policy exists (it may still be stale, see `stale`). */
  readonly compiled: boolean;
  /** Same meaning as {@link PersonaDetailDto.stale}; absent when fresh or not compiled. */
  readonly stale?: PolicyStaleReason;
  /**
   * Whether persistent memory is enabled for this persona
   * (persona.memory?.enabled ?? true). NOTE: the Phase-1a service does not yet
   * populate this; it is part of the locked contract and is filled in when the
   * scanner is extended. Additive and backward-compatible.
   */
  readonly memory?: boolean;
}

/** Result of editing a persona's constitution (`personas.editConstitution`). */
export interface PersonaEditResultDto {
  /** True when the compiled policy no longer matches the new constitution. */
  readonly stale: boolean;
}

/**
 * One soft-deleted persona in `~/.ironcurtain/.persona-trash/`
 * (`personas.listTrash`, newest first).
 */
export interface PersonaTrashEntryDto {
  /** The entry's id (its directory name): the handle restore and purge take. */
  readonly id: string;
  /** The persona's name when it was deleted. */
  readonly name: string;
  /** ISO 8601 time of the deletion. */
  readonly deletedAt: string;
  /** The persona's description, when its persona.json is valid. */
  readonly description?: string;
  /** Why the entry's persona.json cannot be used; such an entry cannot be restored. */
  readonly problem?: string;
  /**
   * ISO 8601 time from which the retention sweep purges the entry; absent
   * when entries are kept until purged by hand (or the retention setting
   * could not be read).
   */
  readonly expiresAt?: string;
}

/** Result of `personas.restoreTrash`. */
export interface PersonaRestoreResultDto {
  readonly persona: PersonaDetailDto;
  /** The trash entry that was restored. */
  readonly restored: string;
  /** With `force`: the trash entry the persona it replaced was moved to. */
  readonly replaced?: string;
}

/** Result of `personas.purgeTrash`: entries removed, and entries that could not be. */
export interface PersonaTrashPurgeResultDto {
  readonly purged: readonly string[];
  readonly failed: ReadonlyArray<{ readonly id: string; readonly reason: string }>;
}

/**
 * Compile-time diff vs the persona's previous `compiled-policy.json`,
 * carried on a successful compile result (Phase 1c). Surfaced by the
 * `done` event/card so prompt-injected broadening is reviewable after the
 * fact. `broadenedDomains`, `outOfWorkspacePaths` and `unconstrainedAllows`
 * enumerate the broad access of the new policy's `allow` rules: broad
 * wildcard domains (`*`, `*.com`, `*.github.io`, judged with the Public Suffix
 * List), out-of-workspace `paths.within`, and rules that leave a resource
 * argument unconstrained (`<rule>: <role> on <server>/<tool>`). These are only
 * ever non-empty for an `allowBroadPolicy` persona, since otherwise the
 * broad-policy validator would have rejected the compile. `escalateBreadth` is
 * informational: the same wildcard and path breadth on `escalate` rules, which
 * a human approves call by call.
 */
export interface RuleDeltaDto {
  readonly added: number;
  readonly loosened: number;
  readonly removed: number;
  readonly broadenedDomains: readonly string[];
  readonly outOfWorkspacePaths: readonly string[];
  readonly unconstrainedAllows: readonly string[];
  readonly escalateBreadth: readonly string[];
}

/**
 * A server whose compile failed (LLM or network error, invalid rules, or
 * verification still failing after every repair). It has no rules in the
 * written policy, so every call to its tools is denied until a later compile
 * succeeds. Mirrors the pipeline's `FailedServer`.
 */
export interface FailedServerDto {
  readonly serverName: string;
  /** The phase the server was in when it failed. */
  readonly phase: Exclude<CompilationPhase, 'cached' | 'done'>;
  /** Single-line, length-bounded failure reason. */
  readonly reason: string;
}

/**
 * Compile result carried by a `done` operation record / event: the policy was
 * written.
 *
 * A terminal `done` record never represents a failed compile — when no policy
 * is written (including when every server failed) the result routes through
 * the `persona.compile.failed` event and `PersonaCompileOperationDto.error`.
 * A `done` result can still be partial: `failedServers` lists servers that
 * failed and were left out of the written policy. Phase 1c adds the optional
 * `ruleDelta` (absent when there was no previous compiled policy to diff
 * against).
 */
export interface PersonaCompileResultDto {
  readonly success: true;
  readonly ruleCount: number;
  readonly ruleDelta?: RuleDeltaDto;
  /** Servers left out of the written policy because they failed. Absent when none failed. */
  readonly failedServers?: readonly FailedServerDto[];
}

/**
 * Snapshot of a streamed persona-compile operation, returned by
 * `personas.getCompile` and inside `personas.listCompiles`.
 *
 * Two distinct phase vocabularies:
 *  - `phase` is the OPERATION lifecycle (started/running/done/failed).
 *  - `serverProgress.compilationPhase` is the 9-value {@link CompilationPhase}
 *    from the pipeline (type-only import) for the server currently compiling.
 *
 * The active operation record is the source of truth (events are best-effort /
 * lossy), so a reconnecting client renders the live phase from a single
 * `personas.listCompiles` call.
 */
export interface PersonaCompileOperationDto {
  readonly operationId: string;
  readonly name: string;
  readonly phase: 'started' | 'running' | 'done' | 'failed';
  readonly serverProgress?: {
    readonly server: string;
    readonly compilationPhase: CompilationPhase;
    readonly detail?: string;
  };
  readonly queuePosition?: number;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly result?: PersonaCompileResultDto;
  readonly error?: { readonly code: ErrorCode; readonly message: string };
  readonly actor: string;
}

/** Response from `personas.listCompiles`. */
export interface PersonaListCompilesDto {
  readonly active: readonly PersonaCompileOperationDto[];
  readonly recent: readonly PersonaCompileOperationDto[];
  readonly queueDepth: number;
}

/** Response from `personas.compileStream` (fire-and-return; jobs.run shape). */
export interface PersonaCompileStreamAckDto {
  readonly accepted: true;
  readonly name: string;
  readonly operationId: string;
  /** True when the operation was enqueued behind the global concurrency gate. */
  readonly queued?: boolean;
}

// ---------------------------------------------------------------------------
// Config (modelProviders) DTO Types
// ---------------------------------------------------------------------------
//
// Wire contract for `config.getModelProviders` / `config.setModelProviders`,
// scoped to the `modelProviders` registry only (see
// docs/designs/openrouter-integration.md §12.6). The DTO carries the SAME
// per-profile fields as the resolved config, with every openrouter profile's
// `apiKey` MASKED (`sk-...xyz` / 'none'). The `native` profile is included in
// the get response (`{ type: 'native' }`) but is always implicit — the set
// path silently drops a verbatim `{ type: 'native' }` echo (F7).

/** One glob→slug rule (mirrors the resolved config's modelMap entry). */
export interface ModelMapRuleDto {
  readonly match: string;
  readonly model: string;
}

/** Provider-preference passthrough (cache pinning) — mirrors the resolved shape. */
export interface ProviderPreferenceDto {
  readonly order?: readonly string[];
  readonly only?: readonly string[];
  readonly allowFallbacks?: boolean;
}

/** The native profile DTO — no fields beyond the discriminator. */
export interface NativeProfileDto {
  readonly type: 'native';
}

/**
 * The openrouter profile DTO. On the GET response `apiKey` is MASKED. On a SET
 * request `apiKey` follows the M5 mask-unchanged contract per profile:
 *   - absent / null / equal-to-the-returned-mask → keep the stored key
 *   - '' (empty string) → clear the stored key
 *   - any other string → set it
 */
export interface GatewayProfileDto {
  readonly type: string;
  readonly apiKey?: string | null;
  readonly plan?: string;
  readonly model?: string;
  readonly modelMap?: readonly ModelMapRuleDto[];
  readonly perAgent?: Readonly<Record<string, string | undefined>>;
  readonly providerPreference?: ProviderPreferenceDto;
  readonly sessionAffinity?: boolean;
}
export interface OpenrouterProfileDto extends GatewayProfileDto {
  readonly type: 'openrouter';
}
export interface ZaiProfileDto extends GatewayProfileDto {
  readonly type: 'zai';
  readonly plan?: 'api' | 'coding';
}
/** Descriptors do not permit new services; the backend validates the built-in profile union. */
export type ProfileDto = GatewayProfileDto;
export type { ProviderEditorDescriptor } from '../config/provider-definitions.js';

/**
 * Response from `config.getModelProviders`. `default` is the resolved default
 * name ('native' when unset); `profiles` always includes the implicit `native`
 * entry and every openrouter profile with its `apiKey` masked.
 */
export interface GetModelProvidersDto {
  readonly providers: readonly import('../config/provider-definitions.js').ProviderEditorDescriptor[];
  readonly summaries: Readonly<Record<string, string>>;
  readonly default: string;
  readonly profiles: Readonly<Record<string, ProfileDto>>;
}

/**
 * Request for `config.setModelProviders`. Carries the WHOLE profiles record
 * (the shallow `deepMergeConfig` replaces `profiles` wholesale, so a partial
 * write would drop unmentioned profiles). `default` is optional; when it names
 * the profile being dropped in the same write, the backend re-points it to
 * 'native' (F10). A verbatim `{ type: 'native' }` under `profiles.native` is
 * accepted-and-dropped (F7); any other value under `native` is rejected.
 */
export interface SetModelProvidersDto {
  /** New name to original name for an atomic rename. */
  readonly renameFrom?: Readonly<Record<string, string>>;
  readonly default?: string;
  readonly profiles: Readonly<Record<string, ProfileDto>>;
}

/** Resolved local statistics settings. Collection defaults on; null disables automatic retention. */
export interface StatisticsConfigDto {
  readonly enabled: boolean;
  readonly retentionDays: number | null;
}

/**
 * Response from `config.listOpenrouterModels`. `source` drives client-side
 * validation strictness: `live`/`cache` are authoritative (hard-block unknown
 * slugs), `bundled` is the known-incomplete offline floor (warn-only). See
 * `catalogEnforces` in `src/config/openrouter-catalog.ts`.
 */
export interface OpenrouterModelsDto {
  readonly models: readonly string[];
  readonly source: 'live' | 'cache' | 'bundled';
}

/** The intentionally small nested-Docker settings surface. */
export interface DockerWorkloadSettingsDto {
  readonly enabled: boolean;
  readonly networkAccess: DockerWorkloadNetworkAccess;
}

// ---------------------------------------------------------------------------
// Error classes for method dispatch
// ---------------------------------------------------------------------------

export class RpcError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

export class InvalidParamsError extends RpcError {
  constructor(message: string) {
    super('INVALID_PARAMS', message);
  }
}

export class SessionNotFoundError extends RpcError {
  constructor(label: number) {
    super('SESSION_NOT_FOUND', `Session #${label} not found`);
  }
}

export class MethodNotFoundError extends RpcError {
  constructor(method: string) {
    super('METHOD_NOT_FOUND', `Unknown method: ${method}`);
  }
}
