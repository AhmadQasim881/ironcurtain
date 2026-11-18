/**
 * memory_recall tool handler.
 * Validates input and delegates to the engine.
 *
 * Recalled memories are framed as notes from earlier sessions, data and not
 * instructions (utils/framing.ts), in every format: the text formats are wrapped
 * in the notes frame, and `raw` returns `{ notice, memories }` so it stays JSON.
 */

import type { CallControls, MemoryEngine } from '../engine.js';
import type { ExpandMode } from '../types.js';
import { FORMAT_MODES, type FormatMode } from '../retrieval/formatting.js';
import { MAX_QUERY_LENGTH, validateTokenBudget, validateTags, validateMaxExpandPassages } from './validation.js';
import { MEMORY_NOTES_NOTICE, frameMemoryNotes } from '../utils/framing.js';

export interface RecallInput {
  query: string;
  token_budget?: number;
  tags?: string[];
  format?: FormatMode;
  expand: ExpandMode;
  max_expand_passages?: number;
}

const VALID_FORMATS: ReadonlySet<string> = new Set(FORMAT_MODES);
const EXPAND_MODES: readonly ExpandMode[] = ['none', 'auto', 'parent'];
const VALID_EXPAND_MODES: ReadonlySet<string> = new Set(EXPAND_MODES);

export function validateRecallInput(args: Record<string, unknown>): RecallInput {
  const query = args.query;
  if (typeof query !== 'string' || query.trim().length === 0) {
    throw new Error('query is required and must be a non-empty string');
  }
  if (query.length > MAX_QUERY_LENGTH) {
    throw new Error(`query exceeds maximum length of ${MAX_QUERY_LENGTH} characters`);
  }

  const tokenBudget = validateTokenBudget(args.token_budget);
  const tags = validateTags(args.tags);

  const format = args.format;
  if (format !== undefined) {
    if (typeof format !== 'string' || !VALID_FORMATS.has(format)) {
      throw new Error(`format must be one of: ${FORMAT_MODES.map((f) => `'${f}'`).join(', ')}`);
    }
  }

  const expandArg = args.expand;
  if (expandArg !== undefined && (typeof expandArg !== 'string' || !VALID_EXPAND_MODES.has(expandArg))) {
    throw new Error(`expand must be one of: ${EXPAND_MODES.map((m) => `'${m}'`).join(', ')}`);
  }
  const expand = (expandArg as ExpandMode | undefined) ?? 'auto';

  const maxExpandPassages = validateMaxExpandPassages(args.max_expand_passages);

  return {
    query: query.trim(),
    token_budget: tokenBudget,
    tags,
    format: format as RecallInput['format'],
    expand,
    max_expand_passages: maxExpandPassages,
  };
}

/**
 * Structured result of a `memory_recall` call. `text` is the human-readable
 * payload; the remaining fields are the recall metadata an agent needs to drive
 * the `memory_expand` follow-up loop: which segments were auto-expanded, and the
 * source segment of every recalled fact (the text names them too, as
 * `[src:<id>]` markers).
 */
export interface RecallToolResult {
  text: string;
  memories_used: number;
  total_matches: number;
  expanded: boolean;
  expanded_segment_ids: string[];
  source_segment_ids: string[];
}

/**
 * The recall text in its frame. `raw` output is a JSON array; it becomes
 * `{ "notice": ..., "memories": [...] }` so a JSON reader still gets JSON and a
 * model reads the notice first. Anything else (and raw text that is not a JSON
 * array) is wrapped in the notes frame.
 */
function frameRecallText(content: string, format: FormatMode | undefined): string {
  if (format === 'raw') {
    let memories: unknown;
    try {
      memories = JSON.parse(content);
    } catch {
      memories = undefined;
    }
    if (Array.isArray(memories)) return JSON.stringify({ notice: MEMORY_NOTES_NOTICE, memories }, null, 2);
  }
  return frameMemoryNotes(content);
}

export async function handleRecall(
  engine: MemoryEngine,
  args: Record<string, unknown>,
  controls?: CallControls,
): Promise<RecallToolResult> {
  const input = validateRecallInput(args);
  const result = await engine.recall(
    {
      query: input.query,
      token_budget: input.token_budget,
      tags: input.tags,
      format: input.format,
      expand: input.expand,
      max_expand_passages: input.max_expand_passages,
    },
    controls,
  );

  const text =
    result.memories_used === 0 ? 'No relevant memories found.' : frameRecallText(result.content, input.format);

  return {
    text,
    memories_used: result.memories_used,
    total_matches: result.total_matches,
    expanded: result.expanded ?? false,
    expanded_segment_ids: result.expanded_segment_ids ?? [],
    source_segment_ids: result.memories_used === 0 ? [] : (result.source_segment_ids ?? []),
  };
}
