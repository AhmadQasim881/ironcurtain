/**
 * Cron run records report what the run consumed. The session's per-turn
 * budget fields are reset when each turn ends, so by the time the daemon
 * builds the record they read zero; the record must use the session totals.
 * A run that a budget stopped is recorded as budget_exhausted, not success.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LanguageModelUsage } from 'ai';

import type { IronCurtainConfig } from '../src/config/types.js';
import { getJobGeneratedDir } from '../src/config/paths.js';
import { loadRecentRuns, saveJob } from '../src/cron/job-store.js';
import { CRON_BUDGET_DEFAULTS, createJobId, type JobDefinition } from '../src/cron/types.js';
import { IronCurtainDaemon } from '../src/daemon/ironcurtain-daemon.js';
import * as logger from '../src/logger.js';
import { createStandaloneSession } from '../src/session/index.js';
import { ResourceBudgetTracker } from '../src/session/resource-budget-tracker.js';
import type { BudgetStatus, Session } from '../src/session/types.js';
import { BudgetExhaustedError } from '../src/types/errors.js';
import { writeCompiledPolicyFor } from './fixtures/scoped-policy.js';

vi.mock('../src/session/index.js', () => ({ createStandaloneSession: vi.fn() }));
vi.mock('../src/cron/compile-task-policy.js', () => ({ compileTaskPolicy: vi.fn(async () => {}) }));
vi.mock('../src/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config/index.js')>()),
  loadConfig: vi.fn(
    () =>
      ({
        protectedPaths: [],
        userConfig: { resourceBudget: {}, memory: { enabled: false, autoSave: false } },
      }) as unknown as IronCurtainConfig,
  ),
}));

const createSession = vi.mocked(createStandaloneSession);

const LIMITS = {
  maxTotalTokens: 500_000,
  maxSteps: 100,
  maxSessionSeconds: 3_600,
  maxEstimatedCostUsd: 2,
  warnThresholdPercent: 80,
} as const;

function stepUsage(input: number, output: number): LanguageModelUsage {
  return {
    inputTokens: input,
    inputTokenDetails: { noCacheTokens: input, cacheReadTokens: 0, cacheWriteTokens: 0 },
    outputTokens: output,
    outputTokenDetails: { textTokens: output, reasoningTokens: 0 },
    totalTokens: input + output,
  };
}

/**
 * A session whose budget status comes from a real ResourceBudgetTracker that
 * runs one turn the way AgentSession does: startTurn, one recordStep per
 * step, endTurn -- so after the turn the per-turn fields are zero.
 */
function trackedSession(steps: readonly LanguageModelUsage[], failWith?: Error): Session {
  const tracker = new ResourceBudgetTracker(LIMITS, 'anthropic:claude-sonnet-4-6');
  return {
    getInfo: () => ({ id: 'cron-budget-test', status: 'ready', turnCount: 1, createdAt: '' }),
    sendMessage: vi.fn(async () => {
      tracker.startTurn();
      try {
        for (const usage of steps) tracker.recordStep(usage);
        if (failWith) throw failWith;
        return 'done';
      } finally {
        tracker.endTurn();
      }
    }),
    getBudgetStatus: (): BudgetStatus => ({
      ...tracker.getSnapshot(),
      limits: LIMITS,
      tokenTrackingAvailable: true,
    }),
    close: vi.fn(async () => {}),
  } as unknown as Session;
}

describe('cron run records', () => {
  let home: string;
  let savedHome: string | undefined;
  let daemon: IronCurtainDaemon;

  function job(): JobDefinition {
    return {
      id: createJobId('budget-job'),
      name: 'Budget job',
      schedule: '0 9 * * *',
      taskDescription: 'do things',
      taskConstitution: 'The agent may read the workspace.',
      notifyOnEscalation: false,
      notifyOnCompletion: false,
      enabled: false,
    };
  }

  beforeEach(() => {
    savedHome = process.env.IRONCURTAIN_HOME;
    home = mkdtempSync(join(tmpdir(), 'ironcurtain-cron-budget-'));
    process.env.IRONCURTAIN_HOME = home;
    createSession.mockReset();
    daemon = new IronCurtainDaemon({ mode: { kind: 'builtin' }, noSignal: true });
  });

  /** Saves the job with the compiled policy executeJob requires before any run (WP-49). */
  async function saveJobWithPolicy(definition: JobDefinition): Promise<void> {
    await saveJob(definition);
    writeCompiledPolicyFor(getJobGeneratedDir(definition.id), definition.taskConstitution);
  }

  afterEach(() => {
    logger.teardown();
    if (savedHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('records the session totals of a completed run, with a non-zero cost', async () => {
    const session = trackedSession([stepUsage(100_000, 2_000), stepUsage(150_000, 3_000)]);
    createSession.mockResolvedValue(session);
    const definition = job();
    await saveJobWithPolicy(definition);

    const record = await daemon.runJobNow(definition.id);

    expect(record.outcome).toEqual({ kind: 'success' });
    // The per-turn view is already reset when the daemon reads the status...
    expect(session.getBudgetStatus().estimatedCostUsd).toBe(0);
    // ...so the record carries the cumulative totals: $0.75 input + $0.075 output.
    expect(record.budget.totalTokens).toBe(255_000);
    expect(record.budget.stepCount).toBe(2);
    expect(record.budget.estimatedCostUsd).toBeCloseTo(0.825, 9);
    expect(record.budget.estimatedCostUsd).toBeGreaterThan(0);
    expect(loadRecentRuns(definition.id, 1)[0]?.budget).toEqual(record.budget);
  });

  it('hands the session the cron defaults as baseline and the job limits as overrides (WP-126)', async () => {
    createSession.mockResolvedValue(trackedSession([stepUsage(1_000, 100)]));
    const definition: JobDefinition = { ...job(), budgetOverrides: { maxEstimatedCostUsd: 0.25, maxSteps: null } };
    await saveJobWithPolicy(definition);

    await daemon.runJobNow(definition.id);

    // The session layers them around a persona job's own resourceBudget:
    // job budgetOverrides > persona resourceBudget > cron defaults > global.
    expect(createSession).toHaveBeenCalledOnce();
    const [options] = createSession.mock.calls[0];
    expect(options.resourceBudgetBaseline).toEqual(CRON_BUDGET_DEFAULTS);
    expect(options.resourceBudgetOverrides).toEqual({ maxEstimatedCostUsd: 0.25, maxSteps: null });
    // Neither is patched into the config any more, where it would sit above the persona.
    expect(options.config?.userConfig.resourceBudget).toEqual({});
  });

  it('records a budget-stopped run as budget_exhausted with what it consumed', async () => {
    const error = new BudgetExhaustedError(
      'cost',
      'Cost budget exhausted: $2.10 / $2.00 estimated. Stopped after 3 steps without a final answer.',
    );
    createSession.mockResolvedValue(
      trackedSession([stepUsage(200_000, 6_000), stepUsage(200_000, 6_000), stepUsage(200_000, 6_000)], error),
    );
    const definition = job();
    await saveJobWithPolicy(definition);

    const record = await daemon.runJobNow(definition.id);

    expect(record.outcome).toEqual({ kind: 'budget_exhausted', dimension: 'cost' });
    expect(record.budget.stepCount).toBe(3);
    expect(record.budget.estimatedCostUsd).toBeCloseTo(3 * (0.6 + 0.09), 9);
  });

  it('records where the cost came from, so a run with no cost source reads "unknown" rather than $0.00', async () => {
    const session = trackedSession([]);
    const status = session.getBudgetStatus.bind(session);
    const unknownCost: Session = { ...session, getBudgetStatus: () => ({ ...status(), costSource: 'unknown' }) };
    createSession.mockResolvedValue(unknownCost);
    const definition = job();
    await saveJobWithPolicy(definition);

    const record = await daemon.runJobNow(definition.id);

    expect(record.outcome).toEqual({ kind: 'success' });
    expect(record.budget).toMatchObject({ estimatedCostUsd: 0, costSource: 'unknown' });
    expect(loadRecentRuns(definition.id, 1)[0]?.budget.costSource).toBe('unknown');
  });

  it('omits the cost source for a session that prices every step itself', async () => {
    createSession.mockResolvedValue(trackedSession([stepUsage(1_000, 10)]));
    const definition = job();
    await saveJobWithPolicy(definition);

    const record = await daemon.runJobNow(definition.id);

    expect(record.outcome).toEqual({ kind: 'success' });
    expect(record.budget.stepCount).toBe(1);
    expect(record.budget).not.toHaveProperty('costSource');
  });
});
