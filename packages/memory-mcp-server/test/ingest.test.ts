import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';

// ---- Mock the LLM client so extraction returns canned JSON, but the REAL ----
// ---- embedder + store/dedup/insert pipeline run end-to-end. ----
const llmMock = vi.hoisted(() => ({
  // A queue of responses; each llmComplete call shifts one. A non-array value
  // (null) simulates a hard LLM failure for that call.
  responses: [] as Array<string | null>,
  hasLLM: true,
  calls: 0,
  /** Runs inside each call, before it answers (e.g. to cancel the ingest mid-way). */
  during: null as null | (() => void),
}));

vi.mock('../src/llm/client.js', () => ({
  getLLMClient: vi.fn(() => (llmMock.hasLLM ? {} : null)),
  llmComplete: vi.fn(async () => {
    llmMock.calls += 1;
    llmMock.during?.();
    if (!llmMock.hasLLM) return null;
    const next = llmMock.responses.shift();
    return next === undefined ? null : next;
  }),
}));

// The real maintenance module, with its trigger observable: an ingest must count its
// writes once, after them, not run maintenance inside every Nth write.
vi.mock('../src/storage/maintenance.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/storage/maintenance.js')>();
  return {
    ...real,
    maybeRunMaintenance: vi.fn(real.maybeRunMaintenance),
    releaseMaintenanceLease: vi.fn(real.releaseMaintenanceLease),
  };
});

import { initDatabase } from '../src/storage/database.js';
import type { SegmentRow } from '../src/storage/database.js';
import { forgetMemoryRows, getNamespaceStats, getMemoriesByIds } from '../src/storage/queries.js';
import { createMemoryEngineFromConfig } from '../src/engine-impl.js';
import type { MemoryEngine, ProgressUpdate } from '../src/engine.js';
import type { MemoryConfig } from '../src/config.js';
import { loadConfig } from '../src/config.js';
import type { IngestResult } from '../src/types.js';
import { testModelEnv } from './helpers/test-models.js';
import {
  chunkBlob,
  extractAllFacts,
  MAX_FACTS_PER_INGEST,
  MAX_INGEST_CHUNK_TOKENS,
  MAX_INGEST_CHUNKS,
} from '../src/storage/extraction.js';
import { maybeRunMaintenance, releaseMaintenanceLease } from '../src/storage/maintenance.js';
import type { MaintenanceResult } from '../src/storage/maintenance.js';
import { handleIngest } from '../src/tools/ingest.js';
import { MAX_INGEST_CONTENT_BYTES, MAX_SOURCE_LENGTH } from '../src/tools/validation.js';

const NAMESPACE = 'test';

function setResponses(...responses: Array<string | null>): void {
  llmMock.responses = responses;
  llmMock.hasLLM = true;
  llmMock.calls = 0;
  llmMock.during = null;
}

function disableLLM(): void {
  llmMock.responses = [];
  llmMock.hasLLM = false;
  llmMock.calls = 0;
  llmMock.during = null;
}

function factsJson(facts: Array<{ fact: string; importance?: number }>): string {
  return JSON.stringify(facts);
}

function testConfig(dbPath: string): MemoryConfig {
  return {
    ...loadConfig(testModelEnv()),
    dbPath,
    namespace: NAMESPACE,
    // The mock controls LLM availability; set non-null so the engine path is "LLM on".
    llmApiKey: 'test-key',
    llmBaseUrl: 'http://localhost:1234/v1',
    // Avoid maintenance noise interleaving in small tests.
    maintenanceInterval: 10000,
  };
}

describe('engine.ingest', () => {
  let tmpDir: string;
  let dbPath: string;
  let engine: MemoryEngine;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memory-ingest-test-'));
    dbPath = join(tmpDir, 'test.db');
    const config = testConfig(dbPath);
    engine = createMemoryEngineFromConfig(config);
    db = initDatabase(dbPath, config.embeddingModel);
  });

  afterEach(() => {
    engine.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('decomposes a blob into N rows', async () => {
    setResponses(
      factsJson([
        { fact: 'The user is named Alice', importance: 0.9 },
        { fact: 'Alice prefers dark mode', importance: 0.6 },
        { fact: 'Alice works on the Iron project', importance: 0.5 },
      ]),
    );

    const result = await engine.ingest('conversation blob', { mode: 'document' });

    expect(result.created).toBe(3);
    expect(result.merged).toBe(0);
    expect(result.memory_ids).toHaveLength(3);

    const stats = getNamespaceStats(db, NAMESPACE);
    expect(stats.total_memories).toBe(3);

    const rows = getMemoriesByIds(db, NAMESPACE, result.memory_ids);
    const contents = rows.map((r) => r.content).sort();
    expect(contents).toEqual(['Alice prefers dark mode', 'Alice works on the Iron project', 'The user is named Alice']);
  });

  it('lands per-fact importance on rows, falling back to the seed when omitted', async () => {
    setResponses(
      factsJson([
        { fact: 'High salience fact', importance: 0.7 },
        { fact: 'Low salience fact', importance: 0.2 },
        { fact: 'No importance fact' }, // falls back to seed
      ]),
    );

    const result = await engine.ingest('blob', { importance: 0.5 });
    const rows = getMemoriesByIds(db, NAMESPACE, result.memory_ids);
    const byContent = new Map(rows.map((r) => [r.content, r.importance]));

    expect(byContent.get('High salience fact')).toBeCloseTo(0.7, 5);
    expect(byContent.get('Low salience fact')).toBeCloseTo(0.2, 5);
    expect(byContent.get('No importance fact')).toBeCloseTo(0.5, 5);
  });

  it('dry_run writes nothing but returns the facts', async () => {
    setResponses(
      factsJson([{ fact: 'Fact one', importance: 0.7 }, { fact: 'Fact two', importance: 0.3 }, { fact: 'Fact three' }]),
    );

    const result = await engine.ingest('blob', { dry_run: true });

    expect(result.created).toBe(0);
    expect(result.facts).toHaveLength(3);
    expect(result.facts[0].importance).toBe(0.7);
    expect(getNamespaceStats(db, NAMESPACE).total_memories).toBe(0);
  });

  describe('as_of stamping (created path)', () => {
    const T_OLD = Date.parse('2023-03-01T00:00:00.000Z');

    it('stamps created/updated/last_accessed to a numeric as_of', async () => {
      setResponses(factsJson([{ fact: 'Backdated fact', importance: 0.5 }]));
      const result = await engine.ingest('blob', { as_of: T_OLD });

      const [row] = getMemoriesByIds(db, NAMESPACE, result.memory_ids);
      expect(row.created_at).toBe(T_OLD);
      expect(row.updated_at).toBe(T_OLD);
      expect(row.last_accessed_at).toBe(T_OLD);
    });

    it('omitting as_of yields created_at ≈ Date.now()', async () => {
      setResponses(factsJson([{ fact: 'Current fact', importance: 0.5 }]));
      const before = Date.now();
      const result = await engine.ingest('blob', {});
      const after = Date.now();
      const [row] = getMemoriesByIds(db, NAMESPACE, result.memory_ids);
      expect(row.created_at).toBeGreaterThanOrEqual(before);
      expect(row.created_at).toBeLessThanOrEqual(after);
    });
  });

  describe('order-independent merge timestamps (A1)', () => {
    const T_OLD = Date.parse('2022-01-01T00:00:00.000Z');
    const T_NEW = Date.parse('2024-06-01T00:00:00.000Z');
    const FACT = 'Alice prefers dark mode';

    // NOTE on updated_at: the merge calls mergeMemoryMetadata (which stamps
    // updated_at = now) BEFORE updateMemoryTimestampsOnMerge runs MAX(updated_at, asOf).
    // With asOf in the past, MAX(now, asOf) === now, so updated_at lands at ~now
    // (the true "last touched" time — the merge just happened). created_at (MIN) and
    // last_accessed_at (MAX, untouched by the metadata merge) are the clean reconciled
    // values. This is the design's §5.4 SQL composed faithfully; see the report.
    it('reconciles min(created)/max(last_accessed) when newer merges into older', async () => {
      setResponses(factsJson([{ fact: FACT, importance: 0.5 }]));
      const first = await engine.ingest('blob A', { as_of: T_OLD });

      const before = Date.now();
      setResponses(factsJson([{ fact: FACT, importance: 0.5 }]));
      const second = await engine.ingest('blob B', { as_of: T_NEW });
      const after = Date.now();

      expect(second.created).toBe(0);
      expect(second.merged).toBe(1);
      expect(second.memory_ids[0]).toBe(first.memory_ids[0]);

      const [row] = getMemoriesByIds(db, NAMESPACE, first.memory_ids);
      expect(row.created_at).toBe(T_OLD); // MIN(T_OLD, T_NEW)
      expect(row.last_accessed_at).toBe(T_NEW); // MAX(T_OLD, T_NEW)
      expect(row.updated_at).toBeGreaterThanOrEqual(before); // MAX(now, T_NEW) === now
      expect(row.updated_at).toBeLessThanOrEqual(after);
    });

    it('is order-independent: same survivor created/last_accessed in reverse ingest order', async () => {
      setResponses(factsJson([{ fact: FACT, importance: 0.5 }]));
      const first = await engine.ingest('blob B', { as_of: T_NEW });

      setResponses(factsJson([{ fact: FACT, importance: 0.5 }]));
      const second = await engine.ingest('blob A', { as_of: T_OLD });

      expect(second.merged).toBe(1);
      expect(second.memory_ids[0]).toBe(first.memory_ids[0]);

      const [row] = getMemoriesByIds(db, NAMESPACE, first.memory_ids);
      // Same reconciled values regardless of which order the two as_ofs arrived.
      expect(row.created_at).toBe(T_OLD); // MIN
      expect(row.last_accessed_at).toBe(T_NEW); // MAX
    });

    it('a non-as_of merge leaves created_at untouched and bumps updated_at', async () => {
      setResponses(factsJson([{ fact: FACT, importance: 0.5 }]));
      const first = await engine.ingest('blob A', { as_of: T_OLD });

      setResponses(factsJson([{ fact: FACT, importance: 0.5 }]));
      const second = await engine.ingest('blob B', {}); // no as_of

      expect(second.merged).toBe(1);
      const [row] = getMemoriesByIds(db, NAMESPACE, first.memory_ids);
      expect(row.created_at).toBe(T_OLD); // untouched (min not invoked)
      expect(row.updated_at).toBeGreaterThan(T_OLD); // bumped to ~now by the metadata merge
    });

    // Proves the MAX(updated_at, ?) clause is LIVE rather than dead. Every other A1
    // test uses a PAST as_of, where the merge already stamped updated_at=now and
    // MAX(now, past)=now — so the clause never moves the value. Only a FUTURE as_of
    // (> the existing updated_at, i.e. > now) makes MAX pick the as_of, which is the
    // assertion below. as_of may lie at most 5 minutes ahead (clock skew), so the
    // test uses 2 minutes. For the realistic backfill case (a PAST as_of, e.g. a
    // multi-year export) updated_at correctly stays ≈ now — the merge just happened —
    // which is exactly what the two reconcile tests above already verify.
    it('moves updated_at to a FUTURE as_of greater than the existing updated_at (A1 — MAX clause is live)', async () => {
      const T_FUTURE = Date.now() + 2 * 60 * 1000; // 2 minutes ahead: > now, within the allowed skew

      setResponses(factsJson([{ fact: FACT, importance: 0.5 }]));
      const first = await engine.ingest('blob A', {}); // created at ~now

      setResponses(factsJson([{ fact: FACT, importance: 0.5 }]));
      const second = await engine.ingest('blob B', { as_of: T_FUTURE });

      expect(second.merged).toBe(1);
      const [row] = getMemoriesByIds(db, NAMESPACE, first.memory_ids);
      // MAX(updated_at≈now, T_FUTURE) === T_FUTURE — the clause actually moved it.
      expect(row.updated_at).toBe(T_FUTURE);
      // last_accessed_at = MAX(≈now, T_FUTURE) likewise advances.
      expect(row.last_accessed_at).toBe(T_FUTURE);
      // created_at = MIN(≈now, T_FUTURE) stays at the original (~now), not the future.
      expect(row.created_at).toBeLessThan(T_FUTURE);
    });

    it('rejects an as_of more than 5 minutes ahead before extracting or writing anything', async () => {
      setResponses(factsJson([{ fact: FACT, importance: 0.5 }]));
      const farFuture = Date.parse('2100-01-01T00:00:00.000Z');

      await expect(engine.ingest('blob', { as_of: farFuture })).rejects.toThrow(/5 minutes in the future/);
      await expect(engine.store(FACT, { createdAt: Date.now() + 10 * 60 * 1000 })).rejects.toThrow(/5 minutes/);

      expect(llmMock.calls).toBe(0);
      expect(getNamespaceStats(db, NAMESPACE).total_memories).toBe(0);
      expect(db.prepare(`SELECT COUNT(*) AS c FROM segments`).get()).toEqual({ c: 0 });
    });
  });

  describe('merge importance composes (A1/A2)', () => {
    const FACT = 'Bob lives in Berlin';

    it('a higher-importance duplicate raises the survivor importance', async () => {
      setResponses(factsJson([{ fact: FACT, importance: 0.3 }]));
      const first = await engine.ingest('blob', {});

      setResponses(factsJson([{ fact: FACT, importance: 0.7 }]));
      await engine.ingest('blob', {});

      const [row] = getMemoriesByIds(db, NAMESPACE, first.memory_ids);
      expect(row.importance).toBeCloseTo(0.7, 5);
    });

    it('a lower-importance duplicate does not lower the survivor importance', async () => {
      setResponses(factsJson([{ fact: FACT, importance: 0.8 }]));
      const first = await engine.ingest('blob', {});

      setResponses(factsJson([{ fact: FACT, importance: 0.1 }]));
      await engine.ingest('blob', {});

      const [row] = getMemoriesByIds(db, NAMESPACE, first.memory_ids);
      expect(row.importance).toBeCloseTo(0.8, 5);
    });
  });

  it('reports honest stats when a fact duplicates an existing row (A7)', async () => {
    setResponses(factsJson([{ fact: 'Existing fact', importance: 0.5 }]));
    await engine.ingest('blob', {});

    setResponses(
      factsJson([
        { fact: 'Existing fact', importance: 0.5 }, // duplicate → merged
        { fact: 'Brand new fact one', importance: 0.5 },
        { fact: 'Brand new fact two', importance: 0.5 },
      ]),
    );
    const result = await engine.ingest('blob', {});

    expect(result.created).toBe(2);
    expect(result.merged).toBe(1);
    expect(result.memory_ids).toHaveLength(3);
  });

  describe('extraction failure handling (A3)', () => {
    it("default 'degrade' with no LLM stores the blob as a single memory", async () => {
      disableLLM();
      const blob = 'unstructured content with no LLM available';
      const result = await engine.ingest(blob, {});

      expect(result.created).toBe(1);
      expect(result.degraded).toBe(true);
      const stats = getNamespaceStats(db, NAMESPACE);
      expect(stats.total_memories).toBe(1);
      const [row] = getMemoriesByIds(db, NAMESPACE, result.memory_ids);
      expect(row.content).toBe(blob);
    });

    it('degrade reports merged (not created) when the blob exact-dedups into an existing memory', async () => {
      disableLLM();
      const blob = 'identical degraded blob with no durable facts';
      const first = await engine.ingest(blob, {});
      expect(first.created).toBe(1);
      expect(first.merged).toBe(0);

      const second = await engine.ingest(blob, {}); // same content → exact-dedup merge
      expect(second.created).toBe(0);
      expect(second.merged).toBe(1);
      expect(second.degraded).toBe(true);
      expect(getNamespaceStats(db, NAMESPACE).total_memories).toBe(1); // merged, not a 2nd row
    });

    it("'skip' writes nothing and reports skipped without throwing", async () => {
      disableLLM();
      const result = await engine.ingest('blob', { on_extraction_failure: 'skip' });

      expect(result.created).toBe(0);
      expect(result.skipped).toBe(true);
      expect(getNamespaceStats(db, NAMESPACE).total_memories).toBe(0);
    });

    it("'error' rejects, with no input substring in the message (A6)", async () => {
      disableLLM();
      const sensitive = 'CREDIT-CARD-4111-1111-1111-1111';
      await expect(engine.ingest(`secret blob ${sensitive}`, { on_extraction_failure: 'error' })).rejects.toThrow();

      try {
        await engine.ingest(`secret blob ${sensitive}`, { on_extraction_failure: 'error' });
        throw new Error('expected ingest to reject');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        expect(message).not.toContain(sensitive);
      }
    });

    it('malformed (non-JSON) response degrades to a single-blob store (does not throw)', async () => {
      setResponses('not json at all');
      const result = await engine.ingest('blob to degrade', {});

      expect(result.degraded).toBe(true);
      expect(result.created).toBe(1);
      expect(getNamespaceStats(db, NAMESPACE).total_memories).toBe(1);
    });

    it('a valid empty extraction ([]) is a clean 0-fact ingest, NOT a failure (no degrade/skip)', async () => {
      // The prompt instructs the model to emit [] when nothing durable is present.
      // That is a successful parse, so it must not inflate failed_chunks, must not
      // degrade to a single-blob store, and must write nothing.
      setResponses('[]');
      const result = await engine.ingest('chit-chat with no durable facts', {});

      expect(result.created).toBe(0);
      expect(result.facts).toEqual([]);
      expect(result.degraded).toBeFalsy();
      expect(result.skipped).toBeFalsy();
      expect(result.partial).toBeFalsy();
      expect(getNamespaceStats(db, NAMESPACE).total_memories).toBe(0);
    });
  });

  it('propagates seed tags and source to every written fact', async () => {
    setResponses(
      factsJson([
        { fact: 'Tagged fact one', importance: 0.5 },
        { fact: 'Tagged fact two', importance: 0.5 },
      ]),
    );
    const result = await engine.ingest('blob', { tags: ['seed-tag'], source: 'session:abc' });

    const rows = getMemoriesByIds(db, NAMESPACE, result.memory_ids);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.source).toBe('session:abc');
      expect(row.tags).toContain('seed-tag');
    }
  });

  describe('chunking integration (A5)', () => {
    function bigBlob(): string {
      // ~150 chars/line × 250 lines ≈ 9400 tokens → ~2-3 chunks (keeps embeds cheap).
      const line = 'sentence words here '.repeat(8).trim();
      return Array.from({ length: 250 }, (_, i) => `${i}: ${line}`).join('\n');
    }

    it('makes >1 LLM call, unions facts, and reports chunks>1', async () => {
      // Two distinct facts per chunk; enough responses for however many chunks form.
      const perChunk = (n: number): string => factsJson([{ fact: `chunk ${n} fact A` }, { fact: `chunk ${n} fact B` }]);
      setResponses(...Array.from({ length: 50 }, (_, i) => perChunk(i)));

      const result = await engine.ingest(bigBlob(), { mode: 'document' });

      expect(llmMock.calls).toBeGreaterThan(1);
      expect(result.chunks).toBeGreaterThan(1);
      expect(result.created).toBeGreaterThan(2); // facts from multiple chunks unioned
    });
  });

  describe('partial extraction is observable (A3)', () => {
    function bigBlob(): string {
      // ~150 chars/line × 250 lines ≈ 9400 tokens → ~2-3 chunks (keeps embeds cheap).
      const line = 'sentence words here '.repeat(8).trim();
      return Array.from({ length: 250 }, (_, i) => `${i}: ${line}`).join('\n');
    }

    it('ingests good chunks and flags partial/degraded/failed_chunks when one chunk fails', async () => {
      // First chunk → facts; all subsequent chunks → null (hard LLM failure).
      // The two facts must be semantically unrelated (not "fact A"/"fact B" one-char
      // variants) so they stay well clear of EXACT_DEDUP_DISTANCE and are never merged
      // at store time — this test asserts both are created, and must not balance on the
      // dedup knife-edge (embedding output shifts across model/runtime versions).
      const responses: Array<string | null> = [
        factsJson([
          { fact: 'The Eiffel Tower is located in Paris' },
          { fact: 'Honey never spoils if stored properly' },
        ]),
      ];
      for (let i = 0; i < 49; i++) responses.push(null);
      setResponses(...responses);

      const result = await engine.ingest(bigBlob(), { mode: 'document' });

      expect(result.created).toBeGreaterThanOrEqual(2);
      expect(result.partial).toBe(true);
      expect(result.degraded).toBe(true);
      expect(result.failed_chunks).toBeGreaterThanOrEqual(1);
      expect(result.chunks).toBeGreaterThan(1);
    });
  });

  describe('segment linking (parent-context retention)', () => {
    function allSegments(): SegmentRow[] {
      return db.prepare(`SELECT * FROM segments WHERE namespace = ?`).all(NAMESPACE) as SegmentRow[];
    }

    it('stores one segment, links every fact to it, and reports segments_created', async () => {
      setResponses(
        factsJson([
          { fact: 'The user is named Alice', importance: 0.9 },
          { fact: 'Alice prefers dark mode', importance: 0.6 },
          { fact: 'Alice works on the Iron project', importance: 0.5 },
        ]),
      );

      const blob = 'Conversation: Alice said she is Alice, prefers dark mode, works on Iron.';
      const result = await engine.ingest(blob, { mode: 'document' });

      expect(result.segments_created).toBe(1);

      const segments = allSegments();
      expect(segments).toHaveLength(1);
      expect(segments[0].content).toBe(blob);
      expect(segments[0].fact_count).toBe(3);

      const rows = getMemoriesByIds(db, NAMESPACE, result.memory_ids);
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.segment_id).toBe(segments[0].id);
      }
    });

    it('multi-chunk: writes a segment per chunk; a boundary-deduped fact stays on its first chunk', async () => {
      function bigBlob(): string {
        const line = 'sentence words here '.repeat(8).trim();
        return Array.from({ length: 250 }, (_, i) => `${i}: ${line}`).join('\n');
      }
      // First chunk yields fact A (and a SHARED fact); every later chunk re-emits the
      // SHARED fact (deduped away) plus its own distinct fact.
      const responses: string[] = [factsJson([{ fact: 'chunk-0 distinct fact' }, { fact: 'SHARED boundary fact' }])];
      for (let i = 1; i < 50; i++) {
        responses.push(factsJson([{ fact: 'SHARED boundary fact' }, { fact: `chunk-${i} distinct fact` }]));
      }
      setResponses(...responses);

      const result = await engine.ingest(bigBlob(), { mode: 'document' });

      const segments = allSegments();
      expect(segments.length).toBeGreaterThanOrEqual(2);
      expect(result.segments_created).toBe(segments.length);

      // The shared boundary fact must be linked to exactly ONE segment (the first
      // chunk's), not duplicated across the chunks that re-emitted it.
      const rows = getMemoriesByIds(db, NAMESPACE, result.memory_ids);
      const sharedRows = rows.filter((r) => r.content === 'SHARED boundary fact');
      expect(sharedRows).toHaveLength(1);

      // Its parent is the FIRST chunk's segment (the one whose other fact is chunk-0's).
      const chunk0Row = rows.find((r) => r.content === 'chunk-0 distinct fact');
      expect(chunk0Row).toBeDefined();
      expect(sharedRows[0].segment_id).toBe(chunk0Row?.segment_id);
    });

    it('backdates the segment created_at to as_of (matches the facts)', async () => {
      const T_OLD = Date.parse('2023-03-01T00:00:00.000Z');
      setResponses(factsJson([{ fact: 'Backdated fact', importance: 0.5 }]));

      const result = await engine.ingest('historical blob', { as_of: T_OLD });

      const segments = allSegments();
      expect(segments).toHaveLength(1);
      expect(segments[0].created_at).toBe(T_OLD);

      const [row] = getMemoriesByIds(db, NAMESPACE, result.memory_ids);
      expect(row.created_at).toBe(T_OLD);
    });

    it('degrade single-blob writes a fact with NULL segment and NO segment row', async () => {
      disableLLM();
      const result = await engine.ingest('unstructured content, no LLM', {});

      expect(result.degraded).toBe(true);
      expect(result.created).toBe(1);
      expect(result.segments_created).toBeUndefined();
      expect(allSegments()).toHaveLength(0);

      const [row] = getMemoriesByIds(db, NAMESPACE, result.memory_ids);
      expect(row.segment_id).toBeNull();
    });

    it('dry_run writes neither facts nor segments', async () => {
      setResponses(factsJson([{ fact: 'Preview fact', importance: 0.5 }]));
      const result = await engine.ingest('blob', { dry_run: true });

      expect(result.facts).toHaveLength(1);
      expect(result.segments_created).toBeUndefined();
      expect(allSegments()).toHaveLength(0);
      expect(getNamespaceStats(db, NAMESPACE).total_memories).toBe(0);
    });

    describe('merge repoints survivor to the richer parent (A4)', () => {
      const FACT = 'Distribution cap is $250k';

      // A 1-fact segment then a 5-fact segment (or vice-versa); the survivor must end
      // up pointing at the 5-fact (richer) segment regardless of ingest order.
      async function ingestPoorSegment(): Promise<string[]> {
        setResponses(factsJson([{ fact: FACT, importance: 0.5 }]));
        const r = await engine.ingest('poor blob', {});
        return r.memory_ids;
      }

      async function ingestRichSegment(): Promise<void> {
        setResponses(
          factsJson([
            { fact: FACT, importance: 0.5 }, // the duplicate that merges
            { fact: 'Rich extra fact 1' },
            { fact: 'Rich extra fact 2' },
            { fact: 'Rich extra fact 3' },
            { fact: 'Rich extra fact 4' },
          ]),
        );
        await engine.ingest('rich blob with many clauses', {});
      }

      function richSegmentId(): string {
        const segs = db.prepare(`SELECT * FROM segments WHERE namespace = ?`).all(NAMESPACE) as SegmentRow[];
        const rich = segs.find((s) => s.fact_count === 5);
        expect(rich).toBeDefined();
        return rich?.id ?? '';
      }

      it('poor-then-rich: survivor adopts the richer (5-fact) parent', async () => {
        const [survivorId] = await ingestPoorSegment();
        await ingestRichSegment();

        const [row] = getMemoriesByIds(db, NAMESPACE, [survivorId]);
        expect(row.segment_id).toBe(richSegmentId());
      });

      it('rich-then-poor: survivor keeps the richer (5-fact) parent (order-independent)', async () => {
        await ingestRichSegment();
        // The rich ingest created the survivor row already; capture it.
        const richRows = db
          .prepare(`SELECT id FROM memories WHERE namespace = ? AND content = ?`)
          .all(NAMESPACE, FACT) as Array<{ id: string }>;
        expect(richRows).toHaveLength(1);
        const survivorId = richRows[0].id;
        const richId = richSegmentId();

        // Now a poorer (1-fact) ingest of the same fact merges — it must NOT downgrade.
        setResponses(factsJson([{ fact: FACT, importance: 0.5 }]));
        await engine.ingest('poor blob', {});

        const [row] = getMemoriesByIds(db, NAMESPACE, [survivorId]);
        expect(row.segment_id).toBe(richId);
      });

      function survivorRowId(): string {
        const rows = db
          .prepare(`SELECT id FROM memories WHERE namespace = ? AND content = ?`)
          .all(NAMESPACE, FACT) as Array<{ id: string }>;
        expect(rows).toHaveLength(1);
        return rows[0].id;
      }

      it('equal fact_count tie keeps the ORIGINAL parent (does not repoint to the incoming)', async () => {
        // First ingest: a 2-fact segment carrying FACT (fact_count = 2).
        setResponses(factsJson([{ fact: FACT, importance: 0.5 }, { fact: 'First-segment extra fact' }]));
        await engine.ingest('first blob with two facts', {});
        const survivorId = survivorRowId();
        const firstSegmentId = getMemoriesByIds(db, NAMESPACE, [survivorId])[0].segment_id;
        expect(firstSegmentId).not.toBeNull();

        // Second ingest from a DIFFERENT segment, also fact_count = 2, re-emitting FACT
        // (exact-dedup merge) → a TIE on fact_count.
        setResponses(factsJson([{ fact: FACT, importance: 0.5 }, { fact: 'Second-segment extra fact' }]));
        const second = await engine.ingest('second blob with two facts', {});
        expect(second.merged).toBe(1);

        // Sanity: two distinct segments exist, both with fact_count = 2 (genuine tie).
        const segs = db.prepare(`SELECT * FROM segments WHERE namespace = ?`).all(NAMESPACE) as SegmentRow[];
        expect(segs).toHaveLength(2);
        expect(segs.every((s) => s.fact_count === 2)).toBe(true);
        const incomingSegmentId = segs.find((s) => s.id !== firstSegmentId)?.id;
        expect(incomingSegmentId).toBeDefined();

        // Tie → survivor keeps its ORIGINAL parent, NOT the incoming one (read back the row).
        const [row] = getMemoriesByIds(db, NAMESPACE, [survivorId]);
        expect(row.segment_id).toBe(firstSegmentId);
        expect(row.segment_id).not.toBe(incomingSegmentId);
      });

      it('a NULL-parent (store-path) survivor adopts the incoming segment on merge', async () => {
        // store() never sets a segment_id → the survivor starts with segment_id = NULL.
        const stored = await engine.store(FACT, { importance: 0.5 });
        const survivorId = stored.id;
        expect(getMemoriesByIds(db, NAMESPACE, [survivorId])[0].segment_id).toBeNull();

        // An ingest re-emitting FACT writes a segment and merges into the store-path row.
        setResponses(factsJson([{ fact: FACT, importance: 0.5 }, { fact: 'Incoming extra fact' }]));
        const result = await engine.ingest('blob carrying a segment', {});
        expect(result.merged).toBe(1);

        const incomingSegmentId = (
          db.prepare(`SELECT * FROM segments WHERE namespace = ?`).all(NAMESPACE) as SegmentRow[]
        ).find((s) => s.fact_count === 2)?.id;
        expect(incomingSegmentId).toBeDefined();

        // Was NULL, now repointed to the incoming segment (read back from the DB).
        const [row] = getMemoriesByIds(db, NAMESPACE, [survivorId]);
        expect(row.segment_id).toBe(incomingSegmentId);
      });
    });
  });

  describe('PII-safe logging on failure (A6)', () => {
    it('does not leak a sensitive marker to ANY stderr channel on parse failure or LLM error', async () => {
      // Widened beyond console.error to also cover process.stderr.write and
      // console.warn — future-proofs the guarantee against a regression that emits
      // via a different channel (T3).
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const sensitive = 'PASSPORT-X9988776655';

      // Parse failure: non-JSON response containing the marker would only be in `raw`.
      setResponses(`I refuse. The input mentioned ${sensitive}.`);
      const r1 = await engine.ingest(`blob with ${sensitive}`, {});
      expect(r1.degraded).toBe(true);

      // LLM error path.
      disableLLM();
      const r2 = await engine.ingest(`another blob ${sensitive}`, { on_extraction_failure: 'skip' });
      expect(r2.skipped).toBe(true);

      const allLogs = [...errorSpy.mock.calls, ...warnSpy.mock.calls, ...stderrSpy.mock.calls]
        .map((c) => JSON.stringify(c))
        .join('\n');
      expect(allLogs).not.toContain(sensitive);

      errorSpy.mockRestore();
      warnSpy.mockRestore();
      stderrSpy.mockRestore();
    });
  });
});

// ---------- Bounded spend, cancellation, progress, retries (WP-94) ----------

describe('engine.ingest bounds', () => {
  let tmpDir: string;
  let dbPath: string;
  let config: MemoryConfig;
  let engine: MemoryEngine;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memory-ingest-bounds-'));
    dbPath = join(tmpDir, 'test.db');
    config = testConfig(dbPath);
    engine = createMemoryEngineFromConfig(config);
    db = initDatabase(dbPath, config.embeddingModel);
    vi.mocked(maybeRunMaintenance).mockClear();
  });

  afterEach(() => {
    engine.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  /** ~19,000-token blob: three or four chunks. */
  function multiChunkBlob(): string {
    const line = 'sentence words here '.repeat(8).trim();
    return Array.from({ length: 450 }, (_, i) => `${i}: ${line}`).join('\n');
  }

  /** One extraction response with `count` distinct facts for chunk `chunk`. */
  function manyFacts(chunk: number, count: number): string {
    return factsJson(Array.from({ length: count }, (_, i) => ({ fact: `chunk ${chunk} fact number ${i}` })));
  }

  it('rejects a 1 MB ingest before calling the LLM, through the tool and through the engine', async () => {
    setResponses(factsJson([{ fact: 'never extracted' }]));
    const huge = 'x'.repeat(1024 * 1024);

    await expect(handleIngest(engine, { content: huge })).rejects.toThrow(/exceeds the maximum of 204800 bytes/);
    await expect(engine.ingest(huge, {})).rejects.toThrow(/exceeds the maximum/);
    await expect(engine.ingest(huge, { dry_run: true })).rejects.toThrow(/exceeds the maximum/);

    expect(llmMock.calls).toBe(0);
    expect(getNamespaceStats(db, NAMESPACE).total_memories).toBe(0);
  });

  it('measures the cap in UTF-8 bytes and accepts content right at it', async () => {
    // 3-byte characters: under the cap in characters, over it in bytes.
    await expect(engine.ingest('€'.repeat(MAX_INGEST_CONTENT_BYTES / 2), { dry_run: true })).rejects.toThrow(
      /exceeds the maximum/,
    );
    setResponses(...Array.from({ length: MAX_INGEST_CHUNKS }, () => '[]'));
    const atCap = 'y'.repeat(MAX_INGEST_CONTENT_BYTES);
    await expect(engine.ingest(atCap, { dry_run: true })).resolves.toMatchObject({ created: 0 });
  });

  it('rejects a source label longer than 256 characters', async () => {
    setResponses(factsJson([{ fact: 'never extracted' }]));
    const source = 's'.repeat(MAX_SOURCE_LENGTH + 1);
    await expect(handleIngest(engine, { content: 'blob', source })).rejects.toThrow(
      /source exceeds maximum length of 256/,
    );
    await expect(engine.ingest('blob', { source })).rejects.toThrow(/source exceeds maximum length/);
    expect(llmMock.calls).toBe(0);
  });

  it('a 50-chunk ingest stops calling the LLM at the per-ingest fact cap', async () => {
    // Well over 50 chunks of content: chunking stops at MAX_INGEST_CHUNKS.
    const line = 'filler words for one chunk of a very long document '.repeat(4);
    const content = Array.from({ length: MAX_INGEST_CHUNKS * 150 }, (_, i) => `${i} ${line}`).join('\n');
    expect(chunkBlob(content)).toHaveLength(MAX_INGEST_CHUNKS);
    // Every chunk yields 10 new facts, so 20 chunks fill the 200-fact cap.
    setResponses(...Array.from({ length: MAX_INGEST_CHUNKS }, (_, i) => manyFacts(i, 10)));

    const outcome = await extractAllFacts(config, content, 'document');

    expect(llmMock.calls).toBe(MAX_FACTS_PER_INGEST / 10);
    expect(outcome.groups.flatMap((g) => g.facts)).toHaveLength(MAX_FACTS_PER_INGEST);
    expect(outcome.totalChunks).toBe(MAX_INGEST_CHUNKS);
    expect(outcome.droppedChunks).toBe(MAX_INGEST_CHUNKS - MAX_FACTS_PER_INGEST / 10);
    expect(outcome.truncated).toBe(true);
  });

  it('caps the facts of one ingest across chunks, dry run included, and says what was left out', async () => {
    const blob = multiChunkBlob();
    const chunks = chunkBlob(blob).length;
    expect(chunks).toBeGreaterThanOrEqual(3);
    // 150 facts per chunk: the second chunk fills the cap, the rest are never extracted.
    setResponses(...Array.from({ length: chunks }, (_, i) => manyFacts(i, 150)));

    const result = await engine.ingest(blob, { dry_run: true });

    expect(llmMock.calls).toBe(2);
    expect(result.facts).toHaveLength(MAX_FACTS_PER_INGEST);
    expect(result.truncated).toBe(true);
    expect(result.dropped_chunks).toBe(chunks - 2);
    expect(result.chunks).toBe(chunks);
  });

  it('runs maintenance once after an ingest, counting every fact it created', async () => {
    setResponses(
      factsJson([
        { fact: 'The office is in Lisbon' },
        { fact: 'Standups are at nine' },
        { fact: 'The build uses Node 24' },
      ]),
    );

    const result = await engine.ingest('blob', {});

    expect(result.created).toBe(3);
    expect(maybeRunMaintenance).toHaveBeenCalledTimes(1);
    expect(maybeRunMaintenance).toHaveBeenCalledWith(expect.anything(), expect.anything(), 3);
  });

  it('returns without waiting for the maintenance pass its writes started', async () => {
    // A pass that never ends, as with an LLM endpoint that hangs: a store or ingest that
    // waited for it would never answer (the relay gives up on it after 300 s).
    const endless = (): Promise<MaintenanceResult> => new Promise<MaintenanceResult>(() => undefined);
    vi.mocked(maybeRunMaintenance).mockImplementationOnce(endless).mockImplementationOnce(endless);
    setResponses(factsJson([{ fact: 'The office is in Lisbon' }]));

    await expect(engine.ingest('blob', {})).resolves.toMatchObject({ created: 1 });
    await expect(engine.store('Standups are at nine', {})).resolves.toMatchObject({ action: 'created' });

    expect(maybeRunMaintenance).toHaveBeenCalledTimes(2);
    expect(getNamespaceStats(db, NAMESPACE).total_memories).toBe(2);
  });

  it('logs a background pass that fails, but not one that the engine’s close cut short', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fails = (): Promise<MaintenanceResult> => Promise.reject(new TypeError('pass failed'));
    const maintenanceErrors = (): unknown[][] =>
      errors.mock.calls.filter((call) => call[0] === '[memory-server] Maintenance failed:');
    const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

    vi.mocked(maybeRunMaintenance).mockImplementationOnce(fails);
    await expect(engine.store('A fact whose pass fails', {})).resolves.toMatchObject({ action: 'created' });
    await settle();
    expect(maintenanceErrors()).toEqual([['[memory-server] Maintenance failed:', 'TypeError']]);

    const closing = createMemoryEngineFromConfig({ ...config, namespace: 'closing-pass' });
    let cutShort: (err: Error) => void = () => undefined;
    vi.mocked(maybeRunMaintenance).mockImplementationOnce(
      () =>
        new Promise<MaintenanceResult>((_resolve, reject) => {
          cutShort = reject;
        }),
    );
    await closing.store('A fact whose pass outlives the engine', {});
    closing.close();
    cutShort(new TypeError('The database connection is not open'));
    await settle();
    expect(maintenanceErrors()).toHaveLength(1);
    errors.mockRestore();
  });

  it('gives up its maintenance lease when the engine closes, so another server can take over at once', () => {
    const other = createMemoryEngineFromConfig({ ...config, namespace: 'closing' });
    vi.mocked(releaseMaintenanceLease).mockClear();
    other.close();
    expect(releaseMaintenanceLease).toHaveBeenCalledWith(expect.anything(), 'closing');
  });

  it('a dry run writes nothing and triggers no maintenance', async () => {
    setResponses(factsJson([{ fact: 'Preview only' }]));
    await engine.ingest('blob', { dry_run: true });
    expect(maybeRunMaintenance).not.toHaveBeenCalled();
  });

  it('stops at the next chunk when the request is cancelled, without counting the chunk as failed', async () => {
    const blob = multiChunkBlob();
    const controller = new AbortController();
    setResponses(...Array.from({ length: 10 }, (_, i) => manyFacts(i, 2)));
    llmMock.during = () => {
      if (llmMock.calls === 1) controller.abort();
    };

    await expect(engine.ingest(blob, {}, { signal: controller.signal })).rejects.toThrow(/cancelled/);

    expect(llmMock.calls).toBe(1);
    expect(getNamespaceStats(db, NAMESPACE).total_memories).toBe(0);
    expect(maybeRunMaintenance).not.toHaveBeenCalled();
  });

  it('stops writing when the request is cancelled after extraction', async () => {
    const controller = new AbortController();
    setResponses(factsJson([{ fact: 'First fact' }, { fact: 'Second fact' }]));
    let writes = 0;
    const onProgress = (update: ProgressUpdate): void => {
      if (update.message?.startsWith('Wrote')) {
        writes += 1;
        controller.abort(); // cancel after the first write
      }
    };

    await expect(engine.ingest('blob', {}, { signal: controller.signal, onProgress })).rejects.toThrow(/cancelled/);
    expect(writes).toBe(1);
    expect(getNamespaceStats(db, NAMESPACE).total_memories).toBe(1);
  });

  it('reports progress for every chunk and every fact written, always increasing', async () => {
    const blob = multiChunkBlob();
    const chunks = chunkBlob(blob).length;
    setResponses(...Array.from({ length: chunks }, (_, i) => manyFacts(i, 1)));
    const updates: ProgressUpdate[] = [];

    const result = await engine.ingest(blob, {}, { onProgress: (update) => updates.push(update) });

    expect(updates).toHaveLength(chunks + result.facts.length);
    expect(updates.map((u) => u.progress)).toEqual(Array.from({ length: updates.length }, (_, i) => i + 1));
    expect(updates[chunks - 1]).toMatchObject({ total: chunks, message: `Extracted ${chunks} of ${chunks} chunk(s)` });
    expect(updates[updates.length - 1]).toMatchObject({
      progress: chunks + result.facts.length,
      total: chunks + result.facts.length,
    });
  });

  it('a retried ingest reuses the source segments its first run wrote', async () => {
    const blob = 'Meeting notes: the office moves to Lisbon in May; standups stay at nine.';
    setResponses(factsJson([{ fact: 'The office moves to Lisbon in May' }]));
    const first = await engine.ingest(blob, { source: 'notes', mode: 'document' });
    expect(first.segments_created).toBe(1);

    // The retry's extraction differs a little (the LLM is not deterministic): one fact is
    // the same, one is new. The new one links to the segment the first run wrote.
    setResponses(factsJson([{ fact: 'The office moves to Lisbon in May' }, { fact: 'Standups stay at nine' }]));
    const retry = await engine.ingest(blob, { source: 'notes', mode: 'document' });

    expect(retry.created).toBe(1);
    expect(retry.merged).toBe(1);
    expect(retry.segments_created).toBeUndefined();
    const segments = db.prepare(`SELECT id FROM segments WHERE namespace = ?`).all(NAMESPACE) as Array<{ id: string }>;
    expect(segments).toHaveLength(1);
    const rows = getMemoriesByIds(db, NAMESPACE, [...first.memory_ids, ...retry.memory_ids]);
    expect(new Set(rows.map((r) => r.segment_id))).toEqual(new Set([segments[0].id]));
  });

  it('the same text under another source label gets its own segment', async () => {
    const blob = 'Release notes: version two ships the new importer.';
    setResponses(factsJson([{ fact: 'Version two ships the new importer' }]));
    await engine.ingest(blob, { source: 'release-notes' });
    setResponses(factsJson([{ fact: 'The importer is new in version two' }]));
    await engine.ingest(blob, { source: 'changelog' });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM segments`).get()).toEqual({ n: 2 });
  });

  it('keeps the chunk token cap the extraction prompt is sized for', () => {
    expect(MAX_INGEST_CHUNK_TOKENS).toBe(6000);
  });
});

// ---------- Segment reuse and review quarantine (WP-94 with WP-96) ----------

describe('segment reuse stays within one review group', () => {
  const INTERACTIVE = { MEMORY_WRITER_KIND: 'interactive', MEMORY_SESSION_ID: 'session-user-1' };
  const DAILY_RUN_1 = { MEMORY_WRITER_KIND: 'cron', MEMORY_SESSION_ID: 'run-1', MEMORY_WRITER_SCOPE: 'job:daily' };
  const DAILY_RUN_2 = { MEMORY_WRITER_KIND: 'cron', MEMORY_SESSION_ID: 'run-2', MEMORY_WRITER_SCOPE: 'job:daily' };
  const WEEKLY_RUN = { MEMORY_WRITER_KIND: 'cron', MEMORY_SESSION_ID: 'run-9', MEMORY_WRITER_SCOPE: 'job:weekly' };

  const BLOB = 'Release checklist: tag the build, then publish the notes to the wiki.';
  const FACT = 'Releases are tagged before the notes are published';

  let tmpDir: string;
  let dbPath: string;
  let db: Database.Database;
  const engines: MemoryEngine[] = [];

  /** One session's memory server on the shared database, writing as `writer`. */
  function session(writer: Record<string, string>): MemoryEngine {
    const engine = createMemoryEngineFromConfig({
      ...loadConfig({ ...testModelEnv(), ...writer }),
      dbPath,
      namespace: NAMESPACE,
      llmApiKey: 'test-key',
      llmBaseUrl: 'http://localhost:1234/v1',
      maintenanceInterval: 10000,
    });
    engines.push(engine);
    return engine;
  }

  async function ingestAs(writer: Record<string, string>): Promise<IngestResult> {
    setResponses(factsJson([{ fact: FACT }]));
    return session(writer).ingest(BLOB, { source: 'checklist', mode: 'document' });
  }

  function segmentOf(memoryId: string): string | null {
    return getMemoriesByIds(db, NAMESPACE, [memoryId])[0]?.segment_id ?? null;
  }

  function segmentCount(): number {
    return (db.prepare(`SELECT COUNT(*) AS n FROM segments WHERE namespace = ?`).get(NAMESPACE) as { n: number }).n;
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memory-ingest-review-'));
    dbPath = join(tmpDir, 'test.db');
    db = initDatabase(dbPath, loadConfig(testModelEnv()).embeddingModel);
  });

  afterEach(() => {
    for (const engine of engines.splice(0)) engine.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("reuses a segment for the writer's own scope: a later run of the same job", async () => {
    const first = await ingestAs(DAILY_RUN_1);
    expect(first.segments_created).toBe(1);

    setResponses(factsJson([{ fact: FACT }, { fact: 'Release notes go to the wiki' }]));
    const retry = await session(DAILY_RUN_2).ingest(BLOB, { source: 'checklist', mode: 'document' });

    expect(retry.segments_created).toBeUndefined();
    expect(segmentCount()).toBe(1);
    expect(new Set([...first.memory_ids, ...retry.memory_ids].map(segmentOf))).toEqual(
      new Set([segmentOf(first.memory_ids[0])]),
    );
  });

  it('gives an unattended run a segment of its own for a source reviewed memories use', async () => {
    const reviewed = await ingestAs(INTERACTIVE);
    const pending = await ingestAs(DAILY_RUN_1);

    expect(pending.segments_created).toBe(1);
    expect(segmentCount()).toBe(2);
    const reviewedSegment = segmentOf(reviewed.memory_ids[0]);
    expect(reviewedSegment).not.toBeNull();
    expect(segmentOf(pending.memory_ids[0])).not.toBe(reviewedSegment);

    // Rejecting what the run wrote (admin review reject deletes through forgetMemoryRows,
    // with the segments of what it deletes) leaves the reviewed memory's source alone.
    forgetMemoryRows(db, NAMESPACE, pending.memory_ids);
    expect(segmentOf(reviewed.memory_ids[0])).toBe(reviewedSegment);
    expect(segmentCount()).toBe(1);
  });

  it('gives an interactive session a segment of its own for a source only pending memories use', async () => {
    const pending = await ingestAs(DAILY_RUN_1);
    const reviewed = await ingestAs(INTERACTIVE);

    // The result does not reveal that a source the session may not read holds the same text.
    expect(reviewed.segments_created).toBe(1);
    expect(segmentCount()).toBe(2);
    expect(segmentOf(reviewed.memory_ids[0])).not.toBe(segmentOf(pending.memory_ids[0]));
  });

  it("does not reuse another job's pending segment", async () => {
    const daily = await ingestAs(DAILY_RUN_1);
    const weekly = await ingestAs(WEEKLY_RUN);

    expect(weekly.segments_created).toBe(1);
    expect(segmentOf(weekly.memory_ids[0])).not.toBe(segmentOf(daily.memory_ids[0]));
  });
});
