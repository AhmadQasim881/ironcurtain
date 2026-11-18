/**
 * Host-side administration of one memory database: what
 * `ironcurtain memory <persona|job> ...` runs (exported as
 * `@provos/memory-mcp-server/admin`).
 *
 * Unlike the MCP server (engine-impl.ts), this API:
 *   - never runs maintenance: opening a store for a `list` or an `export` does not
 *     consolidate, decay or compact anything, and needs no LLM;
 *   - never creates, migrates or rebuilds a database it reads: a missing file or a
 *     schema this version does not know is refused (`openExistingDatabase`);
 *   - sees every memory of the namespace: those waiting for review, decayed and
 *     compacted ones included (it is the user's view, not an agent's);
 *   - needs no embedding model, except to import a memory that comes without a
 *     vector (loaded from the verified model store, see ImportOptions.modelStore).
 *
 * Deletions go through the same path as memory_forget (`forgetMemoryRows`: the
 * rows with their vectors and keyword entries, the source segments they came from,
 * compaction's copies of their text and the superseded copies of it) after the same
 * snapshot.
 */

import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  SCHEMA_VERSION,
  databaseEmbedding,
  initDatabase,
  openExistingDatabase,
  snapshotDatabaseBeforeForget,
  type MemoryRow,
  type SegmentRow,
} from './storage/database.js';
import { forgetMemoryRows, getEmbeddingsForMemories, getMemoryPage } from './storage/queries.js';
import { loadConfig } from './config.js';
import { embeddingDimensionsFor } from './embedding/models.js';
import { segmentContentHash } from './utils/content-hash.js';
import type { MemoryWriter } from './types.js';
import { parseTags } from './utils/tags.js';
import { asMemoryWriter } from './utils/provenance.js';
import { PENDING_REVIEW_KEY, REVIEWED_AT_KEY, pendingReviewOf, pendingSql, reviewGroupSql } from './utils/review.js';
import { redactSecrets } from './utils/secrets.js';
import { MAX_AS_OF_FUTURE_SKEW_MS } from './tools/validation.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** `active`: in briefings and recall. `decayed`: importance 0. `compacted`: folded into a summary. */
export type AdminMemoryStatus = 'active' | 'decayed' | 'compacted';

/** One memory as the admin API reports it. */
export interface AdminMemory {
  id: string;
  content: string;
  tags: string[];
  importance: number;
  status: AdminMemoryStatus;
  created_at: number;
  updated_at: number;
  last_accessed_at: number;
  access_count: number;
  /** False until the memory server's consolidation pass has judged it against the others. */
  consolidated: boolean;
  source: string | null;
  /** The source segment a `memory_ingest` fact was extracted from. */
  segment_id: string | null;
  /** Who wrote it (host-recorded), or null for a row from before provenance existed. */
  writer: MemoryWriter | null;
  /** The writer scope while the memory waits for review; null when it does not (any more). */
  pending_review: string | null;
  /** When the memory was approved (epoch ms), or null. */
  reviewed_at: number | null;
}

/** A source segment (the text `memory_ingest` extracted facts from). */
export interface AdminSegment {
  id: string;
  content: string;
  source: string | null;
  mode: string | null;
  created_at: number;
  fact_count: number;
}

/** One memory with its whole metadata and its source segment. */
export interface AdminMemoryDetail extends AdminMemory {
  metadata: Record<string, unknown> | null;
  segment: AdminSegment | null;
  /** Digest of the full releasable payload, bound to this namespace and memory. */
  review_digest: string;
}

/** A snapshot the host review displayed in full. */
export interface MemoryReviewReceipt {
  id: string;
  digest: string;
}

export interface AdminStats {
  namespace: string;
  total: number;
  active: number;
  decayed: number;
  compacted: number;
  /** Memories waiting for review, in total and per writer scope. */
  pending_review: number;
  pending_by_scope: Array<{ scope: string; count: number }>;
  /** Memories the memory server has not consolidated yet. */
  unconsolidated: number;
  segments: number;
  /** created_at of the oldest and newest memory (epoch ms). */
  oldest: number | null;
  newest: number | null;
  /** Size of the whole database file. */
  storage_bytes: number;
  top_tags: Array<{ tag: string; count: number }>;
}

export interface ListOptions {
  /** Default 50. */
  limit?: number;
  offset?: number;
  /** Only memories waiting for review. */
  pendingOnly?: boolean;
}

export interface ForgetOutcome {
  forgotten: number;
  /** Requested ids that are not memories of this namespace. */
  missing: string[];
  /** The snapshot written before the deletion, or null when nothing was deleted. */
  snapshot: string | null;
}

export interface ApproveOutcome {
  approved: number;
  missing: string[];
  /** Requested ids that were not waiting for review. */
  notPending: string[];
  /** Pending memories whose releasable payload changed since review. */
  changed: string[];
}

export interface ImportOptions {
  /**
   * Embeds a memory that the file gives no usable vector for. Defaults to the
   * memory server's embedder with the database's model, loaded from `modelStore`.
   */
  embed?: (text: string) => Promise<Float32Array>;
  /**
   * The model store the default embedder loads its model from, as a memory server
   * does (models/model-store.ts): the directory of verified model files
   * (MEMORY_MODELS_DIR) and whether a model missing from it may be downloaded
   * (`offline`: never, MEMORY_MODELS_OFFLINE). IronCurtain passes
   * `~/.ironcurtain/models` and `memory.offlineModels`, as it does for its memory
   * servers. Default: the memory server's own defaults (config.ts).
   */
  modelStore?: { modelsDir: string; offline: boolean };
}

export interface ImportOutcome {
  memories: number;
  segments: number;
  /** Records whose id the database already has (left as they are). */
  skipped_existing: number;
  /** Memories whose source segment is in neither the file nor the database (imported without one). */
  unlinked_segments: number;
  /** Memories embedded during the import (no vector in the file, or one from another model). */
  embedded: number;
  /** Secret values removed from imported text, as the memory server removes them. */
  redacted_secrets: number;
}

/** A read-only view of one namespace of a memory database. */
export interface MemoryStoreReader {
  readonly namespace: string;
  readonly dbPath: string;
  stats(): AdminStats;
  /** Newest first. */
  list(options?: ListOptions): AdminMemory[];
  /** Memories whose content, tags or source contain `text` (case-insensitive for ASCII), newest first. */
  search(text: string, options?: { limit?: number }): AdminMemory[];
  get(id: string): AdminMemoryDetail | undefined;
  /**
   * The JSONL export, one line per yielded string (no newline): a header, every
   * segment, then every memory of the namespace with its vector (when it has one),
   * read page by page from one consistent snapshot of the database.
   */
  exportLines(): Generator<string, void, undefined>;
  close(): void;
}

/** A writable view of one namespace of a memory database. */
export interface MemoryStoreWriter extends MemoryStoreReader {
  /** Deletes these memories (after a snapshot of the database). */
  forget(ids: readonly string[]): ForgetOutcome;
  /** Approves only these exact reviewed snapshots, checked under the write lock. */
  approve(receipts: readonly MemoryReviewReceipt[]): ApproveOutcome;
  /** Imports an export (see {@link MemoryStoreReader.exportLines}) into this namespace. */
  importLines(lines: AsyncIterable<string> | Iterable<string>, options?: ImportOptions): Promise<ImportOutcome>;
}

export interface OpenStoreOptions {
  dbPath: string;
  namespace: string;
}

// ---------------------------------------------------------------------------
// Export format
// ---------------------------------------------------------------------------

/** The `kind` of an export's first line. */
export const EXPORT_FORMAT = 'ironcurtain-memory-export';
/** The export format version this code writes and reads. */
export const EXPORT_VERSION = 1;

/** Rows read per page while exporting. */
const EXPORT_PAGE_SIZE = 500;
/** Longest import line accepted (a memory with its vector is a few KB). */
const MAX_IMPORT_LINE_LENGTH = 8 * 1024 * 1024;
/** Most records one import may hold. */
const MAX_IMPORT_RECORDS = 1_000_000;
/** Longest text (memory or segment content) an import accepts. */
const MAX_IMPORT_TEXT_LENGTH = 1_000_000;
const MAX_IMPORT_TAGS = 200;
const MAX_IMPORT_TAG_LENGTH = 1000;
const MAX_IMPORT_SHORT_TEXT_LENGTH = 1000;
const MAX_IMPORT_METADATA_LENGTH = 1_000_000;
/** Ids are what the server generates: 16 random bytes in lowercase hex. */
const ID_PATTERN = /^[0-9a-f]{32}$/;

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100_000;

/** An id this API accepts (as the server generates them). */
export function isMemoryId(value: string): boolean {
  return ID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

/** Opens an existing memory database read-only. Throws when it is missing or has another schema. */
export function openMemoryStoreReader(options: OpenStoreOptions): MemoryStoreReader {
  const db = openExistingDatabase(options.dbPath, { readonly: true });
  return new Store(db, options);
}

/**
 * Opens an existing memory database for writing, or, with `create`, creates it
 * (with the memory server's schema) when the file does not exist yet.
 */
export function openMemoryStoreWriter(options: OpenStoreOptions & { create?: boolean }): MemoryStoreWriter {
  const db =
    options.create === true && !existsSync(options.dbPath)
      ? initDatabase(options.dbPath, loadConfig({}).embeddingModel)
      : openExistingDatabase(options.dbPath, { readonly: false });
  return new Store(db, options);
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function parseMetadata(metadata: string | null): Record<string, unknown> | null {
  if (!metadata) return null;
  try {
    const value: unknown = JSON.parse(metadata);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function statusOf(row: Pick<MemoryRow, 'is_compacted' | 'importance'>): AdminMemoryStatus {
  if (row.is_compacted === 1) return 'compacted';
  return row.importance > 0 ? 'active' : 'decayed';
}

function toAdminMemory(row: MemoryRow): AdminMemory {
  const metadata = parseMetadata(row.metadata);
  const reviewedAt = metadata?.[REVIEWED_AT_KEY];
  return {
    id: row.id,
    content: row.content,
    tags: parseTags(row.tags),
    importance: row.importance,
    status: statusOf(row),
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_accessed_at: row.last_accessed_at,
    access_count: row.access_count,
    consolidated: row.consolidated === 1,
    source: row.source,
    segment_id: row.segment_id,
    writer: asMemoryWriter(metadata?.writer) ?? null,
    pending_review: pendingReviewOf(row.metadata) ?? null,
    reviewed_at: typeof reviewedAt === 'number' ? reviewedAt : null,
  };
}

function toAdminSegment(row: SegmentRow): AdminSegment {
  return {
    id: row.id,
    content: row.content,
    source: row.source,
    mode: row.mode,
    created_at: row.created_at,
    fact_count: row.fact_count,
  };
}

/** Escapes `%`, `_` and `\` for a LIKE pattern with `ESCAPE '\'`. */
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function boundedLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined) return fallback;
  if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
  return Math.min(limit, MAX_LIST_LIMIT);
}

function encodeVector(vector: Float32Array): string {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('base64');
}

/** A base64 float32 vector of `dimensions` finite values, or undefined for anything else. */
function decodeVector(encoded: string, dimensions: number): Float32Array | undefined {
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length !== dimensions * 4) return undefined;
  // Copied into its own buffer: a Buffer may be a slice of a shared pool.
  const vector = new Float32Array(dimensions);
  new Uint8Array(vector.buffer).set(bytes);
  return vector.every((x) => Number.isFinite(x)) ? vector : undefined;
}

function vectorBlob(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

// ---------------------------------------------------------------------------
// Import records
// ---------------------------------------------------------------------------

interface ImportHeader {
  embeddingModel: string | null;
}

interface SegmentRecord {
  id: string;
  content: string;
  source: string | null;
  mode: string | null;
  createdAt: number;
  factCount: number;
}

interface MemoryRecord {
  id: string;
  content: string;
  tags: string[];
  importance: number;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number;
  accessCount: number;
  isCompacted: boolean;
  consolidated: boolean;
  source: string | null;
  metadata: Record<string, unknown> | null;
  segmentId: string | null;
  embedding: string | null;
}

/** An import file that cannot be read; nothing was imported. */
export class MemoryImportError extends Error {
  readonly code = 'MEMORY_IMPORT_INVALID';
  constructor(line: number, problem: string) {
    super(`Line ${line}: ${problem}. Nothing was imported.`);
  }
}

function asRecord(value: unknown, line: number): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MemoryImportError(line, 'expected a JSON object');
  }
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, key: string, line: number, max: number): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length > max) {
    throw new MemoryImportError(line, `"${key}" must be a string of at most ${max} characters`);
  }
  return value;
}

function nullableStringField(record: Record<string, unknown>, key: string, line: number, max: number): string | null {
  if (record[key] === null || record[key] === undefined) return null;
  return stringField(record, key, line, max);
}

function idField(record: Record<string, unknown>, key: string, line: number): string {
  const value = record[key];
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new MemoryImportError(line, `"${key}" must be a memory id (32 lowercase hex characters)`);
  }
  return value;
}

function timeField(record: Record<string, unknown>, key: string, line: number, now: number): number {
  const value = record[key];
  // A future time would sort first in every "recent" view and never decay; the
  // memory server bounds as_of the same way.
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > now + MAX_AS_OF_FUTURE_SKEW_MS) {
    throw new MemoryImportError(line, `"${key}" must be an epoch-ms time that is not in the future`);
  }
  return value;
}

function countField(record: Record<string, unknown>, key: string, line: number): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new MemoryImportError(line, `"${key}" must be a non-negative integer`);
  }
  return value;
}

function booleanField(record: Record<string, unknown>, key: string, line: number): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') throw new MemoryImportError(line, `"${key}" must be true or false`);
  return value;
}

function parseHeader(value: unknown, line: number): ImportHeader {
  const record = asRecord(value, line);
  if (record.kind !== EXPORT_FORMAT) {
    throw new MemoryImportError(
      line,
      `not an IronCurtain memory export (the first line must have kind "${EXPORT_FORMAT}")`,
    );
  }
  if (record.version !== EXPORT_VERSION) {
    throw new MemoryImportError(line, `unsupported export version (this IronCurtain reads version ${EXPORT_VERSION})`);
  }
  return { embeddingModel: nullableStringField(record, 'embedding_model', line, MAX_IMPORT_SHORT_TEXT_LENGTH) };
}

function parseSegment(record: Record<string, unknown>, line: number, now: number): SegmentRecord {
  return {
    id: idField(record, 'id', line),
    content: stringField(record, 'content', line, MAX_IMPORT_TEXT_LENGTH),
    source: nullableStringField(record, 'source', line, MAX_IMPORT_SHORT_TEXT_LENGTH),
    mode: nullableStringField(record, 'mode', line, MAX_IMPORT_SHORT_TEXT_LENGTH),
    createdAt: timeField(record, 'created_at', line, now),
    factCount: countField(record, 'fact_count', line),
  };
}

function parseMemory(record: Record<string, unknown>, line: number, now: number): MemoryRecord {
  const content = stringField(record, 'content', line, MAX_IMPORT_TEXT_LENGTH);
  if (content.trim().length === 0) throw new MemoryImportError(line, '"content" must not be empty');
  const tags = record.tags;
  if (
    !Array.isArray(tags) ||
    tags.length > MAX_IMPORT_TAGS ||
    !tags.every((t): t is string => typeof t === 'string' && t.length <= MAX_IMPORT_TAG_LENGTH)
  ) {
    throw new MemoryImportError(line, `"tags" must be a list of at most ${MAX_IMPORT_TAGS} strings`);
  }
  const importance = record.importance;
  if (typeof importance !== 'number' || !Number.isFinite(importance) || importance < 0 || importance > 1) {
    throw new MemoryImportError(line, '"importance" must be a number from 0 to 1');
  }
  const metadata = record.metadata ?? null;
  if (metadata !== null && (typeof metadata !== 'object' || Array.isArray(metadata))) {
    throw new MemoryImportError(line, '"metadata" must be an object or null');
  }
  if (metadata !== null && JSON.stringify(metadata).length > MAX_IMPORT_METADATA_LENGTH) {
    throw new MemoryImportError(line, '"metadata" is too large');
  }
  const embedding = record.embedding ?? null;
  if (embedding !== null && typeof embedding !== 'string') {
    throw new MemoryImportError(line, '"embedding" must be a base64 string or null');
  }
  return {
    id: idField(record, 'id', line),
    content,
    tags,
    importance,
    createdAt: timeField(record, 'created_at', line, now),
    updatedAt: timeField(record, 'updated_at', line, now),
    lastAccessedAt: timeField(record, 'last_accessed_at', line, now),
    accessCount: countField(record, 'access_count', line),
    isCompacted: booleanField(record, 'is_compacted', line),
    consolidated: booleanField(record, 'consolidated', line),
    source: nullableStringField(record, 'source', line, MAX_IMPORT_SHORT_TEXT_LENGTH),
    metadata: metadata as Record<string, unknown> | null,
    segmentId:
      record.segment_id === null || record.segment_id === undefined ? null : idField(record, 'segment_id', line),
    embedding,
  };
}

/** `text` with secret values removed, counting them into `counter`. */
function withoutSecrets(text: string, counter: { count: number }): string {
  const { text: clean, count } = redactSecrets(text);
  counter.count += count;
  return clean;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

class Store implements MemoryStoreWriter {
  readonly namespace: string;
  readonly dbPath: string;

  constructor(
    private readonly db: Database.Database,
    options: OpenStoreOptions,
  ) {
    this.namespace = options.namespace;
    this.dbPath = options.dbPath;
  }

  close(): void {
    this.db.close();
  }

  private embeddingModel(): string | null {
    const row = this.db.prepare(`SELECT value FROM schema_meta WHERE key = 'embedding_model'`).get() as
      { value: string } | undefined;
    return row?.value ?? null;
  }

  /**
   * The model this database's vectors are made with and their size (its vector index
   * holds vectors of that size only); the memory server's defaults for what it does not
   * record.
   */
  private embeddingSpec(): ImportEmbedding {
    const stored = databaseEmbedding(this.db);
    const model = stored.model ?? loadConfig({}).embeddingModel;
    return { model, dimensions: stored.dimensions ?? embeddingDimensionsFor(model) };
  }

  stats(): AdminStats {
    const pending = pendingSql('m');
    const group = reviewGroupSql('m');
    const agg = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN m.is_compacted = 0 AND m.importance > 0 THEN 1 ELSE 0 END), 0) AS active,
           COALESCE(SUM(CASE WHEN m.is_compacted = 0 AND m.importance = 0 THEN 1 ELSE 0 END), 0) AS decayed,
           COALESCE(SUM(CASE WHEN m.is_compacted = 1 THEN 1 ELSE 0 END), 0) AS compacted,
           COALESCE(SUM(CASE WHEN ${pending} THEN 1 ELSE 0 END), 0) AS pending,
           COALESCE(SUM(CASE WHEN m.consolidated = 0 THEN 1 ELSE 0 END), 0) AS unconsolidated,
           MIN(m.created_at) AS oldest,
           MAX(m.created_at) AS newest
         FROM memories m WHERE m.namespace = ?`,
      )
      .get(this.namespace) as {
      total: number;
      active: number;
      decayed: number;
      compacted: number;
      pending: number;
      unconsolidated: number;
      oldest: number | null;
      newest: number | null;
    };
    const byScope = this.db
      .prepare(
        `SELECT ${group} AS scope, COUNT(*) AS count
         FROM memories m WHERE m.namespace = ? AND ${pending}
         GROUP BY 1 ORDER BY count DESC, scope ASC`,
      )
      .all(this.namespace) as Array<{ scope: string; count: number }>;
    const segments = (
      this.db.prepare(`SELECT COUNT(*) AS count FROM segments WHERE namespace = ?`).get(this.namespace) as {
        count: number;
      }
    ).count;
    const topTags = this.db
      .prepare(
        `SELECT value AS tag, COUNT(*) AS count
         FROM memories m, json_each(m.tags)
         WHERE m.namespace = ? AND m.tags IS NOT NULL AND json_valid(m.tags) AND typeof(value) = 'text'
         GROUP BY value ORDER BY count DESC, tag ASC LIMIT 20`,
      )
      .all(this.namespace) as Array<{ tag: string; count: number }>;
    const pageCount = (this.db.prepare(`PRAGMA page_count`).get() as { page_count: number }).page_count;
    const pageSize = (this.db.prepare(`PRAGMA page_size`).get() as { page_size: number }).page_size;
    return {
      namespace: this.namespace,
      total: agg.total,
      active: agg.active,
      decayed: agg.decayed,
      compacted: agg.compacted,
      pending_review: agg.pending,
      pending_by_scope: byScope,
      unconsolidated: agg.unconsolidated,
      segments,
      oldest: agg.oldest,
      newest: agg.newest,
      storage_bytes: pageCount * pageSize,
      top_tags: topTags,
    };
  }

  list(options: ListOptions = {}): AdminMemory[] {
    const limit = boundedLimit(options.limit, DEFAULT_LIST_LIMIT);
    const offset = options.offset ?? 0;
    if (!Number.isInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer');
    const pendingFilter = options.pendingOnly === true ? ` AND ${pendingSql('m')}` : '';
    const rows = this.db
      .prepare(
        `SELECT m.* FROM memories m
         WHERE m.namespace = ?${pendingFilter}
         ORDER BY m.created_at DESC, m.rowid DESC
         LIMIT ? OFFSET ?`,
      )
      .all(this.namespace, limit, offset) as MemoryRow[];
    return rows.map(toAdminMemory);
  }

  search(text: string, options: { limit?: number } = {}): AdminMemory[] {
    if (text.trim().length === 0) throw new Error('search text must not be empty');
    const limit = boundedLimit(options.limit, DEFAULT_LIST_LIMIT);
    const pattern = likePattern(text.trim());
    const rows = this.db
      .prepare(
        `SELECT m.* FROM memories m
         WHERE m.namespace = ?
           AND (m.content LIKE ? ESCAPE '\\' OR m.tags LIKE ? ESCAPE '\\' OR m.source LIKE ? ESCAPE '\\')
         ORDER BY m.created_at DESC, m.rowid DESC
         LIMIT ?`,
      )
      .all(this.namespace, pattern, pattern, pattern, limit) as MemoryRow[];
    return rows.map(toAdminMemory);
  }

  get(id: string): AdminMemoryDetail | undefined {
    const row = this.db.prepare(`SELECT * FROM memories WHERE namespace = ? AND id = ?`).get(this.namespace, id) as
      MemoryRow | undefined;
    if (row === undefined) return undefined;
    const segment =
      row.segment_id === null
        ? undefined
        : (this.db
            .prepare(`SELECT * FROM segments WHERE namespace = ? AND id = ?`)
            .get(this.namespace, row.segment_id) as SegmentRow | undefined);
    const detail = {
      ...toAdminMemory(row),
      metadata: parseMetadata(row.metadata),
      segment: segment === undefined ? null : toAdminSegment(segment),
    };
    return {
      ...detail,
      review_digest: createHash('sha256')
        .update(
          JSON.stringify([
            1,
            this.namespace,
            detail.id,
            detail.content,
            detail.tags,
            detail.source,
            detail.segment_id,
            detail.metadata,
            detail.segment,
          ]),
        )
        .digest('hex'),
    };
  }

  *exportLines(): Generator<string, void, undefined> {
    // One read transaction: every page comes from the same snapshot, even while a
    // memory server writes to the database.
    this.db.prepare('BEGIN').run();
    try {
      yield JSON.stringify({
        kind: EXPORT_FORMAT,
        version: EXPORT_VERSION,
        namespace: this.namespace,
        schema_version: String(SCHEMA_VERSION),
        embedding_model: this.embeddingModel(),
        exported_at: new Date().toISOString(),
      });

      const segmentPage = this.db.prepare(
        `SELECT rowid AS rowid, * FROM segments WHERE namespace = ? AND rowid > ? ORDER BY rowid ASC LIMIT ?`,
      );
      for (let after = 0; ;) {
        const page = segmentPage.all(this.namespace, after, EXPORT_PAGE_SIZE) as Array<SegmentRow & { rowid: number }>;
        if (page.length === 0) break;
        for (const row of page) yield JSON.stringify({ kind: 'segment', ...toAdminSegment(row) });
        after = page[page.length - 1].rowid;
      }

      for (let after = 0; ;) {
        const page = getMemoryPage(this.db, this.namespace, after, EXPORT_PAGE_SIZE);
        if (page.length === 0) break;
        const vectors = getEmbeddingsForMemories(
          this.db,
          this.namespace,
          page.map((row) => row.id),
        );
        for (const row of page) {
          const vector = vectors.get(row.id);
          yield JSON.stringify({
            kind: 'memory',
            id: row.id,
            content: row.content,
            tags: parseTags(row.tags),
            importance: row.importance,
            created_at: row.created_at,
            updated_at: row.updated_at,
            last_accessed_at: row.last_accessed_at,
            access_count: row.access_count,
            is_compacted: row.is_compacted === 1,
            consolidated: row.consolidated === 1,
            source: row.source,
            metadata: parseMetadata(row.metadata),
            segment_id: row.segment_id,
            embedding: vector === undefined ? null : encodeVector(vector),
          });
        }
        after = page[page.length - 1].rowid;
      }
    } finally {
      this.db.prepare('COMMIT').run();
    }
  }

  forget(ids: readonly string[]): ForgetOutcome {
    const unique = [...new Set(ids)];
    for (const id of unique) {
      if (!ID_PATTERN.test(id)) throw new Error(`Not a memory id: ${JSON.stringify(id)}`);
    }
    const existing = new Set(
      unique.filter(
        (id) =>
          this.db.prepare(`SELECT 1 FROM memories WHERE namespace = ? AND id = ?`).get(this.namespace, id) !==
          undefined,
      ),
    );
    const missing = unique.filter((id) => !existing.has(id));
    if (existing.size === 0) return { forgotten: 0, missing, snapshot: null };
    // As memory_forget does: the copy is written first, and nothing is deleted when it fails.
    const snapshot = snapshotDatabaseBeforeForget(this.db, this.dbPath);
    const forgotten = forgetMemoryRows(this.db, this.namespace, [...existing]);
    return { forgotten, missing, snapshot };
  }

  /**
   * Marks a pending memory reviewed: the marker goes, the time of the review is
   * recorded, and the memory is queued for consolidation again so the memory server
   * judges it against the reviewed memories. While it waited it was frozen
   * (utils/review.ts); approve also checks the full reviewed snapshot under the
   * same transaction before releasing its text, tags, source and source passage.
   */
  private markReviewed(id: string, metadata: string | null, now: number): void {
    const kept = Object.entries(parseMetadata(metadata) ?? {}).filter(([key]) => key !== PENDING_REVIEW_KEY);
    const reviewed = { ...Object.fromEntries(kept), [REVIEWED_AT_KEY]: now };
    this.db
      .prepare(`UPDATE memories SET metadata = ?, consolidated = 0 WHERE namespace = ? AND id = ?`)
      .run(JSON.stringify(reviewed), this.namespace, id);
  }

  /*
   * Approvals (and imports) run in IMMEDIATE transactions that read the rows they
   * rewrite: a memory server may write the same database meanwhile (consolidation
   * rewrites a row's metadata), so the metadata is read under the write lock, never
   * before it (a stale copy written back would drop the server's change), and a
   * deferred transaction would fail with SQLITE_BUSY_SNAPSHOT instead of waiting.
   */

  approve(receipts: readonly MemoryReviewReceipt[]): ApproveOutcome {
    const unique = new Map<string, string>();
    for (const receipt of receipts) {
      if (!ID_PATTERN.test(receipt.id) || !/^[a-f0-9]{64}$/.test(receipt.digest)) {
        throw new Error('Approval requires memory review receipts (id and SHA-256 digest)');
      }
      const previous = unique.get(receipt.id);
      if (previous !== undefined && previous !== receipt.digest) throw new Error('Conflicting memory review receipts');
      unique.set(receipt.id, receipt.digest);
    }
    const outcome: ApproveOutcome = { approved: 0, missing: [], notPending: [], changed: [] };
    const now = Date.now();
    const select = this.db.prepare(`SELECT metadata FROM memories WHERE namespace = ? AND id = ?`);
    this.db
      .transaction(() => {
        for (const [id, digest] of unique) {
          const row = select.get(this.namespace, id) as { metadata: string | null } | undefined;
          if (row === undefined) {
            outcome.missing.push(id);
          } else if (pendingReviewOf(row.metadata) === undefined) {
            outcome.notPending.push(id);
          } else if (this.get(id)?.review_digest !== digest) {
            outcome.changed.push(id);
          } else {
            this.markReviewed(id, row.metadata, now);
            outcome.approved += 1;
          }
        }
      })
      .immediate();
    return outcome;
  }

  async importLines(
    lines: AsyncIterable<string> | Iterable<string>,
    options: ImportOptions = {},
  ): Promise<ImportOutcome> {
    const now = Date.now();
    let header: ImportHeader | undefined;
    const segments: SegmentRecord[] = [];
    const memories: MemoryRecord[] = [];
    let lineNumber = 0;
    // Read and check the whole file before writing anything: an import is all or nothing.
    for await (const raw of lines) {
      lineNumber += 1;
      if (raw.length > MAX_IMPORT_LINE_LENGTH) throw new MemoryImportError(lineNumber, 'the line is too long');
      const text = raw.trim();
      if (text.length === 0) continue;
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        throw new MemoryImportError(lineNumber, 'not valid JSON');
      }
      if (header === undefined) {
        header = parseHeader(value, lineNumber);
        continue;
      }
      if (segments.length + memories.length >= MAX_IMPORT_RECORDS) {
        throw new MemoryImportError(lineNumber, `more than ${MAX_IMPORT_RECORDS} records`);
      }
      const record = asRecord(value, lineNumber);
      if (record.kind === 'segment') segments.push(parseSegment(record, lineNumber, now));
      else if (record.kind === 'memory') memories.push(parseMemory(record, lineNumber, now));
      else throw new MemoryImportError(lineNumber, '"kind" must be "segment" or "memory"');
    }
    if (header === undefined) throw new MemoryImportError(lineNumber, 'the file is empty');

    const redacted = { count: 0 };
    for (const segment of segments) {
      segment.content = withoutSecrets(segment.content, redacted);
      if (segment.source !== null) segment.source = withoutSecrets(segment.source, redacted);
    }

    // Vectors: the file's, when it was exported with this database's model and the
    // text is unchanged; otherwise embedded now. Decayed and compacted memories have none.
    const embedding = this.embeddingSpec();
    const fileVectorsUsable = header.embeddingModel === embedding.model;
    const embedText = options.embed ?? defaultEmbedder(embedding, options.modelStore);
    const vectors = new Map<string, Float32Array>();
    let embedded = 0;
    for (const memory of memories) {
      const before = redacted.count;
      memory.content = withoutSecrets(memory.content, redacted);
      memory.tags = memory.tags.map((tag) => withoutSecrets(tag, redacted));
      if (memory.source !== null) memory.source = withoutSecrets(memory.source, redacted);
      const textChanged = redacted.count !== before;
      if (memory.importance === 0 || memory.isCompacted) continue;
      const fromFile =
        fileVectorsUsable && !textChanged && memory.embedding !== null
          ? decodeVector(memory.embedding, embedding.dimensions)
          : undefined;
      if (fromFile !== undefined) {
        vectors.set(memory.id, fromFile);
      } else {
        vectors.set(memory.id, await embedText(memory.content));
        embedded += 1;
      }
    }

    const outcome: ImportOutcome = {
      memories: 0,
      segments: 0,
      skipped_existing: 0,
      unlinked_segments: 0,
      embedded,
      redacted_secrets: redacted.count,
    };
    const memoryExists = this.db.prepare(`SELECT 1 FROM memories WHERE id = ?`);
    const segmentExists = this.db.prepare(`SELECT 1 FROM segments WHERE id = ?`);
    const segmentInNamespace = this.db.prepare(`SELECT 1 FROM segments WHERE id = ? AND namespace = ?`);
    // With the content hash an ingest finds a segment by (storage/queries.ts), as the
    // memory server writes it.
    const insertSegment = this.db.prepare(
      `INSERT INTO segments (id, namespace, content, source, mode, created_at, fact_count, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertMemory = this.db.prepare(
      `INSERT INTO memories (id, namespace, content, tags, importance, created_at, updated_at,
         last_accessed_at, access_count, is_compacted, source, metadata, consolidated, segment_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertVector = this.db.prepare(`INSERT INTO vec_memories (memory_id, embedding) VALUES (?, ?)`);
    // IMMEDIATE, like the approvals: the existence checks run under the write lock.
    const write = this.db.transaction(() => {
      for (const segment of segments) {
        if (segmentExists.get(segment.id) !== undefined) {
          outcome.skipped_existing += 1;
          continue;
        }
        insertSegment.run(
          segment.id,
          this.namespace,
          segment.content,
          segment.source,
          segment.mode,
          segment.createdAt,
          segment.factCount,
          segmentContentHash(segment.content, segment.source, segment.mode),
        );
        outcome.segments += 1;
      }
      for (const memory of memories) {
        if (memoryExists.get(memory.id) !== undefined) {
          outcome.skipped_existing += 1;
          continue;
        }
        let segmentId = memory.segmentId;
        if (segmentId !== null && segmentInNamespace.get(segmentId, this.namespace) === undefined) {
          segmentId = null;
          outcome.unlinked_segments += 1;
        }
        insertMemory.run(
          memory.id,
          this.namespace,
          memory.content,
          memory.tags.length > 0 ? JSON.stringify(memory.tags) : null,
          memory.importance,
          memory.createdAt,
          memory.updatedAt,
          memory.lastAccessedAt,
          memory.accessCount,
          memory.isCompacted ? 1 : 0,
          memory.source,
          memory.metadata === null ? null : JSON.stringify(memory.metadata),
          memory.consolidated ? 1 : 0,
          segmentId,
        );
        const vector = vectors.get(memory.id);
        if (vector !== undefined) insertVector.run(memory.id, vectorBlob(vector));
        outcome.memories += 1;
      }
    });
    write.immediate();
    return outcome;
  }
}

/** The embedding model of a database and the size of its vectors. */
interface ImportEmbedding {
  model: string;
  dimensions: number;
}

/**
 * The memory server's embedder for `embedding.model`, loaded from `modelStore` (verified
 * and pinned, as for a memory server) the first time a memory needs it. It refuses
 * vectors of another size than the database's (embedding/embedder.ts).
 */
function defaultEmbedder(
  embedding: ImportEmbedding,
  modelStore: ImportOptions['modelStore'],
): (text: string) => Promise<Float32Array> {
  const config = {
    ...loadConfig({}),
    embeddingModel: embedding.model,
    embeddingDimensions: embedding.dimensions,
    ...(modelStore === undefined ? {} : { modelsDir: modelStore.modelsDir, modelsOffline: modelStore.offline }),
  };
  return async (text: string) => {
    const { embed } = await import('./embedding/embedder.js');
    return embed(text, config);
  };
}
