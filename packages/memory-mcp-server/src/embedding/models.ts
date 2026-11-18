/**
 * What the server knows about the embedding models it can run: the size of the vectors
 * each one produces, which names denote the same model, and the query prefix of the
 * asymmetric (BGE) ones.
 *
 * A database is built for one model: `vec_memories` holds vectors of one dimension, and
 * vectors from two different models are not comparable even when their dimensions match.
 * `initDatabase` therefore refuses to open a database built with another model (see
 * storage/database.ts), and this table decides what "another model" is.
 */

/** Vector size of the default model; also assumed for a model this table does not know. */
export const DEFAULT_EMBEDDING_DIMENSIONS = 768;

interface KnownModel {
  /** Size of the vectors the model produces. */
  readonly dimensions: number;
  /** Models with the same family produce the same vectors (an ONNX port of the same weights). */
  readonly family: string;
  /** Prefix for queries (asymmetric retrieval); documents are embedded as-is. */
  readonly queryPrefix?: string;
}

const BGE_QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

const KNOWN_MODELS: Readonly<Record<string, KnownModel>> = {
  'Xenova/bge-base-en-v1.5': { dimensions: 768, family: 'bge-base-en-v1.5', queryPrefix: BGE_QUERY_PREFIX },
  'BAAI/bge-base-en-v1.5': { dimensions: 768, family: 'bge-base-en-v1.5', queryPrefix: BGE_QUERY_PREFIX },
  'Xenova/bge-small-en-v1.5': { dimensions: 384, family: 'bge-small-en-v1.5', queryPrefix: BGE_QUERY_PREFIX },
  'BAAI/bge-small-en-v1.5': { dimensions: 384, family: 'bge-small-en-v1.5', queryPrefix: BGE_QUERY_PREFIX },
};

function knownModel(model: string): KnownModel | undefined {
  return Object.hasOwn(KNOWN_MODELS, model) ? KNOWN_MODELS[model] : undefined;
}

/**
 * The vector size `model` produces: from the table above, or DEFAULT_EMBEDDING_DIMENSIONS
 * for a model it does not list (set MEMORY_EMBEDDING_DIMENSIONS for such a model; the
 * embedder checks every vector against the configured size).
 */
export function embeddingDimensionsFor(model: string): number {
  return knownModel(model)?.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;
}

/** True when vectors of `a` and `b` can share one index: the same model, or two names of it. */
export function sameEmbeddingModel(a: string, b: string): boolean {
  if (a === b) return true;
  const familyA = knownModel(a)?.family;
  return familyA !== undefined && familyA === knownModel(b)?.family;
}

/** The query prefix of an asymmetric model ('' for a symmetric or unknown one). */
export function queryPrefixFor(model: string): string {
  return knownModel(model)?.queryPrefix ?? '';
}
