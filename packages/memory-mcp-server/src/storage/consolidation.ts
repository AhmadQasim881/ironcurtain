/**
 * Deferred batch consolidation -- resolves duplicates and contradictions
 * among recently stored memories using a single batched LLM call.
 */

import type Database from 'better-sqlite3';
import type { MemoryConfig } from '../config.js';
import type { MemoryRow } from './database.js';
import {
  getUnconsolidatedMemories,
  markConsolidated,
  vectorSearchConsolidated,
  getEmbeddingsForMemories,
  getMemoriesByIds,
  mergeMemoryMetadata,
  updateMemoryContent,
  updateMemorySegmentIfRicher,
  setMemoryProvenance,
  deleteMemory,
  addSourceSegments,
  sourceSegmentsOf,
} from './queries.js';
import { readWriter } from '../utils/provenance.js';
import { reviewGroupOf } from '../utils/review.js';
import { cosineSimilarity } from '../embedding/embedder.js';
import { getLLMClient, batchJudgeMemoryRelations } from '../llm/client.js';
import type { CandidatePair, BatchJudgment, PairRelation } from '../llm/client.js';
import { parseTags, unionTags } from '../utils/tags.js';

const DEDUP_DISTANCE_THRESHOLD = 0.3;
const INTRA_BATCH_SIMILARITY = 0.7;
/** Consolidated neighbours each new memory is paired with (before the distance cut). */
const EXTERNAL_CANDIDATES = 5;

/**
 * Run the consolidation phase: find unconsolidated memories, group with
 * close existing memories, batch-judge via LLM, and apply merges/supersedes.
 */
export async function runConsolidation(
  db: Database.Database,
  config: MemoryConfig,
): Promise<{ consolidated: number; merged: number; superseded: number }> {
  const unconsolidated = getUnconsolidatedMemories(db, config.namespace, config.consolidationBatchSize);

  if (unconsolidated.length === 0) {
    return { consolidated: 0, merged: 0, superseded: 0 };
  }

  // If no LLM configured, just mark everything consolidated
  if (!getLLMClient(config)) {
    markConsolidated(
      db,
      config.namespace,
      unconsolidated.map((m) => m.id),
    );
    return { consolidated: unconsolidated.length, merged: 0, superseded: 0 };
  }

  // Batch-judge the pairs in one (or few) LLM calls, and apply the judgments. Only
  // reviewed memories are paired (buildCandidatePairs), so the text of a memory that
  // waits for review (an unattended run wrote it, maybe from content nobody checked)
  // never reaches the judge's prompt either, where it could steer how other pairs are
  // judged.
  const pairs = buildCandidatePairs(db, config.namespace, unconsolidated);
  const judgments: BatchJudgment[] = pairs.length === 0 ? [] : await batchJudgeMemoryRelations(config, pairs);
  const { merged, superseded, absorbed } = applyJudgments(db, config.namespace, pairs, judgments);

  // Mark all surviving unconsolidated memories as consolidated. That includes the
  // memories waiting for review, which were not paired: approving one queues it for
  // consolidation again (admin.ts markReviewed), against the reviewed memories. They are
  // marked only while they still wait, so an approval made while the LLM judged keeps
  // the memory queued.
  const surviving = unconsolidated.filter((m) => !absorbed.has(m.id));
  markConsolidated(
    db,
    config.namespace,
    surviving.filter(isReviewed).map((m) => m.id),
  );
  markConsolidated(
    db,
    config.namespace,
    surviving.filter((m) => !isReviewed(m)).map((m) => m.id),
    { onlyPending: true },
  );

  return { consolidated: unconsolidated.length, merged, superseded };
}

/**
 * Whether consolidation may pair, and change, a memory: only when it does not wait for
 * review (utils/review.ts). A pending memory is frozen until the user approves it: the
 * text, tags and source passage `ironcurtain memory ... review` listed are what an
 * approval releases to interactive sessions. Merging a newer pending row into it, or
 * letting one replace its text (a later run of the same job could, prompt-injected),
 * would change what the approval of its id releases after the user looked at it. So
 * pending memories are not deduplicated or corrected while they wait; once approved,
 * they are judged against the reviewed memories like any new memory.
 */
function isReviewed(row: Pick<MemoryRow, 'metadata'>): boolean {
  return reviewGroupOf(row.metadata) === '';
}

/**
 * Pair each unconsolidated memory with close CONSOLIDATED memories ("external" pairs,
 * new vs existing), then with close memories of the same batch ("intra-batch" pairs,
 * the later one in the oldest-first batch as new). Which fact is newer is decided when
 * a contradiction is applied, by created_at, not by the role in the pair.
 *
 * Every pair is judged by the LLM. Store-time dedup merges only identical text (see
 * utils/fact-text.ts), so near-identical pairs (distance < EXACT_DEDUP_DISTANCE) are
 * NOT skipped here: 'production' vs 'staging' is exactly such a pair.
 *
 * Both rows of a pair are reviewed memories (isReviewed): a memory waiting for review
 * is never paired, so it is neither merged into another memory nor changed by one,
 * whatever group the other belongs to. vectorSearchConsolidated returns reviewed
 * memories only.
 */
function buildCandidatePairs(db: Database.Database, namespace: string, unconsolidated: MemoryRow[]): CandidatePair[] {
  const reviewed = unconsolidated.filter(isReviewed);
  // Load all unconsolidated embeddings from DB once (they were stored at insert time)
  const embeddings = getEmbeddingsForMemories(
    db,
    namespace,
    reviewed.map((m) => m.id),
  );
  const pairs: CandidatePair[] = [];

  // The neighbour search is restricted to consolidated rows in SQL, so neither the
  // memory itself nor the rest of the batch can crowd a stale fact out of the top k.
  for (const mem of reviewed) {
    const memEmbedding = embeddings.get(mem.id);
    if (!memEmbedding) continue;
    for (const candidate of vectorSearchConsolidated(db, namespace, memEmbedding, EXTERNAL_CANDIDATES)) {
      if (candidate.distance >= DEDUP_DISTANCE_THRESHOLD) continue;
      pairs.push({
        newId: mem.id,
        newContent: mem.content,
        existingId: candidate.id,
        existingContent: candidate.content,
      });
    }
  }

  // Also check intra-batch similarities (unconsolidated vs unconsolidated)
  for (let i = 0; i < reviewed.length; i++) {
    const embA = embeddings.get(reviewed[i].id);
    if (!embA) continue;
    for (let j = i + 1; j < reviewed.length; j++) {
      const embB = embeddings.get(reviewed[j].id);
      if (!embB) continue;
      if (cosineSimilarity(embA, embB) > INTRA_BATCH_SIMILARITY) {
        pairs.push({
          newId: reviewed[j].id,
          newContent: reviewed[j].content,
          existingId: reviewed[i].id,
          existingContent: reviewed[i].content,
        });
      }
    }
  }

  return pairs;
}

/**
 * One relation per pair, by pair index. The model may answer out of order, skip a
 * pair or answer one twice: a skipped pair, an index out of range and a pair with
 * conflicting answers all count as 'distinct' (no change).
 */
function relationsByPair(pairCount: number, judgments: BatchJudgment[]): PairRelation[] {
  const answers = new Map<number, PairRelation | 'conflict'>();
  for (const judgment of judgments) {
    const index = judgment.pairIndex;
    if (!Number.isInteger(index) || index < 0 || index >= pairCount) continue;
    const prior = answers.get(index);
    answers.set(index, prior === undefined || prior === judgment.relation ? judgment.relation : 'conflict');
  }
  return Array.from({ length: pairCount }, (_, index) => {
    const answer = answers.get(index);
    return answer === undefined || answer === 'conflict' ? 'distinct' : answer;
  });
}

function isLive(row: MemoryRow | undefined): row is MemoryRow {
  return row !== undefined && row.importance > 0 && row.is_compacted === 0;
}

/**
 * What applying one pair did to its survivor: merged a duplicate, replaced its text
 * with a newer contradicting fact, or archived an older contradicting fact. With the
 * created_at of the newest statement of the fact the survivor's text now states, and
 * that text.
 */
interface Outcome {
  kind: 'merged' | 'replaced' | 'archived';
  contentTime: number;
  text: string;
}

/**
 * Apply the judgments in pair order. Each applied pair deletes its new row and folds
 * it into a SURVIVOR:
 *
 *  - Survivor map (union-find): `absorbedInto` records which row absorbed each deleted
 *    row, and a pair's existing side is resolved through it first. So a correction
 *    paired with a row that an earlier judgment already merged away lands on the row
 *    that row now lives in, instead of updating nothing and deleting the correction.
 *  - Every pair was judged against the existing row's text as it was when the pairs
 *    were built. A judgment is applied only while the survivor still states that fact
 *    (`states`): the row itself, or a row that absorbed it as a duplicate. Once a
 *    correction has replaced a survivor's text, older judgments about that text no
 *    longer apply (a "duplicate" of the replaced text would otherwise be deleted).
 *  - A pair whose new row is already gone, or whose sides resolve to one row, is
 *    skipped. Both rows are re-read (they may have changed or vanished while the LLM
 *    was judging) and the pair is skipped unless both are still live, still hold the
 *    texts this pass expects (the judged texts, or what this pass itself last wrote
 *    into the survivor) and still do not wait for review (isReviewed). A text another
 *    writer changed meanwhile (for example an overlapping maintenance pass) was never
 *    judged, so the judgment does not apply.
 *  - duplicate: the survivor keeps its text and gains the new row's tags, source (if it
 *    had none), segment (adopt or richer), importance (max) and timestamps (earliest
 *    created_at, latest last_accessed_at).
 *  - contradiction: the newer fact wins. When the new row is at least as recent as
 *    the fact the survivor currently states, its text, vector, source, segment, writer
 *    (`metadata.writer`) and first-seen time (created_at) replace the survivor's, and
 *    the replaced text (read from the survivor now, not when the pair was built) goes
 *    to the bounded superseded history with its own writer. Taking over created_at keeps "which fact is newer" answerable in later
 *    passes. When it is older (e.g. backdated with as_of), the survivor keeps its text
 *    and the older text goes to the history. Tags are unioned either way, so a tag
 *    forget still reaches the absorbed text.
 *  - every outcome: the source segments of both rows that the survivor does not link
 *    to are recorded in its `metadata.source_segments`, so forgetting it deletes them.
 *  - merged/superseded count only pairs that were actually written.
 */
function applyJudgments(
  db: Database.Database,
  namespace: string,
  pairs: CandidatePair[],
  judgments: BatchJudgment[],
): { merged: number; superseded: number; absorbed: Set<string> } {
  const relations = relationsByPair(pairs.length, judgments);
  const absorbedInto = new Map<string, string>();
  // Rows whose fact each touched survivor's text states (default: just itself).
  const states = new Map<string, Set<string>>();
  // created_at of the newest statement of that fact (default: the row's created_at).
  const contentTime = new Map<string, number>();
  // The text this pass last left in each touched survivor.
  const textOf = new Map<string, string>();
  const resolve = (id: string): string => {
    let current = id;
    for (let next = absorbedInto.get(current); next !== undefined; next = absorbedInto.get(current)) {
      current = next;
    }
    return current;
  };
  const statesOf = (id: string): Set<string> => states.get(id) ?? new Set([id]);

  let merged = 0;
  let superseded = 0;

  pairs.forEach((pair, index) => {
    const relation = relations[index];
    if (relation === 'distinct') return;
    if (absorbedInto.has(pair.newId)) return;
    const survivorId = resolve(pair.existingId);
    if (survivorId === pair.newId || !statesOf(survivorId).has(pair.existingId)) return;
    // A survivor this pass has not touched yet is the pair's existing row itself (a row
    // only resolves to another one after being absorbed into it), so its expected text
    // is the judged one.
    const expectedText = textOf.get(survivorId) ?? pair.existingContent;

    const apply = db.transaction((): Outcome | null => {
      const rows = getMemoriesByIds(db, namespace, [survivorId, pair.newId]);
      const survivor = rows.find((r) => r.id === survivorId);
      const incoming = rows.find((r) => r.id === pair.newId);
      if (!isLive(survivor) || !isLive(incoming)) return null;
      if (survivor.content !== expectedText || incoming.content !== pair.newContent) return null;
      // Re-checked on the rows as they are now (fail closed): a pending memory is never
      // changed, nor merged into another one (isReviewed).
      if (!isReviewed(survivor) || !isReviewed(incoming)) return null;

      const tags = unionTags(parseTags(survivor.tags), parseTags(incoming.tags));
      const survivorTime = contentTime.get(survivor.id) ?? survivor.created_at;
      // Every source segment of both rows states a text the survivor now holds (as its
      // text or in its superseded history); those it does not link to are recorded, so
      // forgetting the survivor deletes them all (queries.ts forgetMemoryRows).
      const sources = [...sourceSegmentsOf(survivor), ...sourceSegmentsOf(incoming)];

      // The new row is deleted first, so nothing is half-applied if that fails. Its
      // values (and, for a replacement, its vector) were read above.
      if (relation === 'duplicate') {
        if (!deleteMemory(db, namespace, incoming.id)) return null;
        mergeMemoryMetadata(db, namespace, survivor.id, {
          tags,
          importance: incoming.importance,
          source: incoming.source,
          createdAt: incoming.created_at,
          lastAccessedAt: incoming.last_accessed_at,
        });
        if (incoming.segment_id !== null) {
          updateMemorySegmentIfRicher(db, namespace, survivor.id, incoming.segment_id);
        }
        addSourceSegments(db, namespace, survivor.id, sources);
        return {
          kind: 'merged',
          contentTime: Math.max(survivorTime, incoming.created_at),
          text: survivor.content,
        };
      }

      if (incoming.created_at >= survivorTime) {
        const embedding = getEmbeddingsForMemories(db, namespace, [incoming.id]).get(incoming.id);
        if (!embedding || !deleteMemory(db, namespace, incoming.id)) return null;
        updateMemoryContent(
          db,
          namespace,
          survivor.id,
          incoming.content,
          embedding,
          incoming.importance,
          survivor.content,
          tags,
          readWriter(survivor.metadata),
        );
        setMemoryProvenance(db, namespace, survivor.id, {
          source: incoming.source,
          segmentId: incoming.segment_id,
          createdAt: incoming.created_at,
          lastAccessedAt: incoming.last_accessed_at,
          writer: readWriter(incoming.metadata),
        });
        addSourceSegments(db, namespace, survivor.id, sources);
        return { kind: 'replaced', contentTime: incoming.created_at, text: incoming.content };
      }

      if (!deleteMemory(db, namespace, incoming.id)) return null;
      mergeMemoryMetadata(db, namespace, survivor.id, {
        tags,
        importance: incoming.importance,
        supersededContent: incoming.content,
        supersededWriter: readWriter(incoming.metadata),
      });
      addSourceSegments(db, namespace, survivor.id, sources);
      return { kind: 'archived', contentTime: survivorTime, text: survivor.content };
    });

    const outcome = apply();
    if (outcome === null) return;
    absorbedInto.set(pair.newId, survivorId);
    contentTime.set(survivorId, outcome.contentTime);
    textOf.set(survivorId, outcome.text);
    if (outcome.kind === 'merged') {
      states.set(survivorId, new Set([...statesOf(survivorId), pair.newId]));
      merged++;
    } else {
      // A replaced text now states only the new row's fact; an archived one is unchanged.
      if (outcome.kind === 'replaced') states.set(survivorId, new Set([pair.newId]));
      superseded++;
    }
  });

  return { merged, superseded, absorbed: new Set(absorbedInto.keys()) };
}
