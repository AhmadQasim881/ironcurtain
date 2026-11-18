/**
 * Store-time dedup (MEM-5): without an LLM, a new memory is merged into an existing one
 * ONLY when both state the same fact in the same words. Before the fix any neighbour
 * under cosine distance 0.05 was merged and its text overwritten, so 'production' facts
 * were replaced by 'staging' facts and word-order reversals by their opposite.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';

// The real embedder, except for texts given a fixed vector: those simulate a model
// that cannot tell two different facts apart (distance 0).
const stub = vi.hoisted(() => ({ vectors: new Map<string, Float32Array>() }));
vi.mock('../src/embedding/embedder.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/embedding/embedder.js')>();
  return {
    ...real,
    embed: vi.fn(async (text: string, config: Parameters<typeof real.embed>[1]) => {
      return stub.vectors.get(text) ?? real.embed(text, config);
    }),
  };
});

import { initDatabase, EMBEDDING_DIMENSIONS } from '../src/storage/database.js';
import { getMemoriesByIds } from '../src/storage/queries.js';
import { createMemoryEngineFromConfig } from '../src/engine-impl.js';
import type { MemoryEngine } from '../src/engine.js';
import { loadConfig } from '../src/config.js';
import { testModelEnv } from './helpers/test-models.js';
import { normalizeFactText } from '../src/utils/fact-text.js';
import type { MemoryRow } from '../src/storage/database.js';

const NAMESPACE = 'test';

function fixedVector(): Float32Array {
  const v = new Float32Array(EMBEDDING_DIMENSIONS);
  v[0] = 1;
  return v;
}

describe('store-time dedup', () => {
  let tmpDir: string;
  let engine: MemoryEngine;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memory-store-dedup-'));
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
    stub.vectors.clear();
  });

  afterEach(() => {
    engine.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function rows(): MemoryRow[] {
    return db.prepare(`SELECT * FROM memories WHERE namespace = ? ORDER BY created_at`).all(NAMESPACE) as MemoryRow[];
  }

  it('does not merge "The API runs in production" and "The API runs in staging", even at distance 0', async () => {
    stub.vectors.set('The API runs in production', fixedVector());
    stub.vectors.set('The API runs in staging', fixedVector());

    const first = await engine.store('The API runs in production', { importance: 0.9 });
    const second = await engine.store('The API runs in staging', {});

    expect(second.action).toBe('created');
    expect(second.id).not.toBe(first.id);
    expect(getMemoriesByIds(db, NAMESPACE, [first.id])[0].content).toBe('The API runs in production');
    expect(rows().map((r) => r.content)).toEqual(['The API runs in production', 'The API runs in staging']);
  });

  // Pairs measured under 0.05 with the shipped bge-base q8 model (0.0095, 0.0498 and
  // 0.0459). The last one is equal under NFKC normalization ('10⁶' -> '106'), which is
  // why the normalization is NFC.
  it.each([
    ['The user prefers TypeScript over Python', 'The user prefers Python over TypeScript'],
    ['The production database password rotates every 30 days', 'The staging database password rotates every 30 days'],
    [
      'The production API gateway for the payments service enforces a hard quota of 10⁶ requests per day per tenant across all regions',
      'The production API gateway for the payments service enforces a hard quota of 106 requests per day per tenant across all regions',
    ],
  ])('keeps "%s" and "%s" as separate memories with the real model', async (a, b) => {
    const first = await engine.store(a, { tags: ['preference'] });
    const second = await engine.store(b, {});

    expect(second.action).toBe('created');
    const [kept] = getMemoriesByIds(db, NAMESPACE, [first.id]);
    expect(kept.content).toBe(a);
    expect(kept.metadata).toBeNull();
    expect(rows()).toHaveLength(2);
  });

  it('merges the same fact in the same words, keeping the stored text and merging metadata', async () => {
    const first = await engine.store('The user prefers dark mode', { tags: ['ui'], importance: 0.4 });
    const second = await engine.store('  the user prefers   DARK mode. ', { tags: ['preference'], importance: 0.8 });

    expect(second).toEqual({ id: first.id, action: 'merged_duplicate' });
    const all = rows();
    expect(all).toHaveLength(1);
    expect(all[0].content).toBe('The user prefers dark mode');
    expect(JSON.parse(all[0].tags ?? '[]')).toEqual(['ui', 'preference']);
    expect(all[0].importance).toBeCloseTo(0.8, 5);
    // Nothing was superseded: no history entry for an identical text.
    expect(all[0].metadata).toBeNull();
  });

  it('normalizes only encoding, case, whitespace and trailing full stops', () => {
    expect(normalizeFactText(' The  User\tprefers dark mode!. ')).toBe('the user prefers dark mode');
    // Canonically equivalent encodings (precomposed vs combining accent) are equal...
    expect(normalizeFactText('The user drinks café au lait')).toBe(normalizeFactText('The user drinks café au lait'));
    // ...but compatibility forms are not folded, since that can change the meaning.
    expect(normalizeFactText('a quota of 10⁶ requests')).not.toBe(normalizeFactText('a quota of 106 requests'));
    expect(normalizeFactText('Ｆｕｌｌwidth text')).not.toBe(normalizeFactText('Fullwidth text'));
    expect(normalizeFactText('prefers C++')).not.toBe(normalizeFactText('prefers C'));
    expect(normalizeFactText('offset is -5')).not.toBe(normalizeFactText('offset is 5'));
    expect(normalizeFactText('Is the user vegan?')).not.toBe(normalizeFactText('Is the user vegan'));
    expect(normalizeFactText('X over Y')).not.toBe(normalizeFactText('Y over X'));
  });
});
