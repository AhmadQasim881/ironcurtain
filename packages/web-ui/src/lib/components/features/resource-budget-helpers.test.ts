import { describe, it, expect } from 'vitest';
import type { WorkflowBudgetDto, WorkflowUsageDto } from '$lib/types.js';
import {
  budgetUsage,
  formatBudgetUsage,
  formatRunUsage,
  highestRunProgress,
  limitProgress,
  parseResourceBudget,
  runLimit,
} from './resource-budget-helpers.js';
import { formatDuration, formatWorkflowTokens } from './usage-format.js';

function runUsage(overrides: Partial<WorkflowUsageDto> = {}): WorkflowUsageDto {
  return {
    inputTokens: 9000,
    cacheReadTokens: 6000,
    cacheWriteTokens: 1000,
    outputTokens: 1000,
    totalTokens: 10000,
    estimatedCostUsd: 4,
    activeSeconds: 125,
    observedExchanges: 12,
    incompleteExchanges: 0,
    unmeasuredExchanges: 0,
    meteredSessions: 3,
    reportedSessions: 0,
    untrackedSessions: 0,
    lowerBound: false,
    tokenTrackingStatus: 'complete',
    ...overrides,
  };
}

describe('tracked token display', () => {
  it('marks partial session totals as lower bounds', () => {
    const usage = { totalTokens: 2000, stepCount: 1, elapsedSeconds: 1, estimatedCostUsd: 1 };
    expect(
      formatBudgetUsage(
        {
          usage: { ...usage, tokenTrackingAvailable: true, tokenTrackingStatus: 'partial', observedExchanges: 2 },
        } as WorkflowBudgetDto,
        'maxTotalTokens',
        2000,
      ),
    ).toBe(`≥${(2000).toLocaleString()} used`);
    expect(
      formatBudgetUsage(
        {
          usage: { ...usage, tokenTrackingAvailable: true, tokenTrackingStatus: 'partial', observedExchanges: 0 },
        } as WorkflowBudgetDto,
        'maxTotalTokens',
        0,
      ),
    ).toBe('No exchanges observed yet');
    expect(
      formatBudgetUsage(
        { usage: { ...usage, tokenTrackingAvailable: true } } as WorkflowBudgetDto,
        'maxTotalTokens',
        2000,
      ),
    ).toBe(`${(2000).toLocaleString()} used`);
    expect(formatBudgetUsage({} as WorkflowBudgetDto, 'maxSteps', undefined)).toBe('Usage unavailable');
  });

  it('describes run-wide tokens with their breakdown and tracking quality', () => {
    expect(formatWorkflowTokens(runUsage())).toEqual({
      value: (10000).toLocaleString(),
      detail: `${(9000).toLocaleString()} in (${(7000).toLocaleString()} cache) · ${(1000).toLocaleString()} out`,
    });
    const partial = formatWorkflowTokens(
      runUsage({ tokenTrackingStatus: 'partial', incompleteExchanges: 2, untrackedSessions: 1 }),
    );
    expect(partial.value).toBe(`≥${(10000).toLocaleString()}`);
    expect(partial.detail).toContain('partial: 2 of 12 exchanges incomplete');
    expect(partial.detail).toContain('1 session not observed');
    expect(formatWorkflowTokens(runUsage({ tokenTrackingStatus: 'unavailable', totalTokens: 0 })).value).toBe(
      'Unavailable',
    );
    expect(
      formatWorkflowTokens(
        runUsage({ tokenTrackingStatus: 'partial', totalTokens: 0, observedExchanges: 0, meteredSessions: 1 }),
      ),
    ).toEqual({ value: 'No exchanges observed yet' });
  });

  it('explains the part of the run-wide total only the budget gate counted', () => {
    // Statistics off: no exchange was itemized, the bundle's budget gate charged everything.
    const gated = formatWorkflowTokens(
      runUsage({
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        totalTokens: 251_000,
        gateOnlyTokens: 251_000,
        observedExchanges: 0,
        meteredSessions: 0,
        untrackedSessions: 1,
        tokenTrackingStatus: 'partial',
      }),
    );
    expect(gated.value).toBe(`≥${(251_000).toLocaleString()}`);
    expect(gated.detail).toContain(`${(251_000).toLocaleString()} counted only by the budget gate`);
    // Older daemons send no gate figures.
    expect(formatWorkflowTokens(runUsage()).detail).not.toContain('budget gate');
  });

  it('reads the run ceiling and its progress', () => {
    const budget = {
      workflowLimits: { maxEstimatedCostUsd: 5, maxTotalTokens: null },
      workflowUsage: runUsage(),
    } as unknown as WorkflowBudgetDto;
    expect(runLimit(budget, 'maxEstimatedCostUsd')).toBe(5);
    expect(runLimit(budget, 'maxTotalTokens')).toBeNull();
    expect(highestRunProgress(budget)).toBe(80);
    expect(formatRunUsage(runUsage(), 'maxWallClockSeconds')).toBe('2m 5s');
    expect(formatRunUsage(runUsage(), 'maxEstimatedCostUsd')).toBe('$4.00');
    expect(formatDuration(7260)).toBe('2h 1m');
  });
});

const values = { maxTotalTokens: '1000', maxSteps: '12', maxSessionSeconds: '120', maxEstimatedCostUsd: '5.5' };
const enabled = { maxTotalTokens: false, maxSteps: false, maxSessionSeconds: false, maxEstimatedCostUsd: false };

describe('resource budget values', () => {
  it('preserves explicit disabled limits and validates whole steps', () => {
    expect(parseResourceBudget(values, { ...enabled, maxEstimatedCostUsd: true }, '80').maxEstimatedCostUsd).toBeNull();
    expect(() => parseResourceBudget({ ...values, maxSteps: '1.5' }, enabled, '80')).toThrow('whole number');
    for (const invalid of ['', '0', 'Infinity', '-1', 'abc', '9007199254740992']) {
      expect(() => parseResourceBudget({ ...values, maxTotalTokens: invalid }, enabled, '80')).toThrow();
    }
    expect(() => parseResourceBudget(values, enabled, '100')).toThrow('1 and 99');
  });
  it('never invents usage or compares cumulative session age with turn timeout', () => {
    const budget = {
      usage: { totalTokens: 0, stepCount: 0, elapsedSeconds: 999, estimatedCostUsd: 2, tokenTrackingAvailable: false },
    } as WorkflowBudgetDto;
    expect(budgetUsage(budget, 'maxTotalTokens')).toBeUndefined();
    expect(budgetUsage(budget, 'maxEstimatedCostUsd')).toBe(2);
    expect(
      budgetUsage({ usage: { ...budget.usage!, estimatedCostUsd: 0 } } as WorkflowBudgetDto, 'maxEstimatedCostUsd'),
    ).toBeUndefined();
    expect(
      budgetUsage(
        { usage: { ...budget.usage!, estimatedCostUsd: 0, tokenTrackingAvailable: true } } as WorkflowBudgetDto,
        'maxEstimatedCostUsd',
      ),
    ).toBe(0);
    expect(budgetUsage(budget, 'maxSteps')).toBe(0);
    expect(budgetUsage(budget, 'maxSessionSeconds')).toBeUndefined();
    expect(budgetUsage({} as WorkflowBudgetDto, 'maxEstimatedCostUsd')).toBeUndefined();
  });
  it('shows an unknown cost as unavailable, not $0.00, even with token tracking', () => {
    const tracked = {
      usage: { totalTokens: 10, stepCount: 1, elapsedSeconds: 1, estimatedCostUsd: 0, tokenTrackingAvailable: true },
    } as WorkflowBudgetDto;
    const usage = tracked.usage!;
    expect(
      budgetUsage({ usage: { ...usage, costSource: 'unknown' } } as WorkflowBudgetDto, 'maxEstimatedCostUsd'),
    ).toBeUndefined();
    // A partial cost is a lower bound: still progress against the limit.
    expect(
      budgetUsage(
        { usage: { ...usage, estimatedCostUsd: 0.4, costSource: 'partial' } } as WorkflowBudgetDto,
        'maxEstimatedCostUsd',
      ),
    ).toBe(0.4);
    expect(
      budgetUsage({ usage: { ...usage, costSource: 'observed' } } as WorkflowBudgetDto, 'maxEstimatedCostUsd'),
    ).toBe(0);
  });
  it('reports overshoot without imposing a progress value on disabled limits', () => {
    expect(limitProgress(7.12, 5)).toBeCloseTo(142.4);
    expect(limitProgress(7.12, null)).toBeUndefined();
    expect(limitProgress(undefined, 5)).toBeUndefined();
  });
});
