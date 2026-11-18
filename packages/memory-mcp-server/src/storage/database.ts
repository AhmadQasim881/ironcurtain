import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DEFAULT_EMBEDDING_DIMENSIONS, embeddingDimensionsFor, sameEmbeddingModel } from '../embedding/models.js';
import { segmentContentHash } from '../utils/content-hash.js';

export interface MemoryRow {
  id: string;
  namespace: string;
  content: string;
  tags: string | null;
  importance: number;
  created_at: number;
  updated_at: number;
  last_accessed_at: number;
  access_count: number;
  is_compacted: number;
  consolidated: number;
  source: string | null;
  metadata: string | null;
  /** FK to the source segment a `memory_ingest` fact was extracted from. NULL for store-path / degrade-path rows. */
  segment_id: string | null;
}

/**
 * A source chunk `memory_ingest` extracted facts from. Off the retrieval index by
 * construction: never embedded, never in `vec_memories`/`memories_fts`. Fetched
 * only by primary key during recall-time re-expansion ("index fine, return coarse").
 */
export interface SegmentRow {
  id: string;
  namespace: string;
  content: string;
  source: string | null;
  mode: string | null;
  created_at: number;
  fact_count: number;
  /** segmentContentHash of content, source and mode; NULL only for rows a schema-4 server wrote after the upgrade. */
  content_hash: string | null;
}

export interface VectorSearchResult extends MemoryRow {
  distance: number;
}

export interface FtsSearchResult extends MemoryRow {
  bm25_score: number;
}

/** The schema version this binary writes (`schema_meta.schema_version`). */
const SCHEMA_VERSION = 5;

/**
 * The oldest stamp an in-place migration upgrades (3 is the first released schema). An
 * older, unstamped or unparseable database is backed up and rebuilt instead.
 */
const OLDEST_MIGRATABLE_VERSION = 3;

/** Vector size of the default embedding model (for callers that build vectors by hand). */
const EMBEDDING_DIMENSIONS = DEFAULT_EMBEDDING_DIMENSIONS;

/** How long opening a database waits for the write lock another process holds while it upgrades the schema. */
const SCHEMA_LOCK_TIMEOUT_MS = 30_000;

/** Busy timeout for normal operation (better-sqlite3's default). */
const BUSY_TIMEOUT_MS = 5_000;

/** Times the schema is planned again when other processes keep changing it between the plan and the lock. */
const MAX_SCHEMA_ATTEMPTS = 3;

/** Tables this server creates; any of them without `memories` is a half-created database. */
const PARTIAL_SCHEMA_TABLES = ['segments', 'vec_memories', 'memories_fts'] as const;

export interface InitDatabaseOptions {
  /** Size of the configured model's vectors (default: what embedding/models.ts lists for the model). */
  dimensions?: number;
  /**
   * Test hook: runs after the backup an upgrade takes and before the schema lock, the
   * window in which another process opening the same database can upgrade it first.
   */
  beforeSchemaLock?: () => void;
}

/** The embedding model a database is opened for. */
interface EmbeddingSpec {
  readonly model: string;
  readonly dimensions: number;
}

/** How long a write waits for another connection's lock (a running memory server) before failing. */
const ADMIN_BUSY_TIMEOUT_MS = 5000;

/**
 * Open an EXISTING memory database for the host-side admin API (admin.ts): no
 * directory or file is created, no DDL runs, and a database whose schema is not
 * this binary's is refused instead of being upgraded (`initDatabase` backs up and
 * migrates or rebuilds a stale schema, which a `list` must never do). `readonly`
 * opens it read-only (list, show, search, export, stats).
 */
export function openExistingDatabase(dbPath: string, options: { readonly: boolean }): Database.Database {
  const db = new Database(dbPath, { readonly: options.readonly, fileMustExist: true });
  try {
    db.pragma(`busy_timeout = ${ADMIN_BUSY_TIMEOUT_MS}`);
    if (!options.readonly) db.pragma('foreign_keys = ON');
    sqliteVec.load(db);
    const stamp = readSchemaStamp(db);
    if (stamp !== String(SCHEMA_VERSION)) {
      throw new Error(
        `The memory database has schema version ${stamp === undefined ? '(none)' : JSON.stringify(stamp)}, ` +
          `not ${SCHEMA_VERSION}. Run a session that uses this memory once (the memory server upgrades it, ` +
          `keeping a backup), or use a matching IronCurtain version.`,
      );
    }
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

/**
 * Open (creating it if needed) the memory database at `dbPath` for `embeddingModel`:
 * load sqlite-vec, bring the schema to SCHEMA_VERSION, and check that the stored vectors
 * belong to the configured model.
 *
 * Several memory servers may open one database at the same time (every session of a
 * persona starts its own), so the schema is reconciled under SQLite's write lock: a
 * backup is taken first when the schema needs upgrading (VACUUM INTO cannot run inside
 * a transaction), then BEGIN IMMEDIATE, then the schema is read again and only what is
 * still needed is done (create, migrate or rebuild) and stamped in the same transaction.
 * Of several processes opening a stale database at once, one upgrades it; the others
 * find it current once they get the lock and delete their redundant backups.
 *
 *   - empty database            → create the schema
 *   - current stamp             → nothing to do
 *   - stamp 3 or 4 (or a v4 database missing its stamp)
 *                               → back up, then run the ordered additive MIGRATIONS
 *   - older, unstamped (legacy shape), unparseable stamp, or a half-created schema
 *                               → back up, then drop and recreate (rebuild)
 *   - newer stamp               → THROW (fail closed): an older binary must not touch a
 *                                 database it cannot understand
 *   - stored vectors from another embedding model (or of another size)
 *                               → THROW, leaving the database untouched; a database
 *                                 without vectors is switched to the configured model
 *
 * If the backup cannot be written, the open fails and the database is left untouched.
 */
export function initDatabase(
  dbPath: string,
  embeddingModel: string,
  options: InitDatabaseOptions = {},
): Database.Database {
  if (!isEphemeralDatabase(dbPath)) mkdirSync(dirname(dbPath), { recursive: true });
  const embedding: EmbeddingSpec = {
    model: embeddingModel,
    dimensions: options.dimensions ?? embeddingDimensionsFor(embeddingModel),
  };

  const db = new Database(dbPath, { timeout: SCHEMA_LOCK_TIMEOUT_MS });
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    sqliteVec.load(db);
    reconcileSchema(db, dbPath, embedding, options.beforeSchemaLock);
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

// ---------- Schema plan ----------

/** What opening a database has to do to its schema. */
type SchemaPlan =
  | { readonly kind: 'create' }
  | { readonly kind: 'current' }
  | { readonly kind: 'migrate'; readonly from: number }
  | { readonly kind: 'rebuild'; readonly reason: string }
  | { readonly kind: 'newer'; readonly stamp: string };

function tableExists(db: Database.Database, name: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const columns = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as Array<{ name: string }>;
  return columns.some((c) => c.name === column);
}

/** The `schema_version` stamp, or undefined when the database has none. */
function readSchemaStamp(db: Database.Database): string | undefined {
  if (!tableExists(db, 'schema_meta')) return undefined;
  const row = db.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get() as
    { value: string | null } | undefined;
  return row?.value ?? undefined;
}

/**
 * Decide what the schema needs (read-only). A stamp is compared NUMERICALLY: a string
 * compare once let an older binary drop a newer schema it could not understand.
 */
function planSchema(db: Database.Database): SchemaPlan {
  const stamp = readSchemaStamp(db);
  if (stamp === undefined) {
    if (tableExists(db, 'memories')) {
      // Stamped last by every version; a crash between creating the tables and stamping
      // them leaves a v4 database without its stamp. Without segment_id it is a legacy
      // (or foreign) shape.
      return hasColumn(db, 'memories', 'segment_id')
        ? { kind: 'migrate', from: 4 }
        : { kind: 'rebuild', reason: 'legacy-unversioned' };
    }
    return PARTIAL_SCHEMA_TABLES.some((table) => tableExists(db, table))
      ? { kind: 'rebuild', reason: 'partial-schema' }
      : { kind: 'create' };
  }
  // A present but unparseable stamp is not a recognizable newer version: rebuild.
  if (!/^\d+$/.test(stamp)) return { kind: 'rebuild', reason: `schema-${stamp}` };
  const onDisk = Number(stamp);
  if (onDisk > SCHEMA_VERSION) return { kind: 'newer', stamp };
  if (onDisk === SCHEMA_VERSION) return { kind: 'current' };
  if (onDisk >= OLDEST_MIGRATABLE_VERSION) return { kind: 'migrate', from: onDisk };
  return { kind: 'rebuild', reason: `schema-v${stamp}` };
}

/** Upgrades rewrite the live database, so they are preceded by a backup. */
function needsBackup(plan: SchemaPlan): plan is Extract<SchemaPlan, { kind: 'migrate' | 'rebuild' }> {
  return plan.kind === 'migrate' || plan.kind === 'rebuild';
}

function newerSchemaError(stamp: string): Error {
  return new Error(
    `Refusing to open memory database: on-disk schema version ${stamp} is newer than ` +
      `this binary's schema version ${SCHEMA_VERSION}. Upgrade the memory server or point at a ` +
      `compatible database; the newer database was left untouched.`,
  );
}

// ---------- Reconciliation ----------

/** See initDatabase. */
function reconcileSchema(
  db: Database.Database,
  dbPath: string,
  embedding: EmbeddingSpec,
  beforeSchemaLock: (() => void) | undefined,
): void {
  for (let attempt = 1; ; attempt++) {
    const planned = planSchema(db);
    if (planned.kind === 'newer') throw newerSchemaError(planned.stamp);
    // A mismatch refuses the open; check it before a backup is written for nothing.
    if (planned.kind === 'current' || planned.kind === 'migrate') assertEmbeddingMatches(db, embedding);
    const backupPath = needsBackup(planned)
      ? backupDatabaseBeforeUpgrade(db, dbPath, planned.kind === 'migrate' ? `schema-v${planned.from}` : planned.reason)
      : null;
    beforeSchemaLock?.();

    let applied: SchemaPlan | null;
    try {
      applied = db
        .transaction((): SchemaPlan | null => {
          const plan = planSchema(db);
          if (plan.kind === 'newer') throw newerSchemaError(plan.stamp);
          // Another process changed the database between the plan and the lock, and it
          // now needs an upgrade this attempt has no backup for: plan again.
          if (needsBackup(plan) && backupPath === null) return null;
          applySchemaPlan(db, plan, embedding);
          reconcileEmbedding(db, embedding);
          writeSchemaMeta(db, embedding);
          return plan;
        })
        .immediate();
    } catch (err) {
      // Nothing changed (the transaction rolled back), so the backup is not needed;
      // removing it keeps a server that is restarted again and again from piling them up.
      if (backupPath !== null) removeOwnFile(backupPath);
      throw err;
    }

    if (applied === null) {
      if (backupPath !== null) removeOwnFile(backupPath);
      if (attempt >= MAX_SCHEMA_ATTEMPTS) {
        throw new Error('Refusing to open memory database: its schema kept changing while it was being upgraded.');
      }
      continue;
    }
    if (backupPath !== null) {
      if (needsBackup(applied)) {
        console.warn(
          applied.kind === 'migrate'
            ? `[memory-server] Upgraded the memory database schema from v${applied.from} to v${SCHEMA_VERSION}; ` +
                `the previous database was backed up to '${backupPath}'.`
            : `[memory-server] Backed up incompatible memory database schema to '${backupPath}' before rebuilding.`,
        );
      } else {
        // Another process upgraded the database first and kept its own backup.
        removeOwnFile(backupPath);
      }
    }
    return;
  }
}

/** Do what `plan` says, inside the schema transaction. */
function applySchemaPlan(db: Database.Database, plan: SchemaPlan, embedding: EmbeddingSpec): void {
  switch (plan.kind) {
    case 'create':
      createSchema(db, embedding.dimensions);
      return;
    case 'current':
    case 'newer':
      return;
    case 'migrate':
      runMigrations(db, plan.from);
      // Anything else the schema lacks (a database missing one of its virtual tables)
      // is created too; createSchema only adds what is missing.
      createSchema(db, embedding.dimensions);
      return;
    case 'rebuild':
      // Virtual tables first; `memories` before `segments`, which it references.
      db.exec(`
        DROP TABLE IF EXISTS vec_memories;
        DROP TABLE IF EXISTS memories_fts;
        DROP TABLE IF EXISTS memories;
        DROP TABLE IF EXISTS segments;
        DROP TABLE IF EXISTS schema_meta;
      `);
      createSchema(db, embedding.dimensions);
      return;
  }
}

// ---------- Migrations ----------

/**
 * One schema step: upgrades a database stamped `to - 1` to `to`.
 */
export interface Migration {
  readonly to: number;
  readonly description: string;
  readonly up: (db: Database.Database) => void;
}

/**
 * The ordered, additive schema steps, oldest first; MIGRATIONS[i] upgrades
 * OLDEST_MIGRATABLE_VERSION + i to the next version, and the last one ends at
 * SCHEMA_VERSION. A step only adds (tables, nullable columns, indexes, backfilled
 * values), so it loses nothing, and a server of the previous version that is still
 * running keeps working on the upgraded database. Each step is idempotent (it checks
 * before it adds), and all of them run in the schema transaction, so a failure leaves
 * the database as it was.
 *
 * A SCHEMA_VERSION bump adds its step here; createSchema must build the same shape for
 * a new database (test/migrations.test.ts compares the two).
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    to: 4,
    description: 'source segments: the segments table and memories.segment_id',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS segments (
          id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          namespace   TEXT NOT NULL DEFAULT 'default',
          content     TEXT NOT NULL,
          source      TEXT,
          mode        TEXT,
          created_at  INTEGER NOT NULL,
          fact_count  INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_segments_namespace ON segments(namespace);
      `);
      if (!hasColumn(db, 'memories', 'segment_id')) {
        db.exec(`ALTER TABLE memories ADD COLUMN segment_id TEXT REFERENCES segments(id)`);
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_segment ON memories(segment_id) WHERE segment_id IS NOT NULL`);
    },
  },
  {
    to: 5,
    description: 'segment content hashes, so a retried ingest reuses its segments',
    up: (db) => {
      if (!hasColumn(db, 'segments', 'content_hash')) {
        db.exec(`ALTER TABLE segments ADD COLUMN content_hash TEXT`);
      }
      const rows = db
        .prepare(`SELECT id, content, source, mode FROM segments WHERE content_hash IS NULL`)
        .all() as Array<{
        id: string;
        content: string;
        source: string | null;
        mode: string | null;
      }>;
      const update = db.prepare(`UPDATE segments SET content_hash = ? WHERE id = ?`);
      for (const row of rows) update.run(segmentContentHash(row.content, row.source, row.mode), row.id);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_segments_content_hash ON segments(namespace, content_hash)`);
    },
  },
];

function runMigrations(db: Database.Database, from: number): void {
  for (const migration of MIGRATIONS) {
    if (migration.to > from) migration.up(db);
  }
}

// ---------- Fresh schema ----------

function createSchema(db: Database.Database, dimensions: number): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS segments (
      id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      namespace   TEXT NOT NULL DEFAULT 'default',
      content     TEXT NOT NULL,
      source      TEXT,
      mode        TEXT,
      created_at  INTEGER NOT NULL,
      fact_count  INTEGER NOT NULL DEFAULT 0,
      content_hash TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_segments_namespace ON segments(namespace);
    CREATE INDEX IF NOT EXISTS idx_segments_content_hash ON segments(namespace, content_hash);

    CREATE TABLE IF NOT EXISTS memories (
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
      consolidated INTEGER NOT NULL DEFAULT 1,
      segment_id TEXT REFERENCES segments(id)
    );

    CREATE INDEX IF NOT EXISTS idx_memories_namespace ON memories(namespace);
    CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(namespace, created_at);
    CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(namespace, importance DESC);
    CREATE INDEX IF NOT EXISTS idx_memories_accessed ON memories(namespace, last_accessed_at);
    CREATE INDEX IF NOT EXISTS idx_memories_unconsolidated
      ON memories(namespace, created_at) WHERE consolidated = 0;
    CREATE INDEX IF NOT EXISTS idx_memories_segment
      ON memories(segment_id) WHERE segment_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // Virtual tables cannot use IF NOT EXISTS in all SQLite builds, so check before
  // creating (inside the schema transaction, so no other process can race the check).
  if (!tableExists(db, 'vec_memories')) createVectorTable(db, dimensions);

  if (!tableExists(db, 'memories_fts')) {
    // A database that lost its keyword index (or never had one) gets it back for the
    // memories it already holds ('rebuild' re-reads the external content table).
    const hasRows = db.prepare(`SELECT 1 FROM memories LIMIT 1`).get() !== undefined;
    db.exec(`
      CREATE VIRTUAL TABLE memories_fts USING fts5(
        content,
        tags,
        content=memories,
        content_rowid=rowid,
        tokenize='porter unicode61'
      );
    `);

    // Create triggers to keep FTS in sync
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content, tags)
        VALUES (new.rowid, new.content, new.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags)
        VALUES ('delete', old.rowid, old.content, old.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags)
        VALUES ('delete', old.rowid, old.content, old.tags);
        INSERT INTO memories_fts(rowid, content, tags)
        VALUES (new.rowid, new.content, new.tags);
      END;
    `);
    if (hasRows) db.exec(`INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')`);
  }
}

function createVectorTable(db: Database.Database, dimensions: number): void {
  if (!Number.isSafeInteger(dimensions) || dimensions <= 0) {
    throw new Error(`Invalid embedding dimensions: ${String(dimensions)}`);
  }
  db.exec(`
    CREATE VIRTUAL TABLE vec_memories USING vec0(
      memory_id TEXT PRIMARY KEY,
      embedding float[${dimensions}]
    );
  `);
}

// ---------- Embedding model ----------

function metaValue(db: Database.Database, key: string): string | undefined {
  if (!tableExists(db, 'schema_meta')) return undefined;
  const row = db.prepare(`SELECT value FROM schema_meta WHERE key = ?`).get(key) as
    { value: string | null } | undefined;
  return row?.value ?? undefined;
}

/** The vector size `vec_memories` was created with (read from its definition), or undefined without one. */
function vectorTableDimensions(db: Database.Database): number | undefined {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vec_memories'`).get() as
    { sql: string | null } | undefined;
  const match = row?.sql ? /\bfloat\[(\d+)\]/i.exec(row.sql) : null;
  return match ? Number(match[1]) : undefined;
}

/**
 * The embedding model and vector size `db` was built for: `schema_meta.embedding_model`
 * and the size of its `vec_memories` index (undefined for what it does not record). For
 * the host-side admin API (admin.ts), which embeds imported memories for the database
 * rather than for a server's configuration.
 */
export function databaseEmbedding(db: Database.Database): { model?: string; dimensions?: number } {
  return { model: metaValue(db, 'embedding_model'), dimensions: vectorTableDimensions(db) };
}

function hasStoredVectors(db: Database.Database): boolean {
  return (
    tableExists(db, 'vec_memories') && db.prepare(`SELECT memory_id FROM vec_memories LIMIT 1`).get() !== undefined
  );
}

/** What the stored vectors were made with, when that is not what this server is configured for. */
function embeddingMismatch(
  db: Database.Database,
  embedding: EmbeddingSpec,
): { model: string; dimensions: string } | null {
  const storedModel = metaValue(db, 'embedding_model');
  const storedDimensions = vectorTableDimensions(db);
  const modelMatches = storedModel === undefined || sameEmbeddingModel(storedModel, embedding.model);
  const dimensionsMatch = storedDimensions === undefined || storedDimensions === embedding.dimensions;
  if (modelMatches && dimensionsMatch) return null;
  return {
    model: storedModel ?? 'unknown',
    dimensions: storedDimensions === undefined ? 'unknown' : String(storedDimensions),
  };
}

/**
 * Refuse to open a database whose stored vectors come from another embedding model or
 * have another size. Vectors of two models are not comparable even at the same size:
 * mixing them breaks every insert (another size) or silently degrades recall and
 * store-time dedup (the same size). A database without vectors is not refused; it is
 * switched to the configured model (reconcileEmbedding).
 */
function assertEmbeddingMatches(db: Database.Database, embedding: EmbeddingSpec): void {
  const stored = embeddingMismatch(db, embedding);
  if (stored === null || !hasStoredVectors(db)) return;
  throw new Error(
    `Refusing to open memory database: its vectors were made with embedding model '${stored.model}' ` +
      `(${stored.dimensions} dimensions), but the server is configured for '${embedding.model}' ` +
      `(${embedding.dimensions} dimensions). Set MEMORY_EMBEDDING_MODEL back to '${stored.model}', or point ` +
      'MEMORY_DB_PATH at a new database; re-embedding an existing database is not supported. ' +
      'The database was left untouched.',
  );
}

/** Inside the schema transaction: refuse a mismatch, or rebuild an empty vector index for the configured model. */
function reconcileEmbedding(db: Database.Database, embedding: EmbeddingSpec): void {
  assertEmbeddingMatches(db, embedding);
  const dimensions = vectorTableDimensions(db);
  if (dimensions !== undefined && dimensions !== embedding.dimensions) {
    // No vectors are stored (assertEmbeddingMatches), so nothing is lost.
    db.exec(`DROP TABLE vec_memories`);
    createVectorTable(db, embedding.dimensions);
  }
}

function writeSchemaMeta(db: Database.Database, embedding: EmbeddingSpec): void {
  const upsert = db.prepare(
    `INSERT INTO schema_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  upsert.run('schema_version', String(SCHEMA_VERSION));
  upsert.run('embedding_model', embedding.model);
  upsert.run('embedding_dimensions', String(embedding.dimensions));
}

// ---------- Backups ----------

/** Copy the database to a private sibling file before an upgrade rewrites it, and return its path. */
function backupDatabaseBeforeUpgrade(db: Database.Database, dbPath: string, reason: string): string {
  if (isEphemeralDatabase(dbPath)) {
    throw new Error(
      `Refusing to rebuild incompatible in-memory memory database schema because it cannot be backed up first.`,
    );
  }

  const sanitizedReason = reason.replace(/[^A-Za-z0-9._-]/g, '_');
  const base = `${dbPath}.backup-${sanitizedReason}-before-v${SCHEMA_VERSION}-${fileTimestamp()}.db`;
  try {
    return copyDatabaseToPrivateFile(db, base);
  } catch (cause) {
    throw new Error(
      `Refusing to upgrade the memory database schema because backup creation failed at '${base}'. ` +
        `The original database was left untouched.`,
      { cause },
    );
  }
}

/** A file this module created; removing it removes nobody else's copy. Best effort. */
function removeOwnFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // An extra copy is harmless.
  }
}

/** How many snapshots taken before forgets are kept per database (oldest removed first). */
export const MAX_FORGET_SNAPSHOTS = 5;

/** How many collision suffixes (`.db.1`, `.db.2`, ...) a snapshot name may try. */
const MAX_SNAPSHOT_NAME_ATTEMPTS = 1000;

/** True for a database with no file behind it (`:memory:` or an anonymous temporary database). */
function isEphemeralDatabase(dbPath: string): boolean {
  return dbPath === ':memory:' || dbPath === '';
}

function forgetSnapshotPrefix(dbPath: string): string {
  return `${basename(dbPath)}.forget-snapshot-`;
}

/** The current time as it appears in copy names (sorts chronologically). */
function fileTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** A copy's file could not be claimed; `path` is the name that failed. */
class PrivateFileError extends Error {
  constructor(
    readonly path: string,
    cause: unknown,
  ) {
    super(`Could not create '${basename(path)}'`, { cause });
  }
}

/**
 * Copy the whole database into `base` (or the first free one of `base.1`, `base.2`, ...),
 * created empty and private (mode 0600) before SQLite writes it: `VACUUM INTO` accepts an
 * existing empty file. Returns the copy's path; on failure removes the file it created
 * and throws a PrivateFileError naming it.
 */
function copyDatabaseToPrivateFile(db: Database.Database, base: string): string {
  const path = createPrivateSnapshotFile(base);
  try {
    db.prepare(`VACUUM main INTO ?`).run(path);
  } catch (cause) {
    // This call created the file, so removing it removes nobody else's copy.
    removeOwnFile(path);
    throw new PrivateFileError(path, cause);
  }
  return path;
}

/**
 * Copy the whole database to a sibling file before `memory_forget` deletes anything
 * (every bulk deletion by tags, query or before, and the first deletion of a server
 * run; see engine-impl.ts), so a deletion an injected or mistaken agent asked for
 * can be undone by restoring the copy. Returns the snapshot's path, or null for a
 * database that has no file (nothing outlives the process anyway).
 *
 * The snapshot is created private (mode 0600) before SQLite writes it: `VACUUM INTO`
 * accepts an existing empty file. Only the MAX_FORGET_SNAPSHOTS newest snapshots of
 * a database are kept. Throws when the snapshot cannot be written; the caller must
 * then delete nothing.
 */
export function snapshotDatabaseBeforeForget(db: Database.Database, dbPath: string): string | null {
  if (isEphemeralDatabase(dbPath)) return null;

  let snapshotPath: string;
  try {
    snapshotPath = copyDatabaseToPrivateFile(db, `${dbPath}.forget-snapshot-${fileTimestamp()}.db`);
  } catch (err) {
    if (err instanceof PrivateFileError) throw snapshotError(basename(err.path), err.cause);
    throw err;
  }

  pruneForgetSnapshots(dbPath);
  return snapshotPath;
}

/** The refusal when no snapshot could be saved (the name only: the agent sees this text). */
function snapshotError(name: string, cause: unknown): Error {
  return new Error(
    `Could not save a snapshot of the memory database ('${name}') before deleting memories; nothing was deleted.`,
    { cause },
  );
}

/**
 * Create `base` empty and private, or, when that name is taken, the first free one of
 * `base.1`, `base.2`, ..., and return its path. The exclusive create is the claim:
 * two servers sharing a database (concurrent sessions of one persona) may pick the
 * same name in the same millisecond, and the one that loses moves on to the next
 * name instead of writing (or later removing) the winner's file.
 */
function createPrivateSnapshotFile(base: string): string {
  for (let attempt = 0; attempt < MAX_SNAPSHOT_NAME_ATTEMPTS; attempt++) {
    const path = attempt === 0 ? base : `${base}.${String(attempt)}`;
    try {
      closeSync(openSync(path, 'wx', 0o600));
      return path;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw new PrivateFileError(path, cause);
    }
  }
  throw new PrivateFileError(base, new Error('no free name'));
}

/**
 * Remove all but the MAX_FORGET_SNAPSHOTS newest snapshots of `dbPath`. Only files
 * named like this module's snapshots are touched; their names sort by time. A file
 * that cannot be removed is left (best effort: an extra snapshot is harmless).
 */
function pruneForgetSnapshots(dbPath: string): void {
  const dir = dirname(dbPath);
  const prefix = forgetSnapshotPrefix(dbPath);
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.startsWith(prefix) && /\.db(?:\.\d+)?$/.test(name));
  } catch {
    return;
  }
  names.sort(compareSnapshotNames);
  for (const name of names.slice(0, Math.max(0, names.length - MAX_FORGET_SNAPSHOTS))) {
    try {
      unlinkSync(join(dir, name));
    } catch {
      // Best effort.
    }
  }
}

/** Orders snapshot names by time, then by their collision suffix (`.db`, `.db.1`, `.db.2`, ...). */
function compareSnapshotNames(a: string, b: string): number {
  const split = (name: string): [string, number] => {
    // `<stem>.db.<n>` -> [`<stem>.db`, n]; `<stem>.db` -> [`<stem>.db`, 0].
    const suffix = /\.db\.(\d+)$/.exec(name);
    return suffix ? [name.slice(0, name.length - suffix[0].length + '.db'.length), Number(suffix[1])] : [name, 0];
  };
  const [stemA, suffixA] = split(a);
  const [stemB, suffixB] = split(b);
  if (stemA !== stemB) return stemA < stemB ? -1 : 1;
  return suffixA - suffixB;
}

// ---------- Listing and restoring copies ----------

/** Which copy of a database a file is. */
export type DatabaseCopyKind = 'schema-upgrade' | 'forget-snapshot' | 'before-restore';

export interface DatabaseCopy {
  readonly path: string;
  readonly kind: DatabaseCopyKind;
  readonly bytes: number;
}

const COPY_KINDS: ReadonlyArray<{ readonly infix: string; readonly kind: DatabaseCopyKind }> = [
  { infix: '.backup-', kind: 'schema-upgrade' },
  { infix: '.forget-snapshot-', kind: 'forget-snapshot' },
  { infix: '.before-restore-', kind: 'before-restore' },
];

/**
 * The copies of `dbPath` this server wrote next to it: backups taken before a schema
 * upgrade, snapshots taken before a forget, and copies saved before a restore. Oldest
 * first within each kind (their names sort by time).
 */
export function listDatabaseCopies(dbPath: string): DatabaseCopy[] {
  const dir = dirname(resolve(dbPath));
  const stem = basename(dbPath);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const copies: DatabaseCopy[] = [];
  for (const { infix, kind } of COPY_KINDS) {
    const matching = names
      .filter((name) => name.startsWith(`${stem}${infix}`) && /\.db(?:\.\d+)?$/.test(name))
      .sort(compareSnapshotNames);
    for (const name of matching) {
      const path = join(dir, name);
      let bytes: number;
      try {
        bytes = statSync(path).size;
      } catch {
        continue;
      }
      copies.push({ path, kind, bytes });
    }
  }
  return copies;
}

export interface RestoreResult {
  /** The database that was restored. */
  readonly dbPath: string;
  /** The copy it was restored from. */
  readonly backupPath: string;
  /** Where the database was saved before the restore overwrote it (null when there was none). */
  readonly previousCopy: string | null;
  /** The schema stamp of the restored copy ('unversioned' when it had none); it is upgraded on restore. */
  readonly restoredSchema: string;
}

/**
 * Check that `backup` is a memory database this binary can open without rebuilding it:
 * intact, with a `memories` table, and with a schema it is current with or can migrate
 * in place (a copy it would rebuild on open would be emptied right after the restore).
 * Returns its schema stamp.
 */
function validateRestoreSource(backup: Database.Database): string {
  const check = backup.pragma('quick_check', { simple: true });
  if (check !== 'ok') throw new Error('The backup is damaged (SQLite quick_check failed); nothing was restored.');
  const plan = planSchema(backup);
  switch (plan.kind) {
    case 'create':
      throw new Error('The file is not a memory database (it has no memories table); nothing was restored.');
    case 'newer':
      throw new Error(
        `The backup has schema version ${plan.stamp}, newer than this server's ${SCHEMA_VERSION}; nothing was restored.`,
      );
    case 'rebuild':
      throw new Error(
        `The backup has a schema this server cannot upgrade in place (${plan.reason}); restoring it would empty ` +
          'the database. Nothing was restored.',
      );
    case 'current':
    case 'migrate':
      return readSchemaStamp(backup) ?? 'unversioned';
  }
}

/**
 * Restore the memory database at `dbPath` from `backupPath` (a schema-upgrade backup,
 * a forget snapshot, or any copy of a memory database):
 *
 *   1. the copy is checked (intact, a memory database, not from a newer server);
 *   2. the current database, if there is one, is saved first to a private
 *      `<db>.before-restore-<time>.db`, so the restore itself can be undone; if that
 *      fails, nothing is restored;
 *   3. the copy replaces the database's content through SQLite's online backup, which
 *      takes the database's write lock rather than swapping the file under an open
 *      connection;
 *   4. the restored database is opened once for the embedding model it was built with,
 *      which upgrades an older schema in place.
 *
 * Stop the sessions that use this memory first: a running server would carry on with
 * the restored content, but whatever it was in the middle of is lost.
 */
export async function restoreDatabase(backupPath: string, dbPath: string): Promise<RestoreResult> {
  if (isEphemeralDatabase(dbPath)) throw new Error('Cannot restore into an in-memory database.');
  const source = resolve(backupPath);
  const target = resolve(dbPath);
  if (!existsSync(source)) throw new Error(`No backup at '${source}'.`);
  if (existsSync(target) && realpathSync(source) === realpathSync(target)) {
    throw new Error('The backup is the database itself; nothing was restored.');
  }

  const backup = new Database(source, { readonly: true, fileMustExist: true });
  let restoredSchema: string;
  let previousCopy: string | null = null;
  try {
    restoredSchema = validateRestoreSource(backup);
    if (existsSync(target)) previousCopy = saveBeforeRestore(target);
    mkdirSync(dirname(target), { recursive: true });
    await backup.backup(target);
  } finally {
    backup.close();
  }

  const restored = new Database(target, { fileMustExist: true });
  let embedding: EmbeddingSpec;
  try {
    const model = metaValue(restored, 'embedding_model') ?? 'Xenova/bge-base-en-v1.5';
    embedding = { model, dimensions: vectorTableDimensions(restored) ?? embeddingDimensionsFor(model) };
  } finally {
    restored.close();
  }
  initDatabase(target, embedding.model, { dimensions: embedding.dimensions }).close();

  return { dbPath: target, backupPath: source, previousCopy, restoredSchema };
}

/** Save the database at `target` before a restore overwrites it, and return the copy's path. */
function saveBeforeRestore(target: string): string {
  const current = new Database(target, { fileMustExist: true });
  try {
    return copyDatabaseToPrivateFile(current, `${target}.before-restore-${fileTimestamp()}.db`);
  } catch (cause) {
    throw new Error(
      'Could not save a copy of the current memory database before restoring; nothing was restored. ' +
        'Move the database aside and run the restore again.',
      { cause },
    );
  } finally {
    current.close();
  }
}

export { EMBEDDING_DIMENSIONS, SCHEMA_VERSION };
