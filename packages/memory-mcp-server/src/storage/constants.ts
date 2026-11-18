/** Very high similarity (distance < 0.05 = cosine > 0.95). Store-time dedup only
 *  considers neighbours this close, and merges one of them only when its text is the
 *  same fact in the same words (utils/fact-text.ts): different facts that differ by one
 *  word ('production' / 'staging') also measure under this distance.
 *  Tighter threshold needed for BGE-base which produces denser clusters than MiniLM. */
export const EXACT_DEDUP_DISTANCE = 0.05;

/** Nearest neighbours a new memory is compared with for the store-time merge. */
export const STORE_DEDUP_CANDIDATES = 5;

/** memory_forget: at most this many rows one tags/before/ids selection targets. */
export const FORGET_RESULT_LIMIT = 1000;

/**
 * memory_forget by query: a memory matches only within this cosine distance of the
 * (query-prefixed) query embedding. With the default BGE model, memories stating what
 * the query names measure about 0.18-0.36 and unrelated ones 0.39 and up, so 0.35
 * errs towards forgetting too little; dry_run shows the matches, ids forget the rest.
 */
export const FORGET_QUERY_MAX_DISTANCE = 0.35;

/** memory_forget by query: at most this many (closest) matches per call. */
export const FORGET_QUERY_LIMIT = 10;
