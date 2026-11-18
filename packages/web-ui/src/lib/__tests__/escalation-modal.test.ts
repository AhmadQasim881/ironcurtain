/**
 * Keyjacking regression tests for the escalation modal.
 *
 * The modal opens on its own when an escalation arrives, typically while the
 * user is typing into the terminal. It must never move focus, no key typed
 * outside it may decide anything, bare letters never decide, and nothing
 * decides an escalation that has been on screen for less than the arming
 * delay -- including a second click or chord meant for the escalation that
 * was just resolved, and a press that began during the delay.
 *
 * Timers are faked so the real ESCALATION_ARM_DELAY_MS is tested at its
 * boundary without depending on machine load.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import EscalationModal, { ESCALATION_ARM_DELAY_MS } from '../components/features/escalation-modal.svelte';
import type { PendingEscalation } from '../types.js';

function escalation(id: string, displayNumber: number, overrides: Partial<PendingEscalation> = {}): PendingEscalation {
  return {
    escalationId: id,
    sessionLabel: 1,
    sessionSource: { kind: 'web-pty' },
    toolName: 'write_file',
    serverName: 'filesystem',
    arguments: { path: '/etc/hosts' },
    reason: 'Write to protected system path',
    receivedAt: '2026-01-01T00:00:00.000Z',
    displayNumber,
    ...overrides,
  };
}

function toMap(items: PendingEscalation[]): Map<string, PendingEscalation> {
  return new Map(items.map((item) => [item.escalationId, item]));
}

function renderModal(items: PendingEscalation[]) {
  const onresolve = vi.fn<(id: string, decision: 'approved' | 'denied', whitelist?: number) => Promise<void>>(
    async () => undefined,
  );
  const onclose = vi.fn();
  const props = {
    open: true,
    escalations: toMap(items),
    onclose,
    onresolve,
    onviewsession: vi.fn(),
  };
  const rendered = render(EscalationModal, { props });
  const dialog = screen.getByRole('dialog');
  return { ...rendered, props, onresolve, onclose, dialog };
}

/** Let `ms` of (fake) time pass and flush Svelte's updates. */
async function elapse(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await tick();
}

const waitUntilArmed = (): Promise<void> => elapse(ESCALATION_ARM_DELAY_MS);

function isArmed(): boolean {
  return screen.getByTestId('escalation-dialog-body').dataset.armed === 'true';
}

/** A real mouse click: the press, then the click it produces. */
async function click(element: HTMLElement): Promise<void> {
  await fireEvent.pointerDown(element);
  await fireEvent.mouseDown(element);
  await fireEvent.pointerUp(element);
  await fireEvent.mouseUp(element);
  await fireEvent.click(element);
}

const ctrlEnter = { key: 'Enter', ctrlKey: true };
const ctrlBackspace = { key: 'Backspace', ctrlKey: true };

let outside: HTMLTextAreaElement;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  // Stands in for xterm's helper textarea: the element the user is typing into
  // when the escalation arrives.
  outside = document.createElement('textarea');
  document.body.appendChild(outside);
  outside.focus();
});

afterEach(() => {
  outside.remove();
  vi.useRealTimers();
});

describe('EscalationModal: no focus steal, no bare-letter approval', () => {
  it('keeps focus in the textarea the user was typing in; keys typed there never resolve', async () => {
    const { onresolve } = renderModal([escalation('e1', 1)]);
    await tick();
    expect(document.activeElement).toBe(outside);

    const typed = document.activeElement as HTMLElement;
    await fireEvent.keyDown(typed, { key: 'a' });
    await fireEvent.keyDown(typed, ctrlEnter);
    await waitUntilArmed();
    expect(isArmed()).toBe(true);
    await fireEvent.keyDown(typed, { key: 'a' });
    await fireEvent.keyDown(typed, { key: 'd' });
    await fireEvent.keyDown(typed, { key: 'Enter' });
    await fireEvent.keyDown(typed, ctrlEnter);

    expect(onresolve).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(outside);
    expect(screen.getByTestId('focus-hint')).toBeTruthy();
  });

  it('ignores the approve chord inside the dialog until the escalation has been visible for the delay', async () => {
    const { onresolve, dialog } = renderModal([escalation('e1', 1)]);
    await fireEvent.keyDown(dialog, ctrlEnter);
    await elapse(ESCALATION_ARM_DELAY_MS - 1);
    expect(isArmed()).toBe(false);
    await fireEvent.keyDown(dialog, ctrlEnter);
    expect(onresolve).not.toHaveBeenCalled();

    await elapse(1);
    expect(isArmed()).toBe(true);
    await fireEvent.keyDown(dialog, ctrlEnter);
    expect(onresolve).toHaveBeenCalledTimes(1);
    expect(onresolve).toHaveBeenCalledWith('e1', 'approved', undefined);
  });

  it('never approves by chord a request that does not name its tool or arguments; it can be denied', async () => {
    const { onresolve, dialog } = renderModal([escalation('e1', 1, { serverName: '', toolName: '' })]);
    await waitUntilArmed();
    await fireEvent.keyDown(dialog, ctrlEnter);
    expect(onresolve).not.toHaveBeenCalled();
    await fireEvent.keyDown(dialog, ctrlBackspace);
    expect(onresolve).toHaveBeenCalledWith('e1', 'denied', undefined);
  });

  it('denies on Ctrl+Backspace', async () => {
    const { onresolve, dialog } = renderModal([escalation('e1', 1)]);
    await waitUntilArmed();
    await fireEvent.keyDown(dialog, ctrlBackspace);
    expect(onresolve).toHaveBeenCalledWith('e1', 'denied', undefined);
  });

  it('accepts the Meta modifier as the chord key', async () => {
    const { onresolve, dialog } = renderModal([escalation('e1', 1)]);
    await waitUntilArmed();
    await fireEvent.keyDown(dialog, { key: 'Enter', metaKey: true });
    expect(onresolve).toHaveBeenCalledWith('e1', 'approved', undefined);
  });

  it('never resolves on bare letters, Enter alone, Shift/Alt chords or key repeats, even when armed', async () => {
    const { onresolve, dialog } = renderModal([escalation('e1', 1)]);
    await waitUntilArmed();

    await fireEvent.keyDown(dialog, { key: 'a' });
    await fireEvent.keyDown(dialog, { key: 'd' });
    await fireEvent.keyDown(dialog, { key: 'Enter' });
    await fireEvent.keyDown(dialog, { key: 'Enter', ctrlKey: true, shiftKey: true });
    await fireEvent.keyDown(dialog, { key: 'Enter', ctrlKey: true, altKey: true });
    await fireEvent.keyDown(dialog, { key: 'Enter', ctrlKey: true, repeat: true });
    await fireEvent.keyDown(dialog, { key: 'Backspace', ctrlKey: true, repeat: true });
    expect(onresolve).not.toHaveBeenCalled();

    await fireEvent.keyDown(dialog, ctrlEnter);
    expect(onresolve).toHaveBeenCalledWith('e1', 'approved', undefined);
  });

  it('ignores chords typed into an input inside the dialog', async () => {
    const { onresolve, dialog } = renderModal([escalation('e1', 1)]);
    await waitUntilArmed();
    const input = document.createElement('input');
    dialog.appendChild(input);
    await fireEvent.keyDown(input, ctrlEnter);
    expect(onresolve).not.toHaveBeenCalled();
  });
});

describe('EscalationModal: Approve and Deny buttons', () => {
  it('ignores clicks during the delay and approves on a click after it', async () => {
    const { onresolve } = renderModal([escalation('e1', 1)]);
    const approve = screen.getByTestId('escalation-approve');
    expect(approve.getAttribute('aria-disabled')).toBe('true');

    await click(approve);
    await click(screen.getByTestId('escalation-deny'));
    await elapse(ESCALATION_ARM_DELAY_MS - 1);
    await click(approve);
    expect(onresolve).not.toHaveBeenCalled();

    await elapse(1);
    expect(approve.hasAttribute('aria-disabled')).toBe(false);
    await click(approve);
    expect(onresolve).toHaveBeenCalledTimes(1);
    expect(onresolve).toHaveBeenCalledWith('e1', 'approved', undefined);
  });

  it('ignores a click whose press began during the delay', async () => {
    const { onresolve } = renderModal([escalation('e1', 1)]);
    const approve = screen.getByTestId('escalation-approve');

    await fireEvent.pointerDown(approve);
    await fireEvent.mouseDown(approve);
    await waitUntilArmed();
    await fireEvent.pointerUp(approve);
    await fireEvent.mouseUp(approve);
    await fireEvent.click(approve);
    expect(onresolve).not.toHaveBeenCalled();

    await click(approve);
    expect(onresolve).toHaveBeenCalledTimes(1);
  });

  it('ignores a touch held from the delay into the armed state (compat mousedown comes at lift-off)', async () => {
    const { onresolve } = renderModal([escalation('e1', 1)]);
    const approve = screen.getByTestId('escalation-approve');

    // Touch: pointerdown when the finger lands, the compatibility mouse
    // events only when it lifts -- here after arming.
    await fireEvent.pointerDown(approve, { pointerType: 'touch' });
    await waitUntilArmed();
    await fireEvent.pointerUp(approve, { pointerType: 'touch' });
    await fireEvent.mouseDown(approve);
    await fireEvent.mouseUp(approve);
    await fireEvent.click(approve);
    expect(onresolve).not.toHaveBeenCalled();

    await click(approve);
    expect(onresolve).toHaveBeenCalledTimes(1);
  });

  it('does not let another key clear a press that began during the delay', async () => {
    const { onresolve } = renderModal([escalation('e1', 1)]);
    const deny = screen.getByTestId('escalation-deny');

    // Space held on a focused button from before arming; a Shift pressed
    // meanwhile is not a new press of the button.
    await fireEvent.keyDown(deny, { key: ' ' });
    await waitUntilArmed();
    await fireEvent.keyDown(deny, { key: 'Shift' });
    await fireEvent.keyUp(deny, { key: ' ' });
    await fireEvent.click(deny);
    expect(onresolve).not.toHaveBeenCalled();
  });

  it('accepts Enter on a focused button once armed, but not a repeated Enter', async () => {
    const { onresolve } = renderModal([escalation('e1', 1)]);
    await waitUntilArmed();
    const deny = screen.getByTestId('escalation-deny');

    // The browser turns Enter on a focused button into a click.
    await fireEvent.keyDown(deny, { key: 'Enter', repeat: true });
    await fireEvent.click(deny);
    expect(onresolve).not.toHaveBeenCalled();

    await fireEvent.keyDown(deny, { key: 'Enter' });
    await fireEvent.click(deny);
    expect(onresolve).toHaveBeenCalledWith('e1', 'denied', undefined);
  });

  it('ignores whitelist choices during the delay and passes the chosen one on approval', async () => {
    const { onresolve } = renderModal([
      escalation('e1', 1, { whitelistCandidates: [{ description: 'first' }, { description: 'second' }] }),
    ]);
    const [first] = screen.getAllByTestId('whitelist-candidate');

    await click(first);
    expect(first.getAttribute('aria-pressed')).toBe('false');

    await waitUntilArmed();
    await click(first);
    expect(first.getAttribute('aria-pressed')).toBe('true');
    await click(screen.getByTestId('escalation-approve'));
    expect(onresolve).toHaveBeenCalledWith('e1', 'approved', 0);
  });
});

describe('EscalationModal: arming follows the escalation on screen', () => {
  it('restarts the delay when another escalation replaces the one just resolved', async () => {
    const first = escalation('e1', 1);
    const second = escalation('e2', 2);
    const { onresolve, dialog, rerender, props } = renderModal([first, second]);
    await waitUntilArmed();
    await fireEvent.keyDown(dialog, ctrlEnter);
    expect(onresolve).toHaveBeenLastCalledWith('e1', 'approved', undefined);

    // e1 is gone; e2 takes over the screen. The repeated chord and a double
    // click's second click must not decide it.
    await rerender({ ...props, escalations: toMap([second]) });
    expect(isArmed()).toBe(false);
    await fireEvent.keyDown(dialog, ctrlEnter);
    await click(screen.getByTestId('escalation-approve'));
    expect(onresolve).toHaveBeenCalledTimes(1);

    await waitUntilArmed();
    await fireEvent.keyDown(dialog, ctrlEnter);
    expect(onresolve).toHaveBeenLastCalledWith('e2', 'approved', undefined);
  });

  it('restarts the delay on a tab switch', async () => {
    const { onresolve, dialog } = renderModal([escalation('e1', 1), escalation('e2', 2)]);
    await waitUntilArmed();
    expect(isArmed()).toBe(true);

    await fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    expect(screen.getAllByRole('tab')[1].getAttribute('aria-selected')).toBe('true');
    expect(isArmed()).toBe(false);
    await fireEvent.keyDown(dialog, ctrlEnter);
    expect(onresolve).not.toHaveBeenCalled();

    await waitUntilArmed();
    await fireEvent.keyDown(dialog, ctrlEnter);
    expect(onresolve).toHaveBeenCalledWith('e2', 'approved', undefined);
  });

  it('restarts the delay when the modal is closed and opened again', async () => {
    const { onresolve, dialog, rerender, props } = renderModal([escalation('e1', 1)]);
    await waitUntilArmed();
    await rerender({ ...props, open: false });
    await rerender({ ...props, open: true });
    const reopened = screen.getByRole('dialog');
    expect(reopened).not.toBe(dialog);
    expect(isArmed()).toBe(false);
    await fireEvent.keyDown(reopened, ctrlEnter);
    expect(onresolve).not.toHaveBeenCalled();

    await waitUntilArmed();
    await fireEvent.keyDown(reopened, ctrlEnter);
    expect(onresolve).toHaveBeenCalledWith('e1', 'approved', undefined);
  });
});

describe('EscalationModal: arming needs the user to be able to see the escalation', () => {
  let visibility: DocumentVisibilityState = 'visible';

  beforeEach(() => {
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  });

  afterEach(() => {
    // Back to jsdom's own getter on Document.prototype.
    Reflect.deleteProperty(document, 'visibilityState');
  });

  function setVisibility(state: DocumentVisibilityState): void {
    visibility = state;
    document.dispatchEvent(new Event('visibilitychange'));
  }

  it('never arms while the window is unfocused and restarts the delay when it regains focus', async () => {
    const { onresolve, dialog } = renderModal([escalation('e1', 1)]);
    const approve = screen.getByTestId('escalation-approve');
    await waitUntilArmed();
    expect(isArmed()).toBe(true);

    // The user switches to another application.
    window.dispatchEvent(new Event('blur'));
    await tick();
    expect(isArmed()).toBe(false);
    await elapse(ESCALATION_ARM_DELAY_MS * 3);
    expect(isArmed()).toBe(false);

    // Coming back: the first click into the window, and anything else
    // within the delay, decides nothing.
    window.dispatchEvent(new Event('focus'));
    await click(approve);
    await fireEvent.keyDown(dialog, ctrlEnter);
    await elapse(ESCALATION_ARM_DELAY_MS - 1);
    expect(isArmed()).toBe(false);
    await click(approve);
    expect(onresolve).not.toHaveBeenCalled();

    await elapse(1);
    expect(isArmed()).toBe(true);
    await click(approve);
    expect(onresolve).toHaveBeenCalledWith('e1', 'approved', undefined);
  });

  it('does not arm an escalation that appeared while the page was hidden until it has been shown for the delay', async () => {
    visibility = 'hidden';
    const { onresolve } = renderModal([escalation('e1', 1)]);
    const approve = screen.getByTestId('escalation-approve');
    await elapse(ESCALATION_ARM_DELAY_MS * 5);
    expect(isArmed()).toBe(false);

    // The flashing title brings the user back to the tab.
    setVisibility('visible');
    await tick();
    await click(approve);
    await elapse(ESCALATION_ARM_DELAY_MS - 1);
    await click(approve);
    expect(onresolve).not.toHaveBeenCalled();

    await elapse(1);
    await click(approve);
    expect(onresolve).toHaveBeenCalledTimes(1);
  });

  it('disarms when the page is hidden', async () => {
    renderModal([escalation('e1', 1)]);
    await waitUntilArmed();
    setVisibility('hidden');
    await tick();
    expect(isArmed()).toBe(false);
  });
});

describe('EscalationModal: dismissal', () => {
  it('closes on Escape pressed outside the dialog and consumes the key', async () => {
    const { onclose } = renderModal([escalation('e1', 1)]);
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    outside.dispatchEvent(event);
    expect(onclose).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe('EscalationModal: tab labels', () => {
  it('shows invisible characters in server and tool names as escapes', async () => {
    renderModal([escalation('e1', 1, { serverName: 'git\u202e', toolName: 'push\u200b' }), escalation('e2', 2)]);
    const tabs = screen.getAllByRole('tab');
    expect(tabs[0].textContent).toContain('git\\u202e/push\\u200b');
    expect(tabs[0].textContent).not.toContain('\u202e');
    expect(tabs[0].classList.contains('bidi-safe')).toBe(true);
  });
});
