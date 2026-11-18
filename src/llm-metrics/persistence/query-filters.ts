/**
 * Identifier validation and the parameterized WHERE builder shared by the
 * SQLite writer (record validation) and reader (query validation).
 *
 * Loaded inside the persistence worker through native type stripping, so it
 * must stay self-contained, erasable TypeScript.
 */

import type { SQLInputValue } from 'node:sqlite';

import type { LlmExchangeFilters, LlmStatisticsDimension, LlmStatisticsDimensionValue } from './repository.js';
import {
  MAX_STATISTICS_FILTER_VALUES,
  STATISTICS_IDENTIFIER_MAX_LENGTH,
  STATISTICS_IDENTIFIER_PATTERN,
  STATISTICS_PROVIDER_IDENTIFIER_MAX_LENGTH,
  STATISTICS_PROVIDER_IDENTIFIER_PATTERN,
} from '../query-contract.js';

/** Column behind every filter and grouping dimension. Values are fixed SQL identifiers, never input. */
export const FILTER_COLUMNS: Readonly<Record<keyof LlmExchangeFilters, string>> = {
  agent: 'agent_name',
  logicalProvider: 'logical_provider',
  gateway: 'gateway_kind',
  protocol: 'protocol',
  providerProfile: 'provider_profile_id',
  requestedModel: 'requested_model',
  forwardedModel: 'forwarded_model',
  responseModel: 'response_model',
  servedModel: 'served_model',
  servedProvider: 'served_provider',
  reasoningMode: 'reasoning_mode',
  requestedServiceTier: 'requested_service_tier',
  actualServiceTier: 'actual_service_tier',
  inputMeasurementProvenance: 'input_measurement_provenance',
  outputMeasurementProvenance: 'output_measurement_provenance',
  thinkingMeasurementProvenance: 'thinking_measurement_provenance',
  nonThinkingMeasurementProvenance: 'non_thinking_measurement_provenance',
  speedMode: 'speed_mode',
  streaming: 'streaming',
  outcome: 'termination_category',
  refusal: 'refusal',
  usageCompleteness: 'usage_completeness',
  attributionQuality: 'attribution_quality',
  sessionId: 'session_id',
  workflowRunId: 'workflow_run_id',
  stateId: 'state_id',
  personaId: 'persona_id',
  bundleId: 'bundle_id',
};

export const DIMENSION_COLUMNS: Readonly<Record<LlmStatisticsDimension, string>> = FILTER_COLUMNS;

/** A rejected query: reported to the caller without retiring the reader. */
export class StatisticsQueryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StatisticsQueryValidationError';
  }
}

export function invalidQuery(message: string): never {
  throw new StatisticsQueryValidationError(message);
}

export function requiredIdentifier(value: string, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length > STATISTICS_IDENTIFIER_MAX_LENGTH ||
    !STATISTICS_IDENTIFIER_PATTERN.test(value)
  ) {
    throw new Error(`Invalid ${field}`);
  }
  return value;
}

export function optionalProviderIdentifier(value: string | null, field: string): string | null {
  if (value === null) return null;
  if (
    typeof value !== 'string' ||
    value.length > STATISTICS_PROVIDER_IDENTIFIER_MAX_LENGTH ||
    !STATISTICS_PROVIDER_IDENTIFIER_PATTERN.test(value)
  ) {
    throw new Error(`Invalid ${field}`);
  }
  return value;
}

export function queryIdentifier(value: string, field: string): string {
  try {
    return requiredIdentifier(value, field);
  } catch {
    return invalidQuery(`Invalid ${field}`);
  }
}

function queryProviderIdentifier(value: string, field: string): string {
  try {
    return optionalProviderIdentifier(value, field) ?? invalidQuery(`Invalid ${field}`);
  } catch (error) {
    if (error instanceof StatisticsQueryValidationError) throw error;
    return invalidQuery(`Invalid ${field}`);
  }
}

export function isBooleanDimension(dimension: LlmStatisticsDimension): boolean {
  return dimension === 'streaming' || dimension === 'refusal';
}

/** Map a stored grouping value back to its DTO form (booleans are stored as 0/1). */
export function decodeDimensionValue(dimension: LlmStatisticsDimension, value: unknown): LlmStatisticsDimensionValue {
  if (value === null) return null;
  if (isBooleanDimension(dimension)) {
    if (value === 0 || value === 1) return value === 1;
    throw new Error('Invalid boolean dimension value');
  }
  if (typeof value !== 'string') throw new Error('Invalid stored dimension value');
  return value;
}

/**
 * Validated, fully parameterized time-range and filter predicates. Filter
 * names select a fixed column; filter values are bound, never interpolated.
 */
export function appendFilters(
  query: { readonly fromMs: number; readonly toMs: number; readonly filters?: LlmExchangeFilters },
  params: SQLInputValue[],
): string[] {
  if (!Number.isSafeInteger(query.fromMs) || !Number.isSafeInteger(query.toMs) || query.fromMs > query.toMs) {
    invalidQuery('Invalid query time range');
  }
  const clauses = ['completed_at_ms >= ?', 'completed_at_ms <= ?'];
  params.push(query.fromMs, query.toMs);

  for (const [filter, values] of Object.entries(query.filters ?? {}) as [
    keyof LlmExchangeFilters,
    readonly (string | boolean)[],
  ][]) {
    const untrustedValues: unknown = values;
    if (!Array.isArray(untrustedValues)) invalidQuery(`Invalid ${filter} filter values`);
    const filterValues = untrustedValues as readonly unknown[];
    if (filterValues.length === 0) continue;
    if (filterValues.length > MAX_STATISTICS_FILTER_VALUES) invalidQuery(`Too many ${filter} filter values`);
    if (!Object.hasOwn(FILTER_COLUMNS, filter)) invalidQuery('Invalid statistics filter');
    const column = FILTER_COLUMNS[filter];
    clauses.push(`${column} IN (${filterValues.map(() => '?').join(', ')})`);
    for (const value of filterValues) {
      if (typeof value !== 'string' && typeof value !== 'boolean') {
        invalidQuery(`Invalid ${filter} filter value`);
      }
      params.push(
        typeof value === 'boolean'
          ? value
            ? 1
            : 0
          : filter === 'servedProvider'
            ? queryProviderIdentifier(value, `${filter} filter`)
            : queryIdentifier(value, `${filter} filter`),
      );
    }
  }
  return clauses;
}
