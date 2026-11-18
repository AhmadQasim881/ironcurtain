/**
 * Compaction (MEM-8): decayed memories have no vector (the KNN index holds live
 * memories only), so compaction embeds their text itself, clusters it, and replaces a
 * cluster with one summary. The summary is written only while every memory it
 * summarizes is unchanged, so a memory forgotten while the summary was being written
 * does not live on in it, and overlapping passes do not summarize a cluster twice.
 *
 * Real SQLite + sqlite-vec and the real embedder (counted); the LLM is stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';

const llm = vi.hoisted(() => ({
  /** Runs inside each summary call, before it returns. */
  during: null as null | (() => void),
  calls: 0,
}));
vi.mock('../src/llm/client.js', () => ({
  getLLMClient: vi.fn(() => ({})),
  llmComplete: vi.fn(async () => {
    llm.calls += 1;
    llm.during?.();
    return 'The user jogs in Riverside Park most mornings.';
  }),
}));

const embedded = vi.hoisted(() => ({
  texts: [] as string[],
  /** When set, the vector for a text instead of the real embedder's. */
  stub: null as null | ((text: string) => Float32Array),
}));
vi.mock('../src/embedding/embedder.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/embedding/embedder.js')>();
  return {
    ...real,
    embed: vi.fn(async (text: string, config: Parameters<typeof real.embed>[1]) => {
      embedded.texts.push(text);
      return embedded.stub?.(text) ?? real.embed(text, config);
    }),
  };
});

import { initDatabase, EMBEDDING_DIMENSIONS } from '../src/storage/database.js';
import type { MemoryRow } from '../src/storage/database.js';
import { insertMemory, generateId, getMemoriesByIds, forgetMemoryRows } from '../src/storage/queries.js';
import { runCompaction } from '../src/storage/compaction.js';
import { loadConfig } from '../src/config.js';
import { testModelEnv } from './helpers/test-models.js';
import type { MemoryConfig } from '../src/config.js';

const NAMESPACE = 'test';

function testConfig(): MemoryConfig {
  return {
    ...loadConfig(testModelEnv()),
    namespace: NAMESPACE,
    llmApiKey: 'stub',
    llmBaseUrl: 'http://127.0.0.1:9/v1',
    compactionMinGroup: 10,
  };
}

describe('runCompaction', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memory-compaction-'));
    db = initDatabase(join(tmpDir, 'test.db'), 'test-model');
    llm.during = null;
    llm.calls = 0;
    embedded.texts = [];
    embedded.stub = null;
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** A decayed memory as markDecayed leaves it: importance 0 and no vector. */
  function putDecayed(content: string, createdAt = Date.parse('2025-01-01')): string {
    const id = generateId();
    insertMemory(
      db,
      { id, namespace: NAMESPACE, content, tags: undefined, importance: 0, createdAt },
      new Float32Array(EMBEDDING_DIMENSIONS),
    );
    db.prepare(`DELETE FROM vec_memories WHERE memory_id = ?`).run(id);
    return id;
  }

  /** The unit vector along axis `axis`, tilted slightly towards `tilt` when given. */
  function axisVector(axis: number, tilt?: number): Float32Array {
    const v = new Float32Array(EMBEDDING_DIMENSIONS);
    v[axis] = 1;
    if (tilt !== undefined) v[tilt] = 0.05;
    const norm = Math.hypot(...v);
    return v.map((x) => x / norm);
  }

  function summaries(): MemoryRow[] {
    return db.prepare(`SELECT * FROM memories WHERE source = 'compaction'`).all() as MemoryRow[];
  }

  function compactedFrom(row: MemoryRow): string[] {
    return [...((JSON.parse(row.metadata ?? '{}') as { compacted_from?: string[] }).compacted_from ?? [])].sort();
  }

  function joggingIds(count: number, label: string): string[] {
    return Array.from({ length: count }, (_, i) =>
      putDecayed(`The user went jogging in Riverside Park on the morning of ${label} ${i + 1}`),
    );
  }

  it('embeds the decayed texts itself and replaces the cluster with an LLM summary', async () => {
    const ids = joggingIds(12, 'March');

    expect(await runCompaction(db, testConfig())).toBe(12);

    const [summary, ...rest] = summaries();
    expect(rest).toEqual([]);
    expect(summary.content).toBe('The user jogs in Riverside Park most mornings.');
    expect(compactedFrom(summary)).toEqual([...ids].sort());
    expect(getMemoriesByIds(db, NAMESPACE, ids).every((m) => m.is_compacted === 1)).toBe(true);
    expect(embedded.texts.filter((t) => t.includes('March'))).toHaveLength(12);
  });

  it('does not write a summary of a memory that was forgotten while the summary was being written', async () => {
    const ids = joggingIds(12, 'April');
    llm.during = () => {
      llm.during = null;
      forgetMemoryRows(db, NAMESPACE, [ids[0]]);
    };

    expect(await runCompaction(db, testConfig())).toBe(0);
    expect(summaries()).toEqual([]);
    expect(getMemoriesByIds(db, NAMESPACE, ids.slice(1)).every((m) => m.is_compacted === 0)).toBe(true);

    // The next pass summarizes what is left.
    expect(await runCompaction(db, testConfig())).toBe(11);
    expect(compactedFrom(summaries()[0])).toEqual(ids.slice(1).sort());
  });

  it('writes one summary when two passes compact the same cluster at once', async () => {
    const ids = joggingIds(12, 'May');

    const [first, second] = await Promise.all([runCompaction(db, testConfig()), runCompaction(db, testConfig())]);

    expect(first + second).toBe(12);
    expect(summaries()).toHaveLength(1);
    expect(compactedFrom(summaries()[0])).toEqual([...ids].sort());
  });

  // A summary states the text of the memories it replaced (the extractive fallback copies
  // it, and the LLM is told to keep names, dates and numbers), and they hold its text.
  it('forgetting a compacted memory deletes its summary; the next pass summarizes the rest again', async () => {
    const ids = joggingIds(12, 'June');
    expect(await runCompaction(db, testConfig())).toBe(12);
    const [first] = summaries();

    expect(forgetMemoryRows(db, NAMESPACE, [ids[0]])).toBe(1);

    expect(summaries()).toEqual([]);
    expect(getMemoriesByIds(db, NAMESPACE, [first.id, ids[0]])).toEqual([]);
    const rest = getMemoriesByIds(db, NAMESPACE, ids.slice(1));
    expect(rest.every((m) => m.is_compacted === 0 && m.importance === 0)).toBe(true);

    expect(await runCompaction(db, testConfig())).toBe(11);
    expect(compactedFrom(summaries()[0])).toEqual(ids.slice(1).sort());
  });

  it('forgetting a summary deletes the memories it replaced', async () => {
    const ids = joggingIds(12, 'July');
    expect(await runCompaction(db, testConfig())).toBe(12);
    const [summary] = summaries();

    expect(forgetMemoryRows(db, NAMESPACE, [summary.id])).toBe(1);

    expect(getMemoriesByIds(db, NAMESPACE, [summary.id, ...ids])).toEqual([]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM memories`).get()).toEqual({ n: 0 });
  });

  it('does not embed again the decayed memories an earlier pass could not cluster', async () => {
    const topics = [
      'The user owns a red bicycle',
      'The quarterly tax filing is due in April',
      'The office coffee machine is broken',
      'Alice prefers Rust over Go',
      'The staging cluster runs in Frankfurt',
      'The cat is named Pixel',
      'The VPN certificate expires in March',
      'Bob moved to the London team',
      'The user is allergic to peanuts',
      'The build uses Bazel',
    ];
    for (const topic of topics) putDecayed(topic);

    expect(await runCompaction(db, testConfig())).toBe(0);
    expect(embedded.texts).toHaveLength(10);

    expect(await runCompaction(db, testConfig())).toBe(0);
    expect(embedded.texts).toHaveLength(10);
    expect(llm.calls).toBe(0);
  });

  // A pass reads at most 200 decayed memories. Reading only the 200 oldest, a namespace
  // whose oldest decayed memories never cluster never compacted a newer one (FU-05).
  it('pages past decayed memories that never cluster to the newer ones', async () => {
    const OLD = Date.parse('2025-01-01');
    const singletons = Array.from({ length: 200 }, (_, i) => `Unrelated decayed note number ${i}`);
    const chess = [0, 1, 2].map((i) => `The user played chess at the club, game ${i + 1}`);
    // Mutually orthogonal vectors for the old notes; nearly the same one for the chess games.
    embedded.stub = (text) => {
      const old = singletons.indexOf(text);
      if (old >= 0) return axisVector(old);
      const game = chess.indexOf(text);
      return game >= 0 ? axisVector(700, 701 + game) : axisVector(767);
    };
    singletons.forEach((text, i) => putDecayed(text, OLD + i));
    const chessIds = chess.map((text, i) => putDecayed(text, OLD + 1000 + i));

    const passes = [await runCompaction(db, testConfig()), await runCompaction(db, testConfig())];

    expect(passes).toEqual([0, 3]);
    expect(getMemoriesByIds(db, NAMESPACE, chessIds).every((m) => m.is_compacted === 1)).toBe(true);
    const [summary, ...rest] = summaries();
    expect(rest).toEqual([]);
    expect(compactedFrom(summary)).toEqual([...chessIds].sort());
  });
});
