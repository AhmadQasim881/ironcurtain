/**
 * Retention (`ironcurtain prune`): what is removed, what is kept and why, on a
 * real IronCurtain home in a temporary directory.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPruneLockPath, getSessionsDir, getWorkflowRunsDir } from '../src/config/paths.js';
import { RETENTION_CONFIG_DEFAULTS, type ResolvedRetentionConfig } from '../src/config/user-config.js';
import { LATEST_RUN_POINTER_FILE, saveJob, saveRunRecord } from '../src/cron/job-store.js';
import { createJobId, type RunRecord } from '../src/cron/types.js';
import { tryAcquireProvisionLock } from '../src/docker/provision-lock.js';
import { WORKFLOW_DEPENDENCY_LAST_USED_FILE } from '../src/docker/workflow-dependency-cache.js';
import { acquireProcessLock, type ProcessLockHandle } from '../src/docker-workload/process-lock.js';
import { runPruneCommand } from '../src/maintenance/prune-command.js';
import {
  PRUNE_BUSY,
  PRUNE_TOMBSTONE_PREFIX,
  runPrune,
  type PruneOptions,
  type PruneReport,
} from '../src/maintenance/prune.js';
import { discoverWorkflowRuns } from '../src/workflow/workflow-discovery.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NO_LEASES = (): { bundleIds: ReadonlySet<string>; unreadable: number } => ({
  bundleIds: new Set<string>(),
  unreadable: 0,
});

let root: string;
let home: string;
let savedHome: string | undefined;
const held: ProcessLockHandle[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ironcurtain-prune-'));
  home = join(root, 'home');
  mkdirSync(home);
  savedHome = process.env.IRONCURTAIN_HOME;
  process.env.IRONCURTAIN_HOME = home;
});

afterEach(() => {
  for (const lock of held.splice(0)) {
    try {
      lock.release();
    } catch {
      // Removed with its directory.
    }
  }
  if (savedHome === undefined) delete process.env.IRONCURTAIN_HOME;
  else process.env.IRONCURTAIN_HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

/** Sets the modification time of `path` and everything below it to `days` ago. */
function age(path: string, days: number): void {
  const when = new Date(Date.now() - days * DAY_MS);
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) return;
  if (stats.isDirectory()) for (const name of readdirSync(path)) age(join(path, name), days);
  utimesSync(path, when, when);
}

function lock(path: string): ProcessLockHandle {
  const handle = acquireProcessLock(path);
  held.push(handle);
  return handle;
}

interface SessionSpec {
  readonly days: number;
  readonly metadata?: Record<string, unknown>;
}

function makeSession(id: string, spec: SessionSpec): string {
  const dir = join(getSessionsDir(), id);
  mkdirSync(join(dir, 'sandbox'), { recursive: true });
  mkdirSync(join(dir, 'escalations'), { recursive: true });
  writeFileSync(join(dir, 'sandbox', 'work.txt'), 'agent output\n');
  writeFileSync(join(dir, 'session.log'), 'log line\n');
  writeFileSync(join(dir, 'audit.jsonl'), '{}\n');
  writeFileSync(
    join(dir, 'session-metadata.json'),
    JSON.stringify({ createdAt: new Date().toISOString(), ...spec.metadata }),
  );
  age(dir, spec.days);
  return dir;
}

interface RunSpec {
  readonly days: number;
  /** Final phase of the checkpoint; undefined for one still in progress; null for no checkpoint. */
  readonly phase?: 'completed' | 'failed' | 'aborted' | null;
  readonly workspacePath?: string;
  readonly dependencyKeys?: readonly string[];
  readonly bundles?: readonly string[];
  readonly bytes?: number;
}

function finalStatus(phase: 'completed' | 'failed' | 'aborted'): Record<string, unknown> {
  if (phase === 'completed') return { phase, result: { finalArtifacts: {} } };
  if (phase === 'failed') return { phase, error: 'boom', lastState: 'work' };
  return { phase, reason: 'stopped' };
}

function makeRun(id: string, spec: RunSpec): string {
  const dir = join(getWorkflowRunsDir(), id);
  mkdirSync(join(dir, 'workspace'), { recursive: true });
  writeFileSync(join(dir, 'workspace', 'result.txt'), 'x'.repeat(spec.bytes ?? 10));
  writeFileSync(join(dir, 'messages.jsonl'), '{}\n');
  if (spec.phase !== null) {
    writeFileSync(
      join(dir, 'checkpoint.json'),
      JSON.stringify({
        machineState: 'work',
        context: {},
        timestamp: new Date().toISOString(),
        transitionHistory: [],
        definitionPath: join(dir, 'definition.json'),
        workspacePath: spec.workspacePath ?? join(dir, 'workspace'),
        ...(spec.phase !== undefined ? { finalStatus: finalStatus(spec.phase) } : {}),
      }),
    );
  }
  for (const key of spec.dependencyKeys ?? []) {
    mkdirSync(join(dir, 'deps', key, 'python-venv'), { recursive: true });
    writeFileSync(join(dir, 'deps', key, 'python-venv', 'pyvenv.cfg'), 'home = /usr/bin\n');
  }
  for (const bundle of spec.bundles ?? []) {
    mkdirSync(join(dir, 'containers', bundle), { recursive: true });
    writeFileSync(join(dir, 'containers', bundle, 'audit.jsonl'), '{}\n');
  }
  age(dir, spec.days);
  return dir;
}

function makeBase(key: string, lastUsedDaysAgo: number | undefined, fileDays = 30): string {
  const dir = join(home, 'workflow-dependency-bases', key);
  mkdirSync(join(dir, 'python-venv', 'lib'), { recursive: true });
  writeFileSync(join(dir, 'python-venv', 'lib', 'numpy.py'), 'x = 1\n');
  writeFileSync(join(dir, 'python-venv.provisioned.json'), '{}\n');
  age(dir, fileDays);
  if (lastUsedDaysAgo !== undefined) {
    writeFileSync(
      join(dir, WORKFLOW_DEPENDENCY_LAST_USED_FILE),
      JSON.stringify({ schemaVersion: 1, lastUsedAt: new Date(Date.now() - lastUsedDaysAgo * DAY_MS).toISOString() }),
    );
  }
  return dir;
}

function makeRunRecord(startedAt: string): RunRecord {
  return {
    startedAt,
    completedAt: startedAt,
    outcome: { kind: 'success' },
    budget: { totalTokens: 1, stepCount: 1, elapsedSeconds: 1, estimatedCostUsd: 0 },
    summary: null,
    escalationsEncountered: 0,
    escalationsApproved: 0,
    discardedChanges: null,
  };
}

async function makeJobWithRuns(id: string, runs: number, workspace?: string): Promise<string> {
  const jobId = createJobId(id);
  await saveJob({
    id: jobId,
    name: id,
    schedule: '0 9 * * *',
    taskDescription: 'task',
    taskConstitution: 'rules',
    notifyOnEscalation: false,
    notifyOnCompletion: false,
    enabled: true,
    ...(workspace !== undefined ? { workspace } : {}),
  });
  for (let index = 0; index < runs; index++) {
    saveRunRecord(jobId, makeRunRecord(new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString()));
  }
  return join(home, 'jobs', id, 'runs');
}

function prune(options: Partial<PruneOptions> & { retention?: ResolvedRetentionConfig } = {}): Promise<PruneReport> {
  return runPrune({ dryRun: false, listLeaseBundles: NO_LEASES, ...options });
}

function removedIds(report: PruneReport, category?: string): string[] {
  return report.removed
    .filter((item) => category === undefined || item.category === category)
    .map((item) => item.id)
    .sort();
}

function keptReason(report: PruneReport, id: string): string | undefined {
  return report.kept.find((item) => item.id === id)?.reason;
}

/**
 * A signal that never aborts and runs `onFirstCheck` the first time the prune
 * asks, which it does right before its first removal: a stand-in for a
 * resume that starts after the prune planned.
 */
function signalOnFirstCheck(onFirstCheck: () => void): AbortSignal {
  let fired = false;
  return {
    get aborted(): boolean {
      if (!fired) {
        fired = true;
        onFirstCheck();
      }
      return false;
    },
  } as unknown as AbortSignal;
}

function tombstones(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith(PRUNE_TOMBSTONE_PREFIX)) : [];
}

const OLD_KEY = 'a'.repeat(24);
const USED_KEY = 'b'.repeat(24);

async function populate(): Promise<{ readonly runsDir: string }> {
  makeSession('old-session', { days: 45 });
  makeSession('new-session', { days: 2 });
  makeRun('old-run', { days: 40, phase: 'completed' });
  makeRun('new-run', { days: 3, phase: 'completed' });
  makeBase(OLD_KEY, 20);
  makeBase(USED_KEY, 1);
  const runsDir = await makeJobWithRuns('nightly', 205);
  return { runsDir };
}

describe('ironcurtain prune', () => {
  it('lists in a dry run what would be removed, without removing or locking anything', async () => {
    const { runsDir } = await populate();
    const report = await prune({ dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(removedIds(report, 'sessions')).toEqual(['old-session']);
    expect(removedIds(report, 'workflowRuns')).toEqual(['old-run']);
    expect(removedIds(report, 'dependencyCaches')).toEqual([OLD_KEY]);
    const records = report.removed.find((item) => item.category === 'jobRuns');
    expect(records).toMatchObject({ id: 'nightly', count: 5 });
    expect(report.removed.find((item) => item.id === 'old-session')?.reason).toMatch(/inactive for 45 days/);
    expect(report.removed.every((item) => item.bytes > 0)).toBe(true);

    // Nothing changed.
    expect(existsSync(join(getSessionsDir(), 'old-session'))).toBe(true);
    expect(existsSync(join(getWorkflowRunsDir(), 'old-run'))).toBe(true);
    expect(existsSync(join(home, 'workflow-dependency-bases', OLD_KEY))).toBe(true);
    expect(readdirSync(runsDir).filter((name) => name !== LATEST_RUN_POINTER_FILE)).toHaveLength(205);
    expect(existsSync(getPruneLockPath())).toBe(false);
    expect(existsSync(join(getSessionsDir(), 'old-session', 'resume.lock'))).toBe(false);
  });

  it('removes what is past its limit and keeps the rest', async () => {
    const { runsDir } = await populate();
    const report = await prune();

    expect(report.dryRun).toBe(false);
    expect(report.failed).toEqual([]);
    expect(removedIds(report, 'sessions')).toEqual(['old-session']);
    expect(readdirSync(getSessionsDir())).toEqual(['new-session']);
    expect(readdirSync(getWorkflowRunsDir())).toEqual(['new-run']);
    expect(readdirSync(join(home, 'workflow-dependency-bases'))).toEqual([USED_KEY]);
    // The newest 200 records and the pointer remain.
    const left = readdirSync(runsDir).sort();
    expect(left).toHaveLength(201);
    expect(left).toContain(LATEST_RUN_POINTER_FILE);
    expect(left[0]).toBe('2026-01-01T00-05-00.000Z.json');
    // No tombstone and no prune lock is left behind.
    expect(tombstones(getSessionsDir())).toEqual([]);
    expect(tombstones(getWorkflowRunsDir())).toEqual([]);
    expect(existsSync(getPruneLockPath())).toBe(false);
  });

  it('honors null limits as keep forever', async () => {
    await populate();
    const retention: ResolvedRetentionConfig = {
      ...RETENTION_CONFIG_DEFAULTS,
      sessions: { maxAgeDays: null, maxBytes: null },
      workflowRuns: { maxAgeDays: null, maxBytes: null },
      jobRuns: { maxRecords: null },
      dependencyCaches: { maxUnusedDays: null },
    };
    const report = await prune({ retention });
    expect(report.removed).toEqual([]);
    expect(readdirSync(getSessionsDir()).sort()).toEqual(['new-session', 'old-session']);
  });

  describe('live sessions', () => {
    it('never removes a session whose PTY registration names a live process', async () => {
      const dir = makeSession('pty-session', { days: 90 });
      mkdirSync(join(home, 'pty-registry'), { recursive: true });
      writeFileSync(
        join(home, 'pty-registry', 'session-pty-session.json'),
        JSON.stringify({
          sessionId: 'pty-session',
          escalationDir: join(dir, 'escalations'),
          label: 'Claude Code (interactive)',
          startedAt: new Date().toISOString(),
          pid: process.pid,
        }),
      );

      const report = await prune();
      expect(existsSync(dir)).toBe(true);
      expect(keptReason(report, 'pty-session')).toMatch(/PTY session is running it \(pid \d+\)/);

      // Once its process is gone, the registration no longer protects it.
      const after = await prune({ isPidAlive: () => false });
      expect(removedIds(after, 'sessions')).toEqual(['pty-session']);
      expect(existsSync(dir)).toBe(false);
    });

    it('keeps a session behind an unreadable PTY registration (fail closed)', async () => {
      const dir = makeSession('pty-garbled', { days: 90 });
      mkdirSync(join(home, 'pty-registry'), { recursive: true });
      writeFileSync(join(home, 'pty-registry', 'session-pty-garbled.json'), '{not json');
      const report = await prune();
      expect(existsSync(dir)).toBe(true);
      expect(keptReason(report, 'pty-garbled')).toMatch(/PTY session/);
    });

    it('never removes a session whose resume.lock a live process holds', async () => {
      const dir = makeSession('locked-session', { days: 90 });
      const handle = lock(join(dir, 'resume.lock'));

      const dry = await prune({ dryRun: true });
      expect(removedIds(dry)).toEqual([]);
      expect(keptReason(dry, 'locked-session')).toMatch(/running session holds it \(pid \d+\)/);
      const report = await prune();
      expect(existsSync(dir)).toBe(true);
      expect(keptReason(report, 'locked-session')).toMatch(/running session holds it/);

      handle.release();
      const after = await prune();
      expect(removedIds(after, 'sessions')).toEqual(['locked-session']);
    });

    it('keeps the sessions the calling daemon runs, however idle', async () => {
      const dir = makeSession('daemon-session', { days: 400 });
      const report = await prune({ liveSessionIds: new Set(['daemon-session']) });
      expect(existsSync(dir)).toBe(true);
      expect(keptReason(report, 'daemon-session')).toBe('the daemon is running it');
    });

    it('keeps sessions and runs whose container resources may remain (owner lease)', async () => {
      makeSession('leased-session', { days: 60 });
      makeRun('leased-run', { days: 60, phase: 'completed', bundles: ['bundle-1'] });
      const report = await prune({
        listLeaseBundles: () => ({ bundleIds: new Set(['leased-session', 'bundle-1']), unreadable: 0 }),
      });
      expect(report.removed).toEqual([]);
      expect(keptReason(report, 'leased-session')).toMatch(/container resources may remain/);
      expect(keptReason(report, 'leased-run')).toMatch(/container resources may remain/);
    });

    it('prunes no session or run while an owner lease record cannot be read (fail closed)', async () => {
      // An unreadable record names no bundle: its containers may mount any
      // session or run directory.
      makeSession('old-session', { days: 60 });
      makeRun('old-run', { days: 60, phase: 'completed', dependencyKeys: [OLD_KEY] });
      makeBase(OLD_KEY, 30);
      const report = await prune({ listLeaseBundles: () => ({ bundleIds: new Set<string>(), unreadable: 1 }) });
      expect(report.removed).toEqual([]);
      expect(report.notes.join('\n')).toMatch(/not pruned: 1 container owner lease record\(s\).*cannot be read/);
      expect(keptReason(report, OLD_KEY)).toMatch(/could not be checked/);
      expect(existsSync(join(getSessionsDir(), 'old-session'))).toBe(true);
      expect(existsSync(join(getWorkflowRunsDir(), 'old-run'))).toBe(true);
    });

    it('prunes no session or run when the owner leases cannot be read (fail closed)', async () => {
      makeSession('old-session', { days: 60 });
      makeRun('old-run', { days: 60, phase: 'completed', dependencyKeys: [OLD_KEY] });
      makeBase(OLD_KEY, 30);
      const report = await prune({
        listLeaseBundles: () => {
          throw new Error('EACCES: permission denied');
        },
      });
      expect(report.removed).toEqual([]);
      expect(report.notes.join('\n')).toMatch(/owner leases cannot be read/);
      expect(keptReason(report, OLD_KEY)).toMatch(/could not be checked/);
      expect(existsSync(join(getSessionsDir(), 'old-session'))).toBe(true);
    });
  });

  describe('workspaces and workflow sessions', () => {
    it('keeps an old session whose sandbox is the workspace of a kept session', async () => {
      const oldDir = makeSession('old-session', { days: 60 });
      makeSession('new-session', { days: 1, metadata: { workspacePath: join(oldDir, 'sandbox') } });
      const report = await prune();
      expect(existsSync(oldDir)).toBe(true);
      expect(keptReason(report, 'old-session')).toBe('it holds the workspace of session new-session');
    });

    it('keeps an old session whose sandbox a cron job uses as its workspace', async () => {
      const oldDir = makeSession('old-session', { days: 60 });
      await makeJobWithRuns('uses-sandbox', 1, join(oldDir, 'sandbox'));
      const report = await prune();
      expect(existsSync(oldDir)).toBe(true);
      expect(keptReason(report, 'old-session')).toBe('it holds the workspace of cron job uses-sandbox');
    });

    it('prunes no session or run when the cron jobs cannot be listed (fail closed)', async () => {
      // A job's workspace may be an old session's sandbox; unknown jobs keep everything.
      const oldDir = makeSession('old-session', { days: 60 });
      makeRun('old-run', { days: 60, phase: 'completed' });
      writeFileSync(join(home, 'jobs'), 'not a directory');
      const report = await prune();
      expect(report.removed).toEqual([]);
      expect(report.notes.join('\n')).toMatch(/not pruned: .*jobs cannot be read, so the workspaces of the cron jobs/);
      expect(existsSync(oldDir)).toBe(true);
    });

    it('prunes no session while the workflow runs cannot be listed, nor a run without the sessions', async () => {
      // A run (or session) that cannot be seen may work in the other's directory.
      const oldDir = makeSession('old-session', { days: 60 });
      writeFileSync(getWorkflowRunsDir(), 'not a directory');
      const withoutRuns = await prune();
      expect(withoutRuns.removed).toEqual([]);
      expect(withoutRuns.notes.join('\n')).toMatch(/Sessions and workflow runs were not pruned: .*workflow-runs/);
      expect(existsSync(oldDir)).toBe(true);

      rmSync(getWorkflowRunsDir());
      const runDir = makeRun('old-run', { days: 60, phase: 'completed' });
      rmSync(getSessionsDir(), { recursive: true });
      writeFileSync(getSessionsDir(), 'not a directory');
      const withoutSessions = await prune();
      expect(withoutSessions.removed).toEqual([]);
      expect(existsSync(runDir)).toBe(true);
    });

    it('matches a workspace recorded through a symlink by its real path', async () => {
      const oldDir = makeSession('old-session', { days: 60 });
      symlinkSync(join(oldDir, 'sandbox'), join(root, 'link-to-sandbox'));
      makeSession('new-session', { days: 1, metadata: { workspacePath: join(root, 'link-to-sandbox') } });
      const report = await prune();
      expect(existsSync(oldDir)).toBe(true);
      expect(keptReason(report, 'old-session')).toMatch(/workspace of session new-session/);
    });

    it('keeps an old run whose workspace a kept session uses, and protects transitively', async () => {
      const runDir = makeRun('old-run', { days: 60, phase: 'completed' });
      // The old session uses the run's workspace and is itself kept: a newer
      // session works in the old session's sandbox.
      const oldSession = makeSession('old-session', {
        days: 60,
        metadata: { workspacePath: join(runDir, 'workspace') },
      });
      makeSession('new-session', { days: 1, metadata: { workspacePath: join(oldSession, 'sandbox') } });
      const report = await prune();
      expect(report.removed).toEqual([]);
      expect(keptReason(report, 'old-session')).toMatch(/workspace of session new-session/);
      expect(keptReason(report, 'old-run')).toMatch(/workspace of session old-session/);
    });

    it('keeps the directory holding the workspace of a run that became live while the prune ran', async () => {
      const sessionDir = makeSession('old-session', { days: 60 });
      const runDir = makeRun('old-run', { days: 60, phase: 'failed', workspacePath: join(sessionDir, 'sandbox') });
      // Both are idle and selected; the run is resumed once removals begin.
      const report = await prune({ signal: signalOnFirstCheck(() => lock(join(runDir, 'run.lock'))) });
      expect(keptReason(report, 'old-run')).toMatch(/^it became live \(pid \d+\)$/);
      expect(keptReason(report, 'old-session')).toBe('it holds the workspace of workflow run old-run, which is kept');
      expect(report.removed).toEqual([]);
      expect(existsSync(join(sessionDir, 'sandbox', 'work.txt'))).toBe(true);
    });

    it('removes a session that became live only after the run whose workspace it uses', async () => {
      const runDir = makeRun('old-run', { days: 70, phase: 'completed' });
      const sessionDir = makeSession('old-session', {
        days: 60,
        metadata: { workspacePath: join(runDir, 'workspace') },
      });
      const report = await prune({ signal: signalOnFirstCheck(() => lock(join(sessionDir, 'resume.lock'))) });
      expect(keptReason(report, 'old-session')).toMatch(/^it became live \(pid \d+\)$/);
      expect(keptReason(report, 'old-run')).toBe('it holds the workspace of session old-session, which is kept');
      expect(existsSync(join(runDir, 'workspace', 'result.txt'))).toBe(true);
    });

    it('removes idle sessions that work in each other’s sandbox', async () => {
      const first = join(getSessionsDir(), 'first-session');
      const second = join(getSessionsDir(), 'second-session');
      makeSession('first-session', { days: 50, metadata: { workspacePath: join(second, 'sandbox') } });
      makeSession('second-session', { days: 40, metadata: { workspacePath: join(first, 'sandbox') } });
      const report = await prune();
      expect(removedIds(report)).toEqual(['first-session', 'second-session']);
      expect(readdirSync(getSessionsDir())).toEqual([]);
    });

    it('breaks a cycle at one of its members, never at an entry that only waits on it', async () => {
      // `waiting` (oldest) holds a workspace of `first`; `first` and `second`
      // work in each other's sandbox. `first` must be handled before `waiting`.
      const waiting = makeSession('waiting-session', { days: 70 });
      const first = join(getSessionsDir(), 'first-session');
      const second = join(getSessionsDir(), 'second-session');
      makeSession('first-session', { days: 60, metadata: { workspacePath: join(waiting, 'sandbox') } });
      writeFileSync(
        join(first, 'session-state.json'),
        JSON.stringify({
          sessionId: 'first-session',
          status: 'user-exit',
          exitCode: 0,
          lastActivity: new Date().toISOString(),
          workspacePath: join(second, 'sandbox'),
          agent: 'claude-code',
          label: 'first',
          resumable: true,
        }),
      );
      age(first, 60);
      makeSession('second-session', { days: 50, metadata: { workspacePath: join(first, 'sandbox') } });

      const report = await prune({ signal: signalOnFirstCheck(() => lock(join(first, 'resume.lock'))) });
      expect(keptReason(report, 'first-session')).toMatch(/^it became live/);
      expect(keptReason(report, 'waiting-session')).toBe(
        'it holds the workspace of session first-session, which is kept',
      );
      expect(keptReason(report, 'second-session')).toBe(
        'it holds the workspace of session first-session, which is kept',
      );
      expect(report.removed).toEqual([]);
    });

    it('keeps the sessions of a workflow run that is kept, and removes them with it', async () => {
      makeRun('active-run', { days: 1 });
      makeSession('state-of-active', { days: 50, metadata: { workflowRunId: 'active-run' } });
      makeRun('done-run', { days: 50, phase: 'completed' });
      makeSession('state-of-done', { days: 50, metadata: { workflowRunId: 'done-run' } });
      const report = await prune();
      expect(keptReason(report, 'state-of-active')).toBe('it belongs to workflow run active-run, which is kept');
      expect(removedIds(report)).toEqual(['done-run', 'state-of-done']);
    });
  });

  describe('workflow runs', () => {
    it('never removes a run whose run.lock a live process holds', async () => {
      const dir = makeRun('running', { days: 90 });
      lock(join(dir, 'run.lock'));
      const report = await prune();
      expect(existsSync(dir)).toBe(true);
      expect(keptReason(report, 'running')).toMatch(/it is running \(pid \d+\)/);
    });

    it('removes resumable runs for their age only, never to meet the size cap', async () => {
      makeRun('finished-old', { days: 10, phase: 'completed', bytes: 200_000 });
      makeRun('finished-newer', { days: 5, phase: 'completed', bytes: 200_000 });
      makeRun('resumable-oldest', { days: 20, phase: 'failed', bytes: 200_000 });
      makeRun('no-checkpoint', { days: 8, phase: null, bytes: 200_000 });
      makeRun('fresh', { days: 0, phase: 'completed', bytes: 200_000 });
      const retention: ResolvedRetentionConfig = {
        ...RETENTION_CONFIG_DEFAULTS,
        workflowRuns: { maxAgeDays: null, maxBytes: 450_000 },
      };
      const report = await prune({ retention });
      // Oldest finished first until what stays fits: the failed (resumable)
      // run and the one active within the last day are never chosen.
      expect(removedIds(report, 'workflowRuns')).toEqual(['finished-newer', 'finished-old', 'no-checkpoint']);
      expect(readdirSync(getWorkflowRunsDir()).sort()).toEqual(['fresh', 'resumable-oldest']);
      expect(report.removed[0]?.reason).toMatch(/over its size limit/);
    });

    it('removes leftover tombstones, which run listings never show', async () => {
      makeRun('kept-run', { days: 1, phase: 'completed' });
      const tombstone = join(getWorkflowRunsDir(), `${PRUNE_TOMBSTONE_PREFIX}crashed-run-0123456789ab`);
      mkdirSync(join(tombstone, 'workspace'), { recursive: true });
      writeFileSync(join(tombstone, 'checkpoint.json'), '{}');
      expect(discoverWorkflowRuns(getWorkflowRunsDir()).map((run) => run.workflowId)).toEqual(['kept-run']);

      const dry = await prune({ dryRun: true });
      expect(dry.removed.map((item) => item.reason)).toEqual(['left behind by an interrupted prune']);
      expect(existsSync(tombstone)).toBe(true);
      const report = await prune();
      expect(report.removed.map((item) => item.id)).toEqual([`${PRUNE_TOMBSTONE_PREFIX}crashed-run-0123456789ab`]);
      expect(existsSync(tombstone)).toBe(false);
    });
  });

  describe('dependency caches', () => {
    it('keeps a base a live run seeded from, and one being provisioned, and removes an unused one', async () => {
      const liveRun = makeRun('live-run', { days: 90, dependencyKeys: [USED_KEY] });
      lock(join(liveRun, 'run.lock'));
      const usedBase = makeBase(USED_KEY, 30);
      const busyKey = 'c'.repeat(24);
      const busyBase = makeBase(busyKey, 30);
      mkdirSync(join(home, 'workflow-dependency-bases'), { recursive: true });
      const provisioning = tryAcquireProvisionLock(busyBase);
      if (provisioning === undefined) throw new Error('expected the provisioning lock');
      held.push(provisioning);
      const unusedBase = makeBase(OLD_KEY, 30);
      const recentKey = 'd'.repeat(24);
      makeBase(recentKey, 2);

      const report = await prune();
      expect(existsSync(usedBase)).toBe(true);
      expect(keptReason(report, USED_KEY)).toBe('a layer of workflow run live-run was seeded from it');
      expect(existsSync(busyBase)).toBe(true);
      expect(keptReason(report, busyKey)).toBe('it is being provisioned or seeded');
      expect(existsSync(unusedBase)).toBe(false);
      expect(removedIds(report, 'dependencyCaches')).toEqual([OLD_KEY]);
      expect(readdirSync(join(home, 'workflow-dependency-bases')).sort()).toEqual(
        [USED_KEY, busyKey, `${busyKey}.provision-lock`, recentKey].sort(),
      );
    });

    it('judges a base without a last-used marker by its files, and never touches the legacy cache', async () => {
      makeBase(OLD_KEY, undefined, 30);
      const legacy = join(home, 'workflow-deps', OLD_KEY, 'python-venv');
      mkdirSync(legacy, { recursive: true });
      writeFileSync(join(legacy, 'x.py'), 'x');
      age(join(home, 'workflow-deps'), 400);
      const report = await prune();
      expect(removedIds(report, 'dependencyCaches')).toEqual([OLD_KEY]);
      expect(existsSync(legacy)).toBe(true);
      expect(report.notes.join('\n')).toMatch(/workflow-deps holds dependency caches of earlier IronCurtain versions/);
    });
  });

  describe('activity', () => {
    it('never removes anything active within the last day, whatever the limits', async () => {
      const retention: ResolvedRetentionConfig = {
        ...RETENTION_CONFIG_DEFAULTS,
        sessions: { maxAgeDays: 0.25, maxBytes: null },
        workflowRuns: { maxAgeDays: 0.25, maxBytes: null },
        dependencyCaches: { maxUnusedDays: 0.25 },
      };
      // Idle for half a day: past a quarter-day limit, yet still within the day
      // a session may spend starting (an image build) before anything holds it.
      makeSession('half-day-session', { days: 0.5 });
      makeRun('half-day-run', { days: 0.5, phase: 'completed' });
      makeBase(USED_KEY, 0.5);
      makeSession('two-day-session', { days: 2 });
      makeRun('two-day-run', { days: 2, phase: 'completed' });
      makeBase(OLD_KEY, 2);
      const report = await prune({ retention });
      expect(removedIds(report)).toEqual([OLD_KEY, 'two-day-run', 'two-day-session']);
      expect(readdirSync(getSessionsDir())).toEqual(['half-day-session']);
      expect(readdirSync(getWorkflowRunsDir())).toEqual(['half-day-run']);
      expect(readdirSync(join(home, 'workflow-dependency-bases'))).toEqual([USED_KEY]);
    });

    it('does not count a far-future time an agent set on its workspace as activity', async () => {
      const future = new Date(Date.now() + 365 * DAY_MS);
      const sessionDir = makeSession('old-session', { days: 60 });
      utimesSync(join(sessionDir, 'sandbox'), future, future);
      const runDir = makeRun('old-run', { days: 60, phase: 'completed' });
      utimesSync(join(runDir, 'workspace'), future, future);
      // A time slightly ahead (clock skew of a networked home) is still activity.
      const skewed = new Date(Date.now() + 60 * 60 * 1000);
      const skewedDir = makeSession('skewed-session', { days: 60 });
      utimesSync(join(skewedDir, 'session.log'), skewed, skewed);

      const report = await prune();
      expect(removedIds(report)).toEqual(['old-run', 'old-session']);
      expect(report.removed.find((item) => item.id === 'old-session')?.reason).toMatch(/inactive for 60 days/);
      expect(readdirSync(getSessionsDir())).toEqual(['skewed-session']);
    });
  });

  describe('safety', () => {
    it('never follows or removes a symlink in the sessions directory', async () => {
      const outside = join(root, 'outside');
      mkdirSync(outside);
      writeFileSync(join(outside, 'precious.txt'), 'keep me');
      age(outside, 400);
      mkdirSync(getSessionsDir(), { recursive: true });
      symlinkSync(outside, join(getSessionsDir(), 'linked-session'));
      // A link inside an old session pointing out of it is removed, its target is not.
      const dir = makeSession('old-session', { days: 60 });
      symlinkSync(outside, join(dir, 'sandbox', 'escape'));
      age(dir, 60);

      const report = await prune();
      expect(removedIds(report)).toEqual(['old-session']);
      expect(lstatSync(join(getSessionsDir(), 'linked-session')).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(outside, 'precious.txt'), 'utf8')).toBe('keep me');
    });

    it('works through a sessions directory that is itself a symlink to another disk', async () => {
      const elsewhere = join(root, 'big-disk', 'sessions');
      mkdirSync(elsewhere, { recursive: true });
      symlinkSync(elsewhere, getSessionsDir());
      makeSession('old-session', { days: 60 });
      const report = await prune();
      expect(removedIds(report)).toEqual(['old-session']);
      expect(readdirSync(realpathSync(getSessionsDir()))).toEqual([]);
    });

    it('refuses to run beside another prune, while a dry run still works', async () => {
      makeSession('old-session', { days: 60 });
      lock(getPruneLockPath());
      await expect(prune()).rejects.toMatchObject({ code: PRUNE_BUSY });
      expect(existsSync(join(getSessionsDir(), 'old-session'))).toBe(true);
      expect(removedIds(await prune({ dryRun: true }))).toEqual(['old-session']);
    });

    it('does nothing, and creates nothing, before the IronCurtain home exists', async () => {
      process.env.IRONCURTAIN_HOME = join(root, 'not-yet');
      const report = await prune();
      expect(report).toMatchObject({ removed: [], kept: [], failed: [], notes: [] });
      expect(existsSync(join(root, 'not-yet'))).toBe(false);
    });

    it('stops before removing anything once aborted', async () => {
      makeSession('old-session', { days: 60 });
      const controller = new AbortController();
      controller.abort();
      const report = await prune({ signal: controller.signal });
      expect(report.aborted).toBe(true);
      expect(report.removed).toEqual([]);
      expect(existsSync(join(getSessionsDir(), 'old-session'))).toBe(true);
    });
  });
});

describe('runPruneCommand', () => {
  function capture(): {
    readonly out: string[];
    readonly err: string[];
    write(t: string): void;
    writeError(t: string): void;
  } {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, write: (text) => out.push(text), writeError: (text) => err.push(text) };
  }

  it('prints what a dry run would remove, naming the limits', async () => {
    makeSession('old-session', { days: 45 });
    const io = capture();
    const code = await runPruneCommand(['--dry-run'], {
      ...io,
      retention: RETENTION_CONFIG_DEFAULTS,
      pruneOptions: { listLeaseBundles: NO_LEASES },
    });
    const text = io.out.join('');
    expect(code).toBe(0);
    expect(text).toContain('Dry run: nothing is removed.');
    expect(text).toContain('Sessions (inactive for more than 30 days)');
    expect(text).toMatch(/Would remove 1 session \(.+\):/);
    expect(text).toContain('old-session: inactive for 45 days (limit 30 days)');
    expect(text).toMatch(/Would free .+\. Run `ironcurtain prune` without --dry-run/);
    expect(existsSync(join(getSessionsDir(), 'old-session'))).toBe(true);
  });

  it('prints the report as JSON and removes with no flag', async () => {
    makeSession('old-session', { days: 45 });
    const io = capture();
    const code = await runPruneCommand(['--json'], {
      ...io,
      retention: RETENTION_CONFIG_DEFAULTS,
      pruneOptions: { listLeaseBundles: NO_LEASES },
    });
    expect(code).toBe(0);
    const report = JSON.parse(io.out.join('')) as PruneReport;
    expect(report.dryRun).toBe(false);
    expect(report.removed.map((item) => item.id)).toEqual(['old-session']);
    expect(existsSync(join(getSessionsDir(), 'old-session'))).toBe(false);
  });

  it('escapes JSON error notes while preserving the dry-run report value', async () => {
    const note = 'neutral\u0085\u202e\u034f';
    const io = capture();
    expect(
      await runPruneCommand(['--dry-run', '--json'], {
        ...io,
        retention: RETENTION_CONFIG_DEFAULTS,
        pruneOptions: {
          listLeaseBundles: () => {
            throw new Error(note);
          },
        },
      }),
    ).toBe(0);
    const out = io.out.join('');
    expect(out).not.toMatch(/\u0085|\u202e|\u034f/u);
    expect((JSON.parse(out) as PruneReport).notes.some((text) => text.includes(note))).toBe(true);
  });

  it('rejects unknown options with exit status 2', async () => {
    const io = capture();
    expect(await runPruneCommand(['--force'], io)).toBe(2);
    expect(io.err.join('')).toMatch(/Unknown option '--force'/);
  });

  it('reports another prune in progress with exit status 1', async () => {
    lock(getPruneLockPath());
    const io = capture();
    const code = await runPruneCommand([], { ...io, retention: RETENTION_CONFIG_DEFAULTS });
    expect(code).toBe(1);
    expect(io.err.join('')).toMatch(/Another prune is running \(pid \d+\)/);
  });
});
