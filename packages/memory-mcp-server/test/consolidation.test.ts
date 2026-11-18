import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';

// ---- Stub LLM: a "semantic oracle" that judges every pair correctly from labels. ----
// Each fact text carries a label `topic=value`: two facts with the same topic and value
// state the same thing (duplicate), the same topic with different values conflict
// (contradiction), and anything else (or the label 'X') is distinct.
const oracle = vi.hoisted(() => ({
  labels: new Map<string, string>(),
  /** Return the judgments in reverse order, as a model is free to. */
  reverse: false,
  /** Answer pair 0 a second time with 'distinct', before or after the real answer. */
  conflictingAnswer: null as null | 'before' | 'after',
  /** Runs inside the judgment call, after pairing and before the judgments are applied. */
  duringJudgment: null as null | (() => void),
}));

vi.mock('../src/llm/client.js', () => ({
  getLLMClient: vi.fn(() => ({})),
  batchJudgeMemoryRelations: vi.fn(
    async (_config: unknown, pairs: Array<{ newContent: string; existingContent: string }>) => {
      oracle.duringJudgment?.();
      const relation = (existing: string, incoming: string): 'duplicate' | 'contradiction' | 'distinct' => {
        const [topicA, valueA] = (oracle.labels.get(existing) ?? 'X').split('=');
        const [topicB, valueB] = (oracle.labels.get(incoming) ?? 'X').split('=');
        if (topicA === 'X' || topicB === 'X' || topicA !== topicB) return 'distinct';
        return valueA === valueB ? 'duplicate' : 'contradiction';
      };
      const judgments = pairs.map((p, i) => ({ pairIndex: i, relation: relation(p.existingContent, p.newContent) }));
      if (oracle.conflictingAnswer === 'before') judgments.unshift({ pairIndex: 0, relation: 'distinct' });
      if (oracle.conflictingAnswer === 'after') judgments.push({ pairIndex: 0, relation: 'distinct' });
      return oracle.reverse ? judgments.reverse() : judgments;
    },
  ),
}));

import { initDatabase, EMBEDDING_DIMENSIONS } from '../src/storage/database.js';
import { insertMemory, getMemoriesByIds, getEmbeddingsForMemories, forgetMemoryRows } from '../src/storage/queries.js';
import type { InsertMemoryParams } from '../src/storage/queries.js';
import { runConsolidation } from '../src/storage/consolidation.js';
import { batchJudgeMemoryRelations } from '../src/llm/client.js';
import { embed } from '../src/embedding/embedder.js';
import { loadConfig } from '../src/config.js';
import { testModelEnv } from './helpers/test-models.js';
import type { MemoryConfig } from '../src/config.js';
import type { MemoryRow } from '../src/storage/database.js';

const NAMESPACE = 'test';

function testConfig(): MemoryConfig {
  return {
    ...loadConfig(testModelEnv()),
    namespace: NAMESPACE,
    llmApiKey: 'stub',
    llmBaseUrl: 'http://127.0.0.1:9/v1',
  };
}

/** Unit vector `sum(coeffs[i] * e_i)` over the first standard basis vectors. */
function vec(...coeffs: number[]): Float32Array {
  const v = new Float32Array(EMBEDDING_DIMENSIONS);
  const norm = Math.sqrt(coeffs.reduce((sum, c) => sum + c * c, 0));
  coeffs.forEach((c, i) => {
    v[i] = c / norm;
  });
  return v;
}

describe('runConsolidation', () => {
  let tmpDir: string;
  let db: Database.Database;
  const T0 = Date.parse('2026-01-01T00:00:00.000Z');

  function put(
    id: string,
    content: string,
    label: string,
    embedding: Float32Array,
    opts: Partial<InsertMemoryParams> & { consolidated: boolean; createdAt: number },
  ): void {
    oracle.labels.set(content, label);
    insertMemory(db, { id, namespace: NAMESPACE, content, tags: undefined, importance: 0.5, ...opts }, embedding);
  }

  function row(id: string): MemoryRow | undefined {
    return getMemoriesByIds(db, NAMESPACE, [id])[0];
  }

  function allRows(): MemoryRow[] {
    return db.prepare(`SELECT * FROM memories WHERE namespace = ? ORDER BY created_at`).all(NAMESPACE) as MemoryRow[];
  }

  function history(r: MemoryRow | undefined): string[] {
    const meta = JSON.parse(r?.metadata ?? '{}') as { superseded?: Array<{ content: string; at: number }> };
    return (meta.superseded ?? []).map((h) => h.content);
  }

  function tags(r: MemoryRow | undefined): string[] {
    return JSON.parse(r?.tags ?? '[]') as string[];
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memory-consolidation-'));
    db = initDatabase(join(tmpDir, 'test.db'), 'test-model');
    oracle.labels.clear();
    oracle.reverse = false;
    oracle.conflictingAnswer = null;
    oracle.duringJudgment = null;
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // E0 is the stale consolidated fact. U0 restates it (duplicate, distance 0.11) and U1
  // corrects it. U1 is 0.35 from E0, outside the 0.3 pairing band, so U1 is only paired
  // with U0 (similarity 0.87). U0 is merged into E0 first; the correction must then
  // land on E0, the row that absorbed U0.
  function seedTransitiveCorrection(): void {
    put('E0', 'The user lives in Lisbon.', 'city=lisbon', vec(1, 0, 0), { consolidated: true, createdAt: T0 });
    put('U0', 'The user is based in Lisbon, Portugal.', 'city=lisbon', vec(1, 0.5, 0), {
      consolidated: false,
      createdAt: T0 + 1000,
      tags: ['location'],
      source: 'session:abc',
    });
    put('U1', 'The user now lives in Berlin.', 'city=berlin', vec(1, 1, 0.6), {
      consolidated: false,
      createdAt: T0 + 2000,
      tags: ['moved'],
      source: 'session:def',
    });
  }

  it('applies a correction to the survivor of an earlier merge instead of losing it', async () => {
    seedTransitiveCorrection();

    const result = await runConsolidation(db, testConfig());

    const e0 = row('E0');
    expect(e0?.content).toBe('The user now lives in Berlin.');
    expect(row('U0')).toBeUndefined();
    expect(row('U1')).toBeUndefined();
    expect(allRows()).toHaveLength(1);
    // The survivor's vector follows its new content (U1's vector has an e3 component).
    expect(getEmbeddingsForMemories(db, NAMESPACE, ['E0']).get('E0')?.[2]).toBeGreaterThan(0);
    // The stale text is kept in the bounded history, read from the survivor itself.
    expect(history(e0)).toEqual(['The user lives in Lisbon.']);
    // Tags of every absorbed row move to the survivor; the source follows the content.
    expect(tags(e0)).toEqual(expect.arrayContaining(['location', 'moved']));
    expect(e0?.source).toBe('session:def');
    expect(result).toEqual({ consolidated: 2, merged: 1, superseded: 1 });
  });

  it('applies judgments in pair order even when the model answers out of order', async () => {
    seedTransitiveCorrection();
    oracle.reverse = true;

    const result = await runConsolidation(db, testConfig());

    expect(row('E0')?.content).toBe('The user now lives in Berlin.');
    expect(allRows()).toHaveLength(1);
    expect(result).toEqual({ consolidated: 2, merged: 1, superseded: 1 });
  });

  it.each(['before', 'after'] as const)(
    'treats a pair the model answers inconsistently as distinct (conflicting answer %s)',
    async (position) => {
      seedTransitiveCorrection();
      oracle.conflictingAnswer = position; // pair 0 (U0 vs E0) is also answered 'distinct'

      const result = await runConsolidation(db, testConfig());

      // U0 is not merged into E0, so U0 survives and the correction lands on U0.
      expect(row('E0')?.content).toBe('The user lives in Lisbon.');
      expect(row('U0')?.content).toBe('The user now lives in Berlin.');
      expect(row('U1')).toBeUndefined();
      expect(result).toEqual({ consolidated: 2, merged: 0, superseded: 1 });
    },
  );

  it('keeps the newest of several corrections and every older text in the history', async () => {
    put('E0', 'The deploy target is server A.', 'deploy=a', vec(1, 0, 0), { consolidated: true, createdAt: T0 });
    put('U1', 'The deploy target is server B.', 'deploy=b', vec(1, 0.5, 0), {
      consolidated: false,
      createdAt: T0 + 1000,
    });
    put('U2', 'The deploy target is server C.', 'deploy=c', vec(1, 0, 0.5), {
      consolidated: false,
      createdAt: T0 + 2000,
    });

    const result = await runConsolidation(db, testConfig());

    const e0 = row('E0');
    expect(e0?.content).toBe('The deploy target is server C.');
    expect(history(e0)).toEqual(['The deploy target is server A.', 'The deploy target is server B.']);
    expect(allRows()).toHaveLength(1);
    expect(result).toEqual({ consolidated: 2, merged: 0, superseded: 2 });
  });

  // A correction carries its writer: after a session's newer fact replaced a row's text,
  // the row must not keep naming the session that wrote the old text as its author
  // (an unattended run could otherwise pass its text off as the user's own session).
  it('moves the writer with a replaced text and keeps the old writer in the history', async () => {
    const interactive = { kind: 'interactive', session_id: 'session-user' };
    const cron = { kind: 'cron', session_id: 'session-job' };
    put('E0', 'Pushes go to origin.', 'push=origin', vec(1, 0, 0), {
      consolidated: true,
      createdAt: T0,
      metadata: { writer: interactive },
    });
    put('U1', 'Pushes go to the mirror remote.', 'push=mirror', vec(1, 0.5, 0), {
      consolidated: false,
      createdAt: T0 + 1000,
      metadata: { writer: cron },
    });

    await runConsolidation(db, testConfig());

    const meta = JSON.parse(row('E0')?.metadata ?? '{}') as {
      writer?: unknown;
      superseded?: Array<{ content: string; writer?: unknown }>;
    };
    expect(row('E0')?.content).toBe('Pushes go to the mirror remote.');
    expect(meta.writer).toEqual(cron);
    expect(meta.superseded).toEqual([
      expect.objectContaining({ content: 'Pushes go to origin.', writer: interactive }),
    ]);
  });

  it('keeps the survivor writer when an older contradiction is archived, recording the loser writer', async () => {
    const interactive = { kind: 'interactive', session_id: 'session-user' };
    const cron = { kind: 'cron', session_id: 'session-job' };
    put('E0', 'Pushes go to origin.', 'push=origin', vec(1, 0, 0), {
      consolidated: true,
      createdAt: T0,
      metadata: { writer: interactive },
    });
    // Backdated before the fact it contradicts: the survivor keeps its text.
    put('U1', 'Pushes go to the mirror remote.', 'push=mirror', vec(1, 0.5, 0), {
      consolidated: false,
      createdAt: T0 - 1000,
      metadata: { writer: cron },
    });

    await runConsolidation(db, testConfig());

    const meta = JSON.parse(row('E0')?.metadata ?? '{}') as {
      writer?: unknown;
      superseded?: Array<{ content: string; writer?: unknown }>;
    };
    expect(row('E0')?.content).toBe('Pushes go to origin.');
    expect(meta.writer).toEqual(interactive);
    expect(meta.superseded).toEqual([
      expect.objectContaining({ content: 'Pushes go to the mirror remote.', writer: cron }),
    ]);
  });

  // All pairs are judged before any is applied. U_b was judged a duplicate of E0's
  // ORIGINAL text, but by then U_a's correction has replaced that text: deleting U_b as
  // a duplicate would lose its fact, which E0 no longer states.
  it('does not apply a judgment to a survivor whose text changed since it was judged', async () => {
    put('E0', 'The deploy target is server A.', 'deploy=a', vec(1, 0, 0), { consolidated: true, createdAt: T0 });
    put('Ua', 'The deploy target is now server B.', 'deploy=b', vec(1, 0.5, 0), {
      consolidated: false,
      createdAt: T0 + 1000,
    });
    // Close to E0 (0.11) but not to Ua (similarity 0.6), so it is only judged against E0.
    put('Ub', 'Deploys go to server A.', 'deploy=a', vec(1, -0.5, 0), { consolidated: false, createdAt: T0 + 2000 });

    const result = await runConsolidation(db, testConfig());

    expect(row('E0')?.content).toBe('The deploy target is now server B.');
    expect(row('Ub')?.content).toBe('Deploys go to server A.');
    expect(result).toEqual({ consolidated: 2, merged: 0, superseded: 1 });
  });

  it('keeps at most five superseded texts per memory', async () => {
    put('E0', 'Build number 0 is current.', 'build=0', vec(1, 0, 0, 0, 0, 0, 0, 0), {
      consolidated: true,
      createdAt: T0,
    });
    for (let i = 1; i <= 7; i++) {
      const coeffs = [1, 0, 0, 0, 0, 0, 0, 0];
      coeffs[i] = 0.5;
      put(`U${i}`, `Build number ${i} is current.`, `build=${i}`, vec(...coeffs), {
        consolidated: false,
        createdAt: T0 + i * 1000,
      });
    }

    await runConsolidation(db, testConfig());

    const e0 = row('E0');
    expect(e0?.content).toBe('Build number 7 is current.');
    expect(history(e0)).toEqual([
      'Build number 2 is current.',
      'Build number 3 is current.',
      'Build number 4 is current.',
      'Build number 5 is current.',
      'Build number 6 is current.',
    ]);
  });

  it('does not let an older (backdated) contradicting fact overwrite a newer one', async () => {
    put('E0', 'The user lives in Berlin.', 'city=berlin', vec(1, 0, 0), { consolidated: true, createdAt: T0 });
    // Ingested later with an as_of in the past: older than E0.
    put('U0', 'The user lives in Lisbon.', 'city=lisbon', vec(1, 0.4, 0), {
      consolidated: false,
      createdAt: T0 - 365 * 24 * 3600 * 1000,
      tags: ['history'],
    });

    const result = await runConsolidation(db, testConfig());

    const e0 = row('E0');
    expect(e0?.content).toBe('The user lives in Berlin.');
    expect(history(e0)).toEqual(['The user lives in Lisbon.']);
    expect(tags(e0)).toContain('history');
    expect(row('U0')).toBeUndefined();
    expect(result).toEqual({ consolidated: 1, merged: 0, superseded: 1 });
  });

  // The replaced row used to keep the created_at of the text it no longer holds, so in
  // the next pass an older, backdated contradiction looked newer than the correction.
  it('keeps the newest fact across passes: a replaced row takes over the first-seen time of its new text', async () => {
    const DAY = 24 * 3600 * 1000;
    put('E0', 'The user lives in Lisbon.', 'city=lisbon', vec(1, 0, 0), { consolidated: true, createdAt: T0 });
    put('U1', 'The user now lives in Berlin.', 'city=berlin', vec(1, 0.4, 0), {
      consolidated: false,
      createdAt: T0 + 5 * DAY,
      source: 'session:def',
    });
    await runConsolidation(db, testConfig());
    expect(row('E0')?.content).toBe('The user now lives in Berlin.');
    expect(row('E0')?.created_at).toBe(T0 + 5 * DAY);
    expect(row('E0')?.last_accessed_at).toBe(T0 + 5 * DAY);

    // A historical export ingested afterwards with an as_of between the two facts.
    put('U9', 'The user lives in Porto.', 'city=porto', vec(1, 0.3, 0.1), {
      consolidated: false,
      createdAt: T0 + 3 * DAY,
    });
    const result = await runConsolidation(db, testConfig());

    const e0 = row('E0');
    expect(e0?.content).toBe('The user now lives in Berlin.');
    expect(history(e0)).toEqual(['The user lives in Lisbon.', 'The user lives in Porto.']);
    expect(row('U9')).toBeUndefined();
    expect(result).toEqual({ consolidated: 1, merged: 0, superseded: 1 });
  });

  // An overlapping maintenance pass (or any other writer) can change a row while this
  // pass waits for the LLM. Its judgments were about the old text and must not apply.
  it('skips a pair whose survivor text changed while the LLM was judging', async () => {
    put('E0', 'The deploy target is server A.', 'deploy=a', vec(1, 0, 0), { consolidated: true, createdAt: T0 });
    put('U1', 'Deploys go to server A.', 'deploy=a', vec(1, 0.4, 0), { consolidated: false, createdAt: T0 + 1000 });
    oracle.duringJudgment = () => {
      db.prepare(`UPDATE memories SET content = 'The deploy target is server C.' WHERE id = 'E0'`).run();
    };

    const result = await runConsolidation(db, testConfig());

    expect(row('E0')?.content).toBe('The deploy target is server C.');
    expect(row('U1')?.content).toBe('Deploys go to server A.');
    expect(row('U1')?.consolidated).toBe(1);
    expect(result).toEqual({ consolidated: 1, merged: 0, superseded: 0 });
  });

  it('skips a pair whose new row text changed while the LLM was judging', async () => {
    put('E0', 'The deploy target is server A.', 'deploy=a', vec(1, 0, 0), { consolidated: true, createdAt: T0 });
    put('U1', 'The deploy target is server B.', 'deploy=b', vec(1, 0.4, 0), {
      consolidated: false,
      createdAt: T0 + 1000,
    });
    oracle.duringJudgment = () => {
      db.prepare(`UPDATE memories SET content = 'The office is in building 7.' WHERE id = 'U1'`).run();
    };

    const result = await runConsolidation(db, testConfig());

    expect(row('E0')?.content).toBe('The deploy target is server A.');
    expect(row('U1')?.content).toBe('The office is in building 7.');
    expect(result).toEqual({ consolidated: 1, merged: 0, superseded: 0 });
  });

  it('merges tags, source, segment and importance of a duplicate into the survivor', async () => {
    db.prepare(
      `INSERT INTO segments (id, namespace, content, created_at, fact_count) VALUES ('seg-1', ?, 'source chunk', ?, 3)`,
    ).run(NAMESPACE, T0);
    put('E0', 'The project uses PostgreSQL 15.', 'db=pg15', vec(1, 0, 0), {
      consolidated: true,
      createdAt: T0,
      tags: ['tech'],
    });
    put('U0', 'PostgreSQL 15 is the main database of the project.', 'db=pg15', vec(1, 0.5, 0), {
      consolidated: false,
      createdAt: T0 + 1000,
      tags: ['database'],
      source: 'session:xyz',
      importance: 0.9,
      segmentId: 'seg-1',
    });

    const result = await runConsolidation(db, testConfig());

    const e0 = row('E0');
    expect(e0?.content).toBe('The project uses PostgreSQL 15.');
    expect(tags(e0)).toEqual(['tech', 'database']);
    expect(e0?.source).toBe('session:xyz');
    expect(e0?.segment_id).toBe('seg-1');
    expect(e0?.importance).toBeCloseTo(0.9, 5);
    expect(history(e0)).toEqual([]);
    expect(row('U0')).toBeUndefined();
    expect(result).toEqual({ consolidated: 1, merged: 1, superseded: 0 });
  });

  // MEM-3: the absorbed row's source chunk states the survivor's text (or a text in its
  // history), so forgetting the survivor must delete it too, not only the one it links to.
  describe('source segments of merged rows', () => {
    function segment(id: string, factCount: number): void {
      db.prepare(`INSERT INTO segments (id, namespace, content, created_at, fact_count) VALUES (?, ?, ?, ?, ?)`).run(
        id,
        NAMESPACE,
        `source chunk ${id}`,
        T0,
        factCount,
      );
    }

    function sourceSegments(id: string): unknown {
      return (JSON.parse(row(id)?.metadata ?? '{}') as { source_segments?: unknown }).source_segments;
    }

    function segmentIds(): string[] {
      return (db.prepare(`SELECT id FROM segments ORDER BY id`).all() as Array<{ id: string }>).map((s) => s.id);
    }

    it('records the source of a merged duplicate, and forgetting the survivor deletes both', async () => {
      segment('seg-rich', 3);
      segment('seg-poor', 2);
      put('E0', 'The project uses PostgreSQL 15.', 'db=pg15', vec(1, 0, 0), {
        consolidated: true,
        createdAt: T0,
        segmentId: 'seg-rich',
      });
      put('U0', 'PostgreSQL 15 is the main database of the project.', 'db=pg15', vec(1, 0.5, 0), {
        consolidated: false,
        createdAt: T0 + 1000,
        segmentId: 'seg-poor',
      });
      // Another fact of the poorer chunk keeps it alive.
      put('S0', 'The project deploys on Fridays.', 'X', vec(0, 0, 1), {
        consolidated: true,
        createdAt: T0,
        segmentId: 'seg-poor',
      });

      expect((await runConsolidation(db, testConfig())).merged).toBe(1);

      expect(row('E0')?.segment_id).toBe('seg-rich');
      expect(sourceSegments('E0')).toEqual(['seg-poor']);

      expect(forgetMemoryRows(db, NAMESPACE, ['E0'])).toBe(1);
      expect(segmentIds()).toEqual([]);
      expect(row('S0')?.segment_id).toBeNull();
    });

    it('records the source of a replaced text, which its superseded history still holds', async () => {
      segment('seg-old', 2);
      segment('seg-new', 2);
      put('E0', 'The API runs in production.', 'api=prod', vec(1, 0, 0), {
        consolidated: true,
        createdAt: T0,
        segmentId: 'seg-old',
      });
      put('U0', 'The API runs in staging.', 'api=staging', vec(1, 0.15, 0), {
        consolidated: false,
        createdAt: T0 + 1000,
        segmentId: 'seg-new',
      });

      expect((await runConsolidation(db, testConfig())).superseded).toBe(1);

      expect(row('E0')?.content).toBe('The API runs in staging.');
      expect(row('E0')?.segment_id).toBe('seg-new');
      expect(sourceSegments('E0')).toEqual(['seg-old']);
      expect(history(row('E0'))).toEqual(['The API runs in production.']);
    });
  });

  it('judges near-identical pairs that store-time dedup no longer merges', async () => {
    // Distance 0.01: the old consolidation skipped every pair under 0.05 as "already
    // handled at store time", but store now merges only identical text.
    put('E0', 'The API runs in production.', 'api=prod', vec(1, 0, 0), { consolidated: true, createdAt: T0 });
    put('U0', 'The API runs in staging.', 'api=staging', vec(1, 0.15, 0), {
      consolidated: false,
      createdAt: T0 + 1000,
    });

    const result = await runConsolidation(db, testConfig());

    expect(row('E0')?.content).toBe('The API runs in staging.');
    expect(result.superseded).toBe(1);
  });

  it('pairs a new row with a stale consolidated row even when similar new rows crowd its neighbourhood', async () => {
    // Six new rows sit closer to U0 than the consolidated E0 does. Before the fix the
    // external neighbour search (k=5) returned U0 itself and the other new rows, so E0
    // was never paired with U0 and the duplicate survived.
    put('E0', 'The office is in building 7.', 'office=b7', vec(1, 0, 0, 0), { consolidated: true, createdAt: T0 });
    put('U0', 'Our office is located in building 7.', 'office=b7', vec(1, 0.6, 0, 0), {
      consolidated: false,
      createdAt: T0 + 1000,
    });
    for (let i = 1; i <= 6; i++) {
      put(`U${i}`, `Unrelated note ${i} about the office plants.`, 'X', vec(1, 0.6, 0.05 * i, 0.02), {
        consolidated: false,
        createdAt: T0 + 1000 + i,
      });
    }

    const result = await runConsolidation(db, testConfig());

    expect(row('U0')).toBeUndefined();
    expect(row('E0')?.content).toBe('The office is in building 7.');
    expect(result.merged).toBe(1);
  });

  it('re-checks that both rows still exist and counts only real writes', async () => {
    seedTransitiveCorrection();
    // The existing row disappears (e.g. a forget) between pairing and applying.
    oracle.duringJudgment = () => {
      db.prepare(`DELETE FROM memories WHERE id = 'E0'`).run();
    };

    const result = await runConsolidation(db, testConfig());

    // U0 vs E0 cannot apply because E0 is gone; U0 must not be deleted for it.
    // U1 vs U0 still applies to U0.
    expect(row('U0')?.content).toBe('The user now lives in Berlin.');
    expect(history(row('U0'))).toEqual(['The user is based in Lisbon, Portugal.']);
    expect(row('U1')).toBeUndefined();
    expect(result).toEqual({ consolidated: 2, merged: 0, superseded: 1 });
  });

  it('marks surviving new rows consolidated and removes absorbed rows from every index', async () => {
    seedTransitiveCorrection();

    await runConsolidation(db, testConfig());

    expect(allRows().every((r) => r.consolidated === 1)).toBe(true);
    expect(getEmbeddingsForMemories(db, NAMESPACE, ['U0', 'U1']).size).toBe(0);
    const fts = db.prepare(`SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'Portugal'`).all();
    expect(fts).toHaveLength(0);
  });

  // The audit's scenario h, with the real embedding model: a batch of Berlin facts
  // crowds the correction's neighbourhood, and the restatement of the old fact is
  // merged first. Before the fix the correction was deleted and 'Lisbon' survived.
  it('scenario h: keeps the newest fact with real embeddings', async () => {
    const config = testConfig();
    const existing: Array<[string, string]> = [
      ['The user lives in Lisbon.', 'city=lisbon'],
      ['The user works remotely from home.', 'X'],
      ['The user has a dog named Rex.', 'X'],
    ];
    const incoming: Array<[string, string]> = [
      ['The user is based in Lisbon, Portugal.', 'city=lisbon'],
      ['The user now lives in Berlin.', 'city=berlin'],
      ['The user rents an apartment in Berlin Kreuzberg.', 'X'],
      ['The user commutes by bike in Berlin.', 'X'],
      ['The user is learning German since moving to Berlin.', 'X'],
      ['The user works from a Berlin coworking space.', 'X'],
      ["The user's Berlin apartment is close to the U-Bahn.", 'X'],
      ['The user registered their address at the Berlin citizen office.', 'X'],
    ];
    let k = 0;
    for (const [i, [text, label]] of existing.entries()) {
      put(`E${i}`, text, label, await embed(text, config), { consolidated: true, createdAt: T0 + k++ });
    }
    for (const [i, [text, label]] of incoming.entries()) {
      put(`U${i}`, text, label, await embed(text, config), { consolidated: false, createdAt: T0 + 100_000 + k++ });
    }

    const result = await runConsolidation(db, config);

    const contents = allRows().map((r) => r.content);
    expect(contents).toContain('The user now lives in Berlin.');
    expect(contents).not.toContain('The user lives in Lisbon.');
    expect(contents).not.toContain('The user is based in Lisbon, Portugal.');
    expect(result.superseded).toBe(1);
  }, 60_000);
  // Review quarantine (utils/review.ts): a memory an unattended run wrote waits for
  // review, and consolidation must neither merge it into a reviewed memory nor let it
  // replace one's text (that would hand its text to interactive sessions unreviewed).
  // Nor may it change a pending memory at all (FU-05): what `review` listed is what
  // approving its id releases, so pending memories are left alone until approved.
  describe('review groups', () => {
    const PENDING = { writer: { kind: 'cron', scope: 'job:daily' }, pending_review: 'job:daily' };

    it('never pairs a pending memory, with a reviewed one or with one of its own scope', async () => {
      put('E0', 'Pushes go to origin.', 'push=origin', vec(1, 0, 0), { consolidated: true, createdAt: T0 });
      put('U1', 'Pushes go to the mirror remote.', 'push=mirror', vec(1, 0.5, 0), {
        consolidated: false,
        createdAt: T0 + 1000,
        metadata: PENDING,
      });
      put('U2', 'Pushes go to origin.', 'push=origin', vec(1, 0.1, 0), {
        consolidated: false,
        createdAt: T0 + 2000,
        metadata: PENDING,
      });
      const judge = vi.mocked(batchJudgeMemoryRelations);
      judge.mockClear();

      const result = await runConsolidation(db, testConfig());

      // The reviewed row keeps its text; the pending contradiction and duplicate stay apart.
      expect(row('E0')?.content).toBe('Pushes go to origin.');
      expect(history(row('E0'))).toEqual([]);
      // The pending rows are not judged against each other either (U2 contradicts U1
      // and is newer): both stay as the run wrote them, and both are marked consolidated.
      expect(judge).not.toHaveBeenCalled();
      expect(row('U1')).toMatchObject({ content: 'Pushes go to the mirror remote.', consolidated: 1 });
      expect(row('U2')).toMatchObject({ content: 'Pushes go to origin.', consolidated: 1 });
      expect(JSON.parse(row('U1')?.metadata ?? '{}')).toEqual(PENDING);
      expect(result).toEqual({ consolidated: 2, merged: 0, superseded: 0 });
    });

    // The judge reads every pair of its call in one prompt: a pending memory (an
    // unattended run's text, maybe from content nobody checked) next to reviewed pairs
    // could steer how they are judged, e.g. have two reviewed facts merged away.
    it('never shows a pending memory to the judge', async () => {
      put('E0', 'Pushes go to origin.', 'push=origin', vec(1, 0, 0), { consolidated: true, createdAt: T0 });
      put('U0', 'Pushes always go to origin.', 'push=origin', vec(1, 0.1, 0), {
        consolidated: false,
        createdAt: T0 + 1000,
      });
      put('P0', 'Reports go to finance.', 'report=finance', vec(0, 0, 1), {
        consolidated: true,
        createdAt: T0,
        metadata: PENDING,
      });
      put('P1', 'Reports go to the board.', 'report=board', vec(0, 0.1, 1), {
        consolidated: false,
        createdAt: T0 + 2000,
        metadata: PENDING,
      });
      const judge = vi.mocked(batchJudgeMemoryRelations);
      judge.mockClear();

      const result = await runConsolidation(db, testConfig());

      const prompts = judge.mock.calls.map(([, pairs]) => pairs.flatMap((p) => [p.existingContent, p.newContent]));
      expect(prompts).toEqual([['Pushes go to origin.', 'Pushes always go to origin.']]);
      // The reviewed duplicate merges; the pending report keeps the text the run wrote.
      expect(row('U0')).toBeUndefined();
      expect(row('E0')?.content).toBe('Pushes go to origin.');
      expect(row('P0')?.content).toBe('Reports go to finance.');
      expect(row('P1')?.content).toBe('Reports go to the board.');
      expect(result).toEqual({ consolidated: 2, merged: 1, superseded: 0 });
    });

    // Pending memories are deduplicated only once approved: the approval queues one for
    // consolidation again, and a pass that was judging meanwhile must not undo that.
    it('keeps a memory approved while the LLM judged queued for consolidation', async () => {
      put('E0', 'Pushes go to origin.', 'push=origin', vec(1, 0, 0), { consolidated: true, createdAt: T0 });
      put('U0', 'Pushes always go to origin.', 'push=origin', vec(1, 0.1, 0), {
        consolidated: false,
        createdAt: T0 + 1000,
      });
      put('P1', 'Reports go to the board.', 'report=board', vec(0, 0, 1), {
        consolidated: false,
        createdAt: T0 + 2000,
        metadata: PENDING,
      });
      put('P2', 'Reports go to finance.', 'report=finance', vec(0, 1, 0), {
        consolidated: false,
        createdAt: T0 + 3000,
        metadata: PENDING,
      });
      // The user approves P1 while the judge looks at the reviewed pair (as admin.ts
      // markReviewed does it).
      oracle.duringJudgment = () => {
        db.prepare(`UPDATE memories SET metadata = '{"reviewed_at":1}', consolidated = 0 WHERE id = 'P1'`).run();
      };

      await runConsolidation(db, testConfig());

      expect(row('U0')).toBeUndefined();
      expect(row('P1')?.consolidated).toBe(0);
      expect(row('P2')?.consolidated).toBe(1);
    });

    it('judges an approved memory against the reviewed ones', async () => {
      put('E0', 'Pushes go to origin.', 'push=origin', vec(1, 0, 0), { consolidated: true, createdAt: T0 });
      // As admin.ts markReviewed leaves an approved memory: no marker, queued for consolidation.
      put('U1', 'Pushes go to the mirror remote.', 'push=mirror', vec(1, 0.5, 0), {
        consolidated: false,
        createdAt: T0 + 1000,
        metadata: { writer: PENDING.writer, reviewed_at: T0 + 1500 },
      });

      const result = await runConsolidation(db, testConfig());

      expect(row('E0')?.content).toBe('Pushes go to the mirror remote.');
      expect(row('U1')).toBeUndefined();
      expect(result.superseded).toBe(1);
    });

    it('never pairs pending memories of two scopes', async () => {
      put('U1', 'Reports go to finance.', 'report=finance', vec(1, 0, 0), {
        consolidated: false,
        createdAt: T0,
        metadata: PENDING,
      });
      put('U2', 'Reports go to the board.', 'report=board', vec(1, 0.1, 0), {
        consolidated: false,
        createdAt: T0 + 1000,
        metadata: { pending_review: 'job:weekly' },
      });

      await runConsolidation(db, testConfig());

      expect(row('U1')?.content).toBe('Reports go to finance.');
      expect(row('U2')?.content).toBe('Reports go to the board.');
    });

    it('skips a pair whose row waits for review by the time the judgment is applied', async () => {
      put('E0', 'Pushes go to origin.', 'push=origin', vec(1, 0, 0), { consolidated: true, createdAt: T0 });
      put('U1', 'Pushes go to the mirror remote.', 'push=mirror', vec(1, 0.5, 0), {
        consolidated: false,
        createdAt: T0 + 1000,
      });
      // The rows are re-read before a judgment is applied; one that waits for review
      // by then is left alone (fail closed), whichever side of the pair it is.
      oracle.duringJudgment = () => {
        db.prepare(`UPDATE memories SET metadata = '{"pending_review":"job:daily"}' WHERE id = 'E0'`).run();
      };

      const result = await runConsolidation(db, testConfig());

      expect(row('E0')?.content).toBe('Pushes go to origin.');
      expect(row('U1')?.content).toBe('Pushes go to the mirror remote.');
      expect(result.superseded).toBe(0);
    });
  });
});
