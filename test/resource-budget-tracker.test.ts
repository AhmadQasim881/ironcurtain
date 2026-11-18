import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ResourceBudgetTracker,
  STEP_SAFETY_CAP,
  resolveStepCap,
  stepTokenUsage,
  type BudgetExhaustedVerdict,
} from '../src/session/resource-budget-tracker.js';
import type { ResolvedResourceBudgetConfig } from '../src/config/user-config.js';
import type { LanguageModelUsage } from 'ai';

// --- Test helpers ---

/** The default agent model: $3 / $15 per MTok, cache reads $0.30. */
const SONNET_4_6 = 'anthropic:claude-sonnet-4-6';

function defaultConfig(overrides: Partial<ResolvedResourceBudgetConfig> = {}): ResolvedResourceBudgetConfig {
  return {
    maxTotalTokens: 10_000,
    maxSteps: 10,
    maxSessionSeconds: 60,
    maxEstimatedCostUsd: 1.0,
    warnThresholdPercent: 80,
    ...overrides,
  };
}

function makeUsage(overrides: Partial<LanguageModelUsage> = {}): LanguageModelUsage {
  return {
    inputTokens: 100,
    inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
    outputTokens: 50,
    outputTokenDetails: { textTokens: 50, reasoningTokens: 0 },
    totalTokens: 150,
    ...overrides,
  };
}

/** Minimal step result stub -- only `usage` is accessed by the stop condition at runtime. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeStepResult(usage: LanguageModelUsage): any {
  return { usage };
}

/** Creates a tracker and starts a turn (most tests need an active turn). */
function createTracker(config?: Partial<ResolvedResourceBudgetConfig>, modelId = SONNET_4_6) {
  const tracker = new ResourceBudgetTracker(defaultConfig(config), modelId);
  tracker.startTurn();
  return tracker;
}

// --- Tests ---

describe('ResourceBudgetTracker', () => {
  describe('token budget', () => {
    it('allows usage below limit', () => {
      const tracker = createTracker({ maxTotalTokens: 1000 });
      const verdict = tracker.recordStep(makeUsage({ inputTokens: 100, outputTokens: 50, totalTokens: 150 }));
      expect(verdict).toEqual({ ok: true });
    });

    it('warns at threshold', () => {
      const tracker = createTracker({ maxTotalTokens: 1000 });

      // Record steps to reach 80%+ of 1000 tokens
      for (let i = 0; i < 5; i++) {
        tracker.recordStep(makeUsage({ inputTokens: 100, outputTokens: 60, totalTokens: 160 }));
      }

      const warnings = tracker.getActiveWarnings();
      expect(warnings.length).toBeGreaterThanOrEqual(1);
      const tokenWarning = warnings.find((w) => w.dimension === 'tokens');
      expect(tokenWarning).toBeDefined();
      expect(tokenWarning!.percentUsed).toBeGreaterThanOrEqual(80);
    });

    it('exhausts at limit', () => {
      const tracker = createTracker({ maxTotalTokens: 500 });

      // First step: 300 tokens, ok
      const v1 = tracker.recordStep(makeUsage({ inputTokens: 200, outputTokens: 100, totalTokens: 300 }));
      expect(v1).toEqual({ ok: true });

      // Second step: 300 more = 600 total, exceeds 500
      const v2 = tracker.recordStep(makeUsage({ inputTokens: 200, outputTokens: 100, totalTokens: 300 }));
      expect('exhausted' in v2).toBe(true);
      expect((v2 as BudgetExhaustedVerdict).dimension).toBe('tokens');
    });
  });

  describe('step budget', () => {
    it('tracks step count and exhausts at limit', () => {
      const tracker = createTracker({ maxSteps: 3, maxTotalTokens: null, maxEstimatedCostUsd: null });

      expect(tracker.recordStep(makeUsage())).toEqual({ ok: true });
      expect(tracker.recordStep(makeUsage())).toEqual({ ok: true });

      const v3 = tracker.recordStep(makeUsage());
      expect('exhausted' in v3).toBe(true);
      expect((v3 as BudgetExhaustedVerdict).dimension).toBe('steps');
    });

    it('warns at step threshold', () => {
      const tracker = createTracker({ maxSteps: 10, maxTotalTokens: null, maxEstimatedCostUsd: null });

      // Reach 80%: 8 steps of 10
      for (let i = 0; i < 8; i++) {
        tracker.recordStep(makeUsage());
      }

      const warnings = tracker.getActiveWarnings();
      const stepWarning = warnings.find((w) => w.dimension === 'steps');
      expect(stepWarning).toBeDefined();
      expect(stepWarning!.percentUsed).toBe(80);
    });
  });

  describe('wall-clock budget', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('exhausts at time limit', () => {
      const tracker = createTracker({
        maxSessionSeconds: 10,
        maxTotalTokens: null,
        maxSteps: null,
        maxEstimatedCostUsd: null,
      });

      // Initially not exhausted
      expect(tracker.isExhausted()).toBeNull();

      // Advance time past the limit
      vi.advanceTimersByTime(11_000);

      const verdict = tracker.isExhausted();
      expect(verdict).not.toBeNull();
      expect(verdict!.dimension).toBe('wall_clock');
    });

    it('getRemainingWallClockMs returns correct value', () => {
      const tracker = createTracker({ maxSessionSeconds: 30 });

      expect(tracker.getRemainingWallClockMs()).toBe(30_000);

      vi.advanceTimersByTime(10_000);
      expect(tracker.getRemainingWallClockMs()).toBe(20_000);

      vi.advanceTimersByTime(25_000);
      expect(tracker.getRemainingWallClockMs()).toBe(0);
    });

    it('getRemainingWallClockMs returns null when disabled', () => {
      const tracker = createTracker({ maxSessionSeconds: null });

      expect(tracker.getRemainingWallClockMs()).toBeNull();
    });
  });

  describe('cost estimation', () => {
    // Prompts stay at or under Sonnet 4.6's 200K-token threshold, above which
    // its long-context price is charged at twice the listed rates (see the
    // "unmodeled long-context premiums" tests below).
    it('estimates cost from token counts and pricing table', () => {
      const tracker = createTracker({ maxEstimatedCostUsd: 10, maxTotalTokens: null, maxSteps: null });

      // claude-sonnet-4-6: input=$3/M, output=$15/M
      // 100K input + 10K output = $0.30 + $0.15 = $0.45
      tracker.recordStep(
        makeUsage({
          inputTokens: 100_000,
          outputTokens: 10_000,
          totalTokens: 110_000,
          inputTokenDetails: { noCacheTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
        }),
      );

      const snapshot = tracker.getSnapshot();
      expect(snapshot.estimatedCostUsd).toBeCloseTo(0.45, 9);
    });

    it('applies reduced rate for cache-read tokens', () => {
      const tracker = createTracker({ maxEstimatedCostUsd: 10, maxTotalTokens: null, maxSteps: null });

      // claude-sonnet-4-6: input=$3/M, cacheRead=$0.3/M, output=$15/M
      // 50K cached + 50K non-cached input + 10K output
      // = (50K/1M * $3) + (50K/1M * $0.3) + (10K/1M * $15)
      // = $0.15 + $0.015 + $0.15 = $0.315
      tracker.recordStep(
        makeUsage({
          inputTokens: 100_000,
          outputTokens: 10_000,
          totalTokens: 110_000,
          inputTokenDetails: { noCacheTokens: 50_000, cacheReadTokens: 50_000, cacheWriteTokens: 0 },
        }),
      );

      const snapshot = tracker.getSnapshot();
      expect(snapshot.estimatedCostUsd).toBeCloseTo(0.315, 9);
    });

    it('exhausts when cost exceeds budget', () => {
      const tracker = createTracker({ maxEstimatedCostUsd: 1.0, maxTotalTokens: null, maxSteps: null });

      // claude-sonnet-4-6: enough tokens to exceed $1
      const v = tracker.recordStep(
        makeUsage({
          inputTokens: 500_000,
          outputTokens: 100_000,
          totalTokens: 600_000,
        }),
      );

      expect('exhausted' in v).toBe(true);
      expect((v as BudgetExhaustedVerdict).dimension).toBe('cost');
    });

    it('uses fallback pricing for unknown models', () => {
      const tracker = createTracker(
        { maxEstimatedCostUsd: 100, maxTotalTokens: null, maxSteps: null },
        'unknown-model-xyz',
      );

      // Fallback: input=$3/M, output=$15/M
      tracker.recordStep(
        makeUsage({
          inputTokens: 1_000_000,
          outputTokens: 0,
          totalTokens: 1_000_000,
        }),
      );

      const snapshot = tracker.getSnapshot();
      expect(snapshot.estimatedCostUsd).toBeCloseTo(3.0, 1);
      expect(tracker.getPricing().source).toBe('unknown_model');
      expect(tracker.getPricing().warning).toContain('unknown-model-xyz');
    });

    it('prices an unknown Claude model at the highest Claude tier and warns, never at Sonnet prices', () => {
      const tracker = createTracker(
        { maxEstimatedCostUsd: null, maxTotalTokens: null, maxSteps: null },
        'anthropic:claude-opus-9',
      );
      tracker.recordStep(makeUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 }));

      // $10 + $50: the Fable/Mythos tier, not the old $3/$15 fallback.
      expect(tracker.getSnapshot().estimatedCostUsd).toBeCloseTo(60, 6);
      expect(tracker.getPricing().source).toBe('unknown_claude');
      expect(tracker.getPricing().warning).toMatch(/resourceBudget\.modelPricing\["claude-opus-9"\]/);
    });

    it('applies a resourceBudget.modelPricing override for the model', () => {
      const tracker = new ResourceBudgetTracker(
        defaultConfig({ maxEstimatedCostUsd: null, maxTotalTokens: null, maxSteps: null }),
        'anthropic:claude-opus-9',
        {
          pricingOverrides: { 'claude-opus-9': { inputPerMillion: 2, outputPerMillion: 8, cacheReadPerMillion: 0.2 } },
        },
      );
      tracker.startTurn();
      tracker.recordStep(makeUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 }));

      expect(tracker.getSnapshot().estimatedCostUsd).toBeCloseTo(10, 6);
      expect(tracker.getPricing().source).toBe('override');
      expect(tracker.getPricing().warning).toBeUndefined();
    });

    it('charges cache writes at 1.25x input (the 5-minute TTL Code Mode uses)', () => {
      const tracker = createTracker({ maxEstimatedCostUsd: null, maxTotalTokens: null, maxSteps: null });

      // inputTokens includes the cache writes (AI SDK v6: noCache + cacheRead + cacheWrite).
      tracker.recordStep(
        makeUsage({
          inputTokens: 100_000,
          outputTokens: 0,
          totalTokens: 100_000,
          inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 100_000 },
        }),
      );

      // claude-sonnet-4-6: $3/M input -> $3.75/M for 5-minute cache writes (was charged $3.00).
      expect(tracker.getSnapshot().estimatedCostUsd).toBeCloseTo(0.375, 9);
    });

    it('charges 1-hour cache writes at 2x input when the raw usage splits them', () => {
      const tracker = createTracker({ maxEstimatedCostUsd: null, maxTotalTokens: null, maxSteps: null });

      tracker.recordStep(
        makeUsage({
          inputTokens: 100_000,
          outputTokens: 0,
          totalTokens: 100_000,
          inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 100_000 },
          raw: {
            input_tokens: 0,
            cache_creation_input_tokens: 100_000,
            cache_creation: { ephemeral_5m_input_tokens: 40_000, ephemeral_1h_input_tokens: 60_000 },
          },
        }),
      );

      // 40K x $3.75/M + 60K x $6/M = $0.15 + $0.36
      expect(tracker.getSnapshot().estimatedCostUsd).toBeCloseTo(0.51, 9);
    });

    it('prices the cache-heavy Claude Opus 5.5 step from the audit at about $1.00 (was $5.25)', () => {
      const tracker = createTracker(
        { maxEstimatedCostUsd: null, maxTotalTokens: null, maxSteps: null },
        'anthropic:claude-opus-5-5',
      );
      tracker.recordStep(
        makeUsage({
          inputTokens: 2_050_000,
          outputTokens: 20_000,
          totalTokens: 2_070_000,
          inputTokenDetails: { noCacheTokens: 50_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 0 },
        }),
      );

      // 50K x $4/M + 2M x $0.20/M + 20K x $20/M = $0.20 + $0.40 + $0.40
      expect(tracker.getSnapshot().estimatedCostUsd).toBeCloseTo(1.0, 6);
    });

    it("decides Claude Haiku 5.5's long-prompt tier per request, never from turn totals", () => {
      const tracker = createTracker(
        { maxEstimatedCostUsd: null, maxTotalTokens: null, maxSteps: null },
        'anthropic:claude-haiku-5-5',
      );

      // Two 60K-token prompts: each at or under 100K, so both bill at $0.10 / $0.50
      // even though the turn total (120K) is over the threshold.
      const smallStep = makeUsage({
        inputTokens: 60_000,
        outputTokens: 1_000,
        totalTokens: 61_000,
        inputTokenDetails: { noCacheTokens: 60_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
      });
      tracker.recordStep(smallStep);
      tracker.recordStep(smallStep);
      const base = 2 * (60_000 * 0.1 + 1_000 * 0.5);
      expect(tracker.getSnapshot().estimatedCostUsd).toBeCloseTo(base / 1_000_000, 9);

      // One 150K-token prompt: the whole request bills at $0.50 / $2.50.
      tracker.recordStep(
        makeUsage({
          inputTokens: 150_000,
          outputTokens: 1_000,
          totalTokens: 151_000,
          inputTokenDetails: { noCacheTokens: 150_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
        }),
      );
      const long = 150_000 * 0.5 + 1_000 * 2.5;
      expect(tracker.getSnapshot().estimatedCostUsd).toBeCloseTo((base + long) / 1_000_000, 9);
    });

    describe('unmodeled long-context premiums', () => {
      // claude-sonnet-4-6 bills a prompt over 200K tokens at its 1M-context
      // price, which the table does not list: the cap charges twice the
      // listed rates rather than letting the limit be overrun.
      const longStep = makeUsage({
        inputTokens: 250_000,
        outputTokens: 10_000,
        totalTokens: 260_000,
        inputTokenDetails: { noCacheTokens: 250_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
      });
      /** longStep at Sonnet 4.6's listed rates: $0.90. */
      const longStepListedUsd = (250_000 * 3 + 10_000 * 15) / 1_000_000;

      it('charges a step whose prompt is past the threshold twice the listed rates, noting it once per model', () => {
        const tracker = createTracker({ maxEstimatedCostUsd: null, maxTotalTokens: null, maxSteps: null });
        tracker.recordStep(longStep);
        expect(tracker.getSnapshot().estimatedCostUsd).toBeCloseTo(2 * longStepListedUsd, 9);
        // Tokens are counted as reported, never multiplied.
        expect(tracker.getSnapshot().totalTokens).toBe(260_000);

        const notices = tracker.takePricingNotices();
        expect(notices).toHaveLength(1);
        expect(notices[0]).toContain('"anthropic:claude-sonnet-4-6"');
        expect(notices[0]).toContain('over 200,000 tokens');

        // Later long steps, in this turn or the next, are charged alike without another notice.
        tracker.recordStep(longStep);
        tracker.endTurn();
        tracker.startTurn();
        tracker.recordStep(longStep);
        expect(tracker.takePricingNotices()).toEqual([]);
        expect(tracker.getSnapshot().cumulative.estimatedCostUsd).toBeCloseTo(6 * longStepListedUsd, 9);
      });

      it('charges a prompt at the threshold the listed rates, with no notice', () => {
        const tracker = createTracker({ maxEstimatedCostUsd: null, maxTotalTokens: null, maxSteps: null });
        // 150K cache reads + 50K uncached: exactly 200K prompt tokens.
        tracker.recordStep(
          makeUsage({
            inputTokens: 200_000,
            outputTokens: 1_000,
            totalTokens: 201_000,
            inputTokenDetails: { noCacheTokens: 50_000, cacheReadTokens: 150_000, cacheWriteTokens: 0 },
          }),
        );
        expect(tracker.getSnapshot().estimatedCostUsd).toBeCloseTo((50_000 * 3 + 150_000 * 0.3 + 1_000 * 15) / 1e6, 9);
        expect(tracker.takePricingNotices()).toEqual([]);
      });

      it('ends the turn on the cost limit the long-context charge reaches', () => {
        // $0.90 at the listed rates stays under $1; the $1.80 charged does not.
        const tracker = createTracker({ maxEstimatedCostUsd: 1, maxTotalTokens: null, maxSteps: null });
        const verdict = tracker.recordStep(longStep);
        expect(verdict).toMatchObject({ exhausted: true, dimension: 'cost' });
      });

      it("charges the summarizer's long prompt at its own model's threshold", () => {
        const tracker = createTracker(
          { maxEstimatedCostUsd: null, maxTotalTokens: null, maxSteps: null },
          'anthropic:claude-opus-5-5',
        );
        // Opus 5.5 lists its whole window; the Sonnet 4.5 summary model does not.
        tracker.recordStep(longStep);
        expect(tracker.takePricingNotices()).toEqual([]);
        tracker.recordAuxiliaryUsage(longStep, 'anthropic:claude-sonnet-4-5');
        const opusListedUsd = (250_000 * 4 + 10_000 * 20) / 1_000_000;
        expect(tracker.getSnapshot().estimatedCostUsd).toBeCloseTo(opusListedUsd + 2 * longStepListedUsd, 9);
        expect(tracker.takePricingNotices()).toEqual([expect.stringContaining('"anthropic:claude-sonnet-4-5"')]);
      });
    });

    it('accumulates priced dollars, so cumulative cost is the sum of per-step costs', () => {
      const tracker = createTracker(
        { maxEstimatedCostUsd: null, maxTotalTokens: null, maxSteps: null },
        'anthropic:claude-haiku-5-5',
      );
      const longStep = makeUsage({
        inputTokens: 150_000,
        outputTokens: 0,
        totalTokens: 150_000,
        inputTokenDetails: { noCacheTokens: 150_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
      });
      tracker.recordStep(longStep);
      tracker.endTurn();
      tracker.startTurn();
      tracker.recordStep(longStep);

      // Each request is in the long tier ($0.50/M): $0.075 per step.
      expect(tracker.getSnapshot().cumulative.estimatedCostUsd).toBeCloseTo(0.15, 9);
    });

    it('resolves OpenRouter dot slugs to the dashed table entry', () => {
      const tracker = createTracker(
        { maxEstimatedCostUsd: null, maxTotalTokens: null, maxSteps: null },
        'anthropic/claude-opus-4.5',
      );
      tracker.recordStep(makeUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 }));
      // $5 + $25, not the legacy $15 + $75 a broad 'claude-opus' match charged.
      expect(tracker.getSnapshot().estimatedCostUsd).toBeCloseTo(30, 6);
    });

    it('resolves GLM pricing for the z-ai/glm-5.2 slug (not the generic fallback)', () => {
      // The OpenRouter GLM slug must hit the `glm-5.2` matcher ($0.60/$2.20/$0.11),
      // NOT the generic Sonnet-priced FALLBACK ($3/$15/$0.30). Using a full
      // 'z-ai/glm-5.2' id also guards ordering: the specific `glm-5.2` entry
      // precedes the broad `z-ai/` guard, so both resolve to GLM pricing.
      const tracker = createTracker({ maxEstimatedCostUsd: 100, maxTotalTokens: null, maxSteps: null }, 'z-ai/glm-5.2');

      // GLM: input=$0.60/M, output=$2.20/M
      // 1M input + 100K output = $0.60 + $0.22 = $0.82
      tracker.recordStep(
        makeUsage({
          inputTokens: 1_000_000,
          outputTokens: 100_000,
          totalTokens: 1_100_000,
          inputTokenDetails: { noCacheTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
        }),
      );

      const snapshot = tracker.getSnapshot();
      expect(snapshot.estimatedCostUsd).toBeCloseTo(0.82, 2);
      // Guard against a silent fall-through to FALLBACK ($3.60 for these tokens).
      expect(snapshot.estimatedCostUsd).toBeLessThan(1.0);
    });

    it('resolves GLM pricing for a broader z-ai/ slug via the guard entry', () => {
      // A z-ai slug that is NOT glm-5.2 still lands on GLM-family pricing via
      // the broad `z-ai/` guard, not the generic FALLBACK.
      const tracker = createTracker(
        { maxEstimatedCostUsd: 100, maxTotalTokens: null, maxSteps: null },
        'z-ai/glm-5.2-air',
      );

      // GLM: input=$0.60/M → 1M input = $0.60
      tracker.recordStep(
        makeUsage({
          inputTokens: 1_000_000,
          outputTokens: 0,
          totalTokens: 1_000_000,
          inputTokenDetails: { noCacheTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
        }),
      );

      const snapshot = tracker.getSnapshot();
      expect(snapshot.estimatedCostUsd).toBeCloseTo(0.6, 2);
    });
  });

  describe('null dimensions', () => {
    it('skips disabled dimensions', () => {
      const tracker = createTracker({
        maxTotalTokens: null,
        maxSteps: null,
        maxSessionSeconds: null,
        maxEstimatedCostUsd: null,
      });

      // Should never exhaust with all limits disabled
      for (let i = 0; i < 100; i++) {
        const v = tracker.recordStep(
          makeUsage({
            inputTokens: 100_000,
            outputTokens: 50_000,
            totalTokens: 150_000,
          }),
        );
        expect(v).toEqual({ ok: true });
      }

      expect(tracker.isExhausted()).toBeNull();
      expect(tracker.getActiveWarnings()).toEqual([]);
    });
  });

  describe('isExhausted persistence', () => {
    it('once exhausted, stays exhausted within a turn', () => {
      const tracker = createTracker({ maxSteps: 2, maxTotalTokens: null, maxEstimatedCostUsd: null });

      tracker.recordStep(makeUsage());
      tracker.recordStep(makeUsage());

      const v1 = tracker.isExhausted();
      expect(v1).not.toBeNull();

      // Additional recordStep also returns exhausted
      const v2 = tracker.recordStep(makeUsage());
      expect('exhausted' in v2).toBe(true);

      // isExhausted remains true
      expect(tracker.isExhausted()).not.toBeNull();
    });
  });

  describe('createStopCondition', () => {
    it('returns false when within budget', () => {
      const tracker = createTracker({ maxSteps: 10, maxTotalTokens: null, maxEstimatedCostUsd: null });
      tracker.recordStep(makeUsage());

      const condition = tracker.createStopCondition();
      expect(condition({ steps: [makeStepResult(makeUsage())] })).toBe(false);
    });

    it('returns true once the recorded steps exhaust the budget', () => {
      const tracker = createTracker({ maxSteps: 2, maxTotalTokens: null, maxEstimatedCostUsd: null });
      const condition = tracker.createStopCondition();

      tracker.recordStep(makeUsage());
      expect(condition({ steps: [makeStepResult(makeUsage())] })).toBe(false);

      tracker.recordStep(makeUsage());
      expect(condition({ steps: [makeStepResult(makeUsage()), makeStepResult(makeUsage())] })).toBe(true);
    });

    it('never records the steps it is shown (recording happens in onStepFinish)', () => {
      const tracker = createTracker({ maxSteps: 5, maxTotalTokens: null, maxEstimatedCostUsd: null });
      const condition = tracker.createStopCondition();

      const steps = [makeStepResult(makeUsage()), makeStepResult(makeUsage()), makeStepResult(makeUsage())];
      condition({ steps });
      condition({ steps });

      const snapshot = tracker.getSnapshot();
      expect(snapshot.stepCount).toBe(0);
      expect(snapshot.totalTokens).toBe(0);
      expect(snapshot.estimatedCostUsd).toBe(0);
    });

    it('reports wall-clock exhaustion without any recorded step', () => {
      vi.useFakeTimers();
      try {
        const tracker = createTracker({
          maxSessionSeconds: 5,
          maxSteps: null,
          maxTotalTokens: null,
          maxEstimatedCostUsd: null,
        });
        const condition = tracker.createStopCondition();
        expect(condition({ steps: [] })).toBe(false);
        vi.advanceTimersByTime(6_000);
        expect(condition({ steps: [] })).toBe(true);
        expect(tracker.isExhausted()?.dimension).toBe('wall_clock');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('step cap', () => {
    it('follows resourceBudget.maxSteps, including values above the old hard-coded 100', () => {
      expect(resolveStepCap({ maxSteps: 300 })).toBe(300);
      expect(resolveStepCap({ maxSteps: 5 })).toBe(5);
    });

    it('falls back to the safety cap when the step budget is disabled', () => {
      expect(resolveStepCap({ maxSteps: null })).toBe(STEP_SAFETY_CAP);
      expect(STEP_SAFETY_CAP).toBeGreaterThan(200);
    });
  });

  describe('recording every step', () => {
    it('still records usage after the turn is exhausted (the step was paid for)', () => {
      const tracker = createTracker({ maxSteps: 1, maxTotalTokens: null, maxEstimatedCostUsd: null });

      expect('exhausted' in tracker.recordStep(makeUsage())).toBe(true);
      const latched = tracker.recordStep(makeUsage({ inputTokens: 1000, outputTokens: 10, totalTokens: 1010 }));
      expect('exhausted' in latched).toBe(true);

      const snapshot = tracker.getSnapshot();
      expect(snapshot.stepCount).toBe(2);
      expect(snapshot.totalTokens).toBe(150 + 1010);
    });

    it('counts a step whose usage is missing as a step with no tokens', () => {
      const tracker = createTracker({ maxTotalTokens: null, maxEstimatedCostUsd: null });
      expect(tracker.recordStep(undefined)).toEqual({ ok: true });
      const snapshot = tracker.getSnapshot();
      expect(snapshot.stepCount).toBe(1);
      expect(snapshot.totalTokens).toBe(0);
      expect(snapshot.estimatedCostUsd).toBe(0);
    });
  });

  describe('auxiliary usage (the compaction summarizer)', () => {
    /** The default summary model: $1 / $5 per MTok. */
    const HAIKU_4_5 = 'anthropic:claude-haiku-4-5';

    const summarizerUsage = () =>
      makeUsage({
        inputTokens: 10_000,
        outputTokens: 1_000,
        totalTokens: 11_000,
        inputTokenDetails: { noCacheTokens: 10_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
      });

    it("adds its tokens and its own model's cost to the turn and the totals without counting a step", () => {
      const tracker = createTracker({ maxTotalTokens: null, maxSteps: null, maxEstimatedCostUsd: null });
      tracker.recordStep(makeUsage({ inputTokens: 100, outputTokens: 50, totalTokens: 150 }));

      expect(tracker.recordAuxiliaryUsage(summarizerUsage(), HAIKU_4_5)).toEqual({ ok: true });

      const snapshot = tracker.getSnapshot();
      expect(snapshot).toMatchObject({
        stepCount: 1,
        totalInputTokens: 10_100,
        totalOutputTokens: 1_050,
        totalTokens: 11_150,
      });
      // Sonnet 4.6 for the step ($3 / $15), Haiku 4.5 for the summarizer ($1 / $5).
      const expected = (100 * 3 + 50 * 15) / 1_000_000 + (10_000 * 1 + 1_000 * 5) / 1_000_000;
      expect(snapshot.estimatedCostUsd).toBeCloseTo(expected, 12);
      expect(snapshot.cumulative).toMatchObject({ stepCount: 1, totalTokens: 11_150 });
      expect(snapshot.cumulative.estimatedCostUsd).toBeCloseTo(expected, 12);

      tracker.endTurn();
      expect(tracker.getSnapshot().lastTurn).toMatchObject({ stepCount: 1, totalTokens: 11_150 });
    });

    it('prices it with the resourceBudget.modelPricing override for its model', () => {
      const tracker = new ResourceBudgetTracker(
        defaultConfig({ maxEstimatedCostUsd: null, maxTotalTokens: null, maxSteps: null }),
        SONNET_4_6,
        { pricingOverrides: { 'claude-haiku-4-5': { inputPerMillion: 100, outputPerMillion: 100 } } },
      );
      tracker.startTurn();
      tracker.recordAuxiliaryUsage(summarizerUsage(), HAIKU_4_5);

      expect(tracker.getSnapshot().estimatedCostUsd).toBeCloseTo(1.1, 12);
      expect(tracker.getPricing(HAIKU_4_5).source).toBe('override');
      // The agent model keeps its own price.
      expect(tracker.getPricing().normalizedId).toBe('claude-sonnet-4-6');
      expect(tracker.getPricing().source).toBe('list');
    });

    it("resolves an unknown model's price fail-closed, with the warning to surface", () => {
      const tracker = createTracker({ maxEstimatedCostUsd: null, maxTotalTokens: null, maxSteps: null });
      tracker.recordAuxiliaryUsage(summarizerUsage(), 'anthropic:claude-haiku-9');

      // The highest Claude tier: $10 / $50 per MTok.
      expect(tracker.getSnapshot().estimatedCostUsd).toBeCloseTo((10_000 * 10 + 1_000 * 50) / 1_000_000, 12);
      expect(tracker.getPricing('anthropic:claude-haiku-9')).toMatchObject({ source: 'unknown_claude' });
      expect(tracker.getPricing('anthropic:claude-haiku-9').warning).toContain('"anthropic:claude-haiku-9"');
      expect(tracker.getPricing().warning).toBeUndefined();
    });

    it("counts toward the turn's limits: it can exhaust a dimension or pass a warning threshold", () => {
      const tracker = createTracker({ maxTotalTokens: 12_000, maxSteps: null, maxEstimatedCostUsd: null });

      expect(tracker.recordAuxiliaryUsage(summarizerUsage(), HAIKU_4_5)).toEqual({ ok: true });
      expect(tracker.getActiveWarnings()).toEqual([expect.objectContaining({ dimension: 'tokens', percentUsed: 92 })]);
      expect(tracker.isExhausted()).toBeNull();

      const verdict = tracker.recordAuxiliaryUsage(summarizerUsage(), HAIKU_4_5);
      expect(verdict).toMatchObject({ exhausted: true, dimension: 'tokens' });
      expect(tracker.isExhausted()).toMatchObject({ dimension: 'tokens' });
      // Still recorded once exhausted: the call ran and was paid for.
      tracker.recordAuxiliaryUsage(summarizerUsage(), HAIKU_4_5);
      expect(tracker.getSnapshot()).toMatchObject({ stepCount: 0, totalTokens: 33_000 });
    });

    it('goes to the cumulative totals alone when no turn is running', () => {
      const tracker = new ResourceBudgetTracker(
        defaultConfig({ maxTotalTokens: 5_000, maxEstimatedCostUsd: null, maxSteps: null }),
        SONNET_4_6,
      );

      // Above the per-turn token limit, but no turn is running to limit.
      expect(tracker.recordAuxiliaryUsage(summarizerUsage(), HAIKU_4_5)).toEqual({ ok: true });
      tracker.startTurn();

      const snapshot = tracker.getSnapshot();
      expect(snapshot).toMatchObject({ totalTokens: 0, stepCount: 0 });
      expect(snapshot.cumulative).toMatchObject({ totalTokens: 11_000, stepCount: 0 });
      expect(snapshot.cumulative.estimatedCostUsd).toBeCloseTo(0.015, 12);
      expect(tracker.isExhausted()).toBeNull();
    });

    it('counts a missing usage object as no tokens', () => {
      const tracker = createTracker();
      expect(tracker.recordAuxiliaryUsage(undefined, HAIKU_4_5)).toEqual({ ok: true });
      expect(tracker.getSnapshot()).toMatchObject({ totalTokens: 0, stepCount: 0, estimatedCostUsd: 0 });
    });
  });

  describe('cross-step accumulation', () => {
    it('accumulates tokens across multiple recordStep calls within a turn', () => {
      const tracker = createTracker({ maxTotalTokens: null, maxSteps: null, maxEstimatedCostUsd: null });

      tracker.recordStep(makeUsage({ inputTokens: 100, outputTokens: 50, totalTokens: 150 }));
      tracker.recordStep(makeUsage({ inputTokens: 200, outputTokens: 80, totalTokens: 280 }));
      tracker.recordStep(makeUsage({ inputTokens: 150, outputTokens: 70, totalTokens: 220 }));

      const snapshot = tracker.getSnapshot();
      expect(snapshot.totalInputTokens).toBe(450);
      expect(snapshot.totalOutputTokens).toBe(200);
      expect(snapshot.totalTokens).toBe(650);
      expect(snapshot.stepCount).toBe(3);
    });
  });

  describe('getSnapshot', () => {
    it('returns zero values initially (no turn active)', () => {
      const tracker = new ResourceBudgetTracker(defaultConfig(), SONNET_4_6);
      const snapshot = tracker.getSnapshot();
      expect(snapshot.totalInputTokens).toBe(0);
      expect(snapshot.totalOutputTokens).toBe(0);
      expect(snapshot.totalTokens).toBe(0);
      expect(snapshot.stepCount).toBe(0);
      expect(snapshot.estimatedCostUsd).toBe(0);
      expect(snapshot.elapsedSeconds).toBe(0);
    });

    it('returns zero per-turn values after startTurn', () => {
      const tracker = createTracker();
      const snapshot = tracker.getSnapshot();
      expect(snapshot.totalInputTokens).toBe(0);
      expect(snapshot.totalOutputTokens).toBe(0);
      expect(snapshot.totalTokens).toBe(0);
      expect(snapshot.stepCount).toBe(0);
      expect(snapshot.estimatedCostUsd).toBe(0);
    });
  });

  describe('warnings', () => {
    it('each dimension warns at most once per turn', () => {
      const tracker = createTracker({ maxSteps: 10, maxTotalTokens: null, maxEstimatedCostUsd: null });

      // Reach 80%: 8 steps
      for (let i = 0; i < 8; i++) {
        tracker.recordStep(makeUsage());
      }

      const first = tracker.getActiveWarnings();
      expect(first.filter((w) => w.dimension === 'steps')).toHaveLength(1);

      // Record another step, no new warning
      tracker.recordStep(makeUsage());
      const second = tracker.getActiveWarnings();
      expect(second.filter((w) => w.dimension === 'steps')).toHaveLength(0);
    });

    it('getActiveWarnings drains pending warnings', () => {
      const tracker = createTracker({ maxSteps: 10, maxTotalTokens: null, maxEstimatedCostUsd: null });

      for (let i = 0; i < 8; i++) {
        tracker.recordStep(makeUsage());
      }

      const first = tracker.getActiveWarnings();
      expect(first.length).toBeGreaterThan(0);

      // Second call returns empty
      const second = tracker.getActiveWarnings();
      expect(second).toEqual([]);
    });
  });

  describe('turn lifecycle', () => {
    it('startTurn resets per-turn counters', () => {
      const tracker = createTracker({
        maxTotalTokens: null,
        maxSteps: null,
        maxEstimatedCostUsd: null,
        maxSessionSeconds: null,
      });

      tracker.recordStep(makeUsage({ inputTokens: 500, outputTokens: 200, totalTokens: 700 }));
      expect(tracker.getSnapshot().totalTokens).toBe(700);

      // End turn 1, start turn 2
      tracker.endTurn();
      tracker.startTurn();

      // Per-turn counters should be reset
      const snapshot = tracker.getSnapshot();
      expect(snapshot.totalInputTokens).toBe(0);
      expect(snapshot.totalOutputTokens).toBe(0);
      expect(snapshot.totalTokens).toBe(0);
      expect(snapshot.stepCount).toBe(0);
    });

    it('cumulative snapshot accumulates across turns', () => {
      const tracker = createTracker({
        maxTotalTokens: null,
        maxSteps: null,
        maxEstimatedCostUsd: null,
        maxSessionSeconds: null,
      });

      tracker.recordStep(makeUsage({ inputTokens: 100, outputTokens: 50, totalTokens: 150 }));
      tracker.recordStep(makeUsage({ inputTokens: 200, outputTokens: 80, totalTokens: 280 }));
      tracker.endTurn();

      tracker.startTurn();
      tracker.recordStep(makeUsage({ inputTokens: 300, outputTokens: 100, totalTokens: 400 }));

      // Per-turn: only turn 2 values
      const snapshot = tracker.getSnapshot();
      expect(snapshot.totalInputTokens).toBe(300);
      expect(snapshot.totalOutputTokens).toBe(100);
      expect(snapshot.stepCount).toBe(1);

      // Cumulative: turn 1 + turn 2
      expect(snapshot.cumulative.totalInputTokens).toBe(600);
      expect(snapshot.cumulative.totalOutputTokens).toBe(230);
      expect(snapshot.cumulative.totalTokens).toBe(830);
      expect(snapshot.cumulative.stepCount).toBe(3);
    });

    it('exhausted verdict resets between turns', () => {
      const tracker = createTracker({
        maxSteps: 2,
        maxTotalTokens: null,
        maxEstimatedCostUsd: null,
        maxSessionSeconds: null,
      });

      tracker.recordStep(makeUsage());
      tracker.recordStep(makeUsage());
      expect(tracker.isExhausted()).not.toBeNull();

      // New turn should reset
      tracker.endTurn();
      tracker.startTurn();
      expect(tracker.isExhausted()).toBeNull();

      // Can use budget again in new turn
      const v = tracker.recordStep(makeUsage());
      expect(v).toEqual({ ok: true });
    });

    it('warnings fire fresh each turn', () => {
      const tracker = createTracker({
        maxSteps: 10,
        maxTotalTokens: null,
        maxEstimatedCostUsd: null,
        maxSessionSeconds: null,
      });

      // Reach 80% in turn 1
      for (let i = 0; i < 8; i++) tracker.recordStep(makeUsage());
      const turn1Warnings = tracker.getActiveWarnings();
      expect(turn1Warnings.find((w) => w.dimension === 'steps')).toBeDefined();

      // New turn: warnings should fire again
      tracker.endTurn();
      tracker.startTurn();
      for (let i = 0; i < 8; i++) tracker.recordStep(makeUsage());
      const turn2Warnings = tracker.getActiveWarnings();
      expect(turn2Warnings.find((w) => w.dimension === 'steps')).toBeDefined();
    });

    it('endTurn without startTurn is a no-op', () => {
      const tracker = new ResourceBudgetTracker(defaultConfig(), SONNET_4_6);
      // Should not throw
      tracker.endTurn();
      const snapshot = tracker.getSnapshot();
      expect(snapshot.cumulative.stepCount).toBe(0);
      expect(snapshot.cumulative.activeSeconds).toBe(0);
    });

    it('startTurn defensively ends active turn', () => {
      const tracker = createTracker({
        maxTotalTokens: null,
        maxSteps: null,
        maxEstimatedCostUsd: null,
        maxSessionSeconds: null,
      });

      tracker.recordStep(makeUsage({ inputTokens: 100, outputTokens: 50, totalTokens: 150 }));

      // startTurn without endTurn: should roll up turn 1
      tracker.startTurn();

      const snapshot = tracker.getSnapshot();
      expect(snapshot.totalInputTokens).toBe(0); // per-turn reset
      expect(snapshot.cumulative.totalInputTokens).toBe(100); // rolled up
      expect(snapshot.cumulative.stepCount).toBe(1);
    });

    it('getSnapshot between turns shows zero per-turn and correct cumulative', () => {
      const tracker = createTracker({
        maxTotalTokens: null,
        maxSteps: null,
        maxEstimatedCostUsd: null,
        maxSessionSeconds: null,
      });

      tracker.recordStep(makeUsage({ inputTokens: 500, outputTokens: 200, totalTokens: 700 }));
      tracker.endTurn();

      // Between turns: no active turn
      const snapshot = tracker.getSnapshot();
      expect(snapshot.totalInputTokens).toBe(0);
      expect(snapshot.totalOutputTokens).toBe(0);
      expect(snapshot.totalTokens).toBe(0);
      expect(snapshot.stepCount).toBe(0);
      expect(snapshot.elapsedSeconds).toBe(0);

      // Cumulative reflects completed turn
      expect(snapshot.cumulative.totalInputTokens).toBe(500);
      expect(snapshot.cumulative.totalOutputTokens).toBe(200);
      expect(snapshot.cumulative.totalTokens).toBe(700);
      expect(snapshot.cumulative.stepCount).toBe(1);
    });

    it('lastTurn is null until a turn ends, then keeps that turn after the per-turn reset', () => {
      vi.useFakeTimers();
      try {
        const tracker = createTracker({
          maxTotalTokens: null,
          maxSteps: null,
          maxEstimatedCostUsd: null,
          maxSessionSeconds: null,
        });
        expect(tracker.getSnapshot().lastTurn).toBeNull();

        tracker.recordStep(
          makeUsage({
            inputTokens: 100_000,
            outputTokens: 0,
            totalTokens: 100_000,
            inputTokenDetails: { noCacheTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
          }),
        );
        tracker.recordStep(makeUsage({ inputTokens: 100, outputTokens: 50, totalTokens: 150 }));
        vi.advanceTimersByTime(4_000);
        tracker.endTurn();

        const between = tracker.getSnapshot();
        expect(between.totalTokens).toBe(0);
        expect(between.lastTurn).toEqual({
          totalInputTokens: 100_100,
          totalOutputTokens: 50,
          totalTokens: 100_150,
          stepCount: 2,
          elapsedSeconds: 4,
          estimatedCostUsd: expect.closeTo(0.3 + (100 * 3 + 50 * 15) / 1_000_000, 9) as number,
        });

        // A new turn in progress does not replace lastTurn until it ends.
        tracker.startTurn();
        tracker.recordStep(makeUsage());
        expect(tracker.getSnapshot().lastTurn?.stepCount).toBe(2);
        tracker.endTurn();
        expect(tracker.getSnapshot().lastTurn?.stepCount).toBe(1);
        expect(tracker.getSnapshot().cumulative.stepCount).toBe(3);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('stepTokenUsage', () => {
    it('splits AI SDK usage into uncached input, cache reads, cache writes and output', () => {
      expect(
        stepTokenUsage(
          makeUsage({
            inputTokens: 1_000,
            outputTokens: 40,
            inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: 700, cacheWriteTokens: 200 },
            raw: { cache_creation: { ephemeral_5m_input_tokens: 150, ephemeral_1h_input_tokens: 50 } },
          }),
        ),
      ).toEqual({
        uncachedInputTokens: 100,
        cacheReadTokens: 700,
        cacheWrite5mTokens: 150,
        cacheWrite1hTokens: 50,
        outputTokens: 40,
      });
    });

    it('treats missing or malformed fields as zero and never reports more 1h writes than writes', () => {
      expect(stepTokenUsage(undefined)).toEqual({
        uncachedInputTokens: 0,
        cacheReadTokens: 0,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
        outputTokens: 0,
      });
      expect(
        stepTokenUsage(
          makeUsage({
            inputTokens: 100,
            outputTokens: undefined,
            inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: 10 },
            raw: { cache_creation: { ephemeral_1h_input_tokens: 999 } },
          }),
        ),
      ).toEqual({
        uncachedInputTokens: 90,
        cacheReadTokens: 0,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 10,
        outputTokens: 0,
      });
    });
  });

  describe('wall-clock per-turn isolation', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('idle time between turns does not count against wall-clock budget', () => {
      const tracker = new ResourceBudgetTracker(
        defaultConfig({ maxSessionSeconds: 10, maxTotalTokens: null, maxSteps: null, maxEstimatedCostUsd: null }),
        SONNET_4_6,
      );

      // Turn 1: 3 seconds
      tracker.startTurn();
      vi.advanceTimersByTime(3_000);
      expect(tracker.isExhausted()).toBeNull();
      tracker.endTurn();

      // Idle for 30 minutes (should not count)
      vi.advanceTimersByTime(30 * 60 * 1000);

      // Turn 2: starts fresh with full 10s budget
      tracker.startTurn();
      expect(tracker.isExhausted()).toBeNull();
      expect(tracker.getRemainingWallClockMs()).toBe(10_000);

      // 5 seconds into turn 2: still within budget
      vi.advanceTimersByTime(5_000);
      expect(tracker.isExhausted()).toBeNull();

      // 6 more seconds: exceeds 10s turn budget
      vi.advanceTimersByTime(6_000);
      expect(tracker.isExhausted()).not.toBeNull();
      expect(tracker.isExhausted()!.dimension).toBe('wall_clock');
    });

    it('cumulative activeSeconds tracks only active time', () => {
      const tracker = new ResourceBudgetTracker(
        defaultConfig({ maxSessionSeconds: null, maxTotalTokens: null, maxSteps: null, maxEstimatedCostUsd: null }),
        SONNET_4_6,
      );

      // Turn 1: 5 seconds
      tracker.startTurn();
      vi.advanceTimersByTime(5_000);
      tracker.endTurn();

      // Idle 60 seconds
      vi.advanceTimersByTime(60_000);

      // Turn 2: 3 seconds
      tracker.startTurn();
      vi.advanceTimersByTime(3_000);

      // Cumulative should be 5 + 3 = 8 seconds (not 68)
      const snapshot = tracker.getSnapshot();
      expect(snapshot.cumulative.activeSeconds).toBeCloseTo(8, 0);
    });

    it('getRemainingWallClockMs returns full budget when no turn active', () => {
      const tracker = new ResourceBudgetTracker(defaultConfig({ maxSessionSeconds: 30 }), SONNET_4_6);

      // No turn active: elapsed is 0
      expect(tracker.getRemainingWallClockMs()).toBe(30_000);
    });
  });

  describe('cumulative cost estimation', () => {
    it('cumulative cost reflects all turns', () => {
      const tracker = new ResourceBudgetTracker(
        defaultConfig({ maxEstimatedCostUsd: null, maxTotalTokens: null, maxSteps: null, maxSessionSeconds: null }),
        SONNET_4_6,
      );

      // Turn 1
      tracker.startTurn();
      tracker.recordStep(
        makeUsage({
          inputTokens: 100_000,
          outputTokens: 10_000,
          totalTokens: 110_000,
          inputTokenDetails: { noCacheTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
        }),
      );
      tracker.endTurn();

      // Turn 2
      tracker.startTurn();
      tracker.recordStep(
        makeUsage({
          inputTokens: 100_000,
          outputTokens: 10_000,
          totalTokens: 110_000,
          inputTokenDetails: { noCacheTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
        }),
      );

      const snapshot = tracker.getSnapshot();
      // Per-turn cost: $0.45 (same as single-turn test)
      expect(snapshot.estimatedCostUsd).toBeCloseTo(0.45, 9);
      // Cumulative cost: $0.90
      expect(snapshot.cumulative.estimatedCostUsd).toBeCloseTo(0.9, 9);
    });
  });
});
