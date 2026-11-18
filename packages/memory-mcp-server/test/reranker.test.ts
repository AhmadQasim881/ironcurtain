import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MemoryRow } from '../src/storage/database.js';
import type { ScoredMemory } from '../src/retrieval/scoring.js';
import { RERANKER_DTYPE, rerank, resetReranker } from '../src/retrieval/reranker.js';
import type { MemoryConfig } from '../src/config.js';
import { loadConfig } from '../src/config.js';
import { ModelStoreError, ensureModel } from '../src/models/model-store.js';

function makeScored(overrides: Partial<MemoryRow & ScoredMemory> = {}): ScoredMemory {
  const now = Date.now();
  return {
    id: overrides.id ?? 'mem-1',
    namespace: 'test',
    content: overrides.content ?? 'Test memory content',
    tags: overrides.tags ?? null,
    importance: overrides.importance ?? 0.5,
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
    last_accessed_at: overrides.last_accessed_at ?? now,
    access_count: overrides.access_count ?? 0,
    is_compacted: overrides.is_compacted ?? 0,
    consolidated: overrides.consolidated ?? 1,
    source: overrides.source ?? null,
    metadata: overrides.metadata ?? null,
    segment_id: overrides.segment_id ?? null,
    fusionScore: overrides.fusionScore ?? 0.5,
    compositeScore: overrides.compositeScore ?? 0.5,
    vectorDistance: overrides.vectorDistance,
  };
}

function makeConfig(overrides: Partial<MemoryConfig> = {}): MemoryConfig {
  return { ...loadConfig({ MEMORY_MODELS_DIR: '/models' }), ...overrides };
}

/** Where the (mocked) model store says the verified cross-encoder lives. */
const VERIFIED_DIR = '/models/Xenova/ms-marco-MiniLM-L-6-v2/0123456789abcdef0123456789abcdef01234567';

// The model store verifies files on disk; here it just answers with a directory.
vi.mock('../src/models/model-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/models/model-store.js')>()),
  ensureModel: vi.fn(),
}));

// Mock transformers with AutoTokenizer and AutoModelForSequenceClassification
const mockTokenizer = vi.fn();
const mockModel = vi.fn();
const transformersEnv = vi.hoisted((): Record<string, unknown> => ({}));

vi.mock('@huggingface/transformers', () => ({
  env: transformersEnv,
  AutoTokenizer: {
    from_pretrained: vi.fn().mockResolvedValue(mockTokenizer),
  },
  AutoModelForSequenceClassification: {
    from_pretrained: vi.fn().mockResolvedValue(mockModel),
  },
}));

describe('rerank', () => {
  beforeEach(() => {
    resetReranker();
    mockTokenizer.mockReset();
    mockModel.mockReset();
    vi.mocked(ensureModel).mockReset();
    vi.mocked(ensureModel).mockResolvedValue(VERIFIED_DIR);
    // Default: tokenizer returns a dummy inputs object
    mockTokenizer.mockReturnValue({ input_ids: 'mock' });
  });

  it('returns empty array for empty candidates', async () => {
    const result = await rerank('query', [], makeConfig());
    expect(result).toEqual([]);
    expect(mockModel).not.toHaveBeenCalled();
  });

  it('returns candidates unchanged when reranker is disabled', async () => {
    const candidates = [makeScored({ id: 'a', content: 'first' }), makeScored({ id: 'b', content: 'second' })];
    const config = makeConfig({ rerankerEnabled: false });

    const result = await rerank('query', candidates, config);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('a');
    expect(result[1].id).toBe('b');
    expect(mockModel).not.toHaveBeenCalled();
  });

  it('sorts candidates by cross-encoder logit score', async () => {
    const candidates = [
      makeScored({ id: 'a', content: 'less relevant' }),
      makeScored({ id: 'b', content: 'more relevant' }),
      makeScored({ id: 'c', content: 'most relevant' }),
    ];

    // Model returns logits: a=-5, b=2, c=8
    mockModel.mockResolvedValue({
      logits: { data: new Float32Array([-5, 2, 8]), dims: [3, 1] },
    });

    const result = await rerank('query', candidates, makeConfig());

    expect(result).toHaveLength(3);
    expect(result[0].id).toBe('c');
    expect(result[0].rerankerScore).toBe(8);
    expect(result[1].id).toBe('b');
    expect(result[1].rerankerScore).toBe(2);
    expect(result[2].id).toBe('a');
    expect(result[2].rerankerScore).toBe(-5);
  });

  it('passes correct query and passage arrays to tokenizer', async () => {
    const candidates = [
      makeScored({ id: 'a', content: 'passage one' }),
      makeScored({ id: 'b', content: 'passage two' }),
    ];

    mockModel.mockResolvedValue({
      logits: { data: new Float32Array([1, 2]), dims: [2, 1] },
    });

    await rerank('my query', candidates, makeConfig());

    expect(mockTokenizer).toHaveBeenCalledWith(['my query', 'my query'], {
      text_pair: ['passage one', 'passage two'],
      padding: true,
      truncation: true,
    });
  });

  it('does not mutate original candidates', async () => {
    const candidates = [makeScored({ id: 'a', content: 'first' }), makeScored({ id: 'b', content: 'second' })];

    mockModel.mockResolvedValue({
      logits: { data: new Float32Array([0.3, 0.8]), dims: [2, 1] },
    });

    const result = await rerank('query', candidates, makeConfig());

    // Original array order unchanged
    expect(candidates[0].id).toBe('a');
    expect(candidates[1].id).toBe('b');
    expect(candidates[0].rerankerScore).toBeUndefined();

    // Result is re-sorted
    expect(result[0].id).toBe('b');
    expect(result[0].rerankerScore).toBeCloseTo(0.8);
  });

  it('caches the model across calls', async () => {
    const transformers = await import('@huggingface/transformers');
    const candidates = [makeScored({ id: 'a', content: 'test' })];

    mockModel.mockResolvedValue({
      logits: { data: new Float32Array([1]), dims: [1, 1] },
    });

    // Clear counts from prior tests, reset singleton
    (transformers.AutoModelForSequenceClassification.from_pretrained as ReturnType<typeof vi.fn>).mockClear();
    resetReranker();

    const config = makeConfig();
    await rerank('query1', candidates, config);
    await rerank('query2', candidates, config);

    // Model loaded only once
    expect(transformers.AutoModelForSequenceClassification.from_pretrained).toHaveBeenCalledTimes(1);
  });

  it('loads the cross-encoder from the verified model store only', async () => {
    const transformers = await import('@huggingface/transformers');
    mockModel.mockResolvedValue({ logits: { data: new Float32Array([1]), dims: [1, 1] } });
    vi.mocked(transformers.AutoTokenizer.from_pretrained).mockClear();
    vi.mocked(transformers.AutoModelForSequenceClassification.from_pretrained).mockClear();
    const config = makeConfig();

    await rerank('query', [makeScored({ id: 'a', content: 'test' })], config);

    // The pinned model, checked by the store, then read from the directory it verified.
    expect(ensureModel).toHaveBeenCalledWith(
      { repo: config.rerankerModel, dtype: RERANKER_DTYPE },
      expect.objectContaining({ modelsDir: '/models', manifest: config.modelManifest, offline: false }),
    );
    expect(transformers.AutoTokenizer.from_pretrained).toHaveBeenCalledWith(VERIFIED_DIR, { local_files_only: true });
    expect(transformers.AutoModelForSequenceClassification.from_pretrained).toHaveBeenCalledWith(VERIFIED_DIR, {
      dtype: 'q8',
      local_files_only: true,
    });
    // transformers.js may not fetch, and caches nothing inside node_modules.
    expect(transformersEnv).toMatchObject({
      allowRemoteModels: false,
      useFSCache: false,
      cacheDir: '/models',
      localModelPath: '/models',
    });
  });

  it('never hands transformers.js a model the store refused', async () => {
    const transformers = await import('@huggingface/transformers');
    vi.mocked(transformers.AutoModelForSequenceClassification.from_pretrained).mockClear();
    vi.mocked(ensureModel).mockRejectedValue(
      new ModelStoreError('MODEL_INTEGRITY', 'onnx/model_quantized.onnx failed verification'),
    );

    await expect(rerank('query', [makeScored({ id: 'a', content: 'test' })], makeConfig())).rejects.toMatchObject({
      code: 'MODEL_INTEGRITY',
    });
    expect(transformers.AutoModelForSequenceClassification.from_pretrained).not.toHaveBeenCalled();
  });
});
