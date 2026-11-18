/**
 * Token lower bounds for one exchange.
 *
 * Exact totals stay null when any component is unknown (for example a cache
 * counter a gateway omitted, or output that never arrived because the stream
 * ended early). Accounting must not then count the exchange as zero: its
 * known components still bound the totals from below. Every value here is
 * either the exact normalized total or a sum of components that the
 * normalized usage contract proves are disjoint parts of it.
 */

/** The token counters of one exchange: live `NormalizedUsage` or a persisted row mapped onto it. */
export interface UsageCounters {
  readonly inputTokensReported: number | null;
  readonly inputTokensTotal: number | null;
  readonly inputTokensUncached: number | null;
  readonly cacheReadInputTokens: number | null;
  readonly cacheWriteInputTokens: number | null;
  readonly toolUseInputTokens: number | null;
  readonly outputTokensReported: number | null;
  readonly outputTokensTotal: number | null;
  readonly thinkingTokens: number | null;
  readonly nonThinkingOutputTokens: number | null;
  readonly providerTotalTokens: number | null;
  readonly canonicalTotalTokens: number | null;
}

export interface UsageTokenBounds {
  /** Exact input total, or the largest provable lower bound. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly inputExact: boolean;
  readonly outputExact: boolean;
  readonly totalExact: boolean;
  /** False when the exchange reported no token counter at all: its usage is unknown, not zero. */
  readonly measured: boolean;
}

/** A counter is a finite count; anything else (null, or absent in a sparse row) is unknown. */
function isCount(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function known(value: number | null): number {
  return isCount(value) ? value : 0;
}

/**
 * Input: uncached input plus the cache parts partition the input total for
 * every built-in protocol, and the reported input count plus tool-use input
 * are disjoint parts of it (for Anthropic the reported count is uncached
 * input; for OpenAI it is the total itself).
 */
function inputLowerBound(usage: UsageCounters): number {
  if (isCount(usage.inputTokensTotal)) return usage.inputTokensTotal;
  const partitioned =
    known(usage.inputTokensUncached) + known(usage.cacheReadInputTokens) + known(usage.cacheWriteInputTokens);
  const reported = known(usage.inputTokensReported) + known(usage.toolUseInputTokens);
  return Math.max(partitioned, reported);
}

/** Output: the reported count, thinking and non-thinking output are each part of the inclusive output. */
function outputLowerBound(usage: UsageCounters): number {
  if (isCount(usage.outputTokensTotal)) return usage.outputTokensTotal;
  return Math.max(known(usage.outputTokensReported), known(usage.thinkingTokens), known(usage.nonThinkingOutputTokens));
}

export function usageTokenBounds(usage: UsageCounters): UsageTokenBounds {
  const inputTokens = inputLowerBound(usage);
  const outputTokens = outputLowerBound(usage);
  const totalTokens = isCount(usage.canonicalTotalTokens)
    ? usage.canonicalTotalTokens
    : Math.max(inputTokens + outputTokens, known(usage.providerTotalTokens));
  const measured = [
    usage.inputTokensReported,
    usage.inputTokensTotal,
    usage.inputTokensUncached,
    usage.cacheReadInputTokens,
    usage.cacheWriteInputTokens,
    usage.toolUseInputTokens,
    usage.outputTokensReported,
    usage.outputTokensTotal,
    usage.thinkingTokens,
    usage.nonThinkingOutputTokens,
    usage.providerTotalTokens,
    usage.canonicalTotalTokens,
  ].some(isCount);
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    inputExact: isCount(usage.inputTokensTotal),
    outputExact: isCount(usage.outputTokensTotal),
    totalExact: isCount(usage.canonicalTotalTokens),
    measured,
  };
}
