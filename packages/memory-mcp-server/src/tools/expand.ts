/**
 * memory_expand tool handler.
 *
 * The agentic follow-up affordance (§9.4): given a `segment_id` surfaced by a prior
 * recall or briefing (the id in a `[src:<id>]` marker, which is accepted whole too;
 * one of `source_segment_ids` / `expanded_segment_ids`; or a `raw` unit's
 * `segment_id`), return passages of that source segment — the "I got a headline,
 * give me THIS fact's parent" call. With a `query`, the passages most relevant to it,
 * best first; without one, the first passages in source order. At most `max_passages`
 * (default DEFAULT_EXPAND_PASSAGES) either way, followed by a line that says which of
 * the source's passages were shown, so a partial view never passes for the whole
 * source. Validates input and delegates to `engine.expand`. The passages are stored
 * text from earlier sessions, so they are framed as notes: data, not instructions
 * (utils/framing.ts).
 */

import type { MemoryEngine } from '../engine.js';
import { MAX_EXPAND_PASSAGES, MAX_QUERY_LENGTH, validateMaxExpandPassages } from './validation.js';
import { frameMemoryNotes } from '../utils/framing.js';
import { segmentIdFromMarker } from '../utils/source-markers.js';

export interface ExpandInput {
  segment_id: string;
  /** What to rank the passages by; absent (a blank query too) for the start of the source. */
  query?: string;
  /** How many passages to return (1 to MAX_EXPAND_PASSAGES); absent for the default. */
  max_passages?: number;
}

export function validateExpandInput(args: Record<string, unknown>): ExpandInput {
  const segmentId = args.segment_id;
  if (typeof segmentId !== 'string' || segmentId.trim().length === 0) {
    throw new Error('segment_id is required and must be a non-empty string');
  }

  const query = args.query;
  if (query !== undefined) {
    if (typeof query !== 'string') {
      throw new Error('query must be a string');
    }
    if (query.length > MAX_QUERY_LENGTH) {
      throw new Error(`query exceeds maximum length of ${MAX_QUERY_LENGTH} characters`);
    }
  }
  const maxPassages = validateMaxExpandPassages(args.max_passages, 'max_passages');

  const id = segmentIdFromMarker(segmentId);
  if (id.length === 0) {
    throw new Error('segment_id is required and must be a non-empty string');
  }
  const trimmedQuery = query?.trim();
  return {
    segment_id: id,
    // A blank query ranks by nothing: it reads the start of the source, like no query.
    query: trimmedQuery === undefined || trimmedQuery.length === 0 ? undefined : trimmedQuery,
    max_passages: maxPassages,
  };
}

/**
 * The line after the passages: which of the source's passages they are, in what order,
 * and how to get others. For example `[passages 1-3 of 20 of this source, in source
 * order; pass a query ...]`. It is the server's own note, so it follows the notes
 * frame instead of sitting in it (stored text cannot fake it: the frame cannot be
 * closed from inside).
 */
export function passageRangeNote(shown: number, total: number, ranked: boolean): string {
  const range = shown === 1 ? 'passage 1' : `passages 1-${shown}`;
  const order = ranked ? 'most relevant to the query first' : 'in source order';
  if (shown >= total) return `[${range} of ${total}: the whole source, ${order}]`;

  const hints: string[] = [];
  if (!ranked) hints.push('pass a query to get the passages most relevant to it');
  if (shown < MAX_EXPAND_PASSAGES) {
    hints.push(`raise max_passages (at most ${MAX_EXPAND_PASSAGES}) to ${ranked ? 'see more' : 'read further'}`);
  }
  const advice = hints.length > 0 ? `; ${hints.join(', or ')}` : '';
  return `[${range} of ${total} of this source, ${order}${advice}]`;
}

export async function handleExpand(engine: MemoryEngine, args: Record<string, unknown>): Promise<string> {
  const input = validateExpandInput(args);
  const result = await engine.expand(input.segment_id, input.query, input.max_passages);

  if (!result.found) {
    return `No source segment found for id ${input.segment_id}.`;
  }
  if (result.passages.length === 0) {
    return `Source segment ${input.segment_id} has no expandable content.`;
  }

  const note = passageRangeNote(result.passages.length, result.total_passages, input.query !== undefined);
  return `${frameMemoryNotes(result.passages.join('\n\n---\n\n'))}\n${note}`;
}
