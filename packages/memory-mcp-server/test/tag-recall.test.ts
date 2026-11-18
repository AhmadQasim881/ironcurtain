/**
 * Tag-scoped recall (MEM-18): `tags` used to filter the top 50 vector and top 50 keyword
 * candidates after they were chosen, so a tagged memory with 50 closer, better-matching
 * untagged memories ahead of it in both channels was never found ("No relevant memories
 * found."). The tag scope now applies inside both searches, before their limits.
 *
 * The query embedding is stubbed so every vector distance is exact; the memories are
 * stored with chosen vectors. The reranker is off.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';

const stub = vi.hoisted(() => ({ queries: new Map<string, Float32Array>() }));
vi.mock('../src/embedding/embedder.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/embedding/embedder.js')>();
  return {
    ...real,
    embedQuery: vi.fn(async (text: string) => {
      const vector = stub.queries.get(text);
      if (!vector) throw new Error(`no stub vector for query '${text}'`);
      return vector;
    }),
  };
});

import { initDatabase, EMBEDDING_DIMENSIONS } from '../src/storage/database.js';
import { insertMemory } from '../src/storage/queries.js';
import { createMemoryEngineFromConfig } from '../src/engine-impl.js';
import type { MemoryEngine } from '../src/engine.js';
import { loadConfig } from '../src/config.js';

const NAMESPACE = 'test';
const QUERY = 'which database does the service use';
const TAGGED = 'Project foo keeps its records in a managed relational store';

/** Unit vector `sum(coeffs[i] * e_i)`; unit(1, x) lies 1 - 1/sqrt(1 + x^2) from unit(1). */
function unit(...coeffs: number[]): Float32Array {
  const v = new Float32Array(EMBEDDING_DIMENSIONS);
  const norm = Math.sqrt(coeffs.reduce((sum, c) => sum + c * c, 0));
  coeffs.forEach((c, i) => {
    v[i] = c / norm;
  });
  return v;
}

describe('tag-scoped recall', () => {
  let tmpDir: string;
  let engine: MemoryEngine;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memory-tag-recall-'));
    const config = {
      ...loadConfig({}),
      dbPath: join(tmpDir, 'test.db'),
      namespace: NAMESPACE,
      llmApiKey: null,
      llmBaseUrl: null,
      rerankerEnabled: false,
      maintenanceInterval: 100_000,
    };
    engine = createMemoryEngineFromConfig(config);
    db = initDatabase(config.dbPath, config.embeddingModel);
    stub.queries.clear();
    stub.queries.set(QUERY, unit(1));

    // 70 untagged memories about databases: each is closer to the query than the tagged
    // one and matches its keywords, so they fill the top 50 of both channels.
    const insertAll = db.transaction(() => {
      for (let i = 0; i < 70; i++) {
        insertMemory(
          db,
          {
            id: `untagged-${i}`,
            namespace: NAMESPACE,
            content: `Service ${i} uses a PostgreSQL database for its service data`,
            tags: undefined,
            importance: 0.5,
          },
          unit(1, 0.01 * (i + 1)),
        );
      }
    });
    insertAll();
    insertMemory(
      db,
      { id: 'tagged', namespace: NAMESPACE, content: TAGGED, tags: ['project:foo'], importance: 0.5 },
      unit(1, 1.5),
    );
  });

  afterEach(() => {
    engine.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Acceptance (MEM-18).
  it('finds a tagged memory outside the top 50 untagged neighbours', async () => {
    const unscoped = await engine.recall({ query: QUERY, format: 'raw', token_budget: 50_000 });
    expect(unscoped.content).not.toContain(TAGGED);

    const scoped = await engine.recall({ query: QUERY, tags: ['project:foo'], format: 'raw' });

    expect(scoped.memories_used).toBe(1);
    const [item] = JSON.parse(scoped.content) as Array<{ id: string; content: string; tags: string[] }>;
    expect(item).toMatchObject({ id: 'tagged', content: TAGGED, tags: ['project:foo'] });
  });

  it('returns nothing when no memory carries all of the tags', async () => {
    const result = await engine.recall({ query: QUERY, tags: ['project:foo', 'project:bar'], format: 'list' });
    expect(result.content).toBe('No relevant memories found.');
    expect(result.memories_used).toBe(0);
  });
});
