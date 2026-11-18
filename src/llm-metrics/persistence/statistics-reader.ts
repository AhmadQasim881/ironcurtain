/**
 * Statistics aggregation inside SQLite, run by the reader worker.
 *
 * Each request runs in one read transaction (one consistent WAL snapshot):
 *
 * 1. an index-backed count of the matching rows, bounded by `maxRows`;
 * 2. optionally the top groups by request count;
 * 3. one GROUP BY pass over only the columns the requested measures need.
 *
 * Sums, counts and means are SQL aggregates; distinct sessions, quartiles and
 * histogram counts use the bounded callbacks in `statistics-functions.ts`.
 * Only per-group results leave the worker. SQL text is assembled from fixed
 * fragments; every request-derived value is a bound parameter.
 *
 * Loaded inside the persistence worker through native type stripping: keep it
 * self-contained, erasable TypeScript.
 */

import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite';

import {
  MAX_STATISTICS_AGGREGATION_ROWS,
  MAX_STATISTICS_DISTRIBUTION_BINS,
  MAX_STATISTICS_GROUP_BY,
  MAX_STATISTICS_GROUPS,
  MAX_STATISTICS_MEASURES,
  MAX_STATISTICS_OUTPUT_ITEMS,
  MAX_STATISTICS_TIME_SERIES_BUCKETS,
  MAX_STATISTICS_TOP_GROUPS,
  STATISTICS_BUCKET_SIZES_MS,
  STATISTICS_DISTRIBUTION_MEASURES,
  STATISTICS_MEASURES,
  STATISTICS_QUANTILE_SAMPLE_SIZE,
  StatisticsLimitError,
  isValidStatisticsTimeZone,
  type StatisticsDistributionMeasure,
  type StatisticsMeasure,
} from '../query-contract.js';
import { calendarDayStarts } from '../statistics-calendar.js';
import {
  DIMENSION_COLUMNS,
  appendFilters,
  decodeDimensionValue,
  invalidQuery,
  queryIdentifier,
} from './query-filters.js';
import type {
  LlmExchangeFilters,
  LlmSessionTotalsQuery,
  LlmSessionUsageTotalsResult,
  LlmStatisticsAggregateQuery,
  LlmStatisticsAggregationLimits,
  LlmStatisticsDimension,
  LlmStatisticsDistributionQuery,
  LlmStatisticsDistributionResult,
  LlmStatisticsMeasureAggregate,
  LlmStatisticsPartition,
} from './repository.js';
import {
  HISTOGRAM_FUNCTION,
  MAX_PARTITION_VALUES,
  PARTITION_STATISTICS_FUNCTION,
  distributionLayout,
  singleValueBin,
} from './statistics-functions.js';

// ---------------------------------------------------------------------------
// Measure formulas (formula version 4). Fixed SQL over fixed column names.
// ---------------------------------------------------------------------------

/** Any reported token counter: an exchange without one is unmeasured, not zero. */
const MEASURED = `(${[
  'input_tokens_reported',
  'input_tokens_total',
  'input_tokens_uncached',
  'cache_read_input_tokens',
  'cache_write_input_tokens',
  'tool_use_input_tokens',
  'output_tokens_reported',
  'output_tokens_total',
  'thinking_tokens',
  'non_thinking_output_tokens',
  'provider_total_tokens',
  'canonical_total_tokens',
]
  .map((column) => `${column} IS NOT NULL`)
  .join(' OR ')})`;

// The lower-bound rule of `usageTokenBounds` (usage-bounds.ts) as SQL: an
// exact total when known, otherwise the largest sum of provably disjoint parts.
const INPUT_PARTIAL =
  'MAX(COALESCE(input_tokens_uncached, 0) + COALESCE(cache_read_input_tokens, 0) + ' +
  'COALESCE(cache_write_input_tokens, 0), COALESCE(input_tokens_reported, 0) + COALESCE(tool_use_input_tokens, 0))';
const OUTPUT_PARTIAL =
  'MAX(COALESCE(output_tokens_reported, 0), COALESCE(thinking_tokens, 0), COALESCE(non_thinking_output_tokens, 0))';
const INPUT_BOUND = `(CASE WHEN input_tokens_total IS NOT NULL THEN input_tokens_total ELSE ${INPUT_PARTIAL} END)`;
const OUTPUT_BOUND = `(CASE WHEN output_tokens_total IS NOT NULL THEN output_tokens_total ELSE ${OUTPUT_PARTIAL} END)`;
const TOTAL_PARTIAL = `MAX(${INPUT_BOUND} + ${OUTPUT_BOUND}, COALESCE(provider_total_tokens, 0))`;

/**
 * A token or cost sum, accumulated in floating point. Every stored counter is
 * a safe integer, but their sum need not be: SQLite's integer SUM() raises
 * "integer overflow" past 2^63, and node:sqlite refuses an integer result
 * above 2^53. Either would turn a few implausible upstream-reported counts
 * into a failure of every query over their range. Sums below 2^53 stay
 * exact, as they were when JavaScript added them; NULL when no row has one.
 */
function floatSum(expression: string): string {
  return `SUM(CAST(${expression} AS REAL))`;
}

/** Largest finite double. SQLite keeps an infinite REAL, so finiteness is a range check. */
const MAX_FINITE_REAL = '1.7976931348623157e308';

/**
 * The exchange's cost (since formula version 3), the choice `exchangeCostUsd`
 * (cost-estimate.ts) makes: the gateway-reported `cost_usd`, else the host's
 * list-price `estimated_cost_usd`, each only when finite and non-negative;
 * NULL when neither is known. `cost_source` records which one a row has.
 */
const EXCHANGE_COST =
  `(CASE WHEN cost_usd BETWEEN 0 AND ${MAX_FINITE_REAL} THEN cost_usd ` +
  `WHEN estimated_cost_usd BETWEEN 0 AND ${MAX_FINITE_REAL} THEN estimated_cost_usd END)`;

/** Earliest visible generated event (reasoning or output). SQLite's scalar MIN is NULL if any argument is. */
const TTFT =
  'MIN(COALESCE(first_reasoning_offset_ms, first_output_offset_ms), ' +
  'COALESCE(first_output_offset_ms, first_reasoning_offset_ms))';

/** Inclusive output over request-received to successful client delivery. */
const EFFECTIVE_OUTPUT_TPS =
  "(CASE WHEN client_delivery_status = 'aborted' OR termination_category IN ('error', 'aborted', 'unknown') " +
  'OR client_delivery_end_offset_ms IS NULL OR client_delivery_end_offset_ms <= 0 OR output_tokens_total IS NULL ' +
  'THEN NULL ELSE output_tokens_total / (client_delivery_end_offset_ms / 1000.0) END)';

type MeasureFormula =
  | { readonly kind: 'requests' }
  | { readonly kind: 'refusals'; readonly rate: boolean }
  | { readonly kind: 'errors'; readonly rate: boolean }
  | { readonly kind: 'lowerBound'; readonly exact: string; readonly partial: string }
  | { readonly kind: 'sum'; readonly expression: string }
  | { readonly kind: 'mean'; readonly expression: string };

const MEASURE_FORMULAS: Readonly<Record<StatisticsMeasure, MeasureFormula>> = {
  requestCount: { kind: 'requests' },
  refusalCount: { kind: 'refusals', rate: false },
  refusalRate: { kind: 'refusals', rate: true },
  errorCount: { kind: 'errors', rate: false },
  errorRate: { kind: 'errors', rate: true },
  inputTokens: { kind: 'lowerBound', exact: 'input_tokens_total', partial: INPUT_PARTIAL },
  outputTokens: { kind: 'lowerBound', exact: 'output_tokens_total', partial: OUTPUT_PARTIAL },
  totalTokens: { kind: 'lowerBound', exact: 'canonical_total_tokens', partial: TOTAL_PARTIAL },
  uncachedInputTokens: { kind: 'sum', expression: 'input_tokens_uncached' },
  cacheReadInputTokens: { kind: 'sum', expression: 'cache_read_input_tokens' },
  cacheWriteInputTokens: { kind: 'sum', expression: 'cache_write_input_tokens' },
  toolUseInputTokens: { kind: 'sum', expression: 'tool_use_input_tokens' },
  thinkingTokens: { kind: 'sum', expression: 'thinking_tokens' },
  nonThinkingOutputTokens: { kind: 'sum', expression: 'non_thinking_output_tokens' },
  costUsd: { kind: 'sum', expression: EXCHANGE_COST },
  ttftMs: { kind: 'mean', expression: TTFT },
  upstreamLatencyMs: { kind: 'mean', expression: 'upstream_response_end_offset_ms' },
  clientLatencyMs: { kind: 'mean', expression: 'client_delivery_end_offset_ms' },
  effectiveOutputTokensPerSecond: { kind: 'mean', expression: EFFECTIVE_OUTPUT_TPS },
};

/** Per-row value a distribution or quartile describes: the exact value only. */
function sampleValueExpression(formula: MeasureFormula): string | null {
  switch (formula.kind) {
    case 'lowerBound':
      return formula.exact;
    case 'sum':
    case 'mean':
      return formula.expression;
    case 'requests':
    case 'refusals':
    case 'errors':
      return null;
  }
}

// ---------------------------------------------------------------------------
// Validation (defense in depth: the query service validates the same rules)
// ---------------------------------------------------------------------------

const ALLOWED_MEASURES: ReadonlySet<string> = new Set(STATISTICS_MEASURES);
const ALLOWED_DISTRIBUTION_MEASURES: ReadonlySet<string> = new Set(STATISTICS_DISTRIBUTION_MEASURES);
const ALLOWED_BUCKETS_MS: ReadonlySet<number> = new Set(STATISTICS_BUCKET_SIZES_MS);

function boundedLimit(value: unknown, maximum: number, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    invalidQuery(`Invalid statistics ${name} limit`);
  }
  return value;
}

function validatedLimits(untrusted: unknown): LlmStatisticsAggregationLimits {
  if (typeof untrusted !== 'object' || untrusted === null) invalidQuery('Missing statistics limits');
  const limits = untrusted as Partial<Record<keyof LlmStatisticsAggregationLimits, unknown>>;
  return {
    maxRows: boundedLimit(limits.maxRows, MAX_STATISTICS_AGGREGATION_ROWS, 'row'),
    maxGroups: boundedLimit(limits.maxGroups, MAX_STATISTICS_GROUPS, 'group'),
    maxOutputItems: boundedLimit(limits.maxOutputItems, MAX_STATISTICS_OUTPUT_ITEMS, 'output'),
    maxBuckets: boundedLimit(limits.maxBuckets, MAX_STATISTICS_TIME_SERIES_BUCKETS, 'bucket'),
    quantileSampleSize: boundedLimit(limits.quantileSampleSize, STATISTICS_QUANTILE_SAMPLE_SIZE, 'sample'),
  };
}

function validatedMeasures(measures: unknown): readonly StatisticsMeasure[] {
  if (
    !Array.isArray(measures) ||
    measures.length === 0 ||
    measures.length > MAX_STATISTICS_MEASURES ||
    new Set(measures).size !== measures.length ||
    !measures.every(
      (measure): measure is StatisticsMeasure => typeof measure === 'string' && ALLOWED_MEASURES.has(measure),
    )
  ) {
    invalidQuery('Invalid statistics measures');
  }
  return measures;
}

function validatedGroupColumns(groupBy: unknown): readonly { dimension: LlmStatisticsDimension; column: string }[] {
  if (groupBy === undefined) return [];
  if (!Array.isArray(groupBy) || groupBy.length > MAX_STATISTICS_GROUP_BY || new Set(groupBy).size !== groupBy.length) {
    invalidQuery('Invalid statistics grouping');
  }
  return groupBy.map((dimension: unknown) => {
    if (typeof dimension !== 'string' || !Object.hasOwn(DIMENSION_COLUMNS, dimension)) {
      invalidQuery('Unknown statistics dimension');
    }
    const known = dimension as LlmStatisticsDimension;
    return { dimension: known, column: DIMENSION_COLUMNS[known] };
  });
}

// ---------------------------------------------------------------------------
// Execution helpers
// ---------------------------------------------------------------------------

/** All statements of one request see one committed snapshot. */
function readTransaction<Value>(database: DatabaseSync, operation: () => Value): Value {
  database.exec('BEGIN');
  try {
    const value = operation();
    database.exec('COMMIT');
    return value;
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Preserve the query error.
    }
    throw error;
  }
}

function count(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid statistics ${field}`);
  }
  return value;
}

function nullableNumber(value: SQLOutputValue | undefined, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid statistics ${field}`);
  return value;
}

/**
 * A sum or mean over stored values. Inputs are finite, but a floating-point
 * sum of extreme upstream-reported values can overflow; such a total is not
 * representable in the JSON response either, so it is reported as unknown
 * rather than failing the query (and retiring the reader).
 */
function aggregateNumber(value: SQLOutputValue | undefined, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number') throw new Error(`Invalid statistics ${field}`);
  return Number.isFinite(value) ? value : null;
}

function parseJsonArray(value: SQLOutputValue | undefined, field: string): unknown[] {
  if (typeof value !== 'string') throw new Error(`Invalid statistics ${field}`);
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error(`Invalid statistics ${field}`);
  return parsed;
}

function whereClause(
  query: { readonly fromMs: number; readonly toMs: number; readonly filters?: LlmExchangeFilters },
  params: SQLInputValue[],
): string {
  return appendFilters(query, params).join(' AND ');
}

/** Reject before any per-row work when more rows match than one request may summarize. */
function assertRowBudget(
  database: DatabaseSync,
  where: string,
  whereParams: readonly SQLInputValue[],
  maxRows: number,
) {
  const row = database
    .prepare(`SELECT COUNT(*) AS matched FROM (SELECT 1 FROM llm_exchanges WHERE ${where} LIMIT ?)`)
    .get(...whereParams, maxRows + 1);
  if (count(row?.matched, 'row count') > maxRows) {
    throw new StatisticsLimitError(
      'scannedRows',
      maxRows,
      `Statistics query exceeds the scanned-row limit: more than ${maxRows} observations match; choose a shorter range or narrower filters`,
    );
  }
}

interface BucketPlan {
  readonly expression: string;
  readonly params: readonly SQLInputValue[];
  readonly count: number;
  bounds(index: number): { readonly fromMs: number; readonly toMs: number };
}

function bucketCase(starts: readonly number[], lower: number, upper: number, params: SQLInputValue[]): string {
  if (lower === upper) return String(lower);
  const middle = (lower + upper + 1) >> 1;
  params.push(starts[middle] ?? 0);
  return `CASE WHEN completed_at_ms < ? THEN ${bucketCase(starts, lower, middle - 1, params)} ELSE ${bucketCase(
    starts,
    middle,
    upper,
    params,
  )} END`;
}

function bucketPlan(query: LlmStatisticsAggregateQuery, maxBuckets: number): BucketPlan | null {
  const bucket: unknown = query.bucket;
  if (bucket === undefined) return null;
  if (typeof bucket !== 'object' || bucket === null || !('kind' in bucket)) invalidQuery('Invalid statistics bucket');
  const tooManyBuckets = (): never => {
    throw new StatisticsLimitError(
      'timeSeriesBuckets',
      maxBuckets,
      `Statistics time series exceeds the bucket limit of ${maxBuckets} buckets; choose a shorter range or a larger bucket`,
    );
  };
  if (bucket.kind === 'fixed') {
    const widthMs = 'widthMs' in bucket ? bucket.widthMs : undefined;
    if (typeof widthMs !== 'number' || !ALLOWED_BUCKETS_MS.has(widthMs)) invalidQuery('Invalid statistics bucket size');
    const bucketCount = Math.ceil((query.toMs - query.fromMs + 1) / widthMs);
    if (bucketCount > maxBuckets) tooManyBuckets();
    return {
      // Integer division of two INTEGER operands: an exact floor for completed_at_ms >= fromMs.
      expression: '(completed_at_ms - CAST(? AS INTEGER)) / CAST(? AS INTEGER)',
      params: [query.fromMs, widthMs],
      count: bucketCount,
      bounds: (index) => {
        const fromMs = query.fromMs + index * widthMs;
        return { fromMs, toMs: Math.min(fromMs + widthMs, query.toMs + 1) };
      },
    };
  }
  if (bucket.kind === 'calendarDay') {
    const timeZone = 'timeZone' in bucket ? bucket.timeZone : undefined;
    if (typeof timeZone !== 'string' || !isValidStatisticsTimeZone(timeZone)) {
      invalidQuery('Invalid statistics calendar bucket');
    }
    const starts = calendarDayStarts(query.fromMs, query.toMs, timeZone, maxBuckets) ?? tooManyBuckets();
    const params: SQLInputValue[] = [];
    const expression = bucketCase(starts, 0, starts.length - 1, params);
    return {
      expression,
      params,
      count: starts.length,
      bounds: (index) => ({ fromMs: starts[index] ?? query.fromMs, toMs: starts[index + 1] ?? query.toMs + 1 }),
    };
  }
  return invalidQuery('Invalid statistics bucket');
}

// ---------------------------------------------------------------------------
// Aggregate (summaries and time series)
// ---------------------------------------------------------------------------

interface MeasurePlan {
  readonly formula: MeasureFormula;
  readonly valueAlias: string | null;
  readonly sampleAlias: string | null;
  readonly lowerBoundAlias: string | null;
  /** Index of the per-row value whose presence marks a row as sampled for this measure. */
  readonly sampleValue: number;
}

/** Deduplicated `expression AS alias` list. */
class AliasList {
  readonly expressions: string[] = [];
  private readonly aliases = new Map<string, string>();
  private readonly prefix: string;

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  alias(expression: string): string {
    const existing = this.aliases.get(expression);
    if (existing !== undefined) return existing;
    const alias = `${this.prefix}${this.expressions.length}`;
    this.aliases.set(expression, alias);
    this.expressions.push(`${expression} AS ${alias}`);
    return alias;
  }
}

interface AggregatePlan {
  readonly plans: readonly MeasurePlan[];
  /** Per-row components, computed once per row in the inner subquery. */
  readonly rowColumns: AliasList;
  /** Group aggregates over those components. */
  readonly aggregates: AliasList;
  /** Per-row sample values passed to the partition callback (`1` = every row). */
  readonly sampleValues: readonly string[];
  /** Bit `i` set: the callback keeps a quartile sample of sample value `i`. */
  readonly quantileMask: number;
}

function planAggregate(measures: readonly StatisticsMeasure[]): AggregatePlan {
  const rowColumns = new AliasList('c');
  const aggregates = new AliasList('a');
  const sampleValues: string[] = [];
  let quantileMask = 0;
  const sampleValue = (expression: string, quartiles: boolean): number => {
    let index = sampleValues.indexOf(expression);
    if (index < 0) {
      sampleValues.push(expression);
      index = sampleValues.length - 1;
    }
    if (quartiles) quantileMask |= 1 << index;
    return index;
  };
  const plans = measures.map((measure): MeasurePlan => {
    const formula = MEASURE_FORMULAS[measure];
    switch (formula.kind) {
      case 'requests':
        return {
          formula,
          valueAlias: null,
          sampleAlias: null,
          lowerBoundAlias: null,
          sampleValue: sampleValue('1', false),
        };
      case 'refusals': {
        const refusal = rowColumns.alias('refusal');
        return {
          formula,
          valueAlias: aggregates.alias(`COALESCE(SUM(${refusal} = 1), 0)`),
          sampleAlias: aggregates.alias(`COUNT(${refusal})`),
          lowerBoundAlias: null,
          sampleValue: sampleValue(refusal, false),
        };
      }
      case 'errors': {
        const error = rowColumns.alias("(termination_category = 'error')");
        return {
          formula,
          valueAlias: aggregates.alias(`COALESCE(SUM(${error}), 0)`),
          sampleAlias: null,
          lowerBoundAlias: null,
          sampleValue: sampleValue('1', false),
        };
      }
      case 'lowerBound': {
        // CASE short-circuits: the measured check runs only for inexact rows.
        const bound = rowColumns.alias(
          `CASE WHEN ${formula.exact} IS NOT NULL THEN ${formula.exact} WHEN ${MEASURED} THEN ${formula.partial} END`,
        );
        const exact = rowColumns.alias(formula.exact);
        const partial = rowColumns.alias(
          `CASE WHEN ${formula.exact} IS NOT NULL THEN 0 WHEN ${MEASURED} THEN 1 ELSE 0 END`,
        );
        return {
          formula,
          valueAlias: aggregates.alias(floatSum(bound)),
          sampleAlias: aggregates.alias(`COUNT(${exact})`),
          lowerBoundAlias: aggregates.alias(`COALESCE(SUM(${partial}), 0)`),
          sampleValue: sampleValue(exact, true),
        };
      }
      case 'sum':
      case 'mean': {
        const value = rowColumns.alias(formula.expression);
        return {
          formula,
          valueAlias: aggregates.alias(formula.kind === 'sum' ? floatSum(value) : `AVG(${value})`),
          sampleAlias: aggregates.alias(`COUNT(${value})`),
          lowerBoundAlias: null,
          sampleValue: sampleValue(value, true),
        };
      }
    }
  });
  if (sampleValues.length > MAX_PARTITION_VALUES) invalidQuery('Too many statistics measures');
  return { plans, rowColumns, aggregates, sampleValues, quantileMask };
}

type Quartiles = readonly [number | null, number | null, number | null] | null;

function decodeQuartiles(entry: unknown): Quartiles {
  if (entry === null) return null;
  if (!Array.isArray(entry) || entry.length !== 3) throw new Error('Invalid statistics quartiles');
  const [lower, median, upper] = entry.map((value: unknown) => {
    if (value === null) return null;
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Invalid statistics quartiles');
    return value;
  });
  return [lower ?? null, median ?? null, upper ?? null];
}

interface DecodedPartitionStatistics {
  readonly sessions: readonly unknown[];
  readonly quartiles: readonly Quartiles[];
}

function decodePartitionStatistics(value: SQLOutputValue | undefined): DecodedPartitionStatistics {
  if (typeof value !== 'string') throw new Error('Invalid statistics partition result');
  const parsed: unknown = JSON.parse(value);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('sessions' in parsed) ||
    !Array.isArray(parsed.sessions) ||
    !('quartiles' in parsed) ||
    !Array.isArray(parsed.quartiles)
  ) {
    throw new Error('Invalid statistics partition result');
  }
  return { sessions: parsed.sessions as unknown[], quartiles: (parsed.quartiles as unknown[]).map(decodeQuartiles) };
}

function measureAggregate(
  plan: MeasurePlan,
  row: Record<string, SQLOutputValue>,
  eligibleCount: number,
  statistics: DecodedPartitionStatistics,
): LlmStatisticsMeasureAggregate {
  const sessions = statistics.sessions[plan.sampleValue];
  const sampleSessionCount = typeof sessions === 'number' && Number.isSafeInteger(sessions) ? sessions : 0;
  const [lowerQuartile, median, upperQuartile] = statistics.quartiles[plan.sampleValue] ?? [null, null, null];
  const raw = plan.valueAlias === null ? eligibleCount : aggregateNumber(row[plan.valueAlias], 'value');
  const sampleCount = plan.sampleAlias === null ? eligibleCount : count(row[plan.sampleAlias], 'sample count');
  const lowerBoundCount = plan.lowerBoundAlias === null ? 0 : count(row[plan.lowerBoundAlias], 'lower-bound count');
  let value = raw;
  const { formula } = plan;
  if (formula.kind === 'refusals' && formula.rate) value = sampleCount === 0 ? null : (raw ?? 0) / sampleCount;
  if (formula.kind === 'errors' && formula.rate) value = eligibleCount === 0 ? null : (raw ?? 0) / eligibleCount;
  const hasQuartiles = formula.kind === 'lowerBound' || formula.kind === 'sum' || formula.kind === 'mean';
  return {
    value,
    sampleCount,
    lowerBoundCount,
    sampleSessionCount,
    median: hasQuartiles ? median : null,
    lowerQuartile: hasQuartiles ? lowerQuartile : null,
    upperQuartile: hasQuartiles ? upperQuartile : null,
  };
}

export function aggregateStatistics(
  database: DatabaseSync,
  query: LlmStatisticsAggregateQuery,
): readonly LlmStatisticsPartition[] {
  const limits = validatedLimits(query.limits);
  const measures = validatedMeasures(query.measures);
  const groups = validatedGroupColumns(query.groupBy);
  const topGroups: unknown = query.topGroups;
  if (
    topGroups !== undefined &&
    (typeof topGroups !== 'number' ||
      !Number.isSafeInteger(topGroups) ||
      topGroups < 1 ||
      topGroups > MAX_STATISTICS_TOP_GROUPS ||
      groups.length === 0)
  ) {
    invalidQuery('Invalid statistics top-groups limit');
  }
  const whereParams: SQLInputValue[] = [];
  const where = whereClause(query, whereParams);
  const bucket = bucketPlan(query, limits.maxBuckets);
  const plan = planAggregate(measures);
  const maxPartitions = Math.min(
    (bucket?.count ?? 1) * limits.maxGroups,
    Math.floor(limits.maxOutputItems / measures.length),
  );
  const groupColumns = groups.map((group) => group.column);

  // Shape: [WITH top_groups] SELECT <keys>, <aggregates>, <callback>
  //   FROM (SELECT <keys>, <row components> FROM llm_exchanges WHERE ... LIMIT -1)
  //   [GROUP BY <keys> LIMIT ?]
  // The inner LIMIT keeps SQLite from flattening the subquery into the
  // aggregate, so each per-row component is computed once and read by every
  // aggregate and the callback.
  const params: SQLInputValue[] = [];
  let sql = '';
  if (typeof topGroups === 'number') {
    const names = groupColumns.map((_, index) => `g${index}`).join(', ');
    const columns = groupColumns.join(', ');
    sql +=
      `WITH top_groups (${names}) AS MATERIALIZED (SELECT ${columns} FROM llm_exchanges WHERE ${where} ` +
      `GROUP BY ${columns} ORDER BY COUNT(*) DESC, ${columns} LIMIT ?) `;
    params.push(...whereParams, topGroups);
  }
  const keyAliases = [
    ...(bucket === null ? [] : ['bucket_index']),
    ...groupColumns.map((_, index) => `group_${index}`),
  ];
  const callback =
    `${PARTITION_STATISTICS_FUNCTION}(?, ?, ingestion_sequence, session_id, ${plan.sampleValues.join(', ')}) ` +
    'AS partition_statistics';
  sql += `SELECT ${[...keyAliases, 'COUNT(*) AS eligible_count', ...plan.aggregates.expressions, callback].join(', ')} `;
  params.push(limits.quantileSampleSize, plan.quantileMask);
  const innerKeys = [
    ...(bucket === null ? [] : [`${bucket.expression} AS bucket_index`]),
    ...groupColumns.map((column, index) => `${column} AS group_${index}`),
  ];
  sql += `FROM (SELECT ${[...innerKeys, 'session_id', 'ingestion_sequence', ...plan.rowColumns.expressions].join(', ')} `;
  if (bucket !== null) params.push(...bucket.params);
  sql += `FROM llm_exchanges WHERE ${where}`;
  params.push(...whereParams);
  if (typeof topGroups === 'number') {
    sql += ` AND EXISTS (SELECT 1 FROM top_groups WHERE ${groupColumns
      .map((column, index) => `top_groups.g${index} IS llm_exchanges.${column}`)
      .join(' AND ')})`;
  }
  sql += ' LIMIT -1)';
  if (keyAliases.length > 0) {
    sql += ` GROUP BY ${keyAliases.join(', ')} LIMIT ?`;
    params.push(maxPartitions + 1);
  }

  const rows = readTransaction(database, () => {
    assertRowBudget(database, where, whereParams, limits.maxRows);
    return database.prepare(sql).all(...params);
  });

  if (rows.length > maxPartitions) {
    // More partitions than buckets x maxGroups: some bucket (or, unbucketed,
    // the whole range) has too many groups, whatever the output size.
    if (rows.length > (bucket?.count ?? 1) * limits.maxGroups) {
      throw new StatisticsLimitError(
        'groups',
        limits.maxGroups,
        `Statistics query exceeds the group cardinality limit of ${limits.maxGroups} groups` +
          (bucket === null ? '' : ' per bucket'),
      );
    }
    throw new StatisticsLimitError(
      'outputItems',
      limits.maxOutputItems,
      `Statistics response exceeds the output-cardinality limit of ${limits.maxOutputItems} summaries`,
    );
  }

  const partitions = rows.map((row) => {
    const bucketIndex = bucket === null ? null : count(row.bucket_index, 'bucket index');
    if (bucket !== null && bucketIndex !== null && bucketIndex >= bucket.count) {
      throw new Error('Invalid statistics bucket index');
    }
    const bounds = bucket === null || bucketIndex === null ? null : bucket.bounds(bucketIndex);
    const eligibleCount = count(row.eligible_count, 'eligible count');
    const statistics = decodePartitionStatistics(row.partition_statistics);
    return {
      bucketIndex,
      partition: {
        bucketFromMs: bounds?.fromMs ?? null,
        bucketToMs: bounds?.toMs ?? null,
        dimensions: groups.map((group, index) => decodeDimensionValue(group.dimension, row[`group_${index}`])),
        eligibleCount,
        measures: plan.plans.map((measurePlan) => measureAggregate(measurePlan, row, eligibleCount, statistics)),
      } satisfies LlmStatisticsPartition,
    };
  });

  if (bucket !== null) {
    const groupsPerBucket = new Map<number, number>();
    for (const { bucketIndex } of partitions) {
      const key = bucketIndex ?? -1;
      const next = (groupsPerBucket.get(key) ?? 0) + 1;
      if (next > limits.maxGroups) {
        throw new StatisticsLimitError(
          'groups',
          limits.maxGroups,
          `Statistics query exceeds the group cardinality limit of ${limits.maxGroups} groups per bucket`,
        );
      }
      groupsPerBucket.set(key, next);
    }
  }

  // Buckets ascending; within one, the busiest group first; ties by value.
  return partitions
    .map(({ bucketIndex, partition }) => ({ bucketIndex, partition, key: JSON.stringify(partition.dimensions) }))
    .sort(
      (left, right) =>
        (left.bucketIndex ?? 0) - (right.bucketIndex ?? 0) ||
        right.partition.eligibleCount - left.partition.eligibleCount ||
        (left.key < right.key ? -1 : left.key > right.key ? 1 : 0),
    )
    .map(({ partition }) => partition);
}

// ---------------------------------------------------------------------------
// Distribution
// ---------------------------------------------------------------------------

export function distributionStatistics(
  database: DatabaseSync,
  query: LlmStatisticsDistributionQuery,
): LlmStatisticsDistributionResult {
  const measure: unknown = query.measure;
  if (typeof measure !== 'string' || !ALLOWED_DISTRIBUTION_MEASURES.has(measure)) {
    invalidQuery('Invalid statistics distribution measure');
  }
  const maxBins = boundedLimit(query.maxBins, MAX_STATISTICS_DISTRIBUTION_BINS, 'distribution bin');
  const limits = query.limits as Partial<LlmStatisticsDistributionQuery['limits']> | undefined;
  const maxRows = boundedLimit(limits?.maxRows, MAX_STATISTICS_AGGREGATION_ROWS, 'row');
  const sampleSize = boundedLimit(limits?.quantileSampleSize, STATISTICS_QUANTILE_SAMPLE_SIZE, 'sample');
  const value = sampleValueExpression(MEASURE_FORMULAS[measure as StatisticsDistributionMeasure]);
  if (value === null) invalidQuery('Invalid statistics distribution measure');
  const whereParams: SQLInputValue[] = [];
  const where = whereClause(query, whereParams);

  // Computed once per row (the LIMIT prevents flattening), read by every aggregate.
  const rows = `(SELECT ingestion_sequence, ${value} AS value FROM llm_exchanges WHERE ${where} LIMIT -1)`;
  return readTransaction(database, () => {
    assertRowBudget(database, where, whereParams, maxRows);
    const stats = database
      .prepare(
        'SELECT COUNT(*) AS eligible_count, COUNT(value) AS sample_count, MIN(value) AS minimum, ' +
          `MAX(value) AS maximum, ${PARTITION_STATISTICS_FUNCTION}(?, 1, ingestion_sequence, NULL, value) ` +
          `AS partition_statistics FROM ${rows}`,
      )
      .get(sampleSize, ...whereParams);
    const eligibleCount = count(stats?.eligible_count, 'eligible count');
    const sampleCount = count(stats?.sample_count, 'sample count');
    const minimum = nullableNumber(stats?.minimum, 'minimum');
    const maximum = nullableNumber(stats?.maximum, 'maximum');
    if (sampleCount === 0 || minimum === null || maximum === null) {
      return { bins: [], sampleCount, eligibleCount, minimum: null, maximum: null };
    }
    const [lowerQuartile, , upperQuartile] = decodePartitionStatistics(stats?.partition_statistics).quartiles[0] ?? [
      null,
      null,
      null,
    ];
    const layout = distributionLayout(
      sampleCount,
      minimum,
      maximum,
      (upperQuartile ?? maximum) - (lowerQuartile ?? minimum),
      maxBins,
    );
    if (layout === null) {
      return { bins: [singleValueBin(minimum, sampleCount)], sampleCount, eligibleCount, minimum, maximum };
    }
    const histogram = database
      .prepare(`SELECT ${HISTOGRAM_FUNCTION}(?, ?, ?, value) AS counts FROM ${rows}`)
      .get(layout.lower, layout.width, layout.binCount, ...whereParams);
    const counts = parseJsonArray(histogram?.counts, 'histogram');
    const bins = Array.from({ length: layout.binCount }, (_, index) => ({
      lower: layout.lower + index * layout.width,
      upper: layout.lower + (index + 1) * layout.width,
      count: count(counts[index], 'histogram count'),
    }));
    return { bins, sampleCount, eligibleCount, minimum, maximum };
  });
}

// ---------------------------------------------------------------------------
// Session totals
// ---------------------------------------------------------------------------

export function sessionTotalsStatistics(
  database: DatabaseSync,
  query: LlmSessionTotalsQuery,
): LlmSessionUsageTotalsResult {
  const sessionId = queryIdentifier(query.sessionId, 'sessionId');
  const limits = query.limits as Partial<LlmSessionTotalsQuery['limits']> | undefined;
  const maxRows = boundedLimit(limits?.maxRows, MAX_STATISTICS_AGGREGATION_ROWS, 'row');
  if (!Number.isSafeInteger(query.toMs) || query.toMs < 0) invalidQuery('Invalid query time range');
  const whereParams: SQLInputValue[] = [];
  const where = whereClause({ fromMs: 0, toMs: query.toMs, filters: { sessionId: [sessionId] } }, whereParams);
  const lowerBoundSum = (exact: string, partial: string): string =>
    floatSum(`CASE WHEN ${exact} IS NOT NULL THEN ${exact} WHEN ${MEASURED} THEN ${partial} END`);
  const sum = (column: string): string => `${floatSum(column)} AS ${column}`;
  const sql =
    'SELECT COUNT(*) AS exchanges, ' +
    `${lowerBoundSum('input_tokens_total', INPUT_PARTIAL)} AS input_tokens, ` +
    `${sum('input_tokens_uncached')}, ${sum('cache_read_input_tokens')}, ` +
    `${sum('cache_write_input_tokens')}, ${sum('tool_use_input_tokens')}, ` +
    `${sum('thinking_tokens')}, ${sum('non_thinking_output_tokens')}, ` +
    `${lowerBoundSum('output_tokens_total', OUTPUT_PARTIAL)} AS output_tokens, ` +
    `${lowerBoundSum('canonical_total_tokens', TOTAL_PARTIAL)} AS total_tokens, ` +
    `${floatSum(EXCHANGE_COST)} AS exchange_cost_usd, ` +
    "COALESCE(SUM(usage_completeness = 'complete'), 0) AS complete_usage, " +
    "COALESCE(SUM(usage_completeness = 'partial'), 0) AS partial_usage, " +
    "COALESCE(SUM(usage_completeness IN ('missing', 'invalid')), 0) AS missing_usage, " +
    'COALESCE(SUM(input_tokens_total IS NULL OR output_tokens_total IS NULL OR canonical_total_tokens IS NULL), 0) ' +
    `AS lower_bound_rows FROM llm_exchanges WHERE ${where}`;
  const row = readTransaction(database, () => {
    assertRowBudget(database, where, whereParams, maxRows);
    return database.prepare(sql).get(...whereParams);
  });
  return {
    exchanges: count(row?.exchanges, 'exchange count'),
    inputTokens: aggregateNumber(row?.input_tokens, 'input tokens'),
    uncachedInputTokens: aggregateNumber(row?.input_tokens_uncached, 'uncached input tokens'),
    cacheReadInputTokens: aggregateNumber(row?.cache_read_input_tokens, 'cache-read input tokens'),
    cacheWriteInputTokens: aggregateNumber(row?.cache_write_input_tokens, 'cache-write input tokens'),
    toolUseInputTokens: aggregateNumber(row?.tool_use_input_tokens, 'tool-use input tokens'),
    thinkingTokens: aggregateNumber(row?.thinking_tokens, 'thinking tokens'),
    nonThinkingOutputTokens: aggregateNumber(row?.non_thinking_output_tokens, 'non-thinking output tokens'),
    outputTokens: aggregateNumber(row?.output_tokens, 'output tokens'),
    totalTokens: aggregateNumber(row?.total_tokens, 'total tokens'),
    costUsd: aggregateNumber(row?.exchange_cost_usd, 'cost'),
    completeUsageExchanges: count(row?.complete_usage, 'complete usage count'),
    partialUsageExchanges: count(row?.partial_usage, 'partial usage count'),
    missingOrInvalidUsageExchanges: count(row?.missing_usage, 'missing usage count'),
    tokenTotalsLowerBound: count(row?.lower_bound_rows, 'lower-bound row count') > 0,
  };
}
