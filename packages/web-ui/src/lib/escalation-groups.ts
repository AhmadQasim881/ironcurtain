/**
 * Groups of pending escalations that share one whitelist pattern.
 *
 * The daemon stamps each groupable escalation with the key of its first
 * whitelist candidate's pattern, the exact one `/approve+` selects
 * (`EscalationDto.groupKey`; see `src/escalation/escalation-groups.ts`):
 * human-only escalations and those without a pattern have none and never
 * group. Escalations with the same key
 * are the same kind of call on the same resources, so the Escalations page
 * offers to approve them together, after a confirmation that lists every
 * member (`escalations.approveGroup`, which the daemon refuses unless the ids
 * are still exactly the group).
 */

import type { PendingEscalation } from './types.js';

export interface PendingEscalationGroup {
  readonly key: string;
  /** The shared pattern's description, as the members' whitelist candidate gives it. */
  readonly description: string;
  /** The members, in display-number order. */
  readonly members: readonly PendingEscalation[];
}

/** Every group of at least two pending escalations, groups in the order of their first member. */
export function groupPendingEscalations(pending: Iterable<PendingEscalation>): PendingEscalationGroup[] {
  const byKey = new Map<string, PendingEscalation[]>();
  const sorted = [...pending].sort((a, b) => a.displayNumber - b.displayNumber);
  for (const esc of sorted) {
    if (esc.groupKey === undefined || esc.groupKey === '') continue;
    const members = byKey.get(esc.groupKey);
    if (members) members.push(esc);
    else byKey.set(esc.groupKey, [esc]);
  }
  const groups: PendingEscalationGroup[] = [];
  for (const [key, members] of byKey) {
    if (members.length < 2) continue;
    groups.push({ key, description: members[0].whitelistCandidates?.[0]?.description ?? '', members });
  }
  return groups;
}

/** The pending members of group `key`, in display-number order. */
export function groupMembersOf(pending: Iterable<PendingEscalation>, key: string): PendingEscalation[] {
  return [...pending].filter((esc) => esc.groupKey === key).sort((a, b) => a.displayNumber - b.displayNumber);
}

/** Whether two id lists name the same escalations, in any order (a repeated id matches nothing). */
export function sameEscalationIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  const setB = new Set(b);
  return setA.size === a.length && setB.size === b.length && b.every((id) => setA.has(id));
}
