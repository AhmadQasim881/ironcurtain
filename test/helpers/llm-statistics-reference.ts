/**
 * Row-by-row reference for the statistics formulas, as the query service
 * computed them in JavaScript before aggregation moved into SQLite. Tests
 * compare the SQL results against it on generated rows.
 */

import { exchangeCostUsd } from '../../src/llm-metrics/cost-estimate.js';
import { calendarDateKey, calendarFormatter } from '../../src/llm-metrics/statistics-calendar.js';
import type { StatisticsMeasure } from '../../src/llm-metrics/query-contract.js';
import type { LlmStatisticsDimension, StoredLlmExchange } from '../../src/llm-metrics/persistence/repository.js';
import { usageTokenBounds } from '../../src/llm-metrics/usage-bounds.js';

export interface ReferenceSummary {
  readonly dimensions: Readonly<Record<string, string | boolean | null>>;
  readonly measure: StatisticsMeasure;
  readonly value: number | null;
  readonly sampleCount: number;
  readonly lowerBoundCount: number;
  readonly sampleSessionCount: number;
  readonly eligibleCount: number;
  readonly coverage: number;
  readonly median: number | null;
  readonly lowerQuartile: number | null;
  readonly upperQuartile: number | null;
}

const DIMENSION_VALUE: Readonly<Record<LlmStatisticsDimension, (row: StoredLlmExchange) => string | boolean | null>> = {
  agent: (row) => row.agent,
  logicalProvider: (row) => row.logicalProvider,
  gateway: (row) => row.gateway,
  protocol: (row) => row.protocol,
  providerProfile: (row) => row.providerProfile,
  requestedModel: (row) => row.requestedModel,
  forwardedModel: (row) => row.forwardedModel,
  responseModel: (row) => row.responseModel,
  servedModel: (row) => row.servedModel,
  servedProvider: (row) => row.servedProvider,
  reasoningMode: (row) => row.reasoningMode,
  requestedServiceTier: (row) => row.requestedServiceTier,
  actualServiceTier: (row) => row.actualServiceTier,
  inputMeasurementProvenance: (row) => row.inputMeasurementProvenance,
  outputMeasurementProvenance: (row) => row.outputMeasurementProvenance,
  thinkingMeasurementProvenance: (row) => row.thinkingMeasurementProvenance,
  nonThinkingMeasurementProvenance: (row) => row.nonThinkingMeasurementProvenance,
  speedMode: (row) => row.speedMode,
  streaming: (row) => row.streaming,
  outcome: (row) => row.outcome,
  refusal: (row) => row.refusal,
  usageCompleteness: (row) => row.usageCompleteness,
  attributionQuality: (row) => row.attributionQuality,
  sessionId: (row) => row.sessionId,
  workflowRunId: (row) => row.workflowRunId,
  stateId: (row) => row.stateId,
  personaId: (row) => row.personaId,
  bundleId: (row) => row.bundleId,
};

export function referenceQuantile(sorted: readonly number[], position: number): number | null {
  if (sorted.length === 0) return null;
  const index = (sorted.length - 1) * position;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const low = sorted[lower] ?? 0;
  const high = sorted[upper] ?? 0;
  return lower === upper ? low : low + (high - low) * (index - lower);
}

/** The per-row value of a measure (distribution and quartile population). */
export function referenceRowMeasure(row: StoredLlmExchange, measure: StatisticsMeasure): number | null {
  switch (measure) {
    case 'inputTokens':
      return row.inputTokens;
    case 'uncachedInputTokens':
      return row.uncachedInputTokens;
    case 'cacheReadInputTokens':
      return row.cacheReadInputTokens;
    case 'cacheWriteInputTokens':
      return row.cacheWriteInputTokens;
    case 'toolUseInputTokens':
      return row.toolUseInputTokens;
    case 'thinkingTokens':
      return row.thinkingTokens;
    case 'nonThinkingOutputTokens':
      return row.nonThinkingOutputTokens;
    case 'outputTokens':
      return row.outputTokens;
    case 'totalTokens':
      return row.totalTokens;
    case 'costUsd':
      // The exchange's cost: gateway-reported, else the host list-price estimate.
      return exchangeCostUsd(row);
    case 'ttftMs': {
      const values = [row.firstReasoningOffsetMs, row.firstOutputOffsetMs].filter(
        (value): value is number => value !== null,
      );
      return values.length === 0 ? null : Math.min(...values);
    }
    case 'upstreamLatencyMs':
      return row.upstreamResponseEndOffsetMs;
    case 'clientLatencyMs':
      return row.clientDeliveryEndOffsetMs;
    case 'effectiveOutputTokensPerSecond': {
      const duration = row.clientDeliveryEndOffsetMs;
      if (
        row.clientAborted ||
        row.outcome === 'error' ||
        row.outcome === 'aborted' ||
        row.outcome === 'unknown' ||
        duration === null ||
        duration <= 0 ||
        row.outputTokens === null
      ) {
        return null;
      }
      return row.outputTokens / (duration / 1_000);
    }
    case 'requestCount':
    case 'refusalCount':
    case 'refusalRate':
    case 'errorCount':
    case 'errorRate':
      return null;
  }
}

function sessions(rows: readonly StoredLlmExchange[]): number {
  return new Set(rows.flatMap((row) => (row.sessionId === null ? [] : [row.sessionId]))).size;
}

function summary(
  rows: readonly StoredLlmExchange[],
  dimensions: Readonly<Record<string, string | boolean | null>>,
  measure: StatisticsMeasure,
): ReferenceSummary {
  let values: number[] = [];
  let value: number | null;
  let sampleRows: readonly StoredLlmExchange[] = rows;
  let lowerBoundCount = 0;
  if (measure === 'requestCount') {
    value = rows.length;
  } else if (measure === 'refusalCount' || measure === 'refusalRate') {
    sampleRows = rows.filter((row) => row.refusal !== null);
    const refused = sampleRows.filter((row) => row.refusal === true).length;
    value = measure === 'refusalCount' ? refused : sampleRows.length === 0 ? null : refused / sampleRows.length;
  } else if (measure === 'errorCount' || measure === 'errorRate') {
    const errors = rows.filter((row) => row.outcome === 'error').length;
    value = measure === 'errorCount' ? errors : rows.length === 0 ? null : errors / rows.length;
  } else if (measure === 'inputTokens' || measure === 'outputTokens' || measure === 'totalTokens') {
    let total: number | null = null;
    const exact: StoredLlmExchange[] = [];
    for (const row of rows) {
      const bounds = usageTokenBounds({
        inputTokensReported: row.inputTokensReported,
        inputTokensTotal: row.inputTokens,
        inputTokensUncached: row.uncachedInputTokens,
        cacheReadInputTokens: row.cacheReadInputTokens,
        cacheWriteInputTokens: row.cacheWriteInputTokens,
        toolUseInputTokens: row.toolUseInputTokens,
        outputTokensReported: row.outputTokensReported,
        outputTokensTotal: row.outputTokens,
        thinkingTokens: row.thinkingTokens,
        nonThinkingOutputTokens: row.nonThinkingOutputTokens,
        providerTotalTokens: row.providerTotalTokens,
        canonicalTotalTokens: row.totalTokens,
      });
      if (!bounds.measured) continue;
      const [bound, isExact] =
        measure === 'inputTokens'
          ? [bounds.inputTokens, bounds.inputExact]
          : measure === 'outputTokens'
            ? [bounds.outputTokens, bounds.outputExact]
            : [bounds.totalTokens, bounds.totalExact];
      total = (total ?? 0) + bound;
      if (isExact) {
        exact.push(row);
        values.push(bound);
      } else {
        lowerBoundCount++;
      }
    }
    value = total;
    sampleRows = exact;
  } else {
    const samples = rows.flatMap((row) => {
      const measured = referenceRowMeasure(row, measure);
      return measured === null ? [] : [{ row, measured }];
    });
    values = samples.map((sample) => sample.measured);
    sampleRows = samples.map((sample) => sample.row);
    const sum = values.reduce((accumulated, entry) => accumulated + entry, 0);
    const mean =
      measure === 'ttftMs' ||
      measure === 'upstreamLatencyMs' ||
      measure === 'clientLatencyMs' ||
      measure === 'effectiveOutputTokensPerSecond';
    value = values.length === 0 ? null : mean ? sum / values.length : sum;
  }
  const sampleCount =
    measure === 'requestCount' || measure === 'errorCount' || measure === 'errorRate' ? rows.length : sampleRows.length;
  const sorted = [...values].sort((left, right) => left - right);
  return {
    dimensions,
    measure,
    value,
    sampleCount,
    lowerBoundCount,
    sampleSessionCount: sessions(sampleRows),
    eligibleCount: rows.length,
    coverage: rows.length === 0 ? 0 : sampleCount / rows.length,
    median: referenceQuantile(sorted, 0.5),
    lowerQuartile: referenceQuantile(sorted, 0.25),
    upperQuartile: referenceQuantile(sorted, 0.75),
  };
}

export interface ReferencePartition {
  readonly bucketKey: string | null;
  readonly summaries: readonly ReferenceSummary[];
}

/** Group rows by an optional bucket key and the grouping dimensions, then summarize every measure. */
export function referencePartitions(
  rows: readonly StoredLlmExchange[],
  measures: readonly StatisticsMeasure[],
  groupBy: readonly LlmStatisticsDimension[] = [],
  bucketKey?: (row: StoredLlmExchange) => string,
): ReferencePartition[] {
  if (groupBy.length === 0 && bucketKey === undefined) {
    return [{ bucketKey: null, summaries: measures.map((measure) => summary(rows, {}, measure)) }];
  }
  const partitions = new Map<
    string,
    { bucketKey: string | null; dimensions: Record<string, string | boolean | null>; rows: StoredLlmExchange[] }
  >();
  for (const row of rows) {
    const dimensions = Object.fromEntries(groupBy.map((dimension) => [dimension, DIMENSION_VALUE[dimension](row)]));
    const bucket = bucketKey?.(row) ?? null;
    const key = JSON.stringify([bucket, groupBy.map((dimension) => dimensions[dimension])]);
    const partition = partitions.get(key) ?? { bucketKey: bucket, dimensions, rows: [] };
    partition.rows.push(row);
    partitions.set(key, partition);
  }
  return [...partitions.values()].map((partition) => ({
    bucketKey: partition.bucketKey,
    summaries: measures.map((measure) => summary(partition.rows, partition.dimensions, measure)),
  }));
}

export function fixedBucketKey(fromMs: number, bucketMs: number): (row: StoredLlmExchange) => string {
  return (row) => String(fromMs + Math.floor((row.completedAtMs - fromMs) / bucketMs) * bucketMs);
}

export function calendarBucketKey(timeZone: string): (row: StoredLlmExchange) => string {
  const formatter = calendarFormatter(timeZone);
  return (row) => calendarDateKey(row.completedAtMs, formatter);
}
