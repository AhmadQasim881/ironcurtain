/**
 * The add-job / edit-job review loop's budget-override, workspace and persona
 * steps (FU-24, audit finding WFC-30). The loop used to offer none of them:
 * `budgetOverrides`, `workspace` and `persona` could only be set by editing
 * job.json by hand.
 *
 * - Budget overrides: each limit is set, removed (`none`) or left to the
 *   default (empty), checked with job-store.ts's own budget schema, so the
 *   wizard never saves a job.json the store refuses to load.
 * - Workspace: checked with validateWorkspacePath() against the protected
 *   paths the daemon checks before every run, and kept in canonical form;
 *   empty means the job's default workspace. add-job syncs the job's
 *   repository into a custom workspace as the daemon does (not managed: it
 *   must be empty, and is never created). A changed workspace recompiles the
 *   job's task policy, which is compiled against it, and first revokes the
 *   old one, which the run-time hash check would still accept: a failed
 *   recompile leaves the job refused, never running under a policy compiled
 *   for another workspace.
 * - Persona: only an existing persona can be chosen. A persona job needs no
 *   constitution and the wizard compiles no task policy for it: the persona
 *   is checked instead (its policy, agent model and limits), as the daemon
 *   checks it before every run.
 *
 * Prompts, the editor, policy compilation, the git sync and the daemon
 * control socket are mocked; IRONCURTAIN_HOME is a temporary directory and the
 * personas are real persona directories in it.
 */

import {
  existsSync,
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as prompts from '@clack/prompts';
import type { IronCurtainConfig } from '../src/config/types.js';
import { getJobDir, getJobGeneratedDir, getJobRepoMirrorDir, getJobWorkspaceDir } from '../src/config/paths.js';
import { compileTaskPolicy, type TaskPolicyJob } from '../src/cron/compile-task-policy.js';
import { syncGitRepo } from '../src/cron/git-sync.js';
import { runAddJobWizard, runEditJobWizard, saveNewJobWithPolicy } from '../src/cron/job-commands.js';
import { checkJobPolicy, REVOKED_JOB_POLICY_FILENAME } from '../src/cron/job-policy.js';
import { findJobDefinitionProblem, loadJob, readJob, saveJob } from '../src/cron/job-store.js';
import { createJobId, type JobDefinition } from '../src/cron/types.js';
import { sendControlRequest } from '../src/daemon/control-socket.js';
import { openEditorForMultiline } from '../src/utils/editor.js';
import { TEST_PERSONA_CONSTITUTION, writeCompiledPolicyFor, writePersonaPolicy } from './fixtures/scoped-policy.js';

/** The protected paths the mocked loadConfig() reports (the daemon checks a workspace against them). */
const config = vi.hoisted(() => ({ protectedPaths: [] as string[] }));

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
vi.mock('../src/cron/git-sync.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/cron/git-sync.js')>()),
  syncGitRepo: vi.fn(),
}));
vi.mock('../src/daemon/control-socket.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/daemon/control-socket.js')>()),
  sendControlRequest: vi.fn(),
}));
vi.mock('../src/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config/index.js')>()),
  loadConfig: vi.fn(
    () =>
      ({
        protectedPaths: config.protectedPaths,
        userConfig: { resourceBudget: {}, memory: { enabled: false, autoSave: false } },
      }) as unknown as IronCurtainConfig,
  ),
}));

const compile = vi.mocked(compileTaskPolicy);
const select = vi.mocked(prompts.select);
const text = vi.mocked(prompts.text);
const editor = vi.mocked(openEditorForMultiline);

/** Thrown by the mocked process.exit so a wizard's exit is observable. */
class ExitCalled extends Error {
  constructor(readonly code: number | string | null | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

const REPO = 'https://example.com/org/repo.git';
const CONSTITUTION = 'The agent may read files in its workspace.';

let home: string;
let scratch: string;
let savedHome: string | undefined;
let consoleLines: string[];

function job(id: string, overrides: Partial<JobDefinition> = {}): JobDefinition {
  return {
    id: createJobId(id),
    name: `Job ${id}`,
    schedule: '0 9 * * *',
    taskDescription: 'Summarize the repository.',
    taskConstitution: CONSTITUTION,
    notifyOnEscalation: false,
    notifyOnCompletion: false,
    enabled: true,
    ...overrides,
  };
}

/** Saves `definition` with a task policy compiled from its constitution, so the policy is fresh. */
async function saveCompiledJob(definition: JobDefinition): Promise<void> {
  await saveJob(definition);
  writeCompiledPolicyFor(getJobGeneratedDir(definition.id), definition.taskConstitution);
}

/**
 * Writes a persona; `compiled: false` leaves it without a compiled policy,
 * and `definition` adds fields to its persona.json.
 */
function createPersona(
  name: string,
  options: { readonly compiled?: boolean; readonly definition?: Record<string, unknown> } = {},
): void {
  const dir = join(home, 'personas', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'persona.json'),
    JSON.stringify({
      name,
      description: `Persona ${name}`,
      createdAt: '2026-11-15T00:00:00.000Z',
      ...options.definition,
    }),
  );
  if (options.compiled === false) writeFileSync(join(dir, 'constitution.md'), TEST_PERSONA_CONSTITUTION);
  else writePersonaPolicy(dir);
}

/** Queues the answers of the next select prompts (the review menu and the persona picker), in order. */
function answerSelects(...answers: unknown[]): void {
  for (const answer of answers) select.mockResolvedValueOnce(answer);
}

/** Queues the answers of the next text prompts, in order. */
function answerTexts(...answers: string[]): void {
  for (const answer of answers) text.mockResolvedValueOnce(answer);
}

/** The options of the n-th select prompt. */
function selectOptions(call: number): Array<{ value: unknown; label?: string }> {
  return (select.mock.calls[call][0] as { options: Array<{ value: unknown; label?: string }> }).options;
}

/** The label of the review menu entry `value` in the n-th select prompt. */
function menuLabel(call: number, value: string): string {
  return selectOptions(call).find((option) => option.value === value)?.label ?? '';
}

/** The validate callback of the n-th text prompt. */
function textValidator(call: number): (value: string | undefined) => unknown {
  const options = text.mock.calls[call][0] as { validate?: (value: string | undefined) => unknown };
  if (!options.validate) throw new Error(`text prompt ${call} has no validate callback`);
  return options.validate;
}

/** The job.json as written, parsed without the store's validation. */
function rawJobFile(id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(getJobDir(createJobId(id)), 'job.json'), 'utf-8')) as Record<string, unknown>;
}

/** What the wizard logged as errors (clack's log.error), in order. */
function loggedErrors(): string[] {
  return vi.mocked(prompts.log.error).mock.calls.map(([message]) => message);
}

beforeEach(() => {
  savedHome = process.env.IRONCURTAIN_HOME;
  home = mkdtempSync(join(tmpdir(), 'ic-job-wizard-'));
  scratch = mkdtempSync(join(tmpdir(), 'ic-job-wizard-dirs-'));
  process.env.IRONCURTAIN_HOME = home;
  config.protectedPaths = [];
  vi.clearAllMocks();
  for (const mock of [select, text, prompts.confirm, editor, compile, syncGitRepo, sendControlRequest]) {
    vi.mocked(mock).mockReset();
  }
  // A prompt the test did not script fails the test instead of answering
  // undefined, which the review loop would ask again forever. Set on each
  // mock: their signatures differ, so a loop over them does not type-check.
  const unscripted = (): Promise<never> => Promise.reject(new Error('unscripted prompt'));
  select.mockImplementation(unscripted);
  text.mockImplementation(unscripted);
  vi.mocked(prompts.confirm).mockImplementation(unscripted);
  // Like the real compile: writes generated/compiled-policy.json recording the
  // hash of the constitution it was given.
  compile.mockImplementation(async (compiled: TaskPolicyJob) => {
    writeCompiledPolicyFor(getJobGeneratedDir(compiled.id), compiled.taskConstitution);
    return { generatedAt: '', constitutionHash: '', inputHash: '', rules: [] };
  });
  vi.mocked(syncGitRepo).mockResolvedValue({
    ok: true,
    branch: 'main',
    commit: 'abc123',
    discardedChanges: null,
    warnings: [],
  });
  vi.mocked(sendControlRequest).mockResolvedValue({ kind: 'response', response: { ok: true } });
  vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
    throw new ExitCalled(code);
  });
  consoleLines = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    consoleLines.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  if (savedHome === undefined) delete process.env.IRONCURTAIN_HOME;
  else process.env.IRONCURTAIN_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Budget overrides
// ---------------------------------------------------------------------------

describe('budget overrides step', () => {
  it('sets limits, removes one with "none", leaves the rest to the defaults, and recompiles nothing', async () => {
    await saveCompiledJob(job('budget-job'));
    answerSelects('budget', 'confirm');
    answerTexts('1000000', 'none', '', '5');

    await runEditJobWizard('budget-job');

    expect(rawJobFile('budget-job').budgetOverrides).toEqual({
      maxTotalTokens: 1000000,
      maxSteps: null,
      maxEstimatedCostUsd: 5,
    });
    expect(readJob(createJobId('budget-job')).kind).toBe('ok');
    // The menu shows the current value; the budget does not affect the policy.
    expect(menuLabel(0, 'budget')).toBe('Edit budget overrides defaults');
    expect(compile).not.toHaveBeenCalled();
    expect(sendControlRequest).toHaveBeenCalledWith({ command: 'reload-job', jobId: 'budget-job' });
  });

  it('clears every override: job.json is left without budgetOverrides', async () => {
    await saveCompiledJob(job('budget-job', { budgetOverrides: { maxSteps: 50, maxSessionSeconds: 7200 } }));
    answerSelects('budget', 'confirm');
    answerTexts('', '', '', '');

    await runEditJobWizard('budget-job');

    expect(rawJobFile('budget-job')).not.toHaveProperty('budgetOverrides');
    // Each prompt started from the current value.
    expect(text.mock.calls.map(([options]) => (options as { initialValue?: string }).initialValue)).toEqual([
      '',
      '50',
      '7200',
      '',
    ]);
    expect(menuLabel(0, 'budget')).toBe('Edit budget overrides steps 50, timeout 7200s');
  });

  it('the prompts refuse what the job store would refuse, and accept a limit, "none" or nothing', async () => {
    await saveCompiledJob(job('budget-job'));
    answerSelects('budget', 'confirm');
    answerTexts('', '', '', '');

    await runEditJobWizard('budget-job');

    const tokens = textValidator(0);
    const seconds = textValidator(2);
    const cost = textValidator(3);
    for (const bad of ['0', '-5', '1.5', 'abc', '0x10', 'Infinity', '1e400', String(2 ** 53), '12 tokens']) {
      expect(tokens(bad), bad).toEqual(expect.stringContaining('Max total tokens: enter a whole number from 1 to'));
    }
    for (const good of ['', 'none', 'NONE', ' 42 ', '1e6', undefined]) {
      expect(tokens(good), String(good)).toBeUndefined();
    }
    // The time and cost limits need not be whole numbers, but must be above 0.
    expect(seconds('1.5')).toBeUndefined();
    expect(cost('0.25')).toBeUndefined();
    for (const bad of ['0', '-1', '$5', 'NaN']) {
      expect(cost(bad), bad).toEqual(expect.stringContaining('Cost cap in USD: enter a number greater than 0'));
    }
  });

  it('refuses a value the prompt returns anyway and keeps the overrides unchanged', async () => {
    await saveCompiledJob(job('budget-job', { budgetOverrides: { maxSteps: 50 } }));
    answerSelects('budget', 'confirm');
    answerTexts('', '0');

    await runEditJobWizard('budget-job');

    expect(loggedErrors()).toEqual([expect.stringContaining('Budget overrides not changed: Max agent steps: enter')]);
    expect(rawJobFile('budget-job').budgetOverrides).toEqual({ maxSteps: 50 });
  });

  it('add-job saves the overrides with the new job', async () => {
    answerSelects('id', 'taskDescription', 'taskConstitution', 'budget', 'confirm');
    answerTexts('new-budget-job', '200000', '', '1800', 'none');
    editor.mockReturnValueOnce('Summarize the repository.').mockReturnValueOnce(CONSTITUTION);
    vi.mocked(prompts.confirm).mockResolvedValueOnce(false); // no generated constitution

    await runAddJobWizard();

    expect(loadJob(createJobId('new-budget-job'))).toMatchObject({
      enabled: true,
      budgetOverrides: { maxTotalTokens: 200000, maxSessionSeconds: 1800, maxEstimatedCostUsd: null },
    });
  });
});

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

describe('workspace step', () => {
  it('add-job keeps the canonical path and syncs the repository into it as the daemon does (not managed)', async () => {
    const workspace = join(scratch, 'checkout');
    mkdirSync(workspace);
    const link = join(scratch, 'link-to-checkout');
    symlinkSync(workspace, link);
    const canonical = realpathSync(workspace);
    answerSelects('id', 'gitRepo', 'workspace', 'taskDescription', 'taskConstitution', 'confirm');
    answerTexts('ws-job', REPO, link);
    editor.mockReturnValueOnce('Summarize the repository.').mockReturnValueOnce(CONSTITUTION);
    vi.mocked(prompts.confirm).mockResolvedValueOnce(false);

    await runAddJobWizard();

    expect(loadJob(createJobId('ws-job'))).toMatchObject({ workspace: canonical, gitRepo: REPO, enabled: true });
    // The daemon's sync of a custom workspace: managedWorkspace is false (it
    // must be empty the first time and is never created).
    expect(syncGitRepo).toHaveBeenCalledWith({
      uri: REPO,
      workspaceDir: canonical,
      mirrorDir: getJobRepoMirrorDir(createJobId('ws-job')),
      managedWorkspace: false,
    });
    expect(compile).toHaveBeenCalledWith(expect.objectContaining({ id: 'ws-job', workspace: canonical }));
    expect(existsSync(getJobWorkspaceDir(createJobId('ws-job')))).toBe(false);
    expect(vi.mocked(prompts.log.info)).toHaveBeenCalledWith(expect.stringContaining('must be empty'));
  });

  it('add-job without a custom workspace still creates and syncs the managed default one', async () => {
    answerSelects('id', 'gitRepo', 'taskDescription', 'taskConstitution', 'confirm');
    answerTexts('default-ws-job', REPO);
    editor.mockReturnValueOnce('Summarize the repository.').mockReturnValueOnce(CONSTITUTION);
    vi.mocked(prompts.confirm).mockResolvedValueOnce(false);

    await runAddJobWizard();

    const defaultWorkspace = getJobWorkspaceDir(createJobId('default-ws-job'));
    expect(syncGitRepo).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: defaultWorkspace, managedWorkspace: true }),
    );
    expect(existsSync(defaultWorkspace)).toBe(true);
    expect(rawJobFile('default-ws-job')).not.toHaveProperty('workspace');
  });

  it('refuses a protected, IronCurtain-internal, missing or non-directory path', async () => {
    const protectedDir = join(scratch, 'protected');
    mkdirSync(join(protectedDir, 'inside'), { recursive: true });
    config.protectedPaths = [protectedDir];
    mkdirSync(join(home, 'jobs'), { recursive: true });
    const file = join(scratch, 'a-file');
    writeFileSync(file, 'not a directory');
    const refused: ReadonlyArray<readonly [string, string]> = [
      [join(protectedDir, 'inside'), 'overlaps with protected path'],
      [join(home, 'jobs'), 'inside the IronCurtain home directory'],
      [join(scratch, 'missing'), 'does not exist'],
      [file, 'is not a directory'],
    ];
    await saveCompiledJob(job('ws-job'));
    answerSelects(...refused.map(() => 'workspace'), 'confirm');
    answerTexts(...refused.map(([path]) => path));

    await runEditJobWizard('ws-job');

    const errors = loggedErrors();
    refused.forEach(([path, reason], index) => {
      // The prompt refuses it, and so does the wizard when the prompt returns it anyway.
      expect(textValidator(index)(path), path).toEqual(expect.stringContaining(reason));
      expect(errors[index], path).toEqual(expect.stringContaining(`Workspace not changed: `));
      expect(errors[index], path).toEqual(expect.stringContaining(reason));
    });
    expect(rawJobFile('ws-job')).not.toHaveProperty('workspace');
    expect(compile).not.toHaveBeenCalled();
  });

  it('edit-job recompiles the task policy when the workspace changes', async () => {
    const workspace = join(scratch, 'new-workspace');
    mkdirSync(workspace);
    await saveCompiledJob(job('ws-job'));
    answerSelects('workspace', 'confirm');
    answerTexts(workspace);

    await runEditJobWizard('ws-job');

    expect(menuLabel(0, 'workspace')).toBe('Edit workspace        default');
    expect(compile).toHaveBeenCalledTimes(1);
    expect(compile).toHaveBeenCalledWith(expect.objectContaining({ workspace: realpathSync(workspace) }));
    expect(consoleLines).toContain('Workspace changed — recompiling policy...');
  });

  it('re-entering the directory job.json names under another spelling is no change and recompiles nothing', async () => {
    const workspace = join(scratch, 'checkout');
    mkdirSync(workspace);
    const link = join(scratch, 'link-to-checkout');
    symlinkSync(workspace, link);
    // A hand-edited job.json naming the workspace through a symlink.
    await saveCompiledJob(job('ws-job', { workspace: link }));
    answerSelects('workspace', 'confirm');
    answerTexts(realpathSync(workspace));

    await runEditJobWizard('ws-job');

    expect(rawJobFile('ws-job').workspace).toBe(link);
    expect(compile).not.toHaveBeenCalled();
  });

  it('a workspace change revokes the old policy first: a failed recompile leaves the job refused, not running under it', async () => {
    // The run-time check compares only the constitution hash, which a policy
    // compiled for the old workspace still matches.
    const workspace = join(scratch, 'new-workspace');
    mkdirSync(workspace);
    await saveCompiledJob(job('ws-job'));
    answerSelects('workspace', 'confirm');
    answerTexts(workspace);
    compile.mockRejectedValueOnce(new Error('model unavailable'));

    await expect(runEditJobWizard('ws-job')).rejects.toMatchObject({ code: 1 });

    const saved = loadJob(createJobId('ws-job'));
    expect(saved?.workspace).toBe(realpathSync(workspace));
    expect(saved && checkJobPolicy(saved)).toMatchObject({ ok: false, problem: 'missing' });
    // Kept for inspection under a name nothing loads.
    const generated = getJobGeneratedDir(createJobId('ws-job'));
    expect(existsSync(join(generated, 'compiled-policy.json'))).toBe(false);
    expect(existsSync(join(generated, REVOKED_JOB_POLICY_FILENAME))).toBe(true);
    const output = consoleLines.join('\n');
    expect(output).toContain('Policy compilation failed: model unavailable');
    expect(output).toContain('Job "ws-job" was saved, but it will not run: Job "ws-job" has no compiled policy.');
    // The daemon is still told, so it refuses the job instead of running an older copy.
    expect(sendControlRequest).toHaveBeenCalledWith({ command: 'reload-job', jobId: 'ws-job' });
  });

  it("a persona job's own policy is revoked with its workspace, so removing the persona later recompiles it", async () => {
    createPersona('reader');
    const workspace = join(scratch, 'new-workspace');
    mkdirSync(workspace);
    // Its own policy, compiled for the default workspace before the persona was set.
    await saveCompiledJob(job('persona-job', { persona: 'reader' }));
    answerSelects('workspace', 'confirm');
    answerTexts(workspace);

    await runEditJobWizard('persona-job');

    // The persona job compiles nothing, and its own policy is out of use.
    expect(compile).not.toHaveBeenCalled();
    expect(existsSync(join(getJobGeneratedDir(createJobId('persona-job')), 'compiled-policy.json'))).toBe(false);

    // A later edit removes the persona: the job now runs under its own
    // policy, which is compiled against the workspace the job has now.
    answerSelects('persona', '', 'confirm');
    await runEditJobWizard('persona-job');

    expect(rawJobFile('persona-job')).not.toHaveProperty('persona');
    expect(compile).toHaveBeenCalledTimes(1);
    expect(compile).toHaveBeenCalledWith(expect.objectContaining({ workspace: realpathSync(workspace) }));
    expect(consoleLines).toContain('No compiled policy — recompiling policy...');
  });

  it('edit-job clears a custom workspace back to the default, and recompiles against it', async () => {
    const workspace = join(scratch, 'old-workspace');
    mkdirSync(workspace);
    await saveCompiledJob(job('ws-job', { workspace: realpathSync(workspace) }));
    answerSelects('workspace', 'confirm');
    answerTexts('');

    await runEditJobWizard('ws-job');

    expect(rawJobFile('ws-job')).not.toHaveProperty('workspace');
    expect(compile).toHaveBeenCalledTimes(1);
    expect(compile.mock.calls[0][0]).not.toHaveProperty('workspace');
  });
});

// ---------------------------------------------------------------------------
// Persona
// ---------------------------------------------------------------------------

describe('persona step', () => {
  it('add-job saves a persona job without a constitution and compiles no task policy', async () => {
    createPersona('reader');
    createPersona('drafter', { compiled: false });
    answerSelects('id', 'persona', 'reader', 'taskDescription', 'confirm');
    answerTexts('persona-job');
    editor.mockReturnValueOnce('Summarize the repository.');

    await runAddJobWizard();

    expect(loadJob(createJobId('persona-job'))).toMatchObject({
      persona: 'reader',
      taskConstitution: '',
      enabled: true,
    });
    expect(compile).not.toHaveBeenCalled();
    // No offer to generate a constitution the job would not use.
    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(sendControlRequest).toHaveBeenCalledWith({ command: 'reload-job', jobId: 'persona-job' });
    // The picker offers "none" and every persona.
    expect(selectOptions(2).map((option) => option.value)).toEqual(['', 'drafter', 'reader']);
    expect(consoleLines).toContain('Checking persona "reader" (the job runs under its policy)...');
  });

  it('the "required" markers and the confirm check follow the persona', async () => {
    createPersona('reader');
    answerSelects('id', 'confirm', 'persona', 'reader', 'taskDescription', 'confirm');
    answerTexts('persona-job');
    editor.mockReturnValueOnce('Summarize the repository.');

    await runAddJobWizard();

    // Without a persona the constitution is required.
    expect(menuLabel(1, 'taskConstitution')).toBe('Edit task constitution  ← required');
    expect(menuLabel(1, 'confirm')).toBe('Confirm — create this job  (required fields missing)');
    expect(vi.mocked(prompts.log.warn)).toHaveBeenCalledWith(
      'Task description and constitution are both required. Please set them before confirming.',
    );
    // With one it is not, and the job can be confirmed once the task is set.
    expect(menuLabel(5, 'taskConstitution')).toBe('Edit task constitution  (not used with a persona)');
    expect(menuLabel(5, 'confirm')).toBe('Confirm — create this job');
    expect(menuLabel(5, 'persona')).toBe('Edit persona          reader');
    expect(loadJob(createJobId('persona-job'))?.persona).toBe('reader');
  });

  it('add-job saves a persona job whose persona has no compiled policy disabled, and exits 1', async () => {
    createPersona('drafter', { compiled: false });
    answerSelects('id', 'persona', 'drafter', 'taskDescription', 'confirm');
    answerTexts('draft-job');
    editor.mockReturnValueOnce('Summarize the repository.');

    await expect(runAddJobWizard()).rejects.toMatchObject({ code: 1 });

    expect(loadJob(createJobId('draft-job'))).toMatchObject({ persona: 'drafter', enabled: false });
    expect(compile).not.toHaveBeenCalled();
    expect(sendControlRequest).not.toHaveBeenCalled();
    const output = consoleLines.join('\n');
    expect(output).toContain('Persona "drafter" has no compiled policy. Run: ironcurtain persona compile drafter');
    expect(output).toContain('Job "draft-job" was saved but is disabled. Fix the persona, then run: ');
    expect(output).toContain('ironcurtain daemon enable-job draft-job');
  });

  it('add-job saves a persona job disabled when the daemon would refuse its runs for the persona model or limits', async () => {
    // A fresh policy, but resource limits the session factory refuses: the
    // daemon refuses every run of the job before it starts (WP-126).
    createPersona('capped', { definition: { resourceBudget: { maxCost: 1 } } });
    createPersona('reader');
    answerSelects('id', 'persona', 'capped', 'taskDescription', 'confirm');
    answerTexts('capped-job');
    editor.mockReturnValueOnce('Summarize the repository.');

    await expect(runAddJobWizard()).rejects.toMatchObject({ code: 1 });

    expect(loadJob(createJobId('capped-job'))).toMatchObject({ persona: 'capped', enabled: false });
    expect(sendControlRequest).not.toHaveBeenCalled();
    const output = consoleLines.join('\n');
    expect(output).toContain('Persona "capped" cannot run the job: Persona "capped" has an invalid resourceBudget');
    expect(output).toContain('Job "capped-job" was saved but is disabled. Fix the persona, then run: ');
    // The picker says so before it is chosen.
    const hints = (select.mock.calls[2][0] as { options: Array<{ value: unknown; hint?: string }> }).options;
    expect(hints.find((option) => option.value === 'capped')?.hint).toContain('invalid agent model or limits');
    expect(hints.find((option) => option.value === 'reader')?.hint).toBe('Persona reader');
  });

  it("edit-job reports a persona whose model or limits the daemon's run check refuses", async () => {
    createPersona('capped', { definition: { agentModelId: 'not a model id' } });
    await saveCompiledJob(job('plain-job'));
    answerSelects('persona', 'capped', 'confirm');

    await runEditJobWizard('plain-job');

    expect(loadJob(createJobId('plain-job'))?.persona).toBe('capped');
    expect(consoleLines.join('\n')).toContain(
      'Job "plain-job" was saved, but it will not run: Persona "capped" has an invalid agentModelId',
    );
  });

  it('refuses a persona that does not exist', async () => {
    await saveCompiledJob(job('plain-job'));
    answerSelects('persona', 'ghost', 'confirm');

    await runEditJobWizard('plain-job');

    expect(loggedErrors()).toEqual([expect.stringContaining('Persona not changed: Persona "ghost" not found')]);
    expect(rawJobFile('plain-job')).not.toHaveProperty('persona');
  });

  it('edit-job sets a persona without compiling the task policy the job will not use', async () => {
    createPersona('reader');
    // The job's own policy is missing, and its constitution changes too: a
    // job without a persona would be recompiled for either.
    await saveJob(job('plain-job'));
    answerSelects('persona', 'reader', 'taskConstitution', 'confirm');
    editor.mockReturnValueOnce('The agent may read and write files.');

    await runEditJobWizard('plain-job');

    expect(loadJob(createJobId('plain-job'))).toMatchObject({
      persona: 'reader',
      taskConstitution: 'The agent may read and write files.',
    });
    expect(compile).not.toHaveBeenCalled();
    expect(sendControlRequest).toHaveBeenCalledWith({ command: 'reload-job', jobId: 'plain-job' });
    // The persona's policy is fresh: nothing says the job will not run.
    expect(consoleLines.join('\n')).not.toContain('will not run');
  });

  it("edit-job reports a persona whose policy cannot run the job, as the daemon's run check would", async () => {
    createPersona('drafter', { compiled: false });
    await saveCompiledJob(job('plain-job'));
    answerSelects('persona', 'drafter', 'confirm');

    await runEditJobWizard('plain-job');

    expect(loadJob(createJobId('plain-job'))?.persona).toBe('drafter');
    expect(compile).not.toHaveBeenCalled();
    expect(consoleLines.join('\n')).toContain(
      'Job "plain-job" was saved, but it will not run: Persona "drafter" has no compiled policy.',
    );
  });

  it('clearing the persona needs a constitution again, and compiles the policy the job now runs under', async () => {
    createPersona('reader');
    await saveJob(job('persona-job', { persona: 'reader', taskConstitution: '' }));
    answerSelects('persona', '', 'confirm', 'taskConstitution', 'confirm');
    editor.mockReturnValueOnce(CONSTITUTION);

    await runEditJobWizard('persona-job');

    expect(vi.mocked(prompts.log.warn)).toHaveBeenCalledWith(
      'Task description and constitution are both required. Please set them before confirming.',
    );
    expect(rawJobFile('persona-job')).not.toHaveProperty('persona');
    expect(compile).toHaveBeenCalledTimes(1);
    expect(compile).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'persona-job', taskConstitution: CONSTITUTION }),
    );
    expect(consoleLines.join('\n')).not.toContain('will not run');
  });
});

// ---------------------------------------------------------------------------
// Saving: never a job.json the store refuses, and the persona save path
// ---------------------------------------------------------------------------

describe('saving', () => {
  it('confirm refuses a definition the job store would read back as invalid', async () => {
    await saveCompiledJob(job('plain-job'));
    // A prompt that returns an empty schedule (the real prompt refuses it).
    answerSelects('schedule', 'confirm', 'schedule', 'confirm');
    answerTexts('', '0 8 * * *');

    await runEditJobWizard('plain-job');

    expect(loggedErrors()).toEqual([expect.stringMatching(/^The job cannot be saved: schedule: /)]);
    expect(loadJob(createJobId('plain-job'))?.schedule).toBe('0 8 * * *');
  });

  it('findJobDefinitionProblem applies the read-back checks to the definition itself', () => {
    expect(findJobDefinitionProblem(job('plain-job', { budgetOverrides: { maxSteps: null } }))).toBeUndefined();
    expect(findJobDefinitionProblem(job('plain-job', { budgetOverrides: { maxSteps: 0 } }))).toMatch(
      /^budgetOverrides\.maxSteps: /,
    );
    // JSON would write Infinity as null ("no limit"): refused before it is written.
    expect(findJobDefinitionProblem(job('plain-job', { budgetOverrides: { maxEstimatedCostUsd: Infinity } }))).toMatch(
      /^budgetOverrides\.maxEstimatedCostUsd: /,
    );
    expect(findJobDefinitionProblem(job('plain-job', { workspace: '' }))).toMatch(/^workspace: /);
  });

  it('saveNewJobWithPolicy checks a persona job against the persona policy and compiles nothing', async () => {
    createPersona('reader');
    createPersona('drafter', { compiled: false });
    const compileSpy = vi.fn();

    expect(await saveNewJobWithPolicy(job('ready-job', { persona: 'reader' }), compileSpy)).toEqual({ ok: true });
    expect(loadJob(createJobId('ready-job'))?.enabled).toBe(true);

    expect(await saveNewJobWithPolicy(job('unready-job', { persona: 'drafter' }), compileSpy)).toMatchObject({
      ok: false,
      problem: 'missing',
    });
    expect(loadJob(createJobId('unready-job'))?.enabled).toBe(false);
    expect(compileSpy).not.toHaveBeenCalled();
  });
});
