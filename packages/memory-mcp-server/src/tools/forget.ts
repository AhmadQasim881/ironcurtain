/**
 * memory_forget tool handler.
 * Validates input, enforces the confirm requirement for bulk criteria,
 * and delegates to the engine.
 *
 * Semantics (see engine-impl.ts forgetMemories): every supplied criterion must match
 * (ids AND tags AND before AND query), so adding a criterion narrows a deletion. A
 * dry run deletes nothing and needs no confirm. Deleting with any bulk criterion
 * (tags, query or before) needs confirm=true even when ids are also given; ids alone
 * do not. Before a bulk deletion, and before the first deletion of a server run,
 * removes anything, the engine writes a snapshot of the database (see
 * storage/database.ts); the reply names it.
 *
 * A dry-run preview shows stored text, so it is framed as notes: data, not
 * instructions (utils/framing.ts).
 */

import { basename } from 'node:path';
import type { MemoryEngine } from '../engine.js';
import { MAX_QUERY_LENGTH, validateIds, validateTags } from './validation.js';
import { frameMemoryNotes } from '../utils/framing.js';

export interface ForgetInput {
  ids?: string[];
  tags?: string[];
  query?: string;
  before?: string;
  confirm?: boolean;
  dry_run?: boolean;
}

export function validateForgetInput(args: Record<string, unknown>): ForgetInput {
  // Empty arrays count as "not provided" (no constraint), consistently with the engine.
  const ids = nonEmpty(validateIds(args.ids));
  const tags = nonEmpty(validateTags(args.tags));

  const query = args.query;
  if (query !== undefined && typeof query !== 'string') {
    throw new Error('query must be a string');
  }
  if (typeof query === 'string' && query.length > MAX_QUERY_LENGTH) {
    throw new Error(`query exceeds maximum length of ${MAX_QUERY_LENGTH} characters`);
  }
  // A supplied query is a criterion; silently dropping a blank one would widen the
  // selection the other criteria describe.
  if (typeof query === 'string' && query.trim().length === 0) {
    throw new Error('query must be a non-empty string');
  }

  const before = args.before;
  if (before !== undefined) {
    if (typeof before !== 'string') {
      throw new Error('before must be an ISO 8601 timestamp string');
    }
    const parsed = Date.parse(before);
    if (isNaN(parsed)) {
      throw new Error('before must be a valid ISO 8601 timestamp');
    }
  }

  const confirm = args.confirm;
  if (confirm !== undefined && typeof confirm !== 'boolean') {
    throw new Error('confirm must be a boolean');
  }

  const dryRun = args.dry_run;
  if (dryRun !== undefined && typeof dryRun !== 'boolean') {
    throw new Error('dry_run must be a boolean');
  }

  if (!ids && !tags && query === undefined && before === undefined) {
    throw new Error('At least one of ids, tags, query, or before must be specified');
  }

  return {
    ids,
    tags,
    query: typeof query === 'string' ? query.trim() : undefined,
    before: before,
    confirm: confirm,
    dry_run: dryRun,
  };
}

function nonEmpty(values: string[] | undefined): string[] | undefined {
  return values !== undefined && values.length > 0 ? values : undefined;
}

/** True when the input selects by tags, query or before (anything beyond explicit ids). */
function hasBulkCriterion(input: ForgetInput): boolean {
  return input.tags !== undefined || input.query !== undefined || input.before !== undefined;
}

function requiresConfirmation(input: ForgetInput): boolean {
  // A dry run only previews. A real deletion by any bulk criterion needs confirm=true,
  // even when ids are also given; explicit ids alone are targeted enough.
  if (input.dry_run === true) return false;
  return hasBulkCriterion(input) && input.confirm !== true;
}

export async function handleForget(engine: MemoryEngine, args: Record<string, unknown>): Promise<string> {
  const input = validateForgetInput(args);

  if (requiresConfirmation(input)) {
    return (
      'Deleting by tags, query or before requires confirm=true. ' +
      'Use dry_run=true first to preview what would be forgotten.'
    );
  }

  const result = await engine.forget({
    ids: input.ids,
    tags: input.tags,
    query: input.query,
    before: input.before,
    confirm: input.confirm,
    dry_run: input.dry_run,
  });

  const truncatedNote = result.truncated
    ? ' (results were truncated — more memories match; run again to continue)'
    : '';

  if (input.dry_run) {
    if (!result.memories || result.memories.length === 0) {
      return 'No memories match the criteria.';
    }
    const preview = result.memories.map((m) => `- ${m.id}: ${m.content.slice(0, 100)}`).join('\n');
    return `Would forget ${result.forgotten} memories${truncatedNote}:\n${frameMemoryNotes(preview)}`;
  }

  const snapshotNote =
    result.snapshot === undefined
      ? ''
      : ` A snapshot of the memory database from before this deletion was saved as ${basename(result.snapshot)} ` +
        'next to the database.';
  return `Forgot ${result.forgotten} memories.${truncatedNote}${snapshotNote}`;
}
