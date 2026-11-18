/**
 * The daemon's use of the cron git sync: executeJob and addJob await the
 * (asynchronous) sync through the job's mirror before anything else, a
 * failed sync ends the run with an error record and never starts a session,
 * and the discarded changes reach the run record.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IronCurtainConfig } from '../src/config/types.js';
import { getJobGeneratedDir, getJobRepoMirrorDir, getJobWorkspaceDir } from '../src/config/paths.js';
import { loadJob, loadRecentRuns, saveJob } from '../src/cron/job-store.js';
import type { TaskPolicyJob } from '../src/cron/compile-task-policy.js';
import { createJobId, type JobDefinition } from '../src/cron/types.js';
import { IronCurtainDaemon } from '../src/daemon/ironcurtain-daemon.js';
import * as logger from '../src/logger.js';
import { createStandaloneSession } from '../src/session/index.js';
import type { Session } from '../src/session/types.js';
import { createGitSyncFixture, gitAvailable, posix, type GitSyncFixture } from './fixtures/git-sync-fixture.js';
import { writeCompiledPolicyFor } from './fixtures/scoped-policy.js';

vi.mock('../src/session/index.js', () => ({ createStandaloneSession: vi.fn() }));
// The real compile writes generated/compiled-policy.json recording the hash of
// the constitution (executeJob refuses a job without a matching one) and
// returns the policy it wrote.
vi.mock('../src/cron/compile-task-policy.js', () => ({
  compileTaskPolicy: vi.fn(async (job: TaskPolicyJob) => {
    const { writeCompiledPolicyFor } = await import('./fixtures/scoped-policy.js');
    const { getJobGeneratedDir: generatedDir } = await import('../src/config/paths.js');
    writeCompiledPolicyFor(generatedDir(job.id), job.taskConstitution);
    return { generatedAt: 'test', constitutionHash: 'test', inputHash: 'test', rules: [] };
  }),
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

const createSession = vi.mocked(createStandaloneSession);

describe.skipIf(!gitAvailable || !posix)('daemon cron git sync', () => {
  let f: GitSyncFixture;
  let savedHome: string | undefined;
  let daemon: IronCurtainDaemon;
  /** Workspace contents at the moment the session was created. */
  let readmeAtSessionStart: string | undefined;

  function fakeSession(): Session {
    return {
      getInfo: () => ({ id: 'cron-git-sync-test' }),
      sendMessage: vi.fn(async () => 'done'),
      getBudgetStatus: () => ({
        cumulative: { totalTokens: 10, stepCount: 1, activeSeconds: 1, estimatedCostUsd: 0.01 },
      }),
      close: vi.fn(async () => {}),
    } as unknown as Session;
  }

  function job(overrides: Partial<JobDefinition> = {}): JobDefinition {
    return {
      id: createJobId('git-job'),
      name: 'Git job',
      schedule: '0 9 * * *',
      taskDescription: 'do things',
      taskConstitution: 'The agent may read the workspace.',
      gitRepo: f.uri,
      notifyOnEscalation: false,
      notifyOnCompletion: false,
      enabled: false,
      ...overrides,
    };
  }

  /** Saves the job together with the compiled policy executeJob requires. */
  async function saveJobWithPolicy(definition: JobDefinition): Promise<void> {
    await saveJob(definition);
    writeCompiledPolicyFor(getJobGeneratedDir(definition.id), definition.taskConstitution);
  }

  beforeEach(() => {
    f = createGitSyncFixture();
    f.commitUpstream({ 'README.md': 'readme\n', 'src/app.js': 'app\n' }, 'one');
    savedHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = join(f.root, 'ironcurtain-home');
    readmeAtSessionStart = undefined;
    createSession.mockReset();
    createSession.mockImplementation(async (options) => {
      const workspace = options.workspacePath ?? '';
      readmeAtSessionStart = existsSync(join(workspace, 'README.md'))
        ? readFileSync(join(workspace, 'README.md'), 'utf8')
        : undefined;
      return fakeSession();
    });
    daemon = new IronCurtainDaemon({ mode: { kind: 'builtin' }, noSignal: true });
  });

  afterEach(() => {
    logger.teardown();
    if (savedHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = savedHome;
    f.cleanup();
  });

  it('syncs before creating the session and records the discarded changes', async () => {
    const definition = job();
    await saveJobWithPolicy(definition);

    const first = await daemon.runJobNow(definition.id);
    expect(first.outcome).toEqual({ kind: 'success' });
    expect(first.discardedChanges).toBeNull();
    expect(readmeAtSessionStart).toBe('readme\n');
    expect(existsSync(join(getJobRepoMirrorDir(definition.id), 'HEAD'))).toBe(true);

    // The agent edits a tracked file; upstream moves on.
    const workspace = getJobWorkspaceDir(definition.id);
    writeFileSync(join(workspace, 'src', 'app.js'), 'agent\n');
    f.commitUpstream({ 'README.md': 'readme v2\n' }, 'two');

    const second = await daemon.runJobNow(definition.id);
    expect(second.outcome).toEqual({ kind: 'success' });
    expect(readmeAtSessionStart).toBe('readme v2\n');
    expect(second.discardedChanges).toMatch(/src\/app\.js/u);
    expect(second.discardedChanges).not.toMatch(/README/u);
    expect(readFileSync(join(workspace, 'src', 'app.js'), 'utf8')).toBe('app\n');
    expect(createSession).toHaveBeenCalledTimes(2);
  });

  it('records a failed sync as an error run and never starts a session', async () => {
    const definition = job({ gitRepo: `file://${join(f.root, 'missing-repo')}` });
    await saveJobWithPolicy(definition);

    const record = await daemon.runJobNow(definition.id);
    expect(record.outcome).toMatchObject({ kind: 'error' });
    expect(record.outcome.kind === 'error' ? record.outcome.message : '').toMatch(
      /^Git sync failed: querying file:\/\//u,
    );
    expect(record.budget).toEqual({ totalTokens: 0, stepCount: 0, elapsedSeconds: 0, estimatedCostUsd: 0 });
    expect(createSession).not.toHaveBeenCalled();
    expect(loadRecentRuns(definition.id, 5)).toEqual([record]);
  });

  it('runs the sync against the job URL even when the workspace .git names another remote', async () => {
    const definition = job();
    await saveJobWithPolicy(definition);
    await daemon.runJobNow(definition.id);
    const secret = f.createRepository('secret', { 'SECRET.txt': 'secret\n' });
    const workspace = getJobWorkspaceDir(definition.id);
    const config = join(workspace, '.git', 'config');
    writeFileSync(
      config,
      readFileSync(config, 'utf8').replace(f.uri, `file://${secret}`) +
        `[core]\n\tfsmonitor = "${f.touch('fsmonitor')}; false"\n`,
    );

    const record = await daemon.runJobNow(definition.id);
    expect(record.outcome).toEqual({ kind: 'success' });
    expect(f.markersCreated()).toEqual([]);
    expect(existsSync(join(workspace, 'SECRET.txt'))).toBe(false);
    expect(readFileSync(config, 'utf8')).toContain(f.uri);
  });

  it('never takes over a non-empty user-supplied workspace, in addJob or executeJob', async () => {
    // A user pointed the job at their own checkout: its .git and files must survive.
    const userDir = join(f.root, 'projects', 'mine');
    mkdirSync(userDir, { recursive: true });
    f.git(f.root, 'init', '-q', '-b', 'main', userDir);
    f.commitUpstream({ 'work.txt': 'precious\n' }, 'mine', userDir);
    const userHead = f.head(userDir);
    const definition = job({ workspace: userDir });

    await expect(daemon.addJob(definition)).rejects.toThrow(
      /^Git clone failed: checking the workspace: .*is not empty and was not populated by IronCurtain/u,
    );
    expect(loadJob(definition.id)).toBeUndefined();

    await saveJobWithPolicy(definition);
    const record = await daemon.runJobNow(definition.id);
    expect(record.outcome.kind === 'error' ? record.outcome.message : '').toMatch(
      /^Git sync failed: checking the workspace: .*is not empty and was not populated by IronCurtain/u,
    );
    expect(createSession).not.toHaveBeenCalled();
    expect(lstatSync(join(userDir, '.git')).isDirectory()).toBe(true);
    expect(f.head(userDir)).toBe(userHead);
    expect(readFileSync(join(userDir, 'work.txt'), 'utf8')).toBe('precious\n');
    expect(existsSync(join(userDir, 'README.md'))).toBe(false);
    expect(existsSync(getJobRepoMirrorDir(definition.id))).toBe(false);
  });

  it('clones in addJob through the mirror and rejects the job when the clone fails', async () => {
    const definition = job();
    await daemon.addJob(definition);
    expect(readFileSync(join(getJobWorkspaceDir(definition.id), 'README.md'), 'utf8')).toBe('readme\n');
    expect(existsSync(join(getJobRepoMirrorDir(definition.id), 'HEAD'))).toBe(true);
    expect(loadJob(definition.id)).toEqual(definition);

    const broken = job({ id: createJobId('broken-job'), gitRepo: `file://${join(f.root, 'missing-repo')}` });
    await expect(daemon.addJob(broken)).rejects.toThrow(/^Git clone failed: querying file:\/\//u);
    expect(loadJob(broken.id)).toBeUndefined();
  });
});
