import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';

import type { LlmCostSource, LlmExchangeCompleted, NormalizedUsage } from '../types.js';
import type {
  LlmDimensionCount,
  LlmExchangeScanQuery,
  LlmSessionTotalsQuery,
  LlmSessionUsageTotalsResult,
  LlmStatisticsAggregateQuery,
  LlmStatisticsDimension,
  LlmStatisticsDistributionQuery,
  LlmStatisticsDistributionResult,
  LlmStatisticsPartition,
  StoredLlmExchange,
} from './repository.js';
import { assertLlmMetricsSchemaCompatible, migrateLlmMetricsDatabase } from './migrations.js';
import { SQLITE_BUSY_TIMEOUT_MS, withSqliteBusyRetry } from './sqlite-busy-retry.js';
import { classifyStorageError, isRecordScopedSqliteError, type LlmMetricsStorageErrorCode } from './storage-errors.js';
import {
  MAX_EXCHANGE_QUALITY_FLAGS,
  STATISTICS_QUANTILE_SAMPLE_SIZE,
  isStatisticsLimitError,
  type StatisticsLimitName,
} from '../query-contract.js';
import {
  DIMENSION_COLUMNS,
  StatisticsQueryValidationError,
  appendFilters,
  decodeDimensionValue,
  invalidQuery,
  optionalProviderIdentifier,
  queryIdentifier,
  requiredIdentifier,
} from './query-filters.js';
import { aggregateStatistics, distributionStatistics, sessionTotalsStatistics } from './statistics-reader.js';
import { registerStatisticsFunctions } from './statistics-functions.js';

export interface SqliteWriterWorkerData {
  readonly role: 'writer';
  readonly databasePath: string;
  readonly processRunId: string;
  readonly startedAtMs: number;
}

export interface SqliteReaderWorkerData {
  readonly role: 'reader';
  readonly databasePath: string;
}

export type SqliteWorkerData = SqliteWriterWorkerData | SqliteReaderWorkerData;

export interface SqliteDeleteLeaseResult {
  readonly acquired: boolean;
  readonly snapshotMaxSequence: number | null;
}

export interface SqliteDeleteChunkResult {
  readonly deleted: number;
  readonly hasMore: boolean;
}

/** Outcome of one insert batch; the three counts add up to the batch size. */
export interface SqliteInsertResult {
  readonly inserted: number;
  readonly duplicates: number;
  /** Records refused as invalid, by reason. Only they were dropped; the rest of the batch was written. */
  readonly rejected: Readonly<Record<string, number>>;
}

export type SqliteWorkerRequest =
  | { readonly id: number; readonly kind: 'insert'; readonly exchanges: readonly LlmExchangeCompleted[] }
  | { readonly id: number; readonly kind: 'snapshotMaxSequence' }
  | {
      readonly id: number;
      readonly kind: 'beginDeleteBefore';
      readonly leaseName: string;
      readonly cutoffMs: number;
      readonly snapshotMaxSequence?: number;
      readonly leaseDurationMs: number;
    }
  | {
      readonly id: number;
      readonly kind: 'deleteBeforeChunk';
      readonly leaseName: string;
      readonly cutoffMs: number;
      readonly snapshotMaxSequence: number;
      readonly chunkSize: number;
      readonly leaseDurationMs: number;
    }
  | { readonly id: number; readonly kind: 'releaseMaintenanceLease'; readonly leaseName: string }
  | { readonly id: number; readonly kind: 'scan'; readonly query: LlmExchangeScanQuery }
  | {
      readonly id: number;
      readonly kind: 'dimensionValues';
      readonly dimension: LlmStatisticsDimension;
      readonly query: Omit<LlmExchangeScanQuery, 'cursor'>;
    }
  | { readonly id: number; readonly kind: 'aggregate'; readonly query: LlmStatisticsAggregateQuery }
  | { readonly id: number; readonly kind: 'distribution'; readonly query: LlmStatisticsDistributionQuery }
  | { readonly id: number; readonly kind: 'sessionTotals'; readonly query: LlmSessionTotalsQuery }
  | {
      readonly id: number;
      readonly kind: 'checkpoint';
      readonly observed: number;
      readonly finalized: number;
      readonly enqueued: number;
      readonly checkpointAtMs: number;
    }
  | {
      readonly id: number;
      readonly kind: 'close';
      readonly cleanEndedAtMs: number;
      readonly observed: number;
      readonly finalized: number;
      readonly enqueued: number;
    };

export type SqliteReaderWorkerRequest = Extract<
  SqliteWorkerRequest,
  {
    readonly kind: 'snapshotMaxSequence' | 'scan' | 'dimensionValues' | 'aggregate' | 'distribution' | 'sessionTotals';
  }
>;

type SqliteWriterWorkerRequest = Exclude<SqliteWorkerRequest, SqliteReaderWorkerRequest>;

export type SqliteWorkerResponse =
  | { readonly kind: 'ready'; readonly schemaVersion: number }
  | {
      readonly kind: 'result';
      readonly id: number;
      readonly value:
        | SqliteInsertResult
        | SqliteDeleteLeaseResult
        | SqliteDeleteChunkResult
        | number
        | readonly StoredLlmExchange[]
        | readonly LlmDimensionCount[]
        | readonly LlmStatisticsPartition[]
        | LlmStatisticsDistributionResult
        | LlmSessionUsageTotalsResult
        | null;
    }
  | {
      readonly kind: 'error';
      readonly id?: number;
      readonly message: string;
      /**
       * Reader errors distinguish rejected queries (`invalid_request`) and
       * well-formed queries over a statistics limit (`limit`) from broken
       * storage (`unavailable`). Only the last retires the reader.
       */
      readonly category?: 'invalid_request' | 'limit' | 'unavailable';
      /** Present for `limit`: which limit was exceeded, and its value. */
      readonly limit?: { readonly name: StatisticsLimitName; readonly maximum: number };
      /** Writer errors the repository acts on: requeue a busy batch, latch off on a permanent failure. */
      readonly code?: LlmMetricsStorageErrorCode;
    };

/** Must match the bounded gateway-adapter contract. */
const MAX_ATTEMPTS = 64;
const MAX_REJECTION_REASON_LENGTH = 120;
const MAX_SCAN_LIMIT = 10_001;
const MAX_DIMENSION_LIMIT = 500;
const MAX_DELETE_CHUNK_SIZE = 1_000;
const MIN_MAINTENANCE_LEASE_MS = 100;
const MAX_MAINTENANCE_LEASE_MS = 60_000;
const MAINTENANCE_BUSY_TIMEOUT_MS = 250;
const NORMAL_BUSY_TIMEOUT_MS = SQLITE_BUSY_TIMEOUT_MS;
/**
 * Page cache of the reader connection. Aggregations read every matching row
 * once; a cache that holds a few months of rows keeps repeated dashboard
 * queries from re-reading pages through the OS on every request.
 */
const READER_CACHE_KIB = 32 * 1024;
const ATTRIBUTION_QUALITIES = ['exact', 'bundle_only', 'unattributed'] as const;
const GATEWAY_KINDS = ['direct', 'openrouter', 'ironcurtain', 'opaque'] as const;
const IDENTITY_SOURCES = [
  'request',
  'forwarded_request',
  'protocol_response',
  'protocol_response_direct',
  'router_metadata',
  'trusted_gateway_header',
  'configured_route',
  'not_exposed',
] as const;
const REASONING_MODES = ['disabled', 'enabled', 'adaptive', 'effort', 'unknown'] as const;
const TERMINATIONS = ['stop', 'length', 'tool', 'refusal', 'content_filter', 'error', 'aborted', 'unknown'] as const;
const STOP_REASONS = [
  'end_turn',
  'stop_sequence',
  'max_tokens',
  'context_window',
  'tool_use',
  'pause_turn',
  'refusal',
  'content_filter',
  'completed',
  'incomplete',
  'failed',
  'cancelled',
  'other',
  'not_reported',
] as const;
const REFUSAL_SOURCES = [
  'stop_reason',
  'stop_details',
  'content_item',
  'content_filter',
  'prompt_feedback',
  'not_reported',
] as const;
const OUTPUT_TOKEN_SEMANTICS = ['includes_thinking', 'excludes_thinking', 'no_thinking_breakdown', 'unknown'] as const;
const USAGE_COMPLETENESS = ['complete', 'partial', 'missing', 'invalid'] as const;
const COST_SOURCES = ['gateway_reported', 'list_price'] as const satisfies readonly LlmCostSource[];
const MEASUREMENT_ACCURACIES = [
  'reported_exact',
  'provider_estimate',
  'derived_exact',
  'derived_from_estimate',
  'unknown',
] as const;
const TRANSPORT_OUTCOMES = ['response', 'auth_retry', 'error', 'aborted'] as const;
const GATEWAY_ATTEMPT_SOURCES = ['router_metadata', 'trusted_gateway_header'] as const;

const EXCHANGE_COLUMNS = `
  exchange_id AS exchangeId,
  schema_version AS schemaVersion,
  completed_at_ms AS completedAtMs,
  request_received_at_ms AS requestReceivedAtMs,
  session_id AS sessionId,
  turn_id AS turnId,
  agent_conversation_id AS agentConversationId,
  bundle_id AS bundleId,
  workflow_run_id AS workflowRunId,
  state_id AS stateId,
  persona_id AS personaId,
  attribution_quality AS attributionQuality,
  agent_name AS agent,
  logical_provider AS logicalProvider,
  provider_profile_id AS providerProfile,
  protocol,
  gateway_kind AS gateway,
  client_route_id AS clientRouteId,
  upstream_route_id AS upstreamRouteId,
  requested_model AS requestedModel,
  forwarded_model AS forwardedModel,
  response_model AS responseModel,
  served_model AS servedModel,
  served_model_source AS servedModelSource,
  served_provider AS servedProvider,
  served_provider_source AS servedProviderSource,
  provider_request_id AS providerRequestId,
  provider_response_id AS providerResponseId,
  gateway_generation_id AS gatewayGenerationId,
  streaming,
  requested_service_tier AS requestedServiceTier,
  actual_service_tier AS actualServiceTier,
  reasoning_mode AS reasoningMode,
  reasoning_effort AS reasoningEffort,
  thinking_budget_tokens AS thinkingBudgetTokens,
  speed_mode AS speedMode,
  response_status_code AS responseStatus,
  termination_category AS outcome,
  provider_stop_reason AS providerStopReason,
  refusal,
  refusal_category AS refusalCategory,
  input_tokens_reported AS inputTokensReported,
  input_tokens_total AS inputTokens,
  input_tokens_uncached AS uncachedInputTokens,
  cache_read_input_tokens AS cacheReadInputTokens,
  cache_write_input_tokens AS cacheWriteInputTokens,
  tool_use_input_tokens AS toolUseInputTokens,
  output_tokens_reported AS outputTokensReported,
  output_tokens_total AS outputTokens,
  thinking_tokens AS thinkingTokens,
  non_thinking_output_tokens AS nonThinkingOutputTokens,
  provider_total_tokens AS providerTotalTokens,
  canonical_total_tokens AS totalTokens,
  cost_usd AS costUsd,
  estimated_cost_usd AS estimatedCostUsd,
  cost_source AS costSource,
  pricing_version AS pricingVersion,
  usage_completeness AS usageCompleteness,
  usage_semantics_version AS usageSemanticsVersion,
  input_measurement_provenance AS inputMeasurementProvenance,
  output_measurement_provenance AS outputMeasurementProvenance,
  thinking_measurement_provenance AS thinkingMeasurementProvenance,
  non_thinking_measurement_provenance AS nonThinkingMeasurementProvenance,
  request_body_complete_offset_ms AS requestBodyCompleteOffsetMs,
  response_headers_offset_ms AS responseHeadersOffsetMs,
  first_upstream_body_byte_offset_ms AS firstUpstreamBodyByteOffsetMs,
  first_protocol_event_offset_ms AS firstProtocolEventOffsetMs,
  first_reasoning_offset_ms AS firstReasoningOffsetMs,
  last_reasoning_offset_ms AS lastReasoningOffsetMs,
  first_output_offset_ms AS firstOutputOffsetMs,
  last_output_offset_ms AS lastOutputOffsetMs,
  protocol_terminal_offset_ms AS protocolTerminalOffsetMs,
  upstream_response_end_offset_ms AS upstreamResponseEndOffsetMs,
  client_delivery_end_offset_ms AS clientDeliveryEndOffsetMs,
  client_delivery_status AS clientDeliveryStatus,
  quality_flags_json AS qualityFlagsJson
`;

const INSERT_EXCHANGE_SQL = `
  INSERT INTO llm_exchanges (
    exchange_id, schema_version, completed_at_ms, request_received_at_ms,
    session_id, turn_id, agent_conversation_id, bundle_id, workflow_run_id, state_id, persona_id,
    attribution_quality, agent_name, logical_provider, provider_profile_id, protocol, gateway_kind,
    client_route_id, upstream_route_id,
    requested_model, requested_model_source, forwarded_model, forwarded_model_source,
    response_model, response_model_source, served_model, served_model_source,
    served_provider, served_provider_source,
    provider_request_id, provider_response_id, gateway_generation_id,
    streaming, requested_service_tier, actual_service_tier, reasoning_mode, reasoning_effort,
    thinking_budget_tokens, speed_mode,
    response_status_code, termination_category, provider_stop_reason, refusal, refusal_category, outcome_source,
    input_tokens_reported, input_tokens_total, input_tokens_uncached, cache_read_input_tokens,
    cache_write_input_tokens, tool_use_input_tokens, output_tokens_reported, output_token_semantics,
    output_tokens_total, thinking_tokens, non_thinking_output_tokens, provider_total_tokens,
    canonical_total_tokens, cost_usd, estimated_cost_usd, cost_source, pricing_version,
    usage_source, usage_completeness, usage_semantics_version,
    input_measurement_provenance, output_measurement_provenance, thinking_measurement_provenance,
    non_thinking_measurement_provenance,
    request_body_complete_offset_ms, response_headers_offset_ms, first_upstream_body_byte_offset_ms,
    first_protocol_event_offset_ms, first_reasoning_offset_ms, last_reasoning_offset_ms,
    first_output_offset_ms, last_output_offset_ms, protocol_terminal_offset_ms,
    upstream_response_end_offset_ms, client_delivery_end_offset_ms, client_delivery_status,
    quality_flags_json, process_run_id
  ) VALUES (
    $exchangeId, $schemaVersion, $completedAtMs, $requestReceivedAtMs,
    $sessionId, $turnId, $agentConversationId, $bundleId, $workflowRunId, $stateId, $personaId,
    $attributionQuality, $agentName, $logicalProvider, $providerProfileId, $protocol, $gatewayKind,
    $clientRouteId, $upstreamRouteId,
    $requestedModel, $requestedModelSource, $forwardedModel, $forwardedModelSource,
    $responseModel, $responseModelSource, $servedModel, $servedModelSource,
    $servedProvider, $servedProviderSource,
    $providerRequestId, $providerResponseId, $gatewayGenerationId,
    $streaming, $requestedServiceTier, $actualServiceTier, $reasoningMode, $reasoningEffort,
    $thinkingBudgetTokens, $speedMode,
    $responseStatusCode, $terminationCategory, $providerStopReason, $refusal, $refusalCategory, $outcomeSource,
    $inputTokensReported, $inputTokensTotal, $inputTokensUncached, $cacheReadInputTokens,
    $cacheWriteInputTokens, $toolUseInputTokens, $outputTokensReported, $outputTokenSemantics,
    $outputTokensTotal, $thinkingTokens, $nonThinkingOutputTokens, $providerTotalTokens,
    $canonicalTotalTokens, $costUsd, $estimatedCostUsd, $costSource, $pricingVersion,
    $usageSource, $usageCompleteness, $usageSemanticsVersion,
    $inputMeasurementProvenance, $outputMeasurementProvenance, $thinkingMeasurementProvenance,
    $nonThinkingMeasurementProvenance,
    $requestBodyCompleteOffsetMs, $responseHeadersOffsetMs, $firstUpstreamBodyByteOffsetMs,
    $firstProtocolEventOffsetMs, $firstReasoningOffsetMs, $lastReasoningOffsetMs,
    $firstOutputOffsetMs, $lastOutputOffsetMs, $protocolTerminalOffsetMs,
    $upstreamResponseEndOffsetMs, $clientDeliveryEndOffsetMs, $clientDeliveryStatus,
    $qualityFlagsJson, $processRunId
  ) ON CONFLICT(exchange_id) DO NOTHING
`;

type SqlParameters = Record<string, SQLInputValue>;

function enumValue<const Value extends string>(value: string, allowed: readonly Value[], field: string): Value {
  if (!allowed.includes(value as Value)) throw new Error(`Invalid ${field}`);
  return value as Value;
}

function optionalIdentifier(value: string | null, field: string): string | null {
  return value === null ? null : requiredIdentifier(value, field);
}

function optionalBoolean(value: boolean | null): number | null {
  if (value === null) return null;
  if (typeof value !== 'boolean') throw new Error('Invalid boolean');
  return value ? 1 : 0;
}

function optionalHttpStatus(value: number | null, field: string): number | null {
  const status = safeTokenCount(value, field);
  if (status !== null && (status < 100 || status > 599)) throw new Error(`Invalid ${field}`);
  return status;
}

function safeOffset(value: number | null, field: string): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${field}`);
  return value;
}

function safeTokenCount(value: number | null, field: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${field}`);
  return value;
}

function optionalCost(value: number | null, field: string): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${field}`);
  return value;
}

/**
 * The stored cost source, consistent with the costs stored alongside it: a
 * source names the column that holds the exchange's cost, so a source whose
 * column is empty would misreport where a cost came from.
 */
function costSource(usage: NormalizedUsage, costUsd: number | null, estimatedCostUsd: number | null): string | null {
  const source = usage.costSource ?? (costUsd !== null ? 'gateway_reported' : null);
  if (source === null) return null;
  const checked = enumValue(source, COST_SOURCES, 'costSource');
  if ((checked === 'gateway_reported' && costUsd === null) || (checked === 'list_price' && estimatedCostUsd === null)) {
    throw new Error('Invalid costSource');
  }
  return checked;
}

function requestReceivedAtMs(exchange: LlmExchangeCompleted): number {
  const value = Date.parse(exchange.timing.requestReceivedAt);
  if (!Number.isFinite(value)) throw new Error('Invalid requestReceivedAt');
  return value;
}

function completedAtMs(exchange: LlmExchangeCompleted, startedAtMs: number): number {
  const endOffset =
    exchange.timing.clientDeliveryEndOffsetMs ??
    exchange.timing.upstreamResponseEndOffsetMs ??
    exchange.timing.protocolTerminalOffsetMs ??
    0;
  const checkedOffset = safeOffset(endOffset, 'completion offset');
  if (checkedOffset === null) throw new Error('Missing completion offset');
  // SQLite stores the wall-clock completion timestamp as an INTEGER. The
  // monotonic offsets retain sub-millisecond precision in their own REAL
  // columns; round only the display/index timestamp.
  return startedAtMs + Math.round(checkedOffset);
}

function qualityFlagsJson(exchange: LlmExchangeCompleted): string {
  if (exchange.qualityFlags.length > MAX_EXCHANGE_QUALITY_FLAGS) throw new Error('Too many quality flags');
  return JSON.stringify(exchange.qualityFlags.map((flag) => requiredIdentifier(flag, 'quality flag')));
}

function exchangeParameters(exchange: LlmExchangeCompleted, processRunId: string): SqlParameters {
  const schemaVersion: unknown = exchange.schemaVersion;
  if (schemaVersion !== 1) throw new Error('Unsupported exchange schemaVersion');
  const startedAtMs = requestReceivedAtMs(exchange);
  const { attribution, route, identity, responseMetadata, request, outcome, usage, timing } = exchange;
  const costUsd = optionalCost(usage.costUsd, 'costUsd');
  const estimatedCostUsd = optionalCost(usage.estimatedCostUsd ?? null, 'estimatedCostUsd');
  const usageSemanticsVersion: unknown = usage.usageSemanticsVersion;
  if (usageSemanticsVersion !== 1) throw new Error('Unsupported usageSemanticsVersion');

  return {
    exchangeId: requiredIdentifier(exchange.exchangeId, 'exchangeId'),
    schemaVersion: exchange.schemaVersion,
    completedAtMs: completedAtMs(exchange, startedAtMs),
    requestReceivedAtMs: startedAtMs,
    sessionId: optionalIdentifier(attribution.sessionId, 'sessionId'),
    turnId: optionalIdentifier(attribution.turnId, 'turnId'),
    agentConversationId: optionalIdentifier(attribution.agentConversationId, 'agentConversationId'),
    bundleId: optionalIdentifier(attribution.bundleId, 'bundleId'),
    workflowRunId: optionalIdentifier(attribution.workflowRunId, 'workflowRunId'),
    stateId: optionalIdentifier(attribution.stateId, 'stateId'),
    personaId: optionalIdentifier(attribution.personaId, 'personaId'),
    attributionQuality: enumValue(attribution.quality, ATTRIBUTION_QUALITIES, 'attribution quality'),
    agentName: optionalIdentifier(attribution.agentId, 'agentId'),
    logicalProvider: requiredIdentifier(route.logicalProvider, 'logicalProvider'),
    providerProfileId: optionalIdentifier(route.providerProfileId, 'providerProfileId'),
    protocol: requiredIdentifier(route.protocol, 'protocol'),
    gatewayKind: enumValue(route.gatewayKind, GATEWAY_KINDS, 'gateway kind'),
    clientRouteId: optionalIdentifier(route.clientRouteId, 'clientRouteId'),
    upstreamRouteId: optionalIdentifier(route.upstreamRouteId, 'upstreamRouteId'),
    requestedModel: optionalIdentifier(identity.requestedModel.value, 'requestedModel'),
    requestedModelSource: enumValue(identity.requestedModel.source, IDENTITY_SOURCES, 'requested model source'),
    forwardedModel: optionalIdentifier(identity.forwardedModel.value, 'forwardedModel'),
    forwardedModelSource: enumValue(identity.forwardedModel.source, IDENTITY_SOURCES, 'forwarded model source'),
    responseModel: optionalIdentifier(identity.responseModel.value, 'responseModel'),
    responseModelSource: enumValue(identity.responseModel.source, IDENTITY_SOURCES, 'response model source'),
    servedModel: optionalIdentifier(identity.servedModel.value, 'servedModel'),
    servedModelSource: enumValue(identity.servedModel.source, IDENTITY_SOURCES, 'served model source'),
    servedProvider: optionalProviderIdentifier(identity.servedProvider.value, 'servedProvider'),
    servedProviderSource: enumValue(identity.servedProvider.source, IDENTITY_SOURCES, 'served provider source'),
    providerRequestId: optionalIdentifier(responseMetadata.providerRequestId, 'providerRequestId'),
    providerResponseId: optionalIdentifier(responseMetadata.providerResponseId, 'providerResponseId'),
    gatewayGenerationId: optionalIdentifier(responseMetadata.gatewayGenerationId, 'gatewayGenerationId'),
    streaming: optionalBoolean(request.streaming),
    requestedServiceTier: optionalIdentifier(request.requestedServiceTier, 'requestedServiceTier'),
    actualServiceTier: optionalIdentifier(responseMetadata.actualServiceTier, 'actualServiceTier'),
    reasoningMode: enumValue(request.reasoningMode, REASONING_MODES, 'reasoning mode'),
    reasoningEffort: optionalIdentifier(request.reasoningEffort, 'reasoningEffort'),
    thinkingBudgetTokens: safeTokenCount(request.thinkingBudgetTokens, 'thinkingBudgetTokens'),
    speedMode: optionalIdentifier(request.speedMode, 'speedMode'),
    responseStatusCode: optionalHttpStatus(outcome.responseStatus, 'responseStatus'),
    terminationCategory: enumValue(outcome.termination, TERMINATIONS, 'termination'),
    providerStopReason: enumValue(outcome.providerStopReason, STOP_REASONS, 'stop reason'),
    refusal: optionalBoolean(outcome.refusal),
    refusalCategory: optionalIdentifier(outcome.refusalCategory, 'refusalCategory'),
    outcomeSource: enumValue(outcome.refusalSource, REFUSAL_SOURCES, 'refusal source'),
    inputTokensReported: safeTokenCount(usage.inputTokensReported, 'inputTokensReported'),
    inputTokensTotal: safeTokenCount(usage.inputTokensTotal, 'inputTokensTotal'),
    inputTokensUncached: safeTokenCount(usage.inputTokensUncached, 'inputTokensUncached'),
    cacheReadInputTokens: safeTokenCount(usage.cacheReadInputTokens, 'cacheReadInputTokens'),
    cacheWriteInputTokens: safeTokenCount(usage.cacheWriteInputTokens, 'cacheWriteInputTokens'),
    toolUseInputTokens: safeTokenCount(usage.toolUseInputTokens, 'toolUseInputTokens'),
    outputTokensReported: safeTokenCount(usage.outputTokensReported, 'outputTokensReported'),
    outputTokenSemantics: enumValue(usage.outputTokenSemantics, OUTPUT_TOKEN_SEMANTICS, 'output token semantics'),
    outputTokensTotal: safeTokenCount(usage.outputTokensTotal, 'outputTokensTotal'),
    thinkingTokens: safeTokenCount(usage.thinkingTokens, 'thinkingTokens'),
    nonThinkingOutputTokens: safeTokenCount(usage.nonThinkingOutputTokens, 'nonThinkingOutputTokens'),
    providerTotalTokens: safeTokenCount(usage.providerTotalTokens, 'providerTotalTokens'),
    canonicalTotalTokens: safeTokenCount(usage.canonicalTotalTokens, 'canonicalTotalTokens'),
    costUsd,
    estimatedCostUsd,
    costSource: costSource(usage, costUsd, estimatedCostUsd),
    pricingVersion: optionalIdentifier(usage.pricingVersion ?? null, 'pricingVersion'),
    usageSource: optionalIdentifier(usage.usageSource, 'usageSource'),
    usageCompleteness: enumValue(usage.usageCompleteness, USAGE_COMPLETENESS, 'usage completeness'),
    usageSemanticsVersion: usage.usageSemanticsVersion,
    inputMeasurementProvenance: enumValue(
      usage.inputTokensAccuracy,
      MEASUREMENT_ACCURACIES,
      'input measurement accuracy',
    ),
    outputMeasurementProvenance: enumValue(
      usage.outputTokensAccuracy,
      MEASUREMENT_ACCURACIES,
      'output measurement accuracy',
    ),
    thinkingMeasurementProvenance: enumValue(
      usage.thinkingTokensAccuracy,
      MEASUREMENT_ACCURACIES,
      'thinking measurement accuracy',
    ),
    nonThinkingMeasurementProvenance: enumValue(
      usage.nonThinkingOutputTokensAccuracy,
      MEASUREMENT_ACCURACIES,
      'non-thinking measurement accuracy',
    ),
    requestBodyCompleteOffsetMs: safeOffset(timing.requestBodyCompleteOffsetMs, 'requestBodyCompleteOffsetMs'),
    responseHeadersOffsetMs: safeOffset(timing.responseHeadersOffsetMs, 'responseHeadersOffsetMs'),
    firstUpstreamBodyByteOffsetMs: safeOffset(timing.firstUpstreamBodyByteOffsetMs, 'firstUpstreamBodyByteOffsetMs'),
    firstProtocolEventOffsetMs: safeOffset(timing.firstProtocolEventOffsetMs, 'firstProtocolEventOffsetMs'),
    firstReasoningOffsetMs: safeOffset(timing.firstReasoningEventOffsetMs, 'firstReasoningEventOffsetMs'),
    lastReasoningOffsetMs: safeOffset(timing.lastReasoningEventOffsetMs, 'lastReasoningEventOffsetMs'),
    firstOutputOffsetMs: safeOffset(timing.firstOutputEventOffsetMs, 'firstOutputEventOffsetMs'),
    lastOutputOffsetMs: safeOffset(timing.lastOutputEventOffsetMs, 'lastOutputEventOffsetMs'),
    protocolTerminalOffsetMs: safeOffset(timing.protocolTerminalOffsetMs, 'protocolTerminalOffsetMs'),
    upstreamResponseEndOffsetMs: safeOffset(timing.upstreamResponseEndOffsetMs, 'upstreamResponseEndOffsetMs'),
    clientDeliveryEndOffsetMs: safeOffset(timing.clientDeliveryEndOffsetMs, 'clientDeliveryEndOffsetMs'),
    clientDeliveryStatus: timing.clientAborted ? 'aborted' : 'finished',
    qualityFlagsJson: qualityFlagsJson(exchange),
    processRunId,
  };
}

function asNumber(value: SQLOutputValue | undefined, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid stored ${field}`);
  return value;
}

function asNullableNumber(value: SQLOutputValue | undefined, field: string): number | null {
  return value === null ? null : asNumber(value, field);
}

function asString(value: SQLOutputValue | undefined, field: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid stored ${field}`);
  return value;
}

function asNullableString(value: SQLOutputValue | undefined, field: string): string | null {
  return value === null ? null : asString(value, field);
}

function parseQualityFlags(value: SQLOutputValue | undefined): readonly string[] {
  const parsed: unknown = JSON.parse(asString(value, 'qualityFlagsJson'));
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === 'string')) {
    throw new Error('Invalid stored qualityFlagsJson');
  }
  return parsed;
}

function storedExchange(row: Record<string, SQLOutputValue>): StoredLlmExchange {
  return {
    exchangeId: asString(row.exchangeId, 'exchangeId'),
    schemaVersion: asNumber(row.schemaVersion, 'schemaVersion'),
    completedAtMs: asNumber(row.completedAtMs, 'completedAtMs'),
    requestReceivedAtMs: asNumber(row.requestReceivedAtMs, 'requestReceivedAtMs'),
    sessionId: asNullableString(row.sessionId, 'sessionId'),
    turnId: asNullableString(row.turnId, 'turnId'),
    agentConversationId: asNullableString(row.agentConversationId, 'agentConversationId'),
    bundleId: asNullableString(row.bundleId, 'bundleId'),
    workflowRunId: asNullableString(row.workflowRunId, 'workflowRunId'),
    stateId: asNullableString(row.stateId, 'stateId'),
    personaId: asNullableString(row.personaId, 'personaId'),
    attributionQuality: asString(row.attributionQuality, 'attributionQuality'),
    agent: asNullableString(row.agent, 'agent'),
    logicalProvider: asString(row.logicalProvider, 'logicalProvider'),
    providerProfile: asNullableString(row.providerProfile, 'providerProfile'),
    protocol: asString(row.protocol, 'protocol'),
    gateway: asString(row.gateway, 'gateway'),
    clientRouteId: asNullableString(row.clientRouteId, 'clientRouteId'),
    upstreamRouteId: asNullableString(row.upstreamRouteId, 'upstreamRouteId'),
    requestedModel: asNullableString(row.requestedModel, 'requestedModel'),
    forwardedModel: asNullableString(row.forwardedModel, 'forwardedModel'),
    responseModel: asNullableString(row.responseModel, 'responseModel'),
    servedModel: asNullableString(row.servedModel, 'servedModel'),
    servedModelSource: enumValue(
      asString(row.servedModelSource, 'servedModelSource'),
      IDENTITY_SOURCES,
      'servedModelSource',
    ),
    servedProvider: asNullableString(row.servedProvider, 'servedProvider'),
    servedProviderSource: enumValue(
      asString(row.servedProviderSource, 'servedProviderSource'),
      IDENTITY_SOURCES,
      'servedProviderSource',
    ),
    providerRequestId: asNullableString(row.providerRequestId, 'providerRequestId'),
    providerResponseId: asNullableString(row.providerResponseId, 'providerResponseId'),
    gatewayGenerationId: asNullableString(row.gatewayGenerationId, 'gatewayGenerationId'),
    streaming: row.streaming === null ? null : asNumber(row.streaming, 'streaming') === 1,
    requestedServiceTier: asNullableString(row.requestedServiceTier, 'requestedServiceTier'),
    actualServiceTier: asNullableString(row.actualServiceTier, 'actualServiceTier'),
    reasoningMode: asString(row.reasoningMode, 'reasoningMode'),
    reasoningEffort: asNullableString(row.reasoningEffort, 'reasoningEffort'),
    thinkingBudgetTokens: asNullableNumber(row.thinkingBudgetTokens, 'thinkingBudgetTokens'),
    speedMode: asNullableString(row.speedMode, 'speedMode'),
    responseStatus: asNullableNumber(row.responseStatus, 'responseStatus'),
    outcome: asString(row.outcome, 'outcome'),
    providerStopReason: asString(row.providerStopReason, 'providerStopReason'),
    refusal: row.refusal === null ? null : asNumber(row.refusal, 'refusal') === 1,
    refusalCategory: asNullableString(row.refusalCategory, 'refusalCategory'),
    inputTokensReported: asNullableNumber(row.inputTokensReported, 'inputTokensReported'),
    inputTokens: asNullableNumber(row.inputTokens, 'inputTokens'),
    uncachedInputTokens: asNullableNumber(row.uncachedInputTokens, 'uncachedInputTokens'),
    cacheReadInputTokens: asNullableNumber(row.cacheReadInputTokens, 'cacheReadInputTokens'),
    cacheWriteInputTokens: asNullableNumber(row.cacheWriteInputTokens, 'cacheWriteInputTokens'),
    toolUseInputTokens: asNullableNumber(row.toolUseInputTokens, 'toolUseInputTokens'),
    outputTokensReported: asNullableNumber(row.outputTokensReported, 'outputTokensReported'),
    outputTokens: asNullableNumber(row.outputTokens, 'outputTokens'),
    thinkingTokens: asNullableNumber(row.thinkingTokens, 'thinkingTokens'),
    nonThinkingOutputTokens: asNullableNumber(row.nonThinkingOutputTokens, 'nonThinkingOutputTokens'),
    providerTotalTokens: asNullableNumber(row.providerTotalTokens, 'providerTotalTokens'),
    totalTokens: asNullableNumber(row.totalTokens, 'totalTokens'),
    costUsd: asNullableNumber(row.costUsd, 'costUsd'),
    estimatedCostUsd: asNullableNumber(row.estimatedCostUsd, 'estimatedCostUsd'),
    // Rows written before schema 2 carry no source; their cost_usd was gateway-reported.
    costSource:
      row.costSource === null
        ? row.costUsd === null
          ? null
          : 'gateway_reported'
        : enumValue(asString(row.costSource, 'costSource'), COST_SOURCES, 'costSource'),
    pricingVersion: asNullableString(row.pricingVersion, 'pricingVersion'),
    usageCompleteness: asString(row.usageCompleteness, 'usageCompleteness'),
    usageSemanticsVersion: asNumber(row.usageSemanticsVersion, 'usageSemanticsVersion'),
    inputMeasurementProvenance: asString(row.inputMeasurementProvenance, 'inputMeasurementProvenance'),
    outputMeasurementProvenance: asString(row.outputMeasurementProvenance, 'outputMeasurementProvenance'),
    thinkingMeasurementProvenance: asString(row.thinkingMeasurementProvenance, 'thinkingMeasurementProvenance'),
    nonThinkingMeasurementProvenance: asString(
      row.nonThinkingMeasurementProvenance,
      'nonThinkingMeasurementProvenance',
    ),
    requestBodyCompleteOffsetMs: asNullableNumber(row.requestBodyCompleteOffsetMs, 'requestBodyCompleteOffsetMs'),
    responseHeadersOffsetMs: asNullableNumber(row.responseHeadersOffsetMs, 'responseHeadersOffsetMs'),
    firstUpstreamBodyByteOffsetMs: asNullableNumber(row.firstUpstreamBodyByteOffsetMs, 'firstUpstreamBodyByteOffsetMs'),
    firstProtocolEventOffsetMs: asNullableNumber(row.firstProtocolEventOffsetMs, 'firstProtocolEventOffsetMs'),
    firstReasoningOffsetMs: asNullableNumber(row.firstReasoningOffsetMs, 'firstReasoningOffsetMs'),
    lastReasoningOffsetMs: asNullableNumber(row.lastReasoningOffsetMs, 'lastReasoningOffsetMs'),
    firstOutputOffsetMs: asNullableNumber(row.firstOutputOffsetMs, 'firstOutputOffsetMs'),
    lastOutputOffsetMs: asNullableNumber(row.lastOutputOffsetMs, 'lastOutputOffsetMs'),
    protocolTerminalOffsetMs: asNullableNumber(row.protocolTerminalOffsetMs, 'protocolTerminalOffsetMs'),
    upstreamResponseEndOffsetMs: asNullableNumber(row.upstreamResponseEndOffsetMs, 'upstreamResponseEndOffsetMs'),
    clientDeliveryEndOffsetMs: asNullableNumber(row.clientDeliveryEndOffsetMs, 'clientDeliveryEndOffsetMs'),
    clientAborted: asString(row.clientDeliveryStatus, 'clientDeliveryStatus') === 'aborted',
    qualityFlags: parseQualityFlags(row.qualityFlagsJson),
  };
}

function scan(database: DatabaseSync, query: LlmExchangeScanQuery): readonly StoredLlmExchange[] {
  if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > MAX_SCAN_LIMIT) {
    invalidQuery('Invalid scan limit');
  }
  const params: SQLInputValue[] = [];
  const clauses = appendFilters(query, params);
  if (query.snapshotMaxSequence !== undefined) {
    if (!Number.isSafeInteger(query.snapshotMaxSequence) || query.snapshotMaxSequence < 0) {
      invalidQuery('Invalid snapshot sequence');
    }
    clauses.push('ingestion_sequence <= ?');
    params.push(query.snapshotMaxSequence);
  }
  if (query.cursor !== undefined) {
    if (!Number.isSafeInteger(query.cursor.completedAtMs)) invalidQuery('Invalid cursor timestamp');
    clauses.push('(completed_at_ms < ? OR (completed_at_ms = ? AND exchange_id < ?))');
    params.push(
      query.cursor.completedAtMs,
      query.cursor.completedAtMs,
      queryIdentifier(query.cursor.exchangeId, 'cursor exchangeId'),
    );
  }
  params.push(query.limit);
  const rows = database
    .prepare(
      `SELECT ${EXCHANGE_COLUMNS} FROM llm_exchanges WHERE ${clauses.join(
        ' AND ',
      )} ORDER BY completed_at_ms DESC, exchange_id DESC LIMIT ?`,
    )
    .all(...params);
  return rows.map(storedExchange);
}

function dimensionValues(
  database: DatabaseSync,
  dimension: LlmStatisticsDimension,
  query: Omit<LlmExchangeScanQuery, 'cursor'>,
): readonly LlmDimensionCount[] {
  if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > MAX_DIMENSION_LIMIT) {
    invalidQuery('Invalid dimension limit');
  }
  if (!Object.hasOwn(DIMENSION_COLUMNS, dimension)) invalidQuery('Invalid statistics dimension');
  const column = DIMENSION_COLUMNS[dimension];
  const params: SQLInputValue[] = [];
  const clauses = appendFilters(query, params);
  params.push(query.limit);
  const rows = database
    .prepare(
      `SELECT ${column} AS value, COUNT(*) AS count FROM llm_exchanges ` +
        `WHERE ${clauses.join(' AND ')} GROUP BY ${column} ORDER BY count DESC, ${column} ASC LIMIT ?`,
    )
    .all(...params);
  return rows.map((row) => ({
    value: decodeDimensionValue(dimension, row.value),
    count: asNumber(row.count, 'dimension count'),
  }));
}

function initializeWriter(data: SqliteWriterWorkerData): { database: DatabaseSync; schemaVersion: number } {
  mkdirSync(dirname(data.databasePath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(data.databasePath), 0o700);
  const database = new DatabaseSync(data.databasePath, {
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
  });
  try {
    const schemaVersion = migrateLlmMetricsDatabase(database);
    withSqliteBusyRetry(() => database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;'));
    // A restarted writer keeps its process run: the start marker is written
    // once and the checkpoint counters stay process-lifetime monotonic, so
    // the durable gap (enqueued minus persisted rows) still covers records
    // lost with a crashed worker.
    withSqliteBusyRetry(() =>
      database
        .prepare(
          `INSERT INTO llm_process_runs (
            process_run_id, started_at_ms, last_checkpoint_at_ms,
            observed_count, finalized_count, enqueued_count, clean_ended_at_ms
          ) VALUES (?, ?, ?, 0, 0, 0, NULL)
          ON CONFLICT (process_run_id) DO NOTHING`,
        )
        .run(requiredIdentifier(data.processRunId, 'processRunId'), data.startedAtMs, data.startedAtMs),
    );
    chmodSync(data.databasePath, 0o600);
    for (const suffix of ['-wal', '-shm']) {
      try {
        chmodSync(`${data.databasePath}${suffix}`, 0o600);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
    return { database, schemaVersion };
  } catch (error) {
    database.close();
    throw error;
  }
}

function initializeReader(data: SqliteReaderWorkerData): { database: DatabaseSync; schemaVersion: number } {
  const database = new DatabaseSync(data.databasePath, {
    readOnly: true,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
  });
  try {
    const schemaVersion = assertLlmMetricsSchemaCompatible(database, 'reader');
    database.exec(
      `PRAGMA query_only = ON; PRAGMA busy_timeout = ${NORMAL_BUSY_TIMEOUT_MS}; ` +
        `PRAGMA cache_size = -${READER_CACHE_KIB};`,
    );
    registerStatisticsFunctions(database, STATISTICS_QUANTILE_SAMPLE_SIZE);
    return { database, schemaVersion };
  } catch (error) {
    database.close();
    throw error;
  }
}

function boundedSafeInteger(value: number, minimum: number, maximum: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Invalid ${field}`);
  }
  return value;
}

function withMaintenanceBusyTimeout<Value>(database: DatabaseSync, operation: () => Value): Value {
  database.exec(`PRAGMA busy_timeout = ${MAINTENANCE_BUSY_TIMEOUT_MS}`);
  try {
    return operation();
  } finally {
    database.exec(`PRAGMA busy_timeout = ${NORMAL_BUSY_TIMEOUT_MS}`);
  }
}

function immediateTransaction<Value>(database: DatabaseSync, operation: () => Value): Value {
  return withSqliteBusyRetry(() => {
    database.exec('BEGIN IMMEDIATE');
    try {
      const value = operation();
      database.exec('COMMIT');
      return value;
    } catch (error) {
      try {
        database.exec('ROLLBACK');
      } catch {
        // Preserve the operation error.
      }
      throw error;
    }
  });
}

function pruneOrphanedRetentionMetadata(database: DatabaseSync, cutoffMs: number, nowMs: number): void {
  database
    .prepare(
      `DELETE FROM llm_process_runs WHERE process_run_id IN (
         SELECT run.process_run_id FROM llm_process_runs AS run
         WHERE run.clean_ended_at_ms IS NOT NULL
           AND run.clean_ended_at_ms < ?
           AND NOT EXISTS (
             SELECT 1 FROM llm_exchanges AS exchange WHERE exchange.process_run_id = run.process_run_id
           )
         ORDER BY run.clean_ended_at_ms ASC
         LIMIT ?
       )`,
    )
    .run(cutoffMs, MAX_DELETE_CHUNK_SIZE);
  database
    .prepare(
      `DELETE FROM llm_maintenance_leases WHERE lease_name IN (
         SELECT lease_name FROM llm_maintenance_leases
         WHERE expires_at_ms <= ?
         ORDER BY expires_at_ms ASC
         LIMIT ?
       )`,
    )
    .run(nowMs, MAX_DELETE_CHUNK_SIZE);
}

function beginDeleteBefore(
  database: DatabaseSync,
  data: SqliteWriterWorkerData,
  request: Extract<SqliteWorkerRequest, { kind: 'beginDeleteBefore' }>,
): SqliteDeleteLeaseResult {
  assertLlmMetricsSchemaCompatible(database, 'writer');
  const leaseName = requiredIdentifier(request.leaseName, 'maintenance lease name');
  const cutoffMs = boundedSafeInteger(request.cutoffMs, 0, Number.MAX_SAFE_INTEGER, 'delete cutoff');
  const leaseDurationMs = boundedSafeInteger(
    request.leaseDurationMs,
    MIN_MAINTENANCE_LEASE_MS,
    MAX_MAINTENANCE_LEASE_MS,
    'maintenance lease duration',
  );
  const requestedSnapshot =
    request.snapshotMaxSequence === undefined
      ? undefined
      : boundedSafeInteger(request.snapshotMaxSequence, 0, Number.MAX_SAFE_INTEGER, 'delete snapshot sequence');

  // A live lease can be observed through WAL without joining the write-lock
  // queue. This keeps a losing process cheap and avoids delaying its writer.
  const activeLease = database
    .prepare(
      'SELECT owner_id AS ownerId, expires_at_ms AS expiresAtMs FROM llm_maintenance_leases WHERE lease_name = ?',
    )
    .get(leaseName);
  if (
    activeLease !== undefined &&
    activeLease.ownerId !== data.processRunId &&
    asNumber(activeLease.expiresAtMs, 'maintenance lease expiry') > Date.now()
  ) {
    return { acquired: false, snapshotMaxSequence: null };
  }

  return withMaintenanceBusyTimeout(database, () =>
    immediateTransaction(database, () => {
      const now = Date.now();
      const expiresAtMs = boundedSafeInteger(
        now + leaseDurationMs,
        now,
        Number.MAX_SAFE_INTEGER,
        'maintenance lease expiry',
      );
      database
        .prepare(
          `INSERT INTO llm_maintenance_leases (lease_name, owner_id, expires_at_ms)
           VALUES (?, ?, ?)
           ON CONFLICT (lease_name) DO UPDATE SET
             owner_id = excluded.owner_id,
             expires_at_ms = excluded.expires_at_ms
           WHERE llm_maintenance_leases.expires_at_ms <= ?
              OR llm_maintenance_leases.owner_id = excluded.owner_id`,
        )
        .run(leaseName, data.processRunId, expiresAtMs, now);
      const lease = database
        .prepare('SELECT owner_id AS ownerId FROM llm_maintenance_leases WHERE lease_name = ?')
        .get(leaseName);
      if (lease?.ownerId !== data.processRunId) return { acquired: false, snapshotMaxSequence: null };

      pruneOrphanedRetentionMetadata(database, cutoffMs, now);

      const snapshot =
        requestedSnapshot ??
        database
          .prepare('SELECT MAX(ingestion_sequence) AS value FROM llm_exchanges WHERE completed_at_ms < ?')
          .get(cutoffMs)?.value;
      if (snapshot === null || snapshot === undefined) return { acquired: true, snapshotMaxSequence: null };
      return {
        acquired: true,
        snapshotMaxSequence: boundedSafeInteger(
          asNumber(snapshot, 'delete snapshot sequence'),
          0,
          Number.MAX_SAFE_INTEGER,
          'delete snapshot sequence',
        ),
      };
    }),
  );
}

function deleteBeforeChunk(
  database: DatabaseSync,
  data: SqliteWriterWorkerData,
  request: Extract<SqliteWorkerRequest, { kind: 'deleteBeforeChunk' }>,
): SqliteDeleteChunkResult {
  assertLlmMetricsSchemaCompatible(database, 'writer');
  const leaseName = requiredIdentifier(request.leaseName, 'maintenance lease name');
  const cutoffMs = boundedSafeInteger(request.cutoffMs, 0, Number.MAX_SAFE_INTEGER, 'delete cutoff');
  const snapshotMaxSequence = boundedSafeInteger(
    request.snapshotMaxSequence,
    1,
    Number.MAX_SAFE_INTEGER,
    'delete snapshot sequence',
  );
  const chunkSize = boundedSafeInteger(request.chunkSize, 1, MAX_DELETE_CHUNK_SIZE, 'delete chunk size');
  const leaseDurationMs = boundedSafeInteger(
    request.leaseDurationMs,
    MIN_MAINTENANCE_LEASE_MS,
    MAX_MAINTENANCE_LEASE_MS,
    'maintenance lease duration',
  );

  return withMaintenanceBusyTimeout(database, () =>
    immediateTransaction(database, () => {
      const now = Date.now();
      const expiresAtMs = boundedSafeInteger(
        now + leaseDurationMs,
        now,
        Number.MAX_SAFE_INTEGER,
        'maintenance lease expiry',
      );
      const renewed = database
        .prepare(
          `UPDATE llm_maintenance_leases SET expires_at_ms = ?
           WHERE lease_name = ? AND owner_id = ?`,
        )
        .run(expiresAtMs, leaseName, data.processRunId);
      if (Number(renewed.changes) !== 1) throw new Error('LLM metrics maintenance lease was lost');

      const deletion = database
        .prepare(
          `DELETE FROM llm_exchanges WHERE ingestion_sequence IN (
             SELECT ingestion_sequence FROM llm_exchanges
             WHERE completed_at_ms < ? AND ingestion_sequence <= ?
             ORDER BY ingestion_sequence ASC
             LIMIT ?
           )`,
        )
        .run(cutoffMs, snapshotMaxSequence, chunkSize);
      const remaining = database
        .prepare(
          `SELECT EXISTS(
             SELECT 1 FROM llm_exchanges
             WHERE completed_at_ms < ? AND ingestion_sequence <= ?
           ) AS value`,
        )
        .get(cutoffMs, snapshotMaxSequence)?.value;
      return {
        deleted: boundedSafeInteger(Number(deletion.changes), 0, chunkSize, 'deleted row count'),
        hasMore: asNumber(remaining, 'delete remaining indicator') === 1,
      };
    }),
  );
}

function releaseMaintenanceLease(
  database: DatabaseSync,
  data: SqliteWriterWorkerData,
  request: Extract<SqliteWorkerRequest, { kind: 'releaseMaintenanceLease' }>,
): void {
  assertLlmMetricsSchemaCompatible(database, 'writer');
  const leaseName = requiredIdentifier(request.leaseName, 'maintenance lease name');
  withMaintenanceBusyTimeout(database, () => {
    withSqliteBusyRetry(() =>
      database
        .prepare('DELETE FROM llm_maintenance_leases WHERE lease_name = ? AND owner_id = ?')
        .run(leaseName, data.processRunId),
    );
  });
}

interface PreparedExchange {
  readonly parameters: SqlParameters;
  readonly transportAttempts: readonly (readonly SQLInputValue[])[];
  readonly gatewayAttempts: readonly (readonly SQLInputValue[])[];
}

/** Validates one record completely, before any transaction opens. Throws when it is invalid. */
function prepareExchange(exchange: LlmExchangeCompleted, processRunId: string): PreparedExchange {
  const parameters = exchangeParameters(exchange, processRunId);
  const exchangeId = requiredIdentifier(exchange.exchangeId, 'exchangeId');
  if (exchange.transportAttempts.length > MAX_ATTEMPTS) throw new Error('Too many transport attempts');
  if (exchange.gatewayRouteAttempts.length > MAX_ATTEMPTS) throw new Error('Too many gateway attempts');
  return {
    parameters,
    transportAttempts: exchange.transportAttempts.map((attempt) => [
      exchangeId,
      safeTokenCount(attempt.ordinal, 'transport attempt ordinal'),
      safeOffset(attempt.startedOffsetMs, 'transport attempt start'),
      safeOffset(attempt.endedOffsetMs, 'transport attempt end'),
      optionalHttpStatus(attempt.responseStatus, 'transport attempt status'),
      enumValue(attempt.outcome, TRANSPORT_OUTCOMES, 'transport attempt outcome'),
    ]),
    gatewayAttempts: exchange.gatewayRouteAttempts.map((attempt) => [
      exchangeId,
      safeTokenCount(attempt.ordinal, 'gateway attempt ordinal'),
      optionalProviderIdentifier(attempt.provider, 'gateway provider'),
      optionalIdentifier(attempt.model, 'gateway model'),
      optionalHttpStatus(attempt.status, 'gateway attempt status'),
      optionalBoolean(attempt.selected),
      enumValue(attempt.source, GATEWAY_ATTEMPT_SOURCES, 'gateway attempt source'),
    ]),
  };
}

/** Validation and constraint messages name fields, never record values; still bound them. */
function rejectionReason(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const reason = message
    .replace(/\p{Cc}+/gu, ' ')
    .trim()
    .substring(0, MAX_REJECTION_REASON_LENGTH);
  return reason.length > 0 ? reason : 'Invalid record';
}

function countRejection(rejected: Map<string, number>, error: unknown): void {
  const reason = rejectionReason(error);
  rejected.set(reason, (rejected.get(reason) ?? 0) + 1);
}

/**
 * Writes one batch in one transaction. Each record is validated before the
 * transaction and inserted inside its own savepoint, so an invalid record or a
 * constraint failure on one record's rows drops that record alone, counted by
 * reason. Storage failures (busy after the bounded retries, I/O, full, corrupt)
 * still abort the whole batch; the repository decides whether to requeue it.
 */
function insertBatch(
  database: DatabaseSync,
  processRunId: string,
  exchanges: readonly LlmExchangeCompleted[],
): SqliteInsertResult {
  assertLlmMetricsSchemaCompatible(database, 'writer');
  const rejected = new Map<string, number>();
  const prepared: PreparedExchange[] = [];
  for (const exchange of exchanges) {
    try {
      prepared.push(prepareExchange(exchange, processRunId));
    } catch (error) {
      countRejection(rejected, error);
    }
  }
  if (prepared.length === 0) return { inserted: 0, duplicates: 0, rejected: Object.fromEntries(rejected) };

  const insertExchange = database.prepare(INSERT_EXCHANGE_SQL);
  const insertTransportAttempt = database.prepare(
    `INSERT INTO llm_transport_attempts
      (exchange_id, ordinal, started_offset_ms, ended_offset_ms, status_code, outcome)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertGatewayAttempt = database.prepare(
    `INSERT INTO llm_gateway_route_attempts
      (exchange_id, ordinal, provider, model, status_code, selected, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const written = immediateTransaction(database, () => {
    let inserted = 0;
    let duplicates = 0;
    const refused = new Map<string, number>();
    for (const record of prepared) {
      database.exec('SAVEPOINT llm_exchange_record');
      try {
        const result = insertExchange.run(record.parameters);
        const changes = typeof result.changes === 'bigint' ? Number(result.changes) : result.changes;
        if (changes === 0) {
          duplicates++;
        } else {
          for (const values of record.transportAttempts) insertTransportAttempt.run(...values);
          for (const values of record.gatewayAttempts) insertGatewayAttempt.run(...values);
          inserted++;
        }
        database.exec('RELEASE llm_exchange_record');
      } catch (error) {
        // A storage failure may already have rolled the transaction back;
        // let immediateTransaction abort the batch.
        if (!isRecordScopedSqliteError(error)) throw error;
        database.exec('ROLLBACK TO llm_exchange_record');
        database.exec('RELEASE llm_exchange_record');
        countRejection(refused, error);
      }
    }
    return { inserted, duplicates, refused };
  });
  for (const [reason, count] of written.refused) rejected.set(reason, (rejected.get(reason) ?? 0) + count);
  return { inserted: written.inserted, duplicates: written.duplicates, rejected: Object.fromEntries(rejected) };
}

function checkpoint(
  database: DatabaseSync,
  data: SqliteWriterWorkerData,
  request: Extract<SqliteWorkerRequest, { kind: 'checkpoint' }>,
): void {
  withSqliteBusyRetry(() =>
    database
      .prepare(
        `UPDATE llm_process_runs SET
          last_checkpoint_at_ms = ?, observed_count = ?, finalized_count = ?, enqueued_count = ?
         WHERE process_run_id = ?`,
      )
      .run(request.checkpointAtMs, request.observed, request.finalized, request.enqueued, data.processRunId),
  );
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown SQLite worker error';
  return message.substring(0, 500);
}

/** A writer failure, classified so the repository can requeue, restart, or latch persistence off. */
function writerErrorResponse(error: unknown, id?: number): SqliteWorkerResponse {
  const code = classifyStorageError(error);
  return {
    kind: 'error',
    ...(id === undefined ? {} : { id }),
    message: errorMessage(error),
    ...(code === undefined ? {} : { code }),
  };
}

function startWriterWorker(data: SqliteWriterWorkerData): void {
  if (parentPort === null) throw new Error('SQLite metrics worker has no parent port');
  const port = parentPort;
  let database: DatabaseSync;
  try {
    const initialized = initializeWriter(data);
    database = initialized.database;
    port.postMessage({ kind: 'ready', schemaVersion: initialized.schemaVersion } satisfies SqliteWorkerResponse);
  } catch (error) {
    port.postMessage(writerErrorResponse(error));
    return;
  }

  let chain = Promise.resolve();
  port.on('message', (request: SqliteWriterWorkerRequest) => {
    chain = chain.then(() => {
      try {
        let value: Extract<SqliteWorkerResponse, { kind: 'result' }>['value'];
        switch (request.kind) {
          case 'insert':
            value = insertBatch(database, data.processRunId, request.exchanges);
            break;
          case 'beginDeleteBefore':
            value = beginDeleteBefore(database, data, request);
            break;
          case 'deleteBeforeChunk':
            value = deleteBeforeChunk(database, data, request);
            break;
          case 'releaseMaintenanceLease':
            releaseMaintenanceLease(database, data, request);
            value = null;
            break;
          case 'checkpoint':
            checkpoint(database, data, request);
            value = null;
            break;
          case 'close':
            checkpoint(database, data, {
              id: request.id,
              kind: 'checkpoint',
              observed: request.observed,
              finalized: request.finalized,
              enqueued: request.enqueued,
              checkpointAtMs: request.cleanEndedAtMs,
            });
            withSqliteBusyRetry(() =>
              database
                .prepare('UPDATE llm_process_runs SET clean_ended_at_ms = ? WHERE process_run_id = ?')
                .run(request.cleanEndedAtMs, data.processRunId),
            );
            database.close();
            value = null;
            break;
          default:
            throw new Error('Invalid SQLite metrics writer request');
        }
        port.postMessage({ kind: 'result', id: request.id, value } satisfies SqliteWorkerResponse);
      } catch (error) {
        port.postMessage(writerErrorResponse(error, request.id));
      }
    });
  });
}

function readerErrorResponse(id: number, error: unknown): SqliteWorkerResponse {
  if (isStatisticsLimitError(error)) {
    return {
      kind: 'error',
      id,
      message: errorMessage(error),
      category: 'limit',
      limit: { name: error.limit, maximum: error.maximum },
    };
  }
  return {
    kind: 'error',
    id,
    message: errorMessage(error),
    category: error instanceof StatisticsQueryValidationError ? 'invalid_request' : 'unavailable',
  };
}

function startReaderWorker(data: SqliteReaderWorkerData): void {
  if (parentPort === null) throw new Error('SQLite metrics worker has no parent port');
  const port = parentPort;
  let database: DatabaseSync;
  try {
    const initialized = initializeReader(data);
    database = initialized.database;
    port.postMessage({ kind: 'ready', schemaVersion: initialized.schemaVersion } satisfies SqliteWorkerResponse);
  } catch (error) {
    port.postMessage({ kind: 'error', message: errorMessage(error) } satisfies SqliteWorkerResponse);
    return;
  }

  let chain = Promise.resolve();
  port.on('message', (request: SqliteReaderWorkerRequest) => {
    chain = chain.then(() => {
      try {
        let value: Extract<SqliteWorkerResponse, { kind: 'result' }>['value'];
        switch (request.kind) {
          case 'snapshotMaxSequence': {
            const row = database
              .prepare('SELECT COALESCE(MAX(ingestion_sequence), 0) AS value FROM llm_exchanges')
              .get();
            value = asNumber(row?.value, 'snapshot sequence');
            break;
          }
          case 'scan':
            value = scan(database, request.query);
            break;
          case 'dimensionValues':
            value = dimensionValues(database, request.dimension, request.query);
            break;
          case 'aggregate':
            value = aggregateStatistics(database, request.query);
            break;
          case 'distribution':
            value = distributionStatistics(database, request.query);
            break;
          case 'sessionTotals':
            value = sessionTotalsStatistics(database, request.query);
            break;
          default:
            throw new Error('Invalid SQLite metrics reader request');
        }
        port.postMessage({ kind: 'result', id: request.id, value } satisfies SqliteWorkerResponse);
      } catch (error) {
        port.postMessage(readerErrorResponse(request.id, error));
      }
    });
  });
}

function startWorker(data: SqliteWorkerData): void {
  if (data.role === 'reader') startReaderWorker(data);
  else startWriterWorker(data);
}

if (!isMainThread) {
  startWorker(workerData as SqliteWorkerData);
}
