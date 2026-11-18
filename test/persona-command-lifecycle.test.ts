/**
 * The persona CLI's lifecycle commands (CFG-25: clone, rename, trash
 * list/restore/purge) and its handling of persona.json that cannot be used
 * (CFG-8: a persona directory copied by hand must never be edited through
 * the name its persona.json still carries).
 *
 * The prompts and the LLM customizer are faked; nothing is compiled.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('../src/persona/compile-persona-policy.js', () => ({ compilePersonaPolicy: vi.fn() }));
vi.mock('../src/cron/constitution-generator.js', () => ({ generateConstitution: vi.fn() }));
vi.mock('../src/persona/persona-customizer.js', () => ({
  runPersonaConstitutionCustomizer: vi.fn(() => Promise.resolve('B rules (edited)')),
}));
vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn(() => false),
  select: vi.fn(),
  confirm: vi.fn(),
  text: vi.fn(),
  multiselect: vi.fn(),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), step: vi.fn(), success: vi.fn(), message: vi.fn() },
}));

import * as prompts from '@clack/prompts';
import { main as personaMain } from '../src/persona/persona-command.js';
import { createPersona, deletePersona } from '../src/persona/persona-service.js';
import { getPersonaTrashDir } from '../src/persona/persona-trash.js';
import { createPersonaName } from '../src/persona/types.js';
import { writeCompiledPolicyFor } from './fixtures/scoped-policy.js';
import { generateConstitution } from '../src/cron/constitution-generator.js';
import { toDisplayText } from '../src/terminal/display-sanitize.js';

const TEST_HOME = resolve(`/tmp/ironcurtain-persona-command-lifecycle-test-${process.pid}`);

class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

function personaDir(name: string): string {
  return resolve(TEST_HOME, 'personas', name);
}

function constitutionOf(name: string): string {
  return readFileSync(resolve(personaDir(name), 'constitution.md'), 'utf-8');
}

function makePersona(name: string, constitution = `${name} rules`): void {
  createPersona({ name, description: `Persona ${name}`, constitution }, 'setup');
  writeCompiledPolicyFor(resolve(personaDir(name), 'generated'), `${constitution}\n`);
}

function trashIds(): string[] {
  return existsSync(getPersonaTrashDir()) ? readdirSync(getPersonaTrashDir()) : [];
}

/** Runs `ironcurtain persona ...`: its stderr lines, and the exit code if it called process.exit. */
async function runCli(args: string[]): Promise<{ lines: string[]; exit?: number; exitCode: number }> {
  const lines: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => {
    lines.push(parts.map(String).join(' '));
  });
  vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
    throw new ExitCalled(typeof code === 'number' ? code : undefined);
  });
  process.exitCode = undefined;
  let exit: number | undefined;
  try {
    await personaMain(args);
  } catch (err) {
    if (!(err instanceof ExitCalled)) throw err;
    exit = err.code;
  }
  const exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0;
  process.exitCode = undefined;
  return { lines, exitCode, ...(exit !== undefined ? { exit } : {}) };
}

beforeEach(() => {
  mkdirSync(TEST_HOME, { recursive: true });
  process.env['IRONCURTAIN_HOME'] = TEST_HOME;
});

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  delete process.env['IRONCURTAIN_HOME'];
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('a persona directory copied by hand (CFG-8)', () => {
  beforeEach(() => {
    makePersona('a', 'A rules');
    cpSync(personaDir('a'), personaDir('b'), { recursive: true });
  });

  it('`persona edit` of the copy is refused before anything is written, to the copy or the original', async () => {
    vi.mocked(prompts.select).mockResolvedValue('customize');

    const { lines, exit } = await runCli(['edit', 'b']);

    expect(exit).toBe(1);
    expect(lines.join('\n')).toContain('ironcurtain persona clone a b');
    expect(constitutionOf('a')).toBe('A rules\n');
    expect(constitutionOf('b')).toBe('A rules\n');
    expect(prompts.select).not.toHaveBeenCalled();
  });

  it('`persona show` and `persona compile` of the copy print why it cannot be used', async () => {
    const show = await runCli(['show', 'b']);
    expect(show.exit).toBe(1);
    expect(show.lines.join('\n')).toContain('does not match the persona\'s directory name "b"');

    const compile = await runCli(['compile', 'b']);
    expect(compile.exit).toBe(1);
    expect(compile.lines.join('\n')).toContain('invalid definition');
  });

  it('`persona list` reports the copy as a directory that cannot be used', async () => {
    const { lines } = await runCli(['list']);
    const text = lines.join('\n');
    expect(text).toMatch(/Persona directories that cannot be used:\n\s+b\n/);
    expect(text).toContain('does not match the persona\'s directory name "b"');
  });

  it('a valid persona is still edited in its own directory', async () => {
    vi.mocked(prompts.select).mockResolvedValue('customize');
    vi.mocked(prompts.confirm).mockResolvedValue(false); // "Compile policy now?"

    const { exit } = await runCli(['edit', 'a']);

    expect(exit).toBeUndefined();
    expect(constitutionOf('a')).toBe('B rules (edited)\n');
    expect(constitutionOf('b')).toBe('A rules\n');
  });
});

describe('persona create', () => {
  it('refuses an unconfigured server before asking anything', async () => {
    const { exit } = await runCli(['create', 'p', '--description', 'd', '--servers', 'git,nope']);
    expect(exit).toBe(1);
    expect(
      vi
        .mocked(prompts.cancel)
        .mock.calls.map((call) => String(call[0]))
        .join('\n'),
    ).toContain('"nope"');
    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(existsSync(personaDir('p'))).toBe(false);
  });
});

describe('persona constitution display', () => {
  it('quotes the complete generated policy and reasoning while saving the original text', async () => {
    makePersona('example');
    const text = ' - Example\u0007 policy\u202e label\n - Last example line.';
    vi.mocked(generateConstitution).mockResolvedValueOnce({ constitution: text, reasoning: text, exploredServers: [] });
    vi.mocked(prompts.select).mockResolvedValueOnce('generate').mockResolvedValueOnce('accept');
    vi.mocked(prompts.confirm).mockResolvedValueOnce(false);

    await runCli(['edit', 'example']);

    expect(prompts.note).toHaveBeenCalledWith(toDisplayText(text, { multiline: true }), 'Generated Constitution');
    expect(prompts.log.info).toHaveBeenCalledWith(toDisplayText(text, { multiline: true }));
    expect(constitutionOf('example')).toBe(`${text}\n`);
    const shown = await runCli(['show', 'example']);
    expect(shown.lines).toContain(toDisplayText(`${text}\n`, { multiline: true }));
  });
});

describe('persona clone and rename', () => {
  it('`persona clone` creates the copy and says it needs compiling', async () => {
    makePersona('src');
    const { lines, exit } = await runCli(['clone', 'src', 'dst', '--description', 'A copy']);
    expect(exit).toBeUndefined();
    expect(constitutionOf('dst')).toBe('src rules\n');
    expect(lines.join('\n')).toContain('ironcurtain persona compile dst');
    expect(JSON.parse(readFileSync(resolve(personaDir('dst'), 'persona.json'), 'utf-8'))).toMatchObject({
      name: 'dst',
      description: 'A copy',
    });
  });

  it('`persona clone` refuses an existing target and a bad name', async () => {
    makePersona('src');
    makePersona('dst');
    expect((await runCli(['clone', 'src', 'dst'])).lines.join('\n')).toContain('already exists');
    expect((await runCli(['clone', 'src', '../x'])).exit).toBe(1);
    expect((await runCli(['clone', 'src'])).exit).toBe(1);
  });

  it('`persona rename` moves the persona and tells the user to recompile', async () => {
    makePersona('old');
    const { lines, exit } = await runCli(['rename', 'old', 'new']);
    expect(exit).toBeUndefined();
    expect(existsSync(personaDir('old'))).toBe(false);
    expect(existsSync(personaDir('new'))).toBe(true);
    const text = lines.join('\n');
    expect(text).toContain('moved aside');
    expect(text).toContain('ironcurtain persona compile new');
  });
});

describe('persona trash', () => {
  it('`trash list` shows each entry with its persona and expiry', async () => {
    expect((await runCli(['trash', 'list'])).lines).toEqual(['The persona trash is empty.']);
    makePersona('p');
    const { trashEntry } = deletePersona(createPersonaName('p'), 'cli');

    const text = (await runCli(['trash', 'list'])).lines.join('\n');
    expect(text).toContain(trashEntry ?? 'missing');
    expect(text).toMatch(/persona "p", deleted .*, purged after /);
    expect(text).toContain('Persona p');
  });

  it('`trash restore` refuses a name collision without --force, and replaces with it', async () => {
    makePersona('p', 'deleted rules');
    deletePersona(createPersonaName('p'), 'cli');
    makePersona('p', 'recreated rules');

    const refused = await runCli(['trash', 'restore', 'p']);
    expect(refused.exit).toBe(1);
    expect(refused.lines.join('\n')).toContain('needs force');
    expect(constitutionOf('p')).toBe('recreated rules\n');

    const forced = await runCli(['trash', 'restore', 'p', '--force']);
    expect(forced.exit).toBeUndefined();
    expect(constitutionOf('p')).toBe('deleted rules\n');
    expect(forced.lines.join('\n')).toContain('moved to the trash as');
    expect(trashIds()).toHaveLength(1);
  });

  it('`trash restore --as` restores under another name', async () => {
    makePersona('p');
    deletePersona(createPersonaName('p'), 'cli');
    const { lines, exit } = await runCli(['trash', 'restore', 'p', '--as', 'q']);
    expect(exit).toBeUndefined();
    expect(existsSync(personaDir('q'))).toBe(true);
    expect(lines.join('\n')).toContain('ironcurtain persona compile q');
  });

  it('`trash purge` asks before deleting, and --yes skips the question', async () => {
    makePersona('p');
    deletePersona(createPersonaName('p'), 'cli');

    vi.mocked(prompts.confirm).mockResolvedValueOnce(false);
    expect((await runCli(['trash', 'purge', 'p'])).lines).toContain('Cancelled.');
    expect(trashIds()).toHaveLength(1);

    vi.mocked(prompts.confirm).mockResolvedValueOnce(true);
    expect((await runCli(['trash', 'purge', 'p'])).exitCode).toBe(0);
    expect(trashIds()).toEqual([]);

    makePersona('q');
    deletePersona(createPersonaName('q'), 'cli');
    const { lines } = await runCli(['trash', 'purge', '--all', '--yes']);
    expect(lines.some((line) => line.startsWith('Purged q-'))).toBe(true);
    expect(trashIds()).toEqual([]);
  });

  it('`trash purge` needs exactly one selector', async () => {
    expect((await runCli(['trash', 'purge'])).exit).toBe(1);
    expect((await runCli(['trash', 'purge', '--all', '--expired'])).exit).toBe(1);
    expect((await runCli(['trash', 'purge', 'p', '--all'])).exit).toBe(1);
    expect((await runCli(['trash', 'purge', '--expired'])).lines).toEqual(['Nothing to purge.']);
    expect((await runCli(['trash', 'bogus'])).exit).toBe(1);
  });
});
