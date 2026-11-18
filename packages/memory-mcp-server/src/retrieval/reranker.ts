import type { MemoryConfig } from '../config.js';
import { ensureModel, modelStoreOptions } from '../models/model-store.js';
import { lockDownTransformers } from '../models/transformers-env.js';
import type { ScoredMemory } from './scoring.js';

/** The dtype the cross-encoder is loaded with, and pinned for. */
export const RERANKER_DTYPE = 'q8';

interface RerankerModel {
  tokenizer: {
    (texts: string[], options: { text_pair: string[]; padding: boolean; truncation: boolean }): Record<string, unknown>;
  };
  model: {
    (inputs: Record<string, unknown>): Promise<{ logits: { data: Float32Array; dims: number[] } }>;
  };
}

let cachedPromise: Promise<RerankerModel> | null = null;
let currentModel: string | null = null;

/**
 * Get or lazily initialize the cross-encoder model and tokenizer.
 * Caches the loading promise to prevent concurrent loads from racing.
 */
export async function getReranker(config: MemoryConfig): Promise<RerankerModel> {
  const key = `${config.rerankerModel}\u0000${config.modelsDir}`;
  if (cachedPromise && currentModel === key) {
    return cachedPromise;
  }

  // Model changed — discard old promise before starting a new load
  currentModel = key;
  cachedPromise = loadReranker(config).catch((e: unknown) => {
    cachedPromise = null;
    currentModel = null;
    throw e;
  });

  return cachedPromise;
}

/**
 * Loads the cross-encoder from the verified model store, like the embedder:
 * pinned files checked (or fetched and checked) first, then transformers.js
 * reads that directory and nothing else.
 */
async function loadReranker(config: MemoryConfig): Promise<RerankerModel> {
  const modelDir = await ensureModel({ repo: config.rerankerModel, dtype: RERANKER_DTYPE }, modelStoreOptions(config));
  const { AutoTokenizer, AutoModelForSequenceClassification, env } = await import('@huggingface/transformers');
  lockDownTransformers(env, config.modelsDir);
  const tokenizer = await AutoTokenizer.from_pretrained(modelDir, { local_files_only: true });
  const model = await AutoModelForSequenceClassification.from_pretrained(modelDir, {
    dtype: RERANKER_DTYPE,
    local_files_only: true,
  });

  return {
    tokenizer: tokenizer as unknown as RerankerModel['tokenizer'],
    model: model as unknown as RerankerModel['model'],
  };
}

/**
 * Reset the cached reranker instance. Primarily for testing.
 */
export function resetReranker(): void {
  cachedPromise = null;
  currentModel = null;
}

/**
 * Re-rank retrieval candidates using a cross-encoder model.
 *
 * Cross-encoders score (query, document) pairs jointly, producing much
 * more accurate relevance judgments than bi-encoder similarity alone.
 * Uses the low-level AutoModelForSequenceClassification API to get
 * raw logits — the high-level pipeline applies softmax which squashes
 * single-output models to always return 1.0.
 *
 * Returns a new array sorted by cross-encoder score (descending).
 * Each candidate's `rerankerScore` field is set to the raw model logit.
 */
export async function rerank(query: string, candidates: ScoredMemory[], config: MemoryConfig): Promise<ScoredMemory[]> {
  if (candidates.length === 0) return [];
  if (!config.rerankerEnabled) return candidates;

  const { tokenizer, model } = await getReranker(config);

  // Build parallel arrays for tokenizer's text_pair API
  const queries = candidates.map(() => query);
  const passages = candidates.map((mem) => mem.content);

  // Tokenize all pairs and run through the model
  const inputs = tokenizer(queries, { text_pair: passages, padding: true, truncation: true });
  const output = await model(inputs);

  // Extract raw logits (shape: [n_candidates, 1] for single-output cross-encoders)
  const logits = output.logits.data;
  const stride = output.logits.dims[1] ?? 1;

  // Attach scores and sort by cross-encoder relevance
  const reranked = candidates.map((mem, i) => {
    const out: ScoredMemory = { ...mem, rerankerScore: logits[i * stride] };
    return out;
  });

  reranked.sort((a, b) => (b.rerankerScore ?? 0) - (a.rerankerScore ?? 0));
  return reranked;
}
