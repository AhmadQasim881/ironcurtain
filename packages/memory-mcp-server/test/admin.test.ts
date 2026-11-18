/**
 * The host-side admin API (src/admin.ts) behind `ironcurtain memory <persona|job> ...`:
 * it reads without maintenance or schema changes, sees every memory (pending, decayed
 * and compacted ones included), exports and imports the whole store page by page,
 * deletes through the memory server's path after a snapshot, and approves memories
 * that wait for review.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

import { initDatabase, EMBEDDING_DIMENSIONS } from '../src/storage/database.js';
import type { MemoryRow } from '../src/storage/database.js';
import {
  generateId,
  getEmbeddingsForMemories,
  insertMemory,
  insertSegment,
  markCompacted,
  markDecayed,
} from '../src/storage/queries.js';
import {
  EXPORT_FORMAT,
  MemoryImportError,
  openMemoryStoreReader,
  openMemoryStoreWriter,
  type MemoryStoreWriter,
} from '../src/admin.js';
import { loadConfig } from '../src/config.js';
import { REDACTED_SECRET_MARKER } from '../src/utils/secrets.js';
import { segmentContentHash } from '../src/utils/content-hash.js';

const NAMESPACE = 'alice';
const MODEL = loadConfig({}).embeddingModel;

function unitVector(seed: number): Float32Array {
  const v = new Float32Array(EMBEDDING_DIMENSIONS);
  v[seed % EMBEDDING_DIMENSIONS] = 1;
  return v;
}

describe('memory admin API', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memory-admin-'));
    dbPath = join(tmpDir, 'memory.db');
    db = initDatabase(dbPath, MODEL);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function put(content: string, options: { metadata?: Record<string, unknown>; consolidated?: boolean } = {}): string {
    const id = generateId();
    insertMemory(
      db,
      {
        id,
        namespace: NAMESPACE,
        content,
        tags: ['deploy'],
        importance: 0.5,
        metadata: options.metadata,
        consolidated: options.consolidated ?? true,
      },
      unitVector(content.length),
    );
    return id;
  }

  function allRows(): MemoryRow[] {
    return db.prepare(`SELECT * FROM memories ORDER BY rowid`).all() as MemoryRow[];
  }

  const PENDING = { writer: { kind: 'cron', session_id: 'run-1', scope: 'job:daily' }, pending_review: 'job:daily' };

  describe('reading', () => {
    it('lists memories without running maintenance: nothing is consolidated, decayed or changed', () => {
      put('Deploys happen on Tuesdays', { consolidated: false });
      put('Rollbacks use the previous tag', { consolidated: false });
      const before = allRows();

      const store = openMemoryStoreReader({ dbPath, namespace: NAMESPACE });
      try {
        expect(store.list().map((m) => m.content)).toEqual([
          'Rollbacks use the previous tag',
          'Deploys happen on Tuesdays',
        ]);
        expect(store.stats()).toMatchObject({ total: 2, unconsolidated: 2 });
      } finally {
        store.close();
      }

      // The memory server consolidates on startup (and, without an LLM, just marks
      // every row consolidated): a list must not.
      expect(allRows()).toEqual(before);
      expect(allRows().every((r) => r.consolidated === 0)).toBe(true);
    });

    it('refuses a missing database without creating it', () => {
      const missing = join(tmpDir, 'nope', 'memory.db');
      expect(() => openMemoryStoreReader({ dbPath: missing, namespace: NAMESPACE })).toThrow();
      expect(existsSync(missing)).toBe(false);
    });

    it('refuses a database of another schema version instead of rebuilding it', () => {
      put('Kept as it is');
      db.prepare(`UPDATE schema_meta SET value = '3' WHERE key = 'schema_version'`).run();

      expect(() => openMemoryStoreReader({ dbPath, namespace: NAMESPACE })).toThrow(/schema version "3"/);
      expect(() => openMemoryStoreWriter({ dbPath, namespace: NAMESPACE })).toThrow(/schema version/);
      expect(allRows().map((r) => r.content)).toEqual(['Kept as it is']);
      expect(readdirSync(tmpDir).filter((name) => name.includes('backup'))).toEqual([]);
    });

    it('shows pending, decayed and compacted memories with their status and writer', () => {
      const pending = put('Push to the mirror remote', { metadata: PENDING });
      const decayed = put('An old note');
      markDecayed(db, NAMESPACE, decayed);
      const compacted = put('A compacted note');
      markDecayed(db, NAMESPACE, compacted);
      markCompacted(db, NAMESPACE, [compacted]);

      const store = openMemoryStoreReader({ dbPath, namespace: NAMESPACE });
      try {
        const byId = new Map(store.list().map((m) => [m.id, m]));
        expect(byId.get(pending)).toMatchObject({
          status: 'active',
          pending_review: 'job:daily',
          writer: { kind: 'cron', session_id: 'run-1', scope: 'job:daily' },
        });
        expect(byId.get(decayed)?.status).toBe('decayed');
        expect(byId.get(compacted)?.status).toBe('compacted');
        expect(store.list({ pendingOnly: true }).map((m) => m.id)).toEqual([pending]);
        expect(store.stats()).toMatchObject({
          total: 3,
          active: 1,
          decayed: 1,
          compacted: 1,
          pending_review: 1,
          pending_by_scope: [{ scope: 'job:daily', count: 1 }],
        });
      } finally {
        store.close();
      }
    });

    it('searches content, tags and source literally (LIKE wildcards are escaped)', () => {
      put('Coverage must stay at 100% for the parser');
      put('Coverage is at 1000 lines');
      const store = openMemoryStoreReader({ dbPath, namespace: NAMESPACE });
      try {
        expect(store.search('100%').map((m) => m.content)).toEqual(['Coverage must stay at 100% for the parser']);
        expect(store.search('DEPLOY')).toHaveLength(2); // the tag, case-insensitively
        expect(() => store.search('  ')).toThrow('must not be empty');
      } finally {
        store.close();
      }
    });

    it('shows one memory with its metadata and source segment', () => {
      const segmentId = insertSegment(db, {
        namespace: NAMESPACE,
        content: 'The full release checklist',
        factCount: 1,
      });
      const id = generateId();
      insertMemory(
        db,
        { id, namespace: NAMESPACE, content: 'A checklist exists', tags: undefined, importance: 0.5, segmentId },
        unitVector(3),
      );
      const store = openMemoryStoreReader({ dbPath, namespace: NAMESPACE });
      try {
        expect(store.get(id)?.segment).toMatchObject({ id: segmentId, content: 'The full release checklist' });
        expect(store.get(generateId())).toBeUndefined();
      } finally {
        store.close();
      }
    });
  });

  describe('export and import', () => {
    function exportAll(): string[] {
      const store = openMemoryStoreReader({ dbPath, namespace: NAMESPACE });
      try {
        return [...store.exportLines()];
      } finally {
        store.close();
      }
    }

    function freshTarget(): MemoryStoreWriter {
      return openMemoryStoreWriter({
        dbPath: join(tmpDir, 'restored', 'memory.db'),
        namespace: NAMESPACE,
        create: true,
      });
    }

    it('exports every memory, decayed and compacted ones too, over several pages, with segments first', () => {
      const segmentId = insertSegment(db, { namespace: NAMESPACE, content: 'Source text', factCount: 1 });
      const ids: string[] = [];
      for (let i = 0; i < 1203; i++) ids.push(put(`Fact number ${i}`));
      markDecayed(db, NAMESPACE, ids[5]);
      markDecayed(db, NAMESPACE, ids[6]);
      markCompacted(db, NAMESPACE, [ids[6]]);
      db.prepare(`UPDATE memories SET segment_id = ? WHERE id = ?`).run(segmentId, ids[7]);

      const lines = exportAll().map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(lines[0]).toMatchObject({ kind: EXPORT_FORMAT, version: 1, namespace: NAMESPACE, embedding_model: MODEL });
      expect(lines[1]).toMatchObject({ kind: 'segment', id: segmentId });
      const memories = lines.filter((l) => l.kind === 'memory');
      expect(memories.map((m) => m.id)).toEqual(ids);
      expect(memories[5]).toMatchObject({ importance: 0, embedding: null });
      expect(memories[6]).toMatchObject({ is_compacted: true });
      expect(memories[7]).toMatchObject({ segment_id: segmentId });
      expect(typeof memories[0].embedding).toBe('string');
    });

    it('restores an export exactly, vectors and review markers included, without an embedding model', async () => {
      const segmentId = insertSegment(db, { namespace: NAMESPACE, content: 'Source text', factCount: 1 });
      const pending = put('Push to the mirror remote', { metadata: PENDING });
      const linked = put('A linked fact');
      db.prepare(`UPDATE memories SET segment_id = ?, access_count = 4 WHERE id = ?`).run(segmentId, linked);
      const decayed = put('A decayed fact');
      markDecayed(db, NAMESPACE, decayed);
      const lines = exportAll();

      const target = freshTarget();
      try {
        const outcome = await target.importLines(lines, {
          embed: () => Promise.reject(new Error('no embedding needed: the file has the vectors')),
        });
        expect(outcome).toEqual({
          memories: 3,
          segments: 1,
          skipped_existing: 0,
          unlinked_segments: 0,
          embedded: 0,
          redacted_secrets: 0,
        });
        const restored = new Database(join(tmpDir, 'restored', 'memory.db'), { readonly: true });
        try {
          expect(restored.prepare(`SELECT * FROM memories ORDER BY rowid`).all()).toEqual(allRows());
        } finally {
          restored.close();
        }
        expect(target.get(pending)?.pending_review).toBe('job:daily');
        expect(target.get(linked)?.segment?.content).toBe('Source text');

        // The vectors came from the file: a second export carries the same ones.
        const reexported = [...target.exportLines()].map((l) => JSON.parse(l) as Record<string, unknown>);
        const vectorOf = (id: string): unknown => reexported.find((l) => l.id === id)?.embedding;
        const original = getEmbeddingsForMemories(db, NAMESPACE, [pending]).get(pending) ?? new Float32Array();
        expect(vectorOf(pending)).toBe(
          Buffer.from(original.buffer, original.byteOffset, original.byteLength).toString('base64'),
        );
        expect(vectorOf(decayed)).toBeNull();

        // Importing again changes nothing.
        expect(await target.importLines(lines)).toMatchObject({ memories: 0, segments: 0, skipped_existing: 4 });
      } finally {
        target.close();
      }
    });

    it('imports segments with the content hash a retried ingest finds them by, as the server writes it', async () => {
      const segmentId = insertSegment(db, {
        namespace: NAMESPACE,
        content: 'Source text',
        source: 'notes',
        mode: 'document',
        factCount: 1,
      });
      const linked = put('A linked fact');
      db.prepare(`UPDATE memories SET segment_id = ? WHERE id = ?`).run(segmentId, linked);
      const lines = exportAll();

      const target = freshTarget();
      try {
        expect(await target.importLines(lines)).toMatchObject({ segments: 1, memories: 1 });
      } finally {
        target.close();
      }
      const restored = new Database(join(tmpDir, 'restored', 'memory.db'), { readonly: true });
      try {
        expect(restored.prepare(`SELECT content_hash FROM segments WHERE id = ?`).get(segmentId)).toEqual({
          content_hash: segmentContentHash('Source text', 'notes', 'document'),
        });
      } finally {
        restored.close();
      }
    });

    it('embeds memories that come without a vector, or with one from another model, and only active ones', async () => {
      const header = { kind: EXPORT_FORMAT, version: 1, embedding_model: 'some/other-model' };
      const memory = (id: string, importance: number, embedding: string | null) => ({
        kind: 'memory',
        id,
        content: `Fact ${id}`,
        tags: [],
        importance,
        created_at: 1000,
        updated_at: 1000,
        last_accessed_at: 1000,
        access_count: 0,
        is_compacted: false,
        consolidated: true,
        source: null,
        metadata: null,
        segment_id: null,
        embedding,
      });
      const lines = [
        header,
        memory('a'.repeat(32), 0.5, Buffer.from(unitVector(1).buffer).toString('base64')),
        memory('b'.repeat(32), 0.5, null),
        memory('c'.repeat(32), 0, null),
      ].map((r) => JSON.stringify(r));
      const embedded: string[] = [];
      const target = freshTarget();
      try {
        const outcome = await target.importLines(lines, {
          embed: async (text) => {
            embedded.push(text);
            return unitVector(9);
          },
        });
        expect(outcome).toMatchObject({ memories: 3, embedded: 2 });
        expect(embedded).toEqual([`Fact ${'a'.repeat(32)}`, `Fact ${'b'.repeat(32)}`]);
      } finally {
        target.close();
      }
    });

    it('removes secret values from imported text, as the memory server does', async () => {
      const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
      const lines = [
        JSON.stringify({ kind: EXPORT_FORMAT, version: 1, embedding_model: MODEL }),
        JSON.stringify({
          kind: 'memory',
          id: 'd'.repeat(32),
          content: `The deploy key is ${key}`,
          tags: [],
          importance: 0.5,
          created_at: 1000,
          updated_at: 1000,
          last_accessed_at: 1000,
          access_count: 0,
          is_compacted: false,
          consolidated: true,
          source: null,
          metadata: null,
          segment_id: null,
          embedding: null,
        }),
      ];
      const target = freshTarget();
      try {
        const outcome = await target.importLines(lines, { embed: async () => unitVector(2) });
        expect(outcome.redacted_secrets).toBe(1);
        expect(target.get('d'.repeat(32))?.content).toBe(`The deploy key is ${REDACTED_SECRET_MARKER}`);
      } finally {
        target.close();
      }
    });

    it('imports nothing from a file with an invalid record', async () => {
      const good = exportAllWith(['First fact']);
      const bad = [...good, JSON.stringify({ kind: 'memory', id: 'not-an-id' })];
      const target = freshTarget();
      try {
        await expect(target.importLines(bad)).rejects.toBeInstanceOf(MemoryImportError);
        await expect(target.importLines(['{"kind":"something-else"}'])).rejects.toThrow(
          /not an IronCurtain memory export/,
        );
        await expect(target.importLines([])).rejects.toThrow(/empty/);
        const future = good.map((line, i) =>
          i === 1 ? line.replace(/"created_at":\d+/, `"created_at":${Date.now() + 86_400_000}`) : line,
        );
        await expect(target.importLines(future)).rejects.toThrow(/not in the future/);
        expect(target.stats().total).toBe(0);
      } finally {
        target.close();
      }
    });

    function exportAllWith(contents: string[]): string[] {
      for (const content of contents) put(content);
      return exportAll();
    }
  });

  describe('changes', () => {
    it('forgets by id after a snapshot, removing the vector too, and reports unknown ids', () => {
      const keep = put('Keep me');
      const drop = put('Drop me');
      const unknown = generateId();
      const store = openMemoryStoreWriter({ dbPath, namespace: NAMESPACE });
      try {
        const outcome = store.forget([drop, unknown]);
        expect(outcome.forgotten).toBe(1);
        expect(outcome.missing).toEqual([unknown]);
        expect(outcome.snapshot).not.toBeNull();
        expect(existsSync(outcome.snapshot ?? '')).toBe(true);
        expect(store.forget([unknown])).toEqual({ forgotten: 0, missing: [unknown], snapshot: null });
        expect(() => store.forget(['../etc'])).toThrow('Not a memory id');
      } finally {
        store.close();
      }
      expect(allRows().map((r) => r.id)).toEqual([keep]);
      expect(getEmbeddingsForMemories(db, NAMESPACE, [drop]).size).toBe(0);
    });

    it('forgets the way memory_forget does: the source passage goes too, siblings are unlinked', () => {
      // The passage states the forgotten fact; keeping it would hand the text back
      // through memory_expand and the sibling's recall expansion (MEM-3).
      const segmentId = insertSegment(db, {
        namespace: NAMESPACE,
        content: 'Deploy notes: the staging password rotates on Fridays.',
        factCount: 2,
      });
      const drop = put('Staging password rotates on Fridays');
      const sibling = put('Deploy notes exist');
      db.prepare(`UPDATE memories SET segment_id = ? WHERE id IN (?, ?)`).run(segmentId, drop, sibling);

      const store = openMemoryStoreWriter({ dbPath, namespace: NAMESPACE });
      try {
        expect(store.forget([drop]).forgotten).toBe(1);
        expect(store.get(sibling)?.segment).toBeNull();
      } finally {
        store.close();
      }
      expect(db.prepare(`SELECT id FROM segments WHERE id = ?`).get(segmentId)).toBeUndefined();
      expect(allRows().map((r) => [r.id, r.segment_id])).toEqual([[sibling, null]]);
    });

    it('approves only explicit reviewed snapshots and preserves writer provenance', () => {
      const daily1 = put('Daily one', { metadata: PENDING });
      const daily2 = put('Daily two', { metadata: PENDING });
      const weekly = put('Weekly', { metadata: { pending_review: 'job:weekly' } });
      const reviewed = put('Reviewed already');
      const store = openMemoryStoreWriter({ dbPath, namespace: NAMESPACE });
      try {
        const receipt = (id: string) => ({ id, digest: store.get(id)?.review_digest ?? '0'.repeat(64) });
        expect(store.approve([receipt(daily1), receipt(reviewed), receipt('f'.repeat(32))])).toEqual({
          approved: 1,
          missing: ['f'.repeat(32)],
          notPending: [reviewed],
          changed: [],
        });
        expect(store.approve([receipt(weekly)]).approved).toBe(1);
        expect(store.list({ pendingOnly: true }).map((m) => m.id)).toEqual([daily2]);
        expect(store.get(daily1)).toMatchObject({ pending_review: null, consolidated: false });
        expect(typeof store.get(daily1)?.reviewed_at).toBe('number');
        // The writer is kept: who wrote it stays on record.
        expect(store.get(daily1)?.writer).toEqual(PENDING.writer);
        expect(store.get(weekly)?.pending_review).toBeNull();
        expect(store.approve([receipt(daily2)]).approved).toBe(1);
        expect(store.stats().pending_review).toBe(0);
      } finally {
        store.close();
      }
    });

    it.each(['content', 'tags', 'source', 'metadata', 'segment_content', 'segment_source', 'segment_mode'])(
      'refuses a stale receipt when %s changes',
      (field) => {
        const id = put('Example fact', { metadata: PENDING });
        const segmentId = insertSegment(db, { namespace: NAMESPACE, content: 'Example source passage.', factCount: 1 });
        db.prepare('UPDATE memories SET segment_id = ? WHERE id = ?').run(segmentId, id);
        const store = openMemoryStoreWriter({ dbPath, namespace: NAMESPACE });
        try {
          const receipt = { id, digest: store.get(id)?.review_digest ?? '' };
          if (field === 'content')
            db.prepare('UPDATE memories SET content = ? WHERE id = ?').run('New example fact', id);
          else if (field === 'tags') db.prepare('UPDATE memories SET tags = ? WHERE id = ?').run('["new-tag"]', id);
          else if (field === 'source') db.prepare('UPDATE memories SET source = ? WHERE id = ?').run('New label', id);
          else if (field === 'metadata')
            db.prepare('UPDATE memories SET metadata = ? WHERE id = ?').run(
              JSON.stringify({ ...PENDING, example: 'new metadata' }),
              id,
            );
          else if (field === 'segment_content')
            db.prepare('UPDATE segments SET content = ? WHERE id = ?').run('New example source passage.', segmentId);
          else if (field === 'segment_source')
            db.prepare('UPDATE segments SET source = ? WHERE id = ?').run('New source label', segmentId);
          else db.prepare('UPDATE segments SET mode = ? WHERE id = ?').run('new-mode', segmentId);
          expect(store.approve([receipt])).toEqual({ approved: 0, missing: [], notPending: [], changed: [id] });
          expect(store.get(id)?.pending_review).toBe('job:daily');
          expect(store.approve([{ id, digest: store.get(id)?.review_digest ?? '' }]).approved).toBe(1);
        } finally {
          store.close();
        }
      },
    );

    it('rejects malformed or conflicting receipts without approving any row', () => {
      const id = put('Example pending fact', { metadata: PENDING });
      const store = openMemoryStoreWriter({ dbPath, namespace: NAMESPACE });
      try {
        expect(() => store.approve([{ id, digest: 'not-a-digest' }])).toThrow(/review receipts/);
        const receipt = { id, digest: store.get(id)?.review_digest ?? '' };
        expect(() => store.approve([receipt, { id, digest: '0'.repeat(64) }])).toThrow(/Conflicting/);
        expect(store.get(id)?.pending_review).toBe('job:daily');
      } finally {
        store.close();
      }
    });
  });
});
