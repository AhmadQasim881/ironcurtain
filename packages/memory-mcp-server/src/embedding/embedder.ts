import type { MemoryConfig } from '../config.js';
import { ensureModel, modelStoreOptions } from '../models/model-store.js';
import { lockDownTransformers } from '../models/transformers-env.js';
import { queryPrefixFor } from './models.js';

type EmbedderPipeline = (
  text: string,
  options: { pooling: string; normalize: boolean },
) => Promise<{ data: ArrayLike<number> }>;

let cachedPromise: Promise<EmbedderPipeline> | null = null;
let currentModel: string | null = null;

/** Which loaded pipeline a config asks for: the model, its dtype and the store it is loaded from. */
function embedderKey(config: MemoryConfig): string {
  return [config.embeddingModel, config.embeddingDtype, config.modelsDir].join('\u0000');
}

/**
 * Get or lazily initialize the embedding pipeline.
 * The pipeline is cached as a singleton — the model is only loaded once.
 */
export async function getEmbedder(config: MemoryConfig): Promise<EmbedderPipeline> {
  const key = embedderKey(config);
  if (cachedPromise && currentModel === key) {
    return cachedPromise;
  }

  // Cache the loading promise to prevent concurrent calls from racing
  currentModel = key;
  cachedPromise = loadEmbedder(config).catch((e: unknown) => {
    cachedPromise = null;
    currentModel = null;
    throw e;
  });

  return cachedPromise;
}

/**
 * Reset the cached embedder instance. Primarily for testing.
 */
export function resetEmbedder(): void {
  cachedPromise = null;
  currentModel = null;
}

/**
 * Loads the embedding model from the verified model store: the pinned files
 * are checked (or, when missing and downloads are allowed, fetched and
 * checked) before transformers.js and its native ONNX runtime are even
 * imported, and transformers.js then reads that directory only.
 */
async function loadEmbedder(config: MemoryConfig): Promise<EmbedderPipeline> {
  const modelDir = await ensureModel(
    { repo: config.embeddingModel, dtype: config.embeddingDtype },
    modelStoreOptions(config),
  );
  const { pipeline, env } = await import('@huggingface/transformers');
  lockDownTransformers(env, config.modelsDir);
  return (await pipeline('feature-extraction', modelDir, {
    dtype: config.embeddingDtype as 'q8' | 'fp32' | 'fp16',
    local_files_only: true,
  })) as unknown as EmbedderPipeline;
}

/**
 * Embed a document (memory content) into a vector.
 * Documents are embedded as-is — no prefix applied.
 *
 * Throws when the model's vectors do not have the configured size: the database's
 * vector index holds vectors of that size only (see embedding/models.ts).
 */
export async function embed(text: string, config: MemoryConfig): Promise<Float32Array> {
  const model = await getEmbedder(config);
  const result = await model(text, { pooling: 'mean', normalize: true });
  const vector = new Float32Array(result.data);
  if (vector.length !== config.embeddingDimensions) {
    throw new Error(
      `Embedding model '${config.embeddingModel}' produced ${vector.length}-dimensional vectors, but the server ` +
        `is configured for ${config.embeddingDimensions}. Set MEMORY_EMBEDDING_DIMENSIONS=${vector.length} ` +
        'for this model, with a database built for it.',
    );
  }
  return vector;
}

/**
 * Embed a query for retrieval. Applies the model's asymmetric query prefix (BGE models)
 * so the embedding is optimized for matching against document passages rather than
 * syntactically similar text.
 */
export async function embedQuery(text: string, config: MemoryConfig): Promise<Float32Array> {
  return embed(queryPrefixFor(config.embeddingModel) + text, config);
}

/**
 * Compute cosine similarity between two vectors.
 * Assumes both vectors are already normalized (as produced by embed()).
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}
