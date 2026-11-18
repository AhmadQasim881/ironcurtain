/**
 * Shared types for the memory MCP server.
 * Used by both the engine layer and the MCP tool handlers.
 */

/** The kinds of session that write memories, as the host that spawns the server reports them. */
export const MEMORY_WRITER_KINDS = ['interactive', 'cron', 'workflow'] as const;
export type MemoryWriterKind = (typeof MEMORY_WRITER_KINDS)[number];

/**
 * Who wrote a memory: set by the host on the server's environment
 * (MEMORY_WRITER_KIND, MEMORY_SESSION_ID, MEMORY_WRITER_SCOPE) and stamped into
 * the row's `metadata.writer` when the row is written. Never taken from tool
 * arguments.
 */
export interface MemoryWriter {
  kind: MemoryWriterKind;
  /** The host's id for the session that wrote the memory, when it gave one. */
  session_id?: string;
  /**
   * The unattended writer's scope (for example `job:<id>` or `workflow:<id>`):
   * the runs that may see this writer's memories while they wait for review
   * (utils/review.ts). Absent for interactive writers.
   */
  scope?: string;
}

export interface Memory {
  id: string;
  namespace: string;
  content: string;
  tags: string[];
  importance: number;
  created_at: number;
  updated_at: number;
  last_accessed_at: number;
  access_count: number;
  is_compacted: boolean;
  compacted_from: string[] | null;
  source: string | null;
  metadata: Record<string, unknown> | null;
  /** FK to the source segment a `memory_ingest` fact was extracted from. NULL otherwise. */
  segment_id: string | null;
}

/** A recall-time return unit: either a fact verbatim or an expanded parent passage. */
export type ExpandMode = 'none' | 'auto' | 'parent';

export interface StoreResult {
  id: string;
  action: 'created' | 'merged_duplicate' | 'contradiction_resolved';
}

export interface IngestResult {
  // ---- honest write stats ----
  /** Rows newly created (action === 'created'). */
  created: number;
  /** Facts that hit an existing row (merged_duplicate / contradiction_resolved). */
  merged: number;
  /** Ids of all touched rows (created + merged); empty when dry_run. */
  memory_ids: string[];

  // ---- substance ----
  /** The extracted atomic facts + their importance (always populated). */
  facts: import('./storage/extraction.js').ExtractedFact[];

  // ---- diagnostics ----
  /** Number of LLM windows used (omitted when 1). */
  chunks?: number;
  /**
   * Chunks that FAILED extraction — returned `null` (no LLM / hard error / unparseable).
   * A parsed empty array `[]` is a valid "nothing durable" result, NOT a failed chunk.
   * Omitted when 0.
   */
  failed_chunks?: number;
  /** True when we fell back to single-blob store, OR a partial failure occurred. */
  degraded?: boolean;
  /** True when SOME (not all) chunks failed but others produced facts. */
  partial?: boolean;
  /** True when on_extraction_failure='skip' wrote nothing. */
  skipped?: boolean;

  /**
   * True when part of the content was not turned into facts: the ingest reached
   * MAX_FACTS_PER_INGEST (the remaining chunks were not extracted, or the last
   * chunk's extra facts were dropped) or the content ran past MAX_INGEST_CHUNKS.
   * Omitted otherwise.
   */
  truncated?: boolean;
  /** Chunks never sent to the extraction model because the fact cap was reached (omitted when 0). */
  dropped_chunks?: number;

  /**
   * Count of `segments` rows this ingest wrote and left in place (omitted when 0 / dry_run).
   * A chunk whose facts all merged into memories that keep their own source writes none.
   */
  segments_created?: number;

  /** Secret values removed from the content before extraction (omitted when 0). */
  redacted_secrets?: number;
}

export interface RecallOptions {
  query: string;
  token_budget?: number;
  tags?: string[];
  format?: import('./retrieval/formatting.js').FormatMode;
  /**
   * Parent re-expansion mode (§5.2), default `'auto'`:
   *   - `'auto'`   — expand a parent when ≥2 kept facts share it (the shared-parent signature);
   *   - `'none'`   — force off (byte-for-byte today's facts-only behavior);
   *   - `'parent'` — force-expand the parent of every kept fact that has one.
   */
  expand?: ExpandMode;
  /** Cap on returned expanded passages across the whole result (§5.4). Default 2. */
  max_expand_passages?: number;
}

export interface RecallResult {
  content: string;
  memories_used: number;
  total_matches: number;
  /** True when any returned unit was an expanded parent passage (every format). */
  expanded?: boolean;
  /** The segment_ids that were expanded (every format; omitted/[] when none). */
  expanded_segment_ids?: string[];
  /** The source segment of every returned fact that has one (what memory_expand takes). */
  source_segment_ids?: string[];
}

/**
 * Result of `memory_expand`: some passages of a parent segment. With a query, the
 * passages most relevant to it, best first; without one, the segment's first passages
 * in source order. At most `max_passages` either way (default 3).
 */
export interface ExpandResult {
  segment_id: string;
  /** The passages shown: the first `passages.length` by relevance, or in source order. */
  passages: string[];
  /** How many passages the whole segment has (0 when it is not found). */
  total_passages: number;
  /**
   * False when no live memory references the segment any more (its facts were forgotten,
   * merged away, decayed or compacted) or there is no such segment.
   */
  found: boolean;
}

export interface ContextOptions {
  task?: string;
  token_budget?: number;
}

export interface ForgetOptions {
  ids?: string[];
  tags?: string[];
  query?: string;
  before?: string;
  confirm?: boolean;
  dry_run?: boolean;
}

export interface ForgetResult {
  forgotten: number;
  memories?: Array<{ id: string; content: string }>;
  truncated?: boolean;
  /**
   * Path of the database snapshot written before this deletion removed anything:
   * before every bulk deletion (tags, query or before), and before the first deletion
   * of a server run. Absent for dry runs, later deletions by ids alone, deletions that
   * matched nothing, and in-memory databases.
   */
  snapshot?: string;
}

export interface InspectOptions {
  view?: 'stats' | 'recent' | 'important' | 'tags' | 'export';
  ids?: string[];
  limit?: number;
}

export interface MemoryStats {
  total_memories: number;
  active_memories: number;
  decayed_memories: number;
  compacted_memories: number;
  oldest_memory: string | null;
  newest_memory: string | null;
  storage_bytes: number;
  top_tags: Array<{ tag: string; count: number }>;
}
