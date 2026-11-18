import { createHash } from 'node:crypto';

import type {
  LlmExchangeFilters,
  LlmMetricsReadRepository,
  LlmMetricsRepositoryHealth,
  LlmStatisticsAggregationLimits,
  LlmStatisticsBucketSpec,
  LlmStatisticsDimension,
  LlmStatisticsDimensionValue,
  LlmStatisticsMeasureAggregate,
  LlmStatisticsPartition,
  StoredLlmExchange,
} from './persistence/repository.js';
import {
  isValidStatisticsTimeZone,
  MAX_STATISTICS_AGGREGATION_ROWS,
  MAX_STATISTICS_DIMENSION_VALUES,
  MAX_STATISTICS_DISTRIBUTION_BINS,
  MAX_STATISTICS_GROUP_BY,
  MAX_STATISTICS_GROUPS,
  MAX_STATISTICS_MEASURES,
  MAX_STATISTICS_OUTPUT_ITEMS,
  MAX_STATISTICS_PAGE_SIZE,
  MAX_STATISTICS_RANGE_DAYS,
  MAX_STATISTICS_RANGE_MS,
  MAX_STATISTICS_TIME_SERIES_BUCKETS,
  MAX_STATISTICS_TOP_GROUPS,
  STATISTICS_BUCKET_SIZES_MS,
  STATISTICS_CALENDAR_BUCKET_UNITS,
  STATISTICS_DIMENSIONS,
  STATISTICS_DISTRIBUTION_MEASURES,
  STATISTICS_DTO_VERSION,
  STATISTICS_FORMULA_VERSION,
  STATISTICS_IDENTIFIER_PATTERN,
  STATISTICS_MEASURES,
  STATISTICS_QUANTILE_SAMPLE_SIZE,
  StatisticsLimitError,
  type StatisticsDistributionMeasure,
  type StatisticsMeasure,
} from './query-contract.js';
import type { StatisticsLabelResolver } from './statistics-labels.js';

const DTO_VERSION = STATISTICS_DTO_VERSION;
const FORMULA_VERSION = STATISTICS_FORMULA_VERSION;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_CURSOR_BYTES = 1_024;
const DEFAULT_DISTRIBUTION_BINS = 20;
const ALLOWED_BUCKETS_MS = new Set<number>(STATISTICS_BUCKET_SIZES_MS);
const ALLOWED_MEASURES: ReadonlySet<StatisticsMeasure> = new Set(STATISTICS_MEASURES);
const ALLOWED_DIMENSIONS: ReadonlySet<string> = new Set(STATISTICS_DIMENSIONS);
const ALLOWED_DISTRIBUTION_MEASURES: ReadonlySet<StatisticsDistributionMeasure> = new Set(
  STATISTICS_DISTRIBUTION_MEASURES,
);
const OUTPUT_CARDINALITY_ERROR = 'Statistics response exceeds the output-cardinality limit';
const OUTPUT_BYTES_ERROR = 'Statistics response exceeds the output-byte limit';

/** Reject a response with more summaries than the advertised output limit. */
function assertOutputCardinality(items: number, maximum: number): void {
  if (!Number.isSafeInteger(items) || items < 0 || items > maximum) {
    throw new StatisticsLimitError('outputItems', maximum, `${OUTPUT_CARDINALITY_ERROR} of ${maximum} summaries`);
  }
}

/**
 * One exact serialized-size check of the finished response. Inputs are
 * already bounded in count (rows, groups, buckets), and every identifier is
 * bounded in length, so this caps the transport size, not the work.
 */
function completeResponse<Value>(value: Value): Value {
  const serialized = JSON.stringify(value) as string | undefined;
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new StatisticsLimitError('outputBytes', MAX_RESPONSE_BYTES, OUTPUT_BYTES_ERROR);
  }
  return value;
}

export type LlmStatisticsMeasure = StatisticsMeasure;
export type LlmStatisticsDistributionMeasure = StatisticsDistributionMeasure;

export interface StatisticsRangeQuery {
  readonly fromMs: number;
  readonly toMs: number;
  readonly filters?: LlmExchangeFilters;
}

export interface ExchangeQuery extends StatisticsRangeQuery {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface CursorPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly snapshotMaxSequence: number;
}

export interface SummaryQuery extends StatisticsRangeQuery {
  readonly measures: readonly LlmStatisticsMeasure[];
  readonly groupBy?: readonly LlmStatisticsDimension[];
  /** Keep the highest request-count groups over the query's stable snapshot. */
  readonly topGroups?: number;
}

export interface MetricSummary {
  readonly dimensions: Readonly<Record<string, string | boolean | null>>;
  /**
   * Display names for pseudonymized dimension values, keyed by dimension:
   * the configured persona, provider profile or agent whose local pseudonym
   * the stored value is. Present only when at least one value resolves.
   */
  readonly labels?: Readonly<Record<string, string>>;
  readonly measure: LlmStatisticsMeasure;
  /**
   * Sum/count/rate for additive measures; arithmetic mean for latency and
   * rate-per-second samples. The input, output and total token sums also
   * include the known parts of exchanges whose exact value is unknown, so
   * they are lower bounds whenever `lowerBoundCount` is non-zero. Null when
   * nothing was measured, or when a sum of reported values overflows a double.
   */
  readonly value: number | null;
  /** Rows exactly measured; median, quartiles and coverage describe these. */
  readonly sampleCount: number;
  /** Rows that added only their known parts to `value` (exact value unknown). */
  readonly lowerBoundCount: number;
  /** Distinct non-null session IDs among observations sampled for this measure. */
  readonly sampleSessionCount: number;
  readonly eligibleCount: number;
  readonly coverage: number;
  /**
   * Quartiles of the exactly measured values: exact when `sampleCount` is at
   * most the advertised `quantileSampleSize`, otherwise computed from a
   * deterministic sample of that many values.
   */
  readonly median: number | null;
  readonly lowerQuartile: number | null;
  readonly upperQuartile: number | null;
  readonly formulaVersion: number;
}

export interface TimeSeriesQuery extends SummaryQuery {
  /** Fixed-duration bucket retained for backwards compatibility. Exactly one bucket form is required. */
  readonly bucketMs?: number;
  /** Calendar day in an IANA time zone. Exactly one bucket form is required. */
  readonly calendarBucket?: {
    readonly unit: 'day';
    readonly timeZone: string;
  };
}

export interface TimeBucket {
  readonly fromMs: number;
  readonly toMs: number;
  readonly summaries: readonly MetricSummary[];
}

export interface DimensionQuery extends StatisticsRangeQuery {
  readonly dimension: LlmStatisticsDimension;
  readonly limit?: number;
}

export interface DimensionValue {
  readonly value: LlmStatisticsDimensionValue;
  /** Display name when `value` is the pseudonym of a configured persona, profile or agent. */
  readonly label?: string;
  readonly count: number;
}

export interface DistributionQuery extends StatisticsRangeQuery {
  readonly measure: LlmStatisticsDistributionMeasure;
  readonly maxBins?: number;
}

export interface DistributionBin {
  readonly lower: number;
  readonly upper: number;
  readonly count: number;
}

export interface MetricDistribution {
  readonly measure: LlmStatisticsDistributionMeasure;
  readonly bins: readonly DistributionBin[];
  readonly sampleCount: number;
  readonly eligibleCount: number;
  readonly coverage: number;
  readonly minimum: number | null;
  readonly maximum: number | null;
  readonly formulaVersion: number;
}

export interface LlmUsageTotals {
  readonly sessionId: string;
  readonly exchanges: number;
  /** Input, output and total include the known parts of partly measured exchanges. */
  readonly inputTokens: number | null;
  readonly uncachedInputTokens: number | null;
  readonly cacheReadInputTokens: number | null;
  readonly cacheWriteInputTokens: number | null;
  readonly toolUseInputTokens: number | null;
  readonly thinkingTokens: number | null;
  readonly nonThinkingOutputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
  readonly completeUsageExchanges: number;
  readonly partialUsageExchanges: number;
  readonly missingOrInvalidUsageExchanges: number;
  /** True when input, output and total are lower bounds: some exchange was measured only in part, or not at all. */
  readonly tokenTotalsLowerBound: boolean;
}

/** The limits a query service enforces; capabilities advertise exactly these. */
export interface StatisticsQueryLimits {
  /** Most matching observations one aggregation query may summarize. */
  readonly maxScannedRows: number;
  /** Most groups per summary, or per time-series bucket. */
  readonly maxGroups: number;
  /** Most summaries (groups x measures over all buckets) per response. */
  readonly maxOutputItems: number;
  readonly maxTimeSeriesBuckets: number;
  /** Most exact values the median and quartiles of one summary are computed from. */
  readonly quantileSampleSize: number;
}

export interface StatisticsCapabilities extends StatisticsQueryLimits {
  readonly available: boolean;
  readonly dtoVersion: number;
  readonly formulaVersion: number;
  readonly schemaVersion: number | null;
  readonly maxPageSize: number;
  readonly maxRangeDays: number;
  readonly maxResponseBytes: number;
  readonly allowedBucketSizesMs: readonly number[];
  readonly allowedCalendarBucketUnits: readonly (typeof STATISTICS_CALENDAR_BUCKET_UNITS)[number][];
  readonly health: LlmMetricsRepositoryHealth;
}

export const DEFAULT_STATISTICS_QUERY_LIMITS: StatisticsQueryLimits = Object.freeze({
  maxScannedRows: MAX_STATISTICS_AGGREGATION_ROWS,
  maxGroups: MAX_STATISTICS_GROUPS,
  maxOutputItems: MAX_STATISTICS_OUTPUT_ITEMS,
  maxTimeSeriesBuckets: MAX_STATISTICS_TIME_SERIES_BUCKETS,
  quantileSampleSize: STATISTICS_QUANTILE_SAMPLE_SIZE,
});

/** Capability fields that do not depend on repository health. */
export function statisticsCapabilityLimits(
  limits: StatisticsQueryLimits = DEFAULT_STATISTICS_QUERY_LIMITS,
): Omit<StatisticsCapabilities, 'available' | 'schemaVersion' | 'health'> {
  return {
    dtoVersion: DTO_VERSION,
    formulaVersion: FORMULA_VERSION,
    maxPageSize: MAX_STATISTICS_PAGE_SIZE,
    maxRangeDays: MAX_STATISTICS_RANGE_DAYS,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    ...limits,
    allowedBucketSizesMs: [...ALLOWED_BUCKETS_MS],
    allowedCalendarBucketUnits: [...STATISTICS_CALENDAR_BUCKET_UNITS],
  };
}

export interface LlmStatisticsReader {
  listExchanges(query: ExchangeQuery): Promise<CursorPage<StoredLlmExchange>>;
  summarize(query: SummaryQuery): Promise<readonly MetricSummary[]>;
  timeSeries(query: TimeSeriesQuery): Promise<readonly TimeBucket[]>;
  distribution(query: DistributionQuery): Promise<MetricDistribution>;
  dimensions(query: DimensionQuery): Promise<readonly DimensionValue[]>;
  sessionTotals(sessionId: string): Promise<LlmUsageTotals>;
  capabilities(): Promise<StatisticsCapabilities>;
}

export interface LlmStatisticsQueryServiceOptions {
  /** Resolves pseudonymized persona, profile and agent values to configured names. */
  readonly labels?: StatisticsLabelResolver;
  /** Tighter limits than the contract maxima (tests, constrained hosts). Never looser. */
  readonly limits?: Partial<StatisticsQueryLimits>;
}

interface CursorPayload {
  readonly version: 1;
  readonly fromMs: number;
  readonly toMs: number;
  readonly snapshotMaxSequence: number;
  readonly filtersFingerprint: string;
  readonly completedAtMs: number;
  readonly exchangeId: string;
}

function validateRange(query: StatisticsRangeQuery): void {
  if (
    !Number.isSafeInteger(query.fromMs) ||
    !Number.isSafeInteger(query.toMs) ||
    query.fromMs < 0 ||
    query.toMs < query.fromMs
  ) {
    throw new Error('Statistics time range is invalid');
  }
  if (query.toMs - query.fromMs > MAX_STATISTICS_RANGE_MS) {
    throw new StatisticsLimitError(
      'rangeDays',
      MAX_STATISTICS_RANGE_DAYS,
      `Statistics time range exceeds ${MAX_STATISTICS_RANGE_DAYS} days`,
    );
  }
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new Error(`Invalid ${name}`);
  return result;
}

function resolveLimits(overrides: Partial<StatisticsQueryLimits> | undefined): StatisticsQueryLimits {
  const limit = (name: keyof StatisticsQueryLimits): number =>
    boundedInteger(
      overrides?.[name],
      DEFAULT_STATISTICS_QUERY_LIMITS[name],
      DEFAULT_STATISTICS_QUERY_LIMITS[name],
      `statistics ${name}`,
    );
  return Object.freeze({
    maxScannedRows: limit('maxScannedRows'),
    maxGroups: limit('maxGroups'),
    maxOutputItems: limit('maxOutputItems'),
    maxTimeSeriesBuckets: limit('maxTimeSeriesBuckets'),
    quantileSampleSize: limit('quantileSampleSize'),
  });
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function filtersFingerprint(filters: LlmExchangeFilters | undefined): string {
  const entries = Object.entries(filters ?? {}) as [string, readonly (string | boolean)[]][];
  const normalized = entries
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, values]) => [key, [...values].map(String).sort()]);
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function decodeCursor(value: string): CursorPayload {
  if (Buffer.byteLength(value, 'utf8') > MAX_CURSOR_BYTES) throw new Error('Statistics cursor is too large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid statistics cursor');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('version' in parsed) ||
    parsed.version !== 1 ||
    !('fromMs' in parsed) ||
    !Number.isSafeInteger(parsed.fromMs) ||
    !('toMs' in parsed) ||
    !Number.isSafeInteger(parsed.toMs) ||
    !('snapshotMaxSequence' in parsed) ||
    !Number.isSafeInteger(parsed.snapshotMaxSequence) ||
    !('filtersFingerprint' in parsed) ||
    typeof parsed.filtersFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(parsed.filtersFingerprint) ||
    !('completedAtMs' in parsed) ||
    !Number.isSafeInteger(parsed.completedAtMs) ||
    !('exchangeId' in parsed) ||
    typeof parsed.exchangeId !== 'string'
  ) {
    throw new Error('Invalid statistics cursor');
  }
  return parsed as CursorPayload;
}

function validateSummaryQuery(query: SummaryQuery): void {
  if (
    query.measures.length === 0 ||
    query.measures.length > MAX_STATISTICS_MEASURES ||
    new Set(query.measures).size !== query.measures.length ||
    query.measures.some((measure) => !ALLOWED_MEASURES.has(measure))
  ) {
    throw new Error('Invalid statistics measures');
  }
  const groupBy = query.groupBy ?? [];
  if (new Set(groupBy).size !== groupBy.length || groupBy.length > MAX_STATISTICS_GROUP_BY) {
    throw new Error('Invalid statistics grouping');
  }
  if (groupBy.some((dimension) => !ALLOWED_DIMENSIONS.has(dimension))) {
    throw new Error('Unknown statistics dimension');
  }
  if (
    query.topGroups !== undefined &&
    (!Number.isSafeInteger(query.topGroups) ||
      query.topGroups < 1 ||
      query.topGroups > MAX_STATISTICS_TOP_GROUPS ||
      groupBy.length === 0)
  ) {
    throw new Error('Invalid statistics top-groups limit');
  }
}

function seriesBucket(query: TimeSeriesQuery): LlmStatisticsBucketSpec {
  const hasFixedBucket = query.bucketMs !== undefined;
  const hasCalendarBucket = query.calendarBucket !== undefined;
  if (hasFixedBucket === hasCalendarBucket) throw new Error('Exactly one statistics bucket form is required');
  if (hasFixedBucket) {
    if (!Number.isSafeInteger(query.bucketMs) || !ALLOWED_BUCKETS_MS.has(query.bucketMs ?? -1)) {
      throw new Error('Invalid statistics bucket size');
    }
    return { kind: 'fixed', widthMs: query.bucketMs ?? 0 };
  }
  const calendarBucket: unknown = query.calendarBucket;
  if (
    typeof calendarBucket !== 'object' ||
    calendarBucket === null ||
    !('unit' in calendarBucket) ||
    calendarBucket.unit !== 'day' ||
    !('timeZone' in calendarBucket) ||
    typeof calendarBucket.timeZone !== 'string' ||
    !isValidStatisticsTimeZone(calendarBucket.timeZone)
  ) {
    throw new Error('Invalid statistics calendar bucket');
  }
  return { kind: 'calendarDay', timeZone: calendarBucket.timeZone };
}

export class LlmStatisticsQueryService implements LlmStatisticsReader {
  private readonly limits: StatisticsQueryLimits;
  private readonly labels: StatisticsLabelResolver | undefined;

  constructor(
    private readonly repository: LlmMetricsReadRepository,
    options: LlmStatisticsQueryServiceOptions = {},
  ) {
    this.limits = resolveLimits(options.limits);
    this.labels = options.labels;
  }

  async listExchanges(query: ExchangeQuery): Promise<CursorPage<StoredLlmExchange>> {
    validateRange(query);
    const limit = boundedInteger(query.limit, 100, MAX_STATISTICS_PAGE_SIZE, 'page size');
    const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor);
    const queryFiltersFingerprint = filtersFingerprint(query.filters);
    if (
      cursor !== null &&
      (cursor.fromMs !== query.fromMs ||
        cursor.toMs !== query.toMs ||
        cursor.filtersFingerprint !== queryFiltersFingerprint)
    ) {
      throw new Error('Statistics cursor does not match the requested query');
    }
    const snapshotMaxSequence = cursor?.snapshotMaxSequence ?? (await this.repository.snapshotMaxSequence());
    const rows = await this.repository.scan({
      fromMs: query.fromMs,
      toMs: query.toMs,
      filters: query.filters,
      limit: limit + 1,
      snapshotMaxSequence,
      cursor: cursor === null ? undefined : { completedAtMs: cursor.completedAtMs, exchangeId: cursor.exchangeId },
    });
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return completeResponse({
      items,
      nextCursor:
        rows.length <= limit || last === undefined
          ? null
          : encodeCursor({
              version: 1,
              fromMs: query.fromMs,
              toMs: query.toMs,
              snapshotMaxSequence,
              filtersFingerprint: queryFiltersFingerprint,
              completedAtMs: last.completedAtMs,
              exchangeId: last.exchangeId,
            }),
      snapshotMaxSequence,
    });
  }

  async summarize(query: SummaryQuery): Promise<readonly MetricSummary[]> {
    validateRange(query);
    validateSummaryQuery(query);
    const groupBy = query.groupBy ?? [];
    const partitions = await this.repository.aggregate({
      fromMs: query.fromMs,
      toMs: query.toMs,
      filters: query.filters,
      measures: query.measures,
      groupBy,
      topGroups: query.topGroups,
      limits: this.aggregationLimits(),
    });
    assertOutputCardinality(partitions.length * query.measures.length, this.limits.maxOutputItems);
    return completeResponse(
      partitions.flatMap((partition) => this.partitionSummaries(partition, groupBy, query.measures)),
    );
  }

  async timeSeries(query: TimeSeriesQuery): Promise<readonly TimeBucket[]> {
    validateRange(query);
    const bucket = seriesBucket(query);
    validateSummaryQuery(query);
    const groupBy = query.groupBy ?? [];
    const partitions = await this.repository.aggregate({
      fromMs: query.fromMs,
      toMs: query.toMs,
      filters: query.filters,
      measures: query.measures,
      groupBy,
      topGroups: query.topGroups,
      bucket,
      limits: this.aggregationLimits(),
    });
    assertOutputCardinality(partitions.length * query.measures.length, this.limits.maxOutputItems);
    const buckets: { fromMs: number; toMs: number; summaries: MetricSummary[] }[] = [];
    for (const partition of partitions) {
      if (partition.bucketFromMs === null || partition.bucketToMs === null) {
        throw new Error('Invalid statistics time-series partition');
      }
      let current = buckets.at(-1);
      if (current?.fromMs !== partition.bucketFromMs) {
        current = { fromMs: partition.bucketFromMs, toMs: partition.bucketToMs, summaries: [] };
        buckets.push(current);
      }
      current.summaries.push(...this.partitionSummaries(partition, groupBy, query.measures));
    }
    return completeResponse(buckets);
  }

  async distribution(query: DistributionQuery): Promise<MetricDistribution> {
    validateRange(query);
    if (!ALLOWED_DISTRIBUTION_MEASURES.has(query.measure)) throw new Error('Invalid statistics distribution measure');
    const maxBins = boundedInteger(
      query.maxBins,
      DEFAULT_DISTRIBUTION_BINS,
      MAX_STATISTICS_DISTRIBUTION_BINS,
      'distribution bins',
    );
    const result = await this.repository.distribution({
      fromMs: query.fromMs,
      toMs: query.toMs,
      filters: query.filters,
      measure: query.measure,
      maxBins,
      limits: { maxRows: this.limits.maxScannedRows, quantileSampleSize: this.limits.quantileSampleSize },
    });
    return completeResponse({
      measure: query.measure,
      bins: result.bins,
      sampleCount: result.sampleCount,
      eligibleCount: result.eligibleCount,
      coverage: result.eligibleCount === 0 ? 0 : result.sampleCount / result.eligibleCount,
      minimum: result.minimum,
      maximum: result.maximum,
      formulaVersion: FORMULA_VERSION,
    });
  }

  async dimensions(query: DimensionQuery): Promise<readonly DimensionValue[]> {
    validateRange(query);
    if (!ALLOWED_DIMENSIONS.has(query.dimension)) throw new Error('Unknown statistics dimension');
    const limit = boundedInteger(query.limit, 100, MAX_STATISTICS_DIMENSION_VALUES, 'dimension limit');
    const values = await this.repository.dimensionValues(query.dimension, {
      fromMs: query.fromMs,
      toMs: query.toMs,
      filters: query.filters,
      limit,
    });
    if (values.length > limit) {
      throw new StatisticsLimitError('outputItems', limit, `${OUTPUT_CARDINALITY_ERROR} of ${limit} values`);
    }
    return completeResponse(
      values.map(({ value, count }) => {
        const label = this.labels?.label(query.dimension, value);
        return label === undefined ? { value, count } : { value, label, count };
      }),
    );
  }

  async sessionTotals(sessionId: string): Promise<LlmUsageTotals> {
    if (typeof sessionId !== 'string' || !STATISTICS_IDENTIFIER_PATTERN.test(sessionId)) {
      throw new Error('Invalid sessionId');
    }
    const totals = await this.repository.sessionTotals({
      sessionId,
      toMs: Date.now(),
      limits: { maxRows: this.limits.maxScannedRows },
    });
    return { sessionId, ...totals };
  }

  capabilities(): Promise<StatisticsCapabilities> {
    const health = this.repository.health();
    return Promise.resolve({
      available: health.readerState !== 'unavailable' && health.readerState !== 'closed',
      schemaVersion: health.schemaVersion,
      ...statisticsCapabilityLimits(this.limits),
      health,
    });
  }

  private aggregationLimits(): LlmStatisticsAggregationLimits {
    return {
      maxRows: this.limits.maxScannedRows,
      maxGroups: this.limits.maxGroups,
      maxOutputItems: this.limits.maxOutputItems,
      maxBuckets: this.limits.maxTimeSeriesBuckets,
      quantileSampleSize: this.limits.quantileSampleSize,
    };
  }

  private partitionSummaries(
    partition: LlmStatisticsPartition,
    groupBy: readonly LlmStatisticsDimension[],
    measures: readonly LlmStatisticsMeasure[],
  ): MetricSummary[] {
    const dimensions: Record<string, string | boolean | null> = {};
    let labels: Record<string, string> | undefined;
    groupBy.forEach((dimension, index) => {
      const value = partition.dimensions[index] ?? null;
      dimensions[dimension] = value;
      const label = this.labels?.label(dimension, value);
      if (label !== undefined) (labels ??= {})[dimension] = label;
    });
    return measures.map((measure, index) => {
      const aggregate = partition.measures[index] as LlmStatisticsMeasureAggregate | undefined;
      if (aggregate === undefined) throw new Error('Invalid statistics partition');
      return {
        dimensions,
        ...(labels === undefined ? {} : { labels }),
        measure,
        value: aggregate.value,
        sampleCount: aggregate.sampleCount,
        lowerBoundCount: aggregate.lowerBoundCount,
        sampleSessionCount: aggregate.sampleSessionCount,
        eligibleCount: partition.eligibleCount,
        coverage: partition.eligibleCount === 0 ? 0 : aggregate.sampleCount / partition.eligibleCount,
        median: aggregate.median,
        lowerQuartile: aggregate.lowerQuartile,
        upperQuartile: aggregate.upperQuartile,
        formulaVersion: FORMULA_VERSION,
      };
    });
  }
}
