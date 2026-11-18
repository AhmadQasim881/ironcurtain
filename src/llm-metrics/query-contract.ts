/** Canonical statistics query vocabulary shared by transport, query, and persistence boundaries. */

/**
 * Version of the statistics DTO shapes. 3: summaries and dimension values
 * carry display `labels` for locally pseudonymized identities, capabilities
 * advertise the enforced limits, over-limit queries fail with
 * `STATISTICS_LIMIT`, and `observableOutputTokensPerSecond` is withdrawn.
 */
export const STATISTICS_DTO_VERSION = 3;

/**
 * Version of the aggregation formulas. 2: additive token sums (input, output,
 * total) include the known parts of partly measured exchanges as lower bounds
 * (see `MetricSummary.lowerBoundCount`) instead of omitting those exchanges.
 * 3: `costUsd` is the exchange's cost: the gateway-reported cost, else the
 * host's list-price estimate for a verified official provider origin
 * (`cost_source` says which); before, only gateway-reported cost counted.
 * 4: aggregation runs in SQLite; the median and quartiles of a summary come
 * from a deterministic sample of at most `STATISTICS_QUANTILE_SAMPLE_SIZE`
 * exactly measured values (exact whenever `sampleCount` is within that size).
 */
export const STATISTICS_FORMULA_VERSION = 4;

export const STATISTICS_DIMENSIONS = [
  'agent',
  'logicalProvider',
  'gateway',
  'protocol',
  'providerProfile',
  'requestedModel',
  'forwardedModel',
  'responseModel',
  'servedModel',
  'servedProvider',
  'reasoningMode',
  'requestedServiceTier',
  'actualServiceTier',
  'inputMeasurementProvenance',
  'outputMeasurementProvenance',
  'thinkingMeasurementProvenance',
  'nonThinkingMeasurementProvenance',
  'speedMode',
  'streaming',
  'outcome',
  'refusal',
  'usageCompleteness',
  'attributionQuality',
  'sessionId',
  'workflowRunId',
  'stateId',
  'personaId',
  'bundleId',
] as const;

export type StatisticsDimension = (typeof STATISTICS_DIMENSIONS)[number];

export const STATISTICS_MEASURES = [
  'requestCount',
  'refusalCount',
  'refusalRate',
  'errorCount',
  'errorRate',
  'inputTokens',
  'uncachedInputTokens',
  'cacheReadInputTokens',
  'cacheWriteInputTokens',
  'toolUseInputTokens',
  'thinkingTokens',
  'nonThinkingOutputTokens',
  'outputTokens',
  'totalTokens',
  'costUsd',
  'ttftMs',
  'upstreamLatencyMs',
  'clientLatencyMs',
  // An observable stream-span rate (generated tokens over the first-to-last
  // output event span) is deliberately not offered: no protocol adapter can
  // yet prove that the reported count and the observed event span describe
  // the same token population (`output_timing_population_exact`), so it
  // would always be null. Add it back once an adapter emits that proof.
  'effectiveOutputTokensPerSecond',
] as const;

export type StatisticsMeasure = (typeof STATISTICS_MEASURES)[number];

export const STATISTICS_DISTRIBUTION_MEASURES = [
  'inputTokens',
  'uncachedInputTokens',
  'cacheReadInputTokens',
  'cacheWriteInputTokens',
  'toolUseInputTokens',
  'thinkingTokens',
  'nonThinkingOutputTokens',
  'outputTokens',
  'totalTokens',
  'costUsd',
  'ttftMs',
  'upstreamLatencyMs',
  'clientLatencyMs',
  'effectiveOutputTokensPerSecond',
] as const satisfies readonly StatisticsMeasure[];

export type StatisticsDistributionMeasure = (typeof STATISTICS_DISTRIBUTION_MEASURES)[number];

export const STATISTICS_BUCKET_SIZES_MS = [60_000, 300_000, 900_000, 3_600_000, 86_400_000] as const;
export const STATISTICS_CALENDAR_BUCKET_UNITS = ['day'] as const;

/** Longest queryable time range (inclusive bounds). */
export const MAX_STATISTICS_RANGE_DAYS = 366;
export const MAX_STATISTICS_RANGE_MS = MAX_STATISTICS_RANGE_DAYS * 24 * 60 * 60 * 1_000;
/**
 * Most observations one aggregation query may summarize. The reader counts
 * the matching rows through an index before it aggregates, so the bound holds
 * before any per-row work starts.
 */
export const MAX_STATISTICS_AGGREGATION_ROWS = 1_000_000;
/** Most distinct groups in one summary, or in one time-series bucket. */
export const MAX_STATISTICS_GROUPS = 500;
/** Most summaries (groups x measures, over all buckets) in one response. */
export const MAX_STATISTICS_OUTPUT_ITEMS = 10_000;
/** Most buckets in one time series. */
export const MAX_STATISTICS_TIME_SERIES_BUCKETS = 1_000;
/** Most exactly measured values the median and quartiles of one summary are computed from. */
export const STATISTICS_QUANTILE_SAMPLE_SIZE = 2_048;
export const MAX_STATISTICS_PAGE_SIZE = 500;
export const MAX_STATISTICS_DIMENSION_VALUES = 500;
export const MAX_STATISTICS_MEASURES = 20;
export const MAX_STATISTICS_GROUP_BY = 3;

/** Names of the limits a `StatisticsLimitError` can report. */
export type StatisticsLimitName =
  'rangeDays' | 'scannedRows' | 'groups' | 'outputItems' | 'outputBytes' | 'timeSeriesBuckets';

export const STATISTICS_LIMIT_ERROR_CODE = 'STATISTICS_LIMIT';

/**
 * A well-formed query that asks for more than one statistics request may
 * compute. Callers branch on `code`, not `instanceof`, so the transport does
 * not depend on which layer (query service or reader worker) raised it.
 */
export class StatisticsLimitError extends Error {
  readonly code = STATISTICS_LIMIT_ERROR_CODE;
  readonly limit: StatisticsLimitName;
  readonly maximum: number;

  constructor(limit: StatisticsLimitName, maximum: number, message: string) {
    super(message);
    this.name = 'StatisticsLimitError';
    this.limit = limit;
    this.maximum = maximum;
  }
}

export function isStatisticsLimitError(error: unknown): error is StatisticsLimitError {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === STATISTICS_LIMIT_ERROR_CODE &&
    'limit' in error &&
    typeof error.limit === 'string' &&
    'maximum' in error &&
    typeof error.maximum === 'number'
  );
}

/**
 * Quality flags one exchange record may carry. Persistence rejects a record
 * with more, and one rejected record fails its whole write batch, so the
 * exchange observer truncates to this bound and marks the record
 * (`quality_flags_truncated`).
 */
export const MAX_EXCHANGE_QUALITY_FLAGS = 64;

export const MAX_STATISTICS_FILTER_VALUES = 20;
export const MAX_STATISTICS_DISTRIBUTION_BINS = 40;
export const MAX_STATISTICS_TOP_GROUPS = 20;
export const STATISTICS_IDENTIFIER_MAX_LENGTH = 256;
export const STATISTICS_PROVIDER_IDENTIFIER_MAX_LENGTH = 128;
export const STATISTICS_TIME_ZONE_MAX_LENGTH = 128;

export const STATISTICS_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
export const STATISTICS_PROVIDER_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._:/@()+&-]*$/;
export const STATISTICS_TIME_ZONE_PATTERN = /^[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)*$/;

export function isValidStatisticsTimeZone(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > STATISTICS_TIME_ZONE_MAX_LENGTH ||
    !STATISTICS_TIME_ZONE_PATTERN.test(value)
  ) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}
