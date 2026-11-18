/**
 * Opening a memory database (storage/database.ts initDatabase), WP-94:
 *   - schema 3 and 4 databases are upgraded in place by ordered, additive migrations
 *     (after a backup), and end up with the same schema as a new database;
 *   - older, unstamped or half-created databases are backed up and rebuilt;
 *   - several processes opening one stale database upgrade it once, and none of them
 *     drops what another wrote after its upgrade (the upgrade runs under BEGIN
 *     IMMEDIATE, after a backup, and re-reads the stamp);
 *   - stored vectors from another embedding model, or of another size, refuse the open.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { initDatabase, MIGRATIONS, SCHEMA_VERSION } from '../src/storage/database.js';
import { getMemoriesByIds, insertMemory, insertSegment, vectorSearch } from '../src/storage/queries.js';
import { segmentContentHash } from '../src/utils/content-hash.js';

const TEST_MODEL = 'test-model';
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = join(PACKAGE_ROOT, 'test', 'fixtures', 'open-database-worker.ts');

function unitVector(dimensions: number, axis = 0): Float32Array {
  const v = new Float32Array(dimensions);
  v[axis] = 1;
  return v;
}

function vectorBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

/** The first released schema (v3), exactly as that version created it. */
function createV3Schema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      namespace TEXT NOT NULL DEFAULT 'default',
      content TEXT NOT NULL,
      tags TEXT,
      importance REAL NOT NULL DEFAULT 0.5,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_accessed_at INTEGER NOT NULL,
      access_count INTEGER NOT NULL DEFAULT 0,
      is_compacted INTEGER NOT NULL DEFAULT 0,
      source TEXT,
      metadata TEXT,
      consolidated INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX idx_memories_namespace ON memories(namespace);
    CREATE INDEX idx_memories_created ON memories(namespace, created_at);
    CREATE INDEX idx_memories_importance ON memories(namespace, importance DESC);
    CREATE INDEX idx_memories_accessed ON memories(namespace, last_accessed_at);
    CREATE INDEX idx_memories_unconsolidated ON memories(namespace, created_at) WHERE consolidated = 0;
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE VIRTUAL TABLE vec_memories USING vec0(memory_id TEXT PRIMARY KEY, embedding float[768]);
    CREATE VIRTUAL TABLE memories_fts USING fts5(
      content, tags, content=memories, content_rowid=rowid, tokenize='porter unicode61'
    );
    CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
    END;
    CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES ('delete', old.rowid, old.content, old.tags);
    END;
    CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES ('delete', old.rowid, old.content, old.tags);
      INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
    END;
    INSERT INTO schema_meta (key, value) VALUES ('schema_version', '3');
    INSERT INTO schema_meta (key, value) VALUES ('embedding_model', '${TEST_MODEL}');
    INSERT INTO schema_meta (key, value) VALUES ('embedding_dimensions', '768');
  `);
}

/** Schema v4 as that version created it: v3 plus segments and memories.segment_id, no content_hash. */
function createV4Schema(db: Database.Database): void {
  createV3Schema(db);
  db.exec(`
    CREATE TABLE segments (
      id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      namespace   TEXT NOT NULL DEFAULT 'default',
      content     TEXT NOT NULL,
      source      TEXT,
      mode        TEXT,
      created_at  INTEGER NOT NULL,
      fact_count  INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_segments_namespace ON segments(namespace);
    ALTER TABLE memories ADD COLUMN segment_id TEXT REFERENCES segments(id);
    CREATE INDEX idx_memories_segment ON memories(segment_id) WHERE segment_id IS NOT NULL;
    UPDATE schema_meta SET value = '4' WHERE key = 'schema_version';
  `);
}

/** A stale database file with `rows` memories (each with a vector), built by `create`. */
function buildDatabase(path: string, create: (db: Database.Database) => void, rows: number): void {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  sqliteVec.load(db);
  create(db);
  const insert = db.transaction(() => {
    for (let i = 0; i < rows; i++) {
      db.prepare(
        `INSERT INTO memories (id, namespace, content, created_at, updated_at, last_accessed_at)
         VALUES (?, 'test', ?, 1, 1, 1)`,
      ).run(`row-${i}`, `stale memory number ${i} about parrots`);
      db.prepare(`INSERT INTO vec_memories (memory_id, embedding) VALUES (?, ?)`).run(
        `row-${i}`,
        vectorBlob(unitVector(768, i % 768)),
      );
    }
  });
  insert();
  db.close();
}

function schemaVersion(db: Database.Database): string | undefined {
  const row = db.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get() as
    { value: string } | undefined;
  return row?.value;
}

function metaValue(db: Database.Database, key: string): string | undefined {
  const row = db.prepare(`SELECT value FROM schema_meta WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value;
}

function backupsIn(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.includes('.backup-'));
}

/** Tables (with their columns and foreign keys), indexes (normalized SQL) and triggers of a database. */
function schemaShape(db: Database.Database): unknown {
  const names = (type: string): string[] =>
    (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name`)
        .all(type) as Array<{ name: string }>
    ).map((r) => r.name);
  const normalize = (sql: string): string =>
    sql
      .replace(/\s+/g, ' ')
      .replace(/ IF NOT EXISTS/i, '')
      .trim();
  return {
    tables: names('table').map((table) => ({
      table,
      columns: db.prepare(`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_xinfo(?)`).all(table),
      foreignKeys: db.prepare(`SELECT "table", "from", "to" FROM pragma_foreign_key_list(?)`).all(table),
    })),
    indexes: (
      db
        .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name`)
        .all() as Array<{ name: string; sql: string }>
    ).map((r) => ({ name: r.name, sql: normalize(r.sql) })),
    triggers: names('trigger'),
  };
}

describe('schema migrations', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memory-migrations-'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('is an ordered chain from the oldest migratable schema to SCHEMA_VERSION', () => {
    expect(MIGRATIONS.map((m) => m.to)).toEqual([4, 5]);
    expect(MIGRATIONS[MIGRATIONS.length - 1].to).toBe(SCHEMA_VERSION);
  });

  it('upgrades a v3 database in place to the same schema a new database gets, keeping every row', () => {
    const stalePath = join(dir, 'stale.db');
    buildDatabase(stalePath, createV3Schema, 20);

    const migrated = initDatabase(stalePath, TEST_MODEL);
    const fresh = initDatabase(join(dir, 'fresh.db'), TEST_MODEL);
    try {
      expect(schemaShape(migrated)).toEqual(schemaShape(fresh));
      expect(schemaVersion(migrated)).toBe(String(SCHEMA_VERSION));
      const rows = getMemoriesByIds(
        migrated,
        'test',
        Array.from({ length: 20 }, (_, i) => `row-${i}`),
      );
      expect(rows).toHaveLength(20);
      expect(rows.every((r) => r.segment_id === null)).toBe(true);
      expect(vectorSearch(migrated, 'test', unitVector(768, 3), 1).map((r) => r.id)).toEqual(['row-3']);
    } finally {
      migrated.close();
      fresh.close();
    }

    expect(backupsIn(dir)).toEqual([expect.stringMatching(/^stale\.db\.backup-schema-v3-before-v5-.*\.db$/)]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Upgraded the memory database schema from v3'));
  });

  it('upgrades a v4 database: backfills segment content hashes, keeps rows and links, then opens without work', () => {
    const stalePath = join(dir, 'v4.db');
    buildDatabase(stalePath, createV4Schema, 3);
    const seeded = new Database(stalePath);
    seeded
      .prepare(
        `INSERT INTO segments (id, namespace, content, source, mode, created_at, fact_count)
         VALUES ('seg-1', 'test', 'the source chunk', 'document', 'document', 1, 1)`,
      )
      .run();
    seeded.prepare(`UPDATE memories SET segment_id = 'seg-1' WHERE id = 'row-0'`).run();
    seeded.close();

    const db = initDatabase(stalePath, TEST_MODEL);
    try {
      expect(schemaVersion(db)).toBe('5');
      const segment = db.prepare(`SELECT content_hash FROM segments WHERE id = 'seg-1'`).get() as {
        content_hash: string;
      };
      expect(segment.content_hash).toBe(segmentContentHash('the source chunk', 'document', 'document'));
      expect(getMemoriesByIds(db, 'test', ['row-0'])[0].segment_id).toBe('seg-1');
    } finally {
      db.close();
    }
    expect(backupsIn(dir)).toHaveLength(1);

    // A second open finds the database current: no backup, no change.
    initDatabase(stalePath, TEST_MODEL).close();
    expect(backupsIn(dir)).toHaveLength(1);
  });

  it('upgrades a v4-shaped database whose stamp was never written', () => {
    const stalePath = join(dir, 'unstamped.db');
    buildDatabase(
      stalePath,
      (db) => {
        createV4Schema(db);
        db.exec(`DELETE FROM schema_meta WHERE key = 'schema_version'`);
      },
      2,
    );

    const db = initDatabase(stalePath, TEST_MODEL);
    try {
      expect(schemaVersion(db)).toBe('5');
      expect(getMemoriesByIds(db, 'test', ['row-0', 'row-1'])).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it('backs up and rebuilds a legacy unstamped database it cannot migrate', () => {
    const stalePath = join(dir, 'legacy.db');
    buildDatabase(
      stalePath,
      (db) => {
        createV3Schema(db);
        db.exec(`DROP TABLE schema_meta`);
      },
      2,
    );

    const db = initDatabase(stalePath, TEST_MODEL);
    try {
      expect(schemaVersion(db)).toBe('5');
      expect(getMemoriesByIds(db, 'test', ['row-0'])).toHaveLength(0);
    } finally {
      db.close();
    }
    expect(backupsIn(dir)).toEqual([expect.stringMatching(/^legacy\.db\.backup-legacy-unversioned-before-v5-/)]);
  });

  it('backs up and rebuilds a half-created schema (tables without memories)', () => {
    const path = join(dir, 'partial.db');
    const partial = new Database(path);
    partial.exec(`CREATE TABLE segments (id TEXT PRIMARY KEY, namespace TEXT, content TEXT, created_at INTEGER)`);
    partial.close();

    const db = initDatabase(path, TEST_MODEL);
    try {
      expect(schemaVersion(db)).toBe('5');
      const columns = db.prepare(`SELECT name FROM pragma_table_info('segments')`).all() as Array<{ name: string }>;
      expect(columns.map((c) => c.name)).toContain('content_hash');
    } finally {
      db.close();
    }
    expect(backupsIn(dir)).toHaveLength(1);
  });

  describe('two processes opening one stale database', () => {
    it('a process that loses the race finds the database upgraded, keeps the other one’s writes, and drops its backup', () => {
      const path = join(dir, 'race.db');
      buildDatabase(path, createV4Schema, 5);

      let other: Database.Database | undefined;
      let hookRuns = 0;
      // This open plans the upgrade and backs up; in the window before it takes the
      // schema lock, another process opens the same database, upgrades it, and writes.
      const first = initDatabase(path, TEST_MODEL, {
        beforeSchemaLock: () => {
          hookRuns += 1;
          if (other !== undefined) return;
          other = initDatabase(path, TEST_MODEL);
          other.prepare(`INSERT INTO schema_meta (key, value) VALUES ('written-after-upgrade', 'kept')`).run();
        },
      });
      try {
        expect(hookRuns).toBe(1);
        expect(schemaVersion(first)).toBe('5');
        expect(metaValue(first, 'written-after-upgrade')).toBe('kept');
        expect(
          getMemoriesByIds(
            first,
            'test',
            Array.from({ length: 5 }, (_, i) => `row-${i}`),
          ),
        ).toHaveLength(5);
      } finally {
        first.close();
        other?.close();
      }
      // One upgrade, one backup: the loser removed the backup it no longer needed.
      expect(backupsIn(dir)).toHaveLength(1);
      expect(console.warn).toHaveBeenCalledTimes(1);
    });

    it('a rebuild is done once: the second process does not drop what the first wrote after rebuilding', () => {
      const path = join(dir, 'race-legacy.db');
      buildDatabase(
        path,
        (db) => {
          createV3Schema(db);
          db.exec(`DROP TABLE schema_meta`);
        },
        2,
      );

      let other: Database.Database | undefined;
      const first = initDatabase(path, TEST_MODEL, {
        beforeSchemaLock: () => {
          if (other !== undefined) return;
          other = initDatabase(path, TEST_MODEL);
          insertMemory(
            other,
            {
              id: 'after-rebuild',
              namespace: 'test',
              content: 'written after the rebuild',
              tags: undefined,
              importance: 0.5,
            },
            unitVector(768),
          );
        },
      });
      try {
        expect(getMemoriesByIds(first, 'test', ['after-rebuild'])).toHaveLength(1);
      } finally {
        first.close();
        other?.close();
      }
      expect(backupsIn(dir)).toHaveLength(1);
    });

    it.each([
      {
        name: 'a v4 database (migrated in place)',
        create: createV4Schema,
        message: 'Upgraded the memory database schema',
        rowsAfter: 2000,
      },
      {
        name: 'a legacy unstamped database (rebuilt)',
        create: (db: Database.Database): void => {
          createV3Schema(db);
          db.exec(`DROP TABLE schema_meta`);
        },
        message: 'Backed up incompatible memory database schema',
        rowsAfter: 0,
      },
    ])(
      'real processes opening $name at the same moment upgrade it once and lose no writes',
      async (stale) => {
        const path = join(dir, 'processes.db');
        buildDatabase(path, stale.create, 2000);
        const workers = 4;
        const startAt = Date.now() + 1500;

        const runs = await Promise.all(
          Array.from(
            { length: workers },
            (_, i) =>
              new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
                const child = spawn(process.execPath, ['--import', 'tsx', WORKER, path, String(startAt), String(i)], {
                  cwd: PACKAGE_ROOT,
                  stdio: ['ignore', 'pipe', 'pipe'],
                });
                let stdout = '';
                let stderr = '';
                child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
                child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
                child.on('close', (code) => {
                  done({ code, stdout, stderr });
                });
              }),
          ),
        );

        for (const run of runs) expect(run.code, run.stderr).toBe(0);
        const upgrades = runs.filter((run) => run.stderr.includes(stale.message)).length;
        expect(upgrades).toBe(1);
        expect(backupsIn(dir)).toHaveLength(1);

        const db = new Database(path, { readonly: true });
        try {
          expect(schemaVersion(db)).toBe('5');
          // A second upgrade after a worker wrote its marker would have dropped (rebuild)
          // or kept (migrate) it; every marker must be there.
          for (let i = 0; i < workers; i++) expect(metaValue(db, `marker-${i}`)).toBe('present');
          expect((db.prepare(`SELECT COUNT(*) AS n FROM memories`).get() as { n: number }).n).toBe(stale.rowsAfter);
        } finally {
          db.close();
        }
      },
      60_000,
    );
  });
});

describe('embedding model check on open', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memory-embedding-model-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function seed(path: string, model: string): void {
    const db = initDatabase(path, model);
    insertMemory(
      db,
      { id: 'kept', namespace: 'test', content: 'a memory with a vector', tags: undefined, importance: 0.5 },
      unitVector(768),
    );
    db.close();
  }

  it('refuses a model with another vector size, leaving the database untouched', () => {
    const path = join(dir, 'm.db');
    seed(path, 'Xenova/bge-base-en-v1.5');

    expect(() => initDatabase(path, 'Xenova/bge-small-en-v1.5')).toThrow(
      /vectors were made with embedding model 'Xenova\/bge-base-en-v1\.5' \(768 dimensions\).*'Xenova\/bge-small-en-v1\.5' \(384 dimensions\)/,
    );

    const db = initDatabase(path, 'Xenova/bge-base-en-v1.5');
    try {
      expect(metaValue(db, 'embedding_model')).toBe('Xenova/bge-base-en-v1.5');
      expect(getMemoriesByIds(db, 'test', ['kept'])).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('refuses another model with the same vector size: its vectors are not comparable', () => {
    const path = join(dir, 'm.db');
    seed(path, 'Xenova/bge-base-en-v1.5');
    expect(() => initDatabase(path, 'Xenova/all-mpnet-base-v2', { dimensions: 768 })).toThrow(/Refusing to open/);
  });

  it('accepts another name of the same model', () => {
    const path = join(dir, 'm.db');
    seed(path, 'Xenova/bge-base-en-v1.5');
    const db = initDatabase(path, 'BAAI/bge-base-en-v1.5');
    db.close();
  });

  it('switches a database without vectors to the configured model and its vector size', () => {
    const path = join(dir, 'empty.db');
    initDatabase(path, 'Xenova/bge-base-en-v1.5').close();

    const db = initDatabase(path, 'Xenova/bge-small-en-v1.5');
    try {
      expect(metaValue(db, 'embedding_model')).toBe('Xenova/bge-small-en-v1.5');
      expect(metaValue(db, 'embedding_dimensions')).toBe('384');
      insertMemory(
        db,
        { id: 'small', namespace: 'test', content: 'a 384-dimensional memory', tags: undefined, importance: 0.5 },
        unitVector(384),
      );
      expect(vectorSearch(db, 'test', unitVector(384), 1).map((r) => r.id)).toEqual(['small']);
    } finally {
      db.close();
    }
  });

  it('checks a stale database before backing it up, so a refused open leaves no backup behind', () => {
    const path = join(dir, 'stale.db');
    buildDatabase(path, createV4Schema, 1);
    expect(() => initDatabase(path, 'Xenova/bge-small-en-v1.5')).toThrow(/Refusing to open/);
    expect(backupsIn(dir)).toEqual([]);
    const db = new Database(path, { readonly: true });
    try {
      expect(schemaVersion(db)).toBe('4');
    } finally {
      db.close();
    }
  });

  it('segments written after the upgrade carry their content hash', () => {
    const db = initDatabase(join(dir, 'fresh.db'), TEST_MODEL);
    try {
      insertSegment(db, {
        id: 's',
        namespace: 'test',
        content: 'chunk',
        source: 'src',
        mode: 'document',
        factCount: 1,
      });
      const row = db.prepare(`SELECT content_hash FROM segments WHERE id = 's'`).get() as { content_hash: string };
      expect(row.content_hash).toBe(segmentContentHash('chunk', 'src', 'document'));
    } finally {
      db.close();
    }
  });
});
