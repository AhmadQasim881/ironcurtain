/**
 * Per-tool policy for trusted servers.
 *
 * A trusted server (today only IronCurtain's own memory server, verified by its
 * exact command line in `buildTrustedServerSet`) has no tool annotations and no
 * compiled rules: its tools take no paths, URLs or other resources the policy
 * engine could judge. Trusting the server does not mean trusting every call to
 * it, though. Memory is shared by every session of a persona, including
 * unattended cron jobs and workflows, so a single injected session must not be
 * able to wipe it or bulk-load it without a human seeing the call:
 *
 *  - `memory_store`, `memory_recall`, `memory_context`, `memory_expand` and
 *    `memory_inspect` are allowed (`trusted-server`), as are `memory_forget`
 *    with `dry_run: true` or with only `ids` (at most
 *    {@link MEMORY_FORGET_ESCALATE_IDS} of them), and `memory_ingest` of up to
 *    {@link MEMORY_INGEST_ESCALATE_CHARS} characters;
 *  - `memory_forget` that deletes by `tags`, `query` or `before`, or names more
 *    than {@link MEMORY_FORGET_ESCALATE_IDS} ids (a bulk deletion), escalates, as
 *    does a larger `memory_ingest`. Both escalations are human-only: the
 *    auto-approver and the approval whitelist anchor on resource arguments, and
 *    these calls have none, so only a person reading the arguments can judge
 *    them;
 *  - any other tool on a trusted server is denied. A tool the server gains later
 *    is not trusted until it is classified here.
 *
 * The id bound matters because `memory_inspect` lists every id and a deletion by
 * ids needs no confirm: without it, one call could delete up to the server's
 * 100-id maximum and a handful of calls a whole namespace, with no human asked.
 * A run of small id deletions is still allowed call by call; the memory server
 * covers it by saving a snapshot before the first deletion of each server run
 * (see its storage/database.ts), as it does before every bulk deletion.
 *
 * The evaluation reads the raw arguments the server will receive (trusted
 * servers get the same arguments for policy and transport). It reads only own
 * properties, as JSON serialization sends only those to the server, and fails
 * towards escalation: any present bulk selector counts, whatever its value, an
 * `ids` that is not a short enough list counts, and only `dry_run: true` itself
 * makes a forget a preview.
 */

import type { ToolCallRequest } from '../types/mcp.js';
import type { EvaluationResult } from './policy-types.js';
import { ownArgument } from './argument-values.js';
import { MEMORY_SERVER_NAME } from '../memory/memory-server-name.js';
import { isPlainObject } from '../utils/is-plain-object.js';

/** Rule name of an allowed trusted-server call. */
export const TRUSTED_SERVER_RULE = 'trusted-server';

/**
 * Rule name of the escalation for a bulk `memory_forget` (by tags, query or before,
 * or by more than {@link MEMORY_FORGET_ESCALATE_IDS} ids).
 */
export const MEMORY_BULK_FORGET_RULE = 'memory-bulk-forget-escalate';

/** Rule name of the escalation for a `memory_ingest` larger than {@link MEMORY_INGEST_ESCALATE_CHARS}. */
export const MEMORY_LARGE_INGEST_RULE = 'memory-large-ingest-escalate';

/** Rule name of the denial of a tool a trusted server's policy does not classify. */
export const TRUSTED_SERVER_UNKNOWN_TOOL_RULE = 'trusted-server-unknown-tool';

/**
 * `memory_ingest` content longer than this escalates. It is the most a single
 * `memory_store` may hold, so a blob that one memory could not take (and that
 * would be split into many facts) needs a human.
 */
export const MEMORY_INGEST_ESCALATE_CHARS = 10_000;

/**
 * A `memory_forget` that names more ids than this escalates like a bulk selector
 * (see the module comment). It is as many as one query forget may delete.
 */
export const MEMORY_FORGET_ESCALATE_IDS = 10;

/** Memory tools that are always allowed: reads, and the single-fact write. */
const MEMORY_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  'memory_store',
  'memory_recall',
  'memory_context',
  'memory_expand',
  'memory_inspect',
]);

/** Every memory tool this policy classifies (the conditional ones included). */
export const CLASSIFIED_MEMORY_TOOLS: ReadonlySet<string> = new Set([
  ...MEMORY_ALLOWED_TOOLS,
  'memory_forget',
  'memory_ingest',
]);

const BULK_FORGET_SELECTORS = ['tags', 'query', 'before'] as const;

function allow(serverName: string): EvaluationResult {
  return { decision: 'allow', rule: TRUSTED_SERVER_RULE, reason: `Server "${serverName}" is trusted` };
}

/**
 * Why `memory_forget` is a bulk deletion, or undefined when it is not: never for a
 * preview (`dry_run: true`); otherwise for any bulk selector, and for an `ids` value
 * that is not a list of at most MEMORY_FORGET_ESCALATE_IDS entries. Arguments are
 * read as own properties only (`ownArgument`): an inherited property is never sent
 * to the server (JSON serialization drops it), so it must not decide the call.
 */
function bulkForgetReason(args: Record<string, unknown>): string | undefined {
  if (ownArgument(args, 'dry_run') === true) return undefined;
  const selected = BULK_FORGET_SELECTORS.some((selector) => {
    const value = ownArgument(args, selector);
    if (value === undefined) return false;
    // The server treats an empty tag list as no constraint.
    return !(selector === 'tags' && Array.isArray(value) && value.length === 0);
  });
  if (selected) return 'Deleting memories by tags, query or before is a bulk deletion';
  const ids = ownArgument(args, 'ids');
  if (ids !== undefined && !(Array.isArray(ids) && ids.length <= MEMORY_FORGET_ESCALATE_IDS)) {
    return `Deleting more than ${MEMORY_FORGET_ESCALATE_IDS} memories by id at once is a bulk deletion`;
  }
  return undefined;
}

/** True when `memory_ingest` content is not a string of at most the limit. */
function isLargeIngest(args: Record<string, unknown>): boolean {
  const content = ownArgument(args, 'content');
  return typeof content !== 'string' || content.length > MEMORY_INGEST_ESCALATE_CHARS;
}

function evaluateMemoryToolCall(toolName: string, args: Record<string, unknown>): EvaluationResult {
  if (MEMORY_ALLOWED_TOOLS.has(toolName)) return allow(MEMORY_SERVER_NAME);
  if (toolName === 'memory_forget') {
    const bulk = bulkForgetReason(args);
    if (bulk === undefined) return allow(MEMORY_SERVER_NAME);
    return {
      decision: 'escalate',
      rule: MEMORY_BULK_FORGET_RULE,
      reason: `${bulk} from the persistent memory that later sessions rely on, and requires human approval`,
      humanOnly: true,
    };
  }
  if (toolName === 'memory_ingest') {
    if (!isLargeIngest(args)) return allow(MEMORY_SERVER_NAME);
    return {
      decision: 'escalate',
      rule: MEMORY_LARGE_INGEST_RULE,
      reason:
        `Ingesting more than ${MEMORY_INGEST_ESCALATE_CHARS} characters into the persistent memory ` +
        'that later sessions rely on requires human approval',
      humanOnly: true,
    };
  }
  return {
    decision: 'deny',
    rule: TRUSTED_SERVER_UNKNOWN_TOOL_RULE,
    reason: `Tool "${toolName}" is not a known tool of the trusted server "${MEMORY_SERVER_NAME}"`,
  };
}

/**
 * The decision for a call to a trusted server. Only the memory server has a
 * trusted-server policy; a call to any other server marked trusted is denied.
 */
export function evaluateTrustedServerCall(request: ToolCallRequest): EvaluationResult {
  if (request.serverName === MEMORY_SERVER_NAME) {
    // A caller that sends no arguments object is judged as sending none.
    const args: unknown = request.arguments;
    return evaluateMemoryToolCall(request.toolName, isPlainObject(args) ? args : {});
  }
  return {
    decision: 'deny',
    rule: TRUSTED_SERVER_UNKNOWN_TOOL_RULE,
    reason: `Server "${request.serverName}" has no trusted-server policy`,
  };
}
