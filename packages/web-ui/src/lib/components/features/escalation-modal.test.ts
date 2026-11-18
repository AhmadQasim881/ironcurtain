import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import EscalationModal, { ESCALATION_ARM_DELAY_MS } from './escalation-modal.svelte';
import type { PendingEscalation } from '$lib/types.js';

function makeEscalation(id: string, displayNumber: number): PendingEscalation {
  return {
    escalationId: id,
    sessionLabel: 3,
    sessionSource: { kind: 'web-pty' },
    toolName: 'write_file',
    serverName: 'filesystem',
    arguments: { path: '/etc/hosts' },
    reason: 'Protected path',
    receivedAt: '2026-01-01T00:00:00.000Z',
    displayNumber,
  };
}

function props(overrides: Record<string, unknown> = {}) {
  return {
    open: true,
    escalations: new Map([['esc-1', makeEscalation('esc-1', 1)]]),
    onclose: vi.fn(),
    onresolve: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    onviewsession: vi.fn(),
    ...overrides,
  };
}

// Approve and Deny act only once the escalation on screen has been visible for
// the arming delay (see escalation-modal.svelte). These tests are about what
// happens after a decision was sent, so they let the delay pass first; timers
// are faked so that costs no real time.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
});

async function waitUntilArmed(): Promise<void> {
  await vi.advanceTimersByTimeAsync(ESCALATION_ARM_DELAY_MS);
  await tick();
  expect(screen.getByTestId('escalation-dialog-body').dataset.armed).toBe('true');
}

/** A real mouse click: the press, then the click it produces. */
async function click(element: HTMLElement): Promise<void> {
  await fireEvent.pointerDown(element);
  await fireEvent.mouseDown(element);
  await fireEvent.pointerUp(element);
  await fireEvent.mouseUp(element);
  await fireEvent.click(element);
}

// WEB-10: the card fires onapprove/ondeny without awaiting, so a rejected
// resolve (ESCALATION_EXPIRED after the proxy timed out, ESCALATION_NOT_FOUND,
// a dropped connection) used to surface only as an unhandled rejection.
describe('EscalationModal resolve errors', () => {
  it('shows a failed approve inside the modal and leaves the card usable', async () => {
    const onresolve = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error('Escalation esc-1 expired before the response arrived; the tool call was denied'));
    render(EscalationModal, { props: props({ onresolve }) });
    await waitUntilArmed();

    await click(screen.getByRole('button', { name: 'Approve' }));

    const alert = await screen.findByTestId('escalation-resolve-error');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toContain('Failed to approve');
    expect(alert.textContent).toContain('expired');
    expect(onresolve).toHaveBeenCalledWith('esc-1', 'approved', undefined);
    // Not stuck in the loading state.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toHaveProperty('disabled', false));
  });

  it('names the decision for a failed deny', async () => {
    const onresolve = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('Not connected'));
    render(EscalationModal, { props: props({ onresolve }) });
    await waitUntilArmed();

    await click(screen.getByRole('button', { name: 'Deny' }));

    const alert = await screen.findByTestId('escalation-resolve-error');
    expect(alert.textContent).toContain('Failed to deny');
    expect(alert.textContent).toContain('Not connected');
  });

  it('shows invisible and direction-changing characters in the failure message as escapes', async () => {
    // The message is server text, but it can quote ids or exception messages;
    // it sits right above the Approve and Deny controls.
    const onresolve = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error('No pending PTY escalation: esc\u202e-1\u200b'));
    render(EscalationModal, { props: props({ onresolve }) });
    await waitUntilArmed();

    await click(screen.getByRole('button', { name: 'Approve' }));

    const alert = await screen.findByTestId('escalation-resolve-error');
    expect(alert.textContent).toContain('esc\\u202e-1\\u200b');
    expect(alert.textContent).not.toMatch(/[\u202e\u200b]/);
    expect(alert.classList.contains('bidi-safe')).toBe(true);
  });

  it('does not show a failure again once the modal was closed and reopened for a new escalation', async () => {
    const onresolve = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('Connection closed'));
    const { rerender } = render(EscalationModal, { props: props({ onresolve }) });
    await waitUntilArmed();

    await click(screen.getByRole('button', { name: 'Approve' }));
    await screen.findByTestId('escalation-resolve-error');

    await rerender({ open: false });
    await rerender({ open: true, escalations: new Map([['esc-2', makeEscalation('esc-2', 2)]]) });

    expect(await screen.findByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(screen.queryByTestId('escalation-resolve-error')).toBeNull();
  });

  it('clears a previous failure when the next resolve is attempted', async () => {
    const onresolve = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce(undefined);
    render(EscalationModal, { props: props({ onresolve }) });
    await waitUntilArmed();

    await click(screen.getByRole('button', { name: 'Approve' }));
    await screen.findByTestId('escalation-resolve-error');

    // The same escalation is still on screen, so it stays armed for the retry.
    await click(await screen.findByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(screen.queryByTestId('escalation-resolve-error')).toBeNull());
    expect(onresolve).toHaveBeenCalledTimes(2);
  });
});
