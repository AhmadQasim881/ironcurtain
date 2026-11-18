/** Small mocked review fixtures: no terminal writes or model calls. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as prompts from '@clack/prompts';
import { generateText } from 'ai';
import { getUserConstitutionPath } from '../src/config/paths.js';
import { main as customizePolicy, type CustomizerResponse } from '../src/pipeline/constitution-customizer.js';
import { runConstitutionCustomizerLoop } from '../src/pipeline/customizer-loop.js';
import { toDisplayText } from '../src/terminal/display-sanitize.js';

vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn(() => false),
  text: vi.fn(),
  select: vi.fn(),
  confirm: vi.fn(),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
  log: { info: vi.fn(), error: vi.fn(), success: vi.fn(), warn: vi.fn() },
}));
vi.mock('ai', async (original) => ({ ...(await original<typeof import('ai')>()), generateText: vi.fn() }));
vi.mock('../src/config/user-config.js', () => ({
  loadUserConfig: () => ({ policyModelId: 'example', serverCredentials: {} }),
}));
vi.mock('../src/session/prompt-cache.js', () => ({
  createCacheStrategy: () => ({
    wrapSystemPrompt: (text: string) => text,
    applyHistoryBreakpoint: (items: unknown) => items,
  }),
}));
vi.mock('../src/pipeline/pipeline-shared.js', () => ({
  createPipelineLlm: vi.fn(async () => ({ model: {}, logContext: {} })),
  loadToolAnnotationsFile: vi.fn(() => ({ servers: {} })),
}));
vi.mock('../src/pipeline/github-identity.js', () => ({
  resolveGitHubToken: () => undefined,
  discoverGitHubIdentity: vi.fn(),
}));
vi.mock('../src/pipeline/amendment-review.js', () => ({ reviewPendingAmendments: vi.fn(async () => undefined) }));

const marker = 'Example\u0007 marker\u202e label';
const initial = `\ufeff# Example policy\n - Read example documents.\n - ${marker}\n`;
let home: string;
let previousHome: string | undefined;
let tty: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(generateText).mockReset();
  vi.mocked(prompts.text).mockReset();
  vi.mocked(prompts.select).mockReset();
  vi.mocked(prompts.confirm).mockResolvedValue(false);
  previousHome = process.env.IRONCURTAIN_HOME;
  home = mkdtempSync(join(tmpdir(), 'ic-constitution-review-'));
  process.env.IRONCURTAIN_HOME = home;
  writeFileSync(getUserConstitutionPath(), initial);
  tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
});

afterEach(() => {
  if (tty) Object.defineProperty(process.stdin, 'isTTY', tty);
  else Reflect.deleteProperty(process.stdin, 'isTTY');
  if (previousHome === undefined) delete process.env.IRONCURTAIN_HOME;
  else process.env.IRONCURTAIN_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function reply(value: CustomizerResponse): void {
  vi.mocked(generateText).mockResolvedValueOnce({ output: value } as Awaited<ReturnType<typeof generateText>>);
}

async function run(mode: 'shared' | 'global'): Promise<string | undefined> {
  if (mode === 'shared')
    return runConstitutionCustomizerLoop(initial, () => 'Example prompt', {
      stepName: 'example',
      noteTitle: 'Example constitution',
    });
  await customizePolicy();
  return readFileSync(getUserConstitutionPath(), 'utf8');
}

describe.each(['shared', 'global'] as const)('%s constitution review', (mode) => {
  it('shows the full initial policy, every proposed line and summary safely while preserving accepted contents', async () => {
    const rule = `${marker}\nAdditional example line.`;
    reply({ type: 'changes', addRules: [rule], summary: marker });
    vi.mocked(prompts.text).mockResolvedValueOnce('Add an example.').mockResolvedValueOnce('done');
    vi.mocked(prompts.select).mockResolvedValueOnce('accept');

    const saved = await run(mode);

    expect(prompts.note).toHaveBeenCalledWith(toDisplayText(initial, { multiline: true }), expect.any(String));
    const review = vi.mocked(prompts.note).mock.calls.find((call) => call[1] === 'Proposed changes')?.[0];
    expect(review).toContain(toDisplayText(marker));
    expect(review).toContain('Additional example line.');
    expect(review).not.toContain(marker);
    expect(saved).toContain(rule);
    expect(saved).toContain(initial.trim());
  });

  it('quotes both ordinary and refinement questions', async () => {
    reply({ type: 'question', question: marker });
    reply({ type: 'changes', addRules: ['Example rule.'], summary: 'Example summary.' });
    reply({ type: 'question', question: marker });
    vi.mocked(prompts.text)
      .mockResolvedValueOnce('Ask.')
      .mockResolvedValueOnce('Change.')
      .mockResolvedValueOnce('Refine.')
      .mockResolvedValueOnce('done');
    vi.mocked(prompts.select).mockResolvedValueOnce('refine');

    await run(mode);

    expect(
      vi.mocked(prompts.log.info).mock.calls.filter((call) => call[0] === toDisplayText(marker, { multiline: true })),
    ).toHaveLength(2);
  });

  it('quotes model errors from both calls without changing the policy', async () => {
    vi.mocked(generateText).mockRejectedValueOnce(new Error(marker));
    reply({ type: 'changes', addRules: ['Example rule.'], summary: 'Example summary.' });
    vi.mocked(generateText).mockRejectedValueOnce(new Error(marker));
    vi.mocked(prompts.text)
      .mockResolvedValueOnce('Try.')
      .mockResolvedValueOnce('Change.')
      .mockResolvedValueOnce('Refine.')
      .mockResolvedValueOnce('done');
    vi.mocked(prompts.select).mockResolvedValueOnce('refine');

    expect(await run(mode)).toBe(initial);

    expect(
      vi
        .mocked(prompts.log.error)
        .mock.calls.filter((call) => call[0] === `LLM error: ${toDisplayText(marker, { multiline: true })}`),
    ).toHaveLength(2);
  });
});
