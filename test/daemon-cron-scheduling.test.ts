/**
 * The daemon's side of cron scheduling: what it does with the scheduler's
 * triggers.
 *
 * - A fire time missed while the machine slept runs only with
 *   `cron.catchUpMissedRuns` (standard cron skips it).
 * - `cron.maxConcurrentRuns` caps the runs the scheduler starts: a trigger
 *   beyond it waits in a queue (once per job) and starts when a run
 *   finishes; a job disabled meanwhile is dropped from the queue; manual runs
 *   are never refused but count toward the limit.
 * - start() reads both settings from the user config.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IronCurtainConfig } from '../src/config/types.js';
import { getJobGeneratedDir } from '../src/config/paths.js';
import type { ResolvedUserConfig } from '../src/config/user-config.js';
import type { JobTrigger } from '../src/cron/cron-scheduler.js';
import { saveJob } from '../src/cron/job-store.js';
import { createJobId, type JobDefinition } from '../src/cron/types.js';
import { IronCurtainDaemon } from '../src/daemon/ironcurtain-daemon.js';
import * as logger from '../src/logger.js';
import { createStandaloneSession } from '../src/session/index.js';
import type { Session } from '../src/session/types.js';
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
vi.mock('../src/config/user-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config/user-config.js')>()),
  loadUserConfig: vi.fn(
    () =>
      ({
        statistics: { enabled: false, retentionDays: null },
        cron: { maxConcurrentRuns: 2, catchUpMissedRuns: true },
      }) as unknown as ResolvedUserConfig,
  ),
}));

const createSession = vi.mocked(createStandaloneSession);

interface DaemonInternals {
  maxConcurrentCronRuns: number | null;
  catchUpMissedRuns: boolean;
  exitResolve: (() => void) | null;
  onJobTrigger(job: JobDefinition, trigger: JobTrigger): Promise<void>;
}

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('daemon cron scheduling', () => {
  let home: string;
  let savedHome: string | undefined;
  let daemon: IronCurtainDaemon;
  /** Releases the agent run of each job (by session task text = job id). */
  let release: Map<string, () => void>;
  let started: string[];

  function internals(): DaemonInternals {
    return daemon as unknown as DaemonInternals;
  }

  function job(id: string, overrides: Partial<JobDefinition> = {}): JobDefinition {
    return {
      id: createJobId(id),
      name: `Job ${id}`,
      schedule: '0 9 * * *',
      taskDescription: id,
      taskConstitution: 'The agent may read the workspace.',
      notifyOnEscalation: false,
      notifyOnCompletion: false,
      enabled: true,
      ...overrides,
    };
  }

  async function saveJobWithPolicy(definition: JobDefinition): Promise<void> {
    await saveJob(definition);
    writeCompiledPolicyFor(getJobGeneratedDir(definition.id), definition.taskConstitution);
  }

  function scheduled(): JobTrigger {
    return { kind: 'scheduled', scheduledFor: new Date() };
  }

  /** Lets the scheduled triggers and runs make progress. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  }

  async function waitFor(condition: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ic-daemon-cron-scheduling-'));
    savedHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = home;
    release = new Map();
    started = [];
    createSession.mockReset();
    createSession.mockImplementation(async () => {
      const done = deferred();
      return {
        getInfo: () => ({ id: `session-${started.length}` }),
        sendMessage: vi.fn(async (task: string) => {
          started.push(task);
          release.set(task, done.resolve);
          await done.promise;
          return 'done';
        }),
        resolveEscalation: vi.fn(async () => {}),
        getBudgetStatus: () => ({
          cumulative: { totalTokens: 0, stepCount: 0, activeSeconds: 0, estimatedCostUsd: 0 },
        }),
        close: vi.fn(async () => {}),
      } as unknown as Session;
    });
    daemon = new IronCurtainDaemon({ mode: { kind: 'builtin' }, noSignal: true });
  });

  afterEach(async () => {
    for (const finish of release.values()) finish();
    await daemon.shutdown();
    logger.teardown();
    if (savedHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('skips a missed fire time unless catching up is enabled, then runs it once', async () => {
    const definition = job('sleepy');
    await saveJobWithPolicy(definition);
    const missed: JobTrigger = { kind: 'missed', scheduledFor: new Date(Date.now() - 3 * 3_600_000) };

    await internals().onJobTrigger(definition, missed);
    expect(createSession).not.toHaveBeenCalled();

    internals().catchUpMissedRuns = true;
    const run = internals().onJobTrigger(definition, missed);
    await waitFor(() => started.length === 1, 'the caught-up run');
    release.get('sleepy')?.();
    await run;
    expect(started).toEqual(['sleepy']);
  });

  it('queues scheduled runs beyond cron.maxConcurrentRuns and starts them as runs finish', async () => {
    internals().maxConcurrentCronRuns = 1;
    const first = job('first');
    const second = job('second');
    await saveJobWithPolicy(first);
    await saveJobWithPolicy(second);
    // Both scheduled, as start() or reload-job leaves them.
    await daemon.reloadJob(first.id);
    await daemon.reloadJob(second.id);

    const firstRun = internals().onJobTrigger(first, scheduled());
    await waitFor(() => started.length === 1, 'the first run');
    await internals().onJobTrigger(second, scheduled());
    // A second trigger of a queued job does not queue it twice.
    await internals().onJobTrigger(second, scheduled());

    expect(started).toEqual(['first']);
    expect(daemon.listJobs().find((entry) => entry.job.id === second.id)).toMatchObject({
      isRunning: false,
      isQueued: true,
    });

    release.get('first')?.();
    await firstRun;
    await waitFor(() => started.length === 2, 'the queued run');
    expect(started).toEqual(['first', 'second']);
    expect(daemon.listJobs().find((entry) => entry.job.id === second.id)).toMatchObject({
      isRunning: true,
      isQueued: false,
    });
    release.get('second')?.();
    await waitFor(() => daemon.getStatus().jobs.running === 0, 'the second run to end');
    expect(createSession).toHaveBeenCalledTimes(2);
  });

  it('drops a queued run of a job that is disabled while it waits', async () => {
    internals().maxConcurrentCronRuns = 1;
    const first = job('first');
    const second = job('second');
    await saveJobWithPolicy(first);
    await saveJobWithPolicy(second);
    await daemon.reloadJob(first.id);
    await daemon.reloadJob(second.id);

    const firstRun = internals().onJobTrigger(first, scheduled());
    await waitFor(() => started.length === 1, 'the first run');
    await internals().onJobTrigger(second, scheduled());
    await daemon.disableJob(second.id);

    release.get('first')?.();
    await firstRun;
    await settle();
    expect(started).toEqual(['first']);
    expect(daemon.listJobs().find((entry) => entry.job.id === second.id)?.isQueued).toBe(false);
  });

  it('never refuses a manual run, which still counts toward the limit', async () => {
    internals().maxConcurrentCronRuns = 1;
    const manual = job('manual');
    const timed = job('timed');
    await saveJobWithPolicy(manual);
    await saveJobWithPolicy(timed);
    await daemon.reloadJob(timed.id);

    const first = daemon.startJobRun(manual.id);
    await waitFor(() => started.length === 1, 'the manual run');
    // A second manual run of another job is not refused by the limit.
    const other = job('other');
    await saveJobWithPolicy(other);
    const second = daemon.startJobRun(other.id);
    await waitFor(() => started.length === 2, 'the second manual run');

    await internals().onJobTrigger(timed, scheduled());
    expect(started).toEqual(['manual', 'other']);
    expect(daemon.listJobs().find((entry) => entry.job.id === timed.id)?.isQueued).toBe(true);

    release.get('manual')?.();
    await first.completion;
    // Still one run in progress: the limit is 1, so the queued run waits.
    await settle();
    expect(started).toEqual(['manual', 'other']);

    release.get('other')?.();
    await second.completion;
    await waitFor(() => started.length === 3, 'the queued run');
    expect(started[2]).toBe('timed');
  });

  it('reads cron.maxConcurrentRuns and cron.catchUpMissedRuns at start', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true); // start-up banner
    const running = daemon.start();
    await waitFor(() => internals().exitResolve !== null, 'the daemon to start');
    expect(internals().maxConcurrentCronRuns).toBe(2);
    expect(internals().catchUpMissedRuns).toBe(true);
    await daemon.shutdown();
    await running;
    stderr.mockRestore();
  });
});
