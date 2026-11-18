/**
 * Between-turn budget admission shared by DockerAgentSession and the workflow
 * orchestrator (`src/session/budget-admission.ts`).
 */
import { describe, expect, it } from 'vitest';

import { describeCumulativeBudgetExhaustion, findCumulativeBudgetExhaustion } from '../src/session/budget-admission.js';
import type { BudgetStatus } from '../src/session/types.js';

function status(overrides: {
  readonly limits?: Partial<BudgetStatus['limits']>;
  readonly cumulative?: Partial<BudgetStatus['cumulative']>;
  readonly tokenTrackingAvailable?: boolean;
  readonly hostObservedCostUsd?: number;
}): BudgetStatus {
  return {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    stepCount: 0,
    elapsedSeconds: 0,
    estimatedCostUsd: 0,
    tokenTrackingAvailable: overrides.tokenTrackingAvailable ?? true,
    limits: {
      maxTotalTokens: 1_000,
      maxSteps: 10,
      maxSessionSeconds: 60,
      maxEstimatedCostUsd: 5,
      warnThresholdPercent: 80,
      ...overrides.limits,
    },
    lastTurn: null,
    cumulative: {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      stepCount: 0,
      activeSeconds: 0,
      estimatedCostUsd: 0,
      ...overrides.cumulative,
    },
    ...(overrides.hostObservedCostUsd === undefined ? {} : { hostObservedCostUsd: overrides.hostObservedCostUsd }),
  };
}

describe('findCumulativeBudgetExhaustion', () => {
  it('admits a turn while every cumulative dimension is below its limit', () => {
    expect(
      findCumulativeBudgetExhaustion(
        status({ cumulative: { totalTokens: 999, stepCount: 9, estimatedCostUsd: 4.99 } }),
      ),
    ).toBeUndefined();
  });

  it('reports tokens, then steps, then cost, at or past the limit', () => {
    expect(
      findCumulativeBudgetExhaustion(
        status({ cumulative: { totalTokens: 1_000, stepCount: 10, estimatedCostUsd: 5 } }),
      ),
    ).toEqual({ dimension: 'tokens', used: 1_000, limit: 1_000 });
    expect(findCumulativeBudgetExhaustion(status({ cumulative: { stepCount: 12, estimatedCostUsd: 9 } }))).toEqual({
      dimension: 'steps',
      used: 12,
      limit: 10,
    });
    expect(findCumulativeBudgetExhaustion(status({ cumulative: { estimatedCostUsd: 5.5 } }))).toEqual({
      dimension: 'cost',
      used: 5.5,
      limit: 5,
    });
  });

  it('skips the token limit while token usage is not observable', () => {
    expect(
      findCumulativeBudgetExhaustion(status({ tokenTrackingAvailable: false, cumulative: { totalTokens: 50_000 } })),
    ).toBeUndefined();
  });

  it('ignores disabled limits and never sums per-turn wall-clock time', () => {
    expect(
      findCumulativeBudgetExhaustion(
        status({
          limits: { maxTotalTokens: null, maxSteps: null, maxEstimatedCostUsd: null },
          cumulative: { totalTokens: 1e9, stepCount: 1e6, estimatedCostUsd: 1e6, activeSeconds: 1e9 },
        }),
      ),
    ).toBeUndefined();
  });

  it.each([-1, 0, 1e9, Number.POSITIVE_INFINITY])(
    'uses host-observed cost instead of an agent-reported cost of %s',
    (agentReported) => {
      expect(
        findCumulativeBudgetExhaustion(
          status({ cumulative: { estimatedCostUsd: agentReported }, hostObservedCostUsd: 0 }),
        ),
      ).toBeUndefined();
      expect(
        findCumulativeBudgetExhaustion(
          status({ cumulative: { estimatedCostUsd: agentReported }, hostObservedCostUsd: 5.25 }),
        ),
      ).toEqual({ dimension: 'cost', used: 5.25, limit: 5 });
    },
  );
});

describe('describeCumulativeBudgetExhaustion', () => {
  it('keeps the compact workflow reasons', () => {
    expect(describeCumulativeBudgetExhaustion({ dimension: 'tokens', used: 1200, limit: 1000 })).toBe(
      'token budget exhausted (1200/1000)',
    );
    expect(describeCumulativeBudgetExhaustion({ dimension: 'steps', used: 3, limit: 3 })).toBe(
      'step budget exhausted (3/3)',
    );
    expect(describeCumulativeBudgetExhaustion({ dimension: 'cost', used: 7.123, limit: 5 })).toBe(
      'cost budget exhausted ($7.12/$5.00)',
    );
  });
});
