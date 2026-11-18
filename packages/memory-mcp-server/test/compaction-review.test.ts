/**
 * Compaction keeps review groups apart (utils/review.ts): decayed memories that wait
 * for review are summarized only with each other, and their summary waits for review
 * under the same scope, so compaction cannot fold an unattended run's text into a
 * summary interactive sessions see. No LLM (the extractive fallback summarizes); the
 * decayed texts (clustered on their own embeddings, MEM-8) and the summary are
 * embedded with the real embedder.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';

import { initDatabase, EMBEDDING_DIMENSIONS } from '../src/storage/database.js';
import type { MemoryRow } from '../src/storage/database.js';
import { insertMemory } from '../src/storage/queries.js';
import { runCompaction } from '../src/storage/compaction.js';
import { loadConfig } from '../src/config.js';
import { testModelEnv } from './helpers/test-models.js';
import type { MemoryConfig } from '../src/config.js';

const NAMESPACE = 'test';

function testConfig(): MemoryConfig {
  return {
    ...loadConfig(testModelEnv()),
    namespace: NAMESPACE,
    llmApiKey: null,
    llmBaseUrl: null,
    compactionMinGroup: 3,
  };
}

/**
 * A stored vector for the rows. Compaction does not use it (decay drops a memory's
 * vector; compaction embeds the decayed texts itself), so the texts below are what
 * would put every memory in one cluster if review groups did not keep them apart.
 */
function sameVector(): Float32Array {
  const v = new Float32Array(EMBEDDING_DIMENSIONS);
  v[0] = 1;
  return v;
}

describe('compaction review groups', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memory-compaction-review-'));
    db = initDatabase(join(tmpDir, 'test.db'), loadConfig({}).embeddingModel);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function decayed(id: string, content: string, metadata?: Record<string, unknown>): void {
    insertMemory(db, { id, namespace: NAMESPACE, content, tags: undefined, importance: 0, metadata }, sameVector());
  }

  it('summarizes pending and reviewed decayed memories separately', async () => {
    const reviewed = ['r1', 'r2', 'r3'];
    const pending = ['p1', 'p2', 'p3'];
    // The same note in both groups, but for the id: without the groups the six texts
    // would form a single cluster and a single summary.
    for (const id of reviewed) decayed(id, `Deploy note number ${id}`);
    for (const id of pending) {
      decayed(id, `Deploy note number ${id}`, {
        writer: { kind: 'cron', scope: 'job:daily' },
        pending_review: 'job:daily',
      });
    }

    expect(await runCompaction(db, testConfig())).toBe(6);

    const summaries = db
      .prepare(`SELECT * FROM memories WHERE namespace = ? AND source = 'compaction'`)
      .all(NAMESPACE) as MemoryRow[];
    expect(summaries).toHaveLength(2);
    const byGroup = new Map(
      summaries.map((s) => {
        const meta = JSON.parse(s.metadata ?? '{}') as { pending_review?: string; compacted_from: string[] };
        return [meta.pending_review ?? '', { meta, content: s.content }];
      }),
    );
    expect([...(byGroup.get('job:daily')?.meta.compacted_from ?? [])].sort()).toEqual(pending);
    expect(byGroup.get('job:daily')?.content).not.toContain('number r');
    expect([...(byGroup.get('')?.meta.compacted_from ?? [])].sort()).toEqual(reviewed);
    expect(byGroup.get('')?.content).not.toContain('number p');
  });
});
