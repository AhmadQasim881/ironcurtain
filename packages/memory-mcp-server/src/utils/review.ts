/**
 * Review quarantine for memories written by unattended runs.
 *
 * A memory written by a cron job or a workflow run (an unattended writer, see
 * config.ts) waits for review: its `metadata.pending_review` holds the writer's
 * scope (for example `job:daily-report`) until the user approves it with
 * `ironcurtain memory <persona|job> review approve`. A pending memory is
 * visible only to readers of the same scope (the writing job's later runs, the
 * workflow run's later states) and to the host-side admin API (admin.ts);
 * every other reader (a server without a writer included), interactive sessions in
 * particular, sees neither it nor the source passage it was extracted from. So a
 * note planted in an unattended run (one that read web pages or email nobody was
 * watching) cannot reach a session a person drives before that person has looked
 * at it.
 *
 * The flag lives in the existing `metadata` JSON column, like the writer, so no
 * schema change (and no rebuild of existing databases) is needed. Pending and
 * reviewed memories never merge, and a pending memory is frozen until it is
 * approved. The host review shows the full payload with an id@digest receipt,
 * and approval checks that snapshot under the write transaction before releasing
 * its text, tags, source, metadata and source passage. Store-time dedup and consolidation therefore
 * merge reviewed memories only: they never merge anything into a pending memory,
 * nor a pending memory into anything, so a later run of the same scope cannot
 * change a memory the user has already been shown (it writes new pending rows).
 * Compaction summarizes decayed memories within one review group (all reviewed
 * memories, or the pending memories of one scope) into a new memory of that group;
 * it never changes a memory's text.
 */

import type { MemoryWriter } from '../types.js';

/** The `metadata` key that marks a memory as waiting for review; its value is the writer's scope. */
export const PENDING_REVIEW_KEY = 'pending_review';

/** The `metadata` key recording when a memory was approved (epoch ms). */
export const REVIEWED_AT_KEY = 'reviewed_at';

/**
 * Which pending memories a reader may see: those of `scope`, or none when null.
 * Reviewed memories are visible to every reader.
 */
export interface ReadScope {
  readonly pendingScope: string | null;
}

/** The scope under which `writer`'s new memories wait for review, or undefined when they need none. */
export function pendingScopeOf(writer: MemoryWriter | null | undefined): string | undefined {
  if (writer === null || writer === undefined || writer.kind === 'interactive') return undefined;
  return writer.scope ?? writer.kind;
}

/** What a server writing as `writer` may read: reviewed memories, and its own scope's pending ones. */
export function readScopeOf(writer: MemoryWriter | null | undefined): ReadScope {
  return { pendingScope: pendingScopeOf(writer) ?? null };
}

/**
 * The group of every row with a malformed review marker (empty, or not a string):
 * one no reader may see and no well-formed row shares. Starts with NUL, which no
 * writer scope contains (scopes are printable ASCII).
 */
export const MALFORMED_REVIEW_GROUP = '\u0000malformed';

/**
 * The review group of a row: '' for a reviewed memory, the scope for a pending one,
 * {@link MALFORMED_REVIEW_GROUP} for a malformed marker. Memories merge only within
 * one group. Agrees with {@link reviewGroupSql} on every `metadata` value.
 */
export function reviewGroupOf(metadata: string | null): string {
  if (!metadata) return '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    return '';
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return '';
  const marker = (parsed as Record<string, unknown>)[PENDING_REVIEW_KEY];
  if (marker === undefined || marker === null) return '';
  return typeof marker === 'string' && marker !== '' ? marker : MALFORMED_REVIEW_GROUP;
}

/** The pending scope recorded in `metadata` (or the malformed group), or undefined for a reviewed memory. */
export function pendingReviewOf(metadata: string | null): string | undefined {
  const group = reviewGroupOf(metadata);
  return group === '' ? undefined : group;
}

/**
 * SQL for the review group of the row aliased `alias`, exactly as
 * {@link reviewGroupOf} computes it: '' for a reviewed row (no marker, a JSON null
 * marker, or metadata that is not a JSON object), the scope for a pending one, and
 * the malformed group otherwise. Guarded by json_valid: json_extract throws on
 * malformed JSON, and one bad row must not break every query.
 */
export function reviewGroupSql(alias: string): string {
  const path = `'$.${PENDING_REVIEW_KEY}'`;
  const type = `json_type(${alias}.metadata, ${path})`;
  const value = `json_extract(${alias}.metadata, ${path})`;
  const malformed = `(char(0) || 'malformed')`;
  return (
    `(CASE WHEN json_valid(${alias}.metadata) THEN ` +
    `(CASE WHEN ${type} IS NULL OR ${type} = 'null' THEN '' ` +
    `WHEN ${type} = 'text' AND ${value} <> '' THEN ${value} ` +
    `ELSE ${malformed} END) ` +
    `ELSE '' END)`
  );
}

/**
 * SQL condition (one bound parameter, from {@link visibleParams}) that keeps the
 * rows `scope` may see: reviewed memories, and pending ones of its own scope.
 */
export function visibleSql(alias: string): string {
  return `(${reviewGroupSql(alias)} = '' OR ${reviewGroupSql(alias)} = ?)`;
}

/** The parameter of {@link visibleSql}: a NULL scope matches no pending row. */
export function visibleParams(scope: ReadScope): [string | null] {
  return [scope.pendingScope];
}

/** SQL condition that keeps the rows waiting for review (malformed markers included). */
export function pendingSql(alias: string): string {
  return `${reviewGroupSql(alias)} <> ''`;
}

/**
 * SQL condition (one bound parameter, the group from {@link reviewGroupOf}) that
 * keeps the rows of one review group.
 */
export function sameReviewGroupSql(alias: string): string {
  return `${reviewGroupSql(alias)} = ?`;
}
