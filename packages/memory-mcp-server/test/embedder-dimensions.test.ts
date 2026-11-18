/**
 * The embedder checks every vector against the configured size (WP-94): a model whose
 * vectors do not fit the database's vector index fails with a clear message instead of
 * sqlite-vec's "Dimension mismatch" on every insert.
 *
 * The stand-in model is pinned and installed in a temporary verified model store (WP-95),
 * as every model the embedder loads must be; transformers.js is a stub.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const transformers = vi.hoisted(() => {
  const env: Record<string, unknown> = {};
  // A stand-in model that produces 384-dimensional vectors.
  return { env, pipeline: async () => async () => ({ data: new Float32Array(384).fill(0.05) }) };
});

vi.mock('@huggingface/transformers', () => transformers);

import { embed, embedQuery, resetEmbedder } from '../src/embedding/embedder.js';
import { loadConfig, type MemoryConfig } from '../src/config.js';
import { queryPrefixFor, sameEmbeddingModel, embeddingDimensionsFor } from '../src/embedding/models.js';
import { fakeModel, installFakeModel } from './helpers/fake-models.js';

const SMALL_MODEL = fakeModel('someone/small-model');

describe('embedding vector size', () => {
  let modelsDir: string;

  beforeEach(() => {
    modelsDir = mkdtempSync(join(tmpdir(), 'memory-embedder-dimensions-'));
    installFakeModel(modelsDir, SMALL_MODEL);
    resetEmbedder();
  });

  afterEach(() => {
    rmSync(modelsDir, { recursive: true, force: true });
  });

  function config(embeddingDimensions: number): MemoryConfig {
    return {
      ...loadConfig({ MEMORY_MODELS_DIR: modelsDir, MEMORY_MODELS_OFFLINE: 'true' }),
      embeddingModel: SMALL_MODEL.pin.repo,
      embeddingDtype: SMALL_MODEL.pin.dtype,
      modelManifest: [SMALL_MODEL.pin],
      embeddingDimensions,
    };
  }

  it('rejects vectors of another size than the configured one', async () => {
    await expect(embed('text', config(768))).rejects.toThrow(
      /'someone\/small-model' produced 384-dimensional vectors, but the server is configured for 768/,
    );
  });

  it('accepts vectors of the configured size', async () => {
    await expect(embed('text', config(384))).resolves.toHaveLength(384);
    await expect(embedQuery('text', config(384))).resolves.toHaveLength(384);
  });
});

describe('known embedding models', () => {
  it('lists the vector size, aliases and query prefix of the BGE models', () => {
    expect(embeddingDimensionsFor('Xenova/bge-base-en-v1.5')).toBe(768);
    expect(embeddingDimensionsFor('BAAI/bge-small-en-v1.5')).toBe(384);
    expect(sameEmbeddingModel('Xenova/bge-base-en-v1.5', 'BAAI/bge-base-en-v1.5')).toBe(true);
    expect(sameEmbeddingModel('Xenova/bge-base-en-v1.5', 'Xenova/bge-small-en-v1.5')).toBe(false);
    expect(sameEmbeddingModel('someone/model', 'someone/model')).toBe(true);
    expect(sameEmbeddingModel('someone/model', 'someone/other')).toBe(false);
    expect(queryPrefixFor('Xenova/bge-base-en-v1.5')).toContain('Represent this sentence');
    expect(queryPrefixFor('someone/model')).toBe('');
    // Inherited object keys are not models.
    expect(embeddingDimensionsFor('constructor')).toBe(768);
    expect(sameEmbeddingModel('constructor', 'toString')).toBe(false);
  });
});
