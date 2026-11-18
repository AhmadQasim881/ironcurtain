/**
 * `daemon list-jobs` (forwarded to the daemon, or read locally when no
 * daemon runs) and `daemon status` show how many runs in a row of a job
 * failed, so a scheduled job that fails silently is visible.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IronCurtainConfig } from '../src/config/types.js';
import { saveJob, saveRunRecord } from '../src/cron/job-store.js';
import { formatDaemonJobList, runListJobs, type DaemonJobListEntry } from '../src/cron/job-commands.js';
import { createJobId, type JobDefinition, type RunRecord } from '../src/cron/types.js';
import { sendControlRequest, type DaemonStatusDto } from '../src/daemon/control-socket.js';
import { runDaemonCommand } from '../src/daemon/daemon-command.js';
import { stripTerminalSequences } from '../src/terminal/display-sanitize.js';

vi.mock('../src/cron/compile-task-policy.js', () => ({ compileTaskPolicy: vi.fn() }));
vi.mock('../src/cron/constitution-generator.js', () => ({ generateConstitution: vi.fn() }));
vi.mock('../src/cron/job-customizer.js', () => ({ runJobConstitutionCustomizer: vi.fn() }));
vi.mock('../src/session/preflight.js', () => ({
  resolveSessionMode: vi.fn(async () => ({ mode: { kind: 'builtin' } })),
  formatModeLine: vi.fn(() => 'Mode: builtin'),
}));
vi.mock('../src/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config/index.js')>()),
  loadConfig: vi.fn(() => ({ protectedPaths: [] }) as unknown as IronCurtainConfig),
}));
vi.mock('../src/daemon/control-socket.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/daemon/control-socket.js')>()),
  sendControlRequest: vi.fn(),
}));

const sendRequest = vi.mocked(sendControlRequest);

function job(id: string): JobDefinition {
  return {
    id: createJobId(id),
    name: `Job ${id}`,
    schedule: '0 9 * * *',
    taskDescription: 'do things',
    taskConstitution: 'may read',
    notifyOnEscalation: false,
    notifyOnCompletion: false,
    enabled: true,
  };
}

function failedRun(startedAt: string): RunRecord {
  return {
    startedAt,
    completedAt: startedAt,
    outcome: { kind: 'error', phase: 'setup', message: 'Docker is not available' },
    budget: { totalTokens: 0, stepCount: 0, elapsedSeconds: 0, estimatedCostUsd: 0 },
    summary: null,
    escalationsEncountered: 0,
    escalationsApproved: 0,
    discardedChanges: null,
  };
}

describe('failure streaks in the job CLI', () => {
  let root: string;
  let savedHome: string | undefined;
  let output: string[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ironcurtain-streak-output-'));
    savedHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = root;
    output = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      output.push(stripTerminalSequences(args.map(String).join(' ')));
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    sendRequest.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = savedHome;
    rmSync(root, { recursive: true, force: true });
  });

  it('list-jobs from the daemon shows the streak next to the failed last run', () => {
    const entries: DaemonJobListEntry[] = [
      {
        job: job('failing-job'),
        nextRun: null,
        lastRun: failedRun('2026-11-11T09:00:00.000Z'),
        isRunning: false,
        consecutiveFailures: 3,
      },
      {
        job: job('older-daemon'),
        nextRun: null,
        lastRun: failedRun('2026-11-11T09:00:00.000Z'),
        isRunning: false,
      },
    ];

    formatDaemonJobList(entries);
    const text = output.join('\n');
    expect(text).toMatch(/error \(setup\): Docker is not available \[3 consecutive failures\]/);
    // A daemon that predates the field: the last run still shows, without a streak.
    expect(text.match(/consecutive failure/g)).toHaveLength(1);
  });

  it('list-jobs without a daemon counts the streak from the run records', async () => {
    const definition = job('local-job');
    await saveJob(definition);
    saveRunRecord(definition.id, failedRun('2026-11-10T09:00:00.000Z'));
    saveRunRecord(definition.id, failedRun('2026-11-11T09:00:00.000Z'));

    runListJobs();
    expect(output.join('\n')).toContain('[2 consecutive failures]');
  });

  it('status lists the failing jobs with their streaks', async () => {
    const status: DaemonStatusDto = {
      uptimeSeconds: 3_600,
      jobs: { total: 3, enabled: 3, running: 1, failing: 2 },
      failingJobs: [
        { jobId: 'nightly-report', name: 'Nightly report', consecutiveFailures: 100 },
        { jobId: 'issue-triage', name: 'Issue triage', consecutiveFailures: 1 },
      ],
      signalConnected: false,
      nextFireTime: null,
    };
    sendRequest.mockResolvedValue({ kind: 'response', response: { ok: true, data: status } });

    await runDaemonCommand(['status']);
    const text = output.join('\n');
    expect(text).toContain('3 total, 3 enabled, 1 running, 2 failing');
    expect(text).toContain('Failing job:        nightly-report (100+ consecutive failures)');
    expect(text).toContain('Failing job:        issue-triage (1 consecutive failure)');
  });

  it('status from an older daemon without failure fields keeps the old line', async () => {
    sendRequest.mockResolvedValue({
      kind: 'response',
      response: {
        ok: true,
        data: {
          uptimeSeconds: 60,
          jobs: { total: 1, enabled: 1, running: 0 },
          signalConnected: false,
          nextFireTime: null,
        },
      },
    });

    await runDaemonCommand(['status']);
    const text = output.join('\n');
    expect(text).toContain('1 total, 1 enabled, 0 running');
    expect(text).not.toContain('failing');
  });
});
