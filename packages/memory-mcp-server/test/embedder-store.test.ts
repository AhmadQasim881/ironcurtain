/**
 * The embedder loads its model only from the verified model store: the
 * pinned files are checked before transformers.js runs, transformers.js reads
 * that directory with remote loading and its own cache off, and nothing is
 * cached inside node_modules. (The real-model suites run the same path with
 * real ONNX files; here transformers.js is a stub so the checks are exact.)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type MemoryConfig } from '../src/config.js';
import { embed, resetEmbedder } from '../src/embedding/embedder.js';
import { fakeModel, installFakeModel } from './helpers/fake-models.js';

const transformers = vi.hoisted(() => {
  const env: Record<string, unknown> = {};
  return { env, pipeline: vi.fn() };
});

vi.mock('@huggingface/transformers', () => transformers);

const model = fakeModel('Test/tiny-embedder');

describe('embedder model loading', () => {
  let modelsDir: string;

  beforeEach(() => {
    modelsDir = mkdtempSync(join(tmpdir(), 'memory-embedder-store-'));
    resetEmbedder();
    transformers.pipeline.mockReset();
    transformers.pipeline.mockResolvedValue(async () => ({ data: [0.6, 0.8] }));
    for (const key of Object.keys(transformers.env)) Reflect.deleteProperty(transformers.env, key);
  });

  afterEach(() => {
    rmSync(modelsDir, { recursive: true, force: true });
  });

  function config(env: Record<string, string> = {}): MemoryConfig {
    return {
      ...loadConfig({ MEMORY_MODELS_DIR: modelsDir, ...env }),
      embeddingModel: model.pin.repo,
      embeddingDtype: model.pin.dtype,
      modelManifest: [model.pin],
      // The stub's vectors (the embedder checks every vector against this size, WP-94).
      embeddingDimensions: 2,
    };
  }

  it('loads the verified directory under the models directory, never a Hub id', async () => {
    const dir = installFakeModel(modelsDir, model);

    await expect(embed('hello', config())).resolves.toEqual(new Float32Array([0.6, 0.8]));

    expect(transformers.pipeline).toHaveBeenCalledOnce();
    expect(transformers.pipeline).toHaveBeenCalledWith('feature-extraction', dir, {
      dtype: 'q8',
      local_files_only: true,
    });
    expect(dir.startsWith(modelsDir)).toBe(true);
    // transformers.js caches under the models directory (not node_modules), and may not fetch.
    expect(transformers.env).toMatchObject({
      allowRemoteModels: false,
      useFSCache: false,
      cacheDir: modelsDir,
      localModelPath: modelsDir,
    });
  });

  it('rejects a tampered model file before transformers.js sees it', async () => {
    const dir = installFakeModel(modelsDir, model);
    const weights = join(dir, 'onnx', 'model_quantized.onnx');
    const bytes = readFileSync(weights);
    bytes[bytes.length - 1] ^= 0x01;
    writeFileSync(weights, bytes);

    await expect(embed('hello', config())).rejects.toMatchObject({
      code: 'MODEL_INTEGRITY',
      message: expect.stringContaining('failed verification'),
    });
    expect(transformers.pipeline).not.toHaveBeenCalled();
  });

  it('with downloads off and an empty cache, reports a clear error', async () => {
    await expect(embed('hello', config({ MEMORY_MODELS_OFFLINE: 'true' }))).rejects.toMatchObject({
      code: 'MODEL_NOT_CACHED',
      message: expect.stringMatching(/not in the model cache .* model downloads are disabled \(offline mode\)/),
    });
    expect(transformers.pipeline).not.toHaveBeenCalled();
  });

  it('refuses a model the manifest does not pin', async () => {
    await expect(embed('hello', { ...config(), embeddingModel: 'Someone/unpinned-model' })).rejects.toMatchObject({
      code: 'MODEL_UNPINNED',
    });
    expect(transformers.pipeline).not.toHaveBeenCalled();
  });
});
