/**
 * persona.json validation (CFG-8): `loadPersona` validates the definition
 * with a schema and refuses, never coerces, a file that has the wrong
 * types, an unknown field, or a `name` other than its directory's. A
 * persona directory copied by hand (persona.json still naming the original)
 * is therefore refused everywhere instead of steering edits to the original.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  checkPersonaDefinition,
  isPersonaDefinitionError,
  PERSONA_INVALID,
} from '../src/persona/persona-definition.js';
import { applyServerAllowlist, loadPersona, resolvePersona } from '../src/persona/resolve.js';
import {
  getPersonaDetail,
  listInvalidPersonas,
  listPersonas,
  setPersonaConstitution,
  setPersonaMemory,
} from '../src/persona/persona-service.js';
import { createPersonaName, type PersonaName } from '../src/persona/types.js';
import { isMemoryEnabledForPersonaName } from '../src/persona/memory-gate.js';
import type { MCPServerConfig } from '../src/config/types.js';
import { writePersonaPolicy } from './fixtures/scoped-policy.js';
import { testUserConfig } from './helpers/user-config.js';

const TEST_HOME = resolve(`/tmp/ironcurtain-persona-definition-test-${process.pid}`);
const CREATED_AT = '2026-03-07T12:00:00.000Z';

function personaDir(name: string): string {
  return resolve(TEST_HOME, 'personas', name);
}

function writeDefinition(dirName: string, definition: unknown): void {
  mkdirSync(resolve(personaDir(dirName), 'workspace'), { recursive: true });
  writeFileSync(resolve(personaDir(dirName), 'persona.json'), JSON.stringify(definition));
}

/** A complete, valid persona with a fresh compiled policy. */
function makePersona(name: string, extra: Record<string, unknown> = {}): void {
  writeDefinition(name, { name, description: `Persona ${name}`, createdAt: CREATED_AT, ...extra });
  writePersonaPolicy(personaDir(name), {}, `${name} rules\n`);
}

/** The error `fn` throws (fails the test when it does not throw). */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected a throw');
}

function definitionProblems(fn: () => unknown): readonly string[] {
  const err = thrownBy(fn);
  expect(isPersonaDefinitionError(err), String(err)).toBe(true);
  return isPersonaDefinitionError(err) ? err.problems : [];
}

beforeEach(() => {
  mkdirSync(TEST_HOME, { recursive: true });
  process.env['IRONCURTAIN_HOME'] = TEST_HOME;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['IRONCURTAIN_HOME'];
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('checkPersonaDefinition', () => {
  const dir = createPersonaName('b');
  const base = { name: 'b', description: 'd', createdAt: CREATED_AT };

  it('accepts a complete definition and returns only the known fields, named after the directory', () => {
    const check = checkPersonaDefinition(
      { ...base, servers: ['git'], memory: { enabled: false }, allowBroadPolicy: true, memoryNamespace: 'old' },
      dir,
    );
    expect(check).toEqual({
      ok: true,
      definition: {
        name: 'b',
        description: 'd',
        createdAt: CREATED_AT,
        servers: ['git'],
        memory: { enabled: false },
        memoryNamespace: 'old',
        allowBroadPolicy: true,
      },
    });
  });

  it.each([
    ['a name other than the directory (a copied directory)', { name: 'a' }, /name: "a" does not match .* "b"/],
    ['a path-like name', { name: '../x' }, /name: "\.\.\/x" is not a persona name/],
    ['servers as a bare string', { servers: 'github' }, /servers: expected an array, got "github"/],
    ['a non-name server', { servers: ['Git Hub'] }, /servers\[0\]: is not a server name/],
    ['a string broad-policy opt-in', { allowBroadPolicy: 'false' }, /allowBroadPolicy: expected a boolean/],
    ['a string memory flag', { memory: { enabled: 'no' } }, /memory\.enabled: expected a boolean/],
    ['an unknown field (a misspelled "servers")', { server: ['git'] }, /server: unknown field/],
    ['a createdAt that is not a timestamp', { createdAt: 'yesterday' }, /createdAt: expected an ISO 8601/],
    ['a non-string description', { description: 5 }, /description: expected a string/],
  ])('refuses %s', (_label, patch, problem) => {
    const check = checkPersonaDefinition({ ...base, ...patch }, dir);
    expect(check.ok).toBe(false);
    expect(check.ok ? [] : check.problems).toEqual(expect.arrayContaining([expect.stringMatching(problem)]));
  });

  it('refuses a definition without createdAt and anything that is not an object', () => {
    expect(checkPersonaDefinition({ name: 'b', description: 'd' }, dir)).toMatchObject({ ok: false });
    expect(checkPersonaDefinition('b', dir)).toMatchObject({ ok: false });
    expect(checkPersonaDefinition(null, dir)).toMatchObject({ ok: false });
  });

  it('reports every problem at once, the name included', () => {
    const check = checkPersonaDefinition({ name: 'a', description: 5, createdAt: CREATED_AT, extra: 1 }, dir);
    expect(check.ok ? [] : check.problems).toEqual([
      expect.stringMatching(/^description: /),
      'extra: unknown field',
      expect.stringMatching(/^name: "a" does not match/),
    ]);
  });
});

describe('loadPersona validates persona.json', () => {
  it('loads a valid persona under its directory name', () => {
    makePersona('coder', { servers: ['git'] });
    expect(loadPersona(createPersonaName('coder'))).toEqual({
      name: 'coder',
      description: 'Persona coder',
      createdAt: CREATED_AT,
      servers: ['git'],
    });
  });

  it('refuses a copied persona directory whose persona.json names the original, and points at clone', () => {
    makePersona('a');
    cpSync(personaDir('a'), personaDir('b'), { recursive: true });

    const err = thrownBy(() => loadPersona(createPersonaName('b')));
    expect(err).toMatchObject({ code: PERSONA_INVALID, persona: 'b' });
    expect((err as Error).message).toContain('ironcurtain persona clone a b');
    // The original is untouched and still loads.
    expect(loadPersona(createPersonaName('a')).name).toBe('a');
  });

  it('names the clone command in full, even for the longest persona names', () => {
    const original = 'a'.repeat(63);
    const copy = 'b'.repeat(63);
    makePersona(original);
    cpSync(personaDir(original), personaDir(copy), { recursive: true });
    const err = thrownBy(() => loadPersona(createPersonaName(copy)));
    expect((err as Error).message).toContain(`ironcurtain persona clone ${original} ${copy}`);
  });

  it("refuses a stored name that would leave personas/ ('../x')", () => {
    writeDefinition('b', { name: '../x', description: 'd', createdAt: CREATED_AT });
    expect(definitionProblems(() => loadPersona(createPersonaName('b')))).toEqual([
      expect.stringContaining('name: "../x" is not a persona name'),
    ]);
  });

  it('refuses a string server list and a string opt-in instead of coercing them', () => {
    writeDefinition('s', { name: 's', description: 'd', createdAt: CREATED_AT, servers: 'github' });
    expect(definitionProblems(() => loadPersona(createPersonaName('s')))).toEqual([
      expect.stringContaining('servers: expected an array'),
    ]);

    writeDefinition('o', { name: 'o', description: 'd', createdAt: CREATED_AT, allowBroadPolicy: 'false' });
    expect(definitionProblems(() => loadPersona(createPersonaName('o')))).toEqual([
      expect.stringContaining('allowBroadPolicy: expected a boolean'),
    ]);
  });

  it('refuses a file that is not JSON, and reports a missing one as not found', () => {
    mkdirSync(personaDir('broken'), { recursive: true });
    writeFileSync(resolve(personaDir('broken'), 'persona.json'), '{ not json');
    expect(definitionProblems(() => loadPersona(createPersonaName('broken')))).toEqual([
      expect.stringContaining('is not valid JSON'),
    ]);

    expect(thrownBy(() => loadPersona(createPersonaName('missing')))).toMatchObject({ code: 'PERSONA_NOT_FOUND' });
  });
});

describe('a copied persona directory is refused everywhere (CFG-8 repro)', () => {
  let copy: PersonaName;

  beforeEach(() => {
    makePersona('a');
    cpSync(personaDir('a'), personaDir('b'), { recursive: true });
    copy = createPersonaName('b');
  });

  it('an edit of the copy writes nothing, to the copy or to the original', () => {
    expect(thrownBy(() => setPersonaConstitution(copy, 'B rules (edited)', 'cli'))).toMatchObject({
      code: PERSONA_INVALID,
    });
    expect(readFileSync(resolve(personaDir('a'), 'constitution.md'), 'utf-8')).toBe('a rules\n');
    expect(readFileSync(resolve(personaDir('b'), 'constitution.md'), 'utf-8')).toBe('a rules\n');

    expect(thrownBy(() => setPersonaMemory(copy, false, 'cli'))).toMatchObject({ code: PERSONA_INVALID });
    expect(JSON.parse(readFileSync(resolve(personaDir('a'), 'persona.json'), 'utf-8'))).not.toHaveProperty('memory');
    expect(existsSync(resolve(TEST_HOME, 'audit', 'policy-mutation.jsonl'))).toBe(false);
  });

  it('sessions, the detail view and the memory gate refuse the copy; the original still resolves', () => {
    expect(thrownBy(() => resolvePersona('b'))).toMatchObject({ code: PERSONA_INVALID });
    expect(thrownBy(() => getPersonaDetail(copy))).toMatchObject({ code: PERSONA_INVALID });
    const memoryOn = testUserConfig({
      memory: { enabled: true, autoSave: false, llmBaseUrl: undefined, llmApiKey: undefined, offlineModels: false },
    });
    expect(isMemoryEnabledForPersonaName('b', memoryOn)).toBe(false);
    expect(isMemoryEnabledForPersonaName('a', memoryOn)).toBe(true);
    expect(resolvePersona('a').persona.name).toBe('a');
    expect(getPersonaDetail(createPersonaName('a')).name).toBe('a');
  });

  it('listing leaves the copy out of the usable personas and reports why', () => {
    expect(listPersonas().map((p) => p.name)).toEqual(['a']);
    const invalid = listInvalidPersonas();
    expect(invalid.map((dir) => dir.name)).toEqual(['b']);
    expect(invalid[0]?.reason).toContain('does not match the persona\'s directory name "b"');
  });
});

describe('applyServerAllowlist matches whole server names only', () => {
  const servers: Record<string, MCPServerConfig> = {
    filesystem: { command: 'node', args: [] },
    git: { command: 'node', args: [] },
    github: { command: 'node', args: [] },
  };

  it('"github" does not select "git"', () => {
    expect(Object.keys(applyServerAllowlist(servers, ['github'])).sort()).toEqual(['filesystem', 'github']);
  });

  it('a string that slipped past validation selects no server by substring', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const filtered = applyServerAllowlist(servers, 'github' as unknown as readonly string[]);
    expect(Object.keys(filtered)).toEqual(['filesystem']);
  });
});
