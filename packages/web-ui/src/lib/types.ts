/**
 * Frontend type definitions mirroring daemon DTO types.
 * Kept in sync manually -- a shared package could be added later.
 */

export interface SessionSource {
  /**
   * `web-pty` is a live container PTY session streamed to the web UI as an
   * xterm terminal (never registered in the daemon's SessionManager). It is
   * rendered with `TerminalConsole`.
   */
  readonly kind: 'signal' | 'cron' | 'web' | 'web-pty';
  readonly jobId?: string;
  readonly jobName?: string;
  /** Persona name for `web` / `web-pty` sessions. */
  readonly persona?: string;
}

/**
 * Where a cost figure comes from: every observed exchange carried a cost
 * (`observed`), the agent's own report (`reported`), a lower bound
 * (`partial`), or nothing reported one (`unknown`, shown as "unknown").
 * Absent for sessions that price every step themselves.
 */
export type BudgetCostSource = 'observed' | 'reported' | 'partial' | 'unknown';

export interface BudgetSummaryDto {
  readonly totalTokens: number;
  readonly stepCount: number;
  readonly elapsedSeconds: number;
  readonly estimatedCostUsd: number;
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

export interface SessionDto {
  readonly label: number;
  readonly source: SessionSource;
  readonly status: string;
  readonly turnCount: number;
  readonly createdAt: string;
  readonly hasPendingEscalation: boolean;
  readonly messageInFlight: boolean;
  readonly budget: BudgetSummaryDto;
  readonly persona?: string;
  /**
   * ISO 8601 timestamp of the most recent browser attach. Populated only for
   * `web-pty` sessions so the operator can spot an abandoned-but-alive terminal;
   * absent for all other kinds.
   */
  readonly lastAttachedAt?: string;
  /**
   * One-line warning for a `web-pty` session when MCP servers that ask for an
   * OS sandbox will not get one on the daemon host (refused under
   * sandboxPolicy "enforce", or running unconfined under "warn"). Rendered as
   * an alert banner in the terminal view. Absent when every such server is
   * sandboxed. Mirrors the backend `SessionDto.osSandboxWarning`.
   */
  readonly osSandboxWarning?: string;
}

/** Persisted Docker-agent session available to resume as a live terminal. */
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

export interface ConversationTurn {
  readonly turnNumber: number;
  readonly userMessage: string;
  readonly assistantResponse: string;
  readonly timestamp: string;
  readonly usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    /** Null when the provider did not expose a thinking/reasoning split. */
    thinkingTokens?: number | null;
    usageCompleteness?: 'complete' | 'partial' | 'unavailable';
    observedExchanges?: number;
    incompleteExchanges?: number;
  };
}

export interface SessionDetailDto extends SessionDto {
  readonly history: readonly ConversationTurn[];
  readonly diagnosticLog: readonly DiagnosticEvent[];
}

/** Whitelist candidate for display in the escalation UI. */
export interface WhitelistCandidate {
  readonly description: string;
  /** Unambiguous identity of the pattern (the daemon groups escalations by it). */
  readonly patternKey?: string;
}

/** The human's most recent message to a session, as the trusted host recorded it. */
export interface TrustedUserMessage {
  readonly text: string;
  /** ISO 8601 time it was sent, when known. */
  readonly sentAt?: string;
}

/**
 * What a reviewer sees besides the call itself (mirrors
 * `EscalationDisplayFields` in `src/escalation/escalation-review.ts`).
 * `lastTrustedUserMessage` and `taskSummary` are the human's own text;
 * `agentJustification` is written by the agent, UNTRUSTED: shown set apart,
 * labelled as the agent's, and it authorizes nothing.
 */
export interface EscalationReviewContext {
  readonly lastTrustedUserMessage?: TrustedUserMessage;
  readonly taskSummary?: string;
  readonly agentJustification?: string;
}

export interface EscalationDto extends EscalationReviewContext {
  readonly reviewUnavailable?: true;
  readonly escalationId: string;
  readonly sessionLabel: number;
  readonly sessionSource: SessionSource;
  readonly toolName: string;
  readonly serverName: string;
  readonly arguments: Record<string, unknown>;
  readonly reason: string;
  readonly context?: Record<string, string>;
  readonly whitelistCandidates?: readonly WhitelistCandidate[];
  /**
   * The whitelist-pattern group the escalation belongs to. Pending
   * escalations with the same key share one pattern and can be approved
   * together (`escalations.approveGroup`) after a confirmation listing them.
   */
  readonly groupKey?: string;
  readonly receivedAt: string;
}

/** Result of `escalations.approveGroup`. */
export interface EscalationGroupApprovalDto {
  readonly approved: readonly string[];
  readonly failed: readonly { readonly escalationId: string; readonly code: string; readonly message: string }[];
}

export interface DaemonStatusDto {
  readonly uptimeSeconds: number;
  /** `failing`: jobs whose latest run ended in an error (absent from older daemons). */
  readonly jobs: { total: number; enabled: number; running: number; failing?: number };
  readonly signalConnected: boolean;
  readonly webUiListening: boolean;
  readonly activeSessions: number;
  readonly nextFireTime: string | null;
  /**
   * Whether the daemon was launched with `--allow-policy-mutation` (Phase 1c).
   * The UI hides all persona-mutation controls when this is false. Optional in
   * the mirror so pre-1c daemons (which omit it) deserialize cleanly; treat
   * `undefined` as `false` (no mutation controls).
   */
  readonly allowPolicyMutation?: boolean;
  /**
   * The daemon's process-global session mode. `container` → new sessions are
   * `web-pty` live terminals (launch options + trusted-input bar); `builtin` →
   * legacy daemon-managed sessions. Optional in the mirror so a pre-existing
   * daemon that omits it deserializes cleanly.
   */
  readonly sessionMode?: 'builtin' | 'container';
}

export interface JobDefinition {
  readonly id: string;
  readonly name: string;
  readonly schedule: string;
  readonly taskDescription: string;
  readonly enabled: boolean;
}

export interface RunRecord {
  readonly startedAt: string;
  readonly completedAt: string;
  /** `phase` (setup | sync | session) says where an `error` run failed; absent in older records. */
  readonly outcome: { kind: string; message?: string; dimension?: string; phase?: string };
  readonly budget: {
    totalTokens: number;
    stepCount: number;
    elapsedSeconds: number;
    estimatedCostUsd: number;
    costSource?: BudgetCostSource;
  };
  readonly summary: string | null;
  /** What the run's session reported for the user (a stale policy, host-mount findings, ...); display text. */
  readonly notices?: readonly string[];
}

export interface JobListDto {
  readonly job: JobDefinition;
  readonly nextRun: string | null;
  readonly lastRun: RunRecord | null;
  /** True from the moment a run is reserved (before its git sync and session start) until its record is written. */
  readonly isRunning: boolean;
  /** Runs in a row, newest first, that ended in an error (absent from older daemons). */
  readonly consecutiveFailures?: number;
}

/**
 * A diagnostic a session reports for the user to see (mirrors `SessionNotice`
 * in `src/session/startup-notices.ts`): the start-up notices, emitted while
 * the session initializes, and host-mount findings (`host_privileged_files`)
 * after a turn or at session end. Every string can carry server- or
 * agent-chosen text: render it with SafeText.
 */
export type SessionNoticeEvent =
  | { readonly kind: 'annotation_drift'; readonly serverName: string; readonly message: string; readonly hint: string }
  | { readonly kind: 'mcp_server_unavailable'; readonly serverName: string; readonly reason: string }
  | { readonly kind: 'host_model_fallback'; readonly role: string; readonly action: string; readonly message: string }
  | { readonly kind: 'policy_stale'; readonly message: string }
  | {
      readonly kind: 'host_privileged_files';
      readonly when: string;
      readonly stripped: number;
      readonly unstripped: number;
      readonly rootOwned: number;
      readonly unlisted: number;
      readonly paths: readonly string[];
      readonly incomplete: boolean;
      readonly hint: string;
    };

/** A session notice the session view shows until the user dismisses it. */
export interface SessionNoticeEntry {
  /** Identity of the notice: the same notice seeded and pushed is shown once. */
  readonly key: string;
  readonly notice: SessionNoticeEvent;
  readonly dismissed: boolean;
}

export type DiagnosticEvent =
  | { readonly kind: 'tool_call'; readonly toolName: string; readonly preview: string }
  | { readonly kind: 'agent_text'; readonly preview: string }
  | { readonly kind: 'step_finish'; readonly stepIndex: number }
  | {
      readonly kind: 'budget_warning';
      readonly dimension: string;
      readonly percentUsed: number;
      readonly message: string;
    }
  | { readonly kind: 'budget_exhausted'; readonly dimension: string; readonly message: string }
  | SessionNoticeEvent
  | { readonly kind: string; [key: string]: unknown };

/** JSON-RPC response frame. */
export type ResponseFrame =
  | { readonly id: string; readonly ok: true; readonly payload?: unknown }
  | { readonly id: string; readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

/** JSON-RPC event frame. */
export interface EventFrame {
  readonly event: string;
  readonly payload: unknown;
  readonly seq: number;
}

// ---------------------------------------------------------------------------
// Read-only LLM statistics DTOs. Mirror src/llm-metrics query contracts.
// ---------------------------------------------------------------------------

export type LlmStatisticsDimension =
  | 'agent'
  | 'logicalProvider'
  | 'gateway'
  | 'protocol'
  | 'providerProfile'
  | 'requestedModel'
  | 'forwardedModel'
  | 'responseModel'
  | 'servedModel'
  | 'servedProvider'
  | 'reasoningMode'
  | 'requestedServiceTier'
  | 'actualServiceTier'
  | 'inputMeasurementProvenance'
  | 'outputMeasurementProvenance'
  | 'thinkingMeasurementProvenance'
  | 'nonThinkingMeasurementProvenance'
  | 'speedMode'
  | 'streaming'
  | 'outcome'
  | 'refusal'
  | 'usageCompleteness'
  | 'attributionQuality'
  | 'sessionId'
  | 'workflowRunId'
  | 'stateId'
  | 'personaId'
  | 'bundleId';

export type LlmStatisticsMeasure =
  | 'requestCount'
  | 'refusalCount'
  | 'refusalRate'
  | 'errorCount'
  | 'errorRate'
  | 'inputTokens'
  | 'uncachedInputTokens'
  | 'cacheReadInputTokens'
  | 'cacheWriteInputTokens'
  | 'toolUseInputTokens'
  | 'thinkingTokens'
  | 'nonThinkingOutputTokens'
  | 'outputTokens'
  | 'totalTokens'
  | 'costUsd'
  | 'ttftMs'
  | 'upstreamLatencyMs'
  | 'clientLatencyMs'
  | 'effectiveOutputTokensPerSecond';

export type LlmStatisticsDistributionMeasure = Exclude<
  LlmStatisticsMeasure,
  'requestCount' | 'refusalCount' | 'refusalRate' | 'errorCount' | 'errorRate'
>;

export type StatisticsIdentitySource =
  | 'request'
  | 'forwarded_request'
  | 'protocol_response'
  | 'protocol_response_direct'
  | 'router_metadata'
  | 'trusted_gateway_header'
  | 'configured_route'
  | 'not_exposed';

export interface LlmExchangeFilters {
  readonly agent?: readonly string[];
  readonly logicalProvider?: readonly string[];
  readonly gateway?: readonly string[];
  readonly protocol?: readonly string[];
  readonly providerProfile?: readonly string[];
  readonly requestedModel?: readonly string[];
  readonly forwardedModel?: readonly string[];
  readonly responseModel?: readonly string[];
  readonly servedModel?: readonly string[];
  readonly servedProvider?: readonly string[];
  readonly reasoningMode?: readonly string[];
  readonly requestedServiceTier?: readonly string[];
  readonly actualServiceTier?: readonly string[];
  readonly inputMeasurementProvenance?: readonly string[];
  readonly outputMeasurementProvenance?: readonly string[];
  readonly thinkingMeasurementProvenance?: readonly string[];
  readonly nonThinkingMeasurementProvenance?: readonly string[];
  readonly speedMode?: readonly string[];
  readonly streaming?: readonly boolean[];
  readonly outcome?: readonly string[];
  readonly refusal?: readonly boolean[];
  readonly usageCompleteness?: readonly string[];
  readonly attributionQuality?: readonly string[];
  readonly sessionId?: readonly string[];
  readonly workflowRunId?: readonly string[];
  readonly stateId?: readonly string[];
  readonly personaId?: readonly string[];
  readonly bundleId?: readonly string[];
}

export interface StatisticsRangeQuery {
  readonly fromMs: number;
  readonly toMs: number;
  readonly filters?: LlmExchangeFilters;
}

export interface StatisticsSummaryQuery extends StatisticsRangeQuery {
  readonly measures: readonly LlmStatisticsMeasure[];
  readonly groupBy?: readonly LlmStatisticsDimension[];
  readonly topGroups?: number;
}

export type StatisticsSeriesQuery = StatisticsSummaryQuery &
  (
    | { readonly bucketMs: number; readonly calendarBucket?: never }
    | {
        readonly bucketMs?: never;
        readonly calendarBucket: {
          readonly unit: 'day';
          readonly timeZone: string;
        };
      }
  );

export interface StatisticsDistributionQuery extends StatisticsRangeQuery {
  readonly measure: LlmStatisticsDistributionMeasure;
  readonly maxBins?: number;
}

export interface StatisticsExchangeQuery extends StatisticsRangeQuery {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface StatisticsDimensionQuery extends StatisticsRangeQuery {
  readonly dimension: LlmStatisticsDimension;
  readonly limit?: number;
}

export interface StatisticsMetricSummaryDto {
  readonly dimensions: Readonly<Record<string, string | boolean | null>>;
  /**
   * Display names for pseudonymized dimension values (persona, provider
   * profile, agent), keyed by dimension. Present only when one resolves.
   */
  readonly labels?: Readonly<Record<string, string>>;
  readonly measure: LlmStatisticsMeasure;
  readonly value: number | null;
  readonly sampleCount: number;
  /** Exchanges that added only their known parts to an input/output/total token sum. */
  readonly lowerBoundCount?: number;
  readonly sampleSessionCount: number;
  readonly eligibleCount: number;
  readonly coverage: number;
  readonly median: number | null;
  readonly lowerQuartile: number | null;
  readonly upperQuartile: number | null;
  readonly formulaVersion: number;
}

export interface StatisticsTimeBucketDto {
  readonly fromMs: number;
  readonly toMs: number;
  readonly summaries: readonly StatisticsMetricSummaryDto[];
}

export interface StatisticsDimensionValueDto {
  readonly value: string | boolean | null;
  /** Display name when `value` is the pseudonym of a configured persona, profile or agent. */
  readonly label?: string;
  readonly count: number;
}

export interface StatisticsDistributionBinDto {
  readonly lower: number;
  readonly upper: number;
  readonly count: number;
}

export interface StatisticsMetricDistributionDto {
  readonly measure: LlmStatisticsDistributionMeasure;
  readonly bins: readonly StatisticsDistributionBinDto[];
  readonly sampleCount: number;
  readonly eligibleCount: number;
  readonly coverage: number;
  readonly minimum: number | null;
  readonly maximum: number | null;
  readonly formulaVersion: number;
}

export interface StatisticsRepositoryHealthDto {
  readonly state: 'starting' | 'ready' | 'degraded' | 'restarting' | 'disabled' | 'closed';
  readonly schemaVersion: number | null;
  readonly observed: number;
  readonly finalized: number;
  readonly enqueued: number;
  readonly persisted: number;
  readonly duplicates: number;
  readonly dropped: number;
  readonly queuedRecords: number;
  readonly queuedBytes: number;
  readonly lastError: string | null;
  readonly readerState: 'idle' | 'starting' | 'ready' | 'unavailable' | 'closed';
  readonly readerLastError: string | null;
}

export interface StatisticsCapabilitiesDto {
  readonly available: boolean;
  readonly dtoVersion: number;
  readonly formulaVersion: number;
  readonly schemaVersion: number | null;
  readonly maxPageSize: number;
  /** Most matching observations one aggregation query may summarize (else STATISTICS_LIMIT). */
  readonly maxScannedRows: number;
  readonly maxGroups: number;
  readonly maxOutputItems?: number;
  readonly maxTimeSeriesBuckets?: number;
  readonly maxRangeDays?: number;
  readonly maxResponseBytes?: number;
  /** Quartiles come from at most this many exact values per summary. */
  readonly quantileSampleSize?: number;
  readonly allowedBucketSizesMs: readonly number[];
  readonly allowedCalendarBucketUnits: readonly 'day'[];
  readonly health: StatisticsRepositoryHealthDto;
}

/** Content-free flattened exchange returned by statistics.exchanges. */
export interface StatisticsExchangeDto {
  readonly exchangeId: string;
  readonly schemaVersion: number;
  readonly completedAtMs: number;
  readonly requestReceivedAtMs: number;
  readonly sessionId: string | null;
  readonly turnId: string | null;
  readonly agentConversationId: string | null;
  readonly bundleId: string | null;
  readonly workflowRunId: string | null;
  readonly stateId: string | null;
  readonly personaId: string | null;
  readonly attributionQuality: string;
  readonly agent: string | null;
  readonly logicalProvider: string;
  readonly providerProfile: string | null;
  readonly protocol: string;
  readonly gateway: string;
  readonly clientRouteId: string | null;
  readonly upstreamRouteId: string | null;
  readonly requestedModel: string | null;
  readonly forwardedModel: string | null;
  readonly responseModel: string | null;
  readonly servedModel: string | null;
  readonly servedModelSource: StatisticsIdentitySource;
  readonly servedProvider: string | null;
  readonly servedProviderSource: StatisticsIdentitySource;
  readonly providerRequestId: string | null;
  readonly providerResponseId: string | null;
  readonly gatewayGenerationId: string | null;
  readonly streaming: boolean | null;
  readonly requestedServiceTier: string | null;
  readonly actualServiceTier: string | null;
  readonly reasoningMode: string;
  readonly reasoningEffort: string | null;
  readonly thinkingBudgetTokens: number | null;
  readonly speedMode: string | null;
  readonly responseStatus: number | null;
  readonly outcome: string;
  readonly providerStopReason: string;
  readonly refusal: boolean | null;
  readonly refusalCategory: string | null;
  readonly inputTokens: number | null;
  readonly uncachedInputTokens: number | null;
  readonly cacheReadInputTokens: number | null;
  readonly cacheWriteInputTokens: number | null;
  readonly toolUseInputTokens: number | null;
  readonly outputTokens: number | null;
  readonly thinkingTokens: number | null;
  readonly nonThinkingOutputTokens: number | null;
  readonly providerTotalTokens: number | null;
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
  readonly usageCompleteness: string;
  readonly usageSemanticsVersion: number;
  readonly inputMeasurementProvenance: string;
  readonly outputMeasurementProvenance: string;
  readonly thinkingMeasurementProvenance: string;
  readonly nonThinkingMeasurementProvenance: string;
  readonly requestBodyCompleteOffsetMs: number | null;
  readonly responseHeadersOffsetMs: number | null;
  readonly firstUpstreamBodyByteOffsetMs: number | null;
  readonly firstProtocolEventOffsetMs: number | null;
  readonly firstReasoningOffsetMs: number | null;
  readonly lastReasoningOffsetMs: number | null;
  readonly firstOutputOffsetMs: number | null;
  readonly lastOutputOffsetMs: number | null;
  readonly protocolTerminalOffsetMs: number | null;
  readonly upstreamResponseEndOffsetMs: number | null;
  readonly clientDeliveryEndOffsetMs: number | null;
  readonly clientAborted: boolean;
  readonly qualityFlags: readonly string[];
}

export interface StatisticsExchangePageDto {
  readonly items: readonly StatisticsExchangeDto[];
  readonly nextCursor: string | null;
  readonly snapshotMaxSequence: number;
}

// ---------------------------------------------------------------------------
// PTY terminal streaming (web-pty session kind)
//
// Client -> server RPC methods: `sessions.ptyAttach`, `sessions.ptyDetach`,
// `sessions.ptyInput` ({ label, data }), `sessions.ptyResize`
// ({ label, cols, rows }). Server -> client events below. Every `data` /
// `snapshot` field is base64 of the UTF-8 bytes of a terminal string.
// ---------------------------------------------------------------------------

/** Incremental terminal delta pushed to subscribed clients. */
export interface PtyOutputEvent {
  readonly label: number;
  /** base64 of UTF-8 bytes. */
  readonly data: string;
}

/** One-shot full-screen snapshot sent to a single client on attach/resync. */
export interface PtyReplayEvent {
  readonly label: number;
  /** base64 of UTF-8 bytes. */
  readonly snapshot: string;
}

/**
 * Imperative terminal sink the Sessions route installs (keyed by label) so the
 * pure event handler can route incoming `session.pty_*` events to the bound
 * `TerminalConsole` without importing Svelte or the DOM. Both payloads are the
 * raw base64 strings off the wire; the component decodes at the xterm boundary.
 */
export interface PtySink {
  /** Apply an incremental delta (`PtyOutputEvent.data`). */
  write(dataB64: string): void;
  /** Clear and repaint from a full snapshot (`PtyReplayEvent.snapshot`). */
  reset(snapshotB64: string): void;
}

/**
 * Why a persona's compiled policy is stale. Mirrors backend
 * `PolicyStaleReason` (src/config/constitution-hash.ts): `'constitution'` =
 * the constitution changed after the policy was compiled; `'engine'` =
 * compiled for another policy-engine generation (reserved).
 */
export type PolicyStaleReason = 'constitution' | 'engine';

/** Available persona for session creation (`personas.list` row). */
export interface PersonaListItem {
  readonly name: string;
  readonly description: string;
  /** Whether a compiled policy exists (it may still be stale). */
  readonly compiled: boolean;
  /**
   * Present when the compiled policy no longer matches the persona. The
   * daemon refuses to start a session with a stale persona, so it is not a
   * launchable choice until it is recompiled.
   */
  readonly stale?: PolicyStaleReason;
}

/**
 * Launch options for `sessions.create`. `persona` applies to every session mode;
 * `workspacePath` / `providerProfileName` / `model` are container web-pty launch
 * options (mux `/new` parity).
 */
export interface CreateSessionOptions {
  readonly persona?: string;
  readonly workspacePath?: string;
  readonly providerProfileName?: string;
  readonly model?: string;
}

/** An escalation enriched with a monotonic display number for modal ordering. */
export interface PendingEscalation extends EscalationDto {
  readonly displayNumber: number;
}

/** Output line for the session console. */
export interface OutputLine {
  readonly kind: 'user' | 'assistant' | 'tool_call' | 'thinking' | 'error' | 'system' | 'escalation';
  readonly text: string;
  readonly timestamp: string;
  readonly escalationId?: string;
}

// ---------------------------------------------------------------------------
// Workflow types
// ---------------------------------------------------------------------------

/** Phases reported by the orchestrator for a workflow currently tracked in memory. */
export type LiveWorkflowPhase = 'running' | 'waiting_human' | 'completed' | 'failed' | 'aborted';

/**
 * Phases that appear on past-run records loaded from disk. `running_elsewhere`
 * marks a run that is live in another IronCurtain process (its run lock is
 * held there), so it is neither interrupted nor resumable from this daemon.
 */
export type PastRunPhase = 'completed' | 'failed' | 'aborted' | 'waiting_human' | 'interrupted' | 'running_elsewhere';

/**
 * Wide phase union covering both live summaries and past-run records.
 * Retained for backwards compatibility with code that handles all phases uniformly
 * (e.g. badge styling). New code should prefer the narrower `LiveWorkflowPhase` /
 * `PastRunPhase` aliases where possible.
 */
export type WorkflowPhase = LiveWorkflowPhase | PastRunPhase;

/** Constants for WorkflowPhase values — avoids magic strings in event handlers. */
export const PHASE = {
  RUNNING: 'running',
  WAITING_HUMAN: 'waiting_human',
  COMPLETED: 'completed',
  FAILED: 'failed',
  ABORTED: 'aborted',
  INTERRUPTED: 'interrupted',
  RUNNING_ELSEWHERE: 'running_elsewhere',
} as const satisfies Record<string, WorkflowPhase>;

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
  readonly workflowId: string;
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
 * Past-run record returned by `workflows.listResumable`.
 *
 * Covers terminal runs (completed/failed/aborted), runs paused at a human gate
 * (`waiting_human`), and runs whose checkpoint exists on disk with no live
 * orchestrator instance and no recorded `finalStatus` (`interrupted` — typically
 * a daemon crash mid-run; the phase is synthesized at the DTO boundary).
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

export interface HumanGateRequestDto {
  readonly gateId: string;
  readonly workflowId: string;
  readonly stateName: string;
  readonly acceptedEvents: readonly string[];
  readonly presentedArtifacts: readonly string[];
  readonly summary: string;
}

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

export interface ResourceBudgetConfigDto {
  readonly maxTotalTokens: number | null;
  readonly maxSteps: number | null;
  readonly maxSessionSeconds: number | null;
  readonly maxEstimatedCostUsd: number | null;
  readonly warnThresholdPercent: number;
}

/** Run-wide ceiling (`settings.workflowBudget`); omitted or null fields set no ceiling. */
export interface WorkflowBudgetLimitsDto {
  readonly maxTotalTokens?: number | null;
  readonly maxEstimatedCostUsd?: number | null;
  readonly maxWallClockSeconds?: number | null;
}

/**
 * Run-wide usage over every agent session, lane and resume of a workflow.
 * Token figures are lower bounds unless `tokenTrackingStatus` is `complete`.
 * Mirrors `WorkflowUsage` in `src/workflow/workflow-usage.ts`.
 */
export interface WorkflowUsageDto {
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  /** Input plus output, plus what only the budget gates counted (`gateOnlyTokens`). */
  readonly totalTokens: number;
  /** Host-derived cost; a Docker agent's own cost report is never counted. */
  readonly estimatedCostUsd: number;
  /** Part of `totalTokens` only the bundles' budget gates counted (absent from older daemons). */
  readonly gateOnlyTokens?: number;
  /** Part of `estimatedCostUsd` only the bundles' budget gates counted (absent from older daemons). */
  readonly gateOnlyCostUsd?: number;
  readonly activeSeconds: number;
  readonly observedExchanges: number;
  readonly incompleteExchanges: number;
  readonly unmeasuredExchanges: number;
  readonly meteredSessions: number;
  readonly reportedSessions: number;
  readonly untrackedSessions: number;
  /** Untracked sessions no budget gate counted either: the run's ceilings fail closed (absent from older daemons). */
  readonly uncountedSessions?: number;
  readonly lowerBound: boolean;
  readonly tokenTrackingStatus: 'complete' | 'partial' | 'unavailable';
}

export interface WorkflowBudgetDto {
  readonly activeSessionCount?: number;
  readonly limits: ResourceBudgetConfigDto;
  readonly sources: Record<keyof ResourceBudgetConfigDto, 'workflow' | 'global' | 'default'>;
  readonly recorded: boolean;
  readonly usage?: {
    readonly totalTokens: number;
    readonly stepCount: number;
    readonly elapsedSeconds: number;
    readonly estimatedCostUsd: number;
    /** `unknown`: nothing reported a cost, so `estimatedCostUsd` (0) is not zero spend. */
    readonly costSource?: BudgetCostSource;
    readonly tokenTrackingAvailable: boolean;
    /** `partial`: the token total is a lower bound. */
    readonly tokenTrackingStatus?: 'complete' | 'partial' | 'unavailable';
    readonly observedExchanges?: number;
    readonly incompleteExchanges?: number;
  };
  /** The run-wide ceiling, when the workflow sets one. */
  readonly workflowLimits?: WorkflowBudgetLimitsDto;
  /** Run-wide usage the ceiling is checked against. */
  readonly workflowUsage?: WorkflowUsageDto;
}

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
  /** Run-wide usage (tokens by kind, cost, running time, tracking status); absent from older daemons. */
  readonly usage?: WorkflowUsageDto;
  readonly startedAt: string;
  readonly description: string;
  readonly stateGraph: StateGraphDto;
  readonly transitionHistory: readonly TransitionRecordDto[];
  readonly context: WorkflowContextDto;
  readonly gate?: HumanGateRequestDto;
  /** Tool calls blocked on a human decision (present only while some are pending). */
  readonly escalations?: readonly WorkflowEscalationDto[];
  readonly workspacePath: string;
  /** True when the workflow's source package ships a `README.md` (fetch via `workflows.readme`). */
  readonly hasReadme: boolean;
};

/**
 * A tool call that policy escalated inside a workflow agent state and that
 * waits for a human (mirrors `WorkflowToolCallEscalation` in
 * `src/workflow/types.ts`). The agent is blocked inside the call until it is
 * approved, denied, or expires at the escalation timeout. Resolved with
 * `workflows.resolveEscalation`.
 */
export interface WorkflowEscalationDto extends EscalationReviewContext {
  readonly reviewUnavailable?: true;
  readonly escalationId: string;
  readonly workflowId: string;
  readonly stateId: string;
  readonly persona?: string;
  readonly serverName: string;
  readonly toolName: string;
  readonly arguments: Record<string, unknown>;
  readonly reason: string;
  readonly context?: Record<string, string>;
  readonly whitelistCandidates?: readonly WhitelistCandidate[];
  /** Must be decided by a human, approved once and never whitelisted (e.g. opening a passthrough domain). */
  readonly humanOnly?: boolean;
  readonly receivedAt: string;
}

// ---------------------------------------------------------------------------
// Workflow message log types
//
// Mirrors the discriminated union in `src/workflow/message-log.ts`. Kept in
// sync manually so the web-ui package stays self-contained and does not need
// to reach into `src/workflow/`.
// ---------------------------------------------------------------------------

interface MessageLogBaseEntry {
  readonly ts: string;
  readonly workflowId: string;
  readonly state: string;
}

export interface AgentSentEntry extends MessageLogBaseEntry {
  readonly type: 'agent_sent';
  readonly role: string;
  readonly message: string;
}

export interface AgentReceivedEntry extends MessageLogBaseEntry {
  readonly type: 'agent_received';
  readonly role: string;
  readonly message: string;
  readonly verdict: string | null;
  readonly confidence: string | null;
}

/**
 * Why the orchestrator sent an agent another turn. `missing_commit`: under
 * the commit-tool protocol the turn ended without an accepted
 * `workflow_commit` call, so the state had not committed.
 */
export type AgentRetryReason =
  | 'missing_status_block'
  | 'malformed_status_block'
  | 'missing_commit'
  | 'missing_artifacts'
  | 'invalid_verdict'
  | 'upstream_stall';

export interface AgentRetryEntry extends MessageLogBaseEntry {
  readonly type: 'agent_retry';
  readonly role: string;
  readonly reason: AgentRetryReason;
  readonly details: string;
  readonly retryMessage: string;
}

export interface GateRaisedEntry extends MessageLogBaseEntry {
  readonly type: 'gate_raised';
  /** Per-raise gate id; absent on logs written before per-raise ids existed. */
  readonly gateId?: string;
  readonly acceptedEvents: readonly string[];
}

export interface GateResolvedEntry extends MessageLogBaseEntry {
  readonly type: 'gate_resolved';
  /** Id of the raise the decision was validated against; absent on legacy logs. */
  readonly gateId?: string;
  readonly event: string;
  readonly prompt: string | null;
  /** Channel the decider declared (`web-ui`, `cli`, `signal`, `rpc`); absent on legacy logs. */
  readonly resolvedBy?: string;
}

/**
 * A tool call that policy escalated during an agent state, raised to the
 * workflow's human route, and how it ended (one `raised` entry, then exactly
 * one of `approved` / `denied` / `expired`).
 */
export interface ToolCallEscalationEntry extends MessageLogBaseEntry {
  readonly type: 'tool_call_escalation';
  readonly escalationId: string;
  readonly serverName: string;
  readonly toolName: string;
  readonly reason: string;
  readonly outcome: 'raised' | 'approved' | 'denied' | 'expired';
}

export interface ErrorEntry extends MessageLogBaseEntry {
  readonly type: 'error';
  readonly error: string;
  readonly context?: string;
}

export interface StateTransitionEntry extends MessageLogBaseEntry {
  readonly type: 'state_transition';
  readonly from: string;
  readonly event: string;
}

export interface QuotaExhaustedEntry extends MessageLogBaseEntry {
  readonly type: 'quota_exhausted';
  readonly role: string;
  readonly resetAt?: string;
  readonly rawMessage: string;
}

/** Discriminated union of all message-log entry types. */
export type MessageLogEntry =
  | AgentSentEntry
  | AgentReceivedEntry
  | AgentRetryEntry
  | GateRaisedEntry
  | GateResolvedEntry
  | ToolCallEscalationEntry
  | ErrorEntry
  | StateTransitionEntry
  | QuotaExhaustedEntry;

/**
 * A {@link MessageLogEntry} as delivered in a `workflows.messageLog` page.
 * String fields longer than the daemon's inline limit (8,192 characters)
 * arrive cut to that length with `truncated: true` and an opaque `ref` that
 * `workflows.messageLogEntry` accepts to fetch the complete entry.
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
 * entries or at the daemon's per-page byte budget, whichever comes first.
 */
export interface MessageLogResponseDto {
  readonly entries: readonly MessageLogEntryDto[];
  readonly hasMore: boolean;
}

/** Response from `workflows.messageLogEntry`: one complete entry addressed by a page entry's `ref`. */
export interface MessageLogEntryResponseDto {
  readonly entry: MessageLogEntry;
}

// ---------------------------------------------------------------------------
// File browser types
// ---------------------------------------------------------------------------

export interface FileTreeEntryDto {
  readonly name: string;
  readonly type: 'file' | 'directory';
  readonly size?: number;
}

/**
 * Response from `workflows.fileTree`. The daemon lists at most 2,000 entries
 * per directory (directories and regular files only) and sets `truncated`
 * when it stopped early.
 */
export interface FileTreeResponseDto {
  readonly entries: readonly FileTreeEntryDto[];
  readonly truncated?: boolean;
}

/**
 * Response from `workflows.fileContent` and `workflows.artifactFile`. Exactly
 * one of `content`, `binary` or `error` is set; `error` is a short display
 * message (e.g. "File too large to display (>1MB)", "Not a regular file").
 */
export interface FileContentResponseDto {
  readonly content?: string;
  readonly language?: string;
  readonly binary?: boolean;
  readonly error?: string;
}

/** One file of an artifact listing: `/`-separated path below the artifact directory and size in bytes. */
export interface ArtifactFileDto {
  readonly path: string;
  readonly size: number;
}

/**
 * Response from `workflows.artifacts`: names and sizes only. Contents are
 * fetched per file through `workflows.artifactFile`, so the gate review panel
 * loads them lazily. `truncated` is set when the daemon stopped listing early
 * (file count, depth or listing-byte budget).
 */
export interface ArtifactContentDto {
  readonly files: readonly ArtifactFileDto[];
  readonly truncated: boolean;
}

// ---------------------------------------------------------------------------
// Workflow definition types
// ---------------------------------------------------------------------------

export type WorkflowSource = 'bundled' | 'user' | 'custom';

export interface WorkflowDefinitionDto {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly source: WorkflowSource;
  /** True when the package ships a `README.md` (fetch with `workflows.readme`). */
  readonly hasReadme: boolean;
}

/** README markdown for a workflow, returned by `workflows.readme`. */
export interface WorkflowReadmeDto {
  /** Raw markdown source; the client renders + sanitizes it. */
  readonly content: string;
}

// ---------------------------------------------------------------------------
// Persona types
// ---------------------------------------------------------------------------

export interface PersonaDetailDto {
  readonly name: string;
  readonly description: string;
  readonly createdAt: string;
  readonly constitution: string;
  readonly servers?: readonly string[];
  readonly hasPolicy: boolean;
  readonly policyRuleCount?: number;
  /** Present when the compiled policy is stale (see {@link PolicyStaleReason}). */
  readonly stale?: PolicyStaleReason;
  /** Whether persistent memory is enabled (persona.memory?.enabled ?? true). */
  readonly memory?: boolean;
  /**
   * Whether this persona may compile a broad policy (persona.allowBroadPolicy
   * ?? false). Set only via the gated `personas.setBroadPolicyOptIn`. Drives
   * the broad-policy opt-in control + the BROAD_POLICY_REJECTED affordance.
   * Added in Phase 1c. Optional in the mirror for pre-1c back-compat.
   */
  readonly allowBroadPolicy?: boolean;
}

/** Slim list-row returned by `personas.list`. Mirrors backend PersonaListDto. */
export interface PersonaListDto {
  readonly name: string;
  readonly description: string;
  readonly compiled: boolean;
  readonly stale?: PolicyStaleReason;
  readonly memory?: boolean;
}

/** Result of editing a persona constitution. Mirrors backend PersonaEditResultDto. */
export interface PersonaEditResultDto {
  readonly stale: boolean;
}

// ---------------------------------------------------------------------------
// Config (modelProviders) types — mirror src/web-ui/web-ui-types.ts.
// ---------------------------------------------------------------------------

/** One glob→slug rule for a modelMap. */
export interface ModelMapRuleDto {
  readonly match: string;
  readonly model: string;
}

/** Provider-preference passthrough (cache pinning). */
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
 * The openrouter profile DTO. On the GET response `apiKey` is MASKED
 * (`sk-...xyz` / 'none'). On a SET request `apiKey` follows the M5
 * mask-unchanged contract: absent/null/mask-equal → keep, '' → clear, other → set.
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
export type ProfileDto = GatewayProfileDto;

/** Credential-free built-in provider metadata supplied by the daemon. */
export interface ProviderEditorDescriptor {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly credentialEnv: string;
  readonly credentialPlaceholder: string;
  readonly modelPlaceholder: string;
  readonly catalog: 'remote' | 'manual';
  readonly model?: { readonly label: string; readonly defaultValue: string; readonly defaultMapMatch?: string };
  readonly plan?: {
    readonly defaultValue: string;
    readonly choices: readonly { readonly value: string; readonly label: string }[];
  };
  readonly providerRouting: boolean;
  readonly sessionAffinity: boolean;
  readonly defaultMap: readonly ModelMapRuleDto[];
}

/** Response from `config.getModelProviders`. */
export interface GetModelProvidersDto {
  readonly providers: readonly ProviderEditorDescriptor[];
  readonly summaries: Readonly<Record<string, string>>;
  readonly default: string;
  readonly profiles: Readonly<Record<string, ProfileDto>>;
}

/** Request for `config.setModelProviders` (whole profiles record). */
export interface SetModelProvidersDto {
  /** New name to original name for an atomic rename. */
  readonly renameFrom?: Readonly<Record<string, string>>;
  readonly default?: string;
  readonly profiles: Readonly<Record<string, ProfileDto>>;
}

export interface StatisticsConfigDto {
  readonly enabled: boolean;
  readonly retentionDays: number | null;
}

/**
 * Response from `config.listOpenrouterModels`. `source` drives validation
 * strictness: `live`/`cache` hard-block unknown slugs; `bundled` (the offline
 * floor) is warn-only.
 */
export interface OpenrouterModelsDto {
  readonly models: readonly string[];
  readonly source: 'live' | 'cache' | 'bundled';
}

/** Narrow runtime settings exposed by the web UI. */
export type DockerWorkloadNetworkAccess = 'offline' | 'images' | 'packages';

export interface DockerWorkloadSettingsDto {
  readonly enabled: boolean;
  readonly networkAccess: DockerWorkloadNetworkAccess;
}

// ---------------------------------------------------------------------------
// Persona streamed-compile types (Phase 1b). Mirror src/web-ui/web-ui-types.ts.
// ---------------------------------------------------------------------------

/**
 * 9-value per-server compilation phase. Mirrors the pipeline's CompilationPhase
 * union (type-only re-exported by the backend wire-types module).
 */
export type CompilationPhase =
  | 'cached'
  | 'compiling'
  | 'lists'
  | 'scenarios'
  | 'repair-scenarios'
  | 'verifying'
  | 'repair-compile'
  | 'repair-verify'
  | 'done';

/**
 * Phase-1b error codes mirrored for the frontend. The frontend's RPC error
 * `code` field is a plain string on the wire (ResponseFrame), so this alias is
 * documentation/typing for the affordances; it is not exhaustively enforced.
 */
export type PersonaCompileErrorCode =
  | 'COMPILE_IN_PROGRESS'
  | 'COMPILE_QUEUE_FULL'
  | 'CREDENTIALS_MISSING'
  | 'LIST_REQUIRES_MCP'
  | 'POLICY_MUTATION_FORBIDDEN'
  | 'PERSONA_NOT_FOUND'
  | 'INVALID_PARAMS'
  // Phase 1c persona-CRUD error codes (mirror src/web-ui/web-ui-types.ts).
  | 'PERSONA_EXISTS'
  | 'BROAD_POLICY_REJECTED'
  // The merged policy failed the policy lint; nothing was written. The
  // message names the first findings.
  | 'POLICY_LINT_FAILED';

/**
 * Compile-time rule diff vs the persona's previous compiled policy (Phase 1c).
 * Mirrors backend RuleDeltaDto. Shown on the `done` card.
 */
export interface RuleDeltaDto {
  readonly added: number;
  readonly loosened: number;
  readonly removed: number;
  /** Broad wildcard domains in allow rules (needs the broad-policy opt-in). */
  readonly broadenedDomains: readonly string[];
  /** Allow rules' `paths.within` outside the persona workspace (needs the opt-in). */
  readonly outOfWorkspacePaths: readonly string[];
  /** Allow rules leaving a resource argument unconstrained, `<rule>: <role> on <server>/<tool>` (needs the opt-in). */
  readonly unconstrainedAllows: readonly string[];
  /** Informational: wildcard/path breadth on escalate rules, which a human approves per call. */
  readonly escalateBreadth: readonly string[];
}

/**
 * A server that failed to compile and has no rules in the written policy, so
 * its tools are denied. Mirrors backend FailedServerDto.
 */
export interface FailedServerDto {
  readonly serverName: string;
  /** The phase the server was in when it failed. */
  readonly phase: Exclude<CompilationPhase, 'cached' | 'done'>;
  /** Single-line, length-bounded failure reason. */
  readonly reason: string;
}

/**
 * Compile result carried by a `done` record/event: the policy was written.
 * It is partial when `failedServers` is present.
 */
export interface PersonaCompileResultDto {
  readonly success: true;
  readonly ruleCount: number;
  /** Compile-time diff vs the previous policy (absent on first compile). */
  readonly ruleDelta?: RuleDeltaDto;
  /** Servers left out of the written policy because they failed (absent when none failed). */
  readonly failedServers?: readonly FailedServerDto[];
}

/** Snapshot of a streamed compile operation (getCompile / listCompiles). */
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
  readonly error?: { readonly code: string; readonly message: string };
  readonly actor: string;
}

/** Response from `personas.listCompiles`. */
export interface PersonaListCompilesDto {
  readonly active: readonly PersonaCompileOperationDto[];
  readonly recent: readonly PersonaCompileOperationDto[];
  readonly queueDepth: number;
}

/** Response from `personas.compileStream`. */
export interface PersonaCompileStreamAckDto {
  readonly accepted: true;
  readonly name: string;
  readonly operationId: string;
  readonly queued?: boolean;
}

// ---------------------------------------------------------------------------
// Persona streamed-compile event payloads (Phase 1b). Mirror WebEventMap.
// ---------------------------------------------------------------------------

export interface PersonaCompileStartedEvent {
  readonly name: string;
  readonly operationId: string;
  readonly actor: string;
}

export interface PersonaCompileProgressEvent {
  readonly name: string;
  readonly operationId: string;
  readonly serverName: string;
  readonly phase: CompilationPhase;
  readonly detail?: string;
}

export interface PersonaCompileDoneEvent {
  readonly name: string;
  readonly operationId: string;
  readonly result: PersonaCompileResultDto;
}

export interface PersonaCompileFailedEvent {
  readonly name: string;
  readonly operationId: string;
  readonly code: string;
  readonly error: string;
}

/**
 * Persona CRUD change notification (Phase 1c). Mirrors WebEventMap's
 * `personas.changed` (empty payload). Handled by refreshing the persona list,
 * mirroring `job.list_changed -> refreshJobs`.
 */
export type PersonaChangedEvent = Record<string, never>;
