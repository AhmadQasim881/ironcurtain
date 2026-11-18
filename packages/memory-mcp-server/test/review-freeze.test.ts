/**
 * A memory that waits for review is frozen until the user approves it (FU-05):
 * `ironcurtain memory <persona|job> review` lists it, and `review approve <id>@<digest>`
 * checks that snapshot before releasing it. Nothing may change what a pending row says,
 * how it is tagged or which source passage it links to in between: not a later run of
 * the same scope that stores the same fact again (store-time dedup stores a new pending
 * row instead of merging into it), and not consolidation, which leaves pending rows
 * alone (it pairs only reviewed memories; an approval queues a memory for consolidation
 * again). Otherwise an injected unattended run could have the user approve a note and
 * release another text, or another source passage, to interactive sessions.
 *
 * Real SQLite + sqlite-vec and the real embedder; the extraction LLM and the
 * consolidation judge are stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';

const llm = vi.hoisted(() => ({
  /** Extraction answers, one per llmComplete call. */
  responses: [] as Array<string | null>,
  /** The judge's answer for a pair, by `${existing}\n${new}` text; any other pair is distinct. */
  relations: new Map<string, 'duplicate' | 'contradiction'>(),
  /** Every pair the judge was shown, as [existing, new] text. */
  judged: [] as Array<[string, string]>,
}));

vi.mock('../src/llm/client.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/llm/client.js')>();
  return {
    ...real,
    getLLMClient: vi.fn(() => ({})),
    llmComplete: vi.fn(async () => llm.responses.shift() ?? null),
    batchJudgeMemoryRelations: vi.fn(
      async (_config: unknown, pairs: ReadonlyArray<{ existingContent: string; newContent: string }>) =>
        pairs.map((pair, pairIndex) => {
          llm.judged.push([pair.existingContent, pair.newContent]);
          return {
            pairIndex,
            relation: llm.relations.get(`${pair.existingContent}\n${pair.newContent}`) ?? 'distinct',
          };
        }),
    ),
  };
});

import { initDatabase } from '../src/storage/database.js';
import type { MemoryRow, SegmentRow } from '../src/storage/database.js';
import { ingestBlob } from '../src/engine-impl.js';
import { runConsolidation } from '../src/storage/consolidation.js';
import { openMemoryStoreWriter } from '../src/admin.js';
import { loadConfig } from '../src/config.js';
import type { MemoryConfig } from '../src/config.js';
import { testModelEnv } from './helpers/test-models.js';
import { PENDING_REVIEW_KEY } from '../src/utils/review.js';

const NAMESPACE = 'alice';

const JOB_RUN_1 = { MEMORY_WRITER_KIND: 'cron', MEMORY_SESSION_ID: 'run-1', MEMORY_WRITER_SCOPE: 'job:x' };
const JOB_RUN_2 = { MEMORY_WRITER_KIND: 'cron', MEMORY_SESSION_ID: 'run-2', MEMORY_WRITER_SCOPE: 'job:x' };

const FACT = 'Release branches are pushed to the origin remote';
const CORRECTION = 'Release branches are pushed to the backup mirror remote';
const FIRST_CHUNK = 'Release checklist: push the release branch to origin.';
const RICHER_CHUNK = [
  'Release checklist, revised.',
  'Push the release branch to origin. Tag the build first.',
  'Then send the notes to the mailing list.',
].join('\n');

function extracts(facts: string[]): void {
  llm.responses.push(JSON.stringify(facts.map((fact) => ({ fact }))));
}

describe('a memory waiting for review is frozen until approved', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: Database.Database;

  function config(writer: Record<string, string>): MemoryConfig {
    return {
      ...loadConfig({ ...testModelEnv(), ...writer }),
      dbPath,
      namespace: NAMESPACE,
      llmApiKey: 'stub',
      llmBaseUrl: 'http://127.0.0.1:9/v1',
      rerankerEnabled: false,
      maintenanceInterval: 100_000,
    };
  }

  function row(id: string): MemoryRow | undefined {
    return db.prepare(`SELECT * FROM memories WHERE namespace = ? AND id = ?`).get(NAMESPACE, id) as
      MemoryRow | undefined;
  }

  function rowsWith(content: string): MemoryRow[] {
    return db
      .prepare(`SELECT * FROM memories WHERE namespace = ? AND content = ? ORDER BY rowid`)
      .all(NAMESPACE, content) as MemoryRow[];
  }

  function segment(id: string | null): SegmentRow | undefined {
    return db.prepare(`SELECT * FROM segments WHERE id = ?`).get(id) as SegmentRow | undefined;
  }

  /** What a review listing shows of a memory, and what its approval would release. */
  function reviewed(id: string): Pick<MemoryRow, 'content' | 'tags' | 'source' | 'segment_id' | 'metadata'> {
    const current = row(id);
    if (current === undefined) throw new Error(`memory ${id} is gone`);
    const { content, tags, source, segment_id, metadata } = current;
    return { content, tags, source, segment_id, metadata };
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memory-review-freeze-'));
    dbPath = join(tmpDir, 'memory.db');
    db = initDatabase(dbPath, loadConfig(testModelEnv()).embeddingModel);
    llm.responses = [];
    llm.relations.clear();
    llm.judged = [];
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a later run of the same scope changes neither its text, its tags nor its source passage', async () => {
    // Run 1 writes the fact, from a one-fact chunk; the user lists it for review.
    extracts([FACT]);
    const first = await ingestBlob(db, config(JOB_RUN_1), FIRST_CHUNK, { tags: ['release'], mode: 'document' });
    const [pendingId] = first.memory_ids;
    const listed = reviewed(pendingId);
    expect(JSON.parse(listed.metadata ?? '{}')).toMatchObject({ [PENDING_REVIEW_KEY]: 'job:x' });
    expect(segment(listed.segment_id)?.content).toBe(FIRST_CHUNK);

    // Run 2 (same scope) states the same fact again, from a richer chunk and with
    // another tag, and then a newer fact that contradicts it.
    extracts([FACT, 'Release builds are tagged before the push', 'Release notes go to the mailing list']);
    await ingestBlob(db, config(JOB_RUN_2), RICHER_CHUNK, { tags: ['planted'], mode: 'document' });
    extracts([CORRECTION]);
    await ingestBlob(db, config(JOB_RUN_2), 'Update: release branches now go to the backup mirror.', {});
    // A maintenance pass whose judge calls the newer fact a correction of the listed one.
    llm.relations.set(`${FACT}\n${CORRECTION}`, 'contradiction');
    llm.relations.set(`${FACT}\n${FACT}`, 'duplicate');
    await runConsolidation(db, config(JOB_RUN_2));

    // The listed memory still says, and links to, exactly what the user was shown.
    expect(reviewed(pendingId)).toEqual(listed);
    expect(segment(listed.segment_id)?.content).toBe(FIRST_CHUNK);
    // A pending memory is never shown to the judge.
    expect(llm.judged).toEqual([]);
    // Run 2's statements wait for review as rows of their own.
    const restated = rowsWith(FACT).filter((r) => r.id !== pendingId);
    expect(restated).toHaveLength(1);
    expect(JSON.parse(restated[0].metadata ?? '{}')).toMatchObject({ [PENDING_REVIEW_KEY]: 'job:x' });
    expect(segment(restated[0].segment_id)?.content).toBe(RICHER_CHUNK);
    expect(rowsWith(CORRECTION)).toHaveLength(1);

    // Approving the listed memory releases exactly what was listed (but for the review
    // marker and time); run 2's rows still wait for review.
    const store = openMemoryStoreWriter({ dbPath, namespace: NAMESPACE });
    try {
      expect(store.approve([{ id: pendingId, digest: store.get(pendingId)?.review_digest ?? '' }])).toEqual({
        approved: 1,
        missing: [],
        notPending: [],
        changed: [],
      });
      const approved = store.get(pendingId);
      expect(approved).toMatchObject({ content: FACT, tags: ['release'], pending_review: null });
      expect(approved?.segment?.content).toBe(FIRST_CHUNK);
      expect(store.list({ pendingOnly: true }).map((m) => m.content)).toEqual(
        expect.arrayContaining([FACT, CORRECTION, 'Release builds are tagged before the push']),
      );
    } finally {
      store.close();
    }
  });

  it('a later run of the same scope does not merge an identical memory into it at store time', async () => {
    extracts([FACT]);
    const first = await ingestBlob(db, config(JOB_RUN_1), FIRST_CHUNK, { tags: ['release'], importance: 0.3 });
    const [pendingId] = first.memory_ids;
    const listed = reviewed(pendingId);
    const listedImportance = row(pendingId)?.importance;

    extracts([FACT]);
    const again = await ingestBlob(db, config(JOB_RUN_2), FIRST_CHUNK, {
      tags: ['planted'],
      importance: 0.8,
      source: 'https://attacker.example/notes',
    });

    expect(again).toMatchObject({ created: 1, merged: 0 });
    expect(again.memory_ids).not.toContain(pendingId);
    expect(reviewed(pendingId)).toEqual(listed);
    expect(row(pendingId)?.importance).toBe(listedImportance);
  });

  it('is judged against the reviewed memories once approved', async () => {
    extracts([FACT]);
    const first = await ingestBlob(db, config(JOB_RUN_1), FIRST_CHUNK, {});
    extracts([FACT]);
    const second = await ingestBlob(db, config(JOB_RUN_2), RICHER_CHUNK, {});
    // A pass while both wait for review: neither is touched, both are marked consolidated.
    await runConsolidation(db, config(JOB_RUN_2));
    expect(rowsWith(FACT)).toHaveLength(2);

    const store = openMemoryStoreWriter({ dbPath, namespace: NAMESPACE });
    try {
      const receipts = [...first.memory_ids, ...second.memory_ids].map((id) => ({
        id,
        digest: store.get(id)?.review_digest ?? '',
      }));
      expect(store.approve(receipts).approved).toBe(2);
    } finally {
      store.close();
    }
    // The approvals queued both for consolidation again: the duplicates now merge.
    llm.relations.set(`${FACT}\n${FACT}`, 'duplicate');
    const result = await runConsolidation(db, config(JOB_RUN_2));

    expect(llm.judged).toEqual([[FACT, FACT]]);
    expect(result.merged).toBe(1);
    expect(rowsWith(FACT)).toHaveLength(1);
  });
});
