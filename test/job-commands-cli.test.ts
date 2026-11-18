/**
 * `ironcurtain daemon` job commands against a running daemon (WP-52: WFC-15,
 * WFC-23, WFC-12).
 *
 * - add-job used to save and compile the job and never tell a running daemon,
 *   which loads jobs only at startup: the job never fired until a restart.
 *   A reload the daemon refuses, or takes and never answers, is reported and
 *   exits 1.
 * - recompile-job reloads the job after compiling, and the recovery steps a
 *   failed add-job prints (recompile-job, then enable-job) schedule it.
 * - A compile that wrote the policy without some servers (`failedServers`)
 *   used to be reported as a plain success: add-job now keeps the job
 *   disabled, and add-job and recompile-job (run here or by the daemon,
 *   whose reply names the servers) name them and exit 2.
 * - remove-job skipped its confirmation whenever a daemon was running and
 *   deleted the workspace and run history at once; an unknown id was reported
 *   as removed.
 * - Job listings and logs printed agent-written summaries and error messages
 *   with their terminal control sequences intact.
 *
 * The daemon here is a real IronCurtainDaemon started with `start()` (control
 * socket only: no Signal, no web UI) in a temporary IRONCURTAIN_HOME. Prompts,
 * the editor, the session-mode preflight and policy compilation are mocked.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import chalk from 'chalk';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as prompts from '@clack/prompts';
import { getDaemonSocketPath, getJobGeneratedDir } from '../src/config/paths.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import { compileTaskPolicy, type TaskPolicyJob } from '../src/cron/compile-task-policy.js';
import {
  formatDaemonJobList,
  runAddJobWizard,
  runEditJobWizard,
  runShowLogs,
  type DaemonJobListEntry,
} from '../src/cron/job-commands.js';
import { loadJob, saveJob, saveRunRecord } from '../src/cron/job-store.js';
import { createJobId, type JobDefinition, type RunRecord } from '../src/cron/types.js';
import { isDaemonRunning, sendControlRequest } from '../src/daemon/control-socket.js';
import { runDaemonCommand } from '../src/daemon/daemon-command.js';
import { IronCurtainDaemon } from '../src/daemon/ironcurtain-daemon.js';
import * as logger from '../src/logger.js';
import type { CompiledPolicyFile } from '../src/pipeline/types.js';
import { openEditorForMultiline } from '../src/utils/editor.js';
import { writeCompiledPolicyFor } from './fixtures/scoped-policy.js';

vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn(() => false),
  select: vi.fn(),
  text: vi.fn(),
  confirm: vi.fn(),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), step: vi.fn(), success: vi.fn(), message: vi.fn() },
}));
vi.mock('../src/utils/editor.js', () => ({ openEditorForMultiline: vi.fn() }));
vi.mock('../src/cron/compile-task-policy.js', () => ({ compileTaskPolicy: vi.fn() }));
vi.mock('../src/session/index.js', () => ({ createStandaloneSession: vi.fn() }));
vi.mock('../src/session/preflight.js', () => ({
  resolveSessionMode: vi.fn(async () => ({ mode: { kind: 'builtin' } })),
  formatModeLine: vi.fn(() => '[mode] builtin'),
}));
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

const ESC = '\u001b';
const BEL = '\u0007';

class ExitCalled extends Error {
  constructor(readonly code: number | string | null | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

let home: string;
let savedHome: string | undefined;
let daemon: IronCurtainDaemon | undefined;
let daemonStopped: Promise<void> | undefined;

function job(id: string, overrides: Partial<JobDefinition> = {}): JobDefinition {
  return {
    id: createJobId(id),
    name: `Job ${id}`,
    schedule: '0 9 * * *',
    taskDescription: 'Summarize the repository.',
    taskConstitution: 'The agent may read files in its workspace.',
    gitRepo: undefined,
    notifyOnEscalation: false,
    notifyOnCompletion: false,
    enabled: true,
    ...overrides,
  };
}

/** Starts a daemon in the temporary home and waits until its control socket answers. */
async function startDaemon(): Promise<IronCurtainDaemon> {
  const started = new IronCurtainDaemon({ mode: { kind: 'builtin' }, noSignal: true });
  daemon = started;
  daemonStopped = started.start();
  const deadline = Date.now() + 10_000;
  while (!(await isDaemonRunning())) {
    if (Date.now() > deadline) throw new Error('daemon control socket did not come up');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  return started;
}

async function listedJob(jobId: string): Promise<DaemonJobListEntry | undefined> {
  const result = await sendControlRequest({ command: 'list-jobs' });
  if (result.kind !== 'response' || !result.response.ok) {
    throw new Error(`list-jobs failed: ${JSON.stringify(result)}`);
  }
  return (result.response.data as DaemonJobListEntry[]).find((entry) => entry.job.id === jobId);
}

/** Stand-in control-socket servers started by a test; closed in afterEach. */
const stubServers: Server[] = [];

/**
 * Binds a stand-in "daemon" on the control socket that answers every request
 * with `onRequest` (or, without it, drops the connection unanswered).
 */
async function listenOnControlSocket(onRequest?: (line: string) => string): Promise<Server> {
  const server = createServer((socket) => {
    if (!onRequest) {
      socket.destroy();
      return;
    }
    socket.once('data', (chunk: Buffer) => socket.end(`${onRequest(chunk.toString('utf8'))}\n`));
  });
  await new Promise<void>((resolveListen) => server.listen(getDaemonSocketPath(), resolveListen));
  stubServers.push(server);
  return server;
}

/** Scripts the add-job review loop: set the id, the task, the constitution, then confirm. */
function scriptAddJobWizard(jobId: string): void {
  vi.mocked(prompts.select)
    .mockResolvedValueOnce('id')
    .mockResolvedValueOnce('taskDescription')
    .mockResolvedValueOnce('taskConstitution')
    .mockResolvedValueOnce('confirm');
  vi.mocked(prompts.text).mockResolvedValueOnce(jobId);
  // Declines the offer to generate a constitution after the task is entered.
  vi.mocked(prompts.confirm).mockResolvedValueOnce(false);
  vi.mocked(openEditorForMultiline)
    .mockReturnValueOnce('Summarize the repository every morning.')
    .mockReturnValueOnce('The agent may read files in its workspace.');
}

/**
 * A compile that wrote the job's policy without `failed`, as the pipeline
 * does when those servers fail to compile: they are listed in
 * `failedServers` and have no rules.
 */
function partialCompile(failed: readonly string[]): (job: TaskPolicyJob) => Promise<CompiledPolicyFile> {
  return async (compiled: TaskPolicyJob) => {
    const generatedDir = getJobGeneratedDir(compiled.id);
    writeCompiledPolicyFor(generatedDir, compiled.taskConstitution, {
      failedServers: failed.map((serverName) => ({
        serverName,
        phase: 'verifying',
        reason: 'Verification still failing after 3 repair attempt(s).',
      })),
    });
    return JSON.parse(readFileSync(join(generatedDir, 'compiled-policy.json'), 'utf-8')) as CompiledPolicyFile;
  };
}

/** Captures console.error lines (job listings print there). */
function captureConsoleError(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  return lines;
}

beforeAll(() => {
  // Plain text, so assertions see exactly what the commands wrote.
  chalk.level = 0;
});

beforeEach(() => {
  savedHome = process.env.IRONCURTAIN_HOME;
  home = mkdtempSync(join(tmpdir(), 'ic-job-cli-'));
  process.env.IRONCURTAIN_HOME = home;
  // No metrics database for a test daemon.
  writeFileSync(join(home, 'config.json'), JSON.stringify({ statistics: { enabled: false } }));
  vi.clearAllMocks();
  // Drop answers a failed test may have left queued.
  for (const scripted of [prompts.select, prompts.text, prompts.confirm, openEditorForMultiline]) {
    vi.mocked(scripted).mockReset();
  }
  // Like the real compile: writes generated/compiled-policy.json recording the
  // hash of the constitution it was given, so the job's policy checks out, and
  // returns the policy it wrote.
  vi.mocked(compileTaskPolicy).mockReset();
  vi.mocked(compileTaskPolicy).mockImplementation(async (job: TaskPolicyJob) => {
    const generatedDir = getJobGeneratedDir(job.id);
    writeCompiledPolicyFor(generatedDir, job.taskConstitution);
    return JSON.parse(readFileSync(join(generatedDir, 'compiled-policy.json'), 'utf-8')) as CompiledPolicyFile;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  for (const server of stubServers.splice(0)) {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
  if (daemon) {
    await daemon.shutdown();
    await daemonStopped;
    daemon = undefined;
    daemonStopped = undefined;
  }
  logger.teardown();
  if (savedHome === undefined) delete process.env.IRONCURTAIN_HOME;
  else process.env.IRONCURTAIN_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

describe('add-job with a running daemon', () => {
  it('schedules the new job in the running daemon: it gets a next run without a restart', async () => {
    await startDaemon();
    expect(await listedJob('nightly-report')).toBeUndefined();

    scriptAddJobWizard('nightly-report');
    await runAddJobWizard();

    expect(loadJob(createJobId('nightly-report'))).toBeDefined();
    expect(compileTaskPolicy).toHaveBeenCalledTimes(1);
    const entry = await listedJob('nightly-report');
    expect(entry?.job.enabled).toBe(true);
    expect(entry?.nextRun).toEqual(expect.any(String));
    expect(new Date(entry?.nextRun ?? 0).getTime()).toBeGreaterThan(Date.now());
    expect(vi.mocked(prompts.outro)).toHaveBeenCalledWith(
      expect.stringContaining('scheduled by the running daemon. Next run:'),
    );
  });

  it('without a daemon, saves the job and says it runs once the daemon is started', async () => {
    scriptAddJobWizard('offline-job');
    await runAddJobWizard();

    expect(loadJob(createJobId('offline-job'))?.enabled).toBe(true);
    expect(vi.mocked(prompts.outro)).toHaveBeenCalledWith(expect.stringContaining('once the daemon is running'));
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('reports a reload the daemon refused as NOT scheduled, with its error escaped, and exits 1', async () => {
    const requests: string[] = [];
    await listenOnControlSocket((line) => {
      requests.push(line);
      return JSON.stringify({ ok: false, error: `schedule rejected ${ESC}[2J` });
    });
    const lines = captureConsoleError();

    scriptAddJobWizard('refused-job');
    await runAddJobWizard();

    expect(requests.map((line) => JSON.parse(line) as unknown)).toEqual([
      { command: 'reload-job', jobId: 'refused-job' },
    ]);
    expect(lines.join('\n')).toContain('The running daemon did not schedule the job: schedule rejected \\u001b[2J');
    expect(lines.join('\n').includes(ESC)).toBe(false);
    expect(vi.mocked(prompts.outro)).toHaveBeenCalledWith(expect.stringContaining('saved but NOT scheduled'));
    expect(process.exitCode).toBe(1);
  });

  it('reports a reload the daemon took but never answered as unconfirmed, and exits 1', async () => {
    // A daemon that accepts the connection and drops it: it may or may not
    // have reloaded the job, so the wizard must not claim either.
    await listenOnControlSocket();
    const lines = captureConsoleError();

    scriptAddJobWizard('unconfirmed-job');
    await runAddJobWizard();

    expect(loadJob(createJobId('unconfirmed-job'))?.enabled).toBe(true);
    expect(lines.join('\n')).toContain('Could not confirm that the running daemon scheduled the job');
    expect(vi.mocked(prompts.outro)).toHaveBeenCalledWith(expect.stringContaining('ironcurtain daemon list-jobs'));
    expect(vi.mocked(prompts.outro)).not.toHaveBeenCalledWith(expect.stringContaining('scheduled by the running'));
    expect(process.exitCode).toBe(1);
  });

  it('a failed compile leaves the job disabled and never sends it to the daemon', async () => {
    const requests: string[] = [];
    await listenOnControlSocket((line) => {
      requests.push(line);
      return JSON.stringify({ ok: true });
    });
    vi.mocked(compileTaskPolicy).mockRejectedValueOnce(new Error(`verification failed ${ESC}]0;title${BEL}`));
    vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
      throw new ExitCalled(code);
    });
    const lines = captureConsoleError();

    scriptAddJobWizard('broken-job');
    await expect(runAddJobWizard()).rejects.toMatchObject({ code: 1 });

    expect(loadJob(createJobId('broken-job'))?.enabled).toBe(false);
    expect(requests).toEqual([]);
    const output = lines.join('\n');
    expect(output).toContain('Policy compilation failed: verification failed \\u001b]0;title\\u0007');
    expect(output).toContain(
      'ironcurtain daemon recompile-job broken-job and ironcurtain daemon enable-job broken-job',
    );
    expect(output.includes(ESC)).toBe(false);
  });

  it('a compile that left servers out keeps the job disabled, names them and exits 2', async () => {
    const requests: string[] = [];
    await listenOnControlSocket((line) => {
      requests.push(line);
      return JSON.stringify({ ok: true });
    });
    vi.mocked(compileTaskPolicy).mockImplementationOnce(partialCompile(['git', 'github']));
    vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
      throw new ExitCalled(code);
    });
    const lines = captureConsoleError();

    scriptAddJobWizard('partial-job');
    await expect(runAddJobWizard()).rejects.toMatchObject({ code: 2 });

    // Saved, with its policy, but not scheduled: it would run without those servers' tools.
    expect(loadJob(createJobId('partial-job'))?.enabled).toBe(false);
    expect(requests).toEqual([]);
    const output = lines.join('\n');
    expect(output).toContain(
      "2 server(s) failed to compile and have no rules, so the job's calls to their tools are denied until a " +
        'compile succeeds: git, github.',
    );
    expect(output).toContain('ironcurtain daemon recompile-job partial-job');
    expect(output).toContain('ironcurtain daemon enable-job partial-job');
    expect(vi.mocked(prompts.outro)).not.toHaveBeenCalled();
  });
});

describe('job changes through the control socket', () => {
  it('tell web UI clients to refresh their job list (job.list_changed)', async () => {
    const running = await startDaemon();
    const emit = vi.fn();
    // Stands in for the web UI server, which this test daemon does not start.
    (running as unknown as { webUiServer: unknown }).webUiServer = {
      getEventBus: () => ({ emit }),
      stop: vi.fn(async () => {}),
    };
    await saveJob(job('watched'));

    expect(await sendControlRequest({ command: 'reload-job', jobId: 'watched' })).toEqual({
      kind: 'response',
      response: { ok: true },
    });
    expect(emit).toHaveBeenCalledWith('job.list_changed', {});

    // A refused change emits nothing.
    emit.mockClear();
    const refused = await sendControlRequest({ command: 'enable-job', jobId: 'ghost' });
    expect(refused).toEqual({ kind: 'response', response: { ok: false, error: 'Job not found: ghost' } });
    expect(emit).not.toHaveBeenCalled();
  });
});

describe('recompile-job with a running daemon', () => {
  it('reloads the job after compiling: an enabled job saved after startup gets a next run', async () => {
    await startDaemon();
    // Saved after startup and never reloaded (written by hand, or by an
    // add-job whose reload failed): enabled, but not scheduled.
    await saveJob(job('recovered'));
    expect((await listedJob('recovered'))?.nextRun).toBeNull();

    const result = await sendControlRequest({ command: 'recompile-job', jobId: 'recovered' });

    // The reply says which servers the written policy left out: none here.
    expect(result).toEqual({ kind: 'response', response: { ok: true, data: { failedServers: [] } } });
    expect(compileTaskPolicy).toHaveBeenCalledTimes(1);
    expect((await listedJob('recovered'))?.nextRun).toEqual(expect.any(String));
  });

  it('the recovery steps a failed add-job prints (recompile-job, then enable-job) schedule the job', async () => {
    await startDaemon();
    // As after a failed add-job compile: saved disabled, with no policy.
    await saveJob(job('failed-add', { enabled: false }));

    expect(await sendControlRequest({ command: 'recompile-job', jobId: 'failed-add' })).toEqual({
      kind: 'response',
      response: { ok: true, data: { failedServers: [] } },
    });
    expect((await listedJob('failed-add'))?.nextRun).toBeNull();

    expect(await sendControlRequest({ command: 'enable-job', jobId: 'failed-add' })).toEqual({
      kind: 'response',
      response: { ok: true },
    });
    expect((await listedJob('failed-add'))?.nextRun).toEqual(expect.any(String));
  });

  it('a recompile that left servers out names them and exits 2; the job keeps running under the policy', async () => {
    await startDaemon();
    await saveJob(job('partial-daemon'));
    vi.mocked(compileTaskPolicy).mockImplementation(partialCompile(['git']));

    expect(await sendControlRequest({ command: 'recompile-job', jobId: 'partial-daemon' })).toEqual({
      kind: 'response',
      response: { ok: true, data: { failedServers: ['git'] } },
    });

    const lines = captureConsoleError();
    await runDaemonCommand(['recompile-job', 'partial-daemon']);

    const output = lines.join('\n');
    expect(output).toContain('Job "partial-daemon" policy recompiled (daemon notified).');
    expect(output).toContain(
      "1 server(s) failed to compile and have no rules, so the job's calls to their tools are denied until a " +
        'compile succeeds: git.',
    );
    expect(process.exitCode).toBe(2);
    expect((await listedJob('partial-daemon'))?.nextRun).toEqual(expect.any(String));
  });
});

describe('recompile-job without a daemon', () => {
  it('names the servers a recompile left out and exits 2', async () => {
    await saveJob(job('partial-local'));
    vi.mocked(compileTaskPolicy).mockImplementationOnce(partialCompile(['git']));
    const lines = captureConsoleError();

    await runDaemonCommand(['recompile-job', 'partial-local']);

    const output = lines.join('\n');
    expect(output).toContain(
      "1 server(s) failed to compile and have no rules, so the job's calls to their tools are denied until a " +
        'compile succeeds: git.',
    );
    expect(output).toContain('Done, with failed servers.');
    expect(process.exitCode).toBe(2);
  });

  it('exits 0 when every server compiled', async () => {
    await saveJob(job('complete-local'));
    const lines = captureConsoleError();

    await runDaemonCommand(['recompile-job', 'complete-local']);

    expect(lines).toContain('Done.');
    expect(lines.join('\n')).not.toContain('failed to compile');
    expect(process.exitCode ?? 0).toBe(0);
  });
});

describe('remove-job', () => {
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
      throw new ExitCalled(code);
    });
  });

  it('asks before removing through a running daemon; declining keeps the job', async () => {
    const running = await startDaemon();
    const removeJob = vi.spyOn(running, 'removeJob');
    await saveJob(job('keep-me'));
    vi.mocked(prompts.confirm).mockResolvedValueOnce(false);

    await runDaemonCommand(['remove-job', 'keep-me']);

    expect(prompts.confirm).toHaveBeenCalledTimes(1);
    expect(vi.mocked(prompts.confirm).mock.calls[0][0].message).toContain('Remove "Job keep-me"?');
    expect(removeJob).not.toHaveBeenCalled();
    expect(loadJob(createJobId('keep-me'))).toBeDefined();

    vi.mocked(prompts.confirm).mockResolvedValueOnce(true);
    await runDaemonCommand(['remove-job', 'keep-me']);

    expect(removeJob).toHaveBeenCalledWith('keep-me');
    expect(loadJob(createJobId('keep-me'))).toBeUndefined();
  });

  it('removes without asking when given --force', async () => {
    const running = await startDaemon();
    const removeJob = vi.spyOn(running, 'removeJob');
    await saveJob(job('forced'));

    await runDaemonCommand(['remove-job', 'forced', '--force']);

    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(removeJob).toHaveBeenCalledWith('forced');
    expect(loadJob(createJobId('forced'))).toBeUndefined();
  });

  it('asks before removing when no daemon is running', async () => {
    await saveJob(job('local-job'));
    vi.mocked(prompts.confirm).mockResolvedValueOnce(false);

    await runDaemonCommand(['remove-job', 'local-job']);

    expect(prompts.confirm).toHaveBeenCalledTimes(1);
    expect(loadJob(createJobId('local-job'))).toBeDefined();
  });

  it('reports an unknown id as not found instead of removed', async () => {
    await startDaemon();

    expect(await sendControlRequest({ command: 'remove-job', jobId: 'ghost' })).toEqual({
      kind: 'response',
      response: { ok: false, error: 'Job not found: ghost' },
    });
    // The CLI exits 1 both when it checks first (prompt) and when the daemon refuses (--force).
    await expect(runDaemonCommand(['remove-job', 'ghost'])).rejects.toMatchObject({ code: 1 });
    await expect(runDaemonCommand(['remove-job', 'ghost', '-f'])).rejects.toMatchObject({ code: 1 });
    expect(prompts.confirm).not.toHaveBeenCalled();
  });
});

describe('job listings and logs', () => {
  const hostileSummary = `${ESC}[2J${ESC}[HAll checks passed ${ESC}]52;c;cm0gLXJmIH4K${BEL}‮txt\nsecond line`;

  function runRecord(overrides: Partial<RunRecord> = {}): RunRecord {
    return {
      startedAt: '2026-11-10T09:00:00.000Z',
      completedAt: '2026-11-10T09:05:00.000Z',
      outcome: { kind: 'error', message: `git failed ${ESC}[31mred${ESC}[0m\r\nfatal` },
      budget: { totalTokens: 10, stepCount: 1, elapsedSeconds: 300, estimatedCostUsd: 0.12 },
      summary: hostileSummary,
      escalationsEncountered: 0,
      escalationsApproved: 0,
      discardedChanges: null,
      ...overrides,
    };
  }

  function expectNoRawControls(lines: readonly string[]): void {
    for (const line of lines) {
      expect(line.includes(ESC)).toBe(false);
      expect(line.includes(BEL)).toBe(false);
      expect(line.includes('‮')).toBe(false);
      expect(line.includes('\r')).toBe(false);
    }
  }

  it('list-jobs shows agent-written summaries and errors with visible escapes', () => {
    const lines = captureConsoleError();

    formatDaemonJobList([
      {
        job: job('report', { name: `Report${ESC}]0;title${BEL}` }),
        nextRun: new Date(Date.now() + 3_600_000).toISOString(),
        lastRun: runRecord(),
        isRunning: false,
      },
    ]);

    const output = lines.join('\n');
    expectNoRawControls(lines);
    expect(output).toContain('Report\\u001b]0;title\\u0007');
    expect(output).toContain('\\u001b[2J\\u001b[HAll checks passed');
    expect(output).toContain('error: git failed \\u001b[31mred\\u001b[0m\\r\\nfatal');
    expect(output).not.toContain('second line');
  });

  it('list-jobs flags an enabled job that the daemon has not scheduled', () => {
    const lines = captureConsoleError();

    formatDaemonJobList([
      { job: job('unscheduled'), nextRun: null, lastRun: undefined, isRunning: false },
      { job: job('paused', { enabled: false }), nextRun: null, lastRun: undefined, isRunning: false },
      { job: job('fine'), nextRun: new Date(Date.now() + 60_000).toISOString(), lastRun: undefined, isRunning: false },
    ]);

    const lineFor = (id: string): string => lines.find((line) => line.includes(id)) ?? '';
    expect(lineFor('unscheduled')).toContain('NOT SCHEDULED');
    expect(lineFor('paused')).toContain('DISABLED');
    expect(lineFor('paused')).not.toContain('NOT SCHEDULED');
    expect(lineFor('fine')).not.toContain('NOT SCHEDULED');
  });

  it('daemon logs shows run summaries with visible escapes', async () => {
    await saveJob(job('logged'));
    saveRunRecord(createJobId('logged'), runRecord());
    const lines = captureConsoleError();

    runShowLogs('logged', 5);

    expectNoRawControls(lines);
    expect(lines.join('\n')).toContain('\\u001b[2J\\u001b[HAll checks passed');
  });

  it('daemon logs lists the first line of each notice a run recorded, with visible escapes', async () => {
    // FU-10: the run's session notices (a stale policy, host-mount findings)
    // are kept in its record; nobody watched the run.
    await saveJob(job('noticed'));
    saveRunRecord(
      createJobId('noticed'),
      runRecord({
        notices: [
          '[policy] Warning: the compiled policy at /p may be stale:\n  - it records no provenance',
          `[host-files] Warning (session end): files ${ESC}[2J\n  /w/sh`,
        ],
      }),
    );
    const lines = captureConsoleError();

    runShowLogs('noticed', 5);

    expectNoRawControls(lines);
    expect(lines).toContain('    notice: [policy] Warning: the compiled policy at /p may be stale:');
    expect(lines).toContain('    notice: [host-files] Warning (session end): files \\u001b[2J');
    expect(lines.join('\n')).not.toContain('it records no provenance');
  });
});

describe('invalid job.json files', () => {
  /** Writes a job.json the way a crash mid-write (before atomic writes) left it: cut in half. */
  function writeTornJob(id: string): void {
    const dir = join(home, 'jobs', id);
    mkdirSync(dir, { recursive: true });
    const full = JSON.stringify(job(id), null, 2);
    writeFileSync(join(dir, 'job.json'), full.slice(0, Math.floor(full.length / 2)));
  }

  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
      throw new ExitCalled(code);
    });
  });

  it('list-jobs lists a truncated job.json as INVALID with the reason, without a daemon', async () => {
    await saveJob(job('healthy'));
    writeTornJob('torn');
    const lines = captureConsoleError();

    await runDaemonCommand(['list-jobs']);

    const output = lines.join('\n');
    expect(output).toContain('healthy');
    expect(lines.find((line) => line.includes('torn'))).toMatch(/torn\s+INVALID: not valid JSON/);
    expect(output).toContain(join(home, 'jobs', 'torn', 'job.json'));
    expect(output).not.toContain('No jobs configured');
  });

  it('list-jobs through a running daemon lists it as INVALID too', async () => {
    await startDaemon();
    await saveJob(job('healthy'));
    writeTornJob('torn');
    const lines = captureConsoleError();

    await runDaemonCommand(['list-jobs']);

    expect(lines.join('\n')).toContain('Jobs (from running daemon):');
    expect(lines.find((line) => line.includes('torn'))).toMatch(/INVALID: not valid JSON/);
  });

  it('job commands report the job as invalid, not as not found, and remove-job still removes it', async () => {
    await startDaemon();
    writeTornJob('torn');

    const refused = await sendControlRequest({ command: 'enable-job', jobId: 'torn' });
    expect(refused).toMatchObject({ kind: 'response', response: { ok: false } });
    const error = refused.kind === 'response' && !refused.response.ok ? refused.response.error : '';
    expect(error).toContain('Job "torn" cannot be used: its job.json is invalid (not valid JSON');

    await runDaemonCommand(['remove-job', 'torn', '--force']);
    expect(existsSync(join(home, 'jobs', 'torn'))).toBe(false);
  });

  it('without a daemon, enable-job explains the invalid file and remove-job removes it', async () => {
    writeTornJob('torn');
    const lines = captureConsoleError();

    await expect(runDaemonCommand(['enable-job', 'torn'])).rejects.toMatchObject({ code: 1 });
    expect(lines.join('\n')).toContain('its job.json is invalid (not valid JSON');
    expect(lines.join('\n')).toContain('ironcurtain daemon remove-job torn');

    vi.mocked(prompts.confirm).mockResolvedValueOnce(true);
    await runDaemonCommand(['remove-job', 'torn']);
    expect(vi.mocked(prompts.confirm).mock.calls[0][0].message).toContain('torn (invalid job.json)');
    expect(existsSync(join(home, 'jobs', 'torn'))).toBe(false);
  });
});

describe('edit-job', () => {
  it('saves only the edited fields, keeping a disable made while the editor was open', async () => {
    await saveJob(job('edited'));
    // The wizard opens on the enabled job; meanwhile disable-job runs.
    vi.mocked(prompts.select).mockImplementationOnce(async () => {
      await runDaemonCommand(['disable-job', 'edited']);
      return 'name';
    });
    vi.mocked(prompts.text).mockResolvedValueOnce('Renamed job');
    vi.mocked(prompts.select).mockResolvedValueOnce('confirm');
    captureConsoleError();

    await runEditJobWizard('edited');

    expect(loadJob(createJobId('edited'))).toMatchObject({ name: 'Renamed job', enabled: false });
  });
});
