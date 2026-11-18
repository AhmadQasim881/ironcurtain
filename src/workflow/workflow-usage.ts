/**
 * Run-wide usage of a workflow run, and its spend ceiling
 * (`settings.workflowBudget`).
 *
 * A run spans many agent sessions: one per state visit, one per fan-out lane,
 * and new ones after every resume. `resourceBudget` limits bound each session
 * on its own (and, through its MITM budget gate, each shared container as a
 * whole); the meter here keeps the totals over all of them, persists them
 * in the checkpoint (`WorkflowCheckpoint.usage`) so they span resumes, and
 * `findWorkflowBudgetBreach` checks the ceiling against them.
 *
 * Where the numbers come from:
 *
 * - Tokens of Docker sessions: the completed LLM exchanges on the metrics bus
 *   (`getLlmMetricsEventBus()`), the content-free records the MITM publishes
 *   for every observed completion request. An exchange belongs to the run when
 *   its attribution names the run (`workflowRunId`, set for every exchange the
 *   MITM tied to an agent invocation) or one of the run's bundles (`bundleId`).
 *   The bundle rule is required: an exchange the MITM could not tie to an
 *   invocation lease carries only its bundle id. Shared-container bundles are
 *   minted by the orchestrator; a session that owns its bundle uses its
 *   session id as the bundle id (`bundleIdFromSessionId`). The bus carries
 *   exchanges only while LLM statistics are enabled and the provider route is
 *   observable; such a session reports token tracking as unavailable and is
 *   counted in `untrackedSessions`.
 * - Tokens of builtin sessions: the AI SDK usage the session's
 *   ResourceBudgetTracker recorded (`BudgetStatus.cumulative`), read while the
 *   session runs and settled when it ends. Builtin sessions never reach the MITM.
 * - Cost: the sum of every session's host-derived cost, the figure the
 *   between-turn admission check uses (`budgetDecisionCostUsd` in
 *   `src/session/budget-admission.ts`): `hostObservedCostUsd` for Docker
 *   sessions (cost the MITM or gateway reported for the traffic it saw), the
 *   price table estimate for builtin ones. A Docker agent CLI's own
 *   `total_cost_usd` is display-only and never counted: the agent controls
 *   that report, and the run-wide ceiling is a decision (audit finding MET-1).
 * - What each Docker bundle's MITM budget gate charged
 *   (`docker/budget-gate.ts`): the gate counts every completion the bundle
 *   forwarded, whatever metrics lease it carried and whether or not
 *   statistics are on, at its measured usage or a conservative estimate when
 *   usage could not be measured, priced at list prices (or fail-closed
 *   defaults for unlisted models). Bundle by bundle the run counts the larger
 *   of the two views: at least the gate's charged tokens, at least its
 *   charged cost. Spend the views above miss (statistics off, exchanges tied
 *   only to the bundle, an unpriced model, unmeasured usage) therefore still
 *   counts, at the gate's figures (`gateOnlyTokens`, `gateOnlyCostUsd`). The
 *   meter reads a shared bundle's gate from the moment the orchestrator mints
 *   the bundle (`trackBundleGate`), and the gate of a session's own bundle
 *   through its budget status (`BudgetStatus.budgetGate`), settled when the
 *   session ends and read once more after it is closed (`sessionClosed`):
 *   closing it stops the bundle's MITM, which settles the exchanges still in
 *   flight.
 * - Active time: time spent in agent and deterministic states, including
 *   fan-out batches. Time at a human gate or between an abort and a resume is
 *   not counted.
 *
 * A session that nothing counts, with neither token tracking nor a budget
 * gate, is recorded in `uncountedSessions`: both the token and the cost
 * ceiling fail closed while there is one.
 *
 * Accounting never throws: a session whose budget status cannot be read
 * contributes nothing rather than failing the state that reads it.
 */

import type { LlmExchangeCompleted } from '../llm-metrics/types.js';
import { usageTokenBounds } from '../llm-metrics/usage-bounds.js';
import { budgetDecisionCostUsd } from '../session/budget-admission.js';
import type { BudgetGateCharges, BudgetStatus, ConversationTurn, SessionMode } from '../session/types.js';
import type { WorkflowBudgetSettings, WorkflowCheckpoint } from './types.js';

export type WorkflowTokenTrackingStatus = 'complete' | 'partial' | 'unavailable';

/**
 * Run-wide usage over every agent session, fan-out lane and resume leg. Token
 * figures are exact when `tokenTrackingStatus` is `complete` and lower bounds
 * otherwise; a total that includes budget-gate charges (`gateOnlyTokens`)
 * includes the gate's conservative estimates.
 */
export interface WorkflowUsage {
  /** Input tokens, cache reads and cache writes included. */
  readonly inputTokens: number;
  /** Cache-read input tokens (part of `inputTokens`). */
  readonly cacheReadTokens: number;
  /** Cache-write input tokens (part of `inputTokens`). */
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  /** Input plus output, plus the tokens only the budget gates counted (`gateOnlyTokens`). */
  readonly totalTokens: number;
  /**
   * Sum of every agent session's host-derived cost, in USD: never a Docker
   * agent's self-reported cost (see `budgetDecisionCostUsd`). Plus the cost
   * only the budget gates counted (`gateOnlyCostUsd`).
   */
  readonly estimatedCostUsd: number;
  /**
   * The part of `totalTokens` only the bundles' MITM budget gates counted:
   * tokens a gate charged beyond the bundle's exchanges seen on the metrics
   * bus (statistics off, an exchange never published, usage the gate had to
   * estimate). Not part of `inputTokens` or `outputTokens`.
   */
  readonly gateOnlyTokens: number;
  /** The part of `estimatedCostUsd` only the budget gates counted, beyond the sessions' host-derived cost. */
  readonly gateOnlyCostUsd: number;
  /** Seconds spent running states; gates and stopped time excluded. */
  readonly activeSeconds: number;
  /** LLM exchanges of Docker sessions observed on the metrics bus. */
  readonly observedExchanges: number;
  /** Observed exchanges whose usage was not reported in full. */
  readonly incompleteExchanges: number;
  /** Observed exchanges that reported no token counter at all. */
  readonly unmeasuredExchanges: number;
  /** Docker sessions whose exchanges were observable on the metrics bus. */
  readonly meteredSessions: number;
  /** Builtin sessions, whose usage the AI SDK reports. */
  readonly reportedSessions: number;
  /** Sessions whose token usage could not be observed at all. */
  readonly untrackedSessions: number;
  /**
   * Untracked sessions that no budget gate counted either, so nothing counted
   * their tokens or cost: both ceilings fail closed while there is one.
   */
  readonly uncountedSessions: number;
  /**
   * Some token figure undercounts by an unknown amount: an exchange measured
   * only in part, or tokens carried over from a checkpoint that counted
   * output tokens only.
   */
  readonly lowerBound: boolean;
  readonly tokenTrackingStatus: WorkflowTokenTrackingStatus;
}

type UsageCounters = Omit<WorkflowUsage, 'activeSeconds' | 'tokenTrackingStatus'>;
type MutableCounters = { -readonly [K in keyof UsageCounters]: UsageCounters[K] };

const NUMERIC_COUNTERS = [
  'inputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'outputTokens',
  'totalTokens',
  'estimatedCostUsd',
  'gateOnlyTokens',
  'gateOnlyCostUsd',
  'observedExchanges',
  'incompleteExchanges',
  'unmeasuredExchanges',
  'meteredSessions',
  'reportedSessions',
  'untrackedSessions',
  'uncountedSessions',
] as const satisfies readonly (keyof UsageCounters)[];

function emptyCounters(): MutableCounters {
  return {
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    gateOnlyTokens: 0,
    gateOnlyCostUsd: 0,
    observedExchanges: 0,
    incompleteExchanges: 0,
    unmeasuredExchanges: 0,
    meteredSessions: 0,
    reportedSessions: 0,
    untrackedSessions: 0,
    uncountedSessions: 0,
    lowerBound: false,
  };
}

/** A non-negative finite count, or 0 for anything else (null, NaN, a stray string). */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * How complete the token figures are:
 * - `unavailable`: sessions ran but none could be observed, and nothing is known.
 * - `partial`: some session was not observable, some exchange was measured only
 *   in part, a budget gate charged tokens the metrics did not see, earlier legs
 *   counted output only, or nothing was observed yet.
 * - `complete`: every session was observable and every exchange fully measured.
 */
export function workflowTokenTrackingStatus(counters: UsageCounters): WorkflowTokenTrackingStatus {
  const tracked = counters.meteredSessions + counters.reportedSessions;
  if (
    tracked === 0 &&
    counters.untrackedSessions > 0 &&
    counters.observedExchanges === 0 &&
    counters.totalTokens === 0 &&
    !counters.lowerBound
  ) {
    return 'unavailable';
  }
  if (
    counters.untrackedSessions > 0 ||
    counters.incompleteExchanges > 0 ||
    counters.gateOnlyTokens > 0 ||
    counters.lowerBound
  ) {
    return 'partial';
  }
  // Exchanges are the only evidence for Docker sessions; builtin sessions report exactly.
  if (counters.reportedSessions === 0 && counters.observedExchanges === 0) return 'partial';
  return 'complete';
}

function finishUsage(counters: UsageCounters, activeSeconds: number): WorkflowUsage {
  return Object.freeze({
    ...counters,
    activeSeconds,
    tokenTrackingStatus: workflowTokenTrackingStatus(counters),
  });
}

/** Usage of a run that has not started any work. */
export function emptyWorkflowUsage(): WorkflowUsage {
  return finishUsage(emptyCounters(), 0);
}

/**
 * Reads a persisted usage record. Every counter is coerced to a non-negative
 * finite number and the tracking status is recomputed from the counters, so a
 * damaged record can neither crash a reader nor claim complete tracking it
 * does not support. Returns undefined when `raw` is not an object.
 *
 * A record without a valid `uncountedSessions` (written before budget-gate
 * charges were counted, or damaged) counts every untracked session as
 * uncounted: nothing counted their spend then, so the ceilings stay closed.
 */
export function parseWorkflowUsage(raw: unknown): WorkflowUsage | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const counters = emptyCounters();
  for (const key of NUMERIC_COUNTERS) counters[key] = count(record[key]);
  const uncounted = record.uncountedSessions;
  if (typeof uncounted !== 'number' || !Number.isFinite(uncounted) || uncounted < 0) {
    counters.uncountedSessions = counters.untrackedSessions;
  }
  counters.lowerBound = record.lowerBound === true;
  return finishUsage(counters, count(record.activeSeconds));
}

/**
 * The usage a resumed run continues from: the checkpoint's usage record, or
 * for a checkpoint written before that record existed, `context.totalTokens`.
 * Those checkpoints counted output tokens only (and nothing for OpenAI-format
 * streams), so once any state had run the carried-over total is a lower bound.
 */
export function workflowUsageFromCheckpoint(
  checkpoint: Pick<WorkflowCheckpoint, 'usage' | 'context' | 'transitionHistory' | 'usageSettlementPending'>,
): WorkflowUsage {
  const recorded = parseWorkflowUsage(checkpoint.usage);
  if (recorded) {
    if (checkpoint.usageSettlementPending === true)
      return {
        ...recorded,
        uncountedSessions: recorded.uncountedSessions + 1,
        lowerBound: true,
        tokenTrackingStatus: 'partial',
      };
    return recorded;
  }
  const legacyOutputTokens = count(checkpoint.context.totalTokens);
  const counters = emptyCounters();
  counters.outputTokens = legacyOutputTokens;
  counters.totalTokens = legacyOutputTokens;
  counters.lowerBound = legacyOutputTokens > 0 || checkpoint.transitionHistory.length > 0;
  if (checkpoint.usageSettlementPending === true) {
    counters.uncountedSessions += 1;
    counters.lowerBound = true;
  }
  return finishUsage(counters, 0);
}

/** The part of an agent session the meter reads. `Session` satisfies it. */
export interface MeteredSession {
  getInfo(): { readonly id: string };
  getBudgetStatus(): BudgetStatus;
  getHistory(): readonly ConversationTurn[];
}

/** How a session's token usage reaches the meter. */
type SessionTokenSource = 'metered' | 'reported' | 'untracked';

/** A budget gate's charged totals. */
interface GateTotals {
  readonly totalTokens: number;
  readonly costUsd: number;
}

const NO_GATE_CHARGES: GateTotals = Object.freeze({ totalTokens: 0, costUsd: 0 });

/** The larger of two readings of one gate, field by field (a gate's charges only grow). */
function maxCharges(a: GateTotals, b: GateTotals | undefined): GateTotals {
  if (b === undefined) return a;
  return { totalTokens: Math.max(a.totalTokens, b.totalTokens), costUsd: Math.max(a.costUsd, b.costUsd) };
}

/** The part of a bundle's MITM budget gate the meter reads (`BundleBudgetGate` satisfies it). */
export interface BundleGateReader {
  snapshot(): { readonly totalTokens: number; readonly costUsd: number };
}

/** A gate's charged totals, or undefined when it cannot be read. */
function readGate(gate: BundleGateReader | undefined): GateTotals | undefined {
  if (gate === undefined) return undefined;
  try {
    const snapshot = gate.snapshot();
    return { totalTokens: count(snapshot.totalTokens), costUsd: count(snapshot.costUsd) };
  } catch {
    return undefined;
  }
}

/** The bundle-gate charges a budget status reports, or undefined for none (or a malformed one). */
function gateChargesOf(status: BudgetStatus): BudgetGateCharges | undefined {
  try {
    const gate: unknown = status.budgetGate;
    if (typeof gate !== 'object' || gate === null) return undefined;
    const { bundleId, totalTokens, costUsd } = gate as Record<string, unknown>;
    if (typeof bundleId !== 'string' || bundleId.length === 0) return undefined;
    return { bundleId, totalTokens: count(totalTokens), costUsd: count(costUsd) };
  } catch {
    return undefined;
  }
}

/** A session's budget status, or undefined when it cannot be read. */
function readBudgetStatus(session: MeteredSession): BudgetStatus | undefined {
  try {
    return session.getBudgetStatus();
  } catch {
    return undefined;
  }
}

interface SessionContribution {
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly estimatedCostUsd: number;
  /** The charges the session's bundle gate reported, if it has one. */
  readonly gate?: BudgetGateCharges;
}

const NO_CONTRIBUTION: SessionContribution = Object.freeze({
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  estimatedCostUsd: 0,
});

/**
 * A session's cost as budget decisions see it (`budgetDecisionCostUsd`): the
 * host-observed cost of a Docker session, never its agent's own report; the
 * host's estimate for a builtin session. 0 when the status carries no
 * readable cost.
 */
function sessionDecisionCostUsd(status: BudgetStatus): number {
  try {
    return count(budgetDecisionCostUsd(status));
  } catch {
    return 0;
  }
}

/**
 * A session's own contribution: its host-derived cost and its bundle gate's
 * charges always, its tokens only when the meter cannot see them on the bus
 * (builtin sessions). A metered session's tokens arrive exchange by exchange,
 * so adding its totals again would count them twice.
 */
function readSessionContribution(session: MeteredSession, source: SessionTokenSource): SessionContribution {
  const status = readBudgetStatus(session);
  if (status === undefined) return NO_CONTRIBUTION;
  const cumulative = status.cumulative as Partial<BudgetStatus['cumulative']> | undefined;
  const estimatedCostUsd = sessionDecisionCostUsd(status);
  const gate = gateChargesOf(status);
  const gateField = gate !== undefined ? { gate } : {};
  if (source !== 'reported') return { ...NO_CONTRIBUTION, estimatedCostUsd, ...gateField };

  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  try {
    for (const turn of session.getHistory()) {
      cacheReadTokens += count(turn.usage.cacheReadTokens);
      cacheWriteTokens += count(turn.usage.cacheWriteTokens);
    }
  } catch {
    // The cache split is informational; the totals below stand without it.
  }
  const inputTokens = count(cumulative?.totalInputTokens);
  const outputTokens = count(cumulative?.totalOutputTokens);
  return {
    inputTokens,
    // A cache part never exceeds the input it is part of.
    cacheReadTokens: Math.min(cacheReadTokens, inputTokens),
    cacheWriteTokens: Math.min(cacheWriteTokens, inputTokens),
    outputTokens,
    totalTokens: Math.max(count(cumulative?.totalTokens), inputTokens + outputTokens),
    estimatedCostUsd,
    ...gateField,
  };
}

/** Fails closed: a session whose status cannot be read counts as untracked. */
function classifySession(status: BudgetStatus | undefined, mode: SessionMode['kind']): SessionTokenSource {
  if (status?.tokenTrackingAvailable !== true) return 'untracked';
  return mode === 'builtin' ? 'reported' : 'metered';
}

/** A session the meter counts live until it ends. */
interface ActiveSession {
  readonly source: SessionTokenSource;
  /** The bundle the session's cost is part of: the one it borrows, its own (its session id), or none (builtin). */
  readonly bundleId: string | undefined;
}

/**
 * One bundle of the run, as the two views see it: what the metrics observed
 * of it and what its budget gate charged. The run counts the larger of each
 * (see {@link WorkflowUsageMeter.snapshot}).
 */
interface BundleLedger {
  /** Tokens of the bundle's exchanges counted from the metrics bus. */
  observedTokens: number;
  /** Host-derived cost of the bundle's ended sessions. */
  sessionCostUsd: number;
  /** The highest gate charges the bundle's ended sessions reported. */
  settledGate: GateTotals;
  /** The bundle's gate, read live: registered by the orchestrator for a bundle it minted. */
  gate?: BundleGateReader;
}

/** What the active sessions of one bundle contribute to a snapshot. */
interface LiveBundleShare {
  costUsd: number;
  gate: GateTotals;
}

/** Exchange ids remembered for de-duplication; publication is exactly-once, this is insurance. */
const RECENT_EXCHANGE_ID_LIMIT = 4096;

/**
 * Accumulates one run's usage. One instance per running workflow; the
 * orchestrator feeds it metrics-bus exchanges, bundle mints, session starts
 * and ends, and running/idle transitions, and reads `snapshot()` for display,
 * checkpoints and the ceiling check. Active sessions and the gates of live
 * bundles are included live, so a snapshot taken mid-state already reflects
 * the work in progress.
 */
export class WorkflowUsageMeter {
  private readonly counters: MutableCounters;
  private activeMs: number;
  private runningSinceMs: number | undefined;
  /** The run's bundles: an exchange tied only to one of them belongs to the run. */
  private readonly bundles = new Map<string, BundleLedger>();
  private readonly recentExchangeIds = new Set<string>();
  private readonly activeSessions = new Map<MeteredSession, ActiveSession>();

  constructor(
    private readonly workflowRunId: string,
    initial: WorkflowUsage = emptyWorkflowUsage(),
  ) {
    this.counters = emptyCounters();
    for (const key of NUMERIC_COUNTERS) this.counters[key] = count(initial[key]);
    this.counters.lowerBound = initial.lowerBound;
    this.activeMs = count(initial.activeSeconds) * 1000;
  }

  /** Counts exchanges the MITM attributed only to this bundle. */
  addBundle(bundleId: string): void {
    this.ledger(bundleId);
  }

  /**
   * Counts what `bundleId`'s budget gate charges (a bundle the orchestrator
   * minted and shares between states): from now on, and after the bundle is
   * gone, the bundle counts at least the gate's charged tokens and cost.
   */
  trackBundleGate(bundleId: string, gate: BundleGateReader): void {
    this.ledger(bundleId).gate = gate;
  }

  /** Metrics-bus subscriber: adds an exchange that belongs to this run. */
  observeExchange(exchange: LlmExchangeCompleted): void {
    const { attribution } = exchange;
    const belongs =
      attribution.workflowRunId === this.workflowRunId ||
      (attribution.bundleId !== null && this.bundles.has(attribution.bundleId));
    if (!belongs || !this.rememberExchange(exchange.exchangeId)) return;

    const { usage } = exchange;
    // A missing component must not zero the exchange: add what is known.
    const bounds = usageTokenBounds(usage);
    const counters = this.counters;
    counters.inputTokens += bounds.inputTokens;
    counters.outputTokens += bounds.outputTokens;
    counters.totalTokens += bounds.totalTokens;
    counters.cacheReadTokens += count(usage.cacheReadInputTokens);
    counters.cacheWriteTokens += count(usage.cacheWriteInputTokens);
    counters.observedExchanges += 1;
    if (usage.usageCompleteness !== 'complete') counters.incompleteExchanges += 1;
    if (!bounds.measured) counters.unmeasuredExchanges += 1;
    if (!bounds.inputExact || !bounds.outputExact || !bounds.totalExact) counters.lowerBound = true;
    // Set against the charges of the bundle's gate, which counted it too.
    if (attribution.bundleId !== null) this.ledger(attribution.bundleId).observedTokens += bounds.totalTokens;
  }

  /**
   * Registers an agent session when it starts. A Docker session's tokens are
   * counted from the metrics bus when its route is observable; a builtin
   * session's from its own budget status. Either way its host-derived cost
   * comes from the session, and its bundle's budget gate charges (reported
   * in its budget status, or registered for the bundle it borrows) count as
   * well. `bundleId` names the shared bundle the session borrows; a Docker
   * session without one owns its bundle, whose id is the session id, so
   * exchanges attributed only to that bundle count. A session with neither
   * token tracking nor a budget gate is uncounted.
   */
  sessionStarted(session: MeteredSession, mode: SessionMode['kind'], bundleId?: string): void {
    if (this.activeSessions.has(session)) return;
    const status = readBudgetStatus(session);
    const source = classifySession(status, mode);
    const gate = status === undefined ? undefined : gateChargesOf(status);
    const sessionBundleId = bundleId ?? (mode === 'docker' ? session.getInfo().id : undefined);
    this.activeSessions.set(session, { source, bundleId: sessionBundleId });
    if (source === 'metered') this.counters.meteredSessions += 1;
    else if (source === 'reported') this.counters.reportedSessions += 1;
    else this.counters.untrackedSessions += 1;
    const gated =
      gate !== undefined || (sessionBundleId !== undefined && this.bundles.get(sessionBundleId)?.gate !== undefined);
    if (source === 'untracked' && !gated) this.counters.uncountedSessions += 1;
    if (sessionBundleId !== undefined) this.ledger(sessionBundleId);
    if (gate !== undefined) this.ledger(gate.bundleId);
  }

  /**
   * Settles a session's contribution once its last turn has ended, including
   * its share of its bundle and the gate charges it last reported (for a
   * session that owns its bundle, the bundle's final charges).
   */
  sessionEnded(session: MeteredSession): void {
    const entry = this.activeSessions.get(session);
    if (entry === undefined) return;
    this.activeSessions.delete(session);
    const contribution = readSessionContribution(session, entry.source);
    this.addContribution(this.counters, contribution);
    if (entry.bundleId !== undefined) this.ledger(entry.bundleId).sessionCostUsd += contribution.estimatedCostUsd;
    if (contribution.gate !== undefined) {
      const ledger = this.ledger(contribution.gate.bundleId);
      ledger.settledGate = maxCharges(ledger.settledGate, contribution.gate);
    }
  }

  /**
   * Takes a last reading of the bundle-gate charges a session reports, once
   * the session is closed. Closing a session that owns its bundle stops the
   * bundle's MITM, which settles the exchanges still in flight when its last
   * turn ended (a request a process the agent left running had open), so
   * their charges reach the gate only after {@link sessionEnded} read it. A
   * gate's charges only grow, so the reading can only raise the bundle's
   * count. Only a bundle the meter already knows is counted.
   */
  sessionClosed(session: MeteredSession): void {
    const status = readBudgetStatus(session);
    const gate = status === undefined ? undefined : gateChargesOf(status);
    if (gate === undefined) return;
    const ledger = this.bundles.get(gate.bundleId);
    if (ledger !== undefined) ledger.settledGate = maxCharges(ledger.settledGate, gate);
  }

  /** Marks whether the run is working (in an agent or deterministic state). */
  setRunning(running: boolean, nowMs: number = Date.now()): void {
    if (running) {
      this.runningSinceMs ??= nowMs;
      return;
    }
    if (this.runningSinceMs !== undefined) {
      this.activeMs += Math.max(0, nowMs - this.runningSinceMs);
      this.runningSinceMs = undefined;
    }
  }

  /**
   * Current usage, active sessions, the gates of the run's bundles and the
   * running state included.
   */
  snapshot(nowMs: number = Date.now()): WorkflowUsage {
    const counters: MutableCounters = { ...this.counters };
    const live = new Map<string, LiveBundleShare>();
    const shareOf = (bundleId: string): LiveBundleShare => {
      let share = live.get(bundleId);
      if (share === undefined) {
        share = { costUsd: 0, gate: NO_GATE_CHARGES };
        live.set(bundleId, share);
      }
      return share;
    };
    for (const [session, entry] of this.activeSessions) {
      const contribution = readSessionContribution(session, entry.source);
      this.addContribution(counters, contribution);
      if (entry.bundleId !== undefined) shareOf(entry.bundleId).costUsd += contribution.estimatedCostUsd;
      if (contribution.gate !== undefined) {
        const share = shareOf(contribution.gate.bundleId);
        share.gate = maxCharges(share.gate, contribution.gate);
      }
    }
    this.addGateOnlyUsage(counters, live);
    const runningMs = this.runningSinceMs === undefined ? 0 : Math.max(0, nowMs - this.runningSinceMs);
    return finishUsage(counters, (this.activeMs + runningMs) / 1000);
  }

  private addContribution(counters: MutableCounters, contribution: SessionContribution): void {
    counters.inputTokens += contribution.inputTokens;
    counters.cacheReadTokens += contribution.cacheReadTokens;
    counters.cacheWriteTokens += contribution.cacheWriteTokens;
    counters.outputTokens += contribution.outputTokens;
    counters.totalTokens += contribution.totalTokens;
    counters.estimatedCostUsd += contribution.estimatedCostUsd;
  }

  /**
   * Raises the totals to what the budget gates of the run's bundles charged,
   * bundle by bundle: a bundle counts the larger of its exchanges' tokens on
   * the bus and its gate's charged tokens, and the larger of its sessions'
   * host-derived cost and its gate's charged cost. Whatever the gate charged
   * beyond the other view is added as gate-only usage. A gate is read live
   * while the meter holds it; otherwise its charges are the highest any of
   * the bundle's sessions reported.
   */
  private addGateOnlyUsage(counters: MutableCounters, live: ReadonlyMap<string, LiveBundleShare>): void {
    for (const bundleId of new Set([...this.bundles.keys(), ...live.keys()])) {
      const ledger = this.bundles.get(bundleId);
      const share = live.get(bundleId);
      const gate = maxCharges(maxCharges(ledger?.settledGate ?? NO_GATE_CHARGES, readGate(ledger?.gate)), share?.gate);
      const tokens = Math.max(0, gate.totalTokens - (ledger?.observedTokens ?? 0));
      const costUsd = Math.max(0, gate.costUsd - (ledger?.sessionCostUsd ?? 0) - (share?.costUsd ?? 0));
      counters.totalTokens += tokens;
      counters.gateOnlyTokens += tokens;
      counters.estimatedCostUsd += costUsd;
      counters.gateOnlyCostUsd += costUsd;
    }
  }

  /** The ledger of `bundleId`, created on first use. */
  private ledger(bundleId: string): BundleLedger {
    let ledger = this.bundles.get(bundleId);
    if (ledger === undefined) {
      ledger = { observedTokens: 0, sessionCostUsd: 0, settledGate: NO_GATE_CHARGES };
      this.bundles.set(bundleId, ledger);
    }
    return ledger;
  }

  /** False when the exchange was already counted. */
  private rememberExchange(exchangeId: string): boolean {
    if (this.recentExchangeIds.has(exchangeId)) return false;
    this.recentExchangeIds.add(exchangeId);
    if (this.recentExchangeIds.size > RECENT_EXCHANGE_ID_LIMIT) {
      // Sets iterate in insertion order: drop the oldest id.
      const oldest = this.recentExchangeIds.values().next();
      if (!oldest.done) this.recentExchangeIds.delete(oldest.value);
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// Spend ceiling
// ---------------------------------------------------------------------------

export type WorkflowBudgetDimension = 'tokens' | 'cost' | 'wallClock';

export interface WorkflowBudgetBreach {
  readonly dimension: WorkflowBudgetDimension;
  /** The `settings.workflowBudget` field that was reached. */
  readonly limitField: keyof WorkflowBudgetSettings;
  readonly used: number;
  readonly limit: number;
  /** One line for the message log, the tab and the terminal status. */
  readonly message: string;
}

function isLimit(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function formatInteger(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

/** Whole seconds, or two decimals below ten seconds so short limits stay readable. */
function formatSeconds(value: number): string {
  return value >= 10 ? formatInteger(value) : String(Math.round(value * 100) / 100);
}

/** Why a ceiling cannot be held while some session's usage was counted by nothing. */
function uncountedSessionsNote(usage: WorkflowUsage): string {
  return (
    `${usage.uncountedSessions} agent session(s) of this run had neither token tracking ` +
    `nor a budget gate counting their usage`
  );
}

/**
 * The first `settings.workflowBudget` dimension the run has reached, or
 * undefined while it is within every limit. Tokens and cost fail closed: a
 * ceiling cannot be held against sessions whose usage nothing counted (no
 * token tracking and no budget gate, `uncountedSessions`), so such a session
 * counts as a breach rather than letting the undercounted total pass. A
 * session whose tokens the metrics could not observe but whose bundle's gate
 * charged them is held to the gate's figures instead.
 */
export function findWorkflowBudgetBreach(
  limits: WorkflowBudgetSettings | undefined,
  usage: WorkflowUsage,
): WorkflowBudgetBreach | undefined {
  if (limits === undefined) return undefined;
  const { maxTotalTokens, maxEstimatedCostUsd, maxWallClockSeconds } = limits;

  if (isLimit(maxTotalTokens)) {
    if (usage.uncountedSessions > 0) {
      return {
        dimension: 'tokens',
        limitField: 'maxTotalTokens',
        used: usage.totalTokens,
        limit: maxTotalTokens,
        message:
          `the ${formatInteger(maxTotalTokens)}-token ceiling cannot be enforced: ${uncountedSessionsNote(usage)}; ` +
          `remove the token ceiling or use a running-time ceiling for this run`,
      };
    }
    if (usage.totalTokens >= maxTotalTokens) {
      const atLeast = usage.tokenTrackingStatus === 'complete' ? '' : 'at least ';
      return {
        dimension: 'tokens',
        limitField: 'maxTotalTokens',
        used: usage.totalTokens,
        limit: maxTotalTokens,
        message: `${atLeast}${formatInteger(usage.totalTokens)} of ${formatInteger(maxTotalTokens)} tokens used`,
      };
    }
  }

  if (isLimit(maxEstimatedCostUsd)) {
    if (usage.uncountedSessions > 0) {
      return {
        dimension: 'cost',
        limitField: 'maxEstimatedCostUsd',
        used: usage.estimatedCostUsd,
        limit: maxEstimatedCostUsd,
        message:
          `the $${maxEstimatedCostUsd.toFixed(2)} cost ceiling cannot be enforced: ${uncountedSessionsNote(usage)}; ` +
          `remove the cost ceiling or use a running-time ceiling for this run`,
      };
    }
    if (usage.estimatedCostUsd >= maxEstimatedCostUsd) {
      return {
        dimension: 'cost',
        limitField: 'maxEstimatedCostUsd',
        used: usage.estimatedCostUsd,
        limit: maxEstimatedCostUsd,
        message: `estimated cost $${usage.estimatedCostUsd.toFixed(2)} of $${maxEstimatedCostUsd.toFixed(2)}`,
      };
    }
  }

  if (isLimit(maxWallClockSeconds) && usage.activeSeconds >= maxWallClockSeconds) {
    return {
      dimension: 'wallClock',
      limitField: 'maxWallClockSeconds',
      used: usage.activeSeconds,
      limit: maxWallClockSeconds,
      message: `${formatSeconds(usage.activeSeconds)}s of ${formatSeconds(maxWallClockSeconds)}s running time used`,
    };
  }

  return undefined;
}
