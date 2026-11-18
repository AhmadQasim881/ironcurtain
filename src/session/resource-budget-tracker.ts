/**
 * ResourceBudgetTracker -- enforces configurable resource limits per turn.
 *
 * All four budget dimensions (tokens, steps, wall-clock time, cost) are
 * per-turn limits that reset when the agent returns control. Cumulative
 * session totals and a snapshot of the last completed turn are kept for
 * display (CLI, Signal, web UI, cron run records, workflow snapshots).
 *
 * Turn lifecycle: call startTurn() before each agent turn, endTurn() after.
 * Idle time between turns does not count against the wall-clock budget.
 *
 * Every AI SDK step must be passed to recordStep() exactly once -- the agent
 * session does it from `onStepFinish`, which fires for every step including
 * the final text step. Each step is priced on its own with the shared list
 * prices in `llm-metrics/pricing.ts` (so per-request tiers such as Claude
 * Haiku 5.5's long-prompt price are decided per request) and the dollars are
 * accumulated. Pricing is the cost-cap pricing (`estimateCapRequestCostUsd`):
 * a step whose prompt is past its model's unmodeled long-context threshold
 * (Sonnet 4.x above 200K tokens, for one) is charged twice the listed rates,
 * and takePricingNotices() reports that once per model. The token dimension
 * counts every prompt token the provider processed, cache reads and writes
 * included, plus output tokens.
 *
 * A model call the session makes itself beside the agent's steps (the
 * auto-compaction summarizer, which runs inside the turn) goes to
 * recordAuxiliaryUsage() instead: its tokens and cost, priced for the model
 * that served it, count toward the turn and the cumulative totals, but it is
 * not a step.
 *
 * Provides:
 * - recordStep() for accumulation after each AI SDK step
 * - recordAuxiliaryUsage() for the session's own model calls
 * - isExhausted() pre-check for belt-and-suspenders enforcement
 * - createStopCondition() for AI SDK v6 stopWhen integration (read-only)
 * - getRemainingWallClockMs() for AbortSignal timeout
 * - getActiveWarnings() for surfacing threshold warnings
 * - getPricing() for the resolved price and its fail-closed warning
 * - takePricingNotices() for how recorded usage was priced (long prompts)
 */

import type { ResolvedResourceBudgetConfig } from '../config/user-config.js';
import type { LanguageModelUsage, ToolSet, StopCondition } from 'ai';
import {
  estimateCapRequestCostUsd,
  resolveModelPricing,
  unmodeledLongContextWarning,
  type ModelPricing,
  type ModelPricingOverrides,
  type RequestTokenUsage,
  type ResolvedModelPricing,
} from '../llm-metrics/pricing.js';
import { isPlainObject } from '../utils/is-plain-object.js';

export type BudgetDimension = 'tokens' | 'steps' | 'wall_clock' | 'cost';

/**
 * Per-turn step ceiling for the agent loop when `resourceBudget.maxSteps` is
 * null (step budget disabled). Guards against runaway tool loops when every
 * other limit is disabled too.
 */
export const STEP_SAFETY_CAP = 1000;

/**
 * Step cap for one agent turn: the configured step budget, or
 * STEP_SAFETY_CAP when the step budget is disabled.
 */
export function resolveStepCap(config: Pick<ResolvedResourceBudgetConfig, 'maxSteps'>): number {
  return config.maxSteps ?? STEP_SAFETY_CAP;
}

/** Consumption of one turn. */
export interface TurnBudgetSnapshot {
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalTokens: number;
  readonly stepCount: number;
  readonly elapsedSeconds: number;
  readonly estimatedCostUsd: number;
}

/** Cumulative session totals across all turns, including the one in progress. */
export interface CumulativeBudgetSnapshot {
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalTokens: number;
  readonly stepCount: number;
  readonly activeSeconds: number;
  readonly estimatedCostUsd: number;
}

/**
 * The top-level fields describe the turn in progress and read zero between
 * turns. `lastTurn` keeps the most recently completed turn and `cumulative`
 * the session totals, so consumers that run after a turn has ended (cron run
 * records, web DTOs, Signal) never have to read the zeroed per-turn fields.
 */
export interface BudgetSnapshot extends TurnBudgetSnapshot {
  /** The most recently completed turn; null until the first turn ends. */
  readonly lastTurn: TurnBudgetSnapshot | null;
  readonly cumulative: CumulativeBudgetSnapshot;
}

export interface BudgetExhaustedVerdict {
  readonly exhausted: true;
  readonly dimension: BudgetDimension;
  readonly message: string;
  readonly snapshot: BudgetSnapshot;
}

export interface BudgetWarningVerdict {
  readonly warning: true;
  readonly dimension: BudgetDimension;
  readonly message: string;
  readonly percentUsed: number;
  readonly snapshot: BudgetSnapshot;
}

export type BudgetVerdict = { readonly ok: true } | BudgetExhaustedVerdict;

export interface ResourceBudgetTrackerOptions {
  /** Per-model price overrides from config.json `resourceBudget.modelPricing`. */
  readonly pricingOverrides?: ModelPricingOverrides;
}

interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  stepCount: number;
  costUsd: number;
}

function emptyTotals(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, stepCount: 0, costUsd: 0 };
}

/**
 * Adds one request's tokens (every prompt token, cache reads and writes
 * included, plus output) and its cost-cap price (`estimateCapRequestCostUsd`)
 * to `totals`. Returns true when the prompt was past the model's unmodeled
 * long-context threshold, so the request was charged the long-context
 * multiplier.
 */
function addRequestUsage(totals: UsageTotals, usage: LanguageModelUsage | undefined, pricing: ModelPricing): boolean {
  const tokens = stepTokenUsage(usage);
  totals.inputTokens +=
    tokens.uncachedInputTokens + tokens.cacheReadTokens + tokens.cacheWrite5mTokens + tokens.cacheWrite1hTokens;
  totals.outputTokens += tokens.outputTokens;
  const cost = estimateCapRequestCostUsd(pricing, tokens);
  totals.costUsd += cost.costUsd;
  return cost.unmodeledLongContext;
}

/** Non-negative finite token count; undefined, NaN and negatives read as 0. */
function tokenCount(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Cache-write tokens with the 1-hour TTL. The AI SDK reports one cache-write
 * total; Anthropic's raw usage splits it in `cache_creation`. Absent a split,
 * every write is priced as a 5-minute write (the TTL Code Mode requests).
 */
function oneHourCacheWriteTokens(raw: unknown): number {
  if (!isPlainObject(raw)) return 0;
  const creation = raw['cache_creation'];
  if (!isPlainObject(creation)) return 0;
  const oneHour = creation['ephemeral_1h_input_tokens'];
  return typeof oneHour === 'number' ? tokenCount(oneHour) : 0;
}

/**
 * Splits one AI SDK step's usage into the token kinds that are billed
 * separately. AI SDK v6 `inputTokens` is the whole prompt (uncached input
 * plus cache reads plus cache writes); a missing usage object counts as zero.
 */
export function stepTokenUsage(usage: LanguageModelUsage | undefined): RequestTokenUsage {
  if (!usage) {
    return {
      uncachedInputTokens: 0,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      outputTokens: 0,
    };
  }
  const details = usage.inputTokenDetails as Partial<LanguageModelUsage['inputTokenDetails']> | undefined;
  const cacheRead = tokenCount(details?.cacheReadTokens);
  const cacheWrite = tokenCount(details?.cacheWriteTokens);
  const uncached =
    usage.inputTokens === undefined
      ? tokenCount(details?.noCacheTokens)
      : Math.max(0, tokenCount(usage.inputTokens) - cacheRead - cacheWrite);
  const cacheWrite1h = Math.min(cacheWrite, oneHourCacheWriteTokens(usage.raw));
  return {
    uncachedInputTokens: uncached,
    cacheReadTokens: cacheRead,
    cacheWrite5mTokens: cacheWrite - cacheWrite1h,
    cacheWrite1hTokens: cacheWrite1h,
    outputTokens: tokenCount(usage.outputTokens),
  };
}

export class ResourceBudgetTracker {
  private readonly config: ResolvedResourceBudgetConfig;
  private readonly pricing: ResolvedModelPricing;
  private readonly pricingOverrides: ModelPricingOverrides | undefined;

  /** Prices of the models recordAuxiliaryUsage() was given, by model ID. */
  private readonly auxiliaryPricing = new Map<string, ResolvedModelPricing>();

  // --- Per-turn state (reset on each startTurn) ---
  private turnStartMs: number | null = null;
  private turn: UsageTotals = emptyTotals();

  // --- Completed turns (rolled up on each endTurn) ---
  private completed: UsageTotals = emptyTotals();
  private completedActiveMs = 0;
  private lastTurn: TurnBudgetSnapshot | null = null;

  /** Once a dimension is exhausted within a turn, the verdict is latched. */
  private exhaustedVerdict: BudgetExhaustedVerdict | null = null;

  /** Track which dimensions have already fired a warning (emit each once per turn). */
  private warnedDimensions = new Set<BudgetDimension>();

  /** Pending warnings accumulated by recordStep(), drained by getActiveWarnings(). */
  private pendingWarnings: BudgetWarningVerdict[] = [];

  /** Models (normalized IDs) a long prompt was charged the long-context multiplier for. */
  private readonly longContextModels = new Set<string>();

  /** Pricing notices not yet taken by takePricingNotices(); kept across turns. */
  private pendingPricingNotices: string[] = [];

  constructor(config: ResolvedResourceBudgetConfig, modelId: string, options: ResourceBudgetTrackerOptions = {}) {
    this.config = config;
    this.pricingOverrides = options.pricingOverrides;
    this.pricing = resolveModelPricing(modelId, this.pricingOverrides);
  }

  /**
   * The price used for cost estimates: of the agent's steps, or with
   * `modelId`, of that model's calls (recordAuxiliaryUsage). Both apply the
   * resourceBudget.modelPricing overrides; `warning` is set when the price is
   * a fail-closed default.
   */
  getPricing(modelId?: string): ResolvedModelPricing {
    if (modelId === undefined) return this.pricing;
    let resolved = this.auxiliaryPricing.get(modelId);
    if (resolved === undefined) {
      resolved = resolveModelPricing(modelId, this.pricingOverrides);
      this.auxiliaryPricing.set(modelId, resolved);
    }
    return resolved;
  }

  /**
   * Begin a new turn. Resets per-turn accumulators and starts the clock.
   * If a turn is already active, defensively ends it first.
   */
  startTurn(): void {
    if (this.turnStartMs !== null) {
      this.endTurn();
    }
    this.turn = emptyTotals();
    this.exhaustedVerdict = null;
    this.warnedDimensions.clear();
    this.pendingWarnings = [];
    this.turnStartMs = Date.now();
  }

  /**
   * End the current turn. Keeps it as `lastTurn` and rolls it into the
   * cumulative totals. No-op if no turn is active.
   */
  endTurn(): void {
    if (this.turnStartMs === null) return;
    const activeMs = Date.now() - this.turnStartMs;
    this.lastTurn = this.turnSnapshot(activeMs);
    this.completedActiveMs += activeMs;
    this.completed.inputTokens += this.turn.inputTokens;
    this.completed.outputTokens += this.turn.outputTokens;
    this.completed.stepCount += this.turn.stepCount;
    this.completed.costUsd += this.turn.costUsd;
    this.turnStartMs = null;
    this.turn = emptyTotals();
  }

  /**
   * Pre-check: returns a verdict if any budget dimension is exhausted.
   * Also checks wall-clock time (which advances even between steps).
   */
  isExhausted(): BudgetExhaustedVerdict | null {
    if (this.exhaustedVerdict) return this.exhaustedVerdict;
    const exhausted = this.checkExhaustion(this.getSnapshot());
    if (exhausted) this.exhaustedVerdict = exhausted;
    return exhausted;
  }

  /**
   * Record and price the usage of one completed step, then evaluate every
   * budget dimension. Usage is always recorded, even after the turn's budget
   * is exhausted: a step that ran was paid for. A missing usage object counts
   * as a step with no tokens.
   */
  recordStep(usage: LanguageModelUsage | undefined): BudgetVerdict {
    this.addUsage(this.turn, usage, this.pricing);
    this.turn.stepCount++;

    if (this.exhaustedVerdict) return this.exhaustedVerdict;
    return this.evaluate();
  }

  /**
   * Record and price the usage of one model call the session made beside
   * the agent's steps (the auto-compaction summarizer), then evaluate every
   * budget dimension. Its tokens and cost count toward the turn in progress
   * and the cumulative totals exactly like a step's, priced for `modelId`
   * (the model that served the call, as getPricing(modelId) resolves it),
   * but it is not an agent step: the step count does not change. Outside a
   * turn there is no per-turn limit to apply, so the usage goes to the
   * cumulative totals alone. A missing usage object counts as no tokens.
   */
  recordAuxiliaryUsage(usage: LanguageModelUsage | undefined, modelId: string): BudgetVerdict {
    const pricing = this.getPricing(modelId);
    if (this.turnStartMs === null) {
      this.addUsage(this.completed, usage, pricing);
      return { ok: true };
    }
    this.addUsage(this.turn, usage, pricing);

    if (this.exhaustedVerdict) return this.exhaustedVerdict;
    return this.evaluate();
  }

  /**
   * Notices about how recorded usage was priced, each returned once: the
   * first time a model's request had a prompt past its unmodeled
   * long-context threshold and was therefore charged the long-context
   * multiplier. The session surfaces them like getPricing().warning.
   */
  takePricingNotices(): string[] {
    return this.pendingPricingNotices.splice(0);
  }

  /**
   * Returns the current turn's consumption (zero between turns), the last
   * completed turn and the cumulative session totals.
   */
  getSnapshot(): BudgetSnapshot {
    return {
      ...this.turnSnapshot(this.getTurnElapsedMs()),
      lastTurn: this.lastTurn,
      cumulative: this.getCumulativeSnapshot(),
    };
  }

  /**
   * Returns warnings that have been generated since the last call.
   * Each dimension warns at most once per turn.
   */
  getActiveWarnings(): BudgetWarningVerdict[] {
    return this.pendingWarnings.splice(0);
  }

  /**
   * Creates a StopCondition for AI SDK v6 `stopWhen`. It only consults
   * isExhausted(): steps are recorded by the caller (from `onStepFinish`,
   * which the SDK runs before evaluating stop conditions), because stop
   * conditions are not evaluated after a final step without tool calls.
   */
  createStopCondition(): StopCondition<ToolSet> {
    return () => this.isExhausted() !== null;
  }

  /**
   * Returns remaining wall-clock time in milliseconds for the current turn,
   * or null if wall-clock budget is disabled.
   */
  getRemainingWallClockMs(): number | null {
    if (this.config.maxSessionSeconds === null) return null;
    const elapsedMs = this.getTurnElapsedMs();
    const limitMs = this.config.maxSessionSeconds * 1000;
    return Math.max(0, limitMs - elapsedMs);
  }

  // --- Private helpers ---

  /** Adds one request to `totals` at `resolved`'s price, noting a long-context charge once per model. */
  private addUsage(totals: UsageTotals, usage: LanguageModelUsage | undefined, resolved: ResolvedModelPricing): void {
    if (!addRequestUsage(totals, usage, resolved.pricing) || this.longContextModels.has(resolved.normalizedId)) return;
    this.longContextModels.add(resolved.normalizedId);
    this.pendingPricingNotices.push(unmodeledLongContextWarning(resolved.modelId, resolved.pricing));
  }

  private turnSnapshot(elapsedMs: number): TurnBudgetSnapshot {
    return {
      totalInputTokens: this.turn.inputTokens,
      totalOutputTokens: this.turn.outputTokens,
      totalTokens: this.turn.inputTokens + this.turn.outputTokens,
      stepCount: this.turn.stepCount,
      elapsedSeconds: elapsedMs / 1000,
      estimatedCostUsd: this.turn.costUsd,
    };
  }

  private getTurnElapsedMs(): number {
    if (this.turnStartMs === null) return 0;
    return Date.now() - this.turnStartMs;
  }

  /** Returns cumulative snapshot including the current in-progress turn. */
  private getCumulativeSnapshot(): CumulativeBudgetSnapshot {
    const totalInput = this.completed.inputTokens + this.turn.inputTokens;
    const totalOutput = this.completed.outputTokens + this.turn.outputTokens;
    return {
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      totalTokens: totalInput + totalOutput,
      stepCount: this.completed.stepCount + this.turn.stepCount,
      activeSeconds: (this.completedActiveMs + this.getTurnElapsedMs()) / 1000,
      estimatedCostUsd: this.completed.costUsd + this.turn.costUsd,
    };
  }

  private evaluate(): BudgetVerdict {
    const snapshot = this.getSnapshot();

    // Check exhaustion for each dimension
    const exhausted = this.checkExhaustion(snapshot);
    if (exhausted) {
      this.exhaustedVerdict = exhausted;
      return exhausted;
    }

    // Check warnings (only fires once per dimension per turn)
    this.checkWarnings(snapshot);

    return { ok: true };
  }

  private checkExhaustion(snapshot: BudgetSnapshot): BudgetExhaustedVerdict | null {
    const { maxTotalTokens, maxSteps, maxSessionSeconds, maxEstimatedCostUsd } = this.config;

    if (maxTotalTokens !== null && snapshot.totalTokens >= maxTotalTokens) {
      return {
        exhausted: true,
        dimension: 'tokens',
        message: `Token budget exhausted: ${snapshot.totalTokens.toLocaleString()} / ${maxTotalTokens.toLocaleString()} tokens used`,
        snapshot,
      };
    }
    if (maxSteps !== null && snapshot.stepCount >= maxSteps) {
      return {
        exhausted: true,
        dimension: 'steps',
        message: `Step budget exhausted: ${snapshot.stepCount} / ${maxSteps} steps used`,
        snapshot,
      };
    }
    if (maxSessionSeconds !== null && snapshot.elapsedSeconds >= maxSessionSeconds) {
      return {
        exhausted: true,
        dimension: 'wall_clock',
        message: `Time budget exhausted: ${Math.round(snapshot.elapsedSeconds)}s / ${maxSessionSeconds}s elapsed`,
        snapshot,
      };
    }
    if (maxEstimatedCostUsd !== null && snapshot.estimatedCostUsd >= maxEstimatedCostUsd) {
      return {
        exhausted: true,
        dimension: 'cost',
        message: `Cost budget exhausted: $${snapshot.estimatedCostUsd.toFixed(2)} / $${maxEstimatedCostUsd.toFixed(2)} estimated`,
        snapshot,
      };
    }
    return null;
  }

  private checkWarnings(snapshot: BudgetSnapshot): void {
    const maxTokens = this.config.maxTotalTokens;
    const maxSteps = this.config.maxSteps;
    const maxSeconds = this.config.maxSessionSeconds;
    const maxCost = this.config.maxEstimatedCostUsd;

    this.maybeWarn(
      'tokens',
      maxTokens,
      snapshot.totalTokens,
      snapshot,
      (pct) =>
        `Token usage at ${pct}%: ${snapshot.totalTokens.toLocaleString()} / ${(maxTokens ?? 0).toLocaleString()}`,
    );

    this.maybeWarn(
      'steps',
      maxSteps,
      snapshot.stepCount,
      snapshot,
      (pct) => `Step usage at ${pct}%: ${snapshot.stepCount} / ${maxSteps ?? 0}`,
    );

    this.maybeWarn(
      'wall_clock',
      maxSeconds,
      snapshot.elapsedSeconds,
      snapshot,
      (pct) => `Time usage at ${pct}%: ${Math.round(snapshot.elapsedSeconds)}s / ${maxSeconds ?? 0}s`,
    );

    this.maybeWarn(
      'cost',
      maxCost,
      snapshot.estimatedCostUsd,
      snapshot,
      (pct) => `Cost at ${pct}%: $${snapshot.estimatedCostUsd.toFixed(2)} / $${(maxCost ?? 0).toFixed(2)}`,
    );
  }

  private maybeWarn(
    dimension: BudgetDimension,
    limit: number | null,
    current: number,
    snapshot: BudgetSnapshot,
    messageFn: (percentUsed: number) => string,
  ): void {
    if (limit === null) return;
    if (this.warnedDimensions.has(dimension)) return;

    const ratio = current / limit;
    if (ratio >= this.config.warnThresholdPercent / 100 && ratio < 1) {
      const percentUsed = Math.round(ratio * 100);
      this.warnedDimensions.add(dimension);
      this.pendingWarnings.push({
        warning: true,
        dimension,
        message: messageFn(percentUsed),
        percentUsed,
        snapshot,
      });
    }
  }
}
