/**
 * The snapshot saved before a forget deletes anything (storage/database.ts
 * snapshotDatabaseBeforeForget), at the file level. The engine-level behaviour (when a
 * snapshot is taken, and that nothing is deleted without one) is in
 * trust-model.test.ts.
 *
 * Several memory servers can share one database: every session of a persona starts
 * its own server on the persona's file. Two of them can pick the same snapshot name
 * in the same millisecond, and the one that loses must not write, or remove, the
 * winner's file.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

// Simulates the race: another server creates the snapshot name after this one
// checked that it was free. `existsSync` reports every snapshot name as free.
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const existsSync = (path: Parameters<typeof real.existsSync>[0]): boolean =>
    String(path).includes('.forget-snapshot-') ? false : real.existsSync(path);
  return { ...real, existsSync, default: { ...real, existsSync } };
});

import { initDatabase, snapshotDatabaseBeforeForget } from '../src/storage/database.js';

const NOW = new Date('2026-03-04T05:06:07.890Z');
const STAMP = '2026-03-04T05-06-07-890Z';

describe('snapshotDatabaseBeforeForget', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    tmpDir = mkdtempSync(join(tmpdir(), 'memory-forget-snapshot-'));
    dbPath = join(tmpDir, 'test.db');
    db = initDatabase(dbPath, 'Xenova/bge-base-en-v1.5');
    db.prepare(`INSERT INTO schema_meta (key, value) VALUES ('snapshot-test', 'present')`).run();
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('moves on to the next free name when another server claimed this one, leaving its file alone', () => {
    const taken = `${dbPath}.forget-snapshot-${STAMP}.db`;
    writeFileSync(taken, 'written by another memory server');

    const snapshot = snapshotDatabaseBeforeForget(db, dbPath);

    expect(snapshot).toBe(`${taken}.1`);
    expect(readFileSync(taken, 'utf-8')).toBe('written by another memory server');
    expect(statSync(`${taken}.1`).mode & 0o777).toBe(0o600);
    const saved = new Database(`${taken}.1`, { readonly: true });
    try {
      expect(saved.prepare(`SELECT value FROM schema_meta WHERE key = 'snapshot-test'`).get()).toEqual({
        value: 'present',
      });
    } finally {
      saved.close();
    }
  });

  it('removes only its own file when the copy fails, and names no host path', () => {
    const taken = `${dbPath}.forget-snapshot-${STAMP}.db`;
    writeFileSync(taken, 'written by another memory server');
    const broken = {
      prepare: () => ({
        run: () => {
          throw new Error('disk full');
        },
      }),
    } as unknown as Database.Database;

    let error: unknown;
    try {
      snapshotDatabaseBeforeForget(broken, dbPath);
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('nothing was deleted');
    expect(message).toContain(`'${basename(taken)}.1'`);
    expect(message).not.toContain(tmpDir);
    expect(readFileSync(taken, 'utf-8')).toBe('written by another memory server');
    expect(() => statSync(`${taken}.1`)).toThrow();
  });
});
