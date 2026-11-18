import { describe, it, expect } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/svelte';
import type { WorkflowBudgetDto } from '$lib/types.js';
import ResourceBudgetPanel from './resource-budget-panel.svelte';

const budget: WorkflowBudgetDto = {
  limits: {
    maxEstimatedCostUsd: 5,
    maxTotalTokens: null,
    maxSteps: 200,
    maxSessionSeconds: 1800,
    warnThresholdPercent: 80,
  },
  sources: {
    maxEstimatedCostUsd: 'default',
    maxTotalTokens: 'workflow',
    maxSteps: 'global',
    maxSessionSeconds: 'default',
    warnThresholdPercent: 'default',
  },
  recorded: true,
  usage: {
    estimatedCostUsd: 7.12,
    totalTokens: 2000,
    stepCount: 2,
    elapsedSeconds: 8000,
    tokenTrackingAvailable: true,
  },
};

describe('ResourceBudgetPanel', () => {
  it('keeps warnings visible while collapsed and toggles the details', async () => {
    render(ResourceBudgetPanel, { budget });
    const toggle = screen.getByTestId('budget-toggle');
    const details = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(details.hidden).toBe(true);
    expect(within(toggle).getByText('Limit reached')).toBeTruthy();
    expect(screen.queryAllByRole('progressbar')).toHaveLength(0);
    await fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(details.hidden).toBe(false);
    expect(screen.getByRole('progressbar', { name: 'Estimated cost usage' })).toBeTruthy();
    await fireEvent.click(toggle);
    expect(details.hidden).toBe(true);
  });
  it('shows usage overshoot, limit provenance and explicit disabled state', async () => {
    render(ResourceBudgetPanel, { budget });
    await fireEvent.click(screen.getByTestId('budget-toggle'));
    const cost = within(screen.getByTestId('budget-maxEstimatedCostUsd'));
    expect(cost.getByText('$5.00')).toBeTruthy();
    expect(cost.getByText('default')).toBeTruthy();
    expect(cost.getByText('$7.12 used · Limit reached')).toBeTruthy();
    expect(cost.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
    expect(within(screen.getByTestId('budget-maxTotalTokens')).getByText('Disabled')).toBeTruthy();
    expect(within(screen.getByTestId('budget-maxSessionSeconds')).queryByRole('progressbar')).toBeNull();
  });
  it('identifies sampled usage when parallel sessions are active', () => {
    render(ResourceBudgetPanel, { budget: { ...budget, activeSessionCount: 3 } });
    expect(screen.getByText('1 of 3 active agent sessions')).toBeTruthy();
    expect(screen.getByTestId('budget-sampled-note').textContent).toContain('not aggregated');
    expect(screen.getByText('$7.12 used · Limit reached')).toBeTruthy();
  });
  it('does not imply zero spend or known historical limits for legacy runs', () => {
    render(ResourceBudgetPanel, { budget: { ...budget, recorded: false } });
    expect(screen.getByTestId('budget-legacy-note')).toBeTruthy();
    expect(screen.getAllByText('Usage unavailable')).toHaveLength(3);
    expect(within(screen.getByTestId('budget-toggle')).getByText('Historical limits unknown')).toBeTruthy();
    expect(screen.queryByText('$7.12 used · Limit reached')).toBeNull();
    expect(screen.queryAllByRole('progressbar')).toHaveLength(0);
  });
  it('does not display zero spend when neither tokens nor cost have been observed', async () => {
    render(ResourceBudgetPanel, {
      budget: { ...budget, usage: { ...budget.usage!, estimatedCostUsd: 0, tokenTrackingAvailable: false } },
    });
    await fireEvent.click(screen.getByTestId('budget-toggle'));
    const cost = within(screen.getByTestId('budget-maxEstimatedCostUsd'));
    expect(cost.getByText('Usage unavailable')).toBeTruthy();
    expect(cost.queryByText('$0.00 used')).toBeNull();
    expect(cost.queryByRole('progressbar')).toBeNull();
  });
  it('marks a partial (lower-bound) session token total', async () => {
    render(ResourceBudgetPanel, {
      budget: {
        ...budget,
        limits: { ...budget.limits, maxTotalTokens: 1_000_000 },
        usage: {
          ...budget.usage!,
          tokenTrackingStatus: 'partial',
          observedExchanges: 5,
          incompleteExchanges: 1,
        },
      },
    });
    await fireEvent.click(screen.getByTestId('budget-toggle'));
    const tokens = within(screen.getByTestId('budget-maxTotalTokens'));
    expect(tokens.getByText(`≥${(2000).toLocaleString()} used`)).toBeTruthy();
  });
  it('shows whole-run totals against the run ceiling', async () => {
    render(ResourceBudgetPanel, {
      budget: {
        ...budget,
        usage: undefined,
        workflowLimits: { maxEstimatedCostUsd: 10, maxWallClockSeconds: 3600 },
        workflowUsage: {
          inputTokens: 90_000,
          cacheReadTokens: 60_000,
          cacheWriteTokens: 0,
          outputTokens: 10_000,
          totalTokens: 100_000,
          estimatedCostUsd: 8.5,
          activeSeconds: 600,
          observedExchanges: 40,
          incompleteExchanges: 2,
          unmeasuredExchanges: 0,
          meteredSessions: 4,
          reportedSessions: 0,
          untrackedSessions: 0,
          lowerBound: false,
          tokenTrackingStatus: 'partial',
        },
      },
    });
    // The run ceiling drives the header warning even while collapsed.
    expect(within(screen.getByTestId('budget-toggle')).getByText('Near limit')).toBeTruthy();
    await fireEvent.click(screen.getByTestId('budget-toggle'));
    const cost = within(screen.getByTestId('workflow-run-maxEstimatedCostUsd'));
    expect(cost.getByText('$8.50 · Near limit')).toBeTruthy();
    expect(cost.getByText('Ceiling $10.00')).toBeTruthy();
    expect(cost.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('85');
    const tokens = within(screen.getByTestId('workflow-run-maxTotalTokens'));
    expect(tokens.getByText(`≥${(100_000).toLocaleString()}`)).toBeTruthy();
    expect(tokens.getByText('No ceiling')).toBeTruthy();
    expect(screen.getByTestId('workflow-run-tokens-detail').textContent).toContain(
      'partial: 2 of 40 exchanges incomplete',
    );
    expect(within(screen.getByTestId('workflow-run-maxWallClockSeconds')).getByText('10m 0s')).toBeTruthy();
  });
  it('says run tokens are unavailable when no session could be observed', async () => {
    render(ResourceBudgetPanel, {
      budget: {
        ...budget,
        workflowUsage: {
          inputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          estimatedCostUsd: 1,
          activeSeconds: 5,
          observedExchanges: 0,
          incompleteExchanges: 0,
          unmeasuredExchanges: 0,
          meteredSessions: 0,
          reportedSessions: 0,
          untrackedSessions: 2,
          lowerBound: false,
          tokenTrackingStatus: 'unavailable',
        },
      },
    });
    await fireEvent.click(screen.getByTestId('budget-toggle'));
    expect(within(screen.getByTestId('workflow-run-maxTotalTokens')).getByText('Unavailable')).toBeTruthy();
    expect(screen.getByTestId('workflow-run-tokens-detail').textContent).toContain('LLM statistics are off');
  });
  it('preview shows the configured run ceiling', () => {
    render(ResourceBudgetPanel, {
      budget: { ...budget, workflowLimits: { maxEstimatedCostUsd: 25, maxTotalTokens: null } },
      preview: true,
    });
    expect(screen.getByTestId('workflow-ceiling-preview').textContent).toContain('estimated cost $25.00');
    expect(screen.queryByTestId('workflow-run-totals')).toBeNull();
  });
  it('preview shows effective settings without usage or historical caveats', () => {
    render(ResourceBudgetPanel, { budget: { ...budget, recorded: false }, preview: true });
    expect(screen.getByText('Effective settings for this run')).toBeTruthy();
    expect(screen.queryByTestId('budget-legacy-note')).toBeNull();
    expect(screen.queryByText('Usage unavailable')).toBeNull();
    expect(screen.queryByTestId('budget-toggle')).toBeNull();
    expect(screen.getByTestId('budget-maxEstimatedCostUsd').closest('[hidden]')).toBeNull();
  });
});
