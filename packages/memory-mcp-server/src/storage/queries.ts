import type Database from 'better-sqlite3';
import type { MemoryRow, SegmentRow, VectorSearchResult, FtsSearchResult } from './database.js';
import type { MemoryWriter } from '../types.js';
import { withWriter } from '../utils/provenance.js';
import { normalizeFactText } from '../utils/fact-text.js';
import {
  type ReadScope,
  pendingSql,
  reviewGroupSql,
  sameReviewGroupSql,
  visibleParams,
  visibleSql,
} from '../utils/review.js';
import { segmentContentHash } from '../utils/content-hash.js';
import { randomBytes } from 'node:crypto';

/**
 * The review filter of a read query (utils/review.ts): with a `scope`, only the rows
 * that scope may see; without one, every row (maintenance and the host's admin API).
 * Every query an agent's tool call reaches passes the reader's scope.
 */
function visibility(alias: string, scope: ReadScope | undefined): { sql: string; params: Array<string | null> } {
  return scope === undefined
    ? { sql: '', params: [] }
    : { sql: ` AND ${visibleSql(alias)}`, params: visibleParams(scope) };
}

export function generateId(): string {
  return randomBytes(16).toString('hex');
}

/** A vector as the blob sqlite-vec reads. */
function vectorBlob(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

// Query plans. The databases have no ANALYZE statistics, and without them SQLite reads a
// condition like `namespace = ?` through a namespace index even when the statement
// also names a few ids: it then visits every memory of the namespace. The statements
// below that look up a handful of ids or segments therefore join from the id list
// (`json_each(?) j CROSS JOIN memories m`, which fixes the join order) or write the
// namespace condition as `+namespace = ?`: the unary `+` keeps SQLite from using an index
// for that condition, so it uses the id or segment index instead.

/**
 * SQL condition under which the memory aliased `alias` is LIVE. Maintenance marks a
 * memory decayed (importance 0) or compacted (is_compacted 1) and keeps the row, for
 * compaction and memory_inspect; recall, store-time dedup, consolidation's pairing and
 * source expansion only ever see live memories. Importance 0 means decayed and nothing
 * else: the write path never stores a new memory with importance 0 (engine-impl.ts).
 */
function liveMemoryCondition(alias: string): string {
  return `${alias}.importance > 0 AND ${alias}.is_compacted = 0`;
}

/**
 * SQL conditions, one per tag, under which the memory aliased `alias` carries ALL of
 * `tags`, and the parameters they bind. One EXISTS per tag holds even when a row repeats
 * a tag (a COUNT over json_each would let a repeated tag stand in for a missing one).
 * As in parseTags, only the string elements of a JSON array are tags: a tags column that
 * is NULL, not valid JSON or not an array carries none (and never fails the query).
 */
function allTagsConditions(alias: string, tags: readonly string[]): { clauses: string[]; params: string[] } {
  const clause =
    `CASE WHEN json_valid(${alias}.tags) THEN ` +
    `CASE WHEN json_type(${alias}.tags) = 'array' THEN ` +
    `EXISTS (SELECT 1 FROM json_each(${alias}.tags) je WHERE je.type = 'text' AND je.value = ?) ` +
    `ELSE 0 END ELSE 0 END`;
  return { clauses: tags.map(() => clause), params: [...tags] };
}

// ---------- Insert ----------

export interface InsertMemoryParams {
  id: string;
  namespace: string;
  content: string;
  tags: string[] | undefined;
  importance: number;
  source?: string;
  metadata?: Record<string, unknown>;
  consolidated?: boolean;
  /**
   * Epoch ms backdate. When present, stamps created_at/updated_at/last_accessed_at
   * to this value (the `as_of` mechanism). Absent ⇒ Date.now() (unchanged behavior).
   */
  createdAt?: number;
  /**
   * FK to the source segment (`memory_ingest` only). Absent ⇒ bound as NULL,
   * exactly as the store path / degrade path require (a row with no parent).
   */
  segmentId?: string;
}

export function insertMemory(db: Database.Database, params: InsertMemoryParams, embedding: Float32Array): void {
  const now = params.createdAt ?? Date.now();
  const txn = db.transaction(() => {
    db.prepare(
      `INSERT INTO memories (id, namespace, content, tags, importance,
         created_at, updated_at, last_accessed_at, source, metadata, consolidated, segment_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      params.id,
      params.namespace,
      params.content,
      params.tags ? JSON.stringify(params.tags) : null,
      params.importance,
      now,
      now,
      now,
      params.source ?? null,
      params.metadata ? JSON.stringify(params.metadata) : null,
      params.consolidated === false ? 0 : 1,
      params.segmentId ?? null,
    );

    db.prepare(`INSERT INTO vec_memories (memory_id, embedding) VALUES (?, ?)`).run(params.id, vectorBlob(embedding));
  });
  txn();
}

// ---------- Segments ----------
//
// A segment holds the raw source chunk `memory_ingest` extracted facts from. It lives
// only as long as a LIVE memory references it:
//   - an ingest writes a segment when its first fact links to it (materializeSegment),
//     so an ingest whose facts all merged into memories that keep their own parents
//     leaves nothing behind;
//   - forgetting a memory deletes the segments it came from, even when other memories
//     still reference them (purgeSegments): a chunk holds the forgotten fact's text,
//     which cannot be cut out of it. A memory links to one segment (`segment_id`), but
//     the same fact can be extracted from several chunks (re-ingesting an edited
//     document, two documents stating it) and merged into one memory; the other chunks
//     are recorded in its `metadata.source_segments` (addSourceSegments) and deleted
//     with it too;
//   - a segment no live memory references any more (its facts were merged away,
//     decayed or compacted) is deleted by the same ingest or merge that released it,
//     or by the maintenance sweep (deleteSegmentsWithoutLiveFacts);
//   - until then, recall expansion and memory_expand treat it as gone
//     (getLiveSegmentsByIds).
// A chunk's row is found again by its content hash (segmentContentHash over the text, the
// ingest's source label and its mode): an ingest that is retried, or the same document
// ingested again, links its facts to the row that is already there instead of writing a
// second copy of the chunk. Only within one review group (utils/review.ts): a row that
// memories of another group link to is never reused (findSegmentByContent).
// `memories.segment_id` references `segments.id` without an ON DELETE action, so the
// memories that still point at a segment are unlinked before it is deleted.

export interface InsertSegmentParams {
  id?: string;
  namespace: string;
  content: string;
  source?: string;
  mode?: string;
  createdAt?: number;
  factCount: number;
}

/**
 * Insert one source segment and return its id. Mirrors `insertMemory`'s shape
 * (`createdAt ?? Date.now()`). Segments are off the retrieval index — no vec/FTS write.
 */
export function insertSegment(db: Database.Database, params: InsertSegmentParams): string {
  const id = params.id ?? generateId();
  const now = params.createdAt ?? Date.now();
  db.prepare(
    `INSERT INTO segments (id, namespace, content, source, mode, created_at, fact_count, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    params.namespace,
    params.content,
    params.source ?? null,
    params.mode ?? null,
    now,
    params.factCount,
    segmentContentHash(params.content, params.source, params.mode),
  );
  return id;
}

/**
 * The oldest segment of `namespace` with this content, source and mode (see
 * segmentContentHash) that memories of `reviewGroup` link to, and memories of no other
 * review group (utils/review.ts: '' for reviewed memories, the writer's scope for those
 * waiting for review), or undefined.
 *
 * Review groups stay apart, as they do for store dedup and consolidation. Linking one
 * group's facts to a segment another group's memories use would let that group's review
 * reject or forget purge the other's source (forgetMemoryRows deletes the segments of
 * what it deletes), and an ingest's `segments_created` would tell its caller that a
 * source it may not read holds the same text. A segment no memory links to any more
 * (it waits for the maintenance sweep) is not reused either.
 */
export function findSegmentByContent(
  db: Database.Database,
  namespace: string,
  content: string,
  source: string | undefined,
  mode: string | undefined,
  reviewGroup: string,
): string | undefined {
  const group = reviewGroupSql('m');
  const row = db
    .prepare(
      `SELECT s.id FROM segments s
        WHERE s.namespace = ? AND s.content_hash = ? AND s.content = ?
          AND EXISTS (SELECT 1 FROM memories m
                       WHERE m.segment_id = s.id AND +m.namespace = s.namespace AND ${group} = ?)
          AND NOT EXISTS (SELECT 1 FROM memories m WHERE m.segment_id = s.id AND ${group} <> ?)
        ORDER BY s.created_at, s.id LIMIT 1`,
    )
    .get(namespace, segmentContentHash(content, source, mode), content, reviewGroup, reviewGroup) as
    { id: string } | undefined;
  return row?.id;
}

/**
 * A source segment of an ingest whose row is written only when the first fact links to
 * it (materializeSegment), in the same synchronous step as that link. A segment row
 * therefore never exists without a live memory pointing at it, so the maintenance sweep
 * cannot remove a segment an ingest is still filling.
 */
export interface PendingSegment {
  /**
   * The row's id: generated for a new row, replaced by the id of an existing row with
   * the same content (materializeSegment) when the ingest reuses that one.
   */
  id: string;
  readonly namespace: string;
  readonly content: string;
  readonly source?: string;
  readonly mode?: string;
  readonly createdAt?: number;
  readonly factCount: number;
  /**
   * The review group of the facts that link to this chunk: '' for a reviewed writer, the
   * scope of an unattended one (utils/review.ts). materializeSegment reuses an existing
   * row only when memories of this group alone link to it (findSegmentByContent).
   */
  readonly reviewGroup: string;
  /**
   * Set once materializeSegment has written the row (or found an existing one), or has
   * refused to write it (see there). Either way the row is never written after that.
   */
  written: boolean;
  /** True when materializeSegment linked this chunk to a row an earlier ingest wrote. */
  reused?: boolean;
  /**
   * Memories that a fact of this chunk was merged into, before the row was written, and
   * that kept their own parent (adoptRicherPendingSegment). The chunk states their text
   * too, so the row, once written, is recorded among their source segments.
   */
  readonly sharedWith: string[];
}

/**
 * The id to link a fact of `segment` to, writing the segment's row on first use (or,
 * when a row with the same content, source and mode already exists in the namespace and
 * only memories of the segment's review group link to it, an earlier ingest of the same
 * text wrote it, and that row is used instead; see findSegmentByContent). Returns null
 * when the row must not be written (any more):
 *   - it was written before and is gone now: a forget purged it, or its facts were all
 *     merged away or decayed and it was swept. A source a forget removed must not come
 *     back through a later fact of the same ingest;
 *   - a memory in `sharedWith` no longer exists: the chunk states that memory's text,
 *     and a forget may have removed it while this ingest went on (or a merge folded it
 *     into a memory this chunk is not recorded on).
 * The fact is then stored without a source. When the row is written (or found), it is
 * recorded among the source segments of the memories in `sharedWith`, in the same
 * transaction.
 */
export function materializeSegment(db: Database.Database, segment: PendingSegment): string | null {
  const txn = db.transaction((): string | null => {
    if (db.prepare(`SELECT 1 FROM segments WHERE id = ?`).get(segment.id) !== undefined) return segment.id;
    if (segment.written) return null;
    const sharers = [...new Set(segment.sharedWith)];
    if (sharers.length > 0) {
      const { n } = db
        .prepare(
          `SELECT COUNT(*) AS n FROM json_each(?) j CROSS JOIN memories m ON m.id = j.value WHERE m.namespace = ?`,
        )
        .get(JSON.stringify(sharers), segment.namespace) as { n: number };
      if (n < sharers.length) {
        segment.written = true;
        return null;
      }
    }
    const existing = findSegmentByContent(
      db,
      segment.namespace,
      segment.content,
      segment.source,
      segment.mode,
      segment.reviewGroup,
    );
    if (existing === undefined) {
      insertSegment(db, {
        id: segment.id,
        namespace: segment.namespace,
        content: segment.content,
        source: segment.source,
        mode: segment.mode,
        createdAt: segment.createdAt,
        factCount: segment.factCount,
      });
    } else {
      segment.id = existing;
      segment.reused = true;
    }
    segment.written = true;
    for (const memoryId of sharers) addSourceSegments(db, segment.namespace, memoryId, [segment.id]);
    return segment.id;
  });
  return txn();
}

/** A row's `metadata` as an object; null for none, unparseable JSON or a non-object. */
function parseMetadataObject(metadata: string | null): Record<string, unknown> | null {
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

/** The segment ids in `metadata.source_segments` (a JSON array of strings; anything else holds none). */
export function readSourceSegments(metadata: string | null): string[] {
  const value = parseMetadataObject(metadata)?.source_segments;
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}

/**
 * Record in `metadata.source_segments` that segments other than the memory's own
 * `segment_id` hold a text it states, or once stated (its superseded history): the
 * chunks of other ingests whose fact was merged into it. Forgetting the memory deletes
 * them as well (forgetMemoryRows). The list keeps only segments that still exist and are
 * not the memory's `segment_id`, so it never grows past the memory's live sources.
 */
export function addSourceSegments(
  db: Database.Database,
  namespace: string,
  memoryId: string,
  segmentIds: ReadonlyArray<string | null>,
): void {
  const txn = db.transaction(() => {
    const row = db
      .prepare(`SELECT segment_id, metadata FROM memories WHERE id = ? AND namespace = ?`)
      .get(memoryId, namespace) as { segment_id: string | null; metadata: string | null } | undefined;
    if (!row) return;
    const recorded = readSourceSegments(row.metadata);
    const wanted = [...new Set([...recorded, ...segmentIds])].filter(
      (id): id is string => id !== null && id !== row.segment_id,
    );
    const existing = new Set(
      wanted.length === 0
        ? []
        : (
            db
              .prepare(`SELECT s.id FROM json_each(?) j CROSS JOIN segments s ON s.id = j.value WHERE s.namespace = ?`)
              .all(JSON.stringify(wanted), namespace) as Array<{ id: string }>
          ).map((s) => s.id),
    );
    const kept = wanted.filter((id) => existing.has(id));
    if (kept.length === recorded.length && kept.every((id, i) => id === recorded[i])) return;
    // Unparseable metadata cannot be extended; it is replaced (as appendSupersededHistory does).
    const metadata = parseMetadataObject(row.metadata) ?? {};
    if (kept.length === 0) {
      delete metadata.source_segments;
    } else {
      metadata.source_segments = kept;
    }
    db.prepare(`UPDATE memories SET metadata = ? WHERE id = ? AND namespace = ?`).run(
      Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null,
      memoryId,
      namespace,
    );
  });
  txn();
}

/** Every segment a memory row came from: its `segment_id` and its recorded source segments. */
export function sourceSegmentsOf(row: { segment_id: string | null; metadata: string | null }): string[] {
  return [...(row.segment_id === null ? [] : [row.segment_id]), ...readSourceSegments(row.metadata)];
}

/** Batch fetch segments by primary key, whether or not a live memory still references them. */
export function getSegmentsByIds(db: Database.Database, namespace: string, ids: string[]): SegmentRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db
    .prepare(`SELECT * FROM segments WHERE namespace = ? AND id IN (${placeholders})`)
    .all(namespace, ...ids) as SegmentRow[];
}

/**
 * Batch fetch the segments among `ids` that a LIVE memory of `namespace` still
 * references: what recall expansion and memory_expand may show. A segment whose facts
 * were all forgotten, merged away, decayed or compacted is treated as gone, even before
 * the maintenance sweep deletes it.
 *
 * With a `scope`, that live memory must also be one the reader may see (see
 * {@link visibility}): a segment has no review marker of its own, so the source of
 * memories that wait for review is hidden with them (utils/review.ts).
 */
export function getLiveSegmentsByIds(
  db: Database.Database,
  namespace: string,
  ids: string[],
  scope?: ReadScope,
): SegmentRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const visible = visibility('m', scope);
  return db
    .prepare(
      `SELECT s.* FROM segments s
        WHERE s.namespace = ? AND s.id IN (${placeholders})
          AND EXISTS (SELECT 1 FROM memories m
                       WHERE m.segment_id = s.id AND +m.namespace = s.namespace AND ${liveMemoryCondition('m')}${visible.sql})`,
    )
    .all(namespace, ...ids, ...visible.params) as SegmentRow[];
}

/**
 * Whether a merged survivor should take `incomingSegmentId` (with `incomingFactCount`
 * facts) as its parent (A4, §6.2), so a later, richer ingest of the same fact is not
 * discarded purely by ingest order:
 *   - survivor has no parent (NULL)  → adopt the incoming segment;
 *   - else keep whichever segment has the higher `fact_count`; a tie keeps the
 *     existing (stable, order-independent given equal richness).
 */
function prefersIncomingSegment(
  db: Database.Database,
  namespace: string,
  survivorId: string,
  incomingSegmentId: string,
  incomingFactCount: number,
): boolean {
  const row = db
    .prepare(`SELECT segment_id FROM memories WHERE id = ? AND namespace = ?`)
    .get(survivorId, namespace) as { segment_id: string | null } | undefined;
  if (!row) return false;
  if (row.segment_id === null) return true;
  if (row.segment_id === incomingSegmentId) return false;
  const existing = db.prepare(`SELECT fact_count FROM segments WHERE id = ?`).get(row.segment_id) as
    { fact_count: number } | undefined;
  return incomingFactCount > (existing?.fact_count ?? 0);
}

/** Point a memory at `segmentId`; returns the segment it pointed at before (null when none). */
function setMemorySegment(
  db: Database.Database,
  namespace: string,
  memoryId: string,
  segmentId: string,
): string | null {
  const row = db.prepare(`SELECT segment_id FROM memories WHERE id = ? AND namespace = ?`).get(memoryId, namespace) as
    { segment_id: string | null } | undefined;
  if (!row || row.segment_id === segmentId) return null;
  db.prepare(`UPDATE memories SET segment_id = ? WHERE id = ? AND namespace = ?`).run(segmentId, memoryId, namespace);
  return row.segment_id;
}

/**
 * Repoint a merged survivor's `segment_id` to the RICHER parent (consolidation's
 * duplicate merge; see prefersIncomingSegment). `incomingSegmentId` is the parent of the
 * memory merged into the survivor, so its row exists. Consolidation records the segment
 * the survivor does not link to among its source segments (addSourceSegments); one no
 * live memory references is collected by the maintenance sweep that runs after it.
 */
export function updateMemorySegmentIfRicher(
  db: Database.Database,
  namespace: string,
  survivorId: string,
  incomingSegmentId: string,
): void {
  const incoming = db
    .prepare(`SELECT fact_count FROM segments WHERE id = ? AND namespace = ?`)
    .get(incomingSegmentId, namespace) as { fact_count: number } | undefined;
  if (incoming === undefined) return;
  if (prefersIncomingSegment(db, namespace, survivorId, incomingSegmentId, incoming.fact_count)) {
    setMemorySegment(db, namespace, survivorId, incomingSegmentId);
  }
}

/**
 * The ingest merge (A4): a new fact merged into an existing memory. The fact's chunk
 * states the memory's text, so it becomes one of the memory's sources either way:
 *   - when it is the richer parent (see prefersIncomingSegment), the memory points at it
 *     (writing it on first use). The parent the memory leaves is deleted when no live
 *     memory references it any more, and otherwise recorded among the memory's source
 *     segments: it states the memory's text too;
 *   - otherwise the memory keeps its parent and the chunk is recorded among its source
 *     segments: now if the chunk's row exists, or when it is written (`sharedWith`).
 */
export function adoptRicherPendingSegment(
  db: Database.Database,
  namespace: string,
  survivorId: string,
  segment: PendingSegment,
): void {
  const txn = db.transaction(() => {
    const row = db
      .prepare(`SELECT segment_id FROM memories WHERE id = ? AND namespace = ?`)
      .get(survivorId, namespace) as { segment_id: string | null } | undefined;
    if (!row || row.segment_id === segment.id) return;
    if (prefersIncomingSegment(db, namespace, survivorId, segment.id, segment.factCount)) {
      const segmentId = materializeSegment(db, segment);
      if (segmentId === null) return;
      const previous = setMemorySegment(db, namespace, survivorId, segmentId);
      if (previous === null) return;
      deleteSegmentsWithoutLiveFacts(db, namespace, [previous]);
      addSourceSegments(db, namespace, survivorId, [previous]);
      return;
    }
    if (segment.written) {
      addSourceSegments(db, namespace, survivorId, [segment.id]);
    } else {
      segment.sharedWith.push(survivorId);
    }
  });
  txn();
}

/**
 * Delete the segments `segmentIds` of `namespace`, first unlinking every memory of the
 * namespace that still points at one of them (forget; see the section comment above).
 * Returns the number of segments deleted. A segment that a memory of another namespace
 * references (which no API creates) is left in place rather than failing the delete.
 */
export function purgeSegments(db: Database.Database, namespace: string, segmentIds: readonly string[]): number {
  const unique = [...new Set(segmentIds)];
  if (unique.length === 0) return 0;
  const txn = db.transaction((): number => {
    const ids = JSON.stringify(unique);
    db.prepare(
      `UPDATE memories SET segment_id = NULL
        WHERE segment_id IN (SELECT value FROM json_each(?)) AND +namespace = ?`,
    ).run(ids, namespace);
    return db
      .prepare(
        `DELETE FROM segments
          WHERE id IN (SELECT value FROM json_each(?)) AND +namespace = ?
            AND NOT EXISTS (SELECT 1 FROM memories m WHERE m.segment_id = segments.id)`,
      )
      .run(ids, namespace).changes;
  });
  return txn();
}

/**
 * Delete the segments of `namespace` that no LIVE memory references (all of them, or
 * only those among `segmentIds`): their facts were forgotten, merged away, decayed or
 * compacted. Decayed and compacted memories that still point at such a segment are
 * unlinked first. A segment that any live memory references is never touched. Returns
 * the number of segments deleted.
 */
export function deleteSegmentsWithoutLiveFacts(
  db: Database.Database,
  namespace: string,
  segmentIds?: readonly string[],
): number {
  if (segmentIds?.length === 0) return 0;
  const scope =
    segmentIds === undefined
      ? { where: 's.namespace = ?', params: [namespace] }
      : {
          where: 's.id IN (SELECT value FROM json_each(?)) AND +s.namespace = ?',
          params: [JSON.stringify([...new Set(segmentIds)]), namespace],
        };
  const txn = db.transaction((): number => {
    const dead = db
      .prepare(
        `SELECT s.id FROM segments s
          WHERE ${scope.where}
            AND NOT EXISTS (SELECT 1 FROM memories m WHERE m.segment_id = s.id AND ${liveMemoryCondition('m')})`,
      )
      .all(...scope.params) as Array<{ id: string }>;
    return purgeSegments(
      db,
      namespace,
      dead.map((s) => s.id),
    );
  });
  return txn();
}

// ---------- Update ----------

/** One text a memory used to hold, kept in `metadata.superseded`. */
export interface SupersededEntry {
  content: string;
  /** Epoch ms when the text was superseded. */
  at: number;
  /** Who wrote the superseded text, when that was recorded. */
  writer?: MemoryWriter;
}

/** How many superseded texts a memory keeps (oldest dropped first). */
export const MAX_SUPERSEDED_HISTORY = 5;

function isSupersededEntry(value: unknown): value is SupersededEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.content === 'string' && typeof entry.at === 'number';
}

/**
 * Return `metadata` (a JSON object string, or null) with `entry` appended to its
 * bounded `superseded` history: a chronological array of at most
 * MAX_SUPERSEDED_HISTORY entries. The single `{content, at}` object that older
 * versions stored there is kept as the first entry; other metadata keys are kept.
 */
export function appendSupersededHistory(metadata: string | null, entry: SupersededEntry): string {
  let parsed: Record<string, unknown> = {};
  if (metadata) {
    try {
      const value: unknown = JSON.parse(metadata);
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>;
      }
    } catch {
      // Unparseable metadata cannot be extended; it is replaced.
    }
  }
  const prior = parsed.superseded;
  const history = Array.isArray(prior) ? prior.filter(isSupersededEntry) : isSupersededEntry(prior) ? [prior] : [];
  parsed.superseded = [...history, entry].slice(-MAX_SUPERSEDED_HISTORY);
  return JSON.stringify(parsed);
}

export interface MergeMemoryParams {
  /** The complete tag list to store (the caller unions the old and new tags). */
  tags: string[];
  /** Merged as MAX(importance, ?): a merge never lowers importance. */
  importance: number;
  /** Adopted only when the row has no source yet. */
  source?: string | null;
  /** Lowers created_at to this value when it is earlier (true first-seen). */
  createdAt?: number;
  /** Raises last_accessed_at to this value when it is later. */
  lastAccessedAt?: number;
  /** A text to append to the bounded superseded history; the content itself is kept. */
  supersededContent?: string;
  /** Who wrote `supersededContent`, recorded with it in the history. */
  supersededWriter?: MemoryWriter;
}

/**
 * Merge another memory's metadata into an existing row WITHOUT changing its text or
 * vector: the store-time merge of an identical fact and consolidation's duplicate
 * path. Returns false when the row no longer exists.
 */
export function mergeMemoryMetadata(
  db: Database.Database,
  namespace: string,
  id: string,
  params: MergeMemoryParams,
): boolean {
  const now = Date.now();
  const txn = db.transaction((): boolean => {
    const row = db.prepare(`SELECT metadata FROM memories WHERE id = ? AND namespace = ?`).get(id, namespace) as
      { metadata: string | null } | undefined;
    if (!row) return false;
    const metadata =
      params.supersededContent === undefined
        ? row.metadata
        : appendSupersededHistory(row.metadata, {
            content: params.supersededContent,
            at: now,
            ...(params.supersededWriter === undefined ? {} : { writer: params.supersededWriter }),
          });
    const result = db
      .prepare(
        `UPDATE memories
            SET updated_at = ?,
                tags = ?,
                importance = MAX(importance, ?),
                source = COALESCE(source, ?),
                created_at = MIN(created_at, COALESCE(?, created_at)),
                last_accessed_at = MAX(last_accessed_at, COALESCE(?, last_accessed_at)),
                metadata = ?
          WHERE id = ? AND namespace = ?`,
      )
      .run(
        now,
        JSON.stringify(params.tags),
        params.importance,
        params.source ?? null,
        params.createdAt ?? null,
        params.lastAccessedAt ?? null,
        metadata,
        id,
        namespace,
      );
    return result.changes > 0;
  });
  return txn();
}

/**
 * Replace a memory's text and vector (consolidation's contradiction path: a newer fact
 * supersedes the row's current one). `supersededContent` (the text being replaced)
 * is appended to the bounded `metadata.superseded` history, with `supersededWriter`
 * (who wrote it) when known. Returns false when the row no longer exists.
 */
export function updateMemoryContent(
  db: Database.Database,
  namespace: string,
  id: string,
  content: string,
  embedding: Float32Array,
  importance: number,
  supersededContent: string,
  mergedTags?: string[],
  supersededWriter?: MemoryWriter,
): boolean {
  const now = Date.now();
  const txn = db.transaction((): boolean => {
    const row = db.prepare(`SELECT metadata FROM memories WHERE id = ? AND namespace = ?`).get(id, namespace) as
      { metadata: string | null } | undefined;
    if (!row) return false;
    const metadata = appendSupersededHistory(row.metadata, {
      content: supersededContent,
      at: now,
      ...(supersededWriter === undefined ? {} : { writer: supersededWriter }),
    });
    db.prepare(
      `UPDATE memories
          SET content = ?, updated_at = ?, tags = COALESCE(?, tags),
              importance = MAX(importance, ?), metadata = ?
        WHERE id = ? AND namespace = ?`,
    ).run(
      content,
      now,
      mergedTags === undefined ? null : JSON.stringify(mergedTags),
      importance,
      metadata,
      id,
      namespace,
    );

    db.prepare(
      `UPDATE vec_memories SET embedding = ?
       WHERE memory_id = ? AND memory_id IN (SELECT id FROM memories WHERE namespace = ?)`,
    ).run(Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength), id, namespace);
    return true;
  });
  return txn();
}

/** Where the fact a memory holds came from, and when it was first seen. */
export interface MemoryProvenance {
  source: string | null;
  segmentId: string | null;
  /** First-seen time (epoch ms) of the fact the memory now holds. */
  createdAt: number;
  /** Raises last_accessed_at to this value when it is later. */
  lastAccessedAt: number;
  /** Who wrote the fact the memory now holds (`metadata.writer`); undefined removes it. */
  writer: MemoryWriter | undefined;
}

/**
 * Point a memory's provenance at the fact it now holds: after a contradiction replaced
 * its text, the old source, source segment and first-seen time (`created_at`) describe
 * the superseded text, not the current one. Keeping the old `created_at` would make the
 * new fact look as old as the one it replaced, so a later consolidation pass would let
 * an older, backdated contradiction replace it, and recency and decay would age it
 * from the wrong time. The writer moves with the text too: a row whose text a later
 * session replaced must not keep naming the earlier session as its author.
 */
export function setMemoryProvenance(
  db: Database.Database,
  namespace: string,
  id: string,
  provenance: MemoryProvenance,
): void {
  const txn = db.transaction(() => {
    const row = db.prepare(`SELECT metadata FROM memories WHERE id = ? AND namespace = ?`).get(id, namespace) as
      { metadata: string | null } | undefined;
    if (!row) return;
    db.prepare(
      `UPDATE memories
          SET source = ?, segment_id = ?, created_at = ?,
              last_accessed_at = MAX(last_accessed_at, ?), metadata = ?
        WHERE id = ? AND namespace = ?`,
    ).run(
      provenance.source,
      provenance.segmentId,
      provenance.createdAt,
      provenance.lastAccessedAt,
      withWriter(row.metadata, provenance.writer),
      id,
      namespace,
    );
  });
  txn();
}

/**
 * Reconcile a merged row's timestamps order-independently against a backdated
 * `as_of` (A1). Additive — does NOT touch `updateMemoryContent`, which is shared
 * with the consolidation contradiction path.
 *
 *   created_at       = MIN(created_at, asOf)   // true first-seen
 *   last_accessed_at = MAX(last_accessed_at, asOf)
 *   updated_at       = MAX(updated_at, asOf)
 *
 * Computed in SQL so the merge is atomic and order-independent regardless of
 * which insert wins the race.
 */
export function updateMemoryTimestampsOnMerge(
  db: Database.Database,
  namespace: string,
  id: string,
  asOf: number,
): void {
  db.prepare(
    `UPDATE memories
        SET created_at       = MIN(created_at, ?),
            last_accessed_at = MAX(last_accessed_at, ?),
            updated_at       = MAX(updated_at, ?)
      WHERE id = ? AND namespace = ?`,
  ).run(asOf, asOf, asOf, id, namespace);
}

export function updateAccessStats(db: Database.Database, namespace: string, ids: string[]): void {
  if (ids.length === 0) return;
  const now = Date.now();
  const stmt = db.prepare(
    `UPDATE memories
     SET last_accessed_at = ?, access_count = access_count + 1
     WHERE id = ? AND namespace = ?`,
  );
  const txn = db.transaction(() => {
    for (const id of ids) {
      stmt.run(now, id, namespace);
    }
  });
  txn();
}

// ---------- Search ----------

/** The largest k one sqlite-vec KNN query accepts. */
const KNN_MAX_K = 4096;

/** How much a KNN query widens when too few of its neighbours pass the filter. */
const KNN_GROWTH = 4;

/** Options of the candidate searches. */
export interface SearchOptions {
  /** Only memories carrying ALL of these tags (absent or empty: no constraint). */
  tags?: readonly string[];
  /**
   * Only the memories this reader may see (see {@link visibility}): reviewed ones, and
   * those waiting for review under its own scope. Absent: every memory (maintenance,
   * the host's admin API). Every search an agent's tool call reaches passes it.
   */
  scope?: ReadScope;
  /**
   * Only the memories of this review group (utils/review.ts `reviewGroupOf`). The
   * store-time merge and consolidation's pairing pass '' (reviewed memories): they
   * never merge into, or change, a memory that waits for review.
   */
  reviewGroup?: string;
}

/** A filter of a search query over alias `m`: SQL conditions and the parameters they bind, in order. */
interface SearchFilter {
  conditions: string[];
  params: Array<string | null>;
}

/**
 * The filter of a candidate search: live memories only, then `options`' tags, reader
 * scope and review group. Every condition applies before the search's limit.
 */
function searchFilter(options: SearchOptions): SearchFilter {
  const conditions = [liveMemoryCondition('m')];
  const params: Array<string | null> = [];
  const tags = options.tags ?? [];
  if (tags.length > 0) {
    const tagged = allTagsConditions('m', tags);
    conditions.push(...tagged.clauses);
    params.push(...tagged.params);
  }
  if (options.scope !== undefined) {
    conditions.push(visibleSql('m'));
    params.push(...visibleParams(options.scope));
  }
  if (options.reviewGroup !== undefined) {
    conditions.push(sameReviewGroupSql('m'));
    params.push(options.reviewGroup);
  }
  return { conditions, params };
}

/**
 * The `limit` LIVE memories of `namespace` nearest to `embedding`, closest first, with
 * their cosine distance: recall's vector candidates and store-time dedup.
 *
 * Without tags this is a sqlite-vec KNN query (nearestByKnn). With tags it is an exact
 * scan of the memories that carry them, the tags applied before the limit: a recall
 * scoped to a tag must find a tagged memory however many untagged memories lie closer
 * (MEM-18), and a KNN chooses its neighbours among all vectors before any filter. The
 * reader scope and the review group (`options`) are applied before the limit as well.
 */
export function vectorSearch(
  db: Database.Database,
  namespace: string,
  embedding: Float32Array,
  limit: number,
  options: SearchOptions = {},
): VectorSearchResult[] {
  const { conditions, params } = searchFilter(options);
  if ((options.tags ?? []).length > 0) {
    return nearestByScan(db, namespace, embedding, limit, conditions, params);
  }
  return nearestByKnn(db, namespace, embedding, limit, conditions, params);
}

/**
 * The nearest neighbours among CONSOLIDATED, live, REVIEWED memories: consolidation's
 * external pairing. The filter is applied before the limit (nearestByKnn widens its
 * KNN until enough neighbours pass), so unconsolidated rows (the batch being
 * consolidated, including the query row itself) cannot crowd an older consolidated
 * fact out of the top `limit`. A memory that waits for review is never a candidate:
 * consolidation leaves pending memories as they are until they are approved
 * (consolidation.ts isReviewed, utils/review.ts); that filter, too, applies before the
 * limit.
 */
export function vectorSearchConsolidated(
  db: Database.Database,
  namespace: string,
  embedding: Float32Array,
  limit: number,
): VectorSearchResult[] {
  const { conditions, params } = searchFilter({ reviewGroup: '' });
  return nearestByKnn(db, namespace, embedding, limit, [...conditions, 'm.consolidated = 1'], params);
}

/**
 * The `limit` memories of `namespace` that satisfy `conditions` (over alias `m`, with
 * `params`), nearest to `embedding` first, found with a sqlite-vec KNN query
 * (`embedding MATCH ? AND k = ?`). The KNN compares the query with every stored vector
 * but neither joins nor sorts the whole table, which made it 12-15x faster than
 * computing vec_distance_cosine for every row through a join (MEM-17).
 *
 * vec0 measures L2 distance. Stored embeddings are L2-normalized (the embedder passes
 * normalize: true), and for unit vectors L2^2 = 2 - 2 cos, so the L2 order is the cosine
 * order and the cosine distance is L2^2 / 2: callers' thresholds keep their meaning.
 *
 * vec_memories holds the vectors of every namespace (and nothing else), so the KNN picks
 * its k neighbours before the namespace and `conditions` apply. When fewer than `limit`
 * of them pass, the KNN is repeated with a larger k until enough pass or it has returned
 * every vector. That keeps the result exact: a matching memory outside the k nearest
 * vectors is farther away than all of them. Past KNN_MAX_K it falls back to the exact
 * scan.
 */
function nearestByKnn(
  db: Database.Database,
  namespace: string,
  embedding: Float32Array,
  limit: number,
  conditions: readonly string[],
  params: ReadonlyArray<string | number | null>,
): VectorSearchResult[] {
  if (limit <= 0) return [];
  if (limit > KNN_MAX_K) return nearestByScan(db, namespace, embedding, limit, conditions, params);

  const query = vectorBlob(embedding);
  const knn = db.prepare(`SELECT memory_id, distance FROM vec_memories WHERE embedding MATCH ? AND k = ?`);
  const matching = db.prepare(
    `SELECT m.* FROM json_each(?) j CROSS JOIN memories m ON m.id = j.value
      WHERE m.namespace = ? AND ${conditions.join(' AND ')}`,
  );

  // A little more than asked for, so a few non-matching neighbours (another namespace,
  // the batch consolidation is pairing) rarely cost a second query; a KNN's cost
  // hardly depends on k.
  let k = Math.min(KNN_MAX_K, 2 * limit + 16);
  for (;;) {
    const hits = knn.all(query, k) as Array<{ memory_id: string; distance: number }>;
    const rows = matching.all(JSON.stringify(hits.map((h) => h.memory_id)), namespace, ...params) as MemoryRow[];
    const rowById = new Map(rows.map((r) => [r.id, r]));
    const results: VectorSearchResult[] = [];
    for (const hit of hits) {
      const row = rowById.get(hit.memory_id);
      if (row === undefined) continue;
      results.push({ ...row, distance: (hit.distance * hit.distance) / 2 });
      if (results.length === limit) return results;
    }
    // Fewer than `limit` neighbours matched. If the KNN returned every vector there is,
    // no other memory can match; otherwise look further out.
    if (hits.length < k) return results;
    if (k === KNN_MAX_K) return nearestByScan(db, namespace, embedding, limit, conditions, params);
    k = Math.min(KNN_MAX_K, k * KNN_GROWTH);
  }
}

/**
 * The `limit` memories of `namespace` that satisfy `conditions`, nearest to `embedding`
 * first, found by computing the exact cosine distance of each of them: exact for any
 * filter, and cheap when the filter leaves few memories (a tag scope). The memories are
 * the outer loop (CROSS JOIN keeps that order), so a vector is read only for a memory
 * that passed the filter.
 */
function nearestByScan(
  db: Database.Database,
  namespace: string,
  embedding: Float32Array,
  limit: number,
  conditions: readonly string[],
  params: ReadonlyArray<string | number | null>,
): VectorSearchResult[] {
  if (limit <= 0) return [];
  const rows = db
    .prepare(
      `SELECT m.*, vec_distance_cosine(v.embedding, ?) AS scan_distance
         FROM memories m CROSS JOIN vec_memories v ON v.memory_id = m.id
        WHERE m.namespace = ? AND ${conditions.join(' AND ')}
        ORDER BY scan_distance ASC, m.id ASC
        LIMIT ?`,
    )
    .all(vectorBlob(embedding), namespace, ...params, limit) as Array<MemoryRow & { scan_distance: number }>;
  return rows.map(({ scan_distance: distance, ...row }) => ({ ...row, distance }));
}

/**
 * Keyword candidates: the `limit` LIVE memories of `namespace` that best match `query`
 * (BM25), carrying all of `options.tags` when given. Decayed and compacted memories stay
 * in the FTS index (the row is kept) but are filtered here, and the tags (and the reader
 * scope and review group of `options`) are applied before the limit, like the vector side.
 *
 * The FTS match is the outer loop (CROSS JOIN keeps that order). Given the choice,
 * SQLite reads `namespace = ? AND importance > 0` through the importance index and runs
 * the whole MATCH once per memory, which takes seconds on a few thousand memories.
 */
export function ftsSearch(
  db: Database.Database,
  namespace: string,
  query: string,
  limit: number,
  options: SearchOptions = {},
): FtsSearchResult[] {
  // The query's words as quoted FTS5 phrases (no operators); none left, no keyword search.
  const sanitized = sanitizeFtsQuery(query);
  if (!sanitized) return [];

  const { conditions, params } = searchFilter(options);
  return db
    .prepare(
      `SELECT m.*, bm25(memories_fts, 3.0, 1.5) as bm25_score
       FROM memories_fts fts
       CROSS JOIN memories m ON m.rowid = fts.rowid
       WHERE memories_fts MATCH ? AND m.namespace = ? AND ${conditions.join(' AND ')}
       ORDER BY bm25(memories_fts, 3.0, 1.5)
       LIMIT ?`,
    )
    .all(sanitized, namespace, ...params, limit) as FtsSearchResult[];
}

// Common English stop words — these have near-zero IDF in any corpus and
// pollute BM25 rankings when OR-joined with discriminative terms.
const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'can',
  'did',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'he',
  'her',
  'him',
  'his',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'me',
  'my',
  'no',
  'not',
  'of',
  'on',
  'or',
  'our',
  's',
  'she',
  'so',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'to',
  'too',
  'up',
  'us',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'will',
  'with',
  'would',
  'you',
  'your',
]);

/** The most query words a keyword search uses (each also forms a phrase with the next). */
const MAX_FTS_QUERY_WORDS = 20;

/**
 * The search words of `text`: runs of letters of any script, combining marks, digits
 * and `_`, without English stop words. Everything else, FTS5's operator characters
 * (`"`, `*`, `^`, `:`, `(`, `-`, ...) included, separates words. Combining marks stay
 * inside a word because NFKC does not compose every one (most Indic vowel signs have
 * no precomposed form). A word with no letter or digit is dropped: it would be an
 * empty phrase. Stop words are matched in NFKC form, so a stop word typed in a
 * compatibility form ('ＴＨＥ') is left out of the as-typed words too.
 */
function ftsQueryWords(text: string): string[] {
  return text
    .replace(/[^\p{L}\p{M}\p{N}_\s]/gu, ' ')
    .split(/\s+/u)
    .filter((w) => /[\p{L}\p{N}]/u.test(w) && !STOP_WORDS.has(w.normalize('NFKC').toLowerCase()));
}

/**
 * The FTS5 MATCH expression for a recall query: every word as a quoted phrase, and
 * every pair of neighbouring words as a two-word phrase, joined with OR.
 *
 * Words keep their letters in every script ('café', 'Zürich', '東京'). The table's
 * `unicode61` tokenizer folds case and diacritics in the index and in the query alike,
 * so 'café' also finds 'cafe'. (It splits text only at separators, so CJK text written
 * without spaces is one token per run; finding a word inside such a run would need a
 * trigram index.) Quoting each word keeps it a plain term, never an FTS5 operator
 * (AND, OR, NOT, NEAR).
 *
 * The query is NFKC-normalized first, so compatibility forms (full-width letters
 * and digits, ligatures) find the text written with the ordinary characters. The
 * index does not fold them, so a word NFKC changes is also searched as it was typed,
 * which finds text stored in the same form.
 */
function sanitizeFtsQuery(query: string): string {
  const words = ftsQueryWords(query.normalize('NFKC')).slice(0, MAX_FTS_QUERY_WORDS);
  const typed = ftsQueryWords(query.normalize('NFC'))
    .filter((w) => w.normalize('NFKC') !== w)
    .slice(0, MAX_FTS_QUERY_WORDS);

  const phrases: string[] = [];
  for (let i = 0; i < words.length - 1; i++) {
    phrases.push(`"${words[i]} ${words[i + 1]}"`);
  }
  return [...phrases, ...[...words, ...typed].map((w) => `"${w}"`)].join(' OR ');
}

// ---------- Retrieval helpers ----------

export function getMemoriesByIds(
  db: Database.Database,
  namespace: string,
  ids: string[],
  scope?: ReadScope,
): MemoryRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const visible = visibility('m', scope);
  return db
    .prepare(`SELECT m.* FROM memories m WHERE m.namespace = ? AND m.id IN (${placeholders})${visible.sql}`)
    .all(namespace, ...ids, ...visible.params) as MemoryRow[];
}

export function getRecentMemories(
  db: Database.Database,
  namespace: string,
  limit: number,
  scope?: ReadScope,
): MemoryRow[] {
  const visible = visibility('m', scope);
  return db
    .prepare(
      `SELECT m.* FROM memories m
       WHERE m.namespace = ? AND m.is_compacted = 0 AND m.importance > 0${visible.sql}
       ORDER BY m.created_at DESC
       LIMIT ?`,
    )
    .all(namespace, ...visible.params, limit) as MemoryRow[];
}

export function getImportantMemories(
  db: Database.Database,
  namespace: string,
  limit: number,
  scope?: ReadScope,
): MemoryRow[] {
  const visible = visibility('m', scope);
  return db
    .prepare(
      `SELECT m.* FROM memories m
       WHERE m.namespace = ? AND m.is_compacted = 0 AND m.importance > 0${visible.sql}
       ORDER BY m.importance DESC
       LIMIT ?`,
    )
    .all(namespace, ...visible.params, limit) as MemoryRow[];
}

/**
 * One page of every memory of the namespace in insertion order (rowid), decayed and
 * compacted ones included: the export reader. `afterRowid` is the last rowid of the
 * previous page (keyset paging, so a page costs the same however deep it is, and
 * rows written meanwhile never shift the pages).
 */
export function getMemoryPage(
  db: Database.Database,
  namespace: string,
  afterRowid: number,
  limit: number,
  scope?: ReadScope,
): Array<MemoryRow & { rowid: number }> {
  const visible = visibility('m', scope);
  return db
    .prepare(
      `SELECT m.rowid AS rowid, m.* FROM memories m
       WHERE m.namespace = ? AND m.rowid > ?${visible.sql}
       ORDER BY m.rowid ASC
       LIMIT ?`,
    )
    .all(namespace, afterRowid, ...visible.params, limit) as Array<MemoryRow & { rowid: number }>;
}

// ---------- Delete ----------

export function deleteMemory(db: Database.Database, namespace: string, id: string): boolean {
  const txn = db.transaction(() => {
    db.prepare(
      `DELETE FROM vec_memories WHERE memory_id = ?
       AND memory_id IN (SELECT id FROM memories WHERE namespace = ?)`,
    ).run(id, namespace);
    const result = db.prepare(`DELETE FROM memories WHERE id = ? AND namespace = ?`).run(id, namespace);
    return result.changes > 0;
  });
  return txn();
}

/** Ids bound per DELETE statement (well under SQLite's bound-parameter limit). */
const DELETE_CHUNK_SIZE = 500;

/**
 * Delete memories (rows, vectors and, through the trigger, FTS entries) by id, scoped
 * to `namespace`, atomically. Returns the number of memory rows deleted.
 *
 * vec0 accepts only ONE `IN (...)` constraint on its primary-key column per statement
 * ("only 1 'rowid in (..)' operator is allowed in a single vec0 query"), so the id
 * list and the namespace scope go into a single subquery rather than two INs.
 */
export function deleteMemories(db: Database.Database, namespace: string, ids: string[]): number {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return 0;
  const txn = db.transaction((): number => {
    let deleted = 0;
    for (let start = 0; start < unique.length; start += DELETE_CHUNK_SIZE) {
      const chunk = unique.slice(start, start + DELETE_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      db.prepare(
        `DELETE FROM vec_memories
         WHERE memory_id IN (SELECT id FROM memories WHERE namespace = ? AND id IN (${placeholders}))`,
      ).run(namespace, ...chunk);
      deleted += db
        .prepare(`DELETE FROM memories WHERE namespace = ? AND id IN (${placeholders})`)
        .run(namespace, ...chunk).changes;
    }
    return deleted;
  });
  return txn();
}

/** The columns of a memory that forgetting it reads. */
interface ForgetRow {
  id: string;
  content: string;
  segment_id: string | null;
  metadata: string | null;
  is_compacted: number;
}

function forgetRows(db: Database.Database, namespace: string, ids: readonly string[]): ForgetRow[] {
  if (ids.length === 0) return [];
  return db
    .prepare(
      `SELECT m.id, m.content, m.segment_id, m.metadata, m.is_compacted
         FROM json_each(?) j CROSS JOIN memories m ON m.id = j.value
        WHERE m.namespace = ?`,
    )
    .all(JSON.stringify([...new Set(ids)]), namespace) as ForgetRow[];
}

/**
 * Forget memories (memory_forget), atomically: delete the rows with their vectors and
 * FTS entries (deleteMemories), delete the source segments they were extracted from,
 * delete compaction's copies of their text, and remove their text from other memories'
 * superseded histories. Returns the number of the given memories deleted.
 *
 * Every source segment goes (`segment_id` and `metadata.source_segments`), even when
 * sibling facts still reference it: it is a raw chunk the forgotten fact was extracted
 * from, its text included, and that text cannot be cut out of the chunk (facts are
 * paraphrases, not spans). Keeping it would hand the forgotten text back through
 * memory_expand and through expansion of the siblings. The siblings keep their own text
 * and lose only that source context.
 *
 * Compaction (compactionLineage): a summary holds the text of the memories it replaced,
 * and they hold its text. Forgetting a summary deletes those memories; forgetting a
 * compacted memory deletes its summary, and the summary's other memories are released
 * so a later compaction pass summarizes them again without the forgotten text.
 */
export function forgetMemoryRows(db: Database.Database, namespace: string, ids: string[]): number {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return 0;
  const txn = db.transaction((): number => {
    const targets = forgetRows(db, namespace, unique);
    if (targets.length === 0) return 0;
    const lineage = compactionLineage(db, namespace, targets);
    const removed = [...targets, ...forgetRows(db, namespace, lineage.remove)];
    const deleted = deleteMemories(
      db,
      namespace,
      targets.map((r) => r.id),
    );
    deleteMemories(db, namespace, lineage.remove);
    if (lineage.release.length > 0) {
      db.prepare(
        `UPDATE memories SET is_compacted = 0
          WHERE id IN (SELECT value FROM json_each(?)) AND +namespace = ? AND is_compacted = 1`,
      ).run(JSON.stringify(lineage.release), namespace);
    }
    purgeSegments(
      db,
      namespace,
      removed.flatMap((r) => sourceSegmentsOf(r)),
    );
    clearSupersededTexts(
      db,
      namespace,
      removed.map((r) => r.content),
    );
    return deleted;
  });
  return txn();
}

/** The memory ids in a summary's `metadata.compacted_from` (none for any other row). */
function readCompactedFrom(metadata: string | null): string[] {
  const value = parseMetadataObject(metadata)?.compacted_from;
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}

/**
 * What forgetting `targets` does to compaction's copies of their text (compaction.ts
 * writes a summary listing the memories it replaced in `compacted_from` and marks them
 * compacted):
 *   - down: a summary takes the compacted memories it replaced with it; they hold its
 *     text and nothing else shows them. Recursively, for a summary of summaries.
 *   - up: a compacted memory takes the summary that replaced it with it, since the
 *     summary states its text; recursively, while that summary is compacted itself. The
 *     summary's other memories are released (`is_compacted = 0`; they stay decayed), so
 *     the next compaction pass summarizes them again.
 * Returns the memories to delete besides `targets`, and those to release.
 */
function compactionLineage(
  db: Database.Database,
  namespace: string,
  targets: readonly ForgetRow[],
): { remove: string[]; release: string[] } {
  if (!targets.some((r) => r.is_compacted === 1 || readCompactedFrom(r.metadata).length > 0)) {
    return { remove: [], release: [] };
  }

  const summaries = db
    .prepare(
      `SELECT id, metadata, is_compacted FROM memories
        WHERE namespace = ? AND instr(metadata, '"compacted_from"') > 0`,
    )
    .all(namespace) as Array<{ id: string; metadata: string | null; is_compacted: number }>;
  const membersOf = new Map<string, string[]>();
  const summariesOf = new Map<string, string[]>();
  const compacted = new Map<string, boolean>();
  for (const summary of summaries) {
    const members = readCompactedFrom(summary.metadata);
    membersOf.set(summary.id, members);
    for (const member of members) summariesOf.set(member, [...(summariesOf.get(member) ?? []), summary.id]);
    compacted.set(summary.id, summary.is_compacted === 1);
  }
  for (const target of targets) compacted.set(target.id, target.is_compacted === 1);
  const compactedById = db.prepare(`SELECT is_compacted FROM memories WHERE id = ? AND namespace = ?`);
  const isCompacted = (id: string): boolean => {
    let value = compacted.get(id);
    if (value === undefined) {
      value = (compactedById.get(id, namespace) as { is_compacted: number } | undefined)?.is_compacted === 1;
      compacted.set(id, value);
    }
    return value;
  };

  const removed = new Set(targets.map((r) => r.id));
  const released = new Set<string>();
  const queue = targets.map((r) => ({ id: r.id, down: true }));
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    if (next.down) {
      for (const member of membersOf.get(next.id) ?? []) {
        if (removed.has(member) || !isCompacted(member)) continue;
        removed.add(member);
        queue.push({ id: member, down: true });
      }
    }
    if (!isCompacted(next.id)) continue;
    for (const summary of summariesOf.get(next.id) ?? []) {
      if (removed.has(summary)) continue;
      removed.add(summary);
      queue.push({ id: summary, down: false });
      for (const member of membersOf.get(summary) ?? []) {
        if (isCompacted(member)) released.add(member);
      }
    }
  }

  const targetIds = new Set(targets.map((r) => r.id));
  return {
    remove: [...removed].filter((id) => !targetIds.has(id)),
    release: [...released].filter((id) => !removed.has(id)),
  };
}

/**
 * Remove from the superseded history (`metadata.superseded`) of every memory of
 * `namespace` the entries holding one of `texts`, compared as store-time dedup compares
 * texts (normalizeFactText): when a contradiction replaced a memory's text, the old text
 * went to that history, and forgetting a memory with that text must not leave the copy
 * behind. Returns the number of memories changed.
 */
function clearSupersededTexts(db: Database.Database, namespace: string, texts: readonly string[]): number {
  const forgotten = new Set(texts.map(normalizeFactText));
  if (forgotten.size === 0) return 0;
  const isForgotten = (entry: unknown): boolean =>
    typeof entry === 'object' &&
    entry !== null &&
    typeof (entry as { content?: unknown }).content === 'string' &&
    forgotten.has(normalizeFactText((entry as { content: string }).content));

  // A cheap textual pre-filter; the metadata is parsed in JS, so a malformed value is
  // skipped rather than failing the forget.
  const candidates = db
    .prepare(`SELECT id, metadata FROM memories WHERE namespace = ? AND metadata LIKE '%superseded%'`)
    .all(namespace) as Array<{ id: string; metadata: string }>;
  const update = db.prepare(`UPDATE memories SET metadata = ? WHERE id = ? AND namespace = ?`);
  let changed = 0;
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate.metadata);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
    const metadata = parsed as Record<string, unknown>;
    const history = metadata.superseded;
    // An array of entries, or the single entry older versions stored.
    const entries = Array.isArray(history) ? history : [history];
    const kept = entries.filter((entry) => !isForgotten(entry));
    if (kept.length === entries.length) continue;
    if (kept.length === 0) {
      delete metadata.superseded;
    } else {
      metadata.superseded = kept;
    }
    update.run(JSON.stringify(metadata), candidate.id, namespace);
    changed++;
  }
  return changed;
}

/**
 * The criteria of one `memory_forget` call. Every criterion that is present must
 * match (intersection); absent criteria do not constrain.
 */
export interface ForgetCriteria {
  /** Only these ids. */
  ids?: string[];
  /** Only memories carrying ALL of these tags. */
  tags?: string[];
  /** Only memories created strictly before this epoch-ms time. */
  beforeMs?: number;
  /**
   * Only memories whose vector lies strictly within `maxDistance` (cosine distance) of
   * `embedding`. The selection is then ordered closest first instead of oldest first.
   */
  near?: { embedding: Float32Array; maxDistance: number };
}

/**
 * Select the memories one forget call targets: `namespace` AND every present
 * criterion, at most `limit` rows: closest first with `near`, otherwise oldest first.
 * Throws when no criterion is present, so a caller bug can never select a whole
 * namespace.
 *
 * With `near` this is an exact scan in which every criterion, the distance cut-off
 * included, is applied before the LIMIT. A matching memory therefore cannot be
 * crowded out by closer memories that another criterion excludes (a "nearest N
 * first, filter afterwards" selection would miss it and report the same truncation
 * on every retry). Keep it exact: a vec0 KNN (`MATCH ? AND k = ?`) picks its k
 * nearest before any filter.
 */
export function findForgetTargets(
  db: Database.Database,
  namespace: string,
  criteria: ForgetCriteria,
  limit: number,
  scope?: ReadScope,
): MemoryRow[] {
  const where: string[] = [];
  const params: Array<string | number | null> = [];

  if (criteria.ids !== undefined) {
    where.push(`m.id IN (${criteria.ids.map(() => '?').join(',')})`);
    params.push(...criteria.ids);
  }
  if (criteria.tags !== undefined) {
    const tagged = allTagsConditions('m', criteria.tags);
    where.push(...tagged.clauses);
    params.push(...tagged.params);
  }
  if (criteria.beforeMs !== undefined) {
    where.push('m.created_at < ?');
    params.push(criteria.beforeMs);
  }
  const near = criteria.near;
  if (where.length === 0 && near === undefined) {
    throw new Error('findForgetTargets: at least one criterion is required');
  }
  // A reader forgets only what it may see: a memory waiting for review is neither
  // shown in its preview nor deleted by it (utils/review.ts). Not a criterion, so it
  // is added after the check above.
  if (scope !== undefined) {
    where.push(visibleSql('m'));
    params.push(...visibleParams(scope));
  }

  if (near === undefined) {
    return db
      .prepare(
        `SELECT m.* FROM memories m
         WHERE m.namespace = ? AND ${where.join(' AND ')}
         ORDER BY m.created_at ASC, m.id ASC
         LIMIT ?`,
      )
      .all(namespace, ...params, limit) as MemoryRow[];
  }

  // A distinct alias rather than `distance`, so it cannot be confused with vec0's hidden
  // `distance` column (filled only by KNN queries).
  const filters = where.map((clause) => ` AND ${clause}`).join('');
  return db
    .prepare(
      `SELECT * FROM (
         SELECT m.*, vec_distance_cosine(v.embedding, ?) AS forget_distance
         FROM memories m
         JOIN vec_memories v ON v.memory_id = m.id
         WHERE m.namespace = ?${filters}
       )
       WHERE forget_distance < ?
       ORDER BY forget_distance ASC, id ASC
       LIMIT ?`,
    )
    .all(
      Buffer.from(near.embedding.buffer, near.embedding.byteOffset, near.embedding.byteLength),
      namespace,
      ...params,
      near.maxDistance,
      limit,
    ) as MemoryRow[];
}

// ---------- Stats ----------

export interface NamespaceStats {
  total_memories: number;
  active_memories: number;
  decayed_memories: number;
  compacted_memories: number;
  oldest_memory: number | null;
  newest_memory: number | null;
  storage_bytes: number;
  top_tags: Array<{ tag: string; count: number }>;
}

interface AggregateStatsRow {
  total: number;
  active: number;
  decayed: number;
  compacted: number;
  oldest: number | null;
  newest: number | null;
}

/**
 * Counts and top tags of the namespace. With a `scope`, only the memories that
 * reader may see are counted (a reader learns nothing, tags included, about the
 * memories hidden from it); without one, every memory.
 */
export function getNamespaceStats(db: Database.Database, namespace: string, scope?: ReadScope): NamespaceStats {
  const visible = visibility('m', scope);
  const agg = db
    .prepare(
      `SELECT
         COUNT(*) as total,
         COALESCE(SUM(CASE WHEN m.is_compacted = 0 AND m.importance > 0 THEN 1 ELSE 0 END), 0) as active,
         COALESCE(SUM(CASE WHEN m.importance = 0 AND m.is_compacted = 0 THEN 1 ELSE 0 END), 0) as decayed,
         COALESCE(SUM(CASE WHEN m.is_compacted = 1 THEN 1 ELSE 0 END), 0) as compacted,
         MIN(m.created_at) as oldest,
         MAX(m.created_at) as newest
       FROM memories m WHERE m.namespace = ?${visible.sql}`,
    )
    .get(namespace, ...visible.params) as AggregateStatsRow;

  // Approximate storage size from page_count * page_size
  const pageCount = (db.prepare(`PRAGMA page_count`).get() as { page_count: number }).page_count;
  const pageSize = (db.prepare(`PRAGMA page_size`).get() as { page_size: number }).page_size;

  const topTags = computeTopTags(db, namespace, 20, scope);

  return {
    total_memories: agg.total,
    active_memories: agg.active,
    decayed_memories: agg.decayed,
    compacted_memories: agg.compacted,
    oldest_memory: agg.oldest,
    newest_memory: agg.newest,
    storage_bytes: pageCount * pageSize,
    top_tags: topTags,
  };
}

function computeTopTags(
  db: Database.Database,
  namespace: string,
  limit: number,
  scope: ReadScope | undefined,
): Array<{ tag: string; count: number }> {
  const visible = visibility('m', scope);
  return db
    .prepare(
      `SELECT value AS tag, COUNT(*) AS count
       FROM memories m, json_each(m.tags)
       WHERE m.namespace = ? AND m.tags IS NOT NULL AND json_valid(m.tags) AND m.is_compacted = 0${visible.sql}
       GROUP BY value
       ORDER BY count DESC
       LIMIT ?`,
    )
    .all(namespace, ...visible.params, limit) as Array<{ tag: string; count: number }>;
}

// ---------- Maintenance queries ----------

export function getRandomActiveMemories(db: Database.Database, namespace: string, limit: number): MemoryRow[] {
  return db
    .prepare(
      `SELECT * FROM memories
       WHERE namespace = ? AND importance > 0 AND is_compacted = 0
       ORDER BY RANDOM()
       LIMIT ?`,
    )
    .all(namespace, limit) as MemoryRow[];
}

/**
 * Mark a memory decayed: importance 0, and its vector removed, so the KNN index holds
 * live memories only. The row stays for compaction, which embeds its text again
 * (compaction.ts), and for memory_inspect.
 */
export function markDecayed(db: Database.Database, namespace: string, id: string): void {
  const txn = db.transaction(() => {
    db.prepare(
      `DELETE FROM vec_memories WHERE memory_id = ?
       AND memory_id IN (SELECT id FROM memories WHERE namespace = ?)`,
    ).run(id, namespace);
    db.prepare(`UPDATE memories SET importance = 0 WHERE id = ? AND namespace = ?`).run(id, namespace);
  });
  txn();
}

/**
 * Remove the vectors of the memories of `namespace` that are not live (decayed or
 * compacted). markDecayed and markCompacted already do this; this maintenance step
 * catches rows they never saw: a database written before they did, or a row stored
 * with importance 0. Every vector left belongs to a memory recall may return, so the
 * KNN rarely has to look past a neighbour it cannot use. Returns the number removed.
 */
export function pruneVectorsOfInactiveMemories(db: Database.Database, namespace: string): number {
  return db
    .prepare(
      `DELETE FROM vec_memories
        WHERE memory_id IN (SELECT id FROM memories WHERE namespace = ? AND NOT (${liveMemoryCondition('memories')}))`,
    )
    .run(namespace).changes;
}

/**
 * A position in the scan order of decayed memories, (created_at, id): where a
 * compaction pass stopped reading (compaction.ts).
 */
export interface DecayedScanPosition {
  readonly created_at: number;
  readonly id: string;
}

/**
 * At most `limit` decayed, uncompacted memories of `namespace` in scan order (oldest
 * first, ties by id): from the oldest, or, with `after`, those that come after that
 * position.
 */
export function getDecayedUncompacted(
  db: Database.Database,
  namespace: string,
  limit: number,
  after?: DecayedScanPosition,
): MemoryRow[] {
  // `created_at >= ?` lets the (namespace, created_at) index seek to the position;
  // the second condition skips the rows at it.
  const position =
    after === undefined
      ? { sql: '', params: [] }
      : {
          sql: ' AND created_at >= ? AND (created_at > ? OR id > ?)',
          params: [after.created_at, after.created_at, after.id],
        };
  return db
    .prepare(
      `SELECT * FROM memories
       WHERE namespace = ? AND importance = 0 AND is_compacted = 0${position.sql}
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
    )
    .all(namespace, ...position.params, limit) as MemoryRow[];
}

function compactionCursorKey(namespace: string): string {
  return `compaction_cursor:${namespace}`;
}

/**
 * Where the next compaction pass of `namespace` goes on reading decayed memories (kept
 * in schema_meta, like the maintenance lease); null to start from the oldest, also
 * when the value is unreadable.
 */
export function readCompactionCursor(db: Database.Database, namespace: string): DecayedScanPosition | null {
  const row = db.prepare(`SELECT value FROM schema_meta WHERE key = ?`).get(compactionCursorKey(namespace)) as
    { value: string | null } | undefined;
  if (row === undefined || row.value === null) return null;
  try {
    const cursor = JSON.parse(row.value) as Partial<DecayedScanPosition> | null;
    if (typeof cursor?.created_at === 'number' && Number.isFinite(cursor.created_at) && typeof cursor.id === 'string') {
      return { created_at: cursor.created_at, id: cursor.id };
    }
  } catch {
    // Unreadable: start from the oldest.
  }
  return null;
}

/** Record where the next compaction pass of `namespace` goes on reading; null starts it from the oldest. */
export function writeCompactionCursor(
  db: Database.Database,
  namespace: string,
  cursor: DecayedScanPosition | null,
): void {
  if (cursor === null) {
    db.prepare(`DELETE FROM schema_meta WHERE key = ?`).run(compactionCursorKey(namespace));
    return;
  }
  db.prepare(
    `INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(compactionCursorKey(namespace), JSON.stringify({ created_at: cursor.created_at, id: cursor.id }));
}

/**
 * Mark memories compacted (their summary replaces them in retrieval) and remove any
 * vector they still have, so the KNN index holds live memories only.
 */
export function markCompacted(db: Database.Database, namespace: string, ids: string[]): void {
  if (ids.length === 0) return;
  const list = JSON.stringify([...new Set(ids)]);
  const txn = db.transaction(() => {
    db.prepare(
      `DELETE FROM vec_memories
        WHERE memory_id IN (SELECT id FROM memories WHERE id IN (SELECT value FROM json_each(?)) AND +namespace = ?)`,
    ).run(list, namespace);
    db.prepare(
      `UPDATE memories SET is_compacted = 1 WHERE id IN (SELECT value FROM json_each(?)) AND +namespace = ?`,
    ).run(list, namespace);
  });
  txn();
}

/**
 * Unconsolidated live memories, oldest first. Ties (e.g. every fact of one `as_of`
 * ingest shares a timestamp) keep insertion order, so "later in the batch" means
 * "stored later" for consolidation's intra-batch pairs.
 */
export function getUnconsolidatedMemories(db: Database.Database, namespace: string, limit: number): MemoryRow[] {
  return db
    .prepare(
      `SELECT * FROM memories
       WHERE namespace = ? AND consolidated = 0 AND importance > 0
       ORDER BY created_at ASC, rowid ASC
       LIMIT ?`,
    )
    .all(namespace, limit) as MemoryRow[];
}

/**
 * Mark memories consolidated. With `onlyPending`, only those of `ids` that still wait for
 * review (utils/review.ts): consolidation leaves pending memories unjudged, and one the
 * user approved meanwhile was queued for consolidation again by the approval (admin.ts
 * markReviewed), which must not be undone.
 */
export function markConsolidated(
  db: Database.Database,
  namespace: string,
  ids: string[],
  options: { onlyPending?: boolean } = {},
): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  const pending = options.onlyPending === true ? ` AND ${pendingSql('memories')}` : '';
  db.prepare(`UPDATE memories SET consolidated = 1 WHERE namespace = ? AND id IN (${placeholders})${pending}`).run(
    namespace,
    ...ids,
  );
}

export function getEmbeddingsForMemories(
  db: Database.Database,
  namespace: string,
  memoryIds: string[],
): Map<string, Float32Array> {
  const result = new Map<string, Float32Array>();
  if (memoryIds.length === 0) return result;

  const placeholders = memoryIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT v.memory_id, v.embedding FROM vec_memories v
       JOIN memories m ON m.id = v.memory_id
       WHERE m.namespace = ? AND v.memory_id IN (${placeholders})`,
    )
    .all(namespace, ...memoryIds) as Array<{ memory_id: string; embedding: Buffer }>;

  for (const row of rows) {
    result.set(
      row.memory_id,
      new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4),
    );
  }
  return result;
}
