import type { IdentitySource, LlmCostSource, LlmExchangeCompleted } from '../types.js';
import type { StatisticsDimension, StatisticsDistributionMeasure, StatisticsMeasure } from '../query-contract.js';

/**
 * Writer state. `restarting`: the writer worker failed, stalled, or could not
 * start, and a replacement is scheduled with backoff while the bounded queue
 * keeps accepting. `disabled` is latched only for failures no restart can
 * repair: an incompatible (future) schema, a corrupt database, or a
 * permission error.
 */
export type LlmMetricsRepositoryState = 'starting' | 'ready' | 'degraded' | 'restarting' | 'disabled' | 'closed';
export type LlmMetricsReaderState = 'idle' | 'starting' | 'ready' | 'unavailable' | 'closed';

export interface LlmMetricsRepositoryHealth {
  readonly state: LlmMetricsRepositoryState;
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
  /** Writer workers started to replace a failed, stalled, or unstartable one. */
  readonly writerRestarts: number;
  /** Records refused as invalid at the durable boundary, by reason (bounded key set). Included in `dropped`. */
  readonly invalidByReason: Readonly<Record<string, number>>;
  readonly readerState: LlmMetricsReaderState;
  readonly readerLastError: string | null;
}

export type LlmStatisticsDimension = StatisticsDimension;

export type LlmStatisticsDimensionValue = string | boolean | null;

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

export interface LlmExchangeCursor {
  readonly completedAtMs: number;
  readonly exchangeId: string;
}

export interface LlmExchangeScanQuery {
  readonly fromMs: number;
  readonly toMs: number;
  readonly limit: number;
  /** Stable high-water mark captured before cursor pagination starts. */
  readonly snapshotMaxSequence?: number;
  readonly cursor?: LlmExchangeCursor;
  readonly filters?: LlmExchangeFilters;
}

/** Flattened, content-free row returned by the storage boundary. */
export interface StoredLlmExchange {
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
  readonly servedModelSource: IdentitySource;
  readonly servedProvider: string | null;
  readonly servedProviderSource: IdentitySource;
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
  /** The provider's own input count (protocol semantics; a component of `inputTokens`). */
  readonly inputTokensReported: number | null;
  readonly inputTokens: number | null;
  readonly uncachedInputTokens: number | null;
  readonly cacheReadInputTokens: number | null;
  readonly cacheWriteInputTokens: number | null;
  readonly toolUseInputTokens: number | null;
  /** The provider's own output count (protocol semantics; a component of `outputTokens`). */
  readonly outputTokensReported: number | null;
  readonly outputTokens: number | null;
  readonly thinkingTokens: number | null;
  readonly nonThinkingOutputTokens: number | null;
  readonly providerTotalTokens: number | null;
  readonly totalTokens: number | null;
  /** Cost the gateway reported (column `cost_usd`). */
  readonly costUsd: number | null;
  /** Host estimate at first-party list prices (column `estimated_cost_usd`). */
  readonly estimatedCostUsd: number | null;
  /** Which of the two is the exchange's cost; null when neither is known. */
  readonly costSource: LlmCostSource | null;
  /** `PRICING_VERSION` of the table behind `estimatedCostUsd`. */
  readonly pricingVersion: string | null;
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

export interface LlmDimensionCount {
  readonly value: LlmStatisticsDimensionValue;
  readonly count: number;
}

/**
 * Limits one aggregation request runs under. The query service chooses them
 * (it advertises the same values in its capabilities); the reader rejects any
 * value above the contract maximum.
 */
export interface LlmStatisticsAggregationLimits {
  /** Most rows matching the range and filters; counted through an index before aggregating. */
  readonly maxRows: number;
  /** Most groups in the whole result (no bucket) or in any one bucket. */
  readonly maxGroups: number;
  /** Most summaries (partitions x measures) in the result. */
  readonly maxOutputItems: number;
  /** Most time-series buckets the range may span. */
  readonly maxBuckets: number;
  /** Most exact values the quartiles of one partition and measure come from. */
  readonly quantileSampleSize: number;
}

export type LlmStatisticsBucketSpec =
  { readonly kind: 'fixed'; readonly widthMs: number } | { readonly kind: 'calendarDay'; readonly timeZone: string };

export interface LlmStatisticsAggregateQuery {
  readonly fromMs: number;
  readonly toMs: number;
  readonly filters?: LlmExchangeFilters;
  readonly measures: readonly StatisticsMeasure[];
  readonly groupBy?: readonly LlmStatisticsDimension[];
  /** Keep only the groups with the most requests over the whole range. */
  readonly topGroups?: number;
  readonly bucket?: LlmStatisticsBucketSpec;
  readonly limits: LlmStatisticsAggregationLimits;
}

/** One measure of one partition, with the semantics `MetricSummary` documents. */
export interface LlmStatisticsMeasureAggregate {
  readonly value: number | null;
  readonly sampleCount: number;
  readonly lowerBoundCount: number;
  readonly sampleSessionCount: number;
  readonly median: number | null;
  readonly lowerQuartile: number | null;
  readonly upperQuartile: number | null;
}

/** One group within one time bucket (or the whole range when unbucketed). */
export interface LlmStatisticsPartition {
  /** Inclusive start of the bucket; null when the query has no bucket. */
  readonly bucketFromMs: number | null;
  /** Exclusive end of the bucket; null when the query has no bucket. */
  readonly bucketToMs: number | null;
  /** Grouping values, in `groupBy` order. */
  readonly dimensions: readonly LlmStatisticsDimensionValue[];
  readonly eligibleCount: number;
  /** In `measures` order. */
  readonly measures: readonly LlmStatisticsMeasureAggregate[];
}

export interface LlmStatisticsDistributionQuery {
  readonly fromMs: number;
  readonly toMs: number;
  readonly filters?: LlmExchangeFilters;
  readonly measure: StatisticsDistributionMeasure;
  readonly maxBins: number;
  readonly limits: Pick<LlmStatisticsAggregationLimits, 'maxRows' | 'quantileSampleSize'>;
}

export interface LlmStatisticsDistributionResult {
  readonly bins: readonly { readonly lower: number; readonly upper: number; readonly count: number }[];
  readonly sampleCount: number;
  readonly eligibleCount: number;
  readonly minimum: number | null;
  readonly maximum: number | null;
}

/** Whole-session token and cost totals with the lower-bound rule applied to partly measured rows. */
export interface LlmSessionUsageTotalsResult {
  readonly exchanges: number;
  readonly inputTokens: number | null;
  readonly uncachedInputTokens: number | null;
  readonly cacheReadInputTokens: number | null;
  readonly cacheWriteInputTokens: number | null;
  readonly toolUseInputTokens: number | null;
  readonly thinkingTokens: number | null;
  readonly nonThinkingOutputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  /** Sum of the exchanges' known costs (gateway-reported, else list-price); null when none is known. */
  readonly costUsd: number | null;
  readonly completeUsageExchanges: number;
  readonly partialUsageExchanges: number;
  readonly missingOrInvalidUsageExchanges: number;
  readonly tokenTotalsLowerBound: boolean;
}

export interface LlmSessionTotalsQuery {
  readonly sessionId: string;
  /** Inclusive upper completion bound (rows stamped later, e.g. by a skewed clock, are excluded). */
  readonly toMs: number;
  readonly limits: Pick<LlmStatisticsAggregationLimits, 'maxRows'>;
}

export interface LlmDeleteBeforeOptions {
  /** Stable upper bound returned by an earlier partial call. */
  readonly snapshotMaxSequence?: number;
  /** Rows per short transaction. */
  readonly chunkSize?: number;
  /** Hard row bound for one management call. */
  readonly maxRows?: number;
  /** Wall-clock bound for issuing chunks, excluding a currently executing SQLite operation. */
  readonly maxDurationMs?: number;
  /** Crash-safe cross-process lease duration. Must cover maxDurationMs. */
  readonly leaseDurationMs?: number;
}

export interface LlmDeleteBeforeResult {
  readonly status: 'complete' | 'partial' | 'busy';
  readonly cutoffMs: number;
  readonly snapshotMaxSequence: number | null;
  readonly deletedCount: number;
  readonly chunksProcessed: number;
}

/**
 * The read half of the repository. Aggregation runs inside SQLite on the
 * reader worker; only grouped results cross into the caller's thread.
 */
export interface LlmMetricsReadRepository {
  health(): LlmMetricsRepositoryHealth;
  snapshotMaxSequence(): Promise<number>;
  scan(query: LlmExchangeScanQuery): Promise<readonly StoredLlmExchange[]>;
  dimensionValues(
    dimension: LlmStatisticsDimension,
    query: Omit<LlmExchangeScanQuery, 'cursor'>,
  ): Promise<readonly LlmDimensionCount[]>;
  aggregate(query: LlmStatisticsAggregateQuery): Promise<readonly LlmStatisticsPartition[]>;
  distribution(query: LlmStatisticsDistributionQuery): Promise<LlmStatisticsDistributionResult>;
  sessionTotals(query: LlmSessionTotalsQuery): Promise<LlmSessionUsageTotalsResult>;
}

export interface LlmMetricsRepository extends LlmMetricsReadRepository {
  /** Non-blocking, fail-open enqueue. False means this observation was dropped. */
  enqueue(exchange: LlmExchangeCompleted): boolean;
  flush(): Promise<void>;
  close(): Promise<void>;
  deleteBefore(cutoffMs: number, options?: LlmDeleteBeforeOptions): Promise<LlmDeleteBeforeResult>;
}

export class LlmMetricsRepositoryUnavailableError extends Error {
  constructor(message = 'LLM metrics repository is unavailable') {
    super(message);
    this.name = 'LlmMetricsRepositoryUnavailableError';
  }
}
