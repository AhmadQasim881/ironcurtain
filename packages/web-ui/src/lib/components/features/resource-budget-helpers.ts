import type { ResourceBudgetConfigDto, WorkflowBudgetDto, WorkflowUsageDto } from '$lib/types.js';
import {
  formatDuration,
  formatTrackedTokens,
  formatWorkflowTokens,
  NO_EXCHANGES_OBSERVED_YET,
} from './usage-format.js';

export type LimitKey = Exclude<keyof ResourceBudgetConfigDto, 'warnThresholdPercent'>;
export const BUDGET_LIMITS: readonly { key: LimitKey; label: string; hint: string; unit: string; integer: boolean }[] =
  [
    { key: 'maxEstimatedCostUsd', label: 'Estimated cost', hint: 'Recovery threshold', unit: 'USD', integer: false },
    { key: 'maxTotalTokens', label: 'Tokens', hint: 'Turn / recovery threshold', unit: 'tokens', integer: true },
    { key: 'maxSteps', label: 'Steps', hint: 'Turn / recovery threshold', unit: 'steps', integer: true },
    { key: 'maxSessionSeconds', label: 'Turn timeout', hint: 'Per agent turn', unit: 'seconds', integer: false },
  ];

export function formatLimit(key: LimitKey, value: number): string {
  if (key === 'maxEstimatedCostUsd') return `$${value.toFixed(2)}`;
  if (key === 'maxSessionSeconds') return `${value.toLocaleString()}s`;
  return value.toLocaleString();
}

export function budgetUsage(budget: WorkflowBudgetDto, key: LimitKey): number | undefined {
  const usage = budget.usage;
  if (!usage) return undefined;
  if (key === 'maxTotalTokens' && !usage.tokenTrackingAvailable) return undefined;
  if (key === 'maxEstimatedCostUsd') {
    // A session that says nothing reported a cost has unknown, not zero, spend.
    if (usage.costSource === 'unknown') return undefined;
    // Container adapters can report cost independently of token tracking.
    // Without either signal (older runs carry no costSource), zero is an
    // unknown lower bound, not zero spend.
    return !usage.tokenTrackingAvailable && usage.estimatedCostUsd === 0 ? undefined : usage.estimatedCostUsd;
  }
  if (key === 'maxTotalTokens') return usage.totalTokens;
  if (key === 'maxSteps') return usage.stepCount;
  // Session age cannot be compared with a timeout that restarts each turn.
  return undefined;
}

export function limitProgress(usage: number | undefined, limit: number | null): number | undefined {
  return usage === undefined || limit === null || limit <= 0 ? undefined : (usage / limit) * 100;
}

/**
 * "<value> used" for a sampled session's usage. A token total that is a lower
 * bound (`partial` tracking) is marked `≥`, never shown as exact.
 */
export function formatBudgetUsage(budget: WorkflowBudgetDto, key: LimitKey, used: number | undefined): string {
  if (used === undefined) return 'Usage unavailable';
  if (key === 'maxTotalTokens' && budget.usage) {
    const tokens = formatTrackedTokens(used, budget.usage);
    if (tokens === NO_EXCHANGES_OBSERVED_YET) return tokens;
    if (tokens !== undefined) return `${tokens} used`;
  }
  return `${formatLimit(key, used)} used`;
}

// ---------------------------------------------------------------------------
// Run-wide ceiling (settings.workflowBudget)
// ---------------------------------------------------------------------------

export type RunLimitKey = 'maxTotalTokens' | 'maxEstimatedCostUsd' | 'maxWallClockSeconds';

export const RUN_LIMITS: readonly { key: RunLimitKey; label: string }[] = [
  { key: 'maxEstimatedCostUsd', label: 'Estimated cost' },
  { key: 'maxTotalTokens', label: 'Tokens' },
  { key: 'maxWallClockSeconds', label: 'Running time' },
];

export function formatRunValue(key: RunLimitKey, value: number): string {
  if (key === 'maxEstimatedCostUsd') return `$${value.toFixed(2)}`;
  if (key === 'maxWallClockSeconds') return formatDuration(value);
  return value.toLocaleString();
}

/** The run's ceiling for `key`, or null when the workflow sets none. */
export function runLimit(budget: WorkflowBudgetDto, key: RunLimitKey): number | null {
  const value = budget.workflowLimits?.[key];
  return typeof value === 'number' && value > 0 ? value : null;
}

/** Run-wide usage for `key`; undefined when tokens could not be observed. */
export function runUsage(usage: WorkflowUsageDto, key: RunLimitKey): number | undefined {
  if (key === 'maxTotalTokens') return usage.tokenTrackingStatus === 'unavailable' ? undefined : usage.totalTokens;
  if (key === 'maxEstimatedCostUsd') return usage.estimatedCostUsd;
  return usage.activeSeconds;
}

export function formatRunUsage(usage: WorkflowUsageDto, key: RunLimitKey): string {
  if (key === 'maxTotalTokens') return formatWorkflowTokens(usage).value;
  const value = runUsage(usage, key);
  return value === undefined ? 'Unavailable' : formatRunValue(key, value);
}

/** Highest percentage of any run-wide ceiling used, for the panel's warning badge. */
export function highestRunProgress(budget: WorkflowBudgetDto): number {
  const usage = budget.workflowUsage;
  if (!usage) return 0;
  return Math.max(0, ...RUN_LIMITS.map(({ key }) => limitProgress(runUsage(usage, key), runLimit(budget, key)) ?? 0));
}

export function parseResourceBudget(
  values: Record<LimitKey, string>,
  disabled: Record<LimitKey, boolean>,
  warning: string,
): ResourceBudgetConfigDto {
  const limits = {} as Record<LimitKey, number | null>;
  for (const { key, label, integer } of BUDGET_LIMITS) {
    if (disabled[key]) {
      limits[key] = null;
      continue;
    }
    const value = Number(values[key]);
    if (!values[key].trim() || !Number.isFinite(value) || value <= 0 || (integer && !Number.isSafeInteger(value))) {
      throw new Error(`${label} must be a positive ${integer ? 'whole number' : 'number'}, or disabled.`);
    }
    limits[key] = value;
  }
  const threshold = Number(warning);
  if (!warning.trim() || !Number.isFinite(threshold) || threshold < 1 || threshold > 99) {
    throw new Error('Warning threshold must be between 1 and 99%.');
  }
  return { ...limits, warnThresholdPercent: threshold };
}
