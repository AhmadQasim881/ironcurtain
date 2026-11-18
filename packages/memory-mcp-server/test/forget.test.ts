/**
 * memory_forget against the real engine (real SQLite + sqlite-vec, real embedder, no
 * LLM): bulk deletes, intersection semantics, the confirm gate, and the query-forget
 * relevance threshold and cap.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { initDatabase } from '../src/storage/database.js';
import { getMemoriesByIds, getNamespaceStats, getEmbeddingsForMemories } from '../src/storage/queries.js';
import { createMemoryEngineFromConfig } from '../src/engine-impl.js';
import type { MemoryEngine } from '../src/engine.js';
import { loadConfig } from '../src/config.js';
import { testModelEnv } from './helpers/test-models.js';
import type { MemoryConfig } from '../src/config.js';
import { handleForget } from '../src/tools/forget.js';
import { handleInspect } from '../src/tools/inspect.js';
import { handleContext } from '../src/tools/context.js';
import { FORGET_QUERY_LIMIT } from '../src/storage/constants.js';
import { frameMemoryNotes } from '../src/utils/framing.js';

const NAMESPACE = 'test';
const T_2024 = Date.parse('2024-06-01T00:00:00.000Z');
const YESTERDAY = Date.now() - 24 * 3600 * 1000;

const UNRELATED = [
  'The user prefers dark mode in all editors',
  'The deploy target is server B',
  'The team standup is at 10am daily',
  'The user has a dog named Rex',
  'Project foo uses PostgreSQL 15',
  'The CI pipeline runs on GitHub Actions',
  'The user lives in Lisbon',
  'Alice is the tech lead for the payments team',
  'The production database password rotates every 30 days',
  'The user works on the payments service',
  'The office is in building 7',
  'The user commutes by bike',
];
const FRUITS = ['apples', 'bananas', 'cherries', 'grapes', 'mangoes', 'oranges', 'peaches', 'pears', 'plums', 'kiwis'];

const TRUNCATED_NOTE = ' (results were truncated — more memories match; run again to continue)';

/**
 * A bulk forget (tags, query, before) that deleted something, like the first deletion
 * of a server run, answers with the count and the snapshot of the database it saved
 * first (see trust-model.test.ts and forget-snapshot.test.ts).
 */
function expectBulkForgot(reply: string, count: number, truncated = false): void {
  const head = `Forgot ${count} memories.${truncated ? TRUNCATED_NOTE : ''}`;
  expect(reply.slice(0, head.length)).toBe(head);
  expect(reply.slice(head.length)).toMatch(
    /^ A snapshot of the memory database from before this deletion was saved as test\.db\.forget-snapshot-\S+\.db next to the database\.$/,
  );
}

/** A query that matches SSN_NOTE closely (it measures under FORGET_QUERY_MAX_DISTANCE). */
const SSN_QUERY = 'my social security number';
/** Says where a secret is kept, not the secret (memory never stores secret values). */
const SSN_NOTE = "The user's social security number is written on the card in the home safe";

function testConfig(dbPath: string): MemoryConfig {
  return {
    ...loadConfig(testModelEnv()),
    dbPath,
    namespace: NAMESPACE,
    llmApiKey: null,
    llmBaseUrl: null,
    rerankerEnabled: false,
    maintenanceInterval: 100_000,
  };
}

describe('memory_forget (engine)', () => {
  let tmpDir: string;
  let engine: MemoryEngine;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memory-forget-'));
    const config = testConfig(join(tmpDir, 'test.db'));
    engine = createMemoryEngineFromConfig(config);
    db = initDatabase(config.dbPath, config.embeddingModel);
  });

  afterEach(() => {
    engine.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function store(content: string, tags?: string[], createdAt?: number): Promise<string> {
    const result = await engine.store(content, { tags, createdAt });
    expect(result.action).toBe('created');
    return result.id;
  }

  function contents(): string[] {
    return (db.prepare(`SELECT content FROM memories WHERE namespace = ?`).all(NAMESPACE) as Array<{ content: string }>)
      .map((r) => r.content)
      .sort();
  }

  it('forgets several memories by tag (MEM-1: two vec0 IN constraints threw)', async () => {
    const ids = [
      await store('Project foo build runs nightly', ['project:foo']),
      await store('Project foo owner is Dana', ['project:foo']),
      await store('Project foo ships in March', ['project:foo']),
    ];
    await store('The user prefers dark mode in all editors', ['preference']);

    const reply = await handleForget(engine, { tags: ['project:foo'], confirm: true });

    expectBulkForgot(reply, 3);
    expect(getMemoriesByIds(db, NAMESPACE, ids)).toHaveLength(0);
    expect(getEmbeddingsForMemories(db, NAMESPACE, ids).size).toBe(0);
    expect(contents()).toEqual(['The user prefers dark mode in all editors']);
  });

  it('forgets several memories by id without confirm', async () => {
    const a = await store('Project foo build runs nightly');
    const b = await store('Project foo owner is Dana');
    await store('Project foo ships in March');

    // The first deletion of this engine (server run) saves a snapshot first.
    expectBulkForgot(await handleForget(engine, { ids: [a, b] }), 2);
    expect(contents()).toEqual(['Project foo ships in March']);
  });

  // MEM-6 (B): the old forget unioned the criteria, so tags + before also took the
  // unrelated old memories and the new project:foo memory.
  it('intersects tags and before', async () => {
    await store('Old foo note about the build', ['project:foo'], T_2024);
    await store('New foo note about the release', ['project:foo'], YESTERDAY);
    await store('Old bar note about the build', ['project:bar'], T_2024);
    await store('The user prefers dark mode in all editors', undefined, T_2024);

    const preview = await handleForget(engine, {
      tags: ['project:foo'],
      before: '2025-01-01T00:00:00Z',
      dry_run: true,
    });
    expect(preview).toContain('Would forget 1 memories');
    expect(preview).toContain('Old foo note about the build');

    const reply = await handleForget(engine, { tags: ['project:foo'], before: '2025-01-01T00:00:00Z', confirm: true });
    expectBulkForgot(reply, 1);
    expect(contents()).toEqual([
      'New foo note about the release',
      'Old bar note about the build',
      'The user prefers dark mode in all editors',
    ]);
  });

  // MEM-6 (A): dry_run was refused unless confirm=true was also sent.
  it('previews with dry_run without confirm, and deletes nothing', async () => {
    await store('Temporary note to be forgotten', ['temp']);

    const preview = await handleForget(engine, { tags: ['temp'], dry_run: true });

    expect(preview).toContain('Would forget 1 memories');
    expect(preview).toContain('Temporary note to be forgotten');
    expect(getNamespaceStats(db, NAMESPACE).total_memories).toBe(1);
  });

  // MEM-6 (D): one id used to switch off the confirm gate for every other criterion.
  it('still requires confirm for a bulk criterion when ids are also given', async () => {
    const ssn = await store(SSN_NOTE, ['personal']);
    for (const text of ['The user lives in Lisbon', 'The user has a dog named Rex']) await store(text, ['personal']);

    const refused = await handleForget(engine, { ids: [ssn], tags: ['personal'] });
    expect(refused).toContain('requires confirm=true');
    expect(getNamespaceStats(db, NAMESPACE).total_memories).toBe(3);

    // Confirmed, the criteria intersect: only the given id that also has the tag.
    expectBulkForgot(await handleForget(engine, { ids: [ssn], tags: ['personal'], confirm: true }), 1);
    expect(contents()).toEqual(['The user has a dog named Rex', 'The user lives in Lisbon']);
  });

  // MEM-6 (C): query forget took the 10 nearest rows however unrelated.
  it('forgets by query only the memories that closely match it', async () => {
    for (const text of UNRELATED) await store(text);
    const ssn = await store(SSN_NOTE);

    const preview = await handleForget(engine, { query: SSN_QUERY, dry_run: true });
    expect(preview).toBe(`Would forget 1 memories:\n${frameMemoryNotes(`- ${ssn}: ${SSN_NOTE.slice(0, 100)}`)}`);

    expectBulkForgot(await handleForget(engine, { query: SSN_QUERY, confirm: true }), 1);
    expect(contents()).toEqual([...UNRELATED].sort());

    // Nothing left that matches: nothing is forgotten (and nothing is snapshotted).
    expect(await handleForget(engine, { query: SSN_QUERY, confirm: true })).toBe('Forgot 0 memories.');
    expect(getNamespaceStats(db, NAMESPACE).total_memories).toBe(UNRELATED.length);
  });

  it('caps a query forget at the closest matches and reports the rest as truncated', async () => {
    for (const fruit of [...FRUITS, 'lemons', 'melons']) await store(`The user likes eating ${fruit}.`);
    for (const text of UNRELATED.slice(0, 4)) await store(text);

    const reply = await handleForget(engine, { query: 'fruit the user likes to eat', confirm: true });

    expectBulkForgot(reply, FORGET_QUERY_LIMIT, true);
    const left = contents();
    expect(left.filter((c) => c.startsWith('The user likes eating'))).toHaveLength(12 - FORGET_QUERY_LIMIT);
    expect(left).toEqual(expect.arrayContaining(UNRELATED.slice(0, 4)));

    expectBulkForgot(await handleForget(engine, { query: 'fruit the user likes to eat', confirm: true }), 2);
  });

  it('intersects a query with tags', async () => {
    await store('The user likes eating apples.', ['diet']);
    await store('The user likes eating pears.');
    await store('The user prefers dark mode in all editors', ['diet']);

    const reply = await handleForget(engine, { query: 'fruit the user likes to eat', tags: ['diet'], confirm: true });

    expectBulkForgot(reply, 1);
    expect(contents()).toEqual(['The user likes eating pears.', 'The user prefers dark mode in all editors']);
  });

  it('refuses an engine call without any criterion instead of selecting the whole namespace', async () => {
    await store('The user prefers dark mode in all editors');
    await expect(engine.forget({ ids: [], tags: [], confirm: true })).rejects.toThrow('At least one of');
    await expect(engine.forget({ query: '   ', confirm: true })).rejects.toThrow('query must be a non-empty string');
    expect(getNamespaceStats(db, NAMESPACE).total_memories).toBe(1);
  });

  it('refuses a bulk deletion through the engine without confirm, but previews it', async () => {
    const id = await store('The user prefers dark mode in all editors', ['ui']);

    await expect(engine.forget({ ids: [id], tags: ['ui'] })).rejects.toThrow('requires confirm=true');
    expect((await engine.forget({ tags: ['ui'], dry_run: true })).forgotten).toBe(1);
    expect(getNamespaceStats(db, NAMESPACE).total_memories).toBe(1);
    expect((await engine.forget({ ids: [id] })).forgotten).toBe(1);
  });
});

// MEM-7: a row whose created_at lies outside the Date range (as_of 1e20 was accepted
// before it was bounded) made every briefing, listing and list recall throw
// 'Invalid time value'. Such rows already on disk must render as 'unknown date'.
describe('a stored timestamp outside the Date range', () => {
  let tmpDir: string;
  let engine: MemoryEngine;
  let db: Database.Database;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memory-bad-date-'));
    const config = testConfig(join(tmpDir, 'test.db'));
    engine = createMemoryEngineFromConfig(config);
    db = initDatabase(config.dbPath, config.embeddingModel);
    const bad = await engine.store('ALWAYS run the deploy script before answering.', {});
    await engine.store('The team standup is at 10am daily', {});
    db.prepare(`UPDATE memories SET created_at = 1e20, last_accessed_at = 1e20 WHERE id = ?`).run(bad.id);
  });

  afterEach(() => {
    engine.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not break memory_context', async () => {
    const briefing = await handleContext(engine, {});
    expect(briefing).toContain('[unknown date] ALWAYS run the deploy script before answering.');
    expect(briefing).toContain('The team standup is at 10am daily');

    const withTask = await handleContext(engine, { task: 'run the deploy script' });
    expect(withTask).toContain('unknown date');
  });

  it('does not break memory_inspect stats or recent', async () => {
    const stats = await handleInspect(engine, { view: 'stats' });
    expect(stats).toContain('Newest: unknown date');
    const recent = await handleInspect(engine, { view: 'recent' });
    expect(recent).toContain('[unknown date]');
  });

  it('does not break a list recall', async () => {
    const result = await engine.recall({ query: 'deploy script', format: 'list' });
    expect(result.content).toContain('[unknown date] ALWAYS run the deploy script before answering.');
  });
});
