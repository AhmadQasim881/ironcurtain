import { exchangeCostUsd } from './cost-estimate.js';
import type { LlmExchangeCompleted, UsageCompleteness } from './types.js';
import { usageTokenBounds } from './usage-bounds.js';

export type TokenTrackingStatus = 'complete' | 'partial' | 'unavailable';

export interface ObservedUsageSnapshot {
  /** Input, output and total are lower bounds whenever `lowerBound` is true. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Null when at least one included exchange lacked a thinking-token breakdown. */
  readonly thinkingTokens: number | null;
  readonly totalTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  /**
   * Sum of the known exchange costs (gateway-reported, else a host
   * list-price estimate). Complete only when `costedExchanges` equals
   * `observedExchanges`; otherwise a lower bound.
   */
  readonly costUsd: number;
  /** Exchanges whose cost is known; the rest add nothing to `costUsd`. */
  readonly costedExchanges: number;
  readonly observedExchanges: number;
  readonly incompleteExchanges: number;
  /**
   * Exchanges that reported no token counter at all. Their usage is unknown,
   * not zero: they add nothing to the totals, which are then lower bounds.
   */
  readonly unmeasuredExchanges: number;
  /**
   * True when an included exchange was measured only in part: its known
   * components were added, so input, output and total are lower bounds.
   */
  readonly lowerBound: boolean;
  readonly status: TokenTrackingStatus;
}

interface MutableUsage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  missingThinkingTokenExchanges: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  costedExchanges: number;
  observedExchanges: number;
  incompleteExchanges: number;
  unmeasuredExchanges: number;
  inexactExchanges: number;
}

function emptyUsage(): MutableUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    missingThinkingTokenExchanges: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    costedExchanges: 0,
    observedExchanges: 0,
    incompleteExchanges: 0,
    unmeasuredExchanges: 0,
    inexactExchanges: 0,
  };
}

function isIncomplete(value: UsageCompleteness): boolean {
  return value !== 'complete';
}

function add(target: MutableUsage, exchange: LlmExchangeCompleted): void {
  const usage = exchange.usage;
  // A missing component must not zero the whole exchange: add what is known.
  const bounds = usageTokenBounds(usage);
  target.inputTokens += bounds.inputTokens;
  target.outputTokens += bounds.outputTokens;
  if (usage.thinkingTokens === null) target.missingThinkingTokenExchanges += 1;
  else target.thinkingTokens += usage.thinkingTokens;
  target.totalTokens += bounds.totalTokens;
  target.cacheReadTokens += usage.cacheReadInputTokens ?? 0;
  target.cacheWriteTokens += usage.cacheWriteInputTokens ?? 0;
  const cost = exchangeCostUsd(usage);
  if (cost !== null) {
    target.costUsd += cost;
    target.costedExchanges += 1;
  }
  target.observedExchanges += 1;
  if (isIncomplete(usage.usageCompleteness)) target.incompleteExchanges += 1;
  if (!bounds.measured) target.unmeasuredExchanges += 1;
  if (!bounds.inputExact || !bounds.outputExact || !bounds.totalExact) target.inexactExchanges += 1;
}

function snapshot(usage: MutableUsage, trackingPathActive: boolean): ObservedUsageSnapshot {
  const status: TokenTrackingStatus = !trackingPathActive
    ? 'unavailable'
    : usage.observedExchanges === 0 || usage.incompleteExchanges > 0
      ? 'partial'
      : 'complete';
  const { missingThinkingTokenExchanges, inexactExchanges, ...totals } = usage;
  return Object.freeze({
    ...totals,
    thinkingTokens: usage.observedExchanges > 0 && missingThinkingTokenExchanges === 0 ? usage.thinkingTokens : null,
    lowerBound: inexactExchanges > 0,
    status,
  });
}

/** Per-session exact-attribution accumulator. Ambiguous rows are excluded. */
export class ObservedUsageAccumulator {
  private readonly seen = new Set<string>();
  private readonly turns = new Map<string, MutableUsage>();
  private readonly cumulative = emptyUsage();

  constructor(
    private readonly sessionId: string,
    private readonly trackingPathActive: boolean,
  ) {}

  observe(exchange: LlmExchangeCompleted): void {
    if (
      exchange.attribution.quality !== 'exact' ||
      exchange.attribution.sessionId !== this.sessionId ||
      this.seen.has(exchange.exchangeId)
    ) {
      return;
    }
    this.seen.add(exchange.exchangeId);
    add(this.cumulative, exchange);
    if (exchange.attribution.turnId) {
      const turn = this.turns.get(exchange.attribution.turnId) ?? emptyUsage();
      add(turn, exchange);
      this.turns.set(exchange.attribution.turnId, turn);
    }
  }

  takeTurnSnapshot(turnId: string): ObservedUsageSnapshot {
    const turn = this.turns.get(turnId) ?? emptyUsage();
    this.turns.delete(turnId);
    return snapshot(turn, this.trackingPathActive);
  }

  cumulativeSnapshot(): ObservedUsageSnapshot {
    return snapshot(this.cumulative, this.trackingPathActive);
  }
}
