/**
 * Cron job execution in the daemon (executeJob and its callers):
 *
 * - a run is reserved synchronously before its git sync, so a scheduled
 *   trigger, a CLI run-job or a web jobs.run during a long sync (or a slow
 *   session start) never starts a second run, and jobs.run refuses before it
 *   replies "accepted";
 * - one run per workspace: a run holds the workspace lock workflows take from
 *   before its git sync until its session has ended, and a job whose
 *   workspace another job's run or a workflow holds is refused before its
 *   sync or session, with a record and the "Not run" notice;
 * - every run that starts ends with a run record and, when asked for, a Signal
 *   notice: failures in setup, sync and session included; a failing record
 *   write never leaves the job marked running; the daemon log is re-claimed;
 * - a custom workspace is used in the canonical form validateWorkspacePath
 *   returns (`~/projects/foo`, symlinks);
 * - last-run.md is untrusted: moved aside before each run, read after
 *   teardown without following a symlink or opening a FIFO, bounded and
 *   stripped of control characters;
 * - escalation callbacks route by the run's own session label;
 * - removing a job cancels its run and keeps no record or directory;
 * - list-jobs and status report consecutive failures.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi, type Mock } from 'vitest';

import type { IronCurtainConfig } from '../src/config/types.js';
import {
  getDaemonLogPath,
  getJobDir,
  getJobGeneratedDir,
  getJobWorkspaceDir,
  getWorkflowWorkspaceLocksDir,
} from '../src/config/paths.js';
import { syncGitRepo, type GitSyncOptions, type GitSyncResult } from '../src/cron/git-sync.js';
import { loadRecentRuns, saveJob, saveRunRecord } from '../src/cron/job-store.js';
import { createJobId, type JobDefinition, type JobId } from '../src/cron/types.js';
import type { JobTrigger } from '../src/cron/cron-scheduler.js';
import type { ControlRequestHandler } from '../src/daemon/control-socket.js';
import { IronCurtainDaemon } from '../src/daemon/ironcurtain-daemon.js';
import * as logger from '../src/logger.js';
import { createStandaloneSession } from '../src/session/index.js';
import type { SessionManager } from '../src/session/session-manager.js';
import type { EscalationRequest, Session, SessionOptions } from '../src/session/types.js';
import { jobDispatch } from '../src/web-ui/dispatch/job-dispatch.js';
import type { DispatchContext } from '../src/web-ui/dispatch/types.js';
import { WebEventBus } from '../src/web-ui/web-event-bus.js';
import { claimWorkflowWorkspaceLock, isWorkflowLockBusyError } from '../src/workflow/run-lock.js';
import { writeCompiledPolicyFor } from './fixtures/scoped-policy.js';
import { fifoSupported, makeFifo, startFifoUnblocker, type FifoUnblocker } from './helpers/fifo.js';

vi.mock('../src/session/index.js', () => ({ createStandaloneSession: vi.fn() }));
// Returns a policy as the real compile does (addJob reads its failedServers).
vi.mock('../src/cron/compile-task-policy.js', () => ({
  compileTaskPolicy: vi.fn(async () => ({
    generatedAt: 'test',
    constitutionHash: 'test',
    inputHash: 'test',
    rules: [],
  })),
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
vi.mock('../src/cron/git-sync.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/cron/git-sync.js')>()),
  syncGitRepo: vi.fn(),
}));
vi.mock('../src/cron/job-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/cron/job-store.js')>();
  return { ...actual, saveRunRecord: vi.fn(actual.saveRunRecord) };
});

const createSession = vi.mocked(createStandaloneSession);
const syncMock = vi.mocked(syncGitRepo);
const saveRunRecordMock = vi.mocked(saveRunRecord);

const SYNC_OK: GitSyncResult = { ok: true, branch: 'main', commit: 'abc1234', discardedChanges: null, warnings: [] };
const NO_BUDGET = { totalTokens: 0, stepCount: 0, elapsedSeconds: 0, estimatedCostUsd: 0 };
const REPO = 'https://example.invalid/org/repo.git';

/** What the fake agent does in its workspace while the session runs. */
type AgentWork = (workspace: string, options: SessionOptions, session: FakeSession) => void | Promise<void>;

/** A session whose close() and resolveEscalation() are vi.fn() mocks. */
type FakeSession = Session & {
  /** Resolves once close() was called. */
  readonly closed: Promise<void>;
};

interface CreatedSession {
  readonly options: SessionOptions;
  readonly session: FakeSession;
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function escalation(escalationId: string): EscalationRequest {
  return {
    escalationId,
    serverName: 'github',
    toolName: 'close_issue',
    arguments: { issue: 47 },
    reason: 'Closing issues needs approval',
  };
}

describe('daemon cron job execution', () => {
  let root: string;
  let home: string;
  let savedEnv: { home: string | undefined; ironcurtainHome: string | undefined };
  let daemon: IronCurtainDaemon;
  let created: CreatedSession[];
  let agentWork: AgentWork | undefined;
  let nextSession: number;

  function fakeSession(options: SessionOptions): FakeSession {
    const id = `cron-exec-test-${++nextSession}`;
    const closedSignal = deferred<undefined>();
    const session: FakeSession = {
      getInfo: () => ({ id }),
      sendMessage: vi.fn(async () => {
        await agentWork?.(options.workspacePath ?? '', options, session);
        return 'done';
      }),
      // Cron run records read the session totals (the per-turn fields are
      // zero once the run is over).
      getBudgetStatus: () => ({
        totalTokens: 0,
        stepCount: 0,
        elapsedSeconds: 0,
        estimatedCostUsd: 0,
        cumulative: { totalTokens: 10, stepCount: 1, activeSeconds: 2, estimatedCostUsd: 0.25 },
      }),
      close: vi.fn(async () => {
        closedSignal.resolve(undefined);
      }),
      resolveEscalation: vi.fn(async () => {}),
      closed: closedSignal.promise,
    } as unknown as FakeSession;
    return session;
  }

  function job(overrides: Partial<JobDefinition> = {}): JobDefinition {
    return {
      id: createJobId('test-job'),
      name: 'Test job',
      schedule: '0 9 * * *',
      taskDescription: 'Triage the issues',
      taskConstitution: 'The agent may read the workspace.',
      notifyOnEscalation: false,
      notifyOnCompletion: false,
      enabled: false,
      ...overrides,
    };
  }

  /** Saves the job with the compiled policy executeJob requires before any run. */
  async function saveJobWithPolicy(definition: JobDefinition): Promise<void> {
    await saveJob(definition);
    writeCompiledPolicyFor(getJobGeneratedDir(definition.id), definition.taskConstitution);
  }

  /**
   * Signal stand-in: every message the daemon sends. Escalations handed to it
   * are recorded on the shared session manager, as SignalBotDaemon does
   * before it sends the coded banner.
   */
  function attachSignal(): Mock<(text: string, options?: { textMode?: string }) => Promise<void>> {
    const sendSignalMessage = vi.fn<(text: string, options?: { textMode?: string }) => Promise<void>>(async () => {});
    (daemon as unknown as { signalDaemon: unknown }).signalDaemon = {
      sendSignalMessage,
      surfaceEscalation: vi.fn(async (label: number, request: EscalationRequest) => {
        sessionManager().recordEscalation(label, request);
      }),
      expireEscalation: vi.fn((label: number, escalationId: string) =>
        sessionManager().expireEscalation(label, escalationId),
      ),
      shutdown: vi.fn(async () => {}),
    };
    return sendSignalMessage;
  }

  /** The surfaceEscalation fake of the attached Signal stand-in. */
  function surfacedEscalations(): Mock {
    return (daemon as unknown as { signalDaemon: { surfaceEscalation: Mock } }).signalDaemon.surfaceEscalation;
  }

  /** Fires the scheduler callback, as a cron tick does when the job's time comes. */
  function trigger(definition: JobDefinition): Promise<void> {
    return (daemon as unknown as { onJobTrigger(job: JobDefinition, trigger: JobTrigger): Promise<void> }).onJobTrigger(
      definition,
      { kind: 'scheduled', scheduledFor: new Date() },
    );
  }

  /** What start() does for the logger, without the control socket and statistics. */
  function claimDaemonLog(): logger.LoggerClaim {
    const claim = logger.setup({ logFilePath: getDaemonLogPath('daemon'), processWide: true });
    (daemon as unknown as { logClaim: logger.LoggerClaim }).logClaim = claim;
    return claim;
  }

  function sessionManager(): SessionManager {
    return (daemon as unknown as { sessionManager: SessionManager }).sessionManager;
  }

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ironcurtain-exec-job-')));
    home = join(root, 'home');
    mkdirSync(join(home, 'projects', 'foo'), { recursive: true });
    savedEnv = { home: process.env.HOME, ironcurtainHome: process.env.IRONCURTAIN_HOME };
    process.env.HOME = home;
    process.env.IRONCURTAIN_HOME = join(root, 'ironcurtain-home');

    created = [];
    agentWork = undefined;
    nextSession = 0;
    createSession.mockReset();
    createSession.mockImplementation(async (options) => {
      const session = fakeSession(options);
      created.push({ options, session });
      return session;
    });
    syncMock.mockReset();
    syncMock.mockResolvedValue(SYNC_OK);
    saveRunRecordMock.mockClear();
    daemon = new IronCurtainDaemon({ mode: { kind: 'builtin' }, noSignal: true });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await daemon.shutdown();
    logger.teardown();
    if (savedEnv.home === undefined) delete process.env.HOME;
    else process.env.HOME = savedEnv.home;
    if (savedEnv.ironcurtainHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = savedEnv.ironcurtainHome;
    rmSync(root, { recursive: true, force: true });
  });

  describe('run reservation', () => {
    it('reserves the job before a long git sync: no trigger, run-job or second run starts meanwhile', async () => {
      const definition = job({ gitRepo: REPO });
      await saveJobWithPolicy(definition);
      const sync = deferred<GitSyncResult>();
      syncMock.mockImplementation(() => sync.promise);

      const first = daemon.runJobNow(definition.id);
      expect(syncMock).toHaveBeenCalledTimes(1);
      expect(daemon.listJobs()[0]).toMatchObject({ isRunning: true });
      expect(daemon.getStatus().jobs.running).toBe(1);

      await expect(daemon.runJobNow(definition.id)).rejects.toMatchObject({
        code: 'JOB_ALREADY_RUNNING',
        message: 'Job "test-job" is already running (its session is starting)',
      });
      expect(() => daemon.startJobRun(definition.id)).toThrow(/already running/);
      await trigger(definition);
      expect(syncMock).toHaveBeenCalledTimes(1);
      expect(createSession).not.toHaveBeenCalled();

      sync.resolve(SYNC_OK);
      const record = await first;
      expect(record.outcome).toEqual({ kind: 'success' });
      expect(createSession).toHaveBeenCalledTimes(1);
      expect(daemon.listJobs()[0]).toMatchObject({ isRunning: false });

      // Released once the record is written: the next run starts normally.
      const second = await daemon.runJobNow(definition.id);
      expect(second.outcome).toEqual({ kind: 'success' });
      expect(syncMock).toHaveBeenCalledTimes(2);
      expect(createSession).toHaveBeenCalledTimes(2);
      expect(loadRecentRuns(definition.id)[0]).toEqual(second);
    });

    it('stays reserved while the session starts and names the session once it runs', async () => {
      const definition = job();
      await saveJobWithPolicy(definition);
      const sessionStart = deferred<undefined>();
      const agentStarted = deferred<undefined>();
      const agentDone = deferred<undefined>();
      createSession.mockImplementation(async (options) => {
        await sessionStart.promise;
        const session = fakeSession(options);
        created.push({ options, session });
        return session;
      });
      agentWork = async () => {
        agentStarted.resolve(undefined);
        await agentDone.promise;
      };

      const first = daemon.runJobNow(definition.id);
      await expect(daemon.runJobNow(definition.id)).rejects.toMatchObject({ code: 'JOB_ALREADY_RUNNING' });
      sessionStart.resolve(undefined);
      await agentStarted.promise;
      await expect(daemon.runJobNow(definition.id)).rejects.toThrow('Job "test-job" is already running (session #1)');

      agentDone.resolve(undefined);
      await expect(first).resolves.toMatchObject({ outcome: { kind: 'success' } });
      expect(createSession).toHaveBeenCalledTimes(1);
    });

    it('starts one run for two scheduler triggers in the same minute', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
      // Local 08:59:58: the 30 s poll ticks at 09:00:28 and 09:00:58.
      vi.setSystemTime(new Date(2026, 10, 11, 8, 59, 58));
      // A second scheduled job keeps the poll interval running across the reload.
      const other = job({ id: createJobId('other-job'), schedule: '0 0 1 1 *' });
      const definition = job({ schedule: '* * * * *', gitRepo: REPO });
      await saveJob(other);
      await saveJobWithPolicy(definition);
      const sync = deferred<GitSyncResult>();
      syncMock.mockImplementation(() => sync.promise);

      await daemon.enableJob(other.id);
      await daemon.enableJob(definition.id);
      vi.advanceTimersByTime(30_000);
      expect(syncMock).toHaveBeenCalledTimes(1);

      // Rescheduling forgets that the job fired this minute (as reload-job and
      // enable-job do), so the 09:00:58 tick fires it again.
      await daemon.reloadJob(definition.id);
      vi.advanceTimersByTime(30_000);
      expect(syncMock).toHaveBeenCalledTimes(1);

      sync.resolve(SYNC_OK);
      for (let i = 0; i < 200 && daemon.listJobs().some((entry) => entry.isRunning); i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(daemon.listJobs().some((entry) => entry.isRunning)).toBe(false);
      expect(createSession).toHaveBeenCalledTimes(1);
      expect(loadRecentRuns(definition.id)).toHaveLength(1);
    });

    it('makes web jobs.run refuse a running job before replying accepted', async () => {
      const definition = job({ gitRepo: REPO });
      await saveJobWithPolicy(definition);
      const sync = deferred<GitSyncResult>();
      syncMock.mockImplementation(() => sync.promise);
      const eventBus = new WebEventBus();
      const events: string[] = [];
      eventBus.subscribe((event) => events.push(event));
      const handler = {
        startJobRun: (jobId: string) => daemon.startJobRun(jobId as JobId),
      } as unknown as ControlRequestHandler;
      const ctx = { handler, eventBus } as unknown as DispatchContext;

      await expect(jobDispatch(ctx, 'jobs.run', { jobId: definition.id })).resolves.toEqual({
        accepted: true,
        jobId: definition.id,
      });
      await expect(jobDispatch(ctx, 'jobs.run', { jobId: definition.id })).rejects.toMatchObject({
        name: 'RpcError',
        code: 'JOB_ALREADY_RUNNING',
      });
      expect(events).toEqual(['job.started']);
      expect(syncMock).toHaveBeenCalledTimes(1);

      sync.resolve(SYNC_OK);
      await vi.waitFor(() => expect(events).toEqual(['job.started', 'job.completed']));
      expect(createSession).toHaveBeenCalledTimes(1);
    });

    it('makes web jobs.run report an unknown job as JOB_NOT_FOUND before replying accepted', async () => {
      const eventBus = new WebEventBus();
      const events: string[] = [];
      eventBus.subscribe((event) => events.push(event));
      const handler = {
        startJobRun: (jobId: string) => daemon.startJobRun(jobId as JobId),
      } as unknown as ControlRequestHandler;
      const ctx = { handler, eventBus } as unknown as DispatchContext;

      await expect(jobDispatch(ctx, 'jobs.run', { jobId: 'no-such-job' })).rejects.toMatchObject({
        name: 'RpcError',
        code: 'JOB_NOT_FOUND',
        message: 'Job not found: no-such-job',
      });
      expect(events).toEqual([]);
      expect(daemon.getStatus().jobs.running).toBe(0);
    });
  });

  describe('workspace lock', () => {
    /** Whether a run (a job's or a workflow's, in any process) holds the workspace lock of `workspace`. */
    function workspaceLocked(workspace: string): boolean {
      try {
        claimWorkflowWorkspaceLock(getWorkflowWorkspaceLocksDir(), workspace).release();
        return false;
      } catch (err) {
        if (isWorkflowLockBusyError(err)) return true;
        throw err;
      }
    }

    function busyMessage(workspace: string): string {
      return `Workspace ${workspace} is in use by a workflow or cron job running in this process (pid ${process.pid})`;
    }

    it('refuses a job whose workspace another job is running in, before its git sync or session', async () => {
      const shared = join(home, 'projects', 'foo');
      const first = job({ id: createJobId('job-a'), name: 'Job A', workspace: shared });
      // Another spelling of the same directory: the lock is keyed by its identity.
      const second = job({ id: createJobId('job-b'), name: 'Job B', workspace: '~/projects/foo', gitRepo: REPO });
      await saveJobWithPolicy(first);
      await saveJobWithPolicy(second);
      const signal = attachSignal();
      const agentStarted = deferred<undefined>();
      const agentDone = deferred<undefined>();
      // Job A's agent keeps working until the test lets it finish.
      agentWork = async (_workspace, options) => {
        if (options.jobId !== first.id) return;
        agentStarted.resolve(undefined);
        await agentDone.promise;
      };
      onTestFinished(() => agentDone.resolve(undefined));

      const runA = daemon.runJobNow(first.id);
      await agentStarted.promise;
      const refused = await daemon.runJobNow(second.id);

      expect(refused.outcome).toEqual({ kind: 'error', phase: 'setup', message: busyMessage(shared) });
      expect(refused.budget).toEqual(NO_BUDGET);
      expect(syncMock).not.toHaveBeenCalled();
      expect(createSession).toHaveBeenCalledTimes(1);
      expect(loadRecentRuns(second.id)).toEqual([refused]);
      // The refusal notice goes out although the job asks for no completion notice.
      expect(signal).toHaveBeenCalledTimes(1);
      expect(signal).toHaveBeenCalledWith(`[cron: Job B] Not run: ${busyMessage(shared)}`);
      expect(daemon.listJobs().find((entry) => entry.job.id === second.id)).toMatchObject({ isRunning: false });

      agentDone.resolve(undefined);
      await expect(runA).resolves.toMatchObject({ outcome: { kind: 'success' } });
      expect(workspaceLocked(shared)).toBe(false);

      // Once job A has ended, job B runs (and syncs) normally.
      const next = await daemon.runJobNow(second.id);
      expect(next.outcome).toEqual({ kind: 'success' });
      expect(syncMock).toHaveBeenCalledTimes(1);
      expect(createSession).toHaveBeenCalledTimes(2);
    });

    it('holds the lock from before the git sync until the session has been torn down', async () => {
      const shared = join(home, 'projects', 'foo');
      const first = job({ id: createJobId('job-a'), workspace: shared, gitRepo: REPO });
      const second = job({ id: createJobId('job-b'), workspace: shared });
      await saveJobWithPolicy(first);
      await saveJobWithPolicy(second);
      let lockedDuringSync: boolean | undefined;
      syncMock.mockImplementation(async (options) => {
        lockedDuringSync = workspaceLocked(options.workspaceDir);
        return SYNC_OK;
      });
      const closeStarted = deferred<undefined>();
      const closeGate = deferred<undefined>();
      onTestFinished(() => closeGate.resolve(undefined));
      createSession.mockImplementationOnce(async (options) => {
        const session = fakeSession(options);
        vi.mocked(session.close).mockImplementation(async () => {
          closeStarted.resolve(undefined);
          await closeGate.promise;
        });
        created.push({ options, session });
        return session;
      });

      const runA = daemon.runJobNow(first.id);
      await closeStarted.promise;
      // Job A's agent has finished, but its session is still being torn down.
      const refused = await daemon.runJobNow(second.id);
      expect(refused.outcome).toEqual({ kind: 'error', phase: 'setup', message: busyMessage(shared) });

      closeGate.resolve(undefined);
      await expect(runA).resolves.toMatchObject({ outcome: { kind: 'success' } });
      expect(lockedDuringSync).toBe(true);
      expect(workspaceLocked(shared)).toBe(false);
      await expect(daemon.runJobNow(second.id)).resolves.toMatchObject({ outcome: { kind: 'success' } });
    });

    it('excludes workflows: a job is refused on a workflow workspace, and a workflow on a running job', async () => {
      const workspace = join(home, 'projects', 'foo');
      const definition = job({ workspace, gitRepo: REPO, notifyOnCompletion: true });
      await saveJobWithPolicy(definition);
      const signal = attachSignal();

      // What a workflow run on this workspace (in this or another process) holds.
      const workflowLock = claimWorkflowWorkspaceLock(getWorkflowWorkspaceLocksDir(), workspace);
      const refused = await daemon.runJobNow(definition.id).finally(() => workflowLock.release());
      expect(refused.outcome).toEqual({ kind: 'error', phase: 'setup', message: busyMessage(workspace) });
      expect(syncMock).not.toHaveBeenCalled();
      expect(createSession).not.toHaveBeenCalled();
      // The "Not run" notice takes the place of the completion notice.
      expect(signal).toHaveBeenCalledTimes(1);
      expect(signal).toHaveBeenCalledWith(`[cron: Test job] Not run: ${busyMessage(workspace)}`);

      let workflowClaim: unknown;
      agentWork = (dir) => {
        try {
          claimWorkflowWorkspaceLock(getWorkflowWorkspaceLocksDir(), dir).release();
        } catch (err) {
          workflowClaim = err;
        }
      };
      const record = await daemon.runJobNow(definition.id);
      expect(record.outcome).toEqual({ kind: 'success' });
      expect(workflowClaim).toMatchObject({ code: 'WORKFLOW_LOCK_BUSY', kind: 'workspace', ownerPid: process.pid });
      expect(workspaceLocked(workspace)).toBe(false);
    });

    it("locks the job's own default workspace too, creating it when it is missing", async () => {
      const definition = job();
      await saveJobWithPolicy(definition);
      const workspace = getJobWorkspaceDir(definition.id);
      expect(existsSync(workspace)).toBe(false);
      let lockedDuringRun: boolean | undefined;
      agentWork = (dir) => {
        lockedDuringRun = workspaceLocked(dir);
      };

      const record = await daemon.runJobNow(definition.id);
      expect(record.outcome).toEqual({ kind: 'success' });
      expect(created[0]?.options.workspacePath).toBe(workspace);
      expect(lockedDuringRun).toBe(true);
      expect(workspaceLocked(workspace)).toBe(false);

      const workflowLock = claimWorkflowWorkspaceLock(getWorkflowWorkspaceLocksDir(), workspace);
      const refused = await daemon.runJobNow(definition.id).finally(() => workflowLock.release());
      expect(refused.outcome).toEqual({ kind: 'error', phase: 'setup', message: busyMessage(workspace) });
      expect(createSession).toHaveBeenCalledTimes(1);
    });

    it('releases the lock after a failed sync, a failed session start and a removed job', async () => {
      const workspace = join(home, 'projects', 'foo');
      const definition = job({ workspace, gitRepo: REPO });
      await saveJobWithPolicy(definition);

      syncMock.mockResolvedValueOnce({ ok: false, kind: 'sync_error', message: 'fetching: unreachable' });
      await expect(daemon.runJobNow(definition.id)).resolves.toMatchObject({ outcome: { phase: 'sync' } });
      expect(workspaceLocked(workspace)).toBe(false);

      createSession.mockRejectedValueOnce(new Error('Docker is not available'));
      await expect(daemon.runJobNow(definition.id)).resolves.toMatchObject({ outcome: { phase: 'setup' } });
      expect(workspaceLocked(workspace)).toBe(false);

      let removal: Promise<void> | undefined;
      agentWork = async (_dir, _options, session) => {
        removal = daemon.removeJob(definition.id);
        await session.closed;
      };
      await expect(daemon.runJobNow(definition.id)).resolves.toMatchObject({ outcome: { phase: 'session' } });
      await removal;
      expect(workspaceLocked(workspace)).toBe(false);
    });
  });

  describe('always-recorded outcomes', () => {
    it('does not leave the job marked running when saving the record fails with ENOSPC', async () => {
      const definition = job();
      await saveJobWithPolicy(definition);
      saveRunRecordMock.mockImplementationOnce(() => {
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      });

      const record = await daemon.runJobNow(definition.id);
      expect(record.outcome).toEqual({ kind: 'success' });
      expect(created[0]?.session.close).toHaveBeenCalledTimes(1);
      expect(sessionManager().size).toBe(0);
      expect(daemon.listJobs()[0]).toMatchObject({ isRunning: false });
      expect(daemon.getStatus().jobs.running).toBe(0);
      expect(loadRecentRuns(definition.id)).toEqual([]);

      // Not wedged: the next run starts and is recorded.
      const next = await daemon.runJobNow(definition.id);
      expect(loadRecentRuns(definition.id)).toEqual([next]);
    });

    it('records and notifies a run whose session cannot be created', async () => {
      const definition = job({ name: 'Nightly report', notifyOnCompletion: true });
      await saveJobWithPolicy(definition);
      const signal = attachSignal();
      createSession.mockRejectedValueOnce(new Error('Docker is not available'));

      const record = await daemon.runJobNow(definition.id);
      expect(record.outcome).toEqual({ kind: 'error', phase: 'setup', message: 'Docker is not available' });
      expect(record.budget).toEqual(NO_BUDGET);
      expect(record.summary).toBeNull();
      expect(loadRecentRuns(definition.id)).toEqual([record]);
      expect(signal).toHaveBeenCalledTimes(1);
      expect(signal).toHaveBeenCalledWith('[cron: Nightly report] Error (setup): Docker is not available (0s, $0.00)', {
        textMode: 'normal',
      });
      expect(daemon.listJobs()[0]).toMatchObject({ isRunning: false, consecutiveFailures: 1 });
    });

    it('records and notifies a failed git sync with the sync phase', async () => {
      const definition = job({ gitRepo: REPO, notifyOnCompletion: true });
      await saveJobWithPolicy(definition);
      const signal = attachSignal();
      syncMock.mockResolvedValueOnce({ ok: false, kind: 'sync_timeout', message: `fetching ${REPO}: timed out` });

      const record = await daemon.runJobNow(definition.id);
      expect(record.outcome).toEqual({
        kind: 'error',
        phase: 'sync',
        message: `Git sync timed out: fetching ${REPO}: timed out`,
      });
      expect(createSession).not.toHaveBeenCalled();
      expect(loadRecentRuns(definition.id)).toEqual([record]);
      expect(signal).toHaveBeenCalledWith(
        expect.stringMatching(/^\[cron: Test job\] Error \(sync\): Git sync timed out/),
        { textMode: 'normal' },
      );
    });

    it('records an invalid custom workspace as a setup failure', async () => {
      const definition = job({ workspace: join(root, 'missing'), notifyOnCompletion: true });
      await saveJobWithPolicy(definition);
      const signal = attachSignal();

      const record = await daemon.runJobNow(definition.id);
      expect(record.outcome).toMatchObject({ kind: 'error', phase: 'setup' });
      expect(record.outcome.kind === 'error' ? record.outcome.message : '').toMatch(
        /^Invalid workspace: Workspace path does not exist/,
      );
      expect(createSession).not.toHaveBeenCalled();
      expect(loadRecentRuns(definition.id)).toEqual([record]);
      expect(signal).toHaveBeenCalledTimes(1);
    });

    it('refuses to run a job whose hand-edited job.json id names no job directory, saying it is invalid', async () => {
      const dir = join(process.env.IRONCURTAIN_HOME ?? '', 'jobs', 'renamed');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'job.json'), JSON.stringify({ ...job({ notifyOnCompletion: true }), id: 'My Job' }));
      const signal = attachSignal();

      // Validated on load: the job is reported invalid (not "not found"), and
      // no run is reserved or started for it.
      await expect(daemon.runJobNow(createJobId('renamed'))).rejects.toMatchObject({
        code: 'JOB_INVALID',
        message: expect.stringContaining('its job.json is invalid') as unknown,
      });
      expect(createSession).not.toHaveBeenCalled();
      expect(signal).not.toHaveBeenCalled();
      expect(daemon.getStatus().jobs.running).toBe(0);
    });

    it('records a failing agent session with the session phase and its budget', async () => {
      const definition = job();
      await saveJobWithPolicy(definition);
      agentWork = () => {
        throw new Error('model provider returned 529');
      };

      const record = await daemon.runJobNow(definition.id);
      expect(record.outcome).toEqual({ kind: 'error', phase: 'session', message: 'model provider returned 529' });
      expect(record.budget).toEqual({ totalTokens: 10, stepCount: 1, elapsedSeconds: 2, estimatedCostUsd: 0.25 });
      expect(created[0]?.session.close).toHaveBeenCalledTimes(1);
    });

    it('keeps the daemon log after a failed session creation gave back its claim', async () => {
      const definition = job();
      await saveJobWithPolicy(definition);
      claimDaemonLog();
      const deadSessionLog = join(root, 'dead-session.log');
      createSession.mockImplementationOnce(async () => {
        // What session creation does when the session fails to start: it
        // claims the session log, logs there, and gives the claim back.
        const claim = logger.setup({ logFilePath: deadSessionLog });
        logger.runWithClaim(claim, () => logger.info('[test] session line'));
        logger.release(claim);
        throw new Error('Docker is not available');
      });

      await daemon.runJobNow(definition.id);
      logger.info('[test] daemon line after the run');

      const daemonLog = readFileSync(getDaemonLogPath('daemon'), 'utf8');
      expect(daemonLog).toContain('Job test-job failed (setup): Docker is not available');
      expect(daemonLog).toContain('[test] daemon line after the run');
      expect(daemonLog).not.toContain('[test] session line');
      expect(readFileSync(deadSessionLog, 'utf8')).toContain('[test] session line');
      expect(readFileSync(deadSessionLog, 'utf8')).not.toContain('failed (setup)');
    });

    it('logs its own lines to the daemon log while the run session holds its claim', async () => {
      // The session claims its own log (the newest claim) and gives it back
      // in close(). The daemon's claim is process-wide, so daemon lines
      // written while the session is open do not land in the session's log,
      // and the daemon log carries on afterwards.
      const definition = job();
      await saveJobWithPolicy(definition);
      claimDaemonLog();
      const sessionLog = join(root, 'run-session.log');
      createSession.mockImplementationOnce(async (options) => {
        const claim = logger.setup({ logFilePath: sessionLog });
        const session = fakeSession(options);
        vi.mocked(session.sendMessage).mockImplementation(async () => {
          logger.runWithClaim(claim, () => logger.info('[test] agent turn'));
          return 'done';
        });
        vi.mocked(session.close).mockImplementation(async () => {
          logger.release(claim);
        });
        created.push({ options, session });
        return session;
      });

      await trigger(definition);
      logger.info('[test] daemon line after the run');

      const daemonLog = readFileSync(getDaemonLogPath('daemon'), 'utf8');
      const runLog = readFileSync(sessionLog, 'utf8');
      expect(daemonLog).toContain('Started job test-job as session');
      expect(daemonLog).toContain('Job test-job completed: success');
      expect(daemonLog).toContain('[test] daemon line after the run');
      expect(daemonLog).not.toContain('[test] agent turn');
      expect(runLog).toContain('[test] agent turn');
      expect(runLog).not.toContain('[Daemon]');
    });

    it('logs a failure message as one display-safe line', async () => {
      const definition = job();
      await saveJobWithPolicy(definition);
      claimDaemonLog();
      const esc = String.fromCharCode(0x1b);
      const backslash = String.fromCharCode(92);
      createSession.mockRejectedValueOnce(new Error(`pull failed${esc}[2J\nforged: Job other-job completed`));

      await daemon.runJobNow(definition.id);
      const daemonLog = readFileSync(getDaemonLogPath('daemon'), 'utf8');
      expect(daemonLog).toContain(
        `Job test-job failed (setup): pull failed${backslash}u001b[2J${backslash}nforged: Job other-job completed`,
      );
      expect(daemonLog).not.toContain(esc);
      expect(daemonLog).not.toMatch(/^forged:/m);
    });

    it('leaves the console restored when the daemon was never started (CLI one-shot run-job)', async () => {
      const definition = job();
      await saveJobWithPolicy(definition);
      createSession.mockImplementationOnce(async () => {
        logger.release(logger.setup({ logFilePath: join(root, 'dead-session.log') }));
        throw new Error('Docker is not available');
      });

      await daemon.runJobNow(definition.id);
      // The daemon takes no claim of its own unless it was started.
      expect(logger.isActive()).toBe(false);
    });

    it('counts consecutive failures in list-jobs and status until a run succeeds', async () => {
      // Run records are named by start time: give every run its own second.
      vi.useFakeTimers({ toFake: ['Date'] });
      const start = Date.UTC(2026, 10, 11, 9, 0, 0);
      const definition = job();
      await saveJobWithPolicy(definition);
      createSession.mockRejectedValueOnce(new Error('Docker is not available'));
      createSession.mockRejectedValueOnce(new Error('Docker is not available'));
      createSession.mockRejectedValueOnce(new Error('Docker is not available'));

      for (let run = 0; run < 3; run++) {
        vi.setSystemTime(start + run * 60_000);
        await daemon.runJobNow(definition.id);
      }
      expect(daemon.listJobs()[0]).toMatchObject({ consecutiveFailures: 3 });
      expect(daemon.getStatus()).toMatchObject({
        jobs: { total: 1, failing: 1 },
        failingJobs: [{ jobId: 'test-job', name: 'Test job', consecutiveFailures: 3 }],
      });

      vi.setSystemTime(start + 3 * 60_000);
      await daemon.runJobNow(definition.id);
      expect(daemon.listJobs()[0]).toMatchObject({ consecutiveFailures: 0 });
      expect(daemon.getStatus()).toMatchObject({ jobs: { failing: 0 }, failingJobs: [] });
    });

    it('keeps status and list-jobs working with a malformed run record or a hand-edited job id', async () => {
      // getStatus() feeds the web UI's periodic status broadcast, where a throw
      // is an uncaught exception that would end the daemon.
      const definition = job();
      await saveJobWithPolicy(definition);
      createSession.mockRejectedValueOnce(new Error('Docker is not available'));
      await daemon.runJobNow(definition.id);
      writeFileSync(join(getJobDir(definition.id), 'runs', '9999-12-31T00-00-00.000Z.json'), '{}');

      expect(daemon.listJobs()[0]).toMatchObject({ consecutiveFailures: 1 });
      expect(daemon.getStatus()).toMatchObject({ jobs: { total: 1, failing: 1 } });

      // A job.json whose id no longer names a job directory is invalid: left
      // out of status and the job list, never a throw.
      const renamedDir = join(process.env.IRONCURTAIN_HOME ?? '', 'jobs', 'renamed');
      mkdirSync(renamedDir, { recursive: true });
      writeFileSync(join(renamedDir, 'job.json'), JSON.stringify({ ...job(), id: 'My Job' }));
      expect(daemon.getStatus()).toMatchObject({ jobs: { total: 1, failing: 1 } });
      expect(daemon.listJobs().map((entry) => entry.job.id)).toEqual(['test-job']);
    });
  });

  describe('canonical workspace', () => {
    // A raw `~/...` used as a path is relative: it would land under the
    // working directory, so the tests run from a scratch one.
    let savedCwd: string;
    let scratchCwd: string;

    beforeEach(() => {
      savedCwd = process.cwd();
      scratchCwd = join(root, 'cwd');
      mkdirSync(scratchCwd);
      process.chdir(scratchCwd);
    });

    afterEach(() => {
      process.chdir(savedCwd);
    });

    it('runs a ~/projects/foo workspace in its canonical form for the sync, the session and the summary', async () => {
      const canonical = join(home, 'projects', 'foo');
      const definition = job({ workspace: '~/projects/foo', gitRepo: REPO });
      await saveJobWithPolicy(definition);
      agentWork = (workspace) => writeFileSync(join(workspace, 'last-run.md'), 'Labeled 3 issues.\n');

      const record = await daemon.runJobNow(definition.id);
      expect(record.outcome).toEqual({ kind: 'success' });
      expect(syncMock.mock.calls[0]?.[0]).toMatchObject({ workspaceDir: canonical, managedWorkspace: false });
      expect(created[0]?.options.workspacePath).toBe(canonical);
      expect(record.summary).toBe('Labeled 3 issues.\n');
      expect(existsSync(join(scratchCwd, '~'))).toBe(false);
    });

    it('resolves a symlinked workspace to its target', async () => {
      const canonical = join(home, 'projects', 'foo');
      symlinkSync(canonical, join(home, 'foo-link'));
      const definition = job({ workspace: '~/foo-link' });
      await saveJobWithPolicy(definition);

      await daemon.runJobNow(definition.id);
      expect(created[0]?.options.workspacePath).toBe(canonical);
    });

    it('validates and canonicalizes the workspace in addJob too', async () => {
      const canonical = join(home, 'projects', 'foo');
      const definition = job({ workspace: '~/projects/foo', gitRepo: REPO });

      await daemon.addJob(definition);
      expect(syncMock.mock.calls[0]?.[0]).toMatchObject({ workspaceDir: canonical });
      expect(existsSync(join(scratchCwd, '~'))).toBe(false);
    });
  });

  describe('last-run.md', () => {
    function prepareWorkspace(definition: JobDefinition): string {
      const workspace = getJobWorkspaceDir(definition.id);
      mkdirSync(workspace, { recursive: true });
      return workspace;
    }

    it('never credits a run that writes no summary with the previous one', async () => {
      const definition = job();
      await saveJobWithPolicy(definition);
      const workspace = prepareWorkspace(definition);
      agentWork = (dir) => writeFileSync(join(dir, 'last-run.md'), 'First run: labeled 3 issues.\n');

      const first = await daemon.runJobNow(definition.id);
      expect(first.summary).toBe('First run: labeled 3 issues.\n');

      let seenByAgent: { previous: string; current: boolean } | undefined;
      agentWork = (dir) => {
        seenByAgent = {
          previous: readFileSync(join(dir, 'previous-run.md'), 'utf8'),
          current: existsSync(join(dir, 'last-run.md')),
        };
      };
      const second = await daemon.runJobNow(definition.id);
      expect(second.outcome).toEqual({ kind: 'success' });
      expect(second.summary).toBeNull();
      expect(seenByAgent).toEqual({ previous: 'First run: labeled 3 issues.\n', current: false });
      expect(readFileSync(join(workspace, 'previous-run.md'), 'utf8')).toBe('First run: labeled 3 issues.\n');
    });

    it.skipIf(!fifoSupported)('does not hang the daemon on a FIFO at last-run.md', async () => {
      const definition = job();
      await saveJobWithPolicy(definition);
      const workspace = prepareWorkspace(definition);
      const fifo = join(workspace, 'last-run.md');
      let unblocker: FifoUnblocker | undefined;
      agentWork = () => {
        makeFifo(fifo);
        // Releases a regressed (blocking) read after 5 s so the test fails instead of hanging.
        unblocker = startFifoUnblocker(fifo, 5);
      };

      const started = Date.now();
      try {
        const record = await daemon.runJobNow(definition.id);
        expect(Date.now() - started).toBeLessThan(4_000);
        expect(record.outcome).toEqual({ kind: 'success' });
        expect(record.summary).toBeNull();
      } finally {
        unblocker?.stop();
      }

      // Before the next run the FIFO is moved aside, never opened.
      agentWork = undefined;
      const next = await daemon.runJobNow(definition.id);
      expect(next.summary).toBeNull();
      expect(existsSync(fifo)).toBe(false);
      expect(lstatSync(join(workspace, 'previous-run.md')).isFIFO()).toBe(true);
    });

    it('does not follow a last-run.md symlink to a host file', async () => {
      const definition = job({ notifyOnCompletion: true });
      await saveJobWithPolicy(definition);
      prepareWorkspace(definition);
      const signal = attachSignal();
      const secret = join(root, 'host-secret.txt');
      writeFileSync(secret, 'TOP-SECRET-HOST-KEY\n');
      agentWork = (dir) => symlinkSync(secret, join(dir, 'last-run.md'));

      const record = await daemon.runJobNow(definition.id);
      expect(record.summary).toBeNull();
      expect(JSON.stringify(loadRecentRuns(definition.id))).not.toContain('TOP-SECRET');
      expect(signal.mock.calls.map(([text]) => text).join('\n')).not.toContain('TOP-SECRET');
    });

    it('strips control characters and bounds the summary in the record and the notification', async () => {
      const definition = job({ notifyOnCompletion: true });
      await saveJobWithPolicy(definition);
      prepareWorkspace(definition);
      const signal = attachSignal();
      const esc = String.fromCharCode(0x1b);
      const bel = String.fromCharCode(0x07);
      const rlo = String.fromCodePoint(0x202e);
      const lineSeparator = String.fromCodePoint(0x2028);
      agentWork = (dir) =>
        writeFileSync(
          join(dir, 'last-run.md'),
          `Done ${esc}]52;c;ZXZpbA==${bel}ok${esc}[2J\r\n${rlo}txt.exe${lineSeparator}next ` + 'x'.repeat(20_000),
        );

      const record = await daemon.runJobNow(definition.id);
      const summary = record.summary ?? '';
      const visibleRlo = String.fromCharCode(92) + 'u202e';
      expect(summary.startsWith(`Done ok\n${visibleRlo}txt.exe\nnext x`)).toBe(true);
      expect(summary.endsWith('...')).toBe(true);
      expect(Array.from(summary)).toHaveLength(2003);
      for (const forbidden of [esc, bel, '\r', rlo, lineSeparator]) expect(summary).not.toContain(forbidden);

      // Plain text, the agent's summary quoted line by line and cut to 500 characters.
      const [notice, options] = signal.mock.calls[0] ?? [''];
      expect(options).toEqual({ textMode: 'normal' });
      const [header, label, ...quoted] = notice.split('\n');
      expect(header).toBe('[cron: Test job] Completed (2s, $0.25)');
      expect(label).toBe("Summary written by the job's agent:");
      expect(quoted.slice(0, 2)).toEqual(['\u2502 Done ok', `\u2502 ${visibleRlo}txt.exe`]);
      expect(quoted.every((line) => line.startsWith('\u2502 '))).toBe(true);
      expect(Array.from(quoted.map((line) => line.slice(2)).join('\n')).length).toBeLessThanOrEqual(500);
      expect(notice).toMatch(/\.\.\.\[\+\d+ chars\]$/u);
      for (const forbidden of [esc, bel, rlo]) expect(notice).not.toContain(forbidden);
    });
  });

  describe('escalation routing', () => {
    it('routes an escalation raised before the session was registered to that run session', async () => {
      const definition = job();
      await saveJobWithPolicy(definition);
      createSession.mockImplementationOnce(async (options) => {
        const session = fakeSession(options);
        created.push({ options, session });
        options.onEscalation?.(escalation('esc-early'));
        return session;
      });

      const record = await daemon.runJobNow(definition.id);
      // No Signal and no browser: auto-denied on the run's own session once
      // it is registered, through SessionManager.resolveSessionEscalation.
      expect(created[0]?.session.resolveEscalation).toHaveBeenCalledWith('esc-early', 'denied', undefined);
      expect(record.escalationsEncountered).toBe(1);
    });

    it('marks, announces and clears an escalation on the run session label', async () => {
      const definition = job({ name: 'Issue triage', notifyOnEscalation: true });
      await saveJobWithPolicy(definition);
      const signal = attachSignal();
      let pendingDuringRun: string | undefined;
      let pendingAfterResolution: string | undefined;
      agentWork = (_workspace, options) => {
        options.onEscalation?.(escalation('esc-1'));
        pendingDuringRun = sessionManager().get(1)?.pendingEscalations.keys().next().value;
        options.onEscalationResolved?.('esc-1', 'approved');
        pendingAfterResolution = sessionManager().get(1)?.pendingEscalations.keys().next().value;
      };

      const record = await daemon.runJobNow(definition.id);
      expect(pendingDuringRun).toBe('esc-1');
      expect(pendingAfterResolution).toBeUndefined();
      // Handed to the Signal daemon, which sends the coded banner naming the
      // job; no plain "approve #N" message.
      expect(surfacedEscalations()).toHaveBeenCalledWith(1, escalation('esc-1'), { jobName: 'Issue triage' });
      expect(signal).not.toHaveBeenCalled();
      expect(created[0]?.session.resolveEscalation).not.toHaveBeenCalled();
      expect(record.escalationsApproved).toBe(1);
    });
  });

  describe('cancellation', () => {
    function abortableSync(): void {
      syncMock.mockImplementation(
        (options: GitSyncOptions) =>
          new Promise<GitSyncResult>((resolve) => {
            options.signal?.addEventListener('abort', () =>
              resolve({ ok: false, kind: 'sync_error', message: 'fetching: the operation was aborted' }),
            );
          }),
      );
    }

    it('cancels a run in its git sync when the job is removed, keeping no record or directory', async () => {
      const definition = job({ gitRepo: REPO, notifyOnCompletion: true });
      await saveJobWithPolicy(definition);
      const signal = attachSignal();
      abortableSync();

      const run = daemon.runJobNow(definition.id);
      await daemon.removeJob(definition.id);
      const record = await run;

      expect(record.outcome).toEqual({ kind: 'error', phase: 'sync', message: 'Run cancelled: the job was removed' });
      expect(createSession).not.toHaveBeenCalled();
      expect(existsSync(getJobDir(definition.id))).toBe(false);
      expect(daemon.getStatus().jobs.running).toBe(0);
      expect(signal).not.toHaveBeenCalled();
    });

    it('ends the session of a running job that is removed, keeping no record or directory', async () => {
      const definition = job();
      await saveJobWithPolicy(definition);
      let removal: Promise<void> | undefined;
      agentWork = async (_workspace, _options, session) => {
        removal = daemon.removeJob(definition.id);
        await session.closed;
      };

      const record = await daemon.runJobNow(definition.id);
      await removal;

      expect(record.outcome).toEqual({
        kind: 'error',
        phase: 'session',
        message: 'Run cancelled: the job was removed',
      });
      expect(created[0]?.session.close).toHaveBeenCalledTimes(1);
      expect(existsSync(getJobDir(definition.id))).toBe(false);
      expect(daemon.getStatus().jobs.running).toBe(0);
    });

    it('records the cancellation of a run in its git sync when the daemon shuts down', async () => {
      const definition = job({ gitRepo: REPO });
      await saveJobWithPolicy(definition);
      abortableSync();

      const run = daemon.runJobNow(definition.id);
      await daemon.shutdown();
      const record = await run;

      expect(record.outcome).toEqual({
        kind: 'error',
        phase: 'sync',
        message: 'Run cancelled: the daemon is shutting down',
      });
      expect(loadRecentRuns(definition.id)).toEqual([record]);
    });

    it('releases the daemon lock only after a cancelled run has recorded its outcome', async () => {
      const definition = job({ gitRepo: REPO });
      await saveJobWithPolicy(definition);
      abortableSync();
      // What start() holds; a new daemon may start (and run the job) once it is released.
      let recordsAtRelease: number | undefined;
      (daemon as unknown as { daemonLock: unknown }).daemonLock = {
        path: join(root, 'daemon.lock'),
        release: vi.fn(() => {
          recordsAtRelease = loadRecentRuns(definition.id).length;
        }),
      };

      const run = daemon.runJobNow(definition.id);
      await daemon.shutdown();
      await run;

      expect(recordsAtRelease).toBe(1);
    });
  });
});
