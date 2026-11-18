/**
 * memory_forget by query with a stubbed embedder, so every distance is exact: the
 * query's relevance cut-off and the other criteria select together, before the cap.
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
import { insertMemory, getNamespaceStats } from '../src/storage/queries.js';
import { createMemoryEngineFromConfig } from '../src/engine-impl.js';
import type { MemoryEngine } from '../src/engine.js';
import { loadConfig } from '../src/config.js';
import { testModelEnv } from './helpers/test-models.js';
import { handleForget } from '../src/tools/forget.js';
import { FORGET_QUERY_LIMIT } from '../src/storage/constants.js';

const NAMESPACE = 'test';

/** Unit vector `sum(coeffs[i] * e_i)`; unit(1, x) lies 1 - 1/sqrt(1 + x^2) from unit(1). */
function unit(...coeffs: number[]): Float32Array {
  const v = new Float32Array(EMBEDDING_DIMENSIONS);
  const norm = Math.sqrt(coeffs.reduce((sum, c) => sum + c * c, 0));
  coeffs.forEach((c, i) => {
    v[i] = c / norm;
  });
  return v;
}

/**
 * A bulk forget that deleted something answers with the count and the snapshot of the
 * database it saved first (see trust-model.test.ts and forget-snapshot.test.ts).
 */
function expectBulkForgot(reply: string, count: number, truncated = false): void {
  const head =
    `Forgot ${count} memories.` +
    (truncated ? ' (results were truncated — more memories match; run again to continue)' : '');
  expect(reply.slice(0, head.length)).toBe(head);
  expect(reply.slice(head.length)).toMatch(
    /^ A snapshot of the memory database from before this deletion was saved as /,
  );
}

describe('memory_forget by query (exact distances)', () => {
  let tmpDir: string;
  let engine: MemoryEngine;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memory-forget-query-'));
    const config = {
      ...loadConfig(testModelEnv()),
      dbPath: join(tmpDir, 'test.db'),
      namespace: NAMESPACE,
      llmApiKey: null,
      llmBaseUrl: null,
      maintenanceInterval: 100_000,
    };
    engine = createMemoryEngineFromConfig(config);
    db = initDatabase(config.dbPath, config.embeddingModel);
    stub.queries.clear();
    stub.queries.set('fruit', unit(1));
  });

  afterEach(() => {
    engine.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function put(id: string, embedding: Float32Array, tags?: string[]): void {
    insertMemory(db, { id, namespace: NAMESPACE, content: `memory ${id}`, tags, importance: 0.5 }, embedding);
  }

  // The selection used to take the 50 nearest memories first and apply the tags
  // afterwards: with 60 closer untagged matches it forgot nothing and answered
  // "Forgot 0 memories. (results were truncated ...; run again)" on every retry.
  it('forgets matches that lie behind closer memories another criterion excludes', async () => {
    const insertAll = db.transaction(() => {
      for (let i = 0; i < 60; i++) put(`untagged-${i}`, unit(1, 0.01 * (i + 1)));
    });
    insertAll();
    put('tagged-a', unit(1, 0.7), ['diet']);
    put('tagged-b', unit(1, 0.71), ['diet']);

    expectBulkForgot(await handleForget(engine, { query: 'fruit', tags: ['diet'], confirm: true }), 2);
    expect(getNamespaceStats(db, NAMESPACE).total_memories).toBe(60);
  });

  it('reports truncation only while more matches remain, so a rerun makes progress', async () => {
    const extra = 3;
    for (let i = 0; i < FORGET_QUERY_LIMIT + extra; i++) put(`match-${i}`, unit(1, 0.05 * (i + 1)), ['diet']);
    put('unrelated', unit(0, 1), ['diet']);

    expectBulkForgot(
      await handleForget(engine, { query: 'fruit', tags: ['diet'], confirm: true }),
      FORGET_QUERY_LIMIT,
      true,
    );
    expectBulkForgot(await handleForget(engine, { query: 'fruit', tags: ['diet'], confirm: true }), extra);
    expect(await handleForget(engine, { query: 'fruit', tags: ['diet'], confirm: true })).toBe('Forgot 0 memories.');
    expect(getNamespaceStats(db, NAMESPACE).total_memories).toBe(1);
  });
});
