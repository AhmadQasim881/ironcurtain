/**
 * The interactive CLI surfaces of the broad-policy opt-in (CFG-5):
 *  - after a constitution edit, `persona edit` compiles through the shared
 *    path, shows a too-broad result and sets the opt-in only when the user
 *    explicitly allows it (then compiles again);
 *  - the `persona edit` toggle clears the opt-in and revokes a compiled
 *    policy that needed it.
 *
 * The prompts, the editor and the pipeline are faked; the fake pipeline calls
 * the `validateCompiled` hook before writing compiled-policy.json, as the real
 * one does.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const fakePipeline = vi.hoisted((): { calls: number; policy: unknown } => ({ calls: 0, policy: undefined }));
vi.mock('../src/persona/compile-persona-policy.js', () => ({
  compilePersonaPolicy: (name: string, opts: { validateCompiled?: (...args: unknown[]) => void }) => {
    fakePipeline.calls += 1;
    opts.validateCompiled?.(fakePipeline.policy, undefined, packageAnnotations());
    writeFileSync(compiledPolicyPath(name), JSON.stringify(fakePipeline.policy));
    return Promise.resolve(fakePipeline.policy);
  },
}));
vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn(() => false),
  select: vi.fn(),
  confirm: vi.fn(),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), step: vi.fn(), success: vi.fn(), message: vi.fn() },
}));
vi.mock('../src/utils/editor.js', () => ({ openEditor: vi.fn(), openEditorForMultiline: vi.fn() }));

import * as prompts from '@clack/prompts';
import { main as personaMain } from '../src/persona/persona-command.js';
import { REVOKED_POLICY_FILENAME } from '../src/persona/persona-service.js';
import { hashConstitutionText } from '../src/config/constitution-hash.js';
import { openEditor } from '../src/utils/editor.js';
import type { CompiledPolicyFile, CompiledRule, StoredToolAnnotationsFile } from '../src/pipeline/types.js';

const TEST_HOME = resolve(`/tmp/ironcurtain-persona-command-broad-test-${process.pid}`);
const CONSTITUTION = 'Fetch documentation pages.\n';

function packageAnnotations(): StoredToolAnnotationsFile {
  const path = resolve(dirname(fileURLToPath(import.meta.url)), '../src/config/generated/tool-annotations.json');
  return JSON.parse(readFileSync(path, 'utf-8')) as StoredToolAnnotationsFile;
}

function personaDir(name: string): string {
  return resolve(TEST_HOME, 'personas', name);
}
function compiledPolicyPath(name: string): string {
  return resolve(personaDir(name), 'generated', 'compiled-policy.json');
}
function readPersonaJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(personaDir(name), 'persona.json'), 'utf-8')) as Record<string, unknown>;
}

function makePersona(name: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(resolve(personaDir(name), 'generated'), { recursive: true });
  mkdirSync(resolve(personaDir(name), 'workspace'), { recursive: true });
  writeFileSync(
    resolve(personaDir(name), 'persona.json'),
    JSON.stringify({ name, description: 'd', createdAt: '2026-11-11T00:00:00.000Z', ...extra }),
  );
  writeFileSync(resolve(personaDir(name), 'constitution.md'), CONSTITUTION);
}

function policyOf(rules: CompiledRule[]): CompiledPolicyFile {
  return { generatedAt: 'test', constitutionHash: hashConstitutionText(CONSTITUTION), inputHash: 'i', rules };
}

/** Allows every URL: leaves fetch's URL argument unconstrained. */
const UNCONSTRAINED_FETCH: CompiledRule = {
  name: 'allow-any-fetch',
  description: 'd',
  principle: 'p',
  if: { server: ['fetch'], tool: ['http_fetch'] },
  then: 'allow',
  reason: 'r',
};

function auditMethods(): string[] {
  const path = resolve(TEST_HOME, 'audit', 'policy-mutation.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const record = JSON.parse(line) as { method: string; details: { outcome?: string } };
      return record.details.outcome ? `${record.method}:${record.details.outcome}` : record.method;
    });
}

/** Everything the prompts' `log` methods were given, one string per call. */
function logged(level: 'info' | 'warn' | 'error'): string[] {
  return vi.mocked(prompts.log[level]).mock.calls.map((call) => call[0]);
}

/** `persona edit` in $EDITOR: the editor saves a new constitution. */
function editorSaves(name: string, text: string): void {
  vi.mocked(prompts.select).mockResolvedValueOnce('editor');
  vi.mocked(openEditor).mockImplementationOnce(() => {
    writeFileSync(resolve(personaDir(name), 'constitution.md'), text);
    return true;
  });
}

beforeEach(() => {
  mkdirSync(TEST_HOME, { recursive: true });
  process.env['IRONCURTAIN_HOME'] = TEST_HOME;
  fakePipeline.calls = 0;
  fakePipeline.policy = policyOf([UNCONSTRAINED_FETCH]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  // Also drops queued one-shot prompt answers, so a failed test cannot leak them.
  vi.resetAllMocks();
  vi.restoreAllMocks();
  delete process.env['IRONCURTAIN_HOME'];
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('persona edit: compiling a constitution change', () => {
  it('shows a too-broad result and opts in only on an explicit yes, then compiles again', async () => {
    makePersona('web');
    editorSaves('web', 'Fetch any page.\n');
    // "Compile policy now?" yes; "Allow broad policies ... and compile again?" yes.
    vi.mocked(prompts.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(true);

    await personaMain(['edit', 'web']);

    expect(fakePipeline.calls).toBe(2);
    expect(logged('warn').join('\n')).toContain('allow-any-fetch: fetch-url on fetch/http_fetch');
    expect(readPersonaJson('web').allowBroadPolicy).toBe(true);
    expect(existsSync(compiledPolicyPath('web'))).toBe(true);
    expect(auditMethods()).toEqual([
      'setPersonaConstitution',
      'compilePersonaPolicy:rejected',
      'setPersonaBroadPolicyOptIn',
      'compilePersonaPolicy:written',
    ]);
  });

  it('declining leaves the persona without the opt-in and without the broad policy', async () => {
    makePersona('web');
    editorSaves('web', 'Fetch any page.\n');
    vi.mocked(prompts.confirm).mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await personaMain(['edit', 'web']);

    expect(fakePipeline.calls).toBe(1);
    expect(readPersonaJson('web')).not.toHaveProperty('allowBroadPolicy');
    expect(existsSync(compiledPolicyPath('web'))).toBe(false);
    expect(logged('info').join('\n')).toContain('ironcurtain persona compile web --allow-broad');
    expect(auditMethods()).toEqual(['setPersonaConstitution', 'compilePersonaPolicy:rejected']);
  });
});

describe('persona edit: the broad-policy toggle', () => {
  it('clears the opt-in and moves a compiled policy that needed it aside', async () => {
    makePersona('web', { allowBroadPolicy: true });
    writeFileSync(compiledPolicyPath('web'), JSON.stringify(policyOf([UNCONSTRAINED_FETCH])));
    vi.mocked(prompts.select).mockResolvedValueOnce('broad');
    vi.mocked(prompts.confirm).mockResolvedValueOnce(false);

    await personaMain(['edit', 'web']);

    expect(readPersonaJson('web')).not.toHaveProperty('allowBroadPolicy');
    expect(existsSync(compiledPolicyPath('web'))).toBe(false);
    expect(existsSync(resolve(personaDir('web'), 'generated', REVOKED_POLICY_FILENAME))).toBe(true);
    expect(logged('warn').join('\n')).toContain(`moved aside to generated/${REVOKED_POLICY_FILENAME}`);
    expect(fakePipeline.calls).toBe(0);
  });

  it('sets the opt-in without compiling', async () => {
    makePersona('web');
    vi.mocked(prompts.select).mockResolvedValueOnce('broad');
    vi.mocked(prompts.confirm).mockResolvedValueOnce(true);

    await personaMain(['edit', 'web']);

    expect(readPersonaJson('web').allowBroadPolicy).toBe(true);
    expect(fakePipeline.calls).toBe(0);
    expect(auditMethods()).toEqual(['setPersonaBroadPolicyOptIn']);
  });
});
