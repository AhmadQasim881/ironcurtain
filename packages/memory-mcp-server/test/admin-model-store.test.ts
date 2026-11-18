/**
 * The admin import's default embedder (src/admin.ts) loads its model from the model
 * store the host names (`ImportOptions.modelStore`): IronCurtain passes
 * `~/.ironcurtain/models` and `memory.offlineModels`, as it does for its memory
 * servers, so an import never downloads into another directory or while downloads
 * are switched off. It embeds for the database: its model and its vector size (WP-94
 * sizes a database's vector index for its model). The embedder is stubbed; it records
 * the config it was given and returns a vector of the size that config asks for.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

interface SeenConfig {
  modelsDir: string;
  modelsOffline: boolean;
  embeddingModel: string;
}

const seen = vi.hoisted(() => ({
  configs: [] as SeenConfig[],
  dimensions: [] as number[],
}));

vi.mock('../src/embedding/embedder.js', () => ({
  embed: vi.fn(async (_text: string, config: SeenConfig & { embeddingDimensions: number }) => {
    seen.configs.push({
      modelsDir: config.modelsDir,
      modelsOffline: config.modelsOffline,
      embeddingModel: config.embeddingModel,
    });
    seen.dimensions.push(config.embeddingDimensions);
    const vector = new Float32Array(config.embeddingDimensions);
    vector[0] = 1;
    return vector;
  }),
}));

import { EMBEDDING_DIMENSIONS, initDatabase } from '../src/storage/database.js';
import { generateId, getEmbeddingsForMemories } from '../src/storage/queries.js';
import { EXPORT_FORMAT, EXPORT_VERSION, openMemoryStoreWriter } from '../src/admin.js';
import { loadConfig } from '../src/config.js';

const NAMESPACE = 'alice';
const MODEL = loadConfig({}).embeddingModel;
/** A model with smaller vectors than the default one (embedding/models.ts). */
const SMALL_MODEL = 'Xenova/bge-small-en-v1.5';
const SMALL_DIMENSIONS = 384;

/** One exported memory, with `embedding` (base64 float32) or none. */
function memoryRecord(id: string, content: string, embedding: string | null): string {
  const now = Date.now();
  return JSON.stringify({
    kind: 'memory',
    id,
    content,
    tags: [],
    importance: 0.5,
    created_at: now,
    updated_at: now,
    last_accessed_at: now,
    access_count: 0,
    is_compacted: false,
    consolidated: true,
    source: null,
    metadata: null,
    segment_id: null,
    embedding,
  });
}

/** An export with one memory that has no vector, so the import must embed it. */
function exportWithoutVector(): string[] {
  return [
    JSON.stringify({ kind: EXPORT_FORMAT, version: EXPORT_VERSION, embedding_model: MODEL }),
    memoryRecord(generateId(), 'Deploys happen on Tuesdays', null),
  ];
}

describe('admin import embedding', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    seen.configs = [];
    seen.dimensions = [];
    tmpDir = mkdtempSync(join(tmpdir(), 'memory-admin-models-'));
    dbPath = join(tmpDir, 'memory.db');
    initDatabase(dbPath, MODEL).close();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function importWith(options: Parameters<ReturnType<typeof openMemoryStoreWriter>['importLines']>[1]) {
    const store = openMemoryStoreWriter({ dbPath, namespace: NAMESPACE });
    try {
      return await store.importLines(exportWithoutVector(), options);
    } finally {
      store.close();
    }
  }

  it('loads the model from the model store the host names, offline when it says so', async () => {
    const modelsDir = join(tmpDir, 'models');
    const outcome = await importWith({ modelStore: { modelsDir, offline: true } });
    expect(outcome).toMatchObject({ memories: 1, embedded: 1 });
    expect(seen.configs).toEqual([{ modelsDir, modelsOffline: true, embeddingModel: MODEL }]);
  });

  it("uses the memory server's own defaults without one", async () => {
    await importWith(undefined);
    expect(seen.configs).toEqual([
      { modelsDir: loadConfig({}).modelsDir, modelsOffline: false, embeddingModel: MODEL },
    ]);
    expect(seen.dimensions).toEqual([EMBEDDING_DIMENSIONS]);
  });

  it("embeds for a database built for a model with smaller vectors, and keeps the file's vectors of that size", async () => {
    const smallDb = join(tmpDir, 'small.db');
    initDatabase(smallDb, SMALL_MODEL).close();
    const fileVector = new Float32Array(SMALL_DIMENSIONS);
    fileVector[3] = 1;
    const withVector = generateId();
    const withoutVector = generateId();
    const lines = [
      JSON.stringify({ kind: EXPORT_FORMAT, version: EXPORT_VERSION, embedding_model: SMALL_MODEL }),
      memoryRecord(withVector, 'Deploys happen on Tuesdays', Buffer.from(fileVector.buffer).toString('base64')),
      memoryRecord(withoutVector, 'Releases happen on Fridays', null),
    ];

    const store = openMemoryStoreWriter({ dbPath: smallDb, namespace: NAMESPACE });
    try {
      expect(await store.importLines(lines)).toMatchObject({ memories: 2, embedded: 1 });
    } finally {
      store.close();
    }

    expect(seen.configs.map((config) => config.embeddingModel)).toEqual([SMALL_MODEL]);
    expect(seen.dimensions).toEqual([SMALL_DIMENSIONS]);
    const db = initDatabase(smallDb, SMALL_MODEL);
    try {
      const vectors = getEmbeddingsForMemories(db, NAMESPACE, [withVector, withoutVector]);
      expect(vectors.get(withVector)).toEqual(fileVector);
      expect(vectors.get(withoutVector)?.length).toBe(SMALL_DIMENSIONS);
    } finally {
      db.close();
    }
  });
});
