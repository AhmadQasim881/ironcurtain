/**
 * The server loads its models when it starts (index.ts calls preloadModels), not inside
 * the first tool call, whose deadline a first-time model download could exceed (WP-94).
 * The embedder rejects vectors of a size the database is not built for.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const loads = vi.hoisted(() => ({ embedder: 0, reranker: 0, failEmbedder: false }));

vi.mock('../src/embedding/embedder.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/embedding/embedder.js')>();
  return {
    ...real,
    getEmbedder: vi.fn(async () => {
      loads.embedder += 1;
      if (loads.failEmbedder) throw new Error('model download failed');
      return vi.fn();
    }),
  };
});

vi.mock('../src/retrieval/reranker.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/retrieval/reranker.js')>();
  return {
    ...real,
    getReranker: vi.fn(async () => {
      loads.reranker += 1;
      return {};
    }),
  };
});

import { preloadModels } from '../src/engine-impl.js';
import { loadConfig } from '../src/config.js';

describe('preloadModels', () => {
  beforeEach(() => {
    loads.embedder = 0;
    loads.reranker = 0;
    loads.failEmbedder = false;
  });

  it('loads the embedder and, when enabled, the re-ranker', async () => {
    await preloadModels(loadConfig({}));
    expect(loads).toMatchObject({ embedder: 1, reranker: 1 });

    await preloadModels(loadConfig({ MEMORY_RERANKER_ENABLED: 'false' }));
    expect(loads).toMatchObject({ embedder: 2, reranker: 1 });
  });

  it('logs a failed load instead of failing the server (the model loads again on first use)', async () => {
    loads.failEmbedder = true;
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(preloadModels(loadConfig({}))).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith('[memory-server] Preloading models failed:', 'model download failed');
    error.mockRestore();
  });
});
