/**
 * Groups of pending escalations that share one whitelist pattern.
 *
 * Escalations whose first whitelist candidate -- the exact pattern
 * `/approve+` selects (`WhitelistCandidateIpc.patternKey`) -- is the same
 * pattern are the same kind of call on the same resources -- "write
 * /home/u/project/src/a.ts", "push to github.com/owner/repo" -- from one
 * session or several. A front-end shows them as a group and offers "approve
 * group": each member is approved once, and only after a confirmation that
 * lists every member. The approval names exactly the members that were
 * confirmed and is refused, with nothing resolved, when the group changed
 * since it was listed (a member arrived, expired or was resolved).
 *
 * Never grouped:
 * - a human-only escalation (`EscalationRequest.humanOnly`): it is approved
 *   on its own, never in bulk;
 * - an escalation whose first candidate carries no pattern key, or is not
 *   the exact one: no candidate means each such call is approved on its own
 *   (a structural per-call escalation, a history-rewriting role, an
 *   unresolvable destination), and a key is needed because candidate
 *   descriptions can be made to collide by agent-chosen path text.
 *
 * A directory-wide candidate (`scope: 'directory'`, `/approve+dir`) never
 * places an escalation in a group: widening to a directory is chosen one
 * escalation at a time, never in bulk, so calls on different files in one
 * directory are not grouped.
 */

/** The fields of an escalation request that decide its group. */
export interface GroupableEscalation {
  readonly humanOnly?: boolean;
  readonly whitelistCandidates?: readonly {
    readonly description: string;
    readonly patternKey?: string;
    readonly scope?: string;
  }[];
}

/** A group of at least two pending escalations sharing one pattern. */
export interface EscalationGroup<T> {
  /** The shared pattern key. */
  readonly key: string;
  /** The shared pattern's description (identical for every member). */
  readonly description: string;
  /** The members, in the order the caller listed them. */
  readonly members: readonly T[];
}

/**
 * The group an escalation belongs to: its first (exact) candidate's pattern
 * key, or undefined when it is never grouped (see the module comment).
 */
export function escalationGroupKey(request: GroupableEscalation): string | undefined {
  return escalationGroupPattern(request)?.patternKey;
}

/**
 * The pattern that places `request` in a group: the description and key of
 * its first candidate, the exact one `/approve+` selects. Undefined when it
 * is never grouped (see the module comment).
 */
export function escalationGroupPattern(
  request: GroupableEscalation,
): { readonly description: string; readonly patternKey: string } | undefined {
  if (request.humanOnly === true) return undefined;
  // Request files are parsed without a schema; tolerate anything (a
  // non-array, a null entry, a non-string key or description), never throw.
  const candidates: unknown = request.whitelistCandidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return undefined;
  const candidate: unknown = candidates[0];
  if (typeof candidate !== 'object' || candidate === null) return undefined;
  const { description, patternKey, scope } = candidate as {
    description?: unknown;
    patternKey?: unknown;
    scope?: unknown;
  };
  // The exact pattern carries `scope: 'exact'` (a request written before
  // scopes existed carries none); anything else is never grouped.
  if (scope !== undefined && scope !== 'exact') return undefined;
  if (typeof patternKey !== 'string' || patternKey.length === 0 || typeof description !== 'string') return undefined;
  return { description, patternKey };
}

/** The members of group `key` among `items`, in input order. */
export function groupMembers<T>(items: Iterable<T>, requestOf: (item: T) => GroupableEscalation, key: string): T[] {
  const members: T[] = [];
  for (const item of items) {
    if (escalationGroupKey(requestOf(item)) === key) members.push(item);
  }
  return members;
}

/**
 * Every group of at least two escalations among `items`: members in input
 * order, groups in the order of their first member. A lone escalation is not
 * a group.
 */
export function escalationGroups<T>(
  items: Iterable<T>,
  requestOf: (item: T) => GroupableEscalation,
): EscalationGroup<T>[] {
  const byKey = new Map<string, { description: string; members: T[] }>();
  for (const item of items) {
    const candidate = escalationGroupPattern(requestOf(item));
    if (candidate === undefined) continue;
    const existing = byKey.get(candidate.patternKey);
    if (existing) existing.members.push(item);
    else byKey.set(candidate.patternKey, { description: candidate.description, members: [item] });
  }
  return [...byKey]
    .filter(([, group]) => group.members.length >= 2)
    .map(([key, group]) => ({ key, description: group.description, members: group.members }));
}
