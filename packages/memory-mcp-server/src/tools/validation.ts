/**
 * Shared validation constants and helpers used across tool handlers.
 */

export const MAX_CONTENT_LENGTH = 10000;
export const MAX_QUERY_LENGTH = 2000;
export const MAX_TOKEN_BUDGET = 50000;
export const MAX_TAGS = 50;
export const MAX_TAG_LENGTH = 100;
export const MAX_IDS = 100;
export const MAX_LIMIT = 1000;
/** Most source passages one recall (`max_expand_passages`) or memory_expand (`max_passages`) returns. */
export const MAX_EXPAND_PASSAGES = 20;
/** Passages memory_expand returns when the call does not set `max_passages` (each is at most ~350 tokens). */
export const DEFAULT_EXPAND_PASSAGES = 3;

/**
 * Largest memory_ingest content, in UTF-8 bytes (200 KB, about 50,000 tokens). Each
 * ~6,000-token chunk of it is one paid LLM call on the user's key, outside IronCurtain's
 * session budgets, so one call must not be able to send megabytes.
 */
export const MAX_INGEST_CONTENT_BYTES = 200 * 1024;

/** Longest memory_ingest `source` label, in characters: it is stored on every fact and segment. */
export const MAX_SOURCE_LENGTH = 256;
/** How far in the future an `as_of` may lie (clock skew between caller and server). */
export const MAX_AS_OF_FUTURE_SKEW_MS = 5 * 60 * 1000;

/**
 * The highest importance a written memory gets. Importance ranks the "important"
 * half of every briefing and sets the decay half-life, and it comes from the agent
 * (or from an extraction model reading agent-supplied text), so an injected session
 * could otherwise pin a planted note at the top of every later briefing for good.
 * Values above the cap are stored as the cap.
 */
export const MAX_AGENT_IMPORTANCE = 0.8;

/**
 * The lowest importance a written memory gets. Importance 0 marks a memory that
 * maintenance decayed, which recall, store-time dedup and source expansion skip, so a
 * memory written with importance 0 is stored with this value instead (a half-life under
 * two days: unless it is recalled, it decays within about a week).
 */
export const MIN_STORED_IMPORTANCE = 0.01;

/** `importance` capped at {@link MAX_AGENT_IMPORTANCE} (undefined stays undefined). */
export function capImportance(importance: number): number;
export function capImportance(importance: number | undefined): number | undefined;
export function capImportance(importance: number | undefined): number | undefined {
  return importance === undefined ? undefined : Math.min(importance, MAX_AGENT_IMPORTANCE);
}

/**
 * Throw unless `asOf` is an epoch-ms time that is non-negative and at most
 * MAX_AS_OF_FUTURE_SKEW_MS ahead of `now`. A far-future timestamp would sort first in
 * every "recent" view, never decay, and (beyond the Date range) break date rendering.
 */
export function assertValidAsOf(asOf: number, now: number = Date.now()): void {
  if (!Number.isFinite(asOf) || asOf < 0) {
    throw new Error('as_of must resolve to a non-negative epoch-ms timestamp');
  }
  if (asOf > now + MAX_AS_OF_FUTURE_SKEW_MS) {
    throw new Error('as_of must not be more than 5 minutes in the future');
  }
}

/**
 * Throw unless an ingest's content and source label are within MAX_INGEST_CONTENT_BYTES
 * and MAX_SOURCE_LENGTH. Checked by the tool handler, and again by the engine before any
 * LLM call, for callers that use the engine directly.
 */
export function assertIngestSize(content: string, source: string | undefined): void {
  if (Buffer.byteLength(content, 'utf8') > MAX_INGEST_CONTENT_BYTES) {
    throw new Error(
      `content exceeds the maximum of ${MAX_INGEST_CONTENT_BYTES} bytes (200 KB) for one memory_ingest; ` +
        'split it into smaller ingests',
    );
  }
  if (source !== undefined && source.length > MAX_SOURCE_LENGTH) {
    throw new Error(`source exceeds maximum length of ${MAX_SOURCE_LENGTH} characters`);
  }
}

/**
 * Validate and return a tags array, or undefined if not provided.
 */
export function validateTags(tags: unknown): string[] | undefined {
  if (tags === undefined) return undefined;
  if (!Array.isArray(tags) || !tags.every((t) => typeof t === 'string')) {
    throw new Error('tags must be an array of strings');
  }
  if (tags.length > MAX_TAGS) {
    throw new Error(`tags array exceeds maximum of ${MAX_TAGS} items`);
  }
  if (tags.some((t: string) => t.length > MAX_TAG_LENGTH)) {
    throw new Error(`each tag must be at most ${MAX_TAG_LENGTH} characters`);
  }
  return tags;
}

/**
 * Validate and return an IDs array, or undefined if not provided.
 */
export function validateIds(ids: unknown): string[] | undefined {
  if (ids === undefined) return undefined;
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
    throw new Error('ids must be an array of strings');
  }
  if (ids.length > MAX_IDS) {
    throw new Error(`ids array exceeds maximum of ${MAX_IDS} items`);
  }
  return ids;
}

/**
 * Validate and return a token budget, or undefined if not provided.
 */
export function validateTokenBudget(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error('token_budget must be a positive integer');
  }
  if (value > MAX_TOKEN_BUDGET) {
    throw new Error(`token_budget exceeds maximum of ${MAX_TOKEN_BUDGET}`);
  }
  return value;
}

/**
 * Validate and return a passage count (recall's `max_expand_passages`, memory_expand's
 * `max_passages`: an integer from 1 to MAX_EXPAND_PASSAGES), or undefined if not
 * provided. `name` is the argument's name, for the error message.
 */
export function validateMaxExpandPassages(value: unknown, name = 'max_expand_passages'): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  if (value > MAX_EXPAND_PASSAGES) {
    throw new Error(`${name} exceeds maximum of ${MAX_EXPAND_PASSAGES}`);
  }
  return value;
}
