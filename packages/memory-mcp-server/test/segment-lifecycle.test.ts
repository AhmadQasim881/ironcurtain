/**
 * Source segments live only as long as a live memory references them (MEM-3). Before,
 * forgetting an ingested fact deleted the fact row only: the raw chunk it was extracted
 * from stayed on disk, memory_expand returned it, and a default recall expanded it back
 * through the fact's siblings. Re-ingesting a document also left an orphan segment per
 * ingest.
 *
 * Real SQLite + sqlite-vec and the real embedder; the extraction LLM is stubbed and the
 * reranker is off.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';

const llmMock = vi.hoisted(() => ({ responses: [] as Array<string | null> }));
vi.mock('../src/llm/client.js', () => ({
  getLLMClient: vi.fn(() => ({})),
  llmComplete: vi.fn(async () => llmMock.responses.shift() ?? null),
}));

// The real embedder, with a hook that runs before a text is embedded: another call that
// interleaves with an ingest at exactly that point.
const embedHook = vi.hoisted(() => ({ before: null as null | ((text: string) => Promise<void>) }));
vi.mock('../src/embedding/embedder.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/embedding/embedder.js')>();
  return {
    ...real,
    embed: vi.fn(async (text: string, config: Parameters<typeof real.embed>[1]) => {
      await embedHook.before?.(text);
      return real.embed(text, config);
    }),
  };
});

import { initDatabase } from '../src/storage/database.js';
import type { MemoryRow, SegmentRow } from '../src/storage/database.js';
import { getMemoriesByIds, markDecayed } from '../src/storage/queries.js';
import { createMemoryEngineFromConfig } from '../src/engine-impl.js';
import type { MemoryEngine } from '../src/engine.js';
import { loadConfig } from '../src/config.js';
import { testModelEnv } from './helpers/test-models.js';
import type { MemoryConfig } from '../src/config.js';
import { handleForget } from '../src/tools/forget.js';
import { handleExpand } from '../src/tools/expand.js';
import { MIN_STORED_IMPORTANCE } from '../src/tools/validation.js';

const NAMESPACE = 'test';

function testConfig(dbPath: string): MemoryConfig {
  return {
    ...loadConfig(testModelEnv()),
    dbPath,
    namespace: NAMESPACE,
    llmApiKey: 'test-key',
    llmBaseUrl: 'http://localhost:1234/v1',
    maintenanceInterval: 100_000,
    rerankerEnabled: false,
  };
}

function extracts(facts: string[]): void {
  llmMock.responses = [JSON.stringify(facts.map((fact) => ({ fact, importance: 0.6 })))];
}

const PROFILE_CHUNK = [
  'Notes from the onboarding call with the user.',
  '',
  'Her name is Alice Moreau. She lives at 12 Elm Street, Springfield, with her two cats.',
  '',
  'She prefers dark mode in every editor and uses a split keyboard.',
].join('\n');

const NAME_FACT = 'The user is named Alice Moreau';
const ADDRESS_FACT = 'The user lives at 12 Elm Street, Springfield';
const DARK_MODE_FACT = 'The user prefers dark mode in every editor';

describe('source segment lifecycle', () => {
  let tmpDir: string;
  let engine: MemoryEngine;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memory-segments-'));
    const config = testConfig(join(tmpDir, 'test.db'));
    engine = createMemoryEngineFromConfig(config);
    db = initDatabase(config.dbPath, config.embeddingModel);
    llmMock.responses = [];
    embedHook.before = null;
  });

  afterEach(() => {
    engine.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function segments(): SegmentRow[] {
    return db.prepare(`SELECT * FROM segments ORDER BY created_at, id`).all() as SegmentRow[];
  }

  function rowWith(content: string): MemoryRow {
    const row = db.prepare(`SELECT * FROM memories WHERE namespace = ? AND content = ?`).get(NAMESPACE, content) as
      MemoryRow | undefined;
    expect(row).toBeDefined();
    return row as MemoryRow;
  }

  async function ingestProfile(): Promise<string> {
    extracts([NAME_FACT, ADDRESS_FACT, DARK_MODE_FACT]);
    const result = await engine.ingest(PROFILE_CHUNK, { mode: 'document' });
    expect(result.created).toBe(3);
    expect(result.segments_created).toBe(1);
    const [segment] = segments();
    return segment.id;
  }

  // Acceptance (MEM-3).
  it('forgetting an ingested fact makes memory_expand of its segment return found:false', async () => {
    const segmentId = await ingestProfile();
    const before = await engine.expand(segmentId);
    expect(before.found).toBe(true);
    expect(before.passages.join('\n')).toContain('12 Elm Street');

    const reply = await handleForget(engine, { ids: [rowWith(ADDRESS_FACT).id] });
    expect(reply.startsWith('Forgot 1 memories.')).toBe(true);

    expect(await engine.expand(segmentId)).toEqual({
      segment_id: segmentId,
      passages: [],
      total_passages: 0,
      found: false,
    });
    expect(await engine.expand(segmentId, 'where does the user live')).toEqual({
      segment_id: segmentId,
      passages: [],
      total_passages: 0,
      found: false,
    });
    expect(await handleExpand(engine, { segment_id: segmentId })).toBe(`No source segment found for id ${segmentId}.`);
  });

  it('removes the forgotten text from disk, and recall no longer expands it through the siblings', async () => {
    await ingestProfile();
    const query = 'Alice Moreau dark mode editor preferences';
    const expandedBefore = await engine.recall({ query, format: 'raw', expand: 'parent', token_budget: 4000 });
    expect(expandedBefore.content).toContain('12 Elm Street');

    await handleForget(engine, { ids: [rowWith(ADDRESS_FACT).id] });

    // The source is gone, not just hidden: no table holds the text any more.
    expect(segments()).toEqual([]);
    const stored = db.prepare(`SELECT content FROM memories UNION ALL SELECT content FROM segments`).all() as Array<{
      content: string;
    }>;
    expect(stored.some((r) => r.content.includes('Elm Street'))).toBe(false);
    // The siblings keep their text and lose only the source link.
    expect(rowWith(NAME_FACT).segment_id).toBeNull();
    expect(rowWith(DARK_MODE_FACT).segment_id).toBeNull();

    for (const expand of ['auto', 'parent'] as const) {
      const after = await engine.recall({ query, format: 'raw', expand, token_budget: 4000 });
      expect(after.content).not.toContain('Elm Street');
      expect(after.content).toContain(DARK_MODE_FACT);
      expect(after.expanded).toBe(false);
    }
  });

  it('re-ingesting the same chunk leaves no orphan segment', async () => {
    await ingestProfile();

    extracts([NAME_FACT, ADDRESS_FACT, DARK_MODE_FACT]);
    const again = await engine.ingest(PROFILE_CHUNK, { mode: 'document' });

    expect(again.merged).toBe(3);
    expect(again.segments_created).toBeUndefined();
    expect(segments()).toHaveLength(1);
    expect(new Set([NAME_FACT, ADDRESS_FACT, DARK_MODE_FACT].map((f) => rowWith(f).segment_id))).toEqual(
      new Set([segments()[0].id]),
    );
  });

  it('deletes the poorer source when a richer ingest of the same fact takes over', async () => {
    extracts([DARK_MODE_FACT]);
    await engine.ingest('She prefers dark mode in every editor.', {});
    expect(segments()).toHaveLength(1);

    extracts([DARK_MODE_FACT, NAME_FACT, ADDRESS_FACT]);
    const rich = await engine.ingest(PROFILE_CHUNK, {});

    expect(rich.merged).toBe(1);
    expect(rich.segments_created).toBe(1);
    const [only] = segments();
    expect(segments()).toHaveLength(1);
    expect(only.fact_count).toBe(3);
    expect(rowWith(DARK_MODE_FACT).segment_id).toBe(only.id);
  });

  // The same fact extracted from two chunks: an edited version of a document ingested
  // again. The memory links to one chunk; the other states its text as well and must go
  // with it (before, it stayed, and memory_expand and recall expansion returned it).
  describe('a fact several chunks state', () => {
    const LIGHT_MODE_FACT = 'The user prefers light mode in every editor';
    const CATS_FACT = 'The user has two cats';
    const EDITED_CHUNK = PROFILE_CHUNK.replace('dark mode', 'light mode');

    function storedTexts(): string[] {
      return (
        db.prepare(`SELECT content FROM memories UNION ALL SELECT content FROM segments`).all() as Array<{
          content: string;
        }>
      ).map((r) => r.content);
    }

    async function forgetAddressAndCheck(): Promise<void> {
      await handleForget(engine, { ids: [rowWith(ADDRESS_FACT).id] });

      expect(storedTexts().some((text) => text.includes('Elm Street'))).toBe(false);
      expect(segments()).toEqual([]);
      const recalled = await engine.recall({
        query: 'which editor colour mode does the user prefer',
        format: 'raw',
        expand: 'parent',
        token_budget: 4000,
      });
      expect(recalled.memories_used).toBeGreaterThan(0);
      expect(recalled.expanded).toBe(false);
      expect(recalled.content).not.toContain('Elm Street');
    }

    it('forgetting it deletes both chunks when the memory kept its first source', async () => {
      extracts([ADDRESS_FACT, DARK_MODE_FACT]);
      await engine.ingest(PROFILE_CHUNK, { mode: 'document' });
      const [first] = segments();
      // As rich as the first (two facts): the address memory keeps its first source.
      extracts([ADDRESS_FACT, LIGHT_MODE_FACT]);
      const second = await engine.ingest(EDITED_CHUNK, { mode: 'document' });
      expect(second).toMatchObject({ created: 1, merged: 1, segments_created: 1 });
      expect(rowWith(ADDRESS_FACT).segment_id).toBe(first.id);
      const edited = segments().find((s) => s.id !== first.id);
      expect(edited?.content).toContain('Elm Street');
      expect(JSON.parse(rowWith(ADDRESS_FACT).metadata ?? '{}')).toMatchObject({ source_segments: [edited?.id] });

      await forgetAddressAndCheck();
      expect(rowWith(DARK_MODE_FACT).segment_id).toBeNull();
      expect(rowWith(LIGHT_MODE_FACT).segment_id).toBeNull();
    });

    it('forgetting it deletes both chunks when the memory moved to the richer one', async () => {
      extracts([ADDRESS_FACT, DARK_MODE_FACT]);
      await engine.ingest(PROFILE_CHUNK, { mode: 'document' });
      const [first] = segments();
      // Richer (three facts): the address memory moves to it, and its first source,
      // which the dark-mode memory still uses, is recorded.
      extracts([ADDRESS_FACT, LIGHT_MODE_FACT, CATS_FACT]);
      await engine.ingest(EDITED_CHUNK, { mode: 'document' });
      expect(rowWith(ADDRESS_FACT).segment_id).not.toBe(first.id);
      expect(rowWith(DARK_MODE_FACT).segment_id).toBe(first.id);
      expect(JSON.parse(rowWith(ADDRESS_FACT).metadata ?? '{}')).toMatchObject({ source_segments: [first.id] });

      await forgetAddressAndCheck();
    });

    it('does not write the second chunk when the merged memory is forgotten while it is ingested', async () => {
      extracts([ADDRESS_FACT, DARK_MODE_FACT]);
      await engine.ingest(PROFILE_CHUNK, { mode: 'document' });
      // The address fact of the second ingest merges into the stored memory (which keeps
      // its source); before the next fact is stored, a forget of that memory runs.
      embedHook.before = async (text) => {
        if (text !== LIGHT_MODE_FACT) return;
        embedHook.before = null;
        await handleForget(engine, { ids: [rowWith(ADDRESS_FACT).id] });
      };
      extracts([ADDRESS_FACT, LIGHT_MODE_FACT]);
      const second = await engine.ingest(EDITED_CHUNK, { mode: 'document' });

      expect(second).toMatchObject({ created: 1, merged: 1 });
      expect(second.segments_created).toBeUndefined();
      expect(storedTexts().some((text) => text.includes('Elm Street'))).toBe(false);
      expect(rowWith(LIGHT_MODE_FACT).segment_id).toBeNull();
    });
  });

  it('reports a segment whose facts all decayed as not found, before the sweep removes it', async () => {
    const segmentId = await ingestProfile();
    for (const fact of [NAME_FACT, ADDRESS_FACT, DARK_MODE_FACT]) markDecayed(db, NAMESPACE, rowWith(fact).id);

    expect(segments()).toHaveLength(1);
    expect((await engine.expand(segmentId)).found).toBe(false);
  });

  // Importance 0 marks a decayed memory, which recall skips: a memory the agent stores
  // with importance 0 must still be recallable.
  it('stores a memory written with importance 0 at the minimum importance, so recall finds it', async () => {
    const { id } = await engine.store('The user drinks green tea every afternoon', { importance: 0 });

    expect(getMemoriesByIds(db, NAMESPACE, [id])[0].importance).toBeCloseTo(MIN_STORED_IMPORTANCE, 10);
    const recalled = await engine.recall({ query: 'what does the user drink', format: 'list' });
    expect(recalled.content).toContain('green tea');
  });
});
