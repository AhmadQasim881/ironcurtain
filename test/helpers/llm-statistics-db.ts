/**
 * Seeds a migrated LLM statistics database directly (one transaction), so
 * query tests can work with tens of thousands of rows in about a second.
 * Rows bypass the writer's record validation: tests control their content.
 */

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { migrateLlmMetricsDatabase } from '../../src/llm-metrics/persistence/migrations.js';
import type { StoredLlmExchange } from '../../src/llm-metrics/persistence/repository.js';

export type StatisticsTestRow = StoredLlmExchange;

let generated = 0;

/**
 * A complete, valid row; override only what a test is about. Unless a test
 * sets `costSource`, it names the column that holds the row's cost, as the
 * writer stores it: the gateway-reported `costUsd`, else the list-price
 * `estimatedCostUsd`.
 */
export function statisticsRow(overrides: Partial<StoredLlmExchange> = {}): StatisticsTestRow {
  generated += 1;
  const completedAtMs = overrides.completedAtMs ?? Date.parse('2026-08-15T12:00:00.000Z');
  const row: StatisticsTestRow = {
    exchangeId: `exchange-${generated}`,
    schemaVersion: 1,
    completedAtMs,
    requestReceivedAtMs: completedAtMs - 1_000,
    sessionId: 'session-1',
    turnId: null,
    agentConversationId: null,
    bundleId: null,
    workflowRunId: null,
    stateId: null,
    personaId: null,
    attributionQuality: 'exact',
    agent: 'claude-code',
    logicalProvider: 'anthropic',
    providerProfile: null,
    protocol: 'anthropic-messages',
    gateway: 'direct',
    clientRouteId: null,
    upstreamRouteId: null,
    requestedModel: 'model-1',
    forwardedModel: 'model-1',
    responseModel: 'model-1',
    servedModel: 'model-1',
    servedModelSource: 'protocol_response_direct',
    servedProvider: 'Anthropic',
    servedProviderSource: 'configured_route',
    providerRequestId: null,
    providerResponseId: null,
    gatewayGenerationId: null,
    streaming: true,
    requestedServiceTier: null,
    actualServiceTier: null,
    reasoningMode: 'enabled',
    reasoningEffort: null,
    thinkingBudgetTokens: null,
    speedMode: null,
    responseStatus: 200,
    outcome: 'stop',
    providerStopReason: 'end_turn',
    refusal: false,
    refusalCategory: null,
    inputTokensReported: 10,
    inputTokens: 10,
    uncachedInputTokens: 8,
    cacheReadInputTokens: 2,
    cacheWriteInputTokens: 0,
    toolUseInputTokens: 0,
    outputTokensReported: 5,
    outputTokens: 5,
    thinkingTokens: 2,
    nonThinkingOutputTokens: 3,
    providerTotalTokens: 15,
    totalTokens: 15,
    costUsd: 0.001,
    estimatedCostUsd: null,
    costSource: null,
    pricingVersion: null,
    usageCompleteness: 'complete',
    usageSemanticsVersion: 1,
    inputMeasurementProvenance: 'reported_exact',
    outputMeasurementProvenance: 'reported_exact',
    thinkingMeasurementProvenance: 'reported_exact',
    nonThinkingMeasurementProvenance: 'derived_exact',
    requestBodyCompleteOffsetMs: 1,
    responseHeadersOffsetMs: 5,
    firstUpstreamBodyByteOffsetMs: 6,
    firstProtocolEventOffsetMs: 7,
    firstReasoningOffsetMs: 10,
    lastReasoningOffsetMs: 15,
    firstOutputOffsetMs: 20,
    lastOutputOffsetMs: 40,
    protocolTerminalOffsetMs: 45,
    upstreamResponseEndOffsetMs: 50,
    clientDeliveryEndOffsetMs: 60,
    clientAborted: false,
    qualityFlags: [],
    ...overrides,
  };
  if (overrides.costSource !== undefined) return row;
  return {
    ...row,
    costSource: row.costUsd !== null ? 'gateway_reported' : row.estimatedCostUsd !== null ? 'list_price' : null,
  };
}

const COLUMNS: readonly [column: string, value: (row: StatisticsTestRow) => string | number | null][] = [
  ['exchange_id', (row) => row.exchangeId],
  ['schema_version', (row) => row.schemaVersion],
  ['completed_at_ms', (row) => row.completedAtMs],
  ['request_received_at_ms', (row) => row.requestReceivedAtMs],
  ['session_id', (row) => row.sessionId],
  ['turn_id', (row) => row.turnId],
  ['agent_conversation_id', (row) => row.agentConversationId],
  ['bundle_id', (row) => row.bundleId],
  ['workflow_run_id', (row) => row.workflowRunId],
  ['state_id', (row) => row.stateId],
  ['persona_id', (row) => row.personaId],
  ['attribution_quality', (row) => row.attributionQuality],
  ['agent_name', (row) => row.agent],
  ['logical_provider', (row) => row.logicalProvider],
  ['provider_profile_id', (row) => row.providerProfile],
  ['protocol', (row) => row.protocol],
  ['gateway_kind', (row) => row.gateway],
  ['client_route_id', (row) => row.clientRouteId],
  ['upstream_route_id', (row) => row.upstreamRouteId],
  ['requested_model', (row) => row.requestedModel],
  ['requested_model_source', () => 'request'],
  ['forwarded_model', (row) => row.forwardedModel],
  ['forwarded_model_source', () => 'forwarded_request'],
  ['response_model', (row) => row.responseModel],
  ['response_model_source', () => 'protocol_response'],
  ['served_model', (row) => row.servedModel],
  ['served_model_source', (row) => row.servedModelSource],
  ['served_provider', (row) => row.servedProvider],
  ['served_provider_source', (row) => row.servedProviderSource],
  ['provider_request_id', (row) => row.providerRequestId],
  ['provider_response_id', (row) => row.providerResponseId],
  ['gateway_generation_id', (row) => row.gatewayGenerationId],
  ['streaming', (row) => (row.streaming === null ? null : row.streaming ? 1 : 0)],
  ['requested_service_tier', (row) => row.requestedServiceTier],
  ['actual_service_tier', (row) => row.actualServiceTier],
  ['reasoning_mode', (row) => row.reasoningMode],
  ['reasoning_effort', (row) => row.reasoningEffort],
  ['thinking_budget_tokens', (row) => row.thinkingBudgetTokens],
  ['speed_mode', (row) => row.speedMode],
  ['response_status_code', (row) => row.responseStatus],
  ['termination_category', (row) => row.outcome],
  ['provider_stop_reason', (row) => row.providerStopReason],
  ['refusal', (row) => (row.refusal === null ? null : row.refusal ? 1 : 0)],
  ['refusal_category', (row) => row.refusalCategory],
  ['outcome_source', () => 'not_reported'],
  ['input_tokens_reported', (row) => row.inputTokensReported],
  ['input_tokens_total', (row) => row.inputTokens],
  ['input_tokens_uncached', (row) => row.uncachedInputTokens],
  ['cache_read_input_tokens', (row) => row.cacheReadInputTokens],
  ['cache_write_input_tokens', (row) => row.cacheWriteInputTokens],
  ['tool_use_input_tokens', (row) => row.toolUseInputTokens],
  ['output_tokens_reported', (row) => row.outputTokensReported],
  ['output_token_semantics', () => 'includes_thinking'],
  ['output_tokens_total', (row) => row.outputTokens],
  ['thinking_tokens', (row) => row.thinkingTokens],
  ['non_thinking_output_tokens', (row) => row.nonThinkingOutputTokens],
  ['provider_total_tokens', (row) => row.providerTotalTokens],
  ['canonical_total_tokens', (row) => row.totalTokens],
  ['cost_usd', (row) => row.costUsd],
  ['estimated_cost_usd', (row) => row.estimatedCostUsd],
  ['cost_source', (row) => row.costSource],
  ['pricing_version', (row) => row.pricingVersion],
  ['usage_source', () => 'test'],
  ['usage_completeness', (row) => row.usageCompleteness],
  ['usage_semantics_version', (row) => row.usageSemanticsVersion],
  ['input_measurement_provenance', (row) => row.inputMeasurementProvenance],
  ['output_measurement_provenance', (row) => row.outputMeasurementProvenance],
  ['thinking_measurement_provenance', (row) => row.thinkingMeasurementProvenance],
  ['non_thinking_measurement_provenance', (row) => row.nonThinkingMeasurementProvenance],
  ['request_body_complete_offset_ms', (row) => row.requestBodyCompleteOffsetMs],
  ['response_headers_offset_ms', (row) => row.responseHeadersOffsetMs],
  ['first_upstream_body_byte_offset_ms', (row) => row.firstUpstreamBodyByteOffsetMs],
  ['first_protocol_event_offset_ms', (row) => row.firstProtocolEventOffsetMs],
  ['first_reasoning_offset_ms', (row) => row.firstReasoningOffsetMs],
  ['last_reasoning_offset_ms', (row) => row.lastReasoningOffsetMs],
  ['first_output_offset_ms', (row) => row.firstOutputOffsetMs],
  ['last_output_offset_ms', (row) => row.lastOutputOffsetMs],
  ['protocol_terminal_offset_ms', (row) => row.protocolTerminalOffsetMs],
  ['upstream_response_end_offset_ms', (row) => row.upstreamResponseEndOffsetMs],
  ['client_delivery_end_offset_ms', (row) => row.clientDeliveryEndOffsetMs],
  ['client_delivery_status', (row) => (row.clientAborted ? 'aborted' : 'finished')],
  ['quality_flags_json', (row) => JSON.stringify(row.qualityFlags)],
  ['process_run_id', () => 'test-process-run'],
];

export interface StatisticsTestDatabase {
  readonly directory: string;
  readonly databasePath: string;
  insert(rows: readonly StatisticsTestRow[]): void;
  remove(): void;
}

/** A migrated, WAL-mode database under a fresh temporary directory. */
export function createStatisticsTestDatabase(prefix = 'ironcurtain-statistics-'): StatisticsTestDatabase {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const statisticsDirectory = join(directory, 'statistics');
  mkdirSync(statisticsDirectory, { mode: 0o700 });
  const databasePath = join(statisticsDirectory, 'llm-usage.sqlite3');
  const database = new DatabaseSync(databasePath);
  try {
    migrateLlmMetricsDatabase(database);
    database.exec('PRAGMA journal_mode = WAL');
    database
      .prepare(
        `INSERT INTO llm_process_runs (process_run_id, started_at_ms, last_checkpoint_at_ms, clean_ended_at_ms)
         VALUES ('test-process-run', 0, 0, 1)`,
      )
      .run();
  } finally {
    database.close();
  }
  return {
    directory,
    databasePath,
    insert(rows) {
      const writer = new DatabaseSync(databasePath);
      try {
        const statement = writer.prepare(
          `INSERT INTO llm_exchanges (${COLUMNS.map(([column]) => column).join(', ')}) VALUES (${COLUMNS.map(
            () => '?',
          ).join(', ')})`,
        );
        writer.exec('BEGIN');
        for (const row of rows) statement.run(...COLUMNS.map(([, value]) => value(row)));
        writer.exec('COMMIT');
      } finally {
        writer.close();
      }
    },
    remove() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
