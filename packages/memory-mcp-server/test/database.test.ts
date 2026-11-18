import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as sqliteVec from 'sqlite-vec';
import { initDatabase, EMBEDDING_DIMENSIONS } from '../src/storage/database.js';
import {
  insertMemory,
  generateId,
  getMemoriesByIds,
  getRecentMemories,
  getImportantMemories,
  deleteMemory,
  deleteMemories,
  findForgetTargets,
  mergeMemoryMetadata,
  appendSupersededHistory,
  MAX_SUPERSEDED_HISTORY,
  vectorSearch,
  vectorSearchConsolidated,
  ftsSearch,
  updateAccessStats,
  updateMemoryContent,
  getNamespaceStats,
  getEmbeddingsForMemories,
  markDecayed,
  markCompacted,
  pruneVectorsOfInactiveMemories,
  insertSegment,
  getSegmentsByIds,
  getLiveSegmentsByIds,
  materializeSegment,
  purgeSegments,
  deleteSegmentsWithoutLiveFacts,
  forgetMemoryRows,
  addSourceSegments,
  readSourceSegments,
  getDecayedUncompacted,
} from '../src/storage/queries.js';
import type { InsertMemoryParams, PendingSegment } from '../src/storage/queries.js';
import { STORE_DEDUP_CANDIDATES } from '../src/storage/constants.js';
import type Database from 'better-sqlite3';

const TEST_MODEL = 'test-model';
const NAMESPACE = 'test';

function randomEmbedding(): Float32Array {
  const arr = new Float32Array(EMBEDDING_DIMENSIONS);
  for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
    arr[i] = Math.random() * 2 - 1;
  }
  // Normalize
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) arr[i] /= norm;
  return arr;
}

/** Unit vector `sum(coeffs[i] * e_i)`; unit(1, x) lies 1 - 1/sqrt(1 + x^2) from unit(1). */
function unit(...coeffs: number[]): Float32Array {
  const v = new Float32Array(EMBEDDING_DIMENSIONS);
  const norm = Math.sqrt(coeffs.reduce((sum, c) => sum + c * c, 0));
  coeffs.forEach((c, i) => {
    v[i] = c / norm;
  });
  return v;
}

/** Cosine distance of two unit vectors, in double precision. */
function cosineDistance(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return 1 - dot;
}

describe('database', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memory-test-'));
    db = initDatabase(join(tmpDir, 'test.db'), TEST_MODEL);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates schema tables', () => {
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as Array<{
      name: string;
    }>;
    const names = tables.map((t) => t.name);

    expect(names).toContain('memories');
    expect(names).toContain('schema_meta');
    expect(names).toContain('vec_memories');
    expect(names).toContain('memories_fts');
  });

  it('stores schema metadata', () => {
    const model = db.prepare(`SELECT value FROM schema_meta WHERE key = 'embedding_model'`).get() as { value: string };
    expect(model.value).toBe(TEST_MODEL);
  });

  it('inserts and retrieves a memory', () => {
    const id = generateId();
    const emb = randomEmbedding();

    insertMemory(
      db,
      {
        id,
        namespace: NAMESPACE,
        content: 'User prefers dark mode',
        tags: ['preference', 'ui'],
        importance: 0.8,
      },
      emb,
    );

    const mem = getMemoriesByIds(db, NAMESPACE, [id])[0];
    expect(mem).toBeDefined();
    expect(mem.content).toBe('User prefers dark mode');
    expect(JSON.parse(mem.tags!)).toEqual(['preference', 'ui']);
    expect(mem.importance).toBe(0.8);
    expect(mem.access_count).toBe(0);
  });

  it('retrieves multiple memories by IDs', () => {
    const ids = [generateId(), generateId()];
    for (const id of ids) {
      insertMemory(
        db,
        { id, namespace: NAMESPACE, content: `Memory ${id}`, tags: undefined, importance: 0.5 },
        randomEmbedding(),
      );
    }

    const results = getMemoriesByIds(db, NAMESPACE, ids);
    expect(results).toHaveLength(2);
  });

  it('deletes a memory from both tables', () => {
    const id = generateId();
    insertMemory(
      db,
      { id, namespace: NAMESPACE, content: 'To delete', tags: undefined, importance: 0.5 },
      randomEmbedding(),
    );

    expect(deleteMemory(db, NAMESPACE, id)).toBe(true);
    expect(getMemoriesByIds(db, NAMESPACE, [id])[0]).toBeUndefined();
    expect(getEmbeddingsForMemories(db, NAMESPACE, [id]).get(id)).toBeUndefined();
  });

  it('performs vector search', () => {
    // Insert a few memories with known embeddings
    const target = randomEmbedding();
    const id1 = generateId();
    insertMemory(
      db,
      { id: id1, namespace: NAMESPACE, content: 'Similar memory', tags: undefined, importance: 0.5 },
      target,
    );

    // Insert a different memory
    const id2 = generateId();
    insertMemory(
      db,
      { id: id2, namespace: NAMESPACE, content: 'Different memory', tags: undefined, importance: 0.5 },
      randomEmbedding(),
    );

    const results = vectorSearch(db, NAMESPACE, target, 10);
    expect(results.length).toBeGreaterThan(0);
    // The exact match should be first (distance ~0)
    expect(results[0].id).toBe(id1);
    expect(results[0].distance).toBeLessThan(0.01);
  });

  it('performs FTS5 search', () => {
    const id = generateId();
    insertMemory(
      db,
      {
        id,
        namespace: NAMESPACE,
        content: 'TypeScript strict mode is essential',
        tags: ['coding'],
        importance: 0.5,
      },
      randomEmbedding(),
    );

    const results = ftsSearch(db, NAMESPACE, 'TypeScript strict', 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe(id);
  });

  // MEM-22: the query sanitizer kept only ASCII word characters, so 'café' searched for
  // 'caf', 'Zürich' for 'Z' OR 'rich' (and found an unrelated note), and '東京' for nothing.
  describe('keyword search in any script (MEM-22)', () => {
    function put(content: string): string {
      const id = generateId();
      insertMemory(db, { id, namespace: NAMESPACE, content, tags: undefined, importance: 0.5 }, randomEmbedding());
      return id;
    }
    const keywordHits = (query: string): string[] => ftsSearch(db, NAMESPACE, query, 10).map((r) => r.id);

    it("finds accented and non-Latin words: 'café', 'Zürich', 'José', 'Müller', '東京'", () => {
      const travel = put('Met José Müller at a café in Zürich before the flight to 東京');
      const rich = put('A rich client library for the web dashboard');

      for (const query of ['café', 'Zürich', 'José', 'Müller', '東京', 'the café in Zürich']) {
        expect(keywordHits(query)).toEqual([travel]);
      }
      // Before, 'Zürich' became 'Z' OR 'rich' and matched the client-library note.
      expect(keywordHits('Zürich')).not.toContain(rich);
    });

    it('folds diacritics both ways, and reads decomposed and full-width input as the plain word', () => {
      const plain = put('The cafe near Zurich serves breakfast');

      expect(keywordHits('café')).toEqual([plain]);
      expect(keywordHits('Zürich')).toEqual([plain]);
      expect(keywordHits('café')).toEqual([plain]); // 'e' + combining acute (NFD)
      expect(keywordHits('Ｚｕｒｉｃｈ')).toEqual([plain]); // full-width letters (NFKC folds them)
    });

    it('also finds text stored in full-width form by the same full-width word', () => {
      // The index does not fold full-width forms, so the word is searched as typed too.
      const wide = put('Meeting ２０２６年 ＡＩ 会議');
      expect(keywordHits('ＡＩ')).toEqual([wide]);
      expect(keywordHits('２０２６年')).toEqual([wide]);
    });

    it('drops a stop word typed in full-width form, as typed too', () => {
      // 'ＴＨＥ' is 'the': NFKC drops it from the folded words, and the as-typed words
      // must not bring it back as a full-width keyword.
      put('ＴＨＥ ＦＵＬＬ ＷＩＤＴＨ ＮＯＴＥ');
      expect(keywordHits('ＴＨＥ')).toEqual([]);
      expect(keywordHits('Ｔｈｅ ａｎｄ ｏｆ')).toEqual([]);
    });

    it('keeps combining marks inside a word (scripts NFKC does not compose)', () => {
      const hindi = put('मुझे हिन्दी भाषा पसंद है');
      // The tokenizer splits Devanagari at its vowel signs. Searched as one word, 'हिन्दी'
      // needs its letters in sequence; split at the marks, its single letters would also
      // match this unrelated note.
      put('हाँ नदी दूर है');
      expect(keywordHits('हिन्दी')).toEqual([hindi]);
    });

    it('treats FTS5 operator words and syntax as plain text', () => {
      const near = put('The NEAR protocol team meets on Fridays');
      expect(keywordHits('NEAR protocol')).toEqual([near]);
      expect(() => ftsSearch(db, NAMESPACE, 'AND OR NOT NEAR( "protocol* ^team -: {x}', 10)).not.toThrow();
      expect(keywordHits('"protocol* ^team')).toEqual([near]);
      expect(keywordHits('!!! ___ ...')).toEqual([]);
    });
  });

  it('updates access stats', () => {
    const id = generateId();
    insertMemory(
      db,
      { id, namespace: NAMESPACE, content: 'Test', tags: undefined, importance: 0.5 },
      randomEmbedding(),
    );

    updateAccessStats(db, NAMESPACE, [id]);

    const mem = getMemoriesByIds(db, NAMESPACE, [id])[0];
    expect(mem.access_count).toBe(1);
    expect(mem.last_accessed_at).toBeGreaterThan(mem.created_at - 1);
  });

  it('returns recent memories sorted by created_at', () => {
    for (let i = 0; i < 5; i++) {
      const id = generateId();
      insertMemory(
        db,
        { id, namespace: NAMESPACE, content: `Memory ${i}`, tags: undefined, importance: 0.5 },
        randomEmbedding(),
      );
    }

    const recent = getRecentMemories(db, NAMESPACE, 3);
    expect(recent).toHaveLength(3);
    // Should be in descending order of created_at
    expect(recent[0].created_at).toBeGreaterThanOrEqual(recent[1].created_at);
  });

  it('returns important memories sorted by importance', () => {
    const importances = [0.3, 0.9, 0.1, 0.7, 0.5];
    for (const imp of importances) {
      insertMemory(
        db,
        {
          id: generateId(),
          namespace: NAMESPACE,
          content: `Importance ${imp}`,
          tags: undefined,
          importance: imp,
        },
        randomEmbedding(),
      );
    }

    const important = getImportantMemories(db, NAMESPACE, 3);
    expect(important).toHaveLength(3);
    expect(important[0].importance).toBe(0.9);
    expect(important[1].importance).toBe(0.7);
  });

  it('computes namespace stats', () => {
    for (let i = 0; i < 3; i++) {
      insertMemory(
        db,
        {
          id: generateId(),
          namespace: NAMESPACE,
          content: `Memory ${i}`,
          tags: ['test'],
          importance: 0.5,
        },
        randomEmbedding(),
      );
    }

    const stats = getNamespaceStats(db, NAMESPACE);
    expect(stats.total_memories).toBe(3);
    expect(stats.active_memories).toBe(3);
    expect(stats.top_tags).toHaveLength(1);
    expect(stats.top_tags[0].tag).toBe('test');
    expect(stats.top_tags[0].count).toBe(3);
  });

  it('merges tags when updating memory content', () => {
    const id = generateId();
    const emb = randomEmbedding();

    insertMemory(
      db,
      {
        id,
        namespace: NAMESPACE,
        content: 'Original content',
        tags: ['dia_id:D1:5', 'session:1'],
        importance: 0.5,
      },
      emb,
    );

    const newEmb = randomEmbedding();
    updateMemoryContent(db, NAMESPACE, id, 'Updated content', newEmb, 0.7, 'Original content', [
      'dia_id:D1:5',
      'session:1',
      'dia_id:D1:6',
      'session:2',
    ]);

    const mem = getMemoriesByIds(db, NAMESPACE, [id])[0];
    expect(mem.content).toBe('Updated content');
    expect(JSON.parse(mem.tags!)).toEqual(['dia_id:D1:5', 'session:1', 'dia_id:D1:6', 'session:2']);
    expect(mem.importance).toBe(0.7);
  });

  it('preserves existing tags when mergedTags is omitted', () => {
    const id = generateId();
    const emb = randomEmbedding();

    insertMemory(
      db,
      {
        id,
        namespace: NAMESPACE,
        content: 'Original',
        tags: ['keep-me'],
        importance: 0.5,
      },
      emb,
    );

    updateMemoryContent(db, NAMESPACE, id, 'Updated', randomEmbedding(), 0.6, 'Original');

    const mem = getMemoriesByIds(db, NAMESPACE, [id])[0];
    expect(mem.content).toBe('Updated');
    expect(JSON.parse(mem.tags!)).toEqual(['keep-me']);
  });

  describe('deleteMemories', () => {
    function put(id: string, namespace: string, content = `memory ${id}`): void {
      insertMemory(db, { id, namespace, content, tags: undefined, importance: 0.5 }, randomEmbedding());
    }

    function vectorCount(): number {
      return (db.prepare(`SELECT COUNT(*) AS c FROM vec_memories`).get() as { c: number }).c;
    }

    // vec0 rejects a second `IN (...)` on its key column ("only 1 'rowid in (..)'
    // operator is allowed in a single vec0 query"); the old statement had two, so every
    // forget of 2+ memories threw and rolled back.
    it('deletes 2+ memories from the memories, vector and FTS tables and keeps other-namespace rows', () => {
      put('a', NAMESPACE, 'alpha parrot');
      put('b', NAMESPACE, 'bravo parrot');
      put('c', NAMESPACE, 'charlie parrot');
      put('keep', NAMESPACE, 'delta parrot');
      put('other-1', 'other', 'echo parrot');
      put('other-2', 'other', 'foxtrot parrot');

      // Ids of another namespace are ignored, as are unknown and repeated ids.
      expect(deleteMemories(db, NAMESPACE, ['a', 'b', 'c', 'b', 'other-1', 'other-2', 'missing'])).toBe(3);

      expect(getMemoriesByIds(db, NAMESPACE, ['a', 'b', 'c'])).toHaveLength(0);
      expect(getEmbeddingsForMemories(db, NAMESPACE, ['a', 'b', 'c']).size).toBe(0);
      expect(getMemoriesByIds(db, NAMESPACE, ['keep'])).toHaveLength(1);
      expect(getMemoriesByIds(db, 'other', ['other-1', 'other-2'])).toHaveLength(2);
      expect(getEmbeddingsForMemories(db, 'other', ['other-1', 'other-2']).size).toBe(2);
      expect(vectorCount()).toBe(3);
      expect(ftsSearch(db, NAMESPACE, 'parrot', 10).map((r) => r.id)).toEqual(['keep']);
    });

    it('deletes more ids than one statement binds, atomically', () => {
      const ids = Array.from({ length: 520 }, (_, i) => `bulk-${i}`);
      const insertAll = db.transaction(() => {
        for (const id of ids) put(id, NAMESPACE);
      });
      insertAll();
      put('keep', NAMESPACE);

      expect(deleteMemories(db, NAMESPACE, ids)).toBe(520);
      expect(getNamespaceStats(db, NAMESPACE).total_memories).toBe(1);
      expect(vectorCount()).toBe(1);
    });

    it('returns 0 for an empty list', () => {
      put('a', NAMESPACE);
      expect(deleteMemories(db, NAMESPACE, [])).toBe(0);
      expect(vectorCount()).toBe(1);
    });
  });

  describe('findForgetTargets', () => {
    const T_2024 = Date.parse('2024-06-01T00:00:00.000Z');
    const T_2026 = Date.parse('2026-06-01T00:00:00.000Z');
    const CUTOFF = Date.parse('2025-01-01T00:00:00.000Z');

    function put(id: string, tags: string[] | undefined, createdAt: number, namespace = NAMESPACE): void {
      insertMemory(db, { id, namespace, content: `memory ${id}`, tags, importance: 0.5, createdAt }, randomEmbedding());
    }

    function ids(rows: Array<{ id: string }>): string[] {
      return rows.map((r) => r.id).sort();
    }

    beforeEach(() => {
      put('foo-old', ['project:foo'], T_2024);
      put('foo-new', ['project:foo'], T_2026);
      put('foo-personal-old', ['project:foo', 'personal'], T_2024);
      put('bar-old', ['project:bar'], T_2024);
      put('untagged-old', undefined, T_2024);
      put('repeated-tag', ['project:foo', 'project:foo'], T_2024);
      put('other-ns', ['project:foo'], T_2024, 'other');
    });

    // The old forget unioned its criteria: tags + before also took every untagged old
    // memory and every new project:foo memory.
    it('intersects tags and before', () => {
      const rows = findForgetTargets(db, NAMESPACE, { tags: ['project:foo'], beforeMs: CUTOFF }, 100);
      expect(ids(rows)).toEqual(['foo-old', 'foo-personal-old', 'repeated-tag']);
    });

    it('requires every tag, even against a row that repeats one of them', () => {
      const rows = findForgetTargets(db, NAMESPACE, { tags: ['project:foo', 'personal'] }, 100);
      expect(ids(rows)).toEqual(['foo-personal-old']);
    });

    it('intersects ids with the other criteria and stays in the namespace', () => {
      const rows = findForgetTargets(
        db,
        NAMESPACE,
        { ids: ['foo-old', 'bar-old', 'other-ns'], tags: ['project:foo'] },
        100,
      );
      expect(ids(rows)).toEqual(['foo-old']);
    });

    it('returns rows oldest first and honours the limit', () => {
      const rows = findForgetTargets(db, NAMESPACE, { beforeMs: Date.parse('2030-01-01') }, 2);
      expect(rows).toHaveLength(2);
      expect(rows[0].created_at).toBeLessThanOrEqual(rows[1].created_at);
    });

    it('refuses to select without a criterion', () => {
      expect(() => findForgetTargets(db, NAMESPACE, {}, 100)).toThrow('at least one criterion');
    });

    it('skips rows whose tags column is not valid JSON instead of failing the whole selection', () => {
      put('broken-tags', undefined, T_2024);
      db.prepare(`UPDATE memories SET tags = 'not json' WHERE id = 'broken-tags'`).run();
      const rows = findForgetTargets(db, NAMESPACE, { tags: ['project:foo'], beforeMs: CUTOFF }, 100);
      expect(ids(rows)).toEqual(['foo-old', 'foo-personal-old', 'repeated-tag']);
    });
  });

  describe('findForgetTargets with a query vector (near)', () => {
    const T_2024 = Date.parse('2024-06-01T00:00:00.000Z');
    const T_2026 = Date.parse('2026-06-01T00:00:00.000Z');
    const CUTOFF = Date.parse('2025-01-01T00:00:00.000Z');

    const near = (maxDistance: number) => ({ embedding: unit(1), maxDistance });

    function put(
      id: string,
      embedding: Float32Array,
      opts: { tags?: string[]; createdAt?: number; namespace?: string } = {},
    ): void {
      insertMemory(
        db,
        {
          id,
          namespace: opts.namespace ?? NAMESPACE,
          content: `memory ${id}`,
          tags: opts.tags,
          importance: 0.5,
          createdAt: opts.createdAt,
        },
        embedding,
      );
    }

    it('selects only memories within the distance, closest first', () => {
      put('close', unit(1, 0.1));
      put('closest', unit(1, 0.05));
      put('far', unit(0, 1));

      expect(findForgetTargets(db, NAMESPACE, { near: near(0.35) }, 10).map((r) => r.id)).toEqual(['closest', 'close']);
    });

    // The query forget used to take the 50 nearest rows first and filter them
    // afterwards: matches behind 50 closer non-matching rows were never reached, and
    // every retry reported the same truncation while forgetting nothing.
    it('applies every other criterion before the limit, so closer non-matching rows cannot crowd a match out', () => {
      const insertAll = db.transaction(() => {
        for (let i = 0; i < 60; i++) put(`untagged-${i}`, unit(1, 0.01 * (i + 1)));
      });
      insertAll();
      put('tagged-old', unit(1, 0.7), { tags: ['diet'], createdAt: T_2024 });
      put('tagged-new', unit(1, 0.71), { tags: ['diet'], createdAt: T_2026 });
      put('tagged-other-ns', unit(1), { tags: ['diet'], namespace: 'other' });

      const select = (criteria: Parameters<typeof findForgetTargets>[2]) =>
        findForgetTargets(db, NAMESPACE, criteria, 11).map((r) => r.id);
      expect(select({ tags: ['diet'], near: near(0.35) })).toEqual(['tagged-old', 'tagged-new']);
      expect(select({ tags: ['diet'], beforeMs: CUTOFF, near: near(0.35) })).toEqual(['tagged-old']);
      expect(
        select({ ids: ['tagged-new', 'untagged-3', 'tagged-other-ns'], tags: ['diet'], near: near(0.35) }),
      ).toEqual(['tagged-new']);
      expect(select({ near: near(0.35) })).toHaveLength(11);
    });

    it('never selects a memory without a vector (decayed) or one outside the distance', () => {
      put('decayed', unit(1), { tags: ['diet'] });
      markDecayed(db, NAMESPACE, 'decayed');
      put('outside', unit(1, 1), { tags: ['diet'] }); // distance 0.29

      expect(findForgetTargets(db, NAMESPACE, { tags: ['diet'], near: near(0.2) }, 10)).toEqual([]);
      expect(findForgetTargets(db, NAMESPACE, { tags: ['diet'], near: near(0.35) }, 10).map((r) => r.id)).toEqual([
        'outside',
      ]);
    });
  });

  describe('candidate search (live memories, vec0 KNN, tag scope)', () => {
    function put(id: string, embedding: Float32Array, opts: Partial<InsertMemoryParams> = {}): void {
      insertMemory(
        db,
        { id, namespace: NAMESPACE, content: `memory ${id}`, tags: undefined, importance: 0.5, ...opts },
        embedding,
      );
    }

    function ids(rows: Array<{ id: string }>): string[] {
      return rows.map((r) => r.id);
    }

    // MEM-17: vectorSearch used to compute vec_distance_cosine for every row through a
    // join; the KNN must rank and measure exactly like that exact scan did.
    it('returns the same neighbours and cosine distances as an exact scan', () => {
      const vectors = new Map<string, Float32Array>();
      const insertAll = db.transaction(() => {
        for (let i = 0; i < 300; i++) {
          const v = randomEmbedding();
          vectors.set(`m${i}`, v);
          put(`m${i}`, v);
        }
      });
      insertAll();

      const query = randomEmbedding();
      const exact = [...vectors]
        .map(([id, v]) => ({ id, distance: cosineDistance(query, v) }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 10);
      const results = vectorSearch(db, NAMESPACE, query, 10);

      expect(ids(results)).toEqual(exact.map((e) => e.id));
      results.forEach((r, i) => {
        expect(r.distance).toBeCloseTo(exact[i].distance, 5);
      });
      // Identical vectors measure 0, as store-time dedup expects.
      expect(vectorSearch(db, NAMESPACE, vectors.get('m7') ?? query, 1)[0]).toMatchObject({ id: 'm7' });
      expect(vectorSearch(db, NAMESPACE, vectors.get('m7') ?? query, 1)[0].distance).toBeLessThan(1e-6);
    });

    // MEM-8: decayed rows stayed in keyword search, and compacted originals (and rows
    // stored with importance 0) kept their vectors, so both reached recall.
    it('never returns decayed or compacted memories, even ones that still have a vector', () => {
      put('live', unit(1, 0.5));
      put('compacted-with-vector', unit(1, 0.1));
      db.prepare(`UPDATE memories SET is_compacted = 1 WHERE id = 'compacted-with-vector'`).run();
      put('importance-zero', unit(1, 0.05), { importance: 0 });
      put('decayed', unit(1, 0.2));
      markDecayed(db, NAMESPACE, 'decayed');

      expect(ids(vectorSearch(db, NAMESPACE, unit(1), 5))).toEqual(['live']);
      expect(ids(ftsSearch(db, NAMESPACE, 'memory', 10))).toEqual(['live']);
      expect(ids(vectorSearchConsolidated(db, NAMESPACE, unit(1), 5))).toEqual(['live']);
    });

    // The vec0 table holds every namespace's vectors, so the KNN picks its neighbours
    // before the namespace filter; it must widen until enough of them belong here.
    it('finds a memory of its namespace behind many closer vectors of another namespace', () => {
      const insertAll = db.transaction(() => {
        for (let i = 0; i < 200; i++) {
          insertMemory(
            db,
            { id: `other-${i}`, namespace: 'other', content: 'other', tags: undefined, importance: 0.5 },
            unit(1, 0.001 * (i + 1)),
          );
        }
      });
      insertAll();
      put('mine', unit(1, 1));

      const results = vectorSearch(db, NAMESPACE, unit(1), 5);
      expect(ids(results)).toEqual(['mine']);
      expect(results[0].distance).toBeCloseTo(1 - 1 / Math.sqrt(2), 5);
    });

    it('falls back to an exact scan when more vectors lie closer than the largest KNN reaches', () => {
      const insertAll = db.transaction(() => {
        for (let i = 0; i < 4100; i++) {
          insertMemory(
            db,
            { id: `other-${i}`, namespace: 'other', content: 'other', tags: undefined, importance: 0.5 },
            unit(1, 0.0001 * (i + 1)),
          );
        }
      });
      insertAll();
      put('mine', unit(1, 1));

      expect(ids(vectorSearch(db, NAMESPACE, unit(1), 5))).toEqual(['mine']);
    });

    // Consolidation pairs a new memory with its nearest CONSOLIDATED neighbours; the
    // batch being consolidated must not crowd an older fact out of the KNN.
    it('finds a consolidated memory behind a closer unconsolidated batch', () => {
      const insertAll = db.transaction(() => {
        for (let i = 0; i < 60; i++) put(`batch-${i}`, unit(1, 0.001 * (i + 1)), { consolidated: false });
      });
      insertAll();
      put('older-fact', unit(1, 0.5));

      expect(ids(vectorSearchConsolidated(db, NAMESPACE, unit(1), 5))).toEqual(['older-fact']);
    });

    // MEM-18: the tag scope used to filter the top-50 candidates of each channel, so a
    // tagged memory behind 50 closer (or better keyword-matching) untagged ones was lost.
    it('applies a tag scope before the limit in both the vector and the keyword search', () => {
      const insertAll = db.transaction(() => {
        for (let i = 0; i < 60; i++) {
          put(`bar-${i}`, unit(1, 0.01 * (i + 1)), {
            content: `database database memory ${i}`,
            tags: ['project:bar'],
          });
        }
      });
      insertAll();
      put('tagged', unit(1, 2), { content: 'the database of project foo', tags: ['project:foo', 'kind:fact'] });
      put('tagged-decayed', unit(1, 0.001), { content: 'database of foo, decayed', tags: ['project:foo'] });
      markDecayed(db, NAMESPACE, 'tagged-decayed');
      put('broken-tags', unit(1, 0.002), { content: 'database with broken tags' });
      db.prepare(`UPDATE memories SET tags = 'not json' WHERE id = 'broken-tags'`).run();
      put('object-tags', unit(1, 0.003), { content: 'database with object tags' });
      db.prepare(`UPDATE memories SET tags = '{"t":"project:foo"}' WHERE id = 'object-tags'`).run();

      // Unscoped, the 50 closer / better-matching project:bar memories fill both limits.
      expect(ids(vectorSearch(db, NAMESPACE, unit(1), 50))).not.toContain('tagged');
      expect(ids(ftsSearch(db, NAMESPACE, 'database', 50))).not.toContain('tagged');

      const scope = { tags: ['project:foo'] };
      expect(ids(vectorSearch(db, NAMESPACE, unit(1), 50, scope))).toEqual(['tagged']);
      expect(ids(ftsSearch(db, NAMESPACE, 'database', 50, scope))).toEqual(['tagged']);
      // ALL of the tags: a missing one excludes the memory; an empty scope does not constrain.
      expect(vectorSearch(db, NAMESPACE, unit(1), 50, { tags: ['project:foo', 'missing'] })).toEqual([]);
      expect(ftsSearch(db, NAMESPACE, 'database', 50, { tags: ['project:foo', 'missing'] })).toEqual([]);
      expect(vectorSearch(db, NAMESPACE, unit(1), 50, { tags: [] })).toHaveLength(50);
    });

    // The FTS match must stay the outer loop: with `importance > 0` in the WHERE clause,
    // SQLite would otherwise walk the importance index and run the whole MATCH once per
    // memory (about 0.4 s at 2,000 memories, growing with the square of their number).
    it('keeps keyword search fast on thousands of memories, with and without a tag scope', () => {
      const insertAll = db.transaction(() => {
        for (let i = 0; i < 5000; i++) {
          put(`row-${i}`, randomEmbedding(), { content: `database note number ${i}`, tags: [`t${i % 10}`] });
        }
      });
      insertAll();
      ftsSearch(db, NAMESPACE, 'database note', 50);

      const start = performance.now();
      expect(ftsSearch(db, NAMESPACE, 'database note', 50)).toHaveLength(50);
      expect(ftsSearch(db, NAMESPACE, 'database note', 50, { tags: ['t3'] })).toHaveLength(50);
      expect(performance.now() - start).toBeLessThan(500);
    });

    it('removes the vectors of compacted memories and of every non-live memory', () => {
      put('a', unit(1));
      put('b', unit(1, 1));
      put('c', unit(0, 1));
      put('zero', unit(1, 2), { importance: 0 });
      db.prepare(`UPDATE memories SET is_compacted = 1 WHERE id = 'c'`).run();

      markCompacted(db, NAMESPACE, ['a']);
      expect(getMemoriesByIds(db, NAMESPACE, ['a'])[0].is_compacted).toBe(1);
      expect([...getEmbeddingsForMemories(db, NAMESPACE, ['a', 'b', 'c', 'zero']).keys()].sort()).toEqual([
        'b',
        'c',
        'zero',
      ]);

      expect(pruneVectorsOfInactiveMemories(db, NAMESPACE)).toBe(2);
      expect([...getEmbeddingsForMemories(db, NAMESPACE, ['a', 'b', 'c', 'zero']).keys()]).toEqual(['b']);
      expect(getNamespaceStats(db, NAMESPACE).total_memories).toBe(4);
    });

    // Acceptance (MEM-17): each store compares the new memory with its nearest
    // neighbours. The old full scan took 0.3-0.6 s at 50k memories; the KNN takes
    // 25-45 ms. The best of several runs is the measure least disturbed by other load on
    // the machine; the median bound still fails for anything like the old scan.
    it('store-time dedup on a 50k-row database stays under 50 ms', () => {
      const insertAll = db.transaction(() => {
        for (let i = 0; i < 50_000; i++) put(`row-${i}`, randomEmbedding(), { content: `memory number ${i}` });
      });
      insertAll();

      const query = randomEmbedding();
      vectorSearch(db, NAMESPACE, query, STORE_DEDUP_CANDIDATES); // warm the OS file cache
      const timings: number[] = [];
      for (let run = 0; run < 7; run++) {
        const probe = randomEmbedding();
        const start = performance.now();
        const neighbours = vectorSearch(db, NAMESPACE, probe, STORE_DEDUP_CANDIDATES);
        timings.push(performance.now() - start);
        expect(neighbours).toHaveLength(STORE_DEDUP_CANDIDATES);
      }
      timings.sort((a, b) => a - b);
      expect(timings[0]).toBeLessThan(50);
      expect(timings[3]).toBeLessThan(150);

      // ...and it is still the exact nearest neighbours.
      const exact = db
        .prepare(
          `SELECT v.memory_id AS id FROM vec_memories v
            ORDER BY vec_distance_cosine(v.embedding, ?) ASC LIMIT ?`,
        )
        .all(Buffer.from(query.buffer, query.byteOffset, query.byteLength), STORE_DEDUP_CANDIDATES) as Array<{
        id: string;
      }>;
      expect(ids(vectorSearch(db, NAMESPACE, query, STORE_DEDUP_CANDIDATES))).toEqual(ids(exact));
    }, 120_000);
  });

  describe('segment lifecycle (MEM-3)', () => {
    function segment(id: string, factCount = 2): string {
      return insertSegment(db, { id, namespace: NAMESPACE, content: `source text of ${id}`, factCount });
    }

    function fact(id: string, segmentId: string | undefined, opts: Partial<InsertMemoryParams> = {}): void {
      insertMemory(
        db,
        { id, namespace: NAMESPACE, content: `fact ${id}`, tags: undefined, importance: 0.5, segmentId, ...opts },
        randomEmbedding(),
      );
    }

    function segmentIds(): string[] {
      return (db.prepare(`SELECT id FROM segments ORDER BY id`).all() as Array<{ id: string }>).map((s) => s.id);
    }

    function parentOf(id: string): string | null | undefined {
      return getMemoriesByIds(db, NAMESPACE, [id])[0]?.segment_id;
    }

    it('shows a segment only while a live memory references it', () => {
      segment('s-live');
      segment('s-decayed');
      segment('s-compacted');
      segment('s-orphan');
      fact('f-live', 's-live');
      fact('f-decayed', 's-live');
      fact('f-decayed-only', 's-decayed');
      fact('f-compacted-only', 's-compacted');
      markDecayed(db, NAMESPACE, 'f-decayed');
      markDecayed(db, NAMESPACE, 'f-decayed-only');
      markCompacted(db, NAMESPACE, ['f-compacted-only']);

      const all = ['s-live', 's-decayed', 's-compacted', 's-orphan'];
      expect(getSegmentsByIds(db, NAMESPACE, all)).toHaveLength(4);
      expect(getLiveSegmentsByIds(db, NAMESPACE, all).map((s) => s.id)).toEqual(['s-live']);
      expect(getLiveSegmentsByIds(db, 'other', all)).toEqual([]);
    });

    it('sweeps the segments no live memory references, unlinking decayed and compacted rows first', () => {
      segment('s-live');
      segment('s-decayed');
      segment('s-compacted');
      segment('s-orphan');
      insertSegment(db, { id: 's-other-ns', namespace: 'other', content: 'x', factCount: 1 });
      fact('f-live', 's-live');
      fact('f-decayed-sibling', 's-live');
      fact('f-decayed-only', 's-decayed');
      fact('f-compacted-only', 's-compacted');
      markDecayed(db, NAMESPACE, 'f-decayed-sibling');
      markDecayed(db, NAMESPACE, 'f-decayed-only');
      markCompacted(db, NAMESPACE, ['f-compacted-only']);

      // Scoped to some ids: only those are considered.
      expect(deleteSegmentsWithoutLiveFacts(db, NAMESPACE, ['s-orphan', 's-live'])).toBe(1);
      expect(segmentIds()).toEqual(['s-compacted', 's-decayed', 's-live', 's-other-ns']);
      expect(deleteSegmentsWithoutLiveFacts(db, NAMESPACE, [])).toBe(0);

      // The whole namespace (the maintenance sweep).
      expect(deleteSegmentsWithoutLiveFacts(db, NAMESPACE)).toBe(2);
      expect(segmentIds()).toEqual(['s-live', 's-other-ns']);
      expect(parentOf('f-decayed-only')).toBeNull();
      expect(parentOf('f-compacted-only')).toBeNull();
      // A segment with a live fact keeps every link, the decayed sibling's included.
      expect(parentOf('f-live')).toBe('s-live');
      expect(parentOf('f-decayed-sibling')).toBe('s-live');
    });

    it('purges a segment that siblings still reference, unlinking them', () => {
      segment('s-shared', 3);
      segment('s-kept');
      fact('f-1', 's-shared');
      fact('f-2', 's-shared');
      fact('f-3', 's-shared');
      fact('f-4', 's-kept');

      expect(purgeSegments(db, NAMESPACE, ['s-shared', 's-shared', 'missing'])).toBe(1);
      expect(segmentIds()).toEqual(['s-kept']);
      expect([parentOf('f-1'), parentOf('f-2'), parentOf('f-3')]).toEqual([null, null, null]);
      expect(parentOf('f-4')).toBe('s-kept');
      // Other namespaces are never touched.
      expect(purgeSegments(db, 'other', ['s-kept'])).toBe(0);
      expect(segmentIds()).toEqual(['s-kept']);
    });

    it('writes a pending segment on first use and never writes it again once it is gone', () => {
      const pending: PendingSegment = {
        id: 'pending-1',
        namespace: NAMESPACE,
        content: 'chunk text',
        mode: 'document',
        createdAt: 1_000,
        factCount: 2,
        reviewGroup: '',
        written: false,
        sharedWith: [],
      };
      expect(segmentIds()).toEqual([]);
      expect(materializeSegment(db, pending)).toBe('pending-1');
      expect(pending.written).toBe(true);
      expect(getSegmentsByIds(db, NAMESPACE, ['pending-1'])[0]).toMatchObject({
        content: 'chunk text',
        mode: 'document',
        created_at: 1_000,
        fact_count: 2,
      });
      fact('f-1', materializeSegment(db, pending) ?? undefined);
      expect(segmentIds()).toEqual(['pending-1']);

      // A forget purged it: a later fact of the same ingest is stored without a source.
      purgeSegments(db, NAMESPACE, ['pending-1']);
      expect(materializeSegment(db, pending)).toBeNull();
      expect(segmentIds()).toEqual([]);
    });

    it('forgets rows with their source segments and the copies of their text in superseded histories', () => {
      segment('s-1', 2);
      fact('forgotten', 's-1', { content: 'The user lived in Lisbon.' });
      fact('sibling', 's-1');
      fact('corrected', undefined, { content: 'The user lives in Berlin' });
      // A correction replaced this memory's text earlier, keeping the old one in its history.
      updateMemoryContent(
        db,
        NAMESPACE,
        'corrected',
        'The user lives in Berlin',
        randomEmbedding(),
        0.5,
        'The user lived in Lisbon',
      );
      updateMemoryContent(
        db,
        NAMESPACE,
        'corrected',
        'The user lives in Berlin',
        randomEmbedding(),
        0.5,
        'Unrelated old text',
      );
      fact('legacy', undefined, {
        metadata: { superseded: { content: 'the user lived in lisbon', at: 1 }, writer: { kind: 'cron' } },
      });
      fact('unparseable', undefined);
      db.prepare(`UPDATE memories SET metadata = '{superseded' WHERE id = 'unparseable'`).run();

      expect(forgetMemoryRows(db, NAMESPACE, ['forgotten', 'forgotten', 'missing'])).toBe(1);

      expect(getMemoriesByIds(db, NAMESPACE, ['forgotten'])).toEqual([]);
      expect(segmentIds()).toEqual([]);
      expect(parentOf('sibling')).toBeNull();
      const history = (id: string): unknown =>
        (JSON.parse(getMemoriesByIds(db, NAMESPACE, [id])[0].metadata ?? '{}') as { superseded?: unknown }).superseded;
      expect(history('corrected')).toEqual([expect.objectContaining({ content: 'Unrelated old text' })]);
      expect(history('legacy')).toBeUndefined();
      expect(JSON.parse(getMemoriesByIds(db, NAMESPACE, ['legacy'])[0].metadata ?? '{}')).toEqual({
        writer: { kind: 'cron' },
      });
      expect(getMemoriesByIds(db, NAMESPACE, ['unparseable'])[0].metadata).toBe('{superseded');
      expect(forgetMemoryRows(db, NAMESPACE, [])).toBe(0);
    });

    // The same fact can come from several chunks (an edited document ingested again, or
    // two documents stating it); the memory links to one, the others are recorded.
    it('forgets every source segment of a memory, the recorded ones included', () => {
      segment('s-own');
      segment('s-other');
      segment('s-unrelated');
      fact('merged', 's-own', { metadata: { writer: { kind: 'cron' } } });
      fact('own-sibling', 's-own');
      fact('other-sibling', 's-other');
      fact('unrelated', 's-unrelated');
      addSourceSegments(db, NAMESPACE, 'merged', ['s-other', 's-own', 'missing', null, 's-other']);
      const metadata = (): unknown => JSON.parse(getMemoriesByIds(db, NAMESPACE, ['merged'])[0].metadata ?? '{}');
      // Only existing segments other than its own are kept, once; other keys stay.
      expect(metadata()).toEqual({ writer: { kind: 'cron' }, source_segments: ['s-other'] });
      expect(readSourceSegments(getMemoriesByIds(db, NAMESPACE, ['merged'])[0].metadata)).toEqual(['s-other']);

      expect(forgetMemoryRows(db, NAMESPACE, ['merged'])).toBe(1);

      expect(segmentIds()).toEqual(['s-unrelated']);
      expect([parentOf('own-sibling'), parentOf('other-sibling')]).toEqual([null, null]);
      expect(parentOf('unrelated')).toBe('s-unrelated');
    });

    it('drops recorded source segments that are gone', () => {
      segment('s-own');
      segment('s-other');
      fact('merged', 's-own');
      fact('other-sibling', 's-other');
      addSourceSegments(db, NAMESPACE, 'merged', ['s-other']);
      purgeSegments(db, NAMESPACE, ['s-other']);
      addSourceSegments(db, NAMESPACE, 'merged', []);
      expect(getMemoriesByIds(db, NAMESPACE, ['merged'])[0].metadata).toBeNull();
    });

    it('does not write a pending segment once a memory it shares a fact with is gone', () => {
      fact('merged-into', undefined);
      const pending: PendingSegment = {
        id: 'pending-shared',
        namespace: NAMESPACE,
        content: 'chunk stating the merged fact',
        factCount: 2,
        reviewGroup: '',
        written: false,
        sharedWith: ['merged-into'],
      };
      // Written while every memory it shares a fact with exists, and recorded on them.
      const kept: PendingSegment = { ...pending, id: 'pending-kept', sharedWith: ['merged-into'] };
      expect(materializeSegment(db, kept)).toBe('pending-kept');
      expect(readSourceSegments(getMemoriesByIds(db, NAMESPACE, ['merged-into'])[0].metadata)).toEqual([
        'pending-kept',
      ]);

      // A forget removed the memory while the ingest went on: the chunk states its text.
      forgetMemoryRows(db, NAMESPACE, ['merged-into']);
      expect(materializeSegment(db, pending)).toBeNull();
      expect(pending.written).toBe(true);
      expect(materializeSegment(db, pending)).toBeNull();
      expect(segmentIds()).toEqual([]);
    });

    describe('compaction copies', () => {
      /** A summary of `members`, as compaction writes it, the members compacted. */
      function summarize(id: string, members: string[], opts: Partial<InsertMemoryParams> = {}): void {
        fact(id, undefined, {
          content: `summary ${id}`,
          importance: 0.6,
          metadata: { compacted_from: members },
          ...opts,
        });
        markCompacted(db, NAMESPACE, members);
      }

      function decayed(id: string, segmentId?: string): void {
        fact(id, segmentId, { content: `old fact ${id}` });
        markDecayed(db, NAMESPACE, id);
      }

      function existing(...ids: string[]): string[] {
        return getMemoriesByIds(db, NAMESPACE, ids)
          .map((r) => r.id)
          .sort();
      }

      it('forgetting a summary deletes the memories it replaced, through nested summaries', () => {
        segment('s-old');
        fact('live-sibling', 's-old');
        for (const id of ['a1', 'a2', 'a3']) decayed(id, id === 'a1' ? 's-old' : undefined);
        summarize('sum-a', ['a1', 'a2', 'a3']);
        markDecayed(db, NAMESPACE, 'sum-a');
        for (const id of ['b1', 'b2', 'b3']) decayed(id);
        summarize('sum-top', ['sum-a', 'b1', 'b2', 'b3']);
        decayed('unrelated-decayed');

        expect(forgetMemoryRows(db, NAMESPACE, ['sum-top'])).toBe(1);

        expect(existing('sum-top', 'sum-a', 'a1', 'a2', 'a3', 'b1', 'b2', 'b3')).toEqual([]);
        expect(existing('live-sibling', 'unrelated-decayed')).toEqual(['live-sibling', 'unrelated-decayed']);
        // a1's source went with it.
        expect(segmentIds()).toEqual([]);
        expect(parentOf('live-sibling')).toBeNull();
      });

      it('forgetting a compacted memory deletes the summaries holding its text and releases the rest', () => {
        for (const id of ['a1', 'a2', 'a3']) decayed(id);
        summarize('sum-a', ['a1', 'a2', 'a3']);
        markDecayed(db, NAMESPACE, 'sum-a');
        for (const id of ['b1', 'b2', 'b3']) decayed(id);
        summarize('sum-top', ['sum-a', 'b1', 'b2', 'b3']);

        expect(forgetMemoryRows(db, NAMESPACE, ['a2'])).toBe(1);

        expect(existing('a2', 'sum-a', 'sum-top')).toEqual([]);
        // The other memories are decayed and no longer compacted: the next pass
        // summarizes them again.
        const released = getMemoriesByIds(db, NAMESPACE, ['a1', 'a3', 'b1', 'b2', 'b3']);
        expect(released).toHaveLength(5);
        expect(released.every((r) => r.is_compacted === 0 && r.importance === 0)).toBe(true);
        expect(
          getDecayedUncompacted(db, NAMESPACE, 10)
            .map((r) => r.id)
            .sort(),
        ).toEqual(['a1', 'a3', 'b1', 'b2', 'b3']);
      });

      it('leaves compaction alone when no forgotten memory is a summary or compacted', () => {
        for (const id of ['a1', 'a2', 'a3']) decayed(id);
        summarize('sum-a', ['a1', 'a2', 'a3']);
        fact('plain', undefined);
        decayed('decayed-not-compacted');

        expect(forgetMemoryRows(db, NAMESPACE, ['plain', 'decayed-not-compacted'])).toBe(2);

        expect(existing('sum-a', 'a1', 'a2', 'a3')).toEqual(['a1', 'a2', 'a3', 'sum-a']);
        expect(getMemoriesByIds(db, NAMESPACE, ['a1'])[0].is_compacted).toBe(1);
      });
    });
  });

  describe('superseded history', () => {
    it('appends to a bounded, chronological history and keeps other metadata', () => {
      let metadata = JSON.stringify({ compacted_from: ['x'] });
      for (let i = 0; i < MAX_SUPERSEDED_HISTORY + 2; i++) {
        metadata = appendSupersededHistory(metadata, { content: `text ${i}`, at: i });
      }
      const parsed = JSON.parse(metadata) as {
        compacted_from: string[];
        superseded: Array<{ content: string }>;
      };
      expect(parsed.compacted_from).toEqual(['x']);
      expect(parsed.superseded.map((e) => e.content)).toEqual(['text 2', 'text 3', 'text 4', 'text 5', 'text 6']);
    });

    it('keeps the single entry an older version stored as the first history entry', () => {
      const legacy = JSON.stringify({ superseded: { content: 'legacy text', at: 1 } });
      const parsed = JSON.parse(appendSupersededHistory(legacy, { content: 'newer text', at: 2 })) as {
        superseded: Array<{ content: string }>;
      };
      expect(parsed.superseded.map((e) => e.content)).toEqual(['legacy text', 'newer text']);
    });

    it('records every replaced text when content is replaced repeatedly', () => {
      const id = generateId();
      insertMemory(
        db,
        { id, namespace: NAMESPACE, content: 'v1', tags: undefined, importance: 0.5 },
        randomEmbedding(),
      );
      updateMemoryContent(db, NAMESPACE, id, 'v2', randomEmbedding(), 0.5, 'v1');
      updateMemoryContent(db, NAMESPACE, id, 'v3', randomEmbedding(), 0.5, 'v2');

      const [mem] = getMemoriesByIds(db, NAMESPACE, [id]);
      expect(mem.content).toBe('v3');
      const meta = JSON.parse(mem.metadata ?? '{}') as { superseded: Array<{ content: string }> };
      expect(meta.superseded.map((e) => e.content)).toEqual(['v1', 'v2']);
      expect(updateMemoryContent(db, NAMESPACE, 'missing', 'x', randomEmbedding(), 0.5, 'y')).toBe(false);
    });
  });

  describe('mergeMemoryMetadata', () => {
    it('merges tags, importance, source and timestamps without touching the content', () => {
      const id = generateId();
      insertMemory(
        db,
        { id, namespace: NAMESPACE, content: 'kept text', tags: ['a'], importance: 0.4, createdAt: 5_000 },
        randomEmbedding(),
      );

      expect(
        mergeMemoryMetadata(db, NAMESPACE, id, {
          tags: ['a', 'b'],
          importance: 0.8,
          source: 'session:1',
          createdAt: 1_000,
          lastAccessedAt: 9_000,
        }),
      ).toBe(true);
      // A lower importance never lowers it; an existing source is kept.
      mergeMemoryMetadata(db, NAMESPACE, id, { tags: ['a', 'b'], importance: 0.1, source: 'session:2' });

      const [mem] = getMemoriesByIds(db, NAMESPACE, [id]);
      expect(mem.content).toBe('kept text');
      expect(JSON.parse(mem.tags ?? '[]')).toEqual(['a', 'b']);
      expect(mem.importance).toBeCloseTo(0.8, 5);
      expect(mem.source).toBe('session:1');
      expect(mem.created_at).toBe(1_000);
      expect(mem.last_accessed_at).toBe(9_000);
      expect(mergeMemoryMetadata(db, NAMESPACE, 'missing', { tags: [], importance: 0 })).toBe(false);
    });
  });

  it('isolates namespaces', () => {
    insertMemory(
      db,
      { id: generateId(), namespace: 'ns1', content: 'NS1 memory', tags: undefined, importance: 0.5 },
      randomEmbedding(),
    );
    insertMemory(
      db,
      { id: generateId(), namespace: 'ns2', content: 'NS2 memory', tags: undefined, importance: 0.5 },
      randomEmbedding(),
    );

    const stats1 = getNamespaceStats(db, 'ns1');
    const stats2 = getNamespaceStats(db, 'ns2');
    expect(stats1.total_memories).toBe(1);
    expect(stats2.total_memories).toBe(1);
  });

  // Schema 3 and 4 databases are migrated in place (WP-94); see migrations.test.ts for
  // the migration chain, legacy rebuilds and concurrent opens.
  describe('canonical schema & stale-DB upgrade (§4)', () => {
    function columnNames(database: Database.Database, table: string): string[] {
      const cols = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      return cols.map((c) => c.name);
    }

    function tableNames(database: Database.Database): string[] {
      const rows = database.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{
        name: string;
      }>;
      return rows.map((r) => r.name);
    }

    function schemaVersion(database: Database.Database): string | undefined {
      const row = database.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get() as
        { value: string } | undefined;
      return row?.value;
    }

    it('is born with the segments table, the segment_id and content_hash columns, and version 5', () => {
      // beforeEach already opened a fresh DB via initDatabase.
      expect(tableNames(db)).toContain('segments');
      expect(columnNames(db, 'memories')).toContain('segment_id');
      expect(columnNames(db, 'segments')).toContain('content_hash');
      expect(schemaVersion(db)).toBe('5');
    });

    it('backs up, then migrates a stale v3-shaped DB in place, keeping its rows', async () => {
      const staleDir = mkdtempSync(join(tmpdir(), 'memory-stale-'));
      const stalePath = join(staleDir, 'stale.db');

      // Build a v3-shaped DB by hand: a `memories` table WITHOUT segment_id, a
      // schema_meta stamped '3', and one pre-change row.
      const Database = (await import('better-sqlite3')).default;
      const stale = new Database(stalePath);
      stale.exec(`
        CREATE TABLE memories (
          id TEXT PRIMARY KEY,
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
        CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT);
        INSERT INTO schema_meta (key, value) VALUES ('schema_version', '3');
        INSERT INTO memories (id, namespace, content, created_at, updated_at, last_accessed_at)
          VALUES ('old-row', 'test', 'stale pre-change row', 1, 1, 1);
      `);
      stale.close();

      // Reopen via initDatabase: must upgrade in place, not crash and not drop the data.
      const reopened = initDatabase(stalePath, TEST_MODEL);
      try {
        expect(tableNames(reopened)).toContain('segments');
        expect(tableNames(reopened)).toContain('vec_memories');
        expect(tableNames(reopened)).toContain('memories_fts');
        expect(columnNames(reopened, 'memories')).toContain('segment_id');
        expect(schemaVersion(reopened)).toBe('5');

        // A `segment_id` SELECT must NOT throw `no such column`.
        const selectSegment = (): unknown =>
          reopened.prepare(`SELECT segment_id FROM memories WHERE namespace = ?`).all('test');
        expect(selectSegment).not.toThrow();

        // The live DB was migrated, so the pre-change row is still there, without a segment,
        // and keyword search finds it (the missing FTS index was rebuilt for it).
        const oldRow = getMemoriesByIds(reopened, 'test', ['old-row']);
        expect(oldRow).toHaveLength(1);
        expect(oldRow[0].content).toBe('stale pre-change row');
        expect(oldRow[0].segment_id).toBeNull();
        expect(ftsSearch(reopened, 'test', 'stale pre-change', 5).map((r) => r.id)).toEqual(['old-row']);

        const backups = readdirSync(staleDir).filter(
          (name) => name.startsWith('stale.db.backup-schema-v3-before-v5-') && name.endsWith('.db'),
        );
        expect(backups).toHaveLength(1);

        const backup = new Database(join(staleDir, backups[0]));
        try {
          expect(schemaVersion(backup)).toBe('3');
          expect(columnNames(backup, 'memories')).not.toContain('segment_id');
          const preserved = backup.prepare(`SELECT content FROM memories WHERE id = ?`).get('old-row') as
            { content: string } | undefined;
          expect(preserved?.content).toBe('stale pre-change row');
        } finally {
          backup.close();
        }

        // The rebuilt DB round-trips store/recall (insert + read back).
        const id = generateId();
        insertMemory(
          reopened,
          { id, namespace: 'test', content: 'fresh after rebuild', tags: undefined, importance: 0.5 },
          randomEmbedding(),
        );
        const back = getMemoriesByIds(reopened, 'test', [id]);
        expect(back).toHaveLength(1);
        expect(back[0].content).toBe('fresh after rebuild');
        expect(back[0].segment_id).toBeNull();
      } finally {
        reopened.close();
        rmSync(staleDir, { recursive: true, force: true });
      }
    });

    it('backup faithfully preserves a realistic v3 DB (vec0 + FTS5 virtual tables), data intact', async () => {
      const Database = (await import('better-sqlite3')).default;

      const staleDir = mkdtempSync(join(tmpdir(), 'memory-stale-vtab-'));
      const stalePath = join(staleDir, 'stale.db');

      // A faithful pre-v4 database: the production schema minus `segment_id` and
      // the `segments` table, but WITH the sqlite-vec and FTS5 virtual tables a
      // real 0.1.x DB carries — the case `VACUUM INTO` actually has to copy.
      const stale = new Database(stalePath);
      stale.pragma('journal_mode = WAL');
      sqliteVec.load(stale);
      stale.exec(`
        CREATE TABLE memories (
          id TEXT PRIMARY KEY,
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
        CREATE VIRTUAL TABLE vec_memories USING vec0(
          memory_id TEXT PRIMARY KEY,
          embedding float[${EMBEDDING_DIMENSIONS}]
        );
        CREATE VIRTUAL TABLE memories_fts USING fts5(
          content, tags, content=memories, content_rowid=rowid, tokenize='porter unicode61'
        );
        CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT);
        INSERT INTO schema_meta (key, value) VALUES ('schema_version', '3');
      `);

      const embedding = randomEmbedding();
      const embeddingBuf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
      const insert = stale.transaction(() => {
        stale
          .prepare(
            `INSERT INTO memories (id, namespace, content, created_at, updated_at, last_accessed_at)
             VALUES (?, 'test', ?, 1, 1, 1)`,
          )
          .run('vrow', 'parrots are remarkably clever birds');
        const { rowid } = stale.prepare(`SELECT rowid FROM memories WHERE id = ?`).get('vrow') as { rowid: number };
        stale.prepare(`INSERT INTO vec_memories (memory_id, embedding) VALUES (?, ?)`).run('vrow', embeddingBuf);
        stale
          .prepare(`INSERT INTO memories_fts (rowid, content, tags) VALUES (?, ?, ?)`)
          .run(rowid, 'parrots are remarkably clever birds', null);
      });
      insert();
      stale.close();

      const reopened = initDatabase(stalePath, TEST_MODEL);
      try {
        // The live DB was migrated to v5 with its data: the row, its vector and its keyword index.
        expect(schemaVersion(reopened)).toBe('5');
        expect(columnNames(reopened, 'memories')).toContain('segment_id');
        expect(getMemoriesByIds(reopened, 'test', ['vrow'])).toHaveLength(1);
        expect(vectorSearch(reopened, 'test', embedding, 1).map((r) => r.id)).toEqual(['vrow']);
        expect(ftsSearch(reopened, 'test', 'parrots', 5).map((r) => r.id)).toEqual(['vrow']);

        const backups = readdirSync(staleDir).filter(
          (name) => name.startsWith('stale.db.backup-schema-v3-before-v5-') && name.endsWith('.db'),
        );
        expect(backups).toHaveLength(1);

        // The backup must preserve the old schema AND the contents of all three
        // tables — including the sqlite-vec and FTS5 virtual-table data.
        const backup = new Database(join(staleDir, backups[0]), { readonly: true });
        sqliteVec.load(backup);
        try {
          expect(schemaVersion(backup)).toBe('3');
          expect(columnNames(backup, 'memories')).not.toContain('segment_id');

          const row = backup.prepare(`SELECT content FROM memories WHERE id = ?`).get('vrow') as
            { content: string } | undefined;
          expect(row?.content).toBe('parrots are remarkably clever birds');

          // sqlite-vec data survived: the stored embedding's nearest neighbour is
          // itself at ~0 cosine distance, i.e. the vector bytes are intact.
          expect((backup.prepare(`SELECT count(*) AS c FROM vec_memories`).get() as { c: number }).c).toBe(1);
          const knn = backup
            .prepare(
              `SELECT memory_id, vec_distance_cosine(embedding, ?) AS distance
               FROM vec_memories ORDER BY distance ASC LIMIT 1`,
            )
            .get(embeddingBuf) as { memory_id: string; distance: number };
          expect(knn.memory_id).toBe('vrow');
          expect(knn.distance).toBeCloseTo(0, 5);

          // FTS5 index survived: a MATCH still finds the row.
          const ftsHits = backup.prepare(`SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?`).all('parrots');
          expect(ftsHits).toHaveLength(1);
        } finally {
          backup.close();
        }
      } finally {
        reopened.close();
        rmSync(staleDir, { recursive: true, force: true });
      }
    });

    it('re-opening a current (v5) DB is a no-op (no drop, no throw, no backup)', () => {
      const dir = mkdtempSync(join(tmpdir(), 'memory-reopen-'));
      const path = join(dir, 'reopen.db');

      const first = initDatabase(path, TEST_MODEL);
      const id = generateId();
      insertMemory(
        first,
        { id, namespace: 'test', content: 'survives reopen', tags: undefined, importance: 0.5 },
        randomEmbedding(),
      );
      first.close();

      const second = initDatabase(path, TEST_MODEL);
      try {
        expect(schemaVersion(second)).toBe('5');
        // The row from the first open is still present (no drop happened).
        const back = getMemoriesByIds(second, 'test', [id]);
        expect(back).toHaveLength(1);
        expect(back[0].content).toBe('survives reopen');
        expect(readdirSync(dir).filter((name) => name.includes('.backup-'))).toEqual([]);
      } finally {
        second.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('fails closed on a NEWER (v6) DB: throws and does NOT drop the data', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'memory-newer-'));
      const path = join(dir, 'newer.db');

      // Build a current v5 DB, insert a row, then bump its stamp to a future '6' to
      // simulate a DB written by a newer binary being opened by this older one.
      const seeded = initDatabase(path, TEST_MODEL);
      const id = generateId();
      insertMemory(
        seeded,
        { id, namespace: 'test', content: 'newer-schema row must survive', tags: undefined, importance: 0.5 },
        randomEmbedding(),
      );
      seeded.prepare(`UPDATE schema_meta SET value = '6' WHERE key = 'schema_version'`).run();
      seeded.close();

      try {
        // Opening must fail closed: throw a clear error, never drop.
        expect(() => initDatabase(path, TEST_MODEL)).toThrow(/newer than/);

        // The newer DB was left untouched: reopen it directly (bypassing the guard)
        // and confirm the schema_meta stamp and the data both survive.
        const Database = (await import('better-sqlite3')).default;
        const survivor = new Database(path);
        try {
          const stamp = survivor.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get() as {
            value: string;
          };
          expect(stamp.value).toBe('6');
          const row = survivor.prepare(`SELECT content FROM memories WHERE id = ?`).get(id) as
            { content: string } | undefined;
          expect(row?.content).toBe('newer-schema row must survive');
        } finally {
          survivor.close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
