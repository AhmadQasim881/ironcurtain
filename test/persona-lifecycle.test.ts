/**
 * Persona lifecycle in the headless service (CFG-25): clone, rename, and the
 * trash a soft delete fills (list, restore with name-collision handling,
 * purge, the retention sweep), each audited. Runs against a temp
 * IRONCURTAIN_HOME.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';

import {
  clonePersona,
  createPersona,
  deletePersona,
  getPersonaTrashRetentionDays,
  listPersonaTrashEntries,
  purgePersonaTrash,
  renamePersona,
  restorePersona,
  REVOKED_POLICY_FILENAME,
  selectPersonaTrashForPurge,
  setPersonaBroadPolicyOptIn,
  setPersonaConstitution,
  sweepPersonaTrash,
  validatePersonaServers,
  PERSONA_UNKNOWN_SERVERS,
} from '../src/persona/persona-service.js';
import { getPersonaTrashDir, personaTrashEntryId } from '../src/persona/persona-trash.js';
import { acquirePersonaCompileLock, PERSONA_COMPILE_LOCK_FILE } from '../src/persona/persona-compile-service.js';
import { loadPersona, resolvePersona } from '../src/persona/resolve.js';
import { createPersonaName } from '../src/persona/types.js';
import { hashConstitutionText } from '../src/config/constitution-hash.js';
import { writeCompiledPolicyFor } from './fixtures/scoped-policy.js';

const TEST_HOME = resolve(`/tmp/ironcurtain-persona-lifecycle-test-${process.pid}`);
const DAY_MS = 24 * 60 * 60 * 1000;

interface AuditRecord {
  readonly method: string;
  readonly persona: string;
  readonly actor: string;
  readonly details: Record<string, unknown>;
}

function personaDir(name: string): string {
  return resolve(TEST_HOME, 'personas', name);
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
}

function personaJson(name: string): Record<string, unknown> {
  return readJson(resolve(personaDir(name), 'persona.json'));
}

function constitutionOf(name: string): string {
  return readFileSync(resolve(personaDir(name), 'constitution.md'), 'utf-8');
}

function compiledPolicyPath(name: string): string {
  return resolve(personaDir(name), 'generated', 'compiled-policy.json');
}

function readAudit(): AuditRecord[] {
  const path = resolve(TEST_HOME, 'audit', 'policy-mutation.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as AuditRecord);
}

/**
 * A persona as `persona create` + `persona compile` leave it: a compiled
 * policy matching its constitution, a workspace file and a memory database.
 */
function makePersona(
  name: string,
  opts: { constitution?: string; servers?: string[]; memoryEnabled?: boolean } = {},
): void {
  const constitution = opts.constitution ?? `${name} rules`;
  createPersona(
    {
      name,
      description: `Persona ${name}`,
      constitution,
      ...(opts.servers ? { servers: opts.servers } : {}),
      ...(opts.memoryEnabled !== undefined ? { memoryEnabled: opts.memoryEnabled } : {}),
    },
    'setup',
  );
  writeCompiledPolicyFor(resolve(personaDir(name), 'generated'), `${constitution}\n`);
  writeFileSync(resolve(personaDir(name), 'workspace', 'notes.md'), `${name} notes`);
  writeFileSync(resolve(personaDir(name), 'memory.db'), `${name} memories`);
}

/** Moves `name` to the trash with a deletion time `daysAgo` days in the past; returns the entry id. */
function trashedDaysAgo(name: string, daysAgo: number): string {
  makePersona(name);
  const { trashEntry } = deletePersona(createPersonaName(name), 'setup');
  if (trashEntry === undefined) throw new Error('expected a soft delete');
  const oldId = personaTrashEntryId(createPersonaName(name), new Date(Date.now() - daysAgo * DAY_MS));
  renameSync(resolve(getPersonaTrashDir(), trashEntry), resolve(getPersonaTrashDir(), oldId));
  return oldId;
}

function writeUserConfig(config: Record<string, unknown>): void {
  writeFileSync(resolve(TEST_HOME, 'config.json'), JSON.stringify(config));
}

function codeOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return (err as { code?: unknown }).code;
  }
  throw new Error('expected a throw');
}

function trashIds(): string[] {
  return existsSync(getPersonaTrashDir()) ? readdirSync(getPersonaTrashDir()).sort() : [];
}

beforeEach(() => {
  mkdirSync(TEST_HOME, { recursive: true });
  process.env['IRONCURTAIN_HOME'] = TEST_HOME;
});

afterEach(() => {
  delete process.env['IRONCURTAIN_HOME'];
  rmSync(TEST_HOME, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Server validation at creation
// ---------------------------------------------------------------------------

describe('createPersona validates its server allowlist', () => {
  it('refuses a server the configuration does not have, and creates nothing', () => {
    expect(codeOf(() => createPersona({ name: 'p', description: 'd', servers: ['git', 'githu'] }, 'cli'))).toBe(
      PERSONA_UNKNOWN_SERVERS,
    );
    expect(existsSync(personaDir('p'))).toBe(false);
    expect(readAudit()).toEqual([]);
  });

  it('accepts configured servers', () => {
    expect(() => validatePersonaServers(['filesystem', 'git', 'github', 'fetch'])).not.toThrow();
    createPersona({ name: 'p', description: 'd', servers: ['git'] }, 'cli');
    expect(personaJson('p').servers).toEqual(['git']);
  });
});

// ---------------------------------------------------------------------------
// Clone
// ---------------------------------------------------------------------------

describe('clonePersona', () => {
  it("produces an independent persona: the source's configuration, none of its state", () => {
    makePersona('source', { servers: ['git'], memoryEnabled: false });
    setPersonaBroadPolicyOptIn(createPersonaName('source'), true, 'setup');
    mkdirSync(resolve(personaDir('source'), 'skills', 'review'), { recursive: true });
    writeFileSync(resolve(personaDir('source'), 'skills', 'review', 'SKILL.md'), 'review skill');

    const detail = clonePersona(createPersonaName('source'), 'copy', 'cli');

    expect(detail).toMatchObject({ name: 'copy', description: 'Persona source', hasPolicy: false, memory: false });
    expect(detail.allowBroadPolicy).toBe(false);
    const definition = personaJson('copy');
    expect(definition).toMatchObject({ name: 'copy', description: 'Persona source', servers: ['git'] });
    expect(definition).not.toHaveProperty('allowBroadPolicy');
    expect(definition).not.toHaveProperty('memoryNamespace');
    expect(constitutionOf('copy')).toBe(constitutionOf('source'));
    expect(readFileSync(resolve(personaDir('copy'), 'skills', 'review', 'SKILL.md'), 'utf-8')).toBe('review skill');
    // Not copied: the compiled policy (made for the source's workspace path),
    // the workspace and the memories.
    expect(existsSync(compiledPolicyPath('copy'))).toBe(false);
    expect(readdirSync(resolve(personaDir('copy'), 'workspace'))).toEqual([]);
    expect(existsSync(resolve(personaDir('copy'), 'memory.db'))).toBe(false);
    expect(loadPersona(createPersonaName('copy')).name).toBe('copy');

    // Independent: editing one leaves the other alone.
    setPersonaConstitution(createPersonaName('copy'), 'copy rules', 'cli');
    expect(constitutionOf('source')).toBe('source rules\n');
    expect(() => resolvePersona('source')).not.toThrow();

    expect(readAudit().filter((r) => r.method === 'clonePersona')).toEqual([
      expect.objectContaining({
        persona: 'copy',
        actor: 'cli',
        details: { source: 'source', constitutionHash: hashConstitutionText('source rules\n') },
      }),
    ]);
  });

  it("keeps a relative link in the skills relative, so the clone's skills never read the source's files", () => {
    makePersona('source');
    const skill = resolve(personaDir('source'), 'skills', 'review');
    mkdirSync(skill, { recursive: true });
    writeFileSync(resolve(skill, 'SKILL.md'), 'source skill');
    writeFileSync(resolve(personaDir('source'), 'skills', 'shared.md'), 'source notes');
    symlinkSync('../shared.md', resolve(skill, 'notes.md'));

    clonePersona(createPersonaName('source'), 'copy', 'cli');

    const cloned = resolve(personaDir('copy'), 'skills', 'review', 'notes.md');
    expect(readlinkSync(cloned)).toBe('../shared.md');
    // Independent: an edit of the source's file does not show through.
    writeFileSync(resolve(personaDir('source'), 'skills', 'shared.md'), 'edited in the source');
    expect(readFileSync(cloned, 'utf-8')).toBe('source notes');
  });

  it('takes a new description when given one', () => {
    makePersona('source');
    expect(clonePersona(createPersonaName('source'), 'copy', 'cli', { description: '  Stricter  ' })).toMatchObject({
      description: 'Stricter',
    });
  });

  it('refuses an existing target, an invalid name and an invalid source, creating nothing', () => {
    makePersona('source');
    makePersona('taken');
    expect(codeOf(() => clonePersona(createPersonaName('source'), 'taken', 'cli'))).toBe('PERSONA_EXISTS');
    expect(codeOf(() => clonePersona(createPersonaName('source'), 'source', 'cli'))).toBe('PERSONA_EXISTS');
    expect(() => clonePersona(createPersonaName('source'), '../x', 'cli')).toThrow(/Invalid persona name/);

    writeFileSync(resolve(personaDir('source'), 'persona.json'), JSON.stringify({ name: 'other' }));
    expect(codeOf(() => clonePersona(createPersonaName('source'), 'fresh', 'cli'))).toBe('PERSONA_INVALID');

    expect(readdirSync(resolve(TEST_HOME, 'personas')).sort()).toEqual(['source', 'taken']);
    expect(existsSync(resolve(TEST_HOME, 'x'))).toBe(false);
    expect(readAudit().filter((r) => r.method === 'clonePersona')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Rename
// ---------------------------------------------------------------------------

describe('renamePersona', () => {
  it('moves the whole persona, moves its compiled policy aside and keeps its memory namespace', () => {
    makePersona('old');

    const { detail, policyMovedAside } = renamePersona(createPersonaName('old'), 'new', 'cli');

    expect(existsSync(personaDir('old'))).toBe(false);
    expect(policyMovedAside).toBe(true);
    expect(detail).toMatchObject({ name: 'new', hasPolicy: false, description: 'Persona old' });
    expect(personaJson('new')).toMatchObject({ name: 'new', memoryNamespace: 'old' });
    expect(readFileSync(resolve(personaDir('new'), 'workspace', 'notes.md'), 'utf-8')).toBe('old notes');
    expect(readFileSync(resolve(personaDir('new'), 'memory.db'), 'utf-8')).toBe('old memories');
    expect(constitutionOf('new')).toBe('old rules\n');
    // The policy named the old workspace path: kept for inspection, never loaded.
    expect(existsSync(compiledPolicyPath('new'))).toBe(false);
    expect(existsSync(resolve(personaDir('new'), 'generated', REVOKED_POLICY_FILENAME))).toBe(true);
    expect(codeOf(() => resolvePersona('new'))).toBe('POLICY_MISSING');
    // The compile lock the rename held does not travel with the directory.
    expect(existsSync(resolve(personaDir('new'), 'generated', PERSONA_COMPILE_LOCK_FILE))).toBe(false);

    expect(readAudit().filter((r) => r.method === 'renamePersona')).toEqual([
      expect.objectContaining({ persona: 'new', details: { previousName: 'old', policyRevoked: true } }),
    ]);
  });

  it('drops the memory namespace again when a persona gets its first name back', () => {
    makePersona('first');
    renamePersona(createPersonaName('first'), 'second', 'cli');
    renamePersona(createPersonaName('second'), 'third', 'cli');
    expect(personaJson('third').memoryNamespace).toBe('first');
    renamePersona(createPersonaName('third'), 'first', 'cli');
    expect(personaJson('first')).not.toHaveProperty('memoryNamespace');
  });

  it('refuses an existing target, leaving both personas as they were', () => {
    makePersona('a');
    makePersona('b');
    expect(codeOf(() => renamePersona(createPersonaName('a'), 'b', 'cli'))).toBe('PERSONA_EXISTS');
    expect(personaJson('a').name).toBe('a');
    expect(constitutionOf('b')).toBe('b rules\n');
    expect(existsSync(compiledPolicyPath('a'))).toBe(true);
  });

  it('is refused while the persona is being compiled', () => {
    makePersona('busy');
    const lock = acquirePersonaCompileLock(createPersonaName('busy'), 'running-compile');
    try {
      expect(codeOf(() => renamePersona(createPersonaName('busy'), 'moved', 'cli'))).toBe('COMPILE_IN_PROGRESS');
    } finally {
      lock.release();
    }
    expect(existsSync(personaDir('busy'))).toBe(true);
    expect(existsSync(personaDir('moved'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Trash
// ---------------------------------------------------------------------------

describe('the persona trash', () => {
  it('lists soft-deleted personas newest first, with their expiry under the default 30-day retention', () => {
    const older = trashedDaysAgo('first', 2);
    makePersona('second');
    const { trashEntry } = deletePersona(createPersonaName('second'), 'cli');

    const entries = listPersonaTrashEntries();
    expect(entries.map((e) => e.id)).toEqual([trashEntry, older]);
    expect(entries[0]).toMatchObject({ name: 'second', description: 'Persona second' });
    const deletedAt = Date.parse(entries[0]?.deletedAt ?? '');
    expect(Date.parse(entries[0]?.expiresAt ?? '') - deletedAt).toBe(30 * DAY_MS);
    expect(getPersonaTrashRetentionDays()).toBe(30);
  });

  it('lists only real entry directories: no files, symlinks or foreign names', () => {
    makePersona('real');
    deletePersona(createPersonaName('real'), 'cli');
    const trash = getPersonaTrashDir();
    const outside = resolve(TEST_HOME, 'outside');
    mkdirSync(outside);
    writeFileSync(resolve(outside, 'keep.txt'), 'keep');
    symlinkSync(outside, resolve(trash, personaTrashEntryId(createPersonaName('link'), new Date(0))));
    writeFileSync(resolve(trash, personaTrashEntryId(createPersonaName('file'), new Date(0))), 'x');
    mkdirSync(resolve(trash, 'not-an-entry'));

    expect(listPersonaTrashEntries().map((e) => e.name)).toEqual(['real']);
    expect(codeOf(() => restorePersona('link', 'cli'))).toBe('PERSONA_NOT_FOUND');
    return purgePersonaTrash({ kind: 'all' }, 'cli').then((result) => {
      expect(result.purged).toHaveLength(1);
      expect(readFileSync(resolve(outside, 'keep.txt'), 'utf-8')).toBe('keep');
    });
  });

  describe('restore', () => {
    it('restores the newest entry of a persona name, compiled policy included', () => {
      makePersona('p');
      const { trashEntry } = deletePersona(createPersonaName('p'), 'cli');

      const result = restorePersona('p', 'cli');

      expect(result).toMatchObject({ restored: trashEntry, policyMovedAside: false });
      expect(result.replaced).toBeUndefined();
      expect(result.detail).toMatchObject({ name: 'p', hasPolicy: true });
      expect(() => resolvePersona('p')).not.toThrow();
      expect(readFileSync(resolve(personaDir('p'), 'memory.db'), 'utf-8')).toBe('p memories');
      expect(listPersonaTrashEntries()).toEqual([]);
      expect(readAudit().filter((r) => r.method === 'restorePersona')).toEqual([
        expect.objectContaining({ persona: 'p', details: { trashEntry } }),
      ]);
    });

    it('refuses to restore over an existing persona without force, changing nothing', () => {
      makePersona('p', { constitution: 'deleted rules' });
      const { trashEntry } = deletePersona(createPersonaName('p'), 'cli');
      makePersona('p', { constitution: 'recreated rules' });

      expect(codeOf(() => restorePersona('p', 'cli'))).toBe('PERSONA_EXISTS');
      expect(() => restorePersona('p', 'cli')).toThrow(/needs force/);

      expect(constitutionOf('p')).toBe('recreated rules\n');
      expect(listPersonaTrashEntries().map((e) => e.id)).toEqual([trashEntry]);
      expect(readAudit().filter((r) => r.method === 'restorePersona')).toEqual([]);
    });

    it('with force, moves the existing persona to the trash first (recoverable) and audits both', () => {
      makePersona('p', { constitution: 'deleted rules' });
      const { trashEntry } = deletePersona(createPersonaName('p'), 'cli');
      makePersona('p', { constitution: 'recreated rules' });

      const result = restorePersona('p', 'cli', { force: true });

      expect(constitutionOf('p')).toBe('deleted rules\n');
      expect(result.restored).toBe(trashEntry);
      expect(result.replaced).toBeDefined();
      expect(listPersonaTrashEntries().map((e) => e.id)).toEqual([result.replaced]);
      const methods = readAudit().map((r) => `${r.method}:${r.persona}`);
      expect(methods.slice(-2)).toEqual(['deletePersona:p', 'restorePersona:p']);
      expect(readAudit().at(-1)?.details).toEqual({ trashEntry, replacedTrashEntry: result.replaced });

      // The replaced persona can come back under another name.
      const back = restorePersona(result.replaced ?? '', 'cli', { as: 'p-recreated' });
      expect(back.detail.name).toBe('p-recreated');
      expect(constitutionOf('p-recreated')).toBe('recreated rules\n');
    });

    it('restores under another name like a rename: policy moved aside, memory namespace kept', () => {
      makePersona('p');
      const { trashEntry } = deletePersona(createPersonaName('p'), 'cli');

      const result = restorePersona(trashEntry ?? '', 'cli', { as: 'q' });

      expect(result).toMatchObject({ policyMovedAside: true, detail: { name: 'q', hasPolicy: false } });
      expect(personaJson('q')).toMatchObject({ name: 'q', memoryNamespace: 'p' });
      expect(existsSync(personaDir('p'))).toBe(false);
      expect(readAudit().at(-1)).toMatchObject({
        method: 'restorePersona',
        persona: 'q',
        details: { trashEntry, previousName: 'p', policyRevoked: true },
      });
    });

    it("re-validates the entry's persona.json and refuses one naming another persona", () => {
      makePersona('p');
      const { trashEntry } = deletePersona(createPersonaName('p'), 'cli');
      const entryJson = resolve(getPersonaTrashDir(), trashEntry ?? '', 'persona.json');
      writeFileSync(entryJson, JSON.stringify({ ...readJson(entryJson), name: 'other' }));

      expect(codeOf(() => restorePersona('p', 'cli'))).toBe('PERSONA_INVALID');
      expect(listPersonaTrashEntries()[0]?.problem).toContain('does not match');
      expect(existsSync(personaDir('p'))).toBe(false);
    });

    it('refuses an unknown entry and an invalid target name', () => {
      makePersona('p');
      deletePersona(createPersonaName('p'), 'cli');
      expect(codeOf(() => restorePersona('nope', 'cli'))).toBe('PERSONA_NOT_FOUND');
      expect(() => restorePersona('p', 'cli', { as: '../x' })).toThrow(/Invalid persona name/);
      expect(listPersonaTrashEntries()).toHaveLength(1);
    });
  });

  describe('purge and retention', () => {
    it('purges the entries named (an id, or a name for all its entries) and audits each', async () => {
      const a1 = trashedDaysAgo('a', 3);
      const a2 = trashedDaysAgo('a', 1);
      const b = trashedDaysAgo('b', 1);

      expect([...(await purgePersonaTrash({ kind: 'entries', refs: ['a'] }, 'cli')).purged].sort()).toEqual(
        [a1, a2].sort(),
      );
      expect(trashIds()).toEqual([b]);
      const purges = readAudit().filter((r) => r.method === 'purgePersonaTrash');
      expect(purges.map((r) => r.details.trashEntry).sort()).toEqual([a1, a2].sort());
      expect(purges.every((r) => r.persona === 'a' && r.details.expired === undefined)).toBe(true);
    });

    it('refuses an unknown ref before removing anything', async () => {
      const a = trashedDaysAgo('a', 1);
      await expect(purgePersonaTrash({ kind: 'entries', refs: ['a', 'missing'] }, 'cli')).rejects.toMatchObject({
        code: 'PERSONA_NOT_FOUND',
      });
      expect(trashIds()).toEqual([a]);
    });

    it('purges only the expired entries, from the configured retention', async () => {
      writeUserConfig({ personas: { trashRetentionDays: 7 } });
      const old = trashedDaysAgo('old', 8);
      const recent = trashedDaysAgo('recent', 6);

      expect(selectPersonaTrashForPurge({ kind: 'expired' }).map((e) => e.id)).toEqual([old]);
      expect((await purgePersonaTrash({ kind: 'expired' }, 'cli')).purged).toEqual([old]);
      expect(trashIds()).toEqual([recent]);
      expect(readAudit().filter((r) => r.method === 'purgePersonaTrash')).toEqual([
        expect.objectContaining({ persona: 'old', details: { trashEntry: old, expired: true } }),
      ]);
    });

    it('purges nothing as expired when retention is null (kept until purged by hand)', async () => {
      writeUserConfig({ personas: { trashRetentionDays: null } });
      const old = trashedDaysAgo('old', 400);
      expect(getPersonaTrashRetentionDays()).toBeNull();
      expect(listPersonaTrashEntries()[0]?.expiresAt).toBeUndefined();
      expect((await sweepPersonaTrash('cli')).purged).toEqual([]);
      expect(trashIds()).toEqual([old]);
    });

    it('removes only the confirmed entries (`only`) from a selection', async () => {
      const a = trashedDaysAgo('a', 1);
      const b = trashedDaysAgo('b', 1);
      expect((await purgePersonaTrash({ kind: 'all' }, 'cli', { only: [a] })).purged).toEqual([a]);
      expect(trashIds()).toEqual([b]);
    });

    it('a soft delete is followed by the retention sweep in the callers; the sweep removes expired entries', async () => {
      const expired = trashedDaysAgo('expired', 31);
      const kept = trashedDaysAgo('kept', 29);
      const result = await sweepPersonaTrash('daemon');
      expect(result).toEqual({ purged: [expired], failed: [] });
      expect(trashIds()).toEqual([kept]);
    });

    it('the sweep never fails: an unreadable configuration leaves the trash alone', async () => {
      writeFileSync(resolve(TEST_HOME, 'config.json'), '{ broken');
      const old = trashedDaysAgo('old', 400);
      await expect(sweepPersonaTrash('cli')).resolves.toEqual({ purged: [], failed: [] });
      expect(trashIds()).toEqual([old]);
    });
  });

  it('a soft delete is refused while the persona is being compiled', () => {
    makePersona('busy');
    const lock = acquirePersonaCompileLock(createPersonaName('busy'), 'running-compile');
    try {
      expect(codeOf(() => deletePersona(createPersonaName('busy'), 'cli'))).toBe('COMPILE_IN_PROGRESS');
      expect(codeOf(() => deletePersona(createPersonaName('busy'), 'cli', { force: true }))).toBe(
        'COMPILE_IN_PROGRESS',
      );
    } finally {
      lock.release();
    }
    expect(existsSync(personaDir('busy'))).toBe(true);
  });

  it('gives two deletes of one name within the same millisecond distinct entries', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T00:00:00.000Z'));
    try {
      makePersona('p', { constitution: 'first' });
      const first = deletePersona(createPersonaName('p'), 'cli').trashEntry;
      makePersona('p', { constitution: 'second' });
      const second = deletePersona(createPersonaName('p'), 'cli').trashEntry;
      expect([first, second]).toEqual(['p-2026-11-01T00-00-00-000Z', 'p-2026-11-01T00-00-00-001Z']);
      expect(readFileSync(resolve(getPersonaTrashDir(), first ?? '', 'constitution.md'), 'utf-8')).toBe('first\n');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a soft delete records its trash entry and carries no compile lock into the trash', () => {
    makePersona('p');
    const { trashEntry } = deletePersona(createPersonaName('p'), 'cli');
    expect(readAudit().at(-1)).toMatchObject({ method: 'deletePersona', details: { hardDelete: false, trashEntry } });
    expect(existsSync(resolve(getPersonaTrashDir(), trashEntry ?? '', 'generated', PERSONA_COMPILE_LOCK_FILE))).toBe(
      false,
    );
  });

  it('can delete a persona whose persona.json is invalid', () => {
    makePersona('a');
    writeFileSync(resolve(personaDir('a'), 'persona.json'), '{ not json');
    expect(deletePersona(createPersonaName('a'), 'cli').trashEntry).toBeDefined();
    expect(listPersonaTrashEntries()[0]?.problem).toContain('is not valid JSON');
  });
});

describe('the personas.trashRetentionDays setting', () => {
  it.each([0, -1, 1.5, '30'])('refuses %j', (value) => {
    writeUserConfig({ personas: { trashRetentionDays: value } });
    expect(() => getPersonaTrashRetentionDays()).toThrow(/trashRetentionDays/);
  });
});
