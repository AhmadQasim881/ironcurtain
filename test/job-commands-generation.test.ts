/**
 * The job wizard's "generate constitution" step (WP-134, WFC-25). The
 * generator clones the job's repository into its own throwaway directory;
 * the wizard hands it the repository URI and never the job's real
 * workspace, so generating, then changing the job ID or cancelling the
 * wizard, leaves nothing under ~/.ironcurtain/jobs/. A SIGINT or SIGTERM the
 * spinner catches (onCancel) cancels a generation that is still cloning. In
 * a terminal, clack exits the process on Ctrl-C or Escape instead; the
 * generator's exit hook for that case is tested in
 * constitution-generator.test.ts.
 *
 * Prompts, the editor and the generator are mocked; IRONCURTAIN_HOME is a
 * temporary directory.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as prompts from '@clack/prompts';
import { getJobsDir } from '../src/config/paths.js';
import { generateConstitution, type ConstitutionGeneratorOptions } from '../src/cron/constitution-generator.js';
import { runAddJobWizard } from '../src/cron/job-commands.js';
import { openEditorForMultiline } from '../src/utils/editor.js';
import { toDisplayText } from '../src/terminal/display-sanitize.js';

const scripted = vi.hoisted(() => ({
  /** What a prompt resolves to when the user presses Ctrl-C or Escape. */
  CANCEL: Symbol('cancel'),
  /** Options of every spinner the wizard created. */
  spinnerOptions: [] as Array<{ onCancel?: () => void } | undefined>,
}));

vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn((value: unknown) => value === scripted.CANCEL),
  select: vi.fn(),
  text: vi.fn(),
  confirm: vi.fn(),
  spinner: vi.fn((options?: { onCancel?: () => void }) => {
    scripted.spinnerOptions.push(options);
    return { start: vi.fn(), stop: vi.fn(), message: vi.fn() };
  }),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), step: vi.fn(), success: vi.fn(), message: vi.fn() },
}));
vi.mock('../src/utils/editor.js', () => ({ openEditorForMultiline: vi.fn() }));
vi.mock('../src/cron/constitution-generator.js', () => ({ generateConstitution: vi.fn() }));
vi.mock('../src/cron/job-customizer.js', () => ({ runJobConstitutionCustomizer: vi.fn() }));
vi.mock('../src/cron/compile-task-policy.js', () => ({ compileTaskPolicy: vi.fn() }));

class ExitCalled extends Error {
  constructor(readonly code: number | string | null | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

const REPO = 'https://example.com/org/repo.git';
const TASK = 'Summarize the README every morning.';

let home: string;
let savedHome: string | undefined;

/**
 * Scripts the add-job review loop: set the ID, the git repository and the
 * task, generate a constitution, change the ID, then cancel the wizard.
 * `generationAnswers` are the selects answered inside the generation step.
 */
function scriptGenerateThenCancel(generationAnswers: readonly unknown[]): void {
  const select = vi.mocked(prompts.select).mockResolvedValueOnce('id').mockResolvedValueOnce('gitRepo');
  select.mockResolvedValueOnce('taskDescription');
  for (const answer of generationAnswers) select.mockResolvedValueOnce(answer);
  select.mockResolvedValueOnce('id').mockResolvedValueOnce(scripted.CANCEL);
  vi.mocked(prompts.text)
    .mockResolvedValueOnce('draft-job')
    .mockResolvedValueOnce(REPO)
    .mockResolvedValueOnce('final-job');
  vi.mocked(openEditorForMultiline).mockReturnValueOnce(TASK);
  // Accepts the offer to generate a constitution once the task is entered.
  vi.mocked(prompts.confirm).mockResolvedValueOnce(true);
}

beforeEach(() => {
  savedHome = process.env.IRONCURTAIN_HOME;
  home = mkdtempSync(join(tmpdir(), 'ic-job-generation-'));
  process.env.IRONCURTAIN_HOME = home;
  vi.clearAllMocks();
  for (const mock of [prompts.select, prompts.text, prompts.confirm, openEditorForMultiline, generateConstitution]) {
    vi.mocked(mock).mockReset();
  }
  scripted.spinnerOptions.length = 0;
  vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
    throw new ExitCalled(code);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedHome === undefined) delete process.env.IRONCURTAIN_HOME;
  else process.env.IRONCURTAIN_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

describe('add-job constitution generation', () => {
  it('keeps every policy line visible in the final review and quotes generator progress', async () => {
    const text =
      'First example line.\nSecond example line.\nThird example line.\nFourth\u0007 example.\nLast example line.';
    const message = 'Example\u0007 progress';
    const spinnerMessage = vi.fn();
    vi.mocked(prompts.spinner).mockReturnValueOnce({
      start: vi.fn(),
      stop: vi.fn(),
      message: spinnerMessage,
      cancel: vi.fn(),
      error: vi.fn(),
      clear: vi.fn(),
      isCancelled: false,
    });
    vi.mocked(generateConstitution).mockImplementationOnce(async (options) => {
      options.onProgress?.(message);
      return { constitution: text, reasoning: text, exploredServers: [] };
    });
    scriptGenerateThenCancel(['accept']);

    await expect(runAddJobWizard()).rejects.toMatchObject({ code: 0 });

    const review = vi
      .mocked(prompts.note)
      .mock.calls.filter((call) => call[1] === 'New job')
      .at(-1)?.[0];
    expect(review).toContain('Last example line.');
    expect(review).toContain(toDisplayText('Fourth\u0007 example.'));
    expect(review).not.toContain('more lines');
    expect(spinnerMessage).toHaveBeenCalledWith(toDisplayText(message));
  });

  it('hands the generator the repository, not the job workspace, and leaves no job directory behind', async () => {
    vi.mocked(generateConstitution).mockResolvedValueOnce({
      constitution: ' - The agent may read the repository',
      reasoning: '',
      exploredServers: [],
    });
    scriptGenerateThenCancel(['accept']);

    await expect(runAddJobWizard()).rejects.toMatchObject({ code: 0 });

    expect(generateConstitution).toHaveBeenCalledTimes(1);
    const options = vi.mocked(generateConstitution).mock.calls[0][0];
    expect(options).toMatchObject({ taskDescription: TASK, gitRepo: REPO });
    expect(options).not.toHaveProperty('workspacePath');
    // Neither the ID used while generating nor the final one got a directory.
    expect(existsSync(getJobsDir())).toBe(false);
  });

  it('a signal the generation spinner catches cancels the generation', async () => {
    vi.mocked(generateConstitution).mockImplementationOnce(async (options: ConstitutionGeneratorOptions) => {
      expect(options.signal?.aborted).toBe(false);
      // The spinner reports a SIGINT or SIGTERM it caught through onCancel.
      scripted.spinnerOptions.at(-1)?.onCancel?.();
      expect(options.signal?.aborted).toBe(true);
      throw new Error('constitution generation was cancelled');
    });
    scriptGenerateThenCancel([]);

    await expect(runAddJobWizard()).rejects.toMatchObject({ code: 0 });

    expect(vi.mocked(prompts.log.error)).toHaveBeenCalledWith(
      'Constitution generation failed: constitution generation was cancelled',
    );
    expect(existsSync(getJobsDir())).toBe(false);
  });
});
