/**
 * Purging the persona trash while other operations run (CFG-25). The
 * daemon serves requests while a purge deletes files asynchronously, and the
 * CLI is another process, so a purge must take its entries out of the trash
 * before it deletes anything: a restore then finds either the whole entry or
 * nothing, never a half-deleted persona, and files a purge could not delete
 * (or a purge cut short) never come back as a restorable entry.
 *
 * `fs.promises.rm` is wrapped so a test can make a removal fail or wait.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { resolve } from 'node:path';

const rmHooks = vi.hoisted(() => ({
  /** Every path handed to `rm`. */
  calls: [] as string[],
  /** Replaces the next `rm` call once. */
  next: undefined as ((path: string) => Promise<void>) | undefined,
  /** The real `rm`. */
  real: undefined as ((path: string) => Promise<void>) | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  rmHooks.real = (path) => actual.rm(path, { recursive: true, force: true });
  return {
    ...actual,
    rm: (path: Parameters<typeof actual.rm>[0], options?: Parameters<typeof actual.rm>[1]): Promise<void> => {
      rmHooks.calls.push(String(path));
      const hook = rmHooks.next;
      if (hook) {
        rmHooks.next = undefined;
        return hook(String(path));
      }
      return actual.rm(path, options);
    },
  };
});

import {
  createPersona,
  deletePersona,
  listPersonaTrashEntries,
  purgePersonaTrash,
  restorePersona,
  sweepPersonaTrash,
} from '../src/persona/persona-service.js';
import { getPersonaTrashDir, PURGE_REMNANT_PREFIX } from '../src/persona/persona-trash.js';
import { createPersonaName } from '../src/persona/types.js';
import { writeCompiledPolicyFor } from './fixtures/scoped-policy.js';

const TEST_HOME = resolve(`/tmp/ironcurtain-persona-trash-purge-test-${process.pid}`);

function personaDir(name: string): string {
  return resolve(TEST_HOME, 'personas', name);
}

/** A compiled persona with a workspace of many files, moved to the trash; returns its entry id. */
function trashedPersona(name: string): string {
  createPersona({ name, description: `Persona ${name}`, constitution: `${name} rules` }, 'setup');
  writeCompiledPolicyFor(resolve(personaDir(name), 'generated'), `${name} rules\n`);
  for (let i = 0; i < 20; i++) {
    const dir = resolve(personaDir(name), 'workspace', `dir-${i}`);
    mkdirSync(dir, { recursive: true });
    for (let j = 0; j < 10; j++) writeFileSync(resolve(dir, `file-${j}`), `${name} ${i} ${j}`);
  }
  const { trashEntry } = deletePersona(createPersonaName(name), 'setup');
  if (trashEntry === undefined) throw new Error('expected a soft delete');
  return trashEntry;
}

function trashNames(): string[] {
  return existsSync(getPersonaTrashDir()) ? readdirSync(getPersonaTrashDir()).sort() : [];
}

function remnants(): string[] {
  return trashNames().filter((name) => name.startsWith(PURGE_REMNANT_PREFIX));
}

function auditMethods(): string[] {
  const path = resolve(TEST_HOME, 'audit', 'policy-mutation.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => (JSON.parse(line) as { method: string }).method);
}

function codeOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return (err as { code?: unknown }).code;
  }
  throw new Error('expected a throw');
}

beforeEach(() => {
  mkdirSync(TEST_HOME, { recursive: true });
  process.env['IRONCURTAIN_HOME'] = TEST_HOME;
  rmHooks.calls.length = 0;
  rmHooks.next = undefined;
});

afterEach(() => {
  delete process.env['IRONCURTAIN_HOME'];
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('purging the persona trash', () => {
  it('takes an entry out of the trash before deleting its files: a restore meanwhile finds nothing', async () => {
    const entry = trashedPersona('p');

    const purge = purgePersonaTrash({ kind: 'entries', refs: [entry] }, 'cli');
    // The purge is now deleting files asynchronously. The entry is already
    // gone from the trash, so a restore cannot take a half-deleted persona,
    // and the purge does not report (and audit) an entry a restore took.
    expect(listPersonaTrashEntries()).toEqual([]);
    expect(codeOf(() => restorePersona('p', 'cli'))).toBe('PERSONA_NOT_FOUND');

    await expect(purge).resolves.toEqual({ purged: [entry], failed: [] });
    expect(existsSync(personaDir('p'))).toBe(false);
    expect(trashNames()).toEqual([]);
    expect(auditMethods().filter((method) => method !== 'createPersona')).toEqual([
      'deletePersona',
      'purgePersonaTrash',
    ]);
  });

  it('keeps files it cannot delete out of the trash, reports them, and the next purge deletes them', async () => {
    const entry = trashedPersona('p');
    rmHooks.next = () => Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));

    const result = await purgePersonaTrash({ kind: 'entries', refs: [entry] }, 'cli');

    expect(result.purged).toEqual([]);
    expect(result.failed).toEqual([
      { id: entry, reason: expect.stringContaining('The entry is no longer in the trash') as unknown },
    ]);
    expect(result.failed[0]?.reason).toContain(PURGE_REMNANT_PREFIX);
    // Never listed or restorable, half deleted or not.
    expect(listPersonaTrashEntries()).toEqual([]);
    expect(codeOf(() => restorePersona('p', 'cli'))).toBe('PERSONA_NOT_FOUND');
    expect(remnants()).toHaveLength(1);
    // It left the trash, so the purge is recorded.
    expect(auditMethods().at(-1)).toBe('purgePersonaTrash');

    // The next purge, of anything, deletes what is left.
    const other = trashedPersona('q');
    await expect(purgePersonaTrash({ kind: 'entries', refs: [other] }, 'cli')).resolves.toEqual({
      purged: [other],
      failed: [],
    });
    expect(trashNames()).toEqual([]);
  });

  it('a purge cut short leaves a remnant that is never an entry; the retention sweep deletes it', async () => {
    // What a purge leaves when the process ends while it deletes.
    const remnant = resolve(getPersonaTrashDir(), `${PURGE_REMNANT_PREFIX}p-2026-11-01T00-00-00-000Z-0f0f`);
    mkdirSync(resolve(remnant, 'workspace'), { recursive: true });
    writeFileSync(
      resolve(remnant, 'persona.json'),
      JSON.stringify({ name: 'p', description: 'd', createdAt: '2026-11-01T00:00:00.000Z' }),
    );

    expect(listPersonaTrashEntries()).toEqual([]);
    expect(codeOf(() => restorePersona('p', 'cli'))).toBe('PERSONA_NOT_FOUND');

    await sweepPersonaTrash('daemon');
    expect(trashNames()).toEqual([]);
  });

  it('leaves the remnants another purge in this process is still deleting to it', async () => {
    const first = trashedPersona('a');
    const second = trashedPersona('b');
    let finishFirst: () => void = () => undefined;
    rmHooks.next = (path) =>
      new Promise<void>((done) => {
        finishFirst = done;
      }).then(() => rmHooks.real?.(path));

    const firstPurge = purgePersonaTrash({ kind: 'entries', refs: [first] }, 'cli');
    // The first purge's remnant is being deleted; the second purge must not
    // delete it too (it would report the first entry's files as its own).
    await expect(purgePersonaTrash({ kind: 'entries', refs: [second] }, 'cli')).resolves.toEqual({
      purged: [second],
      failed: [],
    });
    expect(rmHooks.calls.filter((path) => path.includes(`${PURGE_REMNANT_PREFIX}${first}-`))).toHaveLength(1);

    finishFirst();
    await expect(firstPurge).resolves.toEqual({ purged: [first], failed: [] });
    expect(trashNames()).toEqual([]);
  });
});
