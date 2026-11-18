/**
 * Restoring a memory database from one of the copies kept next to it (WP-94):
 * `restoreDatabase` / `listDatabaseCopies` in storage/database.ts, and the
 * `memory-mcp-server backups|restore` commands (cli.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import {
  initDatabase,
  listDatabaseCopies,
  restoreDatabase,
  snapshotDatabaseBeforeForget,
  EMBEDDING_DIMENSIONS,
} from '../src/storage/database.js';
import { forgetMemoryRows, getMemoriesByIds, insertMemory, vectorSearch } from '../src/storage/queries.js';
import { runAdminCommand } from '../src/cli.js';

const MODEL = 'Xenova/bge-base-en-v1.5';
const NAMESPACE = 'test';

function unitVector(axis: number): Float32Array {
  const v = new Float32Array(EMBEDDING_DIMENSIONS);
  v[axis] = 1;
  return v;
}

function addMemory(db: Database.Database, id: string, axis: number): void {
  insertMemory(
    db,
    { id, namespace: NAMESPACE, content: `memory ${id}`, tags: undefined, importance: 0.5 },
    unitVector(axis),
  );
}

function memoryIds(path: string): string[] {
  const db = initDatabase(path, MODEL);
  try {
    return (db.prepare(`SELECT id FROM memories ORDER BY id`).all() as Array<{ id: string }>).map((r) => r.id);
  } finally {
    db.close();
  }
}

function output(): { out: string[]; err: string[]; io: { out: (line: string) => void; err: (line: string) => void } } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    },
  };
}

describe('restoreDatabase', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memory-restore-'));
    dbPath = join(dir, 'memory.db');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('undoes a forget from its snapshot, saving the current database first', async () => {
    const db = initDatabase(dbPath, MODEL);
    addMemory(db, 'a', 0);
    addMemory(db, 'b', 1);
    const snapshot = snapshotDatabaseBeforeForget(db, dbPath);
    forgetMemoryRows(db, NAMESPACE, ['a', 'b']);
    db.close();
    expect(snapshot).not.toBeNull();
    expect(memoryIds(dbPath)).toEqual([]);

    const result = await restoreDatabase(snapshot ?? '', dbPath);

    expect(memoryIds(dbPath)).toEqual(['a', 'b']);
    expect(result.restoredSchema).toBe('5');
    expect(result.previousCopy).toMatch(/memory\.db\.before-restore-.*\.db$/);
    // The copy of the database as it was before the restore is private and holds that state.
    expect(statSync(result.previousCopy ?? '').mode & 0o777).toBe(0o600);
    expect(memoryIds(result.previousCopy ?? '')).toEqual([]);

    // The restored database works: vectors and all.
    const reopened = initDatabase(dbPath, MODEL);
    try {
      expect(vectorSearch(reopened, NAMESPACE, unitVector(1), 1).map((r) => r.id)).toEqual(['b']);
    } finally {
      reopened.close();
    }
  });

  it('restores while another connection has the database open', async () => {
    const db = initDatabase(dbPath, MODEL);
    addMemory(db, 'kept', 0);
    const snapshot = snapshotDatabaseBeforeForget(db, dbPath) ?? '';
    forgetMemoryRows(db, NAMESPACE, ['kept']);

    await restoreDatabase(snapshot, dbPath);

    // The open connection sees the restored content on its next statement.
    expect(getMemoriesByIds(db, NAMESPACE, ['kept'])).toHaveLength(1);
    db.close();
  });

  it('upgrades a restored copy with an older schema in place', async () => {
    const oldCopy = join(dir, 'old-v3.db');
    const v3 = new Database(oldCopy);
    sqliteVec.load(v3);
    v3.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY, namespace TEXT NOT NULL DEFAULT 'default', content TEXT NOT NULL, tags TEXT,
        importance REAL NOT NULL DEFAULT 0.5, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        last_accessed_at INTEGER NOT NULL, access_count INTEGER NOT NULL DEFAULT 0,
        is_compacted INTEGER NOT NULL DEFAULT 0, source TEXT, metadata TEXT, consolidated INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE VIRTUAL TABLE vec_memories USING vec0(memory_id TEXT PRIMARY KEY, embedding float[768]);
      INSERT INTO schema_meta VALUES ('schema_version', '3'), ('embedding_model', '${MODEL}');
      INSERT INTO memories (id, namespace, content, created_at, updated_at, last_accessed_at)
        VALUES ('old', 'test', 'from the old schema', 1, 1, 1);
    `);
    v3.close();
    initDatabase(dbPath, MODEL).close();

    const result = await restoreDatabase(oldCopy, dbPath);

    expect(result.restoredSchema).toBe('3');
    const db = initDatabase(dbPath, MODEL);
    try {
      expect(getMemoriesByIds(db, NAMESPACE, ['old'])).toHaveLength(1);
      expect(
        (db.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get() as { value: string }).value,
      ).toBe('5');
    } finally {
      db.close();
    }
  });

  it('restores into a path with no database (one moved aside)', async () => {
    const source = join(dir, 'source.db');
    const db = initDatabase(source, MODEL);
    addMemory(db, 'x', 0);
    db.close();

    const result = await restoreDatabase(source, dbPath);

    expect(result.previousCopy).toBeNull();
    expect(memoryIds(dbPath)).toEqual(['x']);
  });

  it('refuses a file that is not a memory database, a newer schema, a copy it would rebuild, and the database itself', async () => {
    initDatabase(dbPath, MODEL).close();

    const notMemory = join(dir, 'other.db');
    const other = new Database(notMemory);
    other.exec(`CREATE TABLE t (x)`);
    other.close();
    await expect(restoreDatabase(notMemory, dbPath)).rejects.toThrow(/not a memory database/);

    const newer = join(dir, 'newer.db');
    initDatabase(newer, MODEL).close();
    const bump = new Database(newer);
    bump.prepare(`UPDATE schema_meta SET value = '9' WHERE key = 'schema_version'`).run();
    bump.close();
    await expect(restoreDatabase(newer, dbPath)).rejects.toThrow(/newer than this server/);

    const legacy = join(dir, 'legacy.db');
    const legacyDb = new Database(legacy);
    legacyDb.exec(`CREATE TABLE memories (id TEXT PRIMARY KEY, content TEXT)`);
    legacyDb.close();
    await expect(restoreDatabase(legacy, dbPath)).rejects.toThrow(/cannot upgrade in place/);

    const garbage = join(dir, 'garbage.db');
    writeFileSync(garbage, 'not sqlite at all');
    await expect(restoreDatabase(garbage, dbPath)).rejects.toThrow();

    await expect(restoreDatabase(dbPath, dbPath)).rejects.toThrow(/the database itself/);
    await expect(restoreDatabase(join(dir, 'missing.db'), dbPath)).rejects.toThrow(/No backup/);

    // None of the refusals touched the database or saved a pre-restore copy.
    expect(listDatabaseCopies(dbPath)).toEqual([]);
  });
});

describe('listDatabaseCopies', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memory-copies-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists the schema backups, forget snapshots and pre-restore copies of one database only', () => {
    const dbPath = join(dir, 'memory.db');
    for (const name of [
      'memory.db.backup-schema-v3-before-v5-2026-01-01T00-00-00-000Z.db',
      'memory.db.forget-snapshot-2026-01-02T00-00-00-000Z.db',
      'memory.db.forget-snapshot-2026-01-02T00-00-00-000Z.db.1',
      'memory.db.before-restore-2026-01-03T00-00-00-000Z.db',
      'other.db.forget-snapshot-2026-01-02T00-00-00-000Z.db',
      'memory.db-wal',
    ]) {
      writeFileSync(join(dir, name), 'x');
    }

    expect(listDatabaseCopies(dbPath).map((c) => [c.kind, c.path.slice(dir.length + 1)])).toEqual([
      ['schema-upgrade', 'memory.db.backup-schema-v3-before-v5-2026-01-01T00-00-00-000Z.db'],
      ['forget-snapshot', 'memory.db.forget-snapshot-2026-01-02T00-00-00-000Z.db'],
      ['forget-snapshot', 'memory.db.forget-snapshot-2026-01-02T00-00-00-000Z.db.1'],
      ['before-restore', 'memory.db.before-restore-2026-01-03T00-00-00-000Z.db'],
    ]);
  });
});

describe('memory-mcp-server backups|restore', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memory-cli-'));
    dbPath = join(dir, 'memory.db');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists copies of the database named by --db or MEMORY_DB_PATH', async () => {
    const db = initDatabase(dbPath, MODEL);
    addMemory(db, 'a', 0);
    const snapshot = snapshotDatabaseBeforeForget(db, dbPath) ?? '';
    db.close();

    const viaFlag = output();
    expect(await runAdminCommand(['backups', '--db', dbPath], {}, viaFlag.io)).toBe(0);
    expect(viaFlag.out.join('\n')).toContain(`${snapshot}  (before a memory_forget,`);

    const viaEnv = output();
    expect(await runAdminCommand(['backups'], { MEMORY_DB_PATH: dbPath }, viaEnv.io)).toBe(0);
    expect(viaEnv.out.join('\n')).toContain(snapshot);

    const none = output();
    expect(await runAdminCommand(['backups', '--db', join(dir, 'nothing.db')], {}, none.io)).toBe(0);
    expect(none.out).toEqual([`No copies of ${join(dir, 'nothing.db')} found.`]);
  });

  it('restores from a copy and says where the previous database went', async () => {
    const db = initDatabase(dbPath, MODEL);
    addMemory(db, 'a', 0);
    const snapshot = snapshotDatabaseBeforeForget(db, dbPath) ?? '';
    forgetMemoryRows(db, NAMESPACE, ['a']);
    db.close();

    const run = output();
    expect(await runAdminCommand(['restore', snapshot, '--db', dbPath], {}, run.io)).toBe(0);
    expect(run.out[0]).toBe(`Restored ${dbPath} from ${snapshot} (schema 5).`);
    expect(run.out[1]).toMatch(/^The database as it was before the restore is saved at .*before-restore-/);
    expect(memoryIds(dbPath)).toEqual(['a']);
  });

  it('reports usage errors and failures with distinct exit codes', async () => {
    const missing = output();
    expect(await runAdminCommand(['restore'], { MEMORY_DB_PATH: dbPath }, missing.io)).toBe(2);
    expect(missing.err.join('\n')).toContain('Usage:');

    const extra = output();
    expect(await runAdminCommand(['backups', 'surplus'], {}, extra.io)).toBe(2);

    const unknownFlag = output();
    expect(await runAdminCommand(['backups', '--force'], {}, unknownFlag.io)).toBe(2);

    const failed = output();
    expect(await runAdminCommand(['restore', join(dir, 'missing.db'), '--db', dbPath], {}, failed.io)).toBe(1);
    expect(failed.err.join('\n')).toContain('Restore failed: No backup');
  });
});
