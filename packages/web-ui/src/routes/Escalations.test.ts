/**
 * The Escalations page lists every pending escalation as a card. Resolving a
 * card moves the ones below it up under the pointer, so a card takes clicks
 * only once it has been in its place for the arming delay: the second click
 * of a double click on Approve must not approve the escalation that moved
 * into the approved one's place.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import type { PendingEscalation } from '$lib/types.js';
import { ESCALATION_ARM_DELAY_MS } from '$lib/components/features/escalation-modal.svelte';
import { testEscalationsAppState } from './__test_state__.svelte.js';
import Escalations from './Escalations.svelte';

const { mockResolveEscalation } = vi.hoisted(() => ({
  mockResolveEscalation: vi.fn<(id: string, decision: 'approved' | 'denied', whitelist?: number) => Promise<void>>(),
}));

vi.mock('../lib/stores.svelte.js', async () => {
  const { testEscalationsAppState } = await import('./__test_state__.svelte.js');
  return {
    appState: testEscalationsAppState,
    resolveEscalation: (...args: [string, 'approved' | 'denied', number | undefined]) => mockResolveEscalation(...args),
  };
});

function escalation(id: string, displayNumber: number): PendingEscalation {
  return {
    escalationId: id,
    sessionLabel: 1,
    sessionSource: { kind: 'web-pty' },
    toolName: 'write_file',
    serverName: 'filesystem',
    arguments: { path: `/etc/${id}` },
    reason: 'Write to protected system path',
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

const approveButtons = (): HTMLElement[] => screen.getAllByTestId('escalation-approve');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  mockResolveEscalation.mockReset();
  mockResolveEscalation.mockResolvedValue(undefined);
  setPending([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Escalations page: cards are armed only once they have settled in place', () => {
  it('ignores clicks on a card that has just appeared', async () => {
    setPending([escalation('e1', 1)]);
    render(Escalations);
    await tick();

    await fireEvent.click(approveButtons()[0]);
    expect(approveButtons()[0].getAttribute('aria-disabled')).toBe('true');
    await elapse(ESCALATION_ARM_DELAY_MS - 1);
    await fireEvent.click(approveButtons()[0]);
    expect(mockResolveEscalation).not.toHaveBeenCalled();

    await elapse(1);
    await fireEvent.click(approveButtons()[0]);
    expect(mockResolveEscalation).toHaveBeenCalledWith('e1', 'approved', undefined);
  });

  it('does not let the second click of a double click approve the card that moved up', async () => {
    setPending([escalation('e1', 1), escalation('e2', 2)]);
    render(Escalations);
    await elapse(ESCALATION_ARM_DELAY_MS);

    await fireEvent.click(approveButtons()[0]);
    expect(mockResolveEscalation).toHaveBeenCalledTimes(1);
    expect(mockResolveEscalation).toHaveBeenLastCalledWith('e1', 'approved', undefined);

    // escalation.resolved removes e1; e2 moves into its place.
    setPending([escalation('e2', 2)]);
    await tick();
    expect(approveButtons()).toHaveLength(1);
    await fireEvent.click(approveButtons()[0]);
    expect(mockResolveEscalation).toHaveBeenCalledTimes(1);

    await elapse(ESCALATION_ARM_DELAY_MS);
    await fireEvent.click(approveButtons()[0]);
    expect(mockResolveEscalation).toHaveBeenLastCalledWith('e2', 'approved', undefined);
  });

  it('keeps cards that did not move armed when a new escalation is appended', async () => {
    setPending([escalation('e1', 1)]);
    render(Escalations);
    await elapse(ESCALATION_ARM_DELAY_MS);

    setPending([escalation('e1', 1), escalation('e2', 2)]);
    await tick();
    const [first, second] = approveButtons();
    expect(first.hasAttribute('aria-disabled')).toBe(false);
    expect(second.getAttribute('aria-disabled')).toBe('true');

    await fireEvent.click(second);
    expect(mockResolveEscalation).not.toHaveBeenCalled();
    await fireEvent.click(first);
    expect(mockResolveEscalation).toHaveBeenCalledWith('e1', 'approved', undefined);
  });
});
