/**
 * Group approval on the Escalations page. Pending escalations sharing one
 * whitelist pattern (same `groupKey`) are offered as a group, but approving
 * the group takes a confirmation that lists every member: nothing is sent
 * until the user confirms, Approve is inert for the arming delay, the call
 * names exactly the members listed, and a group that changed while the list
 * was open cannot be approved from it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import type { PendingEscalation } from '$lib/types.js';
import { ESCALATION_ARM_DELAY_MS } from '$lib/components/features/escalation-modal.svelte';
import { testEscalationsAppState } from './__test_state__.svelte.js';
import Escalations from './Escalations.svelte';

const { mockApproveGroup, mockResolveEscalation } = vi.hoisted(() => ({
  mockApproveGroup:
    vi.fn<(key: string, ids: readonly string[]) => Promise<{ approved: string[]; failed: unknown[] }>>(),
  mockResolveEscalation: vi.fn(),
}));

vi.mock('../lib/stores.svelte.js', async () => {
  const { testEscalationsAppState } = await import('./__test_state__.svelte.js');
  return {
    appState: testEscalationsAppState,
    resolveEscalation: mockResolveEscalation,
    approveEscalationGroup: (key: string, ids: readonly string[]) => mockApproveGroup(key, ids),
  };
});

const SRC_KEY = '["filesystem","write_file",[["directory","write-path","/work/src"]]]';

function escalation(
  id: string,
  displayNumber: number,
  groupKey?: string,
  sessionLabel = displayNumber,
): PendingEscalation {
  return {
    escalationId: id,
    sessionLabel,
    sessionSource: { kind: 'web-pty' },
    toolName: 'write_file',
    serverName: 'filesystem',
    arguments: { path: `/work/src/${id}.ts` },
    reason: 'Write outside the sandbox',
    whitelistCandidates: [{ description: 'Allow filesystem/write_file write-path within /work/src' }],
    ...(groupKey !== undefined ? { groupKey } : {}),
    agentJustification: `justification for ${id}`,
    receivedAt: '2026-01-01T00:00:00.000Z',
    displayNumber,
  };
}

function setPending(items: PendingEscalation[]): void {
  testEscalationsAppState.pendingEscalations = new Map(items.map((item) => [item.escalationId, item]));
}

async function elapse(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await tick();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  mockApproveGroup.mockReset();
  mockApproveGroup.mockResolvedValue({ approved: [], failed: [] });
  mockResolveEscalation.mockReset();
  setPending([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Escalations page: approving a group takes a confirmation', () => {
  it('offers a group only for two or more escalations sharing a pattern', async () => {
    setPending([escalation('a', 1, SRC_KEY), escalation('b', 2), escalation('c', 3, SRC_KEY)]);
    render(Escalations);
    await tick();

    const groups = screen.getAllByTestId('escalation-group');
    expect(groups).toHaveLength(1);
    expect(groups[0].textContent).toContain('2 pending escalations share one pattern');
    expect(groups[0].textContent).toContain('Allow filesystem/write_file write-path within /work/src');

    setPending([escalation('a', 1, SRC_KEY), escalation('b', 2)]);
    await tick();
    expect(screen.queryByTestId('escalation-group')).toBeNull();
  });

  it('lists every member and approves exactly them only after an armed confirmation', async () => {
    setPending([escalation('a', 1, SRC_KEY), escalation('b', 2), escalation('c', 3, SRC_KEY)]);
    render(Escalations);
    await tick();

    await fireEvent.click(screen.getByTestId('escalation-group-review'));
    await tick();
    expect(mockApproveGroup).not.toHaveBeenCalled();

    const members = screen.getAllByTestId('escalation-group-member');
    expect(members).toHaveLength(2);
    expect(members[0].textContent).toContain('/work/src/a.ts');
    expect(members[1].textContent).toContain('/work/src/c.ts');
    expect(members[0].textContent).toContain('justification for a');

    // Inert during the arming delay: a double click on "Review group" cannot approve.
    const approve = screen.getByTestId('escalation-group-approve');
    expect(approve.getAttribute('aria-disabled')).toBe('true');
    await fireEvent.click(approve);
    expect(mockApproveGroup).not.toHaveBeenCalled();

    await elapse(ESCALATION_ARM_DELAY_MS);
    expect(screen.getByTestId('escalation-group-approve').hasAttribute('aria-disabled')).toBe(false);
    await fireEvent.click(screen.getByTestId('escalation-group-approve'));
    expect(mockApproveGroup).toHaveBeenCalledTimes(1);
    expect(mockApproveGroup).toHaveBeenCalledWith(SRC_KEY, ['a', 'c']);
    // Nothing was resolved one by one.
    expect(mockResolveEscalation).not.toHaveBeenCalled();
  });

  it('a press that began before arming does not approve', async () => {
    setPending([escalation('a', 1, SRC_KEY), escalation('c', 3, SRC_KEY)]);
    render(Escalations);
    await tick();
    await fireEvent.click(screen.getByTestId('escalation-group-review'));
    await tick();

    const approve = screen.getByTestId('escalation-group-approve');
    await fireEvent.pointerDown(approve);
    await elapse(ESCALATION_ARM_DELAY_MS);
    await fireEvent.click(screen.getByTestId('escalation-group-approve'));
    expect(mockApproveGroup).not.toHaveBeenCalled();
  });

  it('cannot approve from a list whose group changed while it was open', async () => {
    setPending([escalation('a', 1, SRC_KEY), escalation('c', 3, SRC_KEY)]);
    render(Escalations);
    await tick();
    await fireEvent.click(screen.getByTestId('escalation-group-review'));
    await elapse(ESCALATION_ARM_DELAY_MS);

    // A new member arrives while the confirmation is open.
    setPending([escalation('a', 1, SRC_KEY), escalation('c', 3, SRC_KEY), escalation('d', 4, SRC_KEY)]);
    await tick();

    expect(screen.getByTestId('escalation-group-changed')).toBeTruthy();
    const approve = screen.getByTestId('escalation-group-approve');
    expect(approve.getAttribute('aria-disabled')).toBe('true');
    await fireEvent.click(approve);
    expect(mockApproveGroup).not.toHaveBeenCalled();
  });

  it('a group banner that comes or goes disarms the cards it moved', async () => {
    const firstApprove = (): HTMLElement => screen.getAllByTestId('escalation-approve')[0];
    setPending([escalation('a', 1, SRC_KEY), escalation('c', 2), escalation('b', 3, SRC_KEY)]);
    render(Escalations);
    await elapse(ESCALATION_ARM_DELAY_MS);
    expect(screen.getAllByTestId('escalation-group')).toHaveLength(1);
    expect(firstApprove().hasAttribute('aria-disabled')).toBe(false);

    // b expires (or is decided elsewhere): the group dissolves and its
    // banner goes, so the first card moves up into the banner's place (under
    // a pointer aimed at "Review group") while keeping its index.
    setPending([escalation('a', 1, SRC_KEY), escalation('c', 2)]);
    await tick();
    expect(screen.queryByTestId('escalation-group')).toBeNull();
    expect(firstApprove().getAttribute('aria-disabled')).toBe('true');
    await fireEvent.click(firstApprove());
    expect(mockResolveEscalation).not.toHaveBeenCalled();

    await elapse(ESCALATION_ARM_DELAY_MS);
    expect(firstApprove().hasAttribute('aria-disabled')).toBe(false);

    // A group forming pushes every card down: they wait again too.
    setPending([escalation('a', 1, SRC_KEY), escalation('c', 2), escalation('d', 4, SRC_KEY)]);
    await tick();
    expect(screen.getAllByTestId('escalation-group')).toHaveLength(1);
    expect(firstApprove().getAttribute('aria-disabled')).toBe('true');

    await elapse(ESCALATION_ARM_DELAY_MS);
    await fireEvent.click(firstApprove());
    expect(mockResolveEscalation).toHaveBeenCalledWith('a', 'approved', undefined);
  });

  it('Cancel closes the list and approves nothing', async () => {
    setPending([escalation('a', 1, SRC_KEY), escalation('c', 3, SRC_KEY)]);
    render(Escalations);
    await tick();
    await fireEvent.click(screen.getByTestId('escalation-group-review'));
    await elapse(ESCALATION_ARM_DELAY_MS);

    await fireEvent.click(screen.getByTestId('escalation-group-cancel'));
    await tick();
    expect(screen.queryByTestId('escalation-group-confirm')).toBeNull();
    expect(mockApproveGroup).not.toHaveBeenCalled();
  });
});
