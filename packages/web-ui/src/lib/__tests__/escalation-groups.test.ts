import { describe, it, expect } from 'vitest';
import { groupMembersOf, groupPendingEscalations, sameEscalationIds } from '../escalation-groups.js';
import type { PendingEscalation } from '../types.js';

function pending(id: string, displayNumber: number, groupKey?: string): PendingEscalation {
  return {
    escalationId: id,
    sessionLabel: 1,
    sessionSource: { kind: 'web' },
    toolName: 'write_file',
    serverName: 'filesystem',
    arguments: {},
    reason: 'r',
    whitelistCandidates: [{ description: `pattern ${groupKey ?? 'none'}` }],
    ...(groupKey !== undefined ? { groupKey } : {}),
    receivedAt: '2026-01-01T00:00:00.000Z',
    displayNumber,
  };
}

describe('escalation groups', () => {
  it('groups two or more escalations by key, in display-number order', () => {
    const groups = groupPendingEscalations([
      pending('c', 3, 'k1'),
      pending('a', 1, 'k1'),
      pending('b', 2, 'k2'),
      pending('d', 4),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('k1');
    expect(groups[0].description).toBe('pattern k1');
    expect(groups[0].members.map((m) => m.escalationId)).toEqual(['a', 'c']);
    expect(groupMembersOf([pending('c', 3, 'k1'), pending('a', 1, 'k1')], 'k1').map((m) => m.escalationId)).toEqual([
      'a',
      'c',
    ]);
  });

  it('compares id lists as sets; a repeated id matches nothing', () => {
    expect(sameEscalationIds(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(sameEscalationIds(['a', 'b'], ['a'])).toBe(false);
    expect(sameEscalationIds(['a', 'a'], ['a', 'b'])).toBe(false);
  });
});
