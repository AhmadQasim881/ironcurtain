import type { ResourceBudgetConfigDto, WorkflowBudgetDto, WorkflowUsageDto } from '../src/lib/types.js';

/** Canned run-wide usage: a lower bound (one exchange not measured in full). */
export function buildRunUsage(totalTokens: number): WorkflowUsageDto {
  const outputTokens = Math.round(totalTokens * 0.08);
  return {
    inputTokens: totalTokens - outputTokens,
    cacheReadTokens: Math.round(totalTokens * 0.6),
    cacheWriteTokens: Math.round(totalTokens * 0.05),
    outputTokens,
    totalTokens,
    estimatedCostUsd: 17,
    gateOnlyTokens: 0,
    gateOnlyCostUsd: 0,
    activeSeconds: 2_400,
    observedExchanges: 48,
    incompleteExchanges: 1,
    unmeasuredExchanges: 0,
    meteredSessions: 6,
    reportedSessions: 0,
    untrackedSessions: 0,
    uncountedSessions: 0,
    lowerBound: true,
    tokenTrackingStatus: 'partial',
  };
}

export type ResourceBudgetFixture = ResourceBudgetConfigDto;
export type WorkflowBudgetFixture = WorkflowBudgetDto;

export type WorkflowBudgetScenario = 'normal' | 'no-usage' | 'legacy';

export const DEFAULT_RESOURCE_BUDGET: ResourceBudgetFixture = {
  maxTotalTokens: 1_000_000,
  maxSteps: 200,
  maxSessionSeconds: 1800,
  maxEstimatedCostUsd: 5,
  warnThresholdPercent: 80,
};

export function validateResourceBudget(value: Record<string, unknown>): boolean {
  const keys = Object.keys(DEFAULT_RESOURCE_BUDGET) as (keyof ResourceBudgetFixture)[];
  if (Object.keys(value).some((key) => !keys.includes(key as keyof ResourceBudgetFixture))) return false;
  return keys.every((key) => {
    const field = value[key];
    if (key === 'warnThresholdPercent') {
      return typeof field === 'number' && Number.isFinite(field) && field >= 1 && field <= 99;
    }
    if (field === null) return true;
    if (typeof field !== 'number' || !Number.isFinite(field) || field <= 0) return false;
    return key !== 'maxTotalTokens' && key !== 'maxSteps' ? true : Number.isSafeInteger(field);
  });
}

/** Simulate two bundled YAML overrides, plus inheritance for custom definitions. */
export function buildBudgetPreview(
  definitionPath: string,
  globalLimits: ResourceBudgetFixture,
  globalConfigured: boolean,
): WorkflowBudgetFixture {
  const limits = { ...globalLimits };
  const sources = Object.fromEntries(
    Object.keys(limits).map((key) => [key, globalConfigured ? 'global' : 'default']),
  ) as WorkflowBudgetFixture['sources'];
  if (definitionPath.includes('design-and-code')) {
    limits.maxEstimatedCostUsd = 20;
    limits.maxSessionSeconds = 21_600;
    sources.maxEstimatedCostUsd = 'workflow';
    sources.maxSessionSeconds = 'workflow';
  } else if (definitionPath.includes('code-review')) {
    for (const key of ['maxTotalTokens', 'maxSteps', 'maxSessionSeconds', 'maxEstimatedCostUsd'] as const) {
      limits[key] = null;
      sources[key] = 'workflow';
    }
  }
  return { limits, sources, recorded: true };
}

export function buildRunBudget(
  name: string,
  globalLimits: ResourceBudgetFixture,
  globalConfigured: boolean,
  scenario: WorkflowBudgetScenario = 'normal',
): WorkflowBudgetFixture {
  const budget = buildBudgetPreview(name, globalLimits, globalConfigured);
  if (scenario === 'legacy') return { ...budget, recorded: false };
  if (scenario === 'no-usage' || name.includes('code-review')) return budget;
  return {
    ...budget,
    usage: {
      totalTokens: 850_000,
      stepCount: 170,
      elapsedSeconds: 1200,
      estimatedCostUsd: 17,
      tokenTrackingAvailable: true,
      tokenTrackingStatus: 'complete',
      observedExchanges: 12,
      incompleteExchanges: 0,
    },
    // A run ceiling (settings.workflowBudget) and the whole-run totals it is checked against.
    workflowLimits: { maxEstimatedCostUsd: 20, maxWallClockSeconds: 14_400 },
    workflowUsage: buildRunUsage(2_150_000),
  };
}
