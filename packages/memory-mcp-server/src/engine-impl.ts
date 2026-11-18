/**
 * MemoryEngine implementation that wires together the engine modules.
 */

import type { MemoryEngine, StoreOptions, IngestOptions, CallControls } from './engine.js';
import type {
  StoreResult,
  IngestResult,
  RecallOptions,
  RecallResult,
  ContextOptions,
  ForgetOptions,
  ForgetResult,
  InspectOptions,
  Memory,
  MemoryStats,
  ExpandResult,
} from './types.js';
import type { MemoryConfig } from './config.js';
import type { MemoryRow } from './storage/database.js';
import { initDatabase, snapshotDatabaseBeforeForget } from './storage/database.js';
import {
  generateId,
  insertMemory,
  materializeSegment,
  adoptRicherPendingSegment,
  deleteSegmentsWithoutLiveFacts,
  getLiveSegmentsByIds,
  mergeMemoryMetadata,
  updateMemoryTimestampsOnMerge,
  vectorSearch,
  forgetMemoryRows,
  findForgetTargets,
  getMemoriesByIds,
  getMemoryPage,
  getRecentMemories,
  getImportantMemories,
  getNamespaceStats,
} from './storage/queries.js';
import type { PendingSegment } from './storage/queries.js';
import { maybeRunMaintenance, releaseMaintenanceLease, runStartupMaintenance } from './storage/maintenance.js';
import { embed, embedQuery, getEmbedder } from './embedding/embedder.js';
import { getReranker } from './retrieval/reranker.js';
import { recall as retrievalRecall } from './retrieval/pipeline.js';
import { rankPassages } from './retrieval/expansion.js';
import { estimateTokens } from './retrieval/scoring.js';
import {
  EXACT_DEDUP_DISTANCE,
  FORGET_QUERY_LIMIT,
  FORGET_QUERY_MAX_DISTANCE,
  FORGET_RESULT_LIMIT,
  STORE_DEDUP_CANDIDATES,
} from './storage/constants.js';
import {
  DEFAULT_EXPAND_PASSAGES,
  MAX_CONTENT_LENGTH,
  MIN_STORED_IMPORTANCE,
  assertIngestSize,
  assertValidAsOf,
  capImportance,
} from './tools/validation.js';
import { cancelledError, extractAllFacts, splitToPassages } from './storage/extraction.js';
import type { ChunkGroup, ExtractedFact, IngestMode } from './storage/extraction.js';
import { parseTags, unionTags } from './utils/tags.js';
import { normalizeFactText } from './utils/fact-text.js';
import { formatDay, formatTimestamp } from './utils/dates.js';
import { redactSecrets } from './utils/secrets.js';
import { PENDING_REVIEW_KEY, pendingScopeOf, readScopeOf } from './utils/review.js';
import { sourceMarker } from './utils/source-markers.js';
import type Database from 'better-sqlite3';

// ---------- Row <-> Memory conversion ----------

function safeParseJson(value: string | null | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function rowToMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    namespace: row.namespace,
    content: row.content,
    tags: parseTags(row.tags),
    importance: row.importance,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_accessed_at: row.last_accessed_at,
    access_count: row.access_count,
    is_compacted: row.is_compacted === 1,
    compacted_from:
      ((safeParseJson(row.metadata) as Record<string, unknown> | null)?.compacted_from as string[] | undefined) ?? null,
    source: row.source,
    metadata: safeParseJson(row.metadata) as Record<string, unknown> | null,
    segment_id: row.segment_id,
  };
}

// ---------- Store (immediate, no LLM) ----------

/** storeImmediate's options: the public store options, plus an ingested fact's source. */
interface ImmediateStoreOptions extends StoreOptions {
  /**
   * The source segment of a fact `memory_ingest` extracted. Its row is written when the
   * first fact links to it; the LLM-free `store` path never sets it, so its rows keep
   * `segment_id = NULL`.
   */
  segment?: PendingSegment;
}

/**
 * The one write path for new memories (memory_store, and every fact memory_ingest
 * extracts). Whatever the caller asked for, it:
 *   - caps importance at MAX_AGENT_IMPORTANCE (agent- or extraction-chosen ranking
 *     must not pin a note at the top of every briefing), and raises it to
 *     MIN_STORED_IMPORTANCE: importance 0 marks a decayed memory, which recall never
 *     returns, so a new memory must not be born decayed;
 *   - removes secret values from the content and tags (the tool handlers reject
 *     them; this covers extracted facts and direct engine callers);
 *   - stamps the host-set writer (`config.writer`) into a new row's
 *     `metadata.writer`. A merge into an existing row keeps that row's writer: its
 *     text, which the writer is accountable for, does not change;
 *   - marks a new row written by an unattended writer (cron, workflow) as waiting
 *     for review (`metadata.pending_review`, utils/review.ts), and merges only into
 *     reviewed rows, only for a writer whose rows need no review: an unattended run
 *     can neither change a reviewed memory nor have its text hidden in one, an
 *     interactive write never lands in a row that waits for review, and a row that
 *     waits for review is never merged into at all. It is frozen until the user
 *     approves its reviewed snapshot: `ironcurtain memory ... review` displays the
 *     full payload with a digest receipt that approval rechecks. A later run of the same scope that
 *     states the same fact again (perhaps from a richer, planted passage) stores a new
 *     pending row instead of retagging or repointing the listed one.
 */
async function storeImmediate(
  db: Database.Database,
  config: MemoryConfig,
  rawContent: string,
  opts: ImmediateStoreOptions,
): Promise<StoreResult> {
  const namespace = config.namespace;
  const importance = Math.max(MIN_STORED_IMPORTANCE, capImportance(opts.importance ?? 0.5));
  if (opts.createdAt !== undefined) assertValidAsOf(opts.createdAt);
  const content = redactSecrets(rawContent).text;
  const tags = opts.tags?.map((tag) => redactSecrets(tag).text);
  const source = opts.source === undefined ? undefined : redactSecrets(opts.source).text;
  const embedding = await embed(content, config);

  // Store-time merge, without an LLM, ONLY for the same fact in the same words: a
  // near neighbour whose normalized text equals the new text. Embedding distance
  // alone cannot tell 'production' from 'staging' or 'X over Y' from 'Y over X'
  // (both measure under EXACT_DEDUP_DISTANCE with the default model), so every
  // other close pair is stored and judged by consolidation's LLM pass instead.
  // An unattended writer's fact is never merged (see above): its rows wait for review,
  // and the only rows it could merge into are its own scope's, which are frozen.
  const normalized = normalizeFactText(content);
  const pendingScope = pendingScopeOf(config.writer);
  const candidates =
    pendingScope === undefined
      ? vectorSearch(db, namespace, embedding, STORE_DEDUP_CANDIDATES, { reviewGroup: '' })
      : [];
  const exactMatch = candidates.find(
    (c) => c.distance < EXACT_DEDUP_DISTANCE && normalizeFactText(c.content) === normalized,
  );

  if (exactMatch) {
    // Same fact: keep the stored text and vector, merge the metadata so none is lost.
    mergeMemoryMetadata(db, namespace, exactMatch.id, {
      tags: unionTags(parseTags(exactMatch.tags), tags ?? []),
      importance,
      source,
    });
    // Order-independent timestamp reconciliation for backdated (`as_of`) merges (A1).
    // Only runs when createdAt is set; non-`as_of` merges leave created_at alone.
    if (opts.createdAt !== undefined) {
      updateMemoryTimestampsOnMerge(db, namespace, exactMatch.id, opts.createdAt);
    }
    // Repoint the survivor to the RICHER parent (A4). Only runs for an ingested fact;
    // store-path merges (no segment) are unchanged.
    if (opts.segment !== undefined) {
      adoptRicherPendingSegment(db, namespace, exactMatch.id, opts.segment);
    }
    return { id: exactMatch.id, action: 'merged_duplicate' };
  }

  // Insert as unconsolidated -- LLM dedup happens during maintenance. An ingested
  // fact's segment is written (on first use) in the same transaction as the fact.
  const id = generateId();
  const { segment } = opts;
  const insert = db.transaction(() => {
    const segmentId = segment === undefined ? null : materializeSegment(db, segment);
    insertMemory(
      db,
      {
        id,
        namespace,
        content,
        tags,
        importance,
        source,
        metadata:
          config.writer === null
            ? undefined
            : { writer: config.writer, ...(pendingScope === undefined ? {} : { [PENDING_REVIEW_KEY]: pendingScope }) },
        consolidated: false,
        createdAt: opts.createdAt,
        segmentId: segmentId ?? undefined,
      },
      embedding,
    );
  });
  insert();

  // Maintenance is the caller's (startMaintenanceAfterWrites): once per call, after its writes.
  return { id, action: 'created' };
}

/**
 * Count `created` new memories towards the maintenance interval and, when a pass is due,
 * start it in the background. An ingest of many facts counts them all and starts at most
 * one pass, after its writes, instead of a pass inside every Nth write.
 *
 * The call that wrote the memories does not wait for the pass: a pass makes up to dozens
 * of LLM calls (each bounded by `config.llmTimeoutMs`) and reports no progress, so with a
 * slow or hung endpoint a memory_store or memory_ingest that waited for it would outlive
 * the caller's deadline (IronCurtain's relay gives up on a call after 300 s without
 * progress), report a timeout for writes that succeeded, and invite a retry. Passes stay
 * serialized (one per connection, one per database through the maintenance lease; see
 * storage/maintenance.ts), like the startup pass that already runs in the background. A
 * failure is logged, not reported (the memories were written); a pass the engine's close
 * cut short is not an error.
 */
function startMaintenanceAfterWrites(db: Database.Database, config: MemoryConfig, created: number): void {
  if (created <= 0) return;
  maybeRunMaintenance(db, config, created).catch((err: unknown) => {
    if (db.open) console.error('[memory-server] Maintenance failed:', err instanceof Error ? err.name : typeof err);
  });
}

// ---------- Ingest (LLM-backed fact decomposition) ----------

const DEFAULT_SEED_IMPORTANCE = 0.5;

/** Flatten the per-chunk groups back to a single fact list (for diagnostics/preview). */
function flattenGroups(groups: ChunkGroup[]): ExtractedFact[] {
  return groups.flatMap((g) => g.facts);
}

/**
 * Decompose a blob into atomic-fact memories via the LLM, writing each fact
 * through the existing `store` pipeline. PII-safe: never logs raw content.
 *
 * Bounded before any LLM call, dry runs included: the content and source caps
 * (assertIngestSize), and at most MAX_FACTS_PER_INGEST facts, after which the remaining
 * chunks are not extracted (`truncated`, `dropped_chunks`). `controls.signal` stops the
 * ingest before its next LLM call or write; `controls.onProgress` hears about each chunk
 * and each fact written. At most one maintenance pass is started, after the writes, and
 * the ingest does not wait for it (startMaintenanceAfterWrites).
 */
export async function ingestBlob(
  db: Database.Database,
  config: MemoryConfig,
  content: string,
  opts: IngestOptions,
  controls: CallControls = {},
): Promise<IngestResult> {
  assertIngestSize(content, opts.source);
  const seedImportance = capImportance(opts.importance ?? DEFAULT_SEED_IMPORTANCE);
  const mode: IngestMode = opts.mode ?? 'conversation';
  const onFailure = opts.on_extraction_failure ?? 'degrade';
  const createdAt = opts.as_of;
  // The handler already bounds as_of; re-check here, before any LLM call or write,
  // for callers that use the engine directly.
  if (createdAt !== undefined) assertValidAsOf(createdAt);
  const dryRun = opts.dry_run ?? false;

  // Secret values never reach the extraction LLM, the stored source segments or the
  // facts: they are removed from the blob before anything else sees it.
  const { text: blob, count: redactedSecrets } = redactSecrets(content);
  const redaction: Pick<IngestResult, 'redacted_secrets'> =
    redactedSecrets > 0 ? { redacted_secrets: redactedSecrets } : {};
  const source = opts.source === undefined ? undefined : redactSecrets(opts.source).text;

  const store = (factContent: string, importance: number, segment?: PendingSegment): Promise<StoreResult> =>
    storeImmediate(db, config, factContent, {
      tags: opts.tags,
      importance,
      source,
      createdAt,
      segment,
    });

  const outcome = await extractAllFacts(config, blob, mode, controls);
  const { groups, totalChunks, failedChunks } = outcome;
  const facts = flattenGroups(groups);
  const multiChunk = totalChunks > 1;
  // Part of the content was not extracted: say so in every result, so a caller does not
  // take a partial decomposition for the whole document.
  const truncation: Pick<IngestResult, 'truncated' | 'dropped_chunks'> = {
    ...(outcome.truncated ? { truncated: true } : {}),
    ...(outcome.droppedChunks > 0 ? { dropped_chunks: outcome.droppedChunks } : {}),
  };

  // Shared shape for the "nothing written" returns (clean-empty and skip).
  const emptyResult = (extra?: Partial<IngestResult>): IngestResult => ({
    created: 0,
    merged: 0,
    memory_ids: [],
    facts: [],
    ...truncation,
    ...redaction,
    ...extra,
  });

  // ---- Empty fact union ----
  if (facts.length === 0) {
    // No failures, just nothing durable: extraction SUCCEEDED and the model
    // reported no durable facts. Write nothing and report a clean empty ingest —
    // this is not a failure, so it never triggers the degrade/skip/error path.
    if (failedChunks === 0) {
      return emptyResult();
    }
    // Real failures produced no usable facts → on_extraction_failure path.
    if (onFailure === 'error') {
      throw new Error(`memory_ingest: extraction produced no facts (${failedChunks}/${totalChunks} chunks failed)`);
    }
    if (onFailure === 'skip') {
      return emptyResult({ skipped: true });
    }
    // 'degrade': store the blob as a single memory (product behavior).
    const truncated = blob.length > MAX_CONTENT_LENGTH ? blob.slice(0, MAX_CONTENT_LENGTH) : blob;
    if (dryRun) {
      return {
        created: 0,
        merged: 0,
        memory_ids: [],
        facts: [{ fact: truncated, importance: seedImportance }],
        degraded: true,
        ...truncation,
        ...redaction,
      };
    }
    if (controls.signal?.aborted) throw cancelledError('memory_ingest');
    const result = await store(truncated, seedImportance);
    // The degraded blob can exact-dedup into an existing memory; report the real action.
    const created = result.action === 'created' ? 1 : 0;
    startMaintenanceAfterWrites(db, config, created);
    return {
      created,
      merged: 1 - created,
      memory_ids: [result.id],
      facts: [{ fact: truncated, importance: seedImportance }],
      degraded: true,
      ...truncation,
      ...redaction,
    };
  }

  const partial = failedChunks > 0;
  const diagnostics: Pick<
    IngestResult,
    'chunks' | 'failed_chunks' | 'degraded' | 'partial' | 'redacted_secrets' | 'truncated' | 'dropped_chunks'
  > = {
    ...(multiChunk ? { chunks: totalChunks } : {}),
    ...(partial ? { failed_chunks: failedChunks, degraded: true, partial: true } : {}),
    ...truncation,
    ...redaction,
  };

  // ---- Dry run: preview without writing ----
  if (dryRun) {
    return { created: 0, merged: 0, memory_ids: [], facts, ...diagnostics };
  }

  // ---- One segment per non-empty chunk-group, linked to by its facts ----
  let created = 0;
  let merged = 0;
  const memoryIds: string[] = [];
  const segments: PendingSegment[] = [];
  // Progress continues from the extraction steps: one step per fact written.
  const totalSteps = totalChunks + facts.length;
  let step = totalChunks;
  for (const group of groups) {
    if (group.facts.length === 0) continue;

    // One source segment per chunk that produced ≥1 fact, written when its first fact
    // links to it: a chunk whose facts all merge into memories that keep their own
    // parent leaves no orphan segment (MEM-3). createdAt flows to both the segment and
    // its facts so a segment's created_at matches its facts'.
    const segment: PendingSegment = {
      id: generateId(),
      namespace: config.namespace,
      content: group.chunkText,
      source,
      mode,
      createdAt,
      factCount: group.facts.length,
      reviewGroup: pendingScopeOf(config.writer) ?? '',
      written: false,
      sharedWith: [],
    };
    segments.push(segment);

    for (const fact of group.facts) {
      if (controls.signal?.aborted) throw cancelledError('memory_ingest');
      const result = await store(fact.fact, fact.importance ?? seedImportance, segment);
      memoryIds.push(result.id);
      if (result.action === 'created') {
        created += 1;
      } else {
        merged += 1;
      }
      step += 1;
      controls.onProgress?.({
        progress: step,
        total: totalSteps,
        message: `Wrote ${step - totalChunks} of ${facts.length} fact(s)`,
      });
    }
  }

  // A segment this ingest wrote can have lost every fact that linked to it while the
  // ingest went on (another server's maintenance pass merged them away); it is deleted
  // now rather than left to the next sweep. `segments_created` counts the segments this
  // ingest wrote and leaves; a retried ingest reuses the rows its first run wrote
  // (materializeSegment) and counts none of them.
  const written = segments.filter((s) => s.written);
  deleteSegmentsWithoutLiveFacts(
    db,
    config.namespace,
    written.map((s) => s.id),
  );
  const segmentsCreated = getLiveSegmentsByIds(
    db,
    config.namespace,
    written.filter((s) => s.reused !== true).map((s) => s.id),
  ).length;

  startMaintenanceAfterWrites(db, config, created);

  return {
    created,
    merged,
    memory_ids: memoryIds,
    facts,
    ...diagnostics,
    ...(segmentsCreated > 0 ? { segments_created: segmentsCreated } : {}),
  };
}

// ---------- Expand (on-demand parent fetch) ----------

/**
 * Fetch a source segment by id and return some of its passages (§9.4), at most
 * `maxPassages` (default DEFAULT_EXPAND_PASSAGES), with the number the segment has in
 * all. With a `query`, every passage is ranked by cosine similarity to the query
 * embedding and the best come first; without one, the segment's first passages come
 * in source order. A segment that no live memory references any more (its facts were
 * forgotten, merged away, decayed or compacted; see getLiveSegmentsByIds) is reported
 * like a missing one: `{ found: false, passages: [], total_passages: 0 }`.
 */
async function expandSegment(
  db: Database.Database,
  config: MemoryConfig,
  segmentId: string,
  query?: string,
  maxPassages: number = DEFAULT_EXPAND_PASSAGES,
): Promise<ExpandResult> {
  // The source of memories this server may not show (they wait for review) is hidden
  // with them: a segment is found only through a live memory the reader may see.
  const segments = getLiveSegmentsByIds(db, config.namespace, [segmentId], readScopeOf(config.writer));
  if (segments.length === 0) {
    return { segment_id: segmentId, passages: [], total_passages: 0, found: false };
  }
  const all = splitToPassages(segments[0].content);

  // No query: the start of the segment, in source order.
  if (query === undefined) {
    return { segment_id: segmentId, passages: all.slice(0, maxPassages), total_passages: all.length, found: true };
  }

  // With a query: rank every passage by similarity to the query embedding (the helper
  // recall expansion uses too) and keep the best, best first.
  const queryEmbedding = await embedQuery(query, config);
  const passages = await rankPassages(config, all, queryEmbedding, maxPassages);
  return { segment_id: segmentId, passages, total_passages: all.length, found: true };
}

// ---------- Context ----------

const CONTEXT_DEFAULT_BUDGET = 800;
const CONTEXT_TASK_BUDGET_FRACTION = 0.7;
const CONTEXT_RECENT_BUDGET_FRACTION = 0.3;

/**
 * The session briefing: task-relevant memories (when a task is given), then recent
 * and important ones packed into the budget.
 *
 * Showing a memory in a briefing does not count as an access. Access count and time
 * reinforce a memory against decay and raise its recall score, and every session
 * starts with a briefing, so counting it would let any note that once made the
 * briefing keep itself alive and ranked by being shown. Only an explicit
 * memory_recall counts.
 *
 * The briefing shows only what this server's reader may see: memories that wait for
 * review are left out of every briefing but those of the run that wrote them
 * (utils/review.ts). A memory extracted from an ingested source carries its
 * `[src:<segment id>]` marker, which memory_expand takes.
 */
async function buildContext(
  db: Database.Database,
  config: MemoryConfig,
  opts: ContextOptions,
  signal?: AbortSignal,
): Promise<string> {
  const totalBudget = opts.token_budget ?? CONTEXT_DEFAULT_BUDGET;
  const sections: string[] = [];

  if (opts.task) {
    const taskResult = await retrievalRecall(db, config, {
      query: opts.task,
      token_budget: Math.floor(totalBudget * CONTEXT_TASK_BUDGET_FRACTION),
      format: 'summary',
      // The no-human-in-loop briefing path is where missing a clause is most costly,
      // so it gets the same auto-expansion as a default recall (§5.2).
      expand: 'auto',
      countAccess: false,
      signal,
    });
    if (taskResult.memoryIds.length > 0) {
      sections.push(`## Task-Relevant Context\n\n${taskResult.text}`);
    }
  }

  // Direct SQL queries for recent & important — no synthetic retrieval query
  const recentBudget = Math.floor(totalBudget * (opts.task ? CONTEXT_RECENT_BUDGET_FRACTION : 1));
  const limit = 20;
  const readScope = readScopeOf(config.writer);
  const recent = getRecentMemories(db, config.namespace, limit, readScope);
  const important = getImportantMemories(db, config.namespace, limit, readScope);

  // Deduplicate by ID (recent and important may overlap)
  const seen = new Set<string>();
  const combined: MemoryRow[] = [];
  for (const mem of [...recent, ...important]) {
    if (!seen.has(mem.id)) {
      seen.add(mem.id);
      combined.push(mem);
    }
  }

  // Format as list and pack to budget
  const lines: string[] = [];
  let usedTokens = 0;
  for (const mem of combined) {
    const marker = mem.segment_id === null ? '' : ` ${sourceMarker(mem.segment_id)}`;
    const line = `- [${formatDay(mem.created_at)}] ${mem.content} (importance: ${mem.importance})${marker}`;
    const tokens = estimateTokens(line);
    if (usedTokens + tokens > recentBudget) continue;
    lines.push(line);
    usedTokens += tokens;
  }

  if (lines.length > 0) {
    sections.push(`## Recent & Important\n\n${lines.join('\n')}`);
  }

  return sections.join('\n\n');
}

// ---------- Forget ----------

/**
 * What one engine (one server run; IronCurtain starts one per session) remembers
 * between its forgets.
 */
interface ForgetGuard {
  /** A snapshot was saved before one of this engine's earlier deletions. */
  snapshotSaved: boolean;
}

/** An absent or empty list is "no constraint"; duplicate entries are dropped. */
function nonEmptyList(values: string[] | undefined): string[] | undefined {
  return values !== undefined && values.length > 0 ? [...new Set(values)] : undefined;
}

/**
 * Forget the memories that match EVERY supplied criterion. The criteria intersect, so
 * adding one only ever narrows the selection:
 *   - ids:    only these memories;
 *   - tags:   only memories carrying all of these tags;
 *   - before: only memories created before this time;
 *   - query:  only memories within FORGET_QUERY_MAX_DISTANCE of the query; of the
 *             memories matching every criterion, the FORGET_QUERY_LIMIT closest per call.
 * A selection is capped; `truncated` then tells the caller to run again. `dry_run`
 * returns the selection without deleting. Deleting by a bulk criterion (tags, query,
 * before) needs `confirm`, even with ids; the tool handler (tools/forget.ts) checks
 * this first and answers with guidance.
 *
 * Before a deletion removes anything, the database is snapshotted
 * (snapshotDatabaseBeforeForget) when it is a bulk deletion, or when this engine has
 * not saved a snapshot yet; if that fails, nothing is deleted. Deletions by ids need
 * no confirm and `memory_inspect` lists every id, so without the first-deletion
 * snapshot a session could empty the namespace by ids with nothing to restore from.
 * Later id deletions of the same run are covered by that snapshot (for every memory
 * that existed when it was taken), and taking no more keeps a run of small deletions
 * from rotating older snapshots out (only MAX_FORGET_SNAPSHOTS are kept).
 *
 * Forgetting removes the text, not just the row (forgetMemoryRows): every source segment
 * an ingested memory was extracted from is deleted with it, even when sibling facts
 * still reference it; a compaction summary goes with a memory it summarized, and the
 * memories a summary replaced go with it; and copies of the text in other memories'
 * superseded histories are removed.
 */
async function forgetMemories(
  db: Database.Database,
  config: MemoryConfig,
  opts: ForgetOptions,
  guard: ForgetGuard,
): Promise<ForgetResult> {
  const namespace = config.namespace;
  const ids = nonEmptyList(opts.ids);
  const tags = nonEmptyList(opts.tags);

  let query: string | undefined;
  if (opts.query !== undefined) {
    query = opts.query.trim();
    if (query.length === 0) throw new Error('query must be a non-empty string');
  }

  let beforeMs: number | undefined;
  if (opts.before !== undefined) {
    beforeMs = Date.parse(opts.before);
    if (Number.isNaN(beforeMs)) throw new Error('before must be a valid ISO 8601 timestamp');
  }

  if (ids === undefined && tags === undefined && query === undefined && beforeMs === undefined) {
    // Fail closed: with no criterion the selection would be the whole namespace.
    throw new Error('At least one of ids, tags, query, or before must be specified');
  }
  // The tool handler answers this case with guidance; the engine refuses it as well,
  // for callers that use the engine directly.
  const bulk = tags !== undefined || query !== undefined || beforeMs !== undefined;
  if (bulk && opts.dry_run !== true && opts.confirm !== true) {
    throw new Error('Deleting by tags, query or before requires confirm=true');
  }

  // A query selects only memories within FORGET_QUERY_MAX_DISTANCE of it, and of the
  // memories that match every criterion only the FORGET_QUERY_LIMIT closest per call.
  // The distance cut-off and the other criteria are applied in one SQL selection, so
  // `truncated` means exactly "more memories match", and a rerun makes progress.
  const near =
    query === undefined
      ? undefined
      : { embedding: await embedQuery(query, config), maxDistance: FORGET_QUERY_MAX_DISTANCE };
  const limit = near === undefined ? FORGET_RESULT_LIMIT : FORGET_QUERY_LIMIT;
  // Only memories this reader may see are previewed or deleted (utils/review.ts).
  const rows = findForgetTargets(db, namespace, { ids, tags, beforeMs, near }, limit + 1, readScopeOf(config.writer));
  const targets = rows.slice(0, limit);

  const truncatedFlag = rows.length > limit ? { truncated: true } : {};
  if (opts.dry_run) {
    return {
      forgotten: targets.length,
      memories: targets.map((r) => ({ id: r.id, content: r.content })),
      ...truncatedFlag,
    };
  }

  const needsSnapshot = targets.length > 0 && (bulk || !guard.snapshotSaved);
  const snapshot = needsSnapshot ? snapshotDatabaseBeforeForget(db, config.dbPath) : null;
  if (snapshot !== null) guard.snapshotSaved = true;
  const forgotten = forgetMemoryRows(
    db,
    namespace,
    targets.map((r) => r.id),
  );
  return { forgotten, ...truncatedFlag, ...(snapshot === null ? {} : { snapshot }) };
}

// ---------- Inspect ----------

/** Default number of memories the `export` view returns (the host CLI exports everything). */
const INSPECT_EXPORT_DEFAULT_LIMIT = 100;

/**
 * The inspect views. Every view shows only what this server's reader may see:
 * memories that wait for review are left out, and so are their tags and counts
 * (utils/review.ts).
 */
function inspectMemories(
  db: Database.Database,
  config: MemoryConfig,
  opts: InspectOptions,
): MemoryStats | Memory[] | string {
  const namespace = config.namespace;
  const limit = opts.limit ?? 20;
  const readScope = readScopeOf(config.writer);

  if (opts.ids && opts.ids.length > 0) {
    const rows = getMemoriesByIds(db, namespace, opts.ids, readScope);
    return rows.map(rowToMemory);
  }

  const view = opts.view ?? 'stats';

  switch (view) {
    case 'stats': {
      const raw = getNamespaceStats(db, namespace, readScope);
      return {
        total_memories: raw.total_memories,
        active_memories: raw.active_memories,
        decayed_memories: raw.decayed_memories,
        compacted_memories: raw.compacted_memories,
        oldest_memory: raw.oldest_memory === null ? null : formatTimestamp(raw.oldest_memory),
        newest_memory: raw.newest_memory === null ? null : formatTimestamp(raw.newest_memory),
        storage_bytes: raw.storage_bytes,
        top_tags: raw.top_tags,
      };
    }

    case 'recent': {
      const rows = getRecentMemories(db, namespace, limit, readScope);
      return rows.map(rowToMemory);
    }

    case 'important': {
      const rows = getImportantMemories(db, namespace, limit, readScope);
      return rows.map(rowToMemory);
    }

    case 'tags': {
      const raw = getNamespaceStats(db, namespace, readScope);
      // Return tags as a formatted string since the return type union includes string
      const lines = raw.top_tags.map((t) => `- ${t.tag}: ${t.count}`);
      return lines.length > 0 ? lines.join('\n') : 'No tags found.';
    }

    case 'export': {
      // Oldest first, decayed and compacted memories included, at most `limit` of
      // them. The complete store (with source segments and vectors, every page) is
      // exported on the host: `ironcurtain memory <persona|job> export`.
      const rows = getMemoryPage(db, namespace, 0, opts.limit ?? INSPECT_EXPORT_DEFAULT_LIMIT, readScope);
      return rows.length === 0 ? '' : rows.map((r) => JSON.stringify(rowToMemory(r))).join('\n') + '\n';
    }
  }
}

// ---------- Public factory ----------

/**
 * Create a MemoryEngine from a config by initializing all subsystems.
 * This is the production entry point.
 */
export function createMemoryEngineFromConfig(config: MemoryConfig): MemoryEngine {
  const db = initDatabase(config.dbPath, config.embeddingModel, { dimensions: config.embeddingDimensions });
  const forgetGuard: ForgetGuard = { snapshotSaved: false };
  let closed = false;

  // Consolidate what earlier sessions left unconsolidated, unless another server on
  // this database did so moments ago or is doing so now (runStartupMaintenance). Not
  // awaited, so it doesn't block initialization; a pass the engine's close cut short
  // is not an error.
  runStartupMaintenance(db, config).catch((err: unknown) => {
    if (!closed) console.error('[memory-server] Startup maintenance failed:', err);
  });

  return {
    async store(content: string, opts: StoreOptions): Promise<StoreResult> {
      const result = await storeImmediate(db, config, content, opts);
      startMaintenanceAfterWrites(db, config, result.action === 'created' ? 1 : 0);
      return result;
    },

    async ingest(content: string, opts: IngestOptions, controls?: CallControls): Promise<IngestResult> {
      return ingestBlob(db, config, content, opts, controls);
    },

    async recall(opts: RecallOptions, controls?: CallControls): Promise<RecallResult> {
      const result = await retrievalRecall(db, config, {
        query: opts.query,
        token_budget: opts.token_budget ?? config.defaultTokenBudget,
        tags: opts.tags,
        format: opts.format ?? 'summary',
        expand: opts.expand ?? 'auto',
        max_expand_passages: opts.max_expand_passages,
        signal: controls?.signal,
      });

      return {
        content: result.text,
        memories_used: result.selectedCount,
        total_matches: result.totalCandidates,
        expanded: result.expanded,
        expanded_segment_ids: result.expandedSegmentIds,
        source_segment_ids: result.sourceSegmentIds,
      };
    },

    async context(opts: ContextOptions, controls?: CallControls): Promise<string> {
      return buildContext(db, config, opts, controls?.signal);
    },

    async forget(opts: ForgetOptions): Promise<ForgetResult> {
      return forgetMemories(db, config, opts, forgetGuard);
    },

    inspect(opts: InspectOptions): Promise<MemoryStats | Memory[] | string> {
      return Promise.resolve(inspectMemories(db, config, opts));
    },

    async expand(segmentId: string, query?: string, maxPassages?: number): Promise<ExpandResult> {
      return expandSegment(db, config, segmentId, query, maxPassages);
    },

    close(): void {
      // A pass still running loses its database; another server may take over at once.
      closed = true;
      releaseMaintenanceLease(db, config.namespace);
      db.close();
    },
  };
}

/**
 * Start loading the embedding model (and the re-ranker, when it is enabled) now, so the
 * first tool call does not wait for it; on the first start they are downloaded first
 * (~130 MB), which could take longer than the call's deadline. Resolves when both are
 * loaded or one failed (logged; the model is then loaded again on first use).
 */
export async function preloadModels(config: MemoryConfig): Promise<void> {
  const loads: Array<Promise<unknown>> = [getEmbedder(config)];
  if (config.rerankerEnabled) loads.push(getReranker(config));
  try {
    await Promise.all(loads);
  } catch (err) {
    console.error('[memory-server] Preloading models failed:', err instanceof Error ? err.message : typeof err);
  }
}

/**
 * Create a MemoryEngine from pre-built modules (for testing).
 */
export interface EngineModules {
  store(content: string, opts: StoreOptions): Promise<StoreResult>;
  ingest(content: string, opts: IngestOptions, controls?: CallControls): Promise<IngestResult>;
  recall(opts: RecallOptions, controls?: CallControls): Promise<RecallResult>;
  context(opts: ContextOptions, controls?: CallControls): Promise<string>;
  forget(opts: ForgetOptions): Promise<ForgetResult>;
  inspect(opts: InspectOptions): Promise<MemoryStats | Memory[] | string>;
  expand(segmentId: string, query?: string, maxPassages?: number): Promise<ExpandResult>;
  close(): void;
}

export function createMemoryEngine(modules: EngineModules): MemoryEngine {
  return {
    store: (...args) => modules.store(...args),
    ingest: (...args) => modules.ingest(...args),
    recall: (...args) => modules.recall(...args),
    context: (...args) => modules.context(...args),
    forget: (...args) => modules.forget(...args),
    inspect: (...args) => modules.inspect(...args),
    expand: (...args) => modules.expand(...args),
    close: () => modules.close(),
  };
}
