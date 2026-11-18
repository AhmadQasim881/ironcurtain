import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initDatabase, EMBEDDING_DIMENSIONS } from '../src/storage/database.js';
import {
  insertMemory,
  insertSegment,
  generateId,
  getMemoriesByIds,
  getEmbeddingsForMemories,
  vectorSearch,
  ftsSearch,
} from '../src/storage/queries.js';
import {
  acquireMaintenanceLease,
  computeVitality,
  lastMaintenanceRun,
  MAINTENANCE_LEASE_MS,
  maybeRunMaintenance,
  releaseMaintenanceLease,
  resetMaintenanceCounter,
  runMaintenance,
  runStartupMaintenance,
  STARTUP_MAINTENANCE_MIN_INTERVAL_MS,
} from '../src/storage/maintenance.js';
import { embed, embedQuery } from '../src/embedding/embedder.js';
import type Database from 'better-sqlite3';
import type { MemoryRow } from '../src/storage/database.js';
import type { MemoryConfig } from '../src/config.js';
import { loadConfig } from '../src/config.js';
import { testModelEnv } from './helpers/test-models.js';

const NAMESPACE = 'test';

function randomEmbedding(): Float32Array {
  const arr = new Float32Array(EMBEDDING_DIMENSIONS);
  for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) arr[i] = Math.random() * 2 - 1;
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) arr[i] /= norm;
  return arr;
}

function testConfig(): MemoryConfig {
  return {
    ...loadConfig(testModelEnv()),
    namespace: NAMESPACE,
    // Disable LLM for tests
    llmApiKey: null,
    llmBaseUrl: null,
    // Trigger maintenance every 2 stores for testing
    maintenanceInterval: 2,
    decayThreshold: 0.05,
    compactionMinGroup: 3,
  };
}

describe('computeVitality', () => {
  it('returns ~1.0 for a just-created memory', () => {
    const now = Date.now();
    const mem: MemoryRow = {
      id: 'test',
      namespace: NAMESPACE,
      content: 'test',
      tags: null,
      importance: 0.5,
      created_at: now,
      updated_at: now,
      last_accessed_at: now,
      access_count: 0,
      is_compacted: 0,
      consolidated: 1,
      source: null,
      metadata: null,
      segment_id: null,
    };

    const vitality = computeVitality(mem, now);
    expect(vitality).toBeGreaterThan(0.9);
  });

  it('decays over time for low-importance memories', () => {
    const now = Date.now();
    const mem: MemoryRow = {
      id: 'test',
      namespace: NAMESPACE,
      content: 'test',
      tags: null,
      importance: 0.1, // low importance = fast decay (18-day half-life)
      created_at: now - 30 * 24 * 3600000, // 30 days ago
      updated_at: now - 30 * 24 * 3600000,
      last_accessed_at: now - 30 * 24 * 3600000,
      access_count: 0,
      is_compacted: 0,
      consolidated: 1,
      source: null,
      metadata: null,
      segment_id: null,
    };

    const vitality = computeVitality(mem, now);
    expect(vitality).toBeLessThan(0.5); // should be well decayed
  });

  it('high importance resists decay', () => {
    const now = Date.now();
    const base = {
      id: 'test',
      namespace: NAMESPACE,
      content: 'test',
      tags: null,
      created_at: now - 60 * 24 * 3600000, // 60 days ago
      updated_at: now - 60 * 24 * 3600000,
      last_accessed_at: now - 60 * 24 * 3600000,
      access_count: 0,
      is_compacted: 0,
      consolidated: 1,
      source: null,
      metadata: null,
      segment_id: null,
    };

    const highImp = computeVitality({ ...base, importance: 0.9 }, now);
    const lowImp = computeVitality({ ...base, importance: 0.1 }, now);

    expect(highImp).toBeGreaterThan(lowImp);
  });

  it('access reinforcement extends lifetime', () => {
    const now = Date.now();
    const base = {
      id: 'test',
      namespace: NAMESPACE,
      content: 'test',
      tags: null,
      importance: 0.3,
      created_at: now - 30 * 24 * 3600000,
      updated_at: now - 30 * 24 * 3600000,
      last_accessed_at: now - 1 * 3600000, // recently accessed
      is_compacted: 0,
      consolidated: 1,
      source: null,
      metadata: null,
      segment_id: null,
    };

    const accessed = computeVitality({ ...base, access_count: 10 }, now);
    const notAccessed = computeVitality({ ...base, access_count: 0 }, now);

    expect(accessed).toBeGreaterThan(notAccessed);
  });

  // A future last_accessed_at (an unbounded as_of merge) made the access-recency
  // factor exp(-negativeAge) huge, pinning vitality at 1 so the memory never decayed.
  it('clamps a future access time to "now" so an old, weak memory still decays', () => {
    const now = Date.now();
    const yearMs = 365 * 24 * 3600000;
    const mem: MemoryRow = {
      id: 'test',
      namespace: NAMESPACE,
      content: 'test',
      tags: null,
      importance: 0.01,
      created_at: now - yearMs,
      updated_at: now - yearMs,
      last_accessed_at: now + yearMs,
      access_count: 1,
      is_compacted: 0,
      consolidated: 1,
      source: null,
      metadata: null,
      segment_id: null,
    };

    const vitality = computeVitality(mem, now);
    expect(vitality).toBeCloseTo(0.03, 5); // reinforcement 0.03 x recency 1; the age term is ~0
    expect(vitality).toBeLessThan(testConfig().decayThreshold);
    // A future creation time counts as created now: fresh, not "fresher than fresh".
    expect(computeVitality({ ...mem, created_at: now + yearMs, access_count: 0 }, now)).toBe(1);
  });

  it('returns 0 for zero importance', () => {
    const now = Date.now();
    const mem: MemoryRow = {
      id: 'test',
      namespace: NAMESPACE,
      content: 'test',
      tags: null,
      importance: 0,
      created_at: now,
      updated_at: now,
      last_accessed_at: now,
      access_count: 0,
      is_compacted: 0,
      consolidated: 1,
      source: null,
      metadata: null,
      segment_id: null,
    };

    expect(computeVitality(mem, now)).toBe(0);
  });
});

describe('maybeRunMaintenance', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memory-maint-'));
    db = initDatabase(join(tmpDir, 'test.db'), 'test-model');
    resetMaintenanceCounter();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not run maintenance before interval', async () => {
    const config = testConfig();
    // Insert some old, low-importance memories
    for (let i = 0; i < 5; i++) {
      const id = generateId();
      insertMemory(
        db,
        { id, namespace: NAMESPACE, content: `Old memory ${i}`, tags: undefined, importance: 0.01 },
        randomEmbedding(),
      );
      // Manually age the memory
      db.prepare(`UPDATE memories SET created_at = ?, last_accessed_at = ? WHERE id = ?`).run(
        Date.now() - 365 * 24 * 3600000,
        Date.now() - 365 * 24 * 3600000,
        id,
      );
    }

    // First call should not trigger (counter = 1, interval = 2)
    const result = await maybeRunMaintenance(db, config);
    expect(result.decayed).toBe(0);
  });

  it('runs maintenance at interval', async () => {
    const config = testConfig();
    // Insert old, low-importance memories that should decay
    for (let i = 0; i < 5; i++) {
      const id = generateId();
      insertMemory(
        db,
        { id, namespace: NAMESPACE, content: `Very old memory ${i}`, tags: undefined, importance: 0.01 },
        randomEmbedding(),
      );
      // Age them significantly
      db.prepare(`UPDATE memories SET created_at = ?, last_accessed_at = ? WHERE id = ?`).run(
        Date.now() - 365 * 24 * 3600000,
        Date.now() - 365 * 24 * 3600000,
        id,
      );
    }

    // First call (counter=1) - no maintenance
    await maybeRunMaintenance(db, config);
    // Second call (counter=2) - triggers maintenance
    const result = await maybeRunMaintenance(db, config);
    // Some should have decayed since they are very old with low importance
    expect(result.decayed).toBeGreaterThan(0);
  });

  it('marks decayed memories with importance=0 and removes from vec index', async () => {
    const config = testConfig();
    const id = generateId();
    insertMemory(
      db,
      { id, namespace: NAMESPACE, content: 'Will decay', tags: undefined, importance: 0.01 },
      randomEmbedding(),
    );
    // Age it
    db.prepare(`UPDATE memories SET created_at = ?, last_accessed_at = ? WHERE id = ?`).run(
      Date.now() - 365 * 24 * 3600000,
      Date.now() - 365 * 24 * 3600000,
      id,
    );

    // Trigger maintenance
    await maybeRunMaintenance(db, config);
    await maybeRunMaintenance(db, config);

    const mem = getMemoriesByIds(db, NAMESPACE, [id])[0];
    // If decayed, importance should be 0 and no vec embedding
    if (mem.importance === 0) {
      expect(getEmbeddingsForMemories(db, NAMESPACE, [id]).get(id)).toBeUndefined();
    }
  });
});

describe('runMaintenance: compaction and clean-up', () => {
  let tmpDir: string;
  let db: Database.Database;
  const YEAR_AGO = Date.now() - 365 * 24 * 3600000;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memory-maint-compaction-'));
    db = initDatabase(join(tmpDir, 'test.db'), 'test-model');
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function config(): MemoryConfig {
    return { ...testConfig(), compactionMinGroup: 10 };
  }

  /** A weak, year-old memory, so the next maintenance pass decays it. */
  async function putAged(content: string, opts: { segmentId?: string; importance?: number } = {}): Promise<string> {
    const id = generateId();
    insertMemory(
      db,
      {
        id,
        namespace: NAMESPACE,
        content,
        tags: ['exercise'],
        importance: opts.importance ?? 0.01,
        createdAt: YEAR_AGO,
        segmentId: opts.segmentId,
      },
      await embed(content, config()),
    );
    return id;
  }

  // MEM-8 (acceptance): decay removes a memory's vector and compaction clustered on
  // those vectors, so every decayed memory was a cluster of one and nothing was ever
  // compacted ({decayed: 12, compacted: 0}).
  it('compacts 12 aged similar memories into a summary with compacted_from', async () => {
    const ids: string[] = [];
    for (let i = 1; i <= 12; i++) {
      ids.push(await putAged(`The user went jogging in Riverside Park on the morning of day ${i}`));
    }

    const result = await runMaintenance(db, config());

    expect(result.decayed).toBe(12);
    expect(result.compacted).toBe(12);

    const summaries = db
      .prepare(`SELECT * FROM memories WHERE namespace = ? AND source = 'compaction'`)
      .all(NAMESPACE) as MemoryRow[];
    expect(summaries).toHaveLength(1);
    const [summary] = summaries;
    const metadata = JSON.parse(summary.metadata ?? '{}') as { compacted_from?: string[] };
    expect([...(metadata.compacted_from ?? [])].sort()).toEqual([...ids].sort());
    expect(summary.importance).toBeGreaterThan(0);
    expect(JSON.parse(summary.tags ?? '[]')).toEqual(['exercise']);

    // The originals are compacted and without vectors; the summary replaces them in
    // both search channels.
    const originals = getMemoriesByIds(db, NAMESPACE, ids);
    expect(originals.every((m) => m.is_compacted === 1 && m.importance === 0)).toBe(true);
    expect(getEmbeddingsForMemories(db, NAMESPACE, ids).size).toBe(0);
    expect(ftsSearch(db, NAMESPACE, 'jogging Riverside', 50).map((r) => r.id)).toEqual([summary.id]);
    const query = await embedQuery('where does the user go jogging', config());
    expect(vectorSearch(db, NAMESPACE, query, 50).map((r) => r.id)).toEqual([summary.id]);

    // A second pass has nothing left to compact.
    const again = await runMaintenance(db, config());
    expect(again.compacted).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE source = 'compaction'`).get()).toEqual({ n: 1 });
  });

  it('leaves dissimilar decayed memories uncompacted', async () => {
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
    for (const topic of topics) await putAged(topic);

    const result = await runMaintenance(db, config());

    expect(result.decayed).toBe(10);
    expect(result.compacted).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE source = 'compaction'`).get()).toEqual({ n: 0 });
  });

  // MEM-3: maintenance deletes the source segments no live memory references any more.
  it('sweeps source segments whose facts all decayed, and keeps those with a live fact', async () => {
    insertSegment(db, { id: 'seg-dead', namespace: NAMESPACE, content: 'old chunk', factCount: 1 });
    insertSegment(db, { id: 'seg-live', namespace: NAMESPACE, content: 'current chunk', factCount: 2 });
    insertSegment(db, { id: 'seg-orphan', namespace: NAMESPACE, content: 'orphan chunk', factCount: 1 });
    const decaying = await putAged('The user once owned a blue canoe', { segmentId: 'seg-dead' });
    const decayingSibling = await putAged('The user once paddled on Lake Tahoe', { segmentId: 'seg-live' });
    const fresh = generateId();
    insertMemory(
      db,
      {
        id: fresh,
        namespace: NAMESPACE,
        content: 'The user paddles weekly',
        tags: undefined,
        importance: 0.5,
        segmentId: 'seg-live',
      },
      randomEmbedding(),
    );

    const result = await runMaintenance(db, config());

    expect(result.decayed).toBe(2);
    expect(result.segmentsRemoved).toBe(2);
    const segments = (db.prepare(`SELECT id FROM segments ORDER BY id`).all() as Array<{ id: string }>).map(
      (s) => s.id,
    );
    expect(segments).toEqual(['seg-live']);
    const [deadFact, sibling, live] = [decaying, decayingSibling, fresh].map(
      (id) => getMemoriesByIds(db, NAMESPACE, [id])[0],
    );
    expect(deadFact.segment_id).toBeNull();
    expect(sibling.segment_id).toBe('seg-live');
    expect(live.segment_id).toBe('seg-live');
  });
});

// ---------- Coordination between passes and servers (WP-94) ----------
//
// Each connection stands for one server process (each has its own lease owner id); two
// connections to one file are two servers sharing a persona's database.

describe('maintenance coordination', () => {
  let tmpDir: string;
  let dbPath: string;
  let first: Database.Database;
  let second: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memory-maint-lease-'));
    dbPath = join(tmpDir, 'test.db');
    first = initDatabase(dbPath, 'test-model');
    second = initDatabase(dbPath, 'test-model');
    resetMaintenanceCounter();
  });

  afterEach(() => {
    first.close();
    second.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs one pass at a time on a connection', async () => {
    const config = testConfig();
    const [a, b] = await Promise.all([runMaintenance(first, config), runMaintenance(first, config)]);
    expect(a.skipped).toBeUndefined();
    expect(b.skipped).toBe('running');
  });

  it('skips a pass while another server holds the lease, and runs once it is released', async () => {
    const config = testConfig();
    expect(acquireMaintenanceLease(first, NAMESPACE)).toBe(true);

    expect((await runMaintenance(second, config)).skipped).toBe('leased');
    // The holder itself may renew its lease and run.
    expect(acquireMaintenanceLease(first, NAMESPACE)).toBe(true);

    releaseMaintenanceLease(first, NAMESPACE);
    expect((await runMaintenance(second, config)).skipped).toBeUndefined();
  });

  it('takes over a lease its holder left to expire (a server that died mid-pass)', () => {
    const past = Date.now() - 2 * MAINTENANCE_LEASE_MS;
    expect(acquireMaintenanceLease(first, NAMESPACE, past)).toBe(true);
    expect(acquireMaintenanceLease(second, NAMESPACE)).toBe(true);
    expect(acquireMaintenanceLease(first, NAMESPACE)).toBe(false);
  });

  it('keeps leases per namespace, and releases its own lease only', () => {
    expect(acquireMaintenanceLease(first, 'ns-a')).toBe(true);
    expect(acquireMaintenanceLease(second, 'ns-b')).toBe(true);
    releaseMaintenanceLease(second, 'ns-a'); // not its lease: no effect
    expect(acquireMaintenanceLease(second, 'ns-a')).toBe(false);
  });

  it('releases the lease after a pass and records when it completed', async () => {
    const before = Date.now();
    await runMaintenance(first, testConfig());
    expect(lastMaintenanceRun(second, NAMESPACE)).toBeGreaterThanOrEqual(before);
    expect(acquireMaintenanceLease(second, NAMESPACE)).toBe(true);
  });

  it('a starting server skips its startup pass when another one completed a pass moments ago', async () => {
    const config = testConfig();
    expect((await runStartupMaintenance(first, config)).skipped).toBeUndefined();
    expect((await runStartupMaintenance(second, config)).skipped).toBe('recent');

    const later = Date.now() + STARTUP_MAINTENANCE_MIN_INTERVAL_MS + 1000;
    expect((await runStartupMaintenance(second, config, later)).skipped).toBeUndefined();
  });

  it('counts the stores of one call together: an ingest of many facts runs at most one pass', async () => {
    const config = { ...testConfig(), maintenanceInterval: 5 };
    expect((await maybeRunMaintenance(first, config, 3)).skipped).toBeUndefined();
    expect(lastMaintenanceRun(first, NAMESPACE)).toBeNull();
    await maybeRunMaintenance(first, config, 7);
    expect(lastMaintenanceRun(first, NAMESPACE)).not.toBeNull();
  });
});
