import { randomUUID } from 'node:crypto';
import type { DockerAuthKind, IronCurtainConfig } from '../config/types.js';
import type { Sandbox, SandboxInitOptions } from '../sandbox/index.js';
import type { ResolvedResourceBudgetConfig } from '../config/user-config.js';
import type { CumulativeBudgetSnapshot, TurnBudgetSnapshot } from './resource-budget-tracker.js';
import type { AgentId, TransientFailureKind } from '../docker/agent-adapter.js';
import type { AgentImageResolution, DockerInfrastructure } from '../docker/docker-infrastructure.js';
import type { WhitelistCandidateIpc } from '../trusted-process/approval-whitelist.js';
import type { LogRedaction } from '../trusted-process/audit-redactor.js';
import type { TrustedUserMessage } from '../trusted-process/escalation-context.js';
import type { WorkflowCommitHandler } from '../trusted-process/workflow-commit-tool.js';
import type { WorkflowId } from '../workflow/types.js';
import type { ResolvedDockerWorkloadConfig } from '../docker-workload/config.js';
import type { ResourceWatchdogPolicy } from '../docker/resource-watchdog.js';
import type { ReadOnlyWorkspace } from '../types/read-only-workspace.js';

/**
 * Unique identifier for a session. Branded to prevent accidental
 * mixing with other string identifiers.
 */
export type SessionId = string & { readonly __brand: 'SessionId' };

/** Creates a new unique SessionId (v4 UUID). */
export function createSessionId(): SessionId {
  return randomUUID() as SessionId;
}

/**
 * Coerce an unknown WS-boundary value into a SessionId, or return undefined
 * if it is not a string. Use at the JSON-RPC / WebSocket boundary so the
 * `as SessionId` brand-injection happens at one typed seam instead of
 * scattered across call sites.
 */
export function parseSessionId(value: unknown): SessionId | undefined {
  if (typeof value !== 'string') return undefined;
  return value as SessionId;
}

/**
 * Unique key for a Docker infrastructure bundle: one container + its
 * MITM proxy, Code Mode proxy, CA, fake keys, and sockets tree. A
 * single-session CLI run has one `BundleId` (equal to the session's
 * `SessionId` at the value level, though the brands remain distinct at
 * the type level). A shared-container workflow has one `BundleId` per
 * distinct `containerScope` used across its states.
 *
 * Used to key the on-disk directory tree
 * (`workflow-runs/<wfId>/containers/<bundleId>/`), the Docker container
 * name suffix (`ironcurtain-<bundleId[0:12]>`), the
 * `ironcurtain.bundle` Docker label, and the coordinator control socket
 * path.
 *
 * See `docs/designs/workflow-session-identity.md` §2.1.
 */
export type BundleId = string & { readonly __brand: 'BundleId' };

/** Creates a new unique BundleId (v4 UUID). */
export function createBundleId(): BundleId {
  return randomUUID() as BundleId;
}

/**
 * Re-brand a `SessionId` as a `BundleId`. Use ONLY in standalone single-
 * session mode, where the workflow-session-identity invariant (§2.1)
 * guarantees the SessionId value doubles as the BundleId and the
 * deterministic `ironcurtain-<sessionId[0:12]>` container name is
 * preserved across crashes.
 *
 * Workflow / multi-session mode mints a separate BundleId; in that mode
 * SessionId and BundleId values diverge and this helper must NOT be
 * used. Centralized here so the cross-brand cast appears in one auditable
 * place rather than scattered `as unknown as BundleId` sites.
 */
export function bundleIdFromSessionId(sessionId: SessionId): BundleId {
  return sessionId as unknown as BundleId;
}

/**
 * Length of the deterministic short slug derived from a `BundleId` for
 * Docker container names (`ironcurtain-<shortId>`). Matches Docker's
 * conventional short-form container-id truncation.
 */
const BUNDLE_SHORT_ID_LEN = 12;

/**
 * Deterministic short slug of a `BundleId` for use in Docker container
 * names. Hyphens are stripped first so the result preserves
 * `BUNDLE_SHORT_ID_LEN` hex chars of entropy (16^12 ≈ 2.8e14). A raw
 * `substring(0, 12)` on a canonical UUID would include the hyphen at
 * index 8 and yield only 11 hex digits.
 *
 * Mirrors `toBundleSlug` in `config/paths.ts`: both must produce the
 * same 12-hex-char slug so that `ironcurtain.bundle` labels,
 * `ironcurtain-<shortId>` container names, and the
 * `~/.ironcurtain/run/<slug>/` runtime tree share a single
 * bundle-identity convention.
 */
export function getBundleShortId(bundleId: BundleId): string {
  return bundleId.replace(/-/g, '').substring(0, BUNDLE_SHORT_ID_LEN);
}

/**
 * UUID the external agent CLI (e.g., Claude Code) uses for conversation
 * continuity. Passed as `--session-id <id>` on first turn and
 * `--resume <id>` on subsequent turns. Shape is dictated by the external
 * agent: Claude Code writes `projects/<cwd-hash>/<id>.jsonl`, so the
 * UUID must be preserved across turns for the agent to find its own
 * history.
 *
 * This identity does NOT correspond to any IronCurtain-owned directory;
 * its entire purpose is to be handed back to the agent CLI on re-entry.
 *
 * See `docs/designs/workflow-session-identity.md` §2.1.
 */
export type AgentConversationId = string & { readonly __brand: 'AgentConversationId' };

/** Creates a new unique AgentConversationId (v4 UUID). */
export function createAgentConversationId(): AgentConversationId {
  return randomUUID() as AgentConversationId;
}

/**
 * Persisted session metadata written to session-metadata.json.
 * Stores the original user intent (persona name, explicit workspace)
 * rather than resolved paths so that on resume the persona can be
 * re-resolved with updated policies.
 */
export interface SessionMetadata {
  readonly createdAt: string;
  readonly persona?: string;
  readonly workspacePath?: string;
  /**
   * The agent the session was created with: `'builtin'` or a container
   * agent ID. `ironcurtain start --resume` defaults to it, and the session
   * factory refuses a resume across the builtin/container boundary (see
   * `findResumeAgentConflict()` in session-metadata.ts). Absent on sessions
   * created before it was recorded.
   */
  readonly agent?: string;
  /**
   * Resolved provider-profile name (`'native'` or a configured profile).
   * Stored as the resolved name — not "no intent" — so a resumed session
   * keeps its original profile even if `modelProviders.default` later
   * changes on disk. See docs/designs/openrouter-integration.md §9.7 F3.
   */
  readonly providerProfileName?: string;
  readonly policyDir?: string;
  /**
   * Task-scope directory of a `--task-scoped` session (canonical path).
   * Restored on resume so the resumed session keeps the same task scope; a
   * directory that no longer validates refuses the resume.
   */
  readonly taskPolicyDir?: string;
  readonly disableAutoApprove?: boolean;
  /**
   * Agent-CLI conversation id assigned when this session was first
   * created. Persisted so `ironcurtain --resume <sessionId>` can reuse
   * the same id and continue the Claude conversation where it left
   * off. Absent on sessions created before this field was introduced;
   * `createStandaloneSession` falls through to a fresh mint in that
   * case (legacy-session fallback).
   */
  readonly agentConversationId?: AgentConversationId;

  /**
   * The workflow run this session is an agent state of (absent outside
   * workflows, and for sessions created before the field). A state that runs
   * as its own session (builtin, or Docker without `sharedContainer`) keeps
   * its audit log under `sessions/`, so `ironcurtain audit report --workflow
   * <id>` finds that log by this field.
   */
  readonly workflowRunId?: string;

  /**
   * Present only for secure nested Docker-workload sessions. Records the
   * host-only lease identity and configuration/policy snapshots for audit
   * and post-hoc inspection. Because a Docker-workload bundle's daemon state
   * is ephemeral (`daemonState: ephemeral`), a persisted lease can never be
   * revived, so resume validation refuses any session carrying this field.
   */
  readonly dockerWorkload?: {
    readonly leaseId: string;
    readonly generation: string;
    readonly backend: 'docker' | 'apple-container';
  } & (
    | {
        readonly configuration: ResolvedDockerWorkloadConfig;
        readonly watchdogPolicy: ResourceWatchdogPolicy;
        readonly configHash?: never;
        readonly watchdogPolicySha256?: never;
      }
    // Historical records remain readable; new sessions store complete values.
    | {
        readonly configuration?: never;
        readonly configHash: string;
        readonly watchdogPolicy?: ResourceWatchdogPolicy;
        readonly watchdogPolicySha256?: string;
      }
  );
}

/**
 * The possible states a session can be in. Conversational sessions progress
 * from initializing -> ready -> (processing <-> ready) -> closed; process-backed
 * sessions may enter stopping while awaiting confirmed process exit.
 *
 * - initializing: sandbox and resources being set up
 * - ready: accepting messages
 * - processing: a message is being processed (generateText in flight)
 * - stopping: termination requested, awaiting confirmed process exit
 * - closed: resources released, no more messages accepted
 */
export type SessionStatus = 'initializing' | 'ready' | 'processing' | 'stopping' | 'closed';

/**
 * Selects the session implementation.
 *
 * 'builtin' creates the existing AgentSession (UTCP Code Mode + AI SDK).
 * 'docker' creates a DockerAgentSession that spawns an external agent
 * inside a Docker container with MCP proxy mediation.
 */
export type SessionMode =
  | { readonly kind: 'builtin' }
  | { readonly kind: 'docker'; readonly agent: AgentId; readonly authKind?: DockerAuthKind };

/**
 * A single turn in the conversation. Captures what the user said,
 * what the agent responded, and metadata about the turn.
 */
export interface ConversationTurn {
  /** 1-based turn number within this session. */
  readonly turnNumber: number;

  /** The user's input for this turn. */
  readonly userMessage: string;

  /** The agent's final text response for this turn. */
  readonly assistantResponse: string;

  /** Token usage for this turn (prompt + completion). */
  readonly usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    /** Provider-reported thinking/reasoning subset when available. */
    thinkingTokens?: number | null;
    /**
     * Whether the numeric values cover every observed exchange in the turn.
     * When partial, the values are lower bounds: the known parts of partly
     * measured exchanges are included.
     */
    usageCompleteness?: 'complete' | 'partial' | 'unavailable';
    observedExchanges?: number;
    incompleteExchanges?: number;
    /** Exchanges whose usage is entirely unknown (counted as nothing, not as a measured zero). */
    unmeasuredExchanges?: number;
  };

  /** ISO 8601 timestamp when this turn started. */
  readonly timestamp: string;
}

/**
 * A diagnostic event emitted during message processing.
 * Transports decide how (or whether) to display these.
 */
export type DiagnosticEvent =
  | { readonly kind: 'tool_call'; readonly toolName: string; readonly preview: string }
  | { readonly kind: 'agent_text'; readonly preview: string }
  | { readonly kind: 'step_finish'; readonly stepIndex: number }
  | {
      readonly kind: 'loop_detection';
      readonly action: 'warn' | 'block';
      readonly category: string;
      readonly message: string;
    }
  | { readonly kind: 'result_truncation'; readonly originalKB: number; readonly finalKB: number }
  | {
      readonly kind: 'budget_warning';
      readonly dimension: string;
      readonly percentUsed: number;
      readonly message: string;
    }
  | { readonly kind: 'budget_exhausted'; readonly dimension: string; readonly message: string }
  | {
      readonly kind: 'message_compaction';
      readonly originalMessageCount: number;
      readonly newMessageCount: number;
      readonly summaryPreview: string;
    }
  | {
      /**
       * An MCP server's live tools differ from its stored annotations in a
       * way that changes what policy evaluates
       * (`trusted-process/schema-drift.ts`): calls carrying unannotated
       * arguments are denied and conditional roles may fall back to their
       * defaults until the server is re-annotated. Emitted while the session
       * initializes, once per such server
       * (`session/annotation-drift-diagnostics.ts`).
       */
      readonly kind: 'annotation_drift';
      readonly serverName: string;
      /** One-line summary of what drifted (tool and argument names). */
      readonly message: string;
      /** The `annotate-tools` command that refreshes the server's annotations. */
      readonly hint: string;
    }
  | {
      /**
       * The compaction summarizer failed. The turn continued with the
       * uncompacted history; the next attempt waits `retryAfterTurns` turns.
       */
      readonly kind: 'message_compaction_failed';
      /** One-line error description (may carry provider error text). */
      readonly reason: string;
      readonly retryAfterTurns: number;
    }
  | {
      /**
       * An MCP server of the session could not be started (its relay failed
       * to connect or to list its tools; see `Sandbox.getUnavailableServers`).
       * The session runs without it, so the agent cannot use its tools.
       * Emitted while the session initializes, once per such server.
       */
      readonly kind: 'mcp_server_unavailable';
      readonly serverName: string;
      /** One line of error text (may carry server-provided text). */
      readonly reason: string;
    }
  | {
      /**
       * A host-side model the session uses has no credentials
       * (`session/host-model-roles.ts`), so the session changed course:
       * `agent_model` summarizes with the agent's model instead, `disabled`
       * turns the feature off for this session, `degraded` runs it without
       * the model (memory without LLM summarization). Emitted while the
       * session initializes.
       */
      readonly kind: 'host_model_fallback';
      readonly role: HostModelNoticeRole;
      readonly action: HostModelNoticeAction;
      /** What happened and how to fix the configuration. */
      readonly message: string;
    }
  | {
      /**
       * The compiled policy the session enforces may be stale: it records no
       * provenance, comes from another policy compiler or engine version, or
       * was compiled against other tool annotations, or it has rules without
       * a server condition (`config/policy-provenance-check.ts`). Under
       * `policy.onStale: "warn"` (the default) the session runs with it.
       * Emitted while the session initializes, once per warning.
       */
      readonly kind: 'policy_stale';
      /**
       * The warning with the rebuild command: display-sanitized and bounded
       * (`startup-notices.ts`); line feeds separate its reasons.
       */
      readonly message: string;
    }
  | {
      /**
       * The host-mount privilege scan (`docker/host-mount-privilege-scan.ts`,
       * Docker daemons where container root is host root) found setuid/setgid
       * or root-owned entries in the agent container's read-write host
       * mounts. Emitted after an agent turn for what no earlier scan of the
       * bundle reported (or what came back after it was removed), and at
       * session end for everything left; never for a scan that found nothing.
       */
      readonly kind: 'host_privileged_files';
      /** When the scan ran: `after agent turn` or `session end`. */
      readonly when: string;
      /** setuid/setgid files the scan neutralized (it removed the bits). */
      readonly stripped: number;
      /** setuid/setgid files it could not change: owned by root or another user. */
      readonly unstripped: number;
      /** Other root-owned entries. */
      readonly rootOwned: number;
      /** Findings beyond the scan's listing cap, counted but not named in the counts above. */
      readonly unlisted: number;
      /** The first host paths among them, unneutralized files first; display-sanitized. */
      readonly paths: readonly string[];
      /** The scan could not list everything (entry limit, unreadable directories). */
      readonly incomplete: boolean;
      /** What the user should do about them. */
      readonly hint: string;
    };

/** Host-model roles a session checks for credentials (see `host_model_fallback`). */
export type HostModelNoticeRole = 'summary' | 'autoApprove' | 'memory';

/** What a session did about a role without credentials (see `host_model_fallback`). */
export type HostModelNoticeAction = 'agent_model' | 'disabled' | 'degraded';

/**
 * How a session's cost figures were obtained.
 * - `observed`: every LLM exchange observed for the session carried a cost
 *   (gateway-reported, or the host's list-price estimate).
 * - `reported`: the agent's own cumulative report (or OpenRouter's summed
 *   `usage.cost` from the token stream).
 * - `partial`: a lower bound: the observed exchanges that carried a cost.
 * - `unknown`: nothing reported a cost. The amount reads 0; renderers show
 *   "unknown", never "$0.00".
 */
export type BudgetCostSource = 'observed' | 'reported' | 'partial' | 'unknown';

/**
 * What the MITM budget gate of a Docker bundle has charged so far
 * (`docker/budget-gate.ts`): every completion request the bundle's proxy
 * forwarded, whatever metrics lease it carried, at its measured tokens or a
 * conservative estimate when usage could not be measured, priced at list
 * prices (or the gateway's reported cost). Bundle-wide: the charges of a
 * shared workflow bundle cover every session that borrows it.
 */
export interface BudgetGateCharges {
  readonly bundleId: string;
  readonly totalTokens: number;
  readonly costUsd: number;
}

/**
 * Budget status: current consumption snapshot plus configured limits.
 * Exposed to transports for the /budget command and end-of-session summary.
 *
 * For builtin sessions the top-level consumption fields describe the turn in
 * progress and read zero between turns (limits are per turn). Anything that
 * reports after a turn has ended -- cron run records, web DTOs, Signal
 * summaries -- reads `cumulative` (session totals) or `lastTurn`.
 */
export interface BudgetStatus {
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalTokens: number;
  readonly stepCount: number;
  readonly elapsedSeconds: number;
  readonly estimatedCostUsd: number;
  /**
   * Where the cost figures (`estimatedCostUsd`, `cumulative` and `lastTurn`)
   * come from. Absent for a session that prices every step itself (the
   * builtin agent), whose cost is always known.
   */
  readonly costSource?: BudgetCostSource;
  readonly limits: ResolvedResourceBudgetConfig;
  /** The most recently completed turn; null until the first turn ends. */
  readonly lastTurn: TurnBudgetSnapshot | null;
  readonly cumulative: CumulativeBudgetSnapshot;

  /**
   * Cumulative cost from host-observed sources only (MITM/gateway usage
   * records). Docker sessions always set it, because their
   * `cumulative.estimatedCostUsd` falls back to the agent CLI's own
   * `total_cost_usd` self-report, which is display-only and must never drive
   * a decision (a compromised agent prints whatever it likes). Absent on
   * builtin sessions, whose `estimatedCostUsd` is itself host-computed.
   * Budget admission uses this when present, else `cumulative.estimatedCostUsd`.
   */
  readonly hostObservedCostUsd?: number;

  /**
   * The charges of the budget gate of the Docker bundle the session runs in
   * (its own, or the workflow bundle it borrows). The gate counts every
   * completion, attributed or not and whether or not statistics are on, so a
   * workflow's run-wide ceiling counts it too (`workflow/workflow-usage.ts`).
   * Absent for builtin sessions and for a bundle without a gate.
   */
  readonly budgetGate?: BudgetGateCharges;

  /** False for Docker sessions where token usage is not observable. */
  readonly tokenTrackingAvailable: boolean;
  /** Separates unavailable tracking from partial lower-bound totals. */
  readonly tokenTrackingStatus?: 'complete' | 'partial' | 'unavailable';
  readonly observedExchanges?: number;
  readonly incompleteExchanges?: number;
  /** Exchanges whose usage is entirely unknown; budget logic must not read them as zero usage. */
  readonly unmeasuredExchanges?: number;
}

/**
 * Read-only snapshot of session state. Exposed to transports
 * and external observers without giving them mutation access.
 */
export interface SessionInfo {
  readonly id: SessionId;
  readonly status: SessionStatus;
  readonly turnCount: number;
  readonly createdAt: string;
}

/**
 * Factory function for creating sandbox instances.
 * The default creates a real Sandbox wrapping UTCP Code Mode's V8 isolate.
 * Tests provide a factory returning a mock. `options` carries the
 * session's coordinator hooks (today only a workflow state's
 * `workflowCommit` target); it is absent for ordinary sessions.
 */
export type SandboxFactory = (config: IronCurtainConfig, options?: SandboxInitOptions) => Promise<Sandbox>;

/**
 * Escalation request data surfaced to the transport.
 * Decoupled from ToolCallRequest to avoid leaking internal types
 * to transport implementations.
 */
export interface EscalationRequest {
  /** Unique ID for this escalation, used to match approve/deny responses. */
  readonly escalationId: string;
  readonly toolName: string;
  readonly serverName: string;
  readonly arguments: Record<string, unknown>;
  readonly reason: string;
  readonly context?: Readonly<Record<string, string>>;
  /**
   * When the trusted process raised the request (ISO 8601), as written into
   * the request file. The escalation watcher surfaces several pending
   * requests of one session oldest first by it. Absent for a request that
   * did not come from a request file, or from one that carries none.
   */
  readonly createdAt?: string;
  /** Whitelist candidates for display. Present when the proxy supports whitelisting. */
  readonly whitelistCandidates?: readonly WhitelistCandidateIpc[];
  /**
   * The call must be approved by a human, one escalation at a time (see
   * `EvaluationResult.humanOnly`): the auto-approver was not consulted, no
   * whitelist candidate exists, and bulk commands such as `/approve all`
   * must skip it so an operator approves it knowingly. Absent otherwise.
   */
  readonly humanOnly?: boolean;
  /**
   * TRUSTED: the human's most recent message to the session, as the trusted
   * host recorded it (the session for its own turns, the mux or web UI
   * trusted-input bar for a PTY session), with the time it was sent. The
   * pipeline reads it like the auto-approver does but also shows a stale
   * one, with its time. Absent when there is none: no message yet, a turn
   * IronCurtain generated, or a PTY session whose trusted-input bar was not
   * used. See trusted-process/escalation-context.ts.
   */
  readonly lastTrustedUserMessage?: TrustedUserMessage;
  /**
   * TRUSTED: the task the session was started with, its first human message
   * (an `ironcurtain start` task, a cron job's task description), attached by
   * the session (escalation/escalation-review.ts) or by the workflow
   * orchestrator (the workflow's task). Absent for PTY sessions.
   */
  readonly taskSummary?: string;
  /**
   * UNTRUSTED: the agent's own explanation, the `justification` it passed to
   * the `execute_code` chain that issued the call. Written by the agent and
   * attacker-controlled under the threat model: front-ends show it escaped,
   * set apart and labelled as the agent's; the auto-approver never sees it
   * and it authorizes nothing.
   */
  readonly agentJustification?: string;
}

/**
 * Where a message handed to `Session.sendMessage()` comes from.
 *
 * - `user`: typed or sent by the human (the default). The session records it
 *   as the trusted user context the auto-approver matches escalations against.
 * - `system`: generated by IronCurtain itself from content an agent may have
 *   written (the memory auto-save prompt replays the agent's own replies; a
 *   workflow state's prompt embeds the previous states' output). The session
 *   clears the trusted user context for the turn instead, so an escalation
 *   raised while the turn runs always reaches a human.
 */
export type MessageOrigin = 'user' | 'system';

export interface SendMessageOptions {
  /** Defaults to `'user'`. */
  readonly origin?: MessageOrigin;
}

/**
 * Workflow-driven session options, grouped under one optional record so
 * the all-or-nothing relationship between borrow-mode fields is
 * structurally enforced. Set by the workflow orchestrator; standalone
 * CLI / daemon callers leave it unset.
 *
 * Borrow-mode invariant: `stateDir` and `stateSlug` are only meaningful
 * alongside `infrastructure` — the per-state artifact dir and slug have
 * no owner without a bundle. `buildSessionConfig` enforces this at
 * runtime; nesting both under one record keeps the bug surface tight.
 *
 * `skillsDir` and `skillFilter` are workflow-specific but apply in BOTH
 * borrow and non-borrow modes (e.g., a non-shared-container Docker
 * workflow still bundles its package's `skills/`). They live here
 * because their meaning is "this is a workflow run", which is the same
 * gate as the rest of the record.
 *
 * The caller's bundle MUST outlive the session: the session records
 * references into the bundle (MCP clients, file paths, etc.) and
 * expects them to remain valid for its lifetime. Do not destroy the
 * bundle while any session is still holding it.
 */
export interface WorkflowBorrowOptions {
  /** Workflow run and logical state used to attribute LLM statistics. */
  readonly workflowRunId?: WorkflowId;
  readonly stateId?: string;
  readonly personaId?: string;

  /**
   * Pre-built Docker infrastructure bundle. When set, the session
   * factory borrows this bundle instead of creating its own, and the
   * resulting session is constructed with `ownsInfra: false` so
   * `close()` does NOT destroy the bundle. The caller retains full
   * responsibility for destroying it via `destroyDockerInfrastructure`.
   *
   * Optional because workflow runs in non-shared-container mode (each
   * state owns its own bundle) still pass workflow-bundled skills
   * through this record — they have no infrastructure to borrow but
   * still need the rest of the workflow context.
   *
   * The bundle's MCP servers were fixed when it was minted, and it runs
   * no memory server, so a borrowing session has memory off whatever its
   * persona says (`borrowedBundle` in `isMemoryEnabledFor`).
   */
  readonly infrastructure?: DockerInfrastructure;

  /**
   * Per-state artifact directory. When set, the session writes
   * `session.log` and `session-metadata.json` here instead of
   * `{home}/sessions/{sessionId}/`. The directory is created by the
   * caller (orchestrator) before session creation.
   *
   * Only valid alongside `infrastructure`; `buildSessionConfig` throws
   * if `stateDir` is supplied without an infrastructure bundle.
   */
  readonly stateDir?: string;

  /**
   * Human-readable slug identifying this state invocation — used only
   * for logging/diagnostics (e.g., "fetch.1", "plan.2"). Paired with
   * `stateDir` so log messages identify which state produced them.
   */
  readonly stateSlug?: string;

  /**
   * Workflow-bundled skills directory: `<workflow-pkg>/skills/`. When
   * set, skills here are layered into the session's resolved skill set
   * (see `src/skills/discovery.ts` for the layering order). Used in
   * both modes: in standalone mode the resolved set rides through
   * `SessionDirConfig.resolvedSkills` for the docker factory to stage
   * at bundle creation; in borrow mode this matters MOST because the
   * workflow orchestrator passes it per-state and `buildSessionConfig`
   * re-stages in place via `restageSkills` — the bind mount is already
   * live so each state's filter takes effect without a remount.
   */
  readonly skillsDir?: string;

  /**
   * When set, restricts the workflow layer to skills whose `name` is in
   * this set. Built from the agent state's optional `skills:` field;
   * left undefined when the state should receive every workflow-package
   * skill. User-global skills are always included regardless. Honored
   * in both modes — see `skillsDir` for how each mode applies the
   * resolved set.
   */
  readonly skillFilter?: ReadonlySet<string>;

  /**
   * Hard off-switch for every skill layer. When true, no user-global,
   * persona, or workflow-package skills are resolved for this session.
   * Set by workflow states that declare `skills: none`. Mutually
   * exclusive in spirit with `skillsDir` / `skillFilter` — when this
   * is true, those fields are ignored and the resolver returns `[]`.
   */
  readonly disableAllSkills?: boolean;

  /**
   * Target of the coordinator-owned `workflow_commit` tool for a workflow
   * state that builds its own coordinator (builtin mode, or a Docker state
   * that owns its container): the session's coordinator offers the tool and
   * dispatches every call to this handler (see
   * `src/trusted-process/workflow-commit-tool.ts`). Ignored when
   * `infrastructure` is set: a borrowed bundle's coordinator was built with
   * the bundle's own handler.
   */
  readonly workflowCommit?: WorkflowCommitHandler;

  /**
   * Runs the session on a read-only workspace whose agent may change only
   * `writablePaths` (a `workspaceAccess: read-only` workflow state): see
   * `applyReadOnlyWorkspace` in `src/config/read-only-workspace.ts`. Only for
   * a session that builds its own environment. A borrowed bundle
   * (`infrastructure`) got its scope's workspace access when it was minted,
   * so `buildSessionConfig` refuses the two together.
   */
  readonly readOnlyWorkspace?: ReadOnlyWorkspace;
}

/**
 * Options for creating a session. Extends the base config with
 * session-specific overrides.
 */
export interface SessionOptions {
  /** Base configuration. If omitted, loaded from environment. */
  config?: IronCurtainConfig;

  /**
   * Session mode selection. Defaults to 'builtin' for backward compatibility.
   * When 'docker', the agent field specifies which external agent to run.
   */
  mode?: SessionMode;

  /** Exact Docker image prepared by the CLI preflight for this session. */
  preparedDockerImageResolution?: AgentImageResolution;

  /**
   * Aborts standalone Docker session setup (Ctrl-C during startup): container
   * readiness waits end early and the partially created infrastructure is torn
   * down before the factory rejects. Ignored once the session exists; close it
   * instead.
   */
  abortSignal?: AbortSignal;

  /**
   * If provided, resumes this previous session: its directory tree, its
   * workspace and the settings recorded in its metadata. A builtin session
   * also keeps this ID, continues the conversation saved in its
   * `messages.jsonl`, and is refused while another process runs it.
   */
  resumeSessionId?: string;

  /**
   * Maximum number of messages to retain in history before pruning.
   * Defined as an extension point but not enforced in the initial
   * implementation. When the context window is exceeded,
   * generateText() throws and the error propagates to the transport.
   */
  maxHistoryMessages?: number;

  /**
   * Factory for creating sandbox instances.
   * Default: creates a real Sandbox (UTCP Code Mode V8 isolate).
   * Tests provide a factory returning a mock.
   */
  sandboxFactory?: SandboxFactory;

  /**
   * Callback invoked when the proxy surfaces an escalation.
   * The transport uses this to notify the user and collect approval.
   * If not provided, escalations are auto-denied.
   */
  onEscalation?: (request: EscalationRequest) => void;

  /**
   * Callback invoked when a pending escalation expires (proxy timed out),
   * with its ID. Several escalations can be pending at once, each expiring
   * on its own. The transport uses this to clear that escalation's banner
   * and notify the user.
   */
  onEscalationExpired?: (escalationId: string) => void;

  /**
   * Callback invoked when a pending escalation is resolved (approved or denied).
   * Fires after the response file is written, regardless of whether the resolution
   * was initiated by the transport or by the proxy (e.g., Signal approve command).
   */
  onEscalationResolved?: (escalationId: string, decision: 'approved' | 'denied') => void;

  /**
   * Callback invoked during message processing with diagnostic events.
   * Transports use this to display progress (e.g., tool call previews).
   * If not provided, diagnostics are silently dropped.
   *
   * A caller that passes one shows the user the session's notices
   * (`isSessionNotice` in `startup-notices.ts`): the start-up notices,
   * emitted while the session initializes (a stale policy among them), and
   * host-mount findings after turns and at the end. Without one, a stale-policy
   * warning is written to stderr when the session's policy is loaded.
   */
  onDiagnostic?: (event: DiagnosticEvent) => void;

  /**
   * Validated workspace path. When provided, this existing directory replaces
   * the session sandbox as the agent's working area (allowedDirectory).
   * A user-supplied path must be validated via validateWorkspacePath() and
   * passed in the canonical form it returns. Only directories IronCurtain
   * derives itself (a persona workspace, a workflow run's default workspace)
   * may skip that step.
   */
  workspacePath?: string;

  /**
   * Per-session provider-profile selection (OpenRouter integration §9.7).
   * Resolved once at infra prep to the active profile that routes the Docker
   * agent. Unset falls through to `modelProviders.default` (→ `native`).
   * Docker Agent Mode only; silently inert for builtin/Code Mode sessions.
   */
  providerProfileName?: string;

  /**
   * When set, loads compiled-policy.json (and optionally
   * dynamic-lists.json) from this directory instead of the global
   * generated directory. Tool annotations are always loaded from
   * the global location regardless of this setting.
   *
   * Used by cron sessions to load task-scoped policy.
   */
  policyDir?: string;

  /**
   * Task scope (`--task-scoped`): a published task-scope directory (see
   * `config/task-scope-policy.ts`) compiled from this session's task text
   * by the CLI entry point. Its policy is intersected with the session
   * policy (global, persona or `policyDir`) rather than replacing it: a
   * call must be allowed by both, a call outside the task scope escalates,
   * and the most restrictive decision wins. Validated by
   * `buildSessionConfig`; a directory that does not validate refuses the
   * session. Persisted in the session metadata for resume. Never set by
   * default: task scoping is opt-in only.
   */
  taskPolicyDir?: string;

  /**
   * Additional content appended to the system prompt.
   * Used by cron sessions to inject task context and workspace
   * conventions.
   */
  systemPromptAugmentation?: string;

  /**
   * When true, disables the auto-approver for this session even if
   * enabled in user config. Used by cron/headless sessions where there
   * is no interactive user context to match escalations against.
   */
  disableAutoApprove?: boolean;

  /**
   * Persona name. When set, resolves to a policyDir, optional server
   * filter, persistent workspace, and system prompt augmentation.
   * Mutually exclusive with policyDir -- if both are provided,
   * persona takes precedence with a warning.
   */
  persona?: string;

  /**
   * Explicit user override: run the persona (or resume the cron job session)
   * even though its compiled policy no longer matches its constitution (the
   * session log records a warning). Without it a stale persona, or a resumed
   * job session whose job policy is stale, is refused. Only interactive entry
   * points set this (`ironcurtain start --allow-stale-policy`); unattended
   * sessions (cron jobs, workflows) never do.
   */
  allowStalePolicy?: boolean;

  /**
   * Cron job ID. When set (and no persona), the memory server uses
   * a job-specific database at ~/.ironcurtain/jobs/{jobId}/memory.db.
   */
  jobId?: string;

  /**
   * Resource limits the caller sets explicitly for this session: a
   * workflow's `settings.resourceBudget`, a cron job's `budgetOverrides`.
   * They take precedence over the persona's `resourceBudget`, which in turn
   * takes precedence over {@link resourceBudgetBaseline} and the config's
   * `resourceBudget` (see src/session/model-budget-precedence.ts).
   */
  resourceBudgetOverrides?: Partial<ResolvedResourceBudgetConfig>;

  /**
   * The caller's own default limits for this session, below the persona's
   * `resourceBudget` and above the config's `resourceBudget`: the
   * global/default limits a workflow run saved when it started, the cron
   * defaults for a job run.
   */
  resourceBudgetBaseline?: Partial<ResolvedResourceBudgetConfig>;

  /**
   * Qualified model ID ("provider:model-name") for this session only:
   * `--model` on the command line, or a workflow state's or workflow's
   * `model`. Takes precedence over the persona's `agentModelId`, which takes
   * precedence over `config.agentModelId` (see
   * src/session/model-budget-precedence.ts).
   */
  agentModelOverride?: string;

  /**
   * Workflow context. When set, this session is part of a workflow run;
   * the orchestrator populates fields like the borrowed Docker bundle,
   * per-state artifact dir, and bundled skills. Standalone callers
   * leave this unset.
   *
   * See {@link WorkflowBorrowOptions} for the borrow-mode invariants
   * enforced when `infrastructure` is present.
   */
  readonly workflow?: WorkflowBorrowOptions;

  /**
   * The agent-CLI conversation id. Used as `--session-id` on first turn
   * or `--resume` on subsequent turns. Required for Docker sessions
   * (the factory will not mint on behalf of callers); ignored for builtin
   * sessions — resume semantics there are keyed on IronCurtain session
   * directories, not agent-CLI conversation ids.
   *
   * The required-for-Docker contract is enforced at the type level by
   * `DockerSessionOptions` / `BuiltinSessionOptions` below — callers of
   * `createSession()` that pass `mode.kind === 'docker'` must supply this
   * field.
   *
   * See `docs/designs/workflow-session-identity.md` §2.2 / §3 / §8.5.
   */
  readonly agentConversationId?: AgentConversationId;

  /**
   * Per-invocation override for the trajectory-capture toggle. CLI flag
   * `--capture-traces` sets this to `true`; daemon JSON-RPC clients can
   * set this per session. Precedence: `captureTracesOverride > userConfig.capture?.enabled > false`.
   * Honored only in Docker mode (capture is MITM-proxy bound).
   *
   * See docs/designs/mitm-token-trajectory-capture.md §10.
   */
  readonly captureTracesOverride?: boolean;
}

/**
 * Docker-mode options: `agentConversationId` is required because every
 * Docker turn passes it to the agent CLI as `--session-id <id>` /
 * `--resume <id>`. See `SessionOptions.agentConversationId`.
 */
export type DockerSessionOptions = SessionOptions & {
  readonly mode: { readonly kind: 'docker'; readonly agent: AgentId; readonly authKind?: DockerAuthKind };
  readonly agentConversationId: AgentConversationId;
};

/**
 * Builtin-mode options: `agentConversationId` is ignored (builtin resume
 * is keyed on the IronCurtain session directory). `mode` may be omitted
 * (defaults to builtin).
 */
export type BuiltinSessionOptions = SessionOptions & {
  readonly mode?: { readonly kind: 'builtin' };
};

/**
 * The core session contract. A session is a stateful conversation
 * that owns its sandbox, policy engine, and message history.
 *
 * Invariants:
 * - sendMessage() can only be called when status is 'ready'
 * - sendMessage() is not reentrant (status transitions to 'processing')
 * - After close(), no methods except getInfo() are valid
 * - The session ID is unique and immutable for the session's lifetime
 */
/**
 * Outcome of a single agent turn, as returned by
 * `Session.sendMessageDetailed()`. Extends the bare response text
 * with diagnostics the caller may need to decide on retry behavior.
 */
export interface AgentTurnResult {
  /** The agent's text response. Empty string when the process produced no output. */
  readonly text: string;
  /**
   * Set when the agent process was killed or crashed before producing
   * any output (e.g., upstream provider closed the stream mid-generation).
   * Callers that care about distinguishing "upstream stall — retry with a
   * fresh session" from "agent replied but formatted the answer wrong"
   * should consult this flag rather than parsing `text`.
   */
  readonly hardFailure: boolean;
  /**
   * Set when the adapter detected upstream quota exhaustion. When
   * present, the caller MUST NOT retry the turn — the provider's
   * rate-limit window is the bottleneck, not the agent. Workflow
   * callers halt the run and surface `resetAt` (if any) to the user;
   * interactive callers print and exit. See `AgentResponse.quotaExhausted`
   * in `src/docker/agent-adapter.ts` for the adapter-side contract this
   * field is populated from.
   */
  readonly quotaExhausted?: {
    readonly resetAt?: Date;
    readonly rawMessage: string;
  };
  /**
   * Mirrors `AgentResponse.transientFailure` in
   * `src/docker/agent-adapter.ts`. See that field's JSDoc for the
   * canonical contract; in short: terminal-but-resumable, no retry,
   * checkpoint preserved.
   */
  readonly transientFailure?: {
    readonly kind: TransientFailureKind;
    readonly rawMessage: string;
  };
}

export interface Session {
  /** Returns a read-only snapshot of session state. */
  getInfo(): SessionInfo;

  /**
   * Sends a user message and returns the agent's response text.
   *
   * Appends the user message to conversation history, calls the LLM
   * with the full history, appends the response messages, and returns
   * the agent's text.
   *
   * For callers that need turn diagnostics (e.g., to detect upstream
   * stalls and retry with a fresh conversation id), call
   * `sendMessageDetailed()` when it exists.
   *
   * `options.origin` says where the message comes from (see
   * {@link MessageOrigin}); a `'system'` turn never becomes the trusted
   * user context the auto-approver reads.
   *
   * @throws {SessionNotReadyError} if status is not 'ready'
   * @throws {SessionClosedError} if session has been closed, including by a
   *   `close()` while this turn was running
   */
  sendMessage(userMessage: string, options?: SendMessageOptions): Promise<string>;

  /**
   * Sends a user message and returns the response text plus turn
   * diagnostics. Semantically equivalent to `sendMessage()` but surfaces
   * `hardFailure` for callers (e.g., the workflow orchestrator's retry
   * loop) that must react to upstream stalls.
   *
   * Optional because only external-agent sessions (e.g., Claude Code in
   * Docker) can produce hard failures. Consumers that care about the
   * diagnostic should fall back to `sendMessage()` and treat the result
   * as the same response text with `hardFailure: false` when this method
   * is absent.
   *
   * @throws {SessionNotReadyError} if status is not 'ready'
   * @throws {SessionClosedError} if session has been closed
   */
  sendMessageDetailed?(userMessage: string, options?: SendMessageOptions): Promise<AgentTurnResult>;

  /**
   * Starts a fresh agent conversation and returns its freshly-minted id.
   *
   * Intended for use after a hard failure (see `AgentTurnResult.hardFailure`):
   * when the agent CLI was killed mid-stream, the prior id has been
   * consumed by the CLI even though no resumable transcript exists,
   * so a retry with the same id is rejected. Rotating mints a new id
   * the next turn will pin with `--session-id` (or equivalent).
   *
   * Callers must observe the returned id and propagate it into any
   * subsequent `AgentInvokeResult` / checkpoint persistence — otherwise
   * a later `freshSession: false` visit will try to resume a stale id
   * whose transcript never existed on disk.
   *
   * External-agent sessions rotate their durable CLI id. Built-in sessions
   * implement the same operation by clearing model-visible conversation
   * state while retaining diagnostics, tools, sandbox, and cumulative budget.
   * The returned id is the fresh identity callers persist for either mode.
   */
  rotateAgentConversationId?(): AgentConversationId;

  /**
   * Diagnostic accessor: streams the complete log of the session's agent
   * container into `sink` (left open for the caller to end), through the
   * container runtime the session's infrastructure was built with (Docker
   * bound to its captured endpoint, or Apple `container`) and the
   * container's real id, never a guessed name or a hard-coded CLI.
   *
   * Optional because only container-backed sessions have a container. Call
   * it before `close()`, which removes a container the session owns.
   * `workflow run-state` uses it to capture `container-logs.txt`.
   */
  streamContainerLogs?(sink: NodeJS.WritableStream): Promise<void>;

  /**
   * Returns the conversation history as turn summaries: the most recent
   * `SESSION_TURN_HISTORY_LIMIT` turns (`session/bounded-log.ts`), oldest
   * first. `getInfo().turnCount` and each turn's `turnNumber` count every
   * turn, dropped ones included.
   * Does not expose raw ModelMessage[] to avoid coupling
   * callers to the AI SDK's internal message format.
   */
  getHistory(): readonly ConversationTurn[];

  /**
   * Returns the diagnostic events of the session: the most recent
   * `SESSION_DIAGNOSTIC_LOG_LIMIT` of them, oldest first.
   * Transports can use this for a /logs command or similar.
   */
  getDiagnosticLog(): readonly DiagnosticEvent[];

  /**
   * Resolves a pending escalation. Called by the transport
   * when the user approves or denies via a slash command.
   *
   * Writes the response to the escalation directory so the
   * proxy process can pick it up and continue.
   *
   * @throws {Error} if no escalation with this ID is pending
   * @throws {EscalationExpiredError} (code `ESCALATION_EXPIRED`) if the
   *   proxy had already timed the request out: the response came too late
   *   and the tool call was denied, so the caller must not report the
   *   decision as applied
   */
  resolveEscalation(
    escalationId: string,
    decision: 'approved' | 'denied',
    options?: { whitelistSelection?: number },
  ): Promise<void>;

  /**
   * Returns every escalation currently pending, oldest first (empty when
   * none is). Several can be pending at once: the agent's parallel tool
   * calls each wait for their own decision.
   */
  getPendingEscalations(): readonly EscalationRequest[];

  /**
   * Returns current resource budget consumption and configured limits.
   * Used by transports for /budget display and end-of-session summary.
   */
  getBudgetStatus(): BudgetStatus;

  /**
   * Redaction for the transcript a transport writes for this session
   * (`interactions.jsonl`), from the session's configuration: the audit
   * redactor's patterns plus the known credential values, or null when
   * `auditRedaction.enabled` is false. Optional so test doubles need not
   * implement it; a transport then applies the audit redactor's patterns.
   */
  getLogRedaction?(): LogRedaction | null;

  /**
   * Releases all session resources: sandbox, MCP connections,
   * audit log, escalation directory. Idempotent -- safe to call
   * multiple times. After close(), status becomes 'closed' and stays
   * 'closed'. A turn in flight is aborted: it makes no further model
   * call, its running tool calls are cancelled (pending escalations are
   * withdrawn), and its `sendMessage()` rejects with `SessionClosedError`.
   */
  close(): Promise<void>;
}
