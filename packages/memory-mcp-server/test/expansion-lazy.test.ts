/**
 * Recall expansion chooses passages lazily (MEM-20): it splits and embeds one segment at
 * a time, in rank order, and stops once `max_expand_passages` passages are chosen.
 * Before, every candidate segment's passages were embedded first and the cap applied
 * afterwards (about 0.5 s of embedding per long segment). The chosen passages are the
 * same: a passage dropped as an overlap duplicate still does not use a cap slot.
 *
 * The embedder is a deterministic stub that records what it embeds.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';

const embedded = vi.hoisted(() => ({ texts: [] as string[] }));
vi.mock('../src/embedding/embedder.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/embedding/embedder.js')>();
  /** A unit vector derived from the text's characters: stable, and different per text. */
  const fakeEmbedding = (text: string): Float32Array => {
    const v = new Float32Array(768);
    for (let i = 0; i < text.length; i++) v[(text.charCodeAt(i) * 31 + i) % 768] += 1;
    const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  };
  return {
    ...real,
    embed: vi.fn(async (text: string) => {
      embedded.texts.push(text);
      return fakeEmbedding(text);
    }),
    embedQuery: vi.fn(async (text: string) => fakeEmbedding(text)),
  };
});

import { initDatabase, EMBEDDING_DIMENSIONS } from '../src/storage/database.js';
import { insertMemory, insertSegment, getMemoriesByIds } from '../src/storage/queries.js';
import { expandKeptFacts } from '../src/retrieval/expansion.js';
import type { ScoredMemory } from '../src/retrieval/scoring.js';
import { splitToPassages } from '../src/storage/extraction.js';
import { embedQuery } from '../src/embedding/embedder.js';
import { loadConfig } from '../src/config.js';
import type { MemoryConfig } from '../src/config.js';

const NAMESPACE = 'test';

/** A segment of three paragraphs, each too long to share a passage with another. */
function longSegment(topic: string): string {
  return ['opening', 'middle', 'closing']
    .map((part) => `${topic} ${part} section. ` + `${topic} detail about the ${part} clause. `.repeat(30))
    .join('\n\n');
}

describe('lazy passage selection', () => {
  let tmpDir: string;
  let db: Database.Database;
  let config: MemoryConfig;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memory-lazy-expand-'));
    config = { ...loadConfig({}), dbPath: join(tmpDir, 'test.db'), namespace: NAMESPACE };
    db = initDatabase(config.dbPath, config.embeddingModel);
    embedded.texts = [];
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** One segment per entry with two facts each; returns the kept facts in rank order. */
  function seed(segments: Array<{ id: string; content: string }>): ScoredMemory[] {
    const ids: string[] = [];
    for (const segment of segments) {
      insertSegment(db, { id: segment.id, namespace: NAMESPACE, content: segment.content, factCount: 2 });
      for (const n of [1, 2]) {
        const id = `${segment.id}-fact-${n}`;
        insertMemory(
          db,
          {
            id,
            namespace: NAMESPACE,
            content: `fact ${n} of ${segment.id}`,
            tags: undefined,
            importance: 0.5,
            segmentId: segment.id,
          },
          new Float32Array(EMBEDDING_DIMENSIONS).fill(1 / Math.sqrt(EMBEDDING_DIMENSIONS)),
        );
        ids.push(id);
      }
    }
    const rows = new Map(getMemoriesByIds(db, NAMESPACE, ids).map((r) => [r.id, r]));
    return ids.map((id, rank) => {
      const row = rows.get(id);
      if (row === undefined) throw new Error(`missing ${id}`);
      return { ...row, fusionScore: 1 - rank / 100, compositeScore: 1 - rank / 100 };
    });
  }

  function embeddedPassagesOf(content: string): number {
    const passages = new Set(splitToPassages(content));
    return embedded.texts.filter((t) => passages.has(t)).length;
  }

  const ALPHA = longSegment('Alpha');
  const BRAVO = longSegment('Bravo');
  const CHARLIE = longSegment('Charlie');

  it('embeds only the segments it needs to reach max_expand_passages', async () => {
    expect(splitToPassages(ALPHA)).toHaveLength(3);
    const kept = seed([
      { id: 'alpha', content: ALPHA },
      { id: 'bravo', content: BRAVO },
      { id: 'charlie', content: CHARLIE },
    ]);
    const query = await embedQuery('detail about the clause', config);

    const one = await expandKeptFacts(db, config, kept, query, 'auto', 1, 50_000);
    expect(one.expandedSegmentIds).toEqual(['alpha']);
    expect(embeddedPassagesOf(ALPHA)).toBe(3);
    expect(embeddedPassagesOf(BRAVO)).toBe(0);
    expect(embeddedPassagesOf(CHARLIE)).toBe(0);

    embedded.texts = [];
    const two = await expandKeptFacts(db, config, kept, query, 'auto', 2, 50_000);
    expect(two.expandedSegmentIds).toEqual(['alpha', 'bravo']);
    expect(embeddedPassagesOf(CHARLIE)).toBe(0);
  });

  it('does not count a passage dropped as an overlap duplicate against the cap', async () => {
    // bravo is a copy of alpha, so its best passage repeats alpha's and is dropped.
    const kept = seed([
      { id: 'alpha', content: ALPHA },
      { id: 'bravo', content: ALPHA },
      { id: 'charlie', content: CHARLIE },
    ]);
    const query = await embedQuery('detail about the clause', config);

    const result = await expandKeptFacts(db, config, kept, query, 'auto', 2, 50_000);

    expect(result.expandedSegmentIds).toEqual(['alpha', 'charlie']);
    expect(result.units.filter((u) => u.expanded)).toHaveLength(2);
  });
});
