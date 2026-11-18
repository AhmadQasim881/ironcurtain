import {
  loadRequestedResourceBudgetConfig,
  USER_CONFIG_DEFAULTS,
  type ResolvedResourceBudgetConfig,
} from '../config/user-config.js';
import type { BudgetCostSource, BudgetStatus } from '../session/types.js';
import type { WorkflowBudgetSettings, WorkflowCheckpoint, WorkflowSettings } from './types.js';
import { parseWorkflowUsage, type WorkflowUsage } from './workflow-usage.js';

export type ResourceBudgetSource = 'workflow' | 'global' | 'default';

/** Effective settings saved at start or resume, including each value's source. */
export interface WorkflowBudget {
  /**
   * Per-session limits: every agent session gets them on its own. A shared
   * container's MITM budget gate also applies the token and cost limits to
   * the container as a whole (`docker/budget-gate.ts`).
   */
  readonly limits: ResolvedResourceBudgetConfig;
  readonly sources: Record<keyof ResolvedResourceBudgetConfig, ResourceBudgetSource>;
  /** False only for legacy saved runs whose effective limits are unknown. */
  readonly recorded: boolean;
  /** Number of concurrent agent sessions; usage describes one session, never their sum. */
  readonly activeSessionCount?: number;
  /** Tokens, steps and cost are cumulative agent-session totals. Time follows the session's tracker. */
  readonly usage?: {
    readonly totalTokens: number;
    readonly stepCount: number;
    readonly elapsedSeconds: number;
    readonly estimatedCostUsd: number;
    /**
     * Where `estimatedCostUsd` comes from (Docker sessions; see
     * `BudgetCostSource`). `unknown`: nothing reported a cost, so the 0 is not
     * zero spend. Absent for builtin sessions and older checkpoints.
     */
    readonly costSource?: BudgetCostSource;
    readonly tokenTrackingAvailable: boolean;
    /** `partial`: `totalTokens` is a lower bound (some exchange was not measured in full). */
    readonly tokenTrackingStatus?: 'complete' | 'partial' | 'unavailable';
    readonly observedExchanges?: number;
    readonly incompleteExchanges?: number;
  };
  /**
   * The run-wide ceiling (`settings.workflowBudget`). A view of the run's
   * definition, never read back from a saved budget: resume takes it from the
   * run's definition copy.
   */
  readonly workflowLimits?: WorkflowBudgetSettings;
  /**
   * Run-wide usage over every session, lane and resume (the meter's snapshot
   * for a live run, `WorkflowCheckpoint.usage` for a past one). A view: the
   * checkpoint stores it once, as `usage`, never inside the saved budget.
   */
  readonly workflowUsage?: WorkflowUsage;
}

/** Shared by previews, orchestrated runs and the single-state CLI. */
export function resolveWorkflowResourceBudget(
  settings?: WorkflowSettings,
  global: Partial<ResolvedResourceBudgetConfig> = loadRequestedResourceBudgetConfig(),
): WorkflowBudget {
  const overrides = { ...settings?.resourceBudget };
  if (settings?.maxSessionSeconds !== undefined) overrides.maxSessionSeconds = settings.maxSessionSeconds;
  const limits = { ...USER_CONFIG_DEFAULTS.resourceBudget } as ResolvedResourceBudgetConfig;
  const sources = {} as WorkflowBudget['sources'];
  for (const key of Object.keys(limits) as (keyof ResolvedResourceBudgetConfig)[]) {
    const value = overrides[key] !== undefined ? overrides[key] : global[key];
    sources[key] = overrides[key] !== undefined ? 'workflow' : global[key] !== undefined ? 'global' : 'default';
    if (value !== undefined) Object.assign(limits, { [key]: value });
  }
  return {
    limits,
    sources,
    recorded: true,
    ...(settings?.workflowBudget !== undefined ? { workflowLimits: settings.workflowBudget } : {}),
  };
}

/** The session-option split of a run's limits; see {@link workflowSessionBudgetOptions}. */
export interface WorkflowSessionBudgetOptions {
  /** Limits the workflow itself sets: above the state persona's `resourceBudget`. */
  readonly resourceBudgetOverrides: Partial<ResolvedResourceBudgetConfig>;
  /** Limits the run inherited (global config or defaults, as saved): below it. */
  readonly resourceBudgetBaseline: Partial<ResolvedResourceBudgetConfig>;
}

/**
 * Splits a run's saved limits for one agent session by where each came
 * from. A limit the workflow sets (`settings.resourceBudget`, the legacy
 * `maxSessionSeconds`) is an explicit override that the state persona's own
 * `resourceBudget` cannot change; a limit the run inherited from the global
 * config or the defaults is only the baseline, so the persona's value for
 * that field applies instead (see session/model-budget-precedence.ts). A
 * field without a recorded source is kept as an override: the saved value
 * is what the run enforced so far.
 */
export function workflowSessionBudgetOptions(budget: WorkflowBudget): WorkflowSessionBudgetOptions {
  const resourceBudgetOverrides: Record<string, number | null> = {};
  const resourceBudgetBaseline: Record<string, number | null> = {};
  // A checkpoint is read from disk: tolerate one that lacks the sources.
  const sources = budget.sources as Partial<WorkflowBudget['sources']> | undefined;
  for (const key of Object.keys(budget.limits) as (keyof ResolvedResourceBudgetConfig)[]) {
    const source = sources?.[key];
    const inherited = source === 'global' || source === 'default';
    (inherited ? resourceBudgetBaseline : resourceBudgetOverrides)[key] = budget.limits[key];
  }
  return { resourceBudgetOverrides, resourceBudgetBaseline };
}

export function workflowBudgetUsage(status: BudgetStatus): NonNullable<WorkflowBudget['usage']> {
  return {
    totalTokens: status.cumulative.totalTokens,
    stepCount: status.cumulative.stepCount,
    estimatedCostUsd: status.cumulative.estimatedCostUsd,
    ...(status.costSource !== undefined ? { costSource: status.costSource } : {}),
    elapsedSeconds: status.elapsedSeconds,
    tokenTrackingAvailable: status.tokenTrackingAvailable,
    ...(status.tokenTrackingStatus !== undefined ? { tokenTrackingStatus: status.tokenTrackingStatus } : {}),
    ...(status.observedExchanges !== undefined ? { observedExchanges: status.observedExchanges } : {}),
    ...(status.incompleteExchanges !== undefined ? { incompleteExchanges: status.incompleteExchanges } : {}),
  };
}

/**
 * The fields of a budget that a checkpoint saves and resume reads back: the
 * session limits, their sources and the last sampled session's usage. The
 * run-wide views (`workflowLimits`, `workflowUsage`) are dropped, so a saved
 * budget can never carry a stale ceiling or a second copy of the run's usage.
 */
export function persistedWorkflowBudget(budget: WorkflowBudget): WorkflowBudget {
  return {
    limits: budget.limits,
    sources: budget.sources,
    recorded: budget.recorded,
    ...(budget.activeSessionCount !== undefined ? { activeSessionCount: budget.activeSessionCount } : {}),
    ...(budget.usage !== undefined ? { usage: budget.usage } : {}),
  };
}

/** Historical limits must never be invented for a checkpoint without a snapshot. */
export function legacyWorkflowBudget(settings?: WorkflowSettings): WorkflowBudget {
  return { ...resolveWorkflowResourceBudget(settings), recorded: false };
}

/** Past runs retain saved limits and usage, but cannot have active sessions. */
export function pastRunWorkflowBudget(
  checkpoint: Pick<WorkflowCheckpoint, 'resourceBudget' | 'usage'> | undefined,
  settings?: WorkflowSettings,
): WorkflowBudget {
  const saved = checkpoint?.resourceBudget ? persistedWorkflowBudget(checkpoint.resourceBudget) : undefined;
  const workflowUsage = parseWorkflowUsage(checkpoint?.usage);
  return {
    ...(saved ?? legacyWorkflowBudget(settings)),
    activeSessionCount: 0,
    ...(settings?.workflowBudget !== undefined ? { workflowLimits: settings.workflowBudget } : {}),
    ...(workflowUsage !== undefined ? { workflowUsage } : {}),
  };
}
