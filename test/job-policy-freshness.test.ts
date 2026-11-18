/**
 * Cron job policies fail closed when missing or stale.
 *
 * A job must run under the policy compiled from its own constitution. Before
 * this gate, a job whose compile failed, was interrupted or never ran ran
 * unattended under the package's default policy (the loaders fall back to it
 * for any missing artifact), and an edited job ran its new task under the old
 * policy. Covered here: the run-time gate in the daemon (error RunRecord and
 * notification, no session), the constitution hash the gate recomputes, the
 * add-job wizard's save-disabled-until-compiled sequence and the edit-job
 * wizard's recompile rules.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IronCurtainConfig } from '../src/config/types.js';
import { checkScopedPolicy, hashConstitutionText } from '../src/config/constitution-hash.js';
import { getJobDir, getJobGeneratedDir } from '../src/config/paths.js';
import { compileTaskPolicy, type TaskPolicyJob } from '../src/cron/compile-task-policy.js';
import { syncGitRepo } from '../src/cron/git-sync.js';
import { runEditJobWizard, runListJobs, saveNewJobWithPolicy } from '../src/cron/job-commands.js';
import { checkJobPolicy, checkJobPolicyDir } from '../src/cron/job-policy.js';
import { loadAllJobs, loadJob, loadRecentRuns, saveJob } from '../src/cron/job-store.js';
import { createJobId, type JobDefinition } from '../src/cron/types.js';
import { IronCurtainDaemon } from '../src/daemon/ironcurtain-daemon.js';
import { sendControlRequest } from '../src/daemon/control-socket.js';
import * as logger from '../src/logger.js';
import { computeHash } from '../src/pipeline/pipeline-shared.js';
import type { CompiledPolicyFile } from '../src/pipeline/types.js';
import { createStandaloneSession } from '../src/session/index.js';
import type { Session } from '../src/session/types.js';
import { writeCompiledPolicyFor, writePersonaPolicy } from './fixtures/scoped-policy.js';

vi.mock('../src/session/index.js', () => ({ createStandaloneSession: vi.fn() }));
vi.mock('../src/cron/compile-task-policy.js', () => ({ compileTaskPolicy: vi.fn() }));
vi.mock('../src/cron/git-sync.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/cron/git-sync.js')>()),
  syncGitRepo: vi.fn(),
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
vi.mock('../src/daemon/control-socket.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/daemon/control-socket.js')>()),
  sendControlRequest: vi.fn(async () => ({ kind: 'response', response: { ok: true } })),
}));
// The edit wizard's review loop: confirm the job unchanged on the first prompt.
vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  cancel: vi.fn(),
  select: vi.fn(async () => 'confirm'),
  confirm: vi.fn(async () => true),
  text: vi.fn(async () => ''),
  isCancel: () => false,
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), step: vi.fn() },
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
}));

const createSession = vi.mocked(createStandaloneSession);
const compile = vi.mocked(compileTaskPolicy);
const controlRequest = vi.mocked(sendControlRequest);

/** Thrown by the mocked process.exit so a wizard's exit is observable. */
class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

function fakeSession(): Session {
  return {
    getInfo: () => ({ id: 'job-policy-test' }),
    sendMessage: vi.fn(async () => 'done'),
    getBudgetStatus: () => ({
      cumulative: { totalTokens: 10, stepCount: 1, activeSeconds: 1, estimatedCostUsd: 0.01 },
    }),
    close: vi.fn(async () => {}),
  } as unknown as Session;
}

function job(overrides: Partial<JobDefinition> = {}): JobDefinition {
  return {
    id: createJobId('nightly'),
    name: 'Nightly',
    schedule: '0 9 * * *',
    taskDescription: 'Summarize the workspace.',
    taskConstitution: 'The agent may read files in its workspace.',
    notifyOnEscalation: false,
    notifyOnCompletion: false,
    enabled: true,
    ...overrides,
  };
}

/** Writes the job's compiled policy as if compiled from `constitution`. */
function compileJobPolicyFrom(definition: JobDefinition, constitution: string): void {
  writeCompiledPolicyFor(getJobGeneratedDir(definition.id), constitution);
}

/** Writes persona.json, constitution.md and a policy compiled from `compiledFrom`. */
function createPersona(home: string, name: string, constitution: string, compiledFrom: string): void {
  const personaDir = join(home, 'personas', name);
  mkdirSync(join(personaDir, 'workspace'), { recursive: true });
  writeFileSync(
    join(personaDir, 'persona.json'),
    JSON.stringify({ name, description: 'test persona', createdAt: '2026-11-11T00:00:00.000Z' }),
  );
  writePersonaPolicy(personaDir, {}, compiledFrom);
  writeFileSync(join(personaDir, 'constitution.md'), constitution);
}

let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ic-job-policy-'));
  savedHome = process.env.IRONCURTAIN_HOME;
  process.env.IRONCURTAIN_HOME = home;
  createSession.mockReset();
  createSession.mockImplementation(async () => fakeSession());
  // Like the real compile: writes generated/compiled-policy.json recording the
  // hash of the constitution it was given. Individual tests override it.
  compile.mockReset();
  compile.mockImplementation(async (compiled: TaskPolicyJob) => {
    writeCompiledPolicyFor(getJobGeneratedDir(compiled.id), compiled.taskConstitution);
    return {
      generatedAt: '',
      constitutionHash: hashConstitutionText(compiled.taskConstitution),
      inputHash: '',
      rules: [],
    };
  });
  controlRequest.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  logger.teardown();
  if (savedHome === undefined) delete process.env.IRONCURTAIN_HOME;
  else process.env.IRONCURTAIN_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The hash the gate recomputes
// ---------------------------------------------------------------------------

describe('constitution hash and scoped policy state', () => {
  it('hashes a constitution exactly as policy compilation records constitutionHash', () => {
    // PipelineRunner records computeHash(constitutionInput); the runtime helper
    // must agree byte for byte or every policy would read as stale.
    for (const text of ['', 'The agent may read files.', 'Unicode ✓ é\r\nwith trailing space \n\n']) {
      expect(hashConstitutionText(text)).toBe(computeHash(text));
    }
  });

  it('reports missing, fresh and stale states', () => {
    const dir = join(home, 'policy');
    expect(checkScopedPolicy(dir, 'text')).toEqual({ kind: 'missing' });

    writeCompiledPolicyFor(dir, 'text');
    expect(checkScopedPolicy(dir, 'text')).toEqual({ kind: 'fresh' });
    // Any change, including whitespace, is a different constitution.
    expect(checkScopedPolicy(dir, 'text ')).toMatchObject({
      kind: 'stale',
      reason: 'constitution',
      detail: 'the constitution changed after the policy was compiled',
    });
    expect(checkScopedPolicy(dir, undefined)).toMatchObject({ kind: 'stale', reason: 'constitution' });
  });

  it('fails closed on a policy whose provenance cannot be confirmed', () => {
    const dir = join(home, 'policy');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'compiled-policy.json'), JSON.stringify({ rules: [] }));
    expect(checkScopedPolicy(dir, '')).toMatchObject({
      kind: 'stale',
      detail: 'the compiled policy does not record which constitution it was compiled from',
    });
    writeFileSync(join(dir, 'compiled-policy.json'), '{ not json');
    expect(checkScopedPolicy(dir, '')).toMatchObject({
      kind: 'stale',
      detail: 'compiled-policy.json is not valid JSON',
    });
  });
});

// ---------------------------------------------------------------------------
// Run-time gate in the daemon
// ---------------------------------------------------------------------------

describe('daemon executeJob policy gate', () => {
  let daemon: IronCurtainDaemon;
  let sendSignalMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    daemon = new IronCurtainDaemon({ mode: { kind: 'builtin' }, noSignal: true });
    sendSignalMessage = vi.fn(async () => {});
    // Stand in for a configured Signal transport (private field).
    (daemon as unknown as { signalDaemon: unknown }).signalDaemon = { sendSignalMessage };
  });

  it('a job without compiled-policy.json yields an error RunRecord, a notification and no session', async () => {
    const definition = job();
    await saveJob(definition);

    const record = await daemon.runJobNow(definition.id);

    expect(record.outcome.kind).toBe('error');
    expect(record.outcome.kind === 'error' ? record.outcome.message : '').toBe(
      'Job "nightly" has no compiled policy. Compile it with: ironcurtain daemon recompile-job nightly',
    );
    expect(record.budget).toEqual({ totalTokens: 0, stepCount: 0, elapsedSeconds: 0, estimatedCostUsd: 0 });
    expect(createSession).not.toHaveBeenCalled();
    expect(loadRecentRuns(definition.id, 5)).toEqual([record]);
    expect(sendSignalMessage).toHaveBeenCalledWith(
      expect.stringMatching(/^\[cron: Nightly\] Not run: Job "nightly" has no compiled policy/),
    );
  });

  it('a job whose taskConstitution changed after compile refuses to run', async () => {
    const definition = job({ taskConstitution: 'The agent may read AND DELETE files anywhere.' });
    compileJobPolicyFrom(definition, 'The agent may read files in its workspace.');
    await saveJob(definition);

    const record = await daemon.runJobNow(definition.id);

    expect(record.outcome).toEqual({
      kind: 'error',
      phase: 'setup',
      message:
        'Job "nightly" has a stale compiled policy: the constitution changed after the policy was compiled. ' +
        'Recompile it with: ironcurtain daemon recompile-job nightly',
    });
    expect(createSession).not.toHaveBeenCalled();
    expect(loadRecentRuns(definition.id, 5)).toEqual([record]);
    expect(sendSignalMessage).toHaveBeenCalledTimes(1);
  });

  it('refuses before the git sync and sends the refusal notice in place of the completion notice', async () => {
    const definition = job({ notifyOnCompletion: true, gitRepo: 'https://example.invalid/org/repo.git' });
    await saveJob(definition);

    const record = await daemon.runJobNow(definition.id);

    expect(record.outcome).toMatchObject({ kind: 'error', phase: 'setup' });
    expect(vi.mocked(syncGitRepo)).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    // One notice: the refusal (which names the fix), not also "[cron: ...] Error (setup): ...".
    expect(sendSignalMessage).toHaveBeenCalledTimes(1);
    expect(sendSignalMessage).toHaveBeenCalledWith(
      '[cron: Nightly] Not run: Job "nightly" has no compiled policy. ' +
        'Compile it with: ironcurtain daemon recompile-job nightly',
    );
    // Released after the record: the next run is refused again rather than JOB_ALREADY_RUNNING.
    await expect(daemon.runJobNow(definition.id)).resolves.toMatchObject({ outcome: { kind: 'error' } });
  });

  it('runs a job whose policy was compiled from its current constitution, under that policy', async () => {
    const definition = job();
    compileJobPolicyFrom(definition, definition.taskConstitution);
    await saveJob(definition);

    const record = await daemon.runJobNow(definition.id);

    expect(record.outcome).toEqual({ kind: 'success' });
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession.mock.calls[0][0]).toMatchObject({ policyDir: getJobGeneratedDir(definition.id) });
    expect(createSession.mock.calls[0][0]).not.toHaveProperty('allowStalePolicy');
  });

  it('a persona job refuses a persona policy that no longer matches its constitution', async () => {
    createPersona(home, 'reader', 'Read and write anything.\n', 'Read only.\n');
    const definition = job({ persona: 'reader' });
    await saveJob(definition);

    const record = await daemon.runJobNow(definition.id);

    expect(record.outcome.kind === 'error' ? record.outcome.message : '').toMatch(
      /^Persona "reader" has a stale compiled policy: the constitution changed after the policy was compiled\./,
    );
    expect(createSession).not.toHaveBeenCalled();
  });

  it('a persona job without a persona policy refuses to run', async () => {
    createPersona(home, 'reader', 'Read only.\n', 'Read only.\n');
    rmSync(join(home, 'personas', 'reader', 'generated'), { recursive: true });
    const definition = job({ persona: 'reader' });
    await saveJob(definition);

    const record = await daemon.runJobNow(definition.id);

    expect(record.outcome.kind === 'error' ? record.outcome.message : '').toMatch(
      /^Persona "reader" has no compiled policy/,
    );
    expect(createSession).not.toHaveBeenCalled();
  });

  it('a persona job whose persona has malformed resource limits refuses before the git sync (WP-126)', async () => {
    createPersona(home, 'reader', 'Read only.\n', 'Read only.\n');
    writeFileSync(
      join(home, 'personas', 'reader', 'persona.json'),
      JSON.stringify({
        name: 'reader',
        description: 'test persona',
        createdAt: '2026-11-11T00:00:00.000Z',
        resourceBudget: { maxCost: 1 },
      }),
    );
    const definition = job({ persona: 'reader', gitRepo: 'https://example.invalid/org/repo.git' });
    await saveJob(definition);
    vi.mocked(syncGitRepo).mockClear();

    const record = await daemon.runJobNow(definition.id);

    expect(record.outcome).toMatchObject({ kind: 'error', phase: 'setup' });
    expect(record.outcome.kind === 'error' ? record.outcome.message : '').toMatch(
      /^Persona "reader" has an invalid resourceBudget/,
    );
    expect(vi.mocked(syncGitRepo)).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    // The refusal notice goes out whatever the job's notification settings.
    expect(sendSignalMessage).toHaveBeenCalledWith(
      expect.stringMatching(/^\[cron: Nightly\] Not run: Persona "reader" has an invalid resourceBudget/),
    );
  });

  it('a persona job with a fresh persona policy runs under the persona, never the job dir', async () => {
    createPersona(home, 'reader', 'Read only.\n', 'Read only.\n');
    const definition = job({ persona: 'reader' });
    await saveJob(definition);

    const record = await daemon.runJobNow(definition.id);

    expect(record.outcome).toEqual({ kind: 'success' });
    expect(createSession.mock.calls[0][0]).toMatchObject({ persona: 'reader' });
    expect(createSession.mock.calls[0][0]).not.toHaveProperty('policyDir');
  });

  it('recompileJob reloads the job so the scheduled definition matches the new policy', async () => {
    const definition = job({ enabled: false });
    await saveJob(definition);
    const reload = vi.spyOn(daemon, 'reloadJob');

    // Every server compiled, so the result names none (the CLI exits 0).
    expect(await daemon.recompileJob(definition.id)).toEqual({ failedServers: [] });

    expect(compile).toHaveBeenCalledWith(
      expect.objectContaining({ id: definition.id, taskConstitution: definition.taskConstitution }),
    );
    expect(reload).toHaveBeenCalledWith(definition.id);
    expect(checkJobPolicy(definition)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Job policy dirs that reach a session without executeJob (resume)
// ---------------------------------------------------------------------------

describe('checkJobPolicyDir', () => {
  it("checks a job's policy dir against the job's CURRENT constitution", async () => {
    const definition = job();
    compileJobPolicyFrom(definition, definition.taskConstitution);
    await saveJob(definition);
    expect(checkJobPolicyDir(getJobGeneratedDir(definition.id))).toEqual({ jobId: definition.id, ok: true });

    // The constitution is edited and the recompile fails: the old policy stays.
    await saveJob({ ...definition, taskConstitution: 'The agent may delete files anywhere.' });
    expect(checkJobPolicyDir(getJobGeneratedDir(definition.id))).toEqual({
      jobId: definition.id,
      ok: false,
      problem: 'stale',
      message:
        'Job "nightly" has a stale compiled policy: the constitution changed after the policy was compiled. ' +
        'Recompile it with: ironcurtain daemon recompile-job nightly',
    });
  });

  it('identifies the job through a symlinked path to its policy dir', async () => {
    const definition = job();
    compileJobPolicyFrom(definition, 'an older constitution');
    await saveJob(definition);
    const link = join(home, 'policy-link');
    symlinkSync(getJobGeneratedDir(definition.id), link);

    expect(checkJobPolicyDir(link)).toMatchObject({ jobId: definition.id, ok: false, problem: 'stale' });
  });

  it('refuses (throws JOB_INVALID) when the job.json is invalid: its constitution cannot be known', async () => {
    const definition = job();
    compileJobPolicyFrom(definition, definition.taskConstitution);
    await saveJob(definition);
    writeFileSync(join(getJobDir(definition.id), 'job.json'), '{"id": "nightly", ');

    expect(() => checkJobPolicyDir(getJobGeneratedDir(definition.id))).toThrow(
      expect.objectContaining({ code: 'JOB_INVALID' }),
    );
  });

  it('ignores directories that are not a job policy dir', () => {
    createPersona(home, 'reader', 'Read only.\n', 'Read only.\n');
    const elsewhere = join(home, 'other', 'generated');
    writeCompiledPolicyFor(elsewhere, 'anything');

    expect(checkJobPolicyDir(join(home, 'personas', 'reader', 'generated'))).toBeUndefined();
    expect(checkJobPolicyDir(elsewhere)).toBeUndefined();
    expect(checkJobPolicyDir(join(home, 'jobs', 'missing-job', 'generated'))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// add-job wizard: saved disabled until the policy compiles
// ---------------------------------------------------------------------------

describe('add-job: saveNewJobWithPolicy', () => {
  it('Ctrl-C mid-compile leaves no enabled job', async () => {
    let finishCompile: (() => void) | undefined;
    const slowCompile = vi.fn(
      (compiled: TaskPolicyJob) =>
        new Promise<Pick<CompiledPolicyFile, 'failedServers'>>((done) => {
          finishCompile = () => {
            writeCompiledPolicyFor(getJobGeneratedDir(compiled.id), compiled.taskConstitution);
            done({});
          };
        }),
    );
    const definition = job();

    const saving = saveNewJobWithPolicy(definition, slowCompile);
    await vi.waitFor(() => expect(slowCompile).toHaveBeenCalledTimes(1));

    // The process could be killed right now: what is on disk must not be
    // schedulable (daemon start() schedules only enabled jobs).
    expect(loadJob(definition.id)).toEqual({ ...definition, enabled: false });
    expect(loadAllJobs().filter((j) => j.enabled)).toEqual([]);

    finishCompile?.();
    expect(await saving).toEqual({ ok: true });
    expect(loadJob(definition.id)).toEqual(definition);
  });

  it('a failed compile leaves the job saved but disabled', async () => {
    const definition = job();
    const failing = vi.fn(async () => {
      throw new Error('LLM rate limit');
    });

    const result = await saveNewJobWithPolicy(definition, failing);

    expect(result).toEqual({ ok: false, problem: 'missing', message: 'LLM rate limit' });
    expect(loadJob(definition.id)).toEqual({ ...definition, enabled: false });
  });

  it('does not enable a job when the compile produced no matching policy', async () => {
    const definition = job();
    const wrongPolicy = vi.fn(async (compiled: TaskPolicyJob) => {
      writeCompiledPolicyFor(getJobGeneratedDir(compiled.id), 'some other constitution');
      return {};
    });

    const result = await saveNewJobWithPolicy(definition, wrongPolicy);

    expect(result).toMatchObject({ ok: false, problem: 'stale' });
    expect(loadJob(definition.id)?.enabled).toBe(false);
  });

  it('does not enable a job whose policy was written without some servers, and names them', async () => {
    const definition = job();
    const partial = vi.fn(async (compiled: TaskPolicyJob) => {
      writeCompiledPolicyFor(getJobGeneratedDir(compiled.id), compiled.taskConstitution);
      return { failedServers: [{ serverName: 'git', phase: 'verifying' as const, reason: 'judge rejected' }] };
    });

    const result = await saveNewJobWithPolicy(definition, partial);

    expect(result).toEqual({ ok: false, problem: 'partial', failedServers: ['git'] });
    expect(loadJob(definition.id)).toEqual({ ...definition, enabled: false });
    // The policy itself is in place: enable-job runs the job under it.
    expect(checkJobPolicy(definition)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// edit-job wizard: never keeps a missing or stale policy
// ---------------------------------------------------------------------------

describe('edit-job wizard', () => {
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitCalled(code);
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('recompiles when the policy is missing even though the constitution did not change', async () => {
    const definition = job();
    await saveJob(definition);

    await runEditJobWizard(definition.id);

    expect(compile).toHaveBeenCalledWith(
      expect.objectContaining({ id: definition.id, taskConstitution: definition.taskConstitution }),
    );
    expect(checkJobPolicy(definition)).toEqual({ ok: true });
    expect(controlRequest).toHaveBeenCalledWith({ command: 'reload-job', jobId: definition.id });
  });

  it('recompiles a stale policy left behind by an earlier failed compile', async () => {
    const definition = job();
    compileJobPolicyFrom(definition, 'an older constitution');
    await saveJob(definition);

    await runEditJobWizard(definition.id);

    expect(compile).toHaveBeenCalledTimes(1);
    expect(checkJobPolicy(definition)).toEqual({ ok: true });
  });

  it('keeps a policy that still matches the constitution', async () => {
    const definition = job();
    compileJobPolicyFrom(definition, definition.taskConstitution);
    await saveJob(definition);

    await runEditJobWizard(definition.id);

    expect(compile).not.toHaveBeenCalled();
  });

  it('a failed recompile exits non-zero but still reloads the daemon, which then refuses the job', async () => {
    const definition = job();
    compileJobPolicyFrom(definition, 'an older constitution');
    await saveJob(definition);
    compile.mockRejectedValueOnce(new Error('verification failed'));

    await expect(runEditJobWizard(definition.id)).rejects.toThrow(ExitCalled);

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(controlRequest).toHaveBeenCalledWith({ command: 'reload-job', jobId: definition.id });
    // The old policy is still on disk but can never pair with the saved constitution.
    expect(checkJobPolicy(loadJob(definition.id) ?? definition)).toMatchObject({ ok: false, problem: 'stale' });
  });

  it('a recompile that left servers out names them and exits 2; the job runs under the written policy', async () => {
    const definition = job();
    await saveJob(definition);
    compile.mockImplementationOnce(async (compiled: TaskPolicyJob) => {
      const failedServers = [{ serverName: 'git', phase: 'verifying' as const, reason: 'judge rejected' }];
      writeCompiledPolicyFor(getJobGeneratedDir(compiled.id), compiled.taskConstitution, { failedServers });
      return {
        generatedAt: '',
        constitutionHash: hashConstitutionText(compiled.taskConstitution),
        inputHash: '',
        rules: [],
        failedServers,
      };
    });
    const lines: string[] = [];
    vi.mocked(console.error).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });

    try {
      await runEditJobWizard(definition.id);
      expect(process.exitCode).toBe(2);
    } finally {
      process.exitCode = undefined;
    }

    expect(process.exit).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain(
      "1 server(s) failed to compile and have no rules, so the job's calls to their tools are denied until a " +
        'compile succeeds: git.',
    );
    expect(controlRequest).toHaveBeenCalledWith({ command: 'reload-job', jobId: definition.id });
    expect(checkJobPolicy(definition)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// list-jobs: jobs that will be refused are visible before their first run
// ---------------------------------------------------------------------------

describe('list-jobs policy labels', () => {
  it('labels jobs whose policy is missing or stale', async () => {
    const fresh = job({ id: createJobId('fresh-job') });
    const stale = job({ id: createJobId('stale-job') });
    const missing = job({ id: createJobId('missing-job') });
    compileJobPolicyFrom(fresh, fresh.taskConstitution);
    compileJobPolicyFrom(stale, 'an older constitution');
    for (const definition of [fresh, stale, missing]) await saveJob(definition);
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });

    runListJobs();

    const row = (id: string): string => lines.find((l) => l.includes(id)) ?? '';
    expect(row('fresh-job')).not.toMatch(/POLICY/);
    expect(row('stale-job')).toMatch(/POLICY STALE/);
    expect(row('missing-job')).toMatch(/NO POLICY/);
  });
});
