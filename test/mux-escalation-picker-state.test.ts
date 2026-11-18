/**
 * The escalation picker's state machine (src/mux/escalation-picker-state.ts):
 * what a change to the pending escalations does to the mux input state.
 * Pure functions with the clock passed in, so every rule is checked without
 * timers. Key handling on top of it is covered in mux-input-handler.test.ts.
 */

import { describe, expect, it } from 'vitest';
import {
  bulkApprovalKey,
  decisionArmedAt,
  ESCALATION_ARMING_DELAY_MS,
  focusAfterRemoval,
  navigateFocus,
  openEscalationPicker,
  reconcileEscalationUi,
  refocusEscalationPicker,
  sameEscalationSet,
  type BulkApproveState,
  type EscalationUiState,
} from '../src/mux/escalation-picker-state.js';
import type { InputMode, PendingRef } from '../src/mux/types.js';

const DELAY = ESCALATION_ARMING_DELAY_MS;

function ref(displayNumber: number, escalationId = `esc-${displayNumber}`): PendingRef {
  return { displayNumber, escalationId };
}

function refs(...numbers: number[]): PendingRef[] {
  return numbers.map((n) => ref(n));
}

function ui(mode: InputMode, extra: Partial<EscalationUiState> = {}): EscalationUiState {
  return { mode, picker: null, bulk: null, ...extra };
}

function bulkState(reviewed: PendingRef[], whitelist = false): BulkApproveState {
  return { reviewed, whitelist, previousMode: 'command', scrollOffset: 0, armedAt: 0 };
}

describe('the arming delay', () => {
  it('is about one second', () => {
    expect(DELAY).toBeGreaterThanOrEqual(750);
    expect(DELAY).toBeLessThanOrEqual(1000);
  });

  it('a decision counts from the later of the picker arming and one delay after the request was shown', () => {
    expect(decisionArmedAt(5_000, 1_000, DELAY)).toBe(5_000);
    expect(decisionArmedAt(5_000, 4_800, DELAY)).toBe(4_800 + DELAY);
    expect(decisionArmedAt(5_000, Number.NEGATIVE_INFINITY, DELAY)).toBe(5_000);
  });

  it('a new picker opens disarmed, focused on the given escalation', () => {
    const picker = openEscalationPicker(ref(4), 'command', 10_000, DELAY);
    expect(picker).toEqual({
      focusedDisplayNumber: 4,
      focusedEscalationId: 'esc-4',
      previousMode: 'command',
      detailView: null,
      armedAt: 10_000 + DELAY,
      whitelistConfirm: false,
    });
  });

  it('moving the focus re-arms, starts the detail view at the top and cancels a whitelist confirmation', () => {
    const picker = { ...openEscalationPicker(ref(1), 'pty', 0, DELAY), detailView: { scrollOffset: 7 } };
    picker.whitelistConfirm = 'exact';
    const moved = refocusEscalationPicker(picker, ref(2), 50_000, DELAY);
    expect(moved.focusedDisplayNumber).toBe(2);
    expect(moved.focusedEscalationId).toBe('esc-2');
    expect(moved.armedAt).toBe(50_000 + DELAY);
    expect(moved.detailView).toEqual({ scrollOffset: 0 });
    expect(moved.whitelistConfirm).toBe(false);
    // The same focus is not a change: nothing re-arms.
    expect(refocusEscalationPicker(moved, ref(2), 90_000, DELAY)).toBe(moved);
  });
});

describe('focus movement', () => {
  it('after the focused escalation goes away, focus moves to the next one, or the last one', () => {
    expect(focusAfterRemoval(refs(2, 5, 9), 3)).toEqual(ref(5));
    expect(focusAfterRemoval(refs(2, 5, 9), 12)).toEqual(ref(9));
    expect(focusAfterRemoval(refs(4), 1)).toEqual(ref(4));
    expect(focusAfterRemoval([], 1)).toBeUndefined();
  });

  it('navigation wraps around and recovers from a focus that is gone', () => {
    const pending = refs(2, 5, 9);
    expect(navigateFocus(pending, 5, 'next')).toEqual(ref(9));
    expect(navigateFocus(pending, 9, 'next')).toEqual(ref(2));
    expect(navigateFocus(pending, 2, 'prev')).toEqual(ref(9));
    expect(navigateFocus(pending, 6, 'prev')).toEqual(ref(9));
    expect(navigateFocus([], 6, 'next')).toBeUndefined();
  });
});

describe('reconcileEscalationUi: an arrival never takes the keyboard', () => {
  const modes: InputMode[] = [
    'pty',
    'command',
    'picker',
    'resume-picker',
    'persona-picker',
    'provider-picker',
    'message-panel',
  ];

  it.each(modes)('in %s mode a new escalation changes nothing', (mode) => {
    const current = ui(mode);
    const transition = reconcileEscalationUi(current, refs(1, 2), 1_000);
    expect(transition.outcome).toBe('unchanged');
    expect(transition.next).toBe(current);
    expect(transition.message).toBeUndefined();
  });

  it('an open picker keeps its focus and its arming when another escalation arrives', () => {
    const picker = openEscalationPicker(ref(1), 'pty', 0, DELAY);
    const current = ui('escalation-picker', { picker });
    const transition = reconcileEscalationUi(current, refs(1, 2), 5_000);
    expect(transition.outcome).toBe('unchanged');
    expect(transition.next.picker).toBe(picker);
    expect(picker.armedAt).toBe(DELAY);
  });
});

describe('reconcileEscalationUi: the open picker', () => {
  it('closes and restores the previous mode when nothing is pending', () => {
    const picker = openEscalationPicker(ref(3), 'command', 0, DELAY);
    const transition = reconcileEscalationUi(ui('escalation-picker', { picker }), [], 9_000);
    expect(transition.outcome).toBe('picker-closed');
    expect(transition.next).toEqual({ mode: 'command', picker: null, bulk: null });
  });

  it('snaps to the next escalation when the focused one is resolved or expires, and re-arms', () => {
    const picker = openEscalationPicker(ref(3), 'pty', 0, DELAY);
    const current = ui('escalation-picker', { picker });
    const transition = reconcileEscalationUi(current, refs(1, 4, 6), 20_000);
    expect(transition.outcome).toBe('refocused');
    expect(transition.next.mode).toBe('escalation-picker');
    expect(transition.next.picker?.focusedDisplayNumber).toBe(4);
    expect(transition.next.picker?.armedAt).toBe(20_000 + DELAY);
    // Pure: the current state is untouched.
    expect(picker.focusedDisplayNumber).toBe(3);
    expect(picker.armedAt).toBe(DELAY);
  });

  it('treats another request under the focused display number as a focus change', () => {
    const picker = openEscalationPicker(ref(3), 'pty', 0, DELAY);
    const transition = reconcileEscalationUi(ui('escalation-picker', { picker }), [ref(3, 'other')], 20_000);
    expect(transition.outcome).toBe('refocused');
    expect(transition.next.picker?.focusedEscalationId).toBe('other');
    expect(transition.next.picker?.armedAt).toBe(20_000 + DELAY);
  });

  it('snaps to the last escalation when the focused one was the last', () => {
    const picker = openEscalationPicker(ref(9), 'pty', 0, DELAY);
    const transition = reconcileEscalationUi(ui('escalation-picker', { picker }), refs(2, 5), 1);
    expect(transition.next.picker?.focusedDisplayNumber).toBe(5);
  });
});

describe('reconcileEscalationUi: the approve-all screen', () => {
  it('stays open while the listed set is exactly what is pending', () => {
    const bulk = bulkState(refs(1, 2));
    const current = ui('escalation-approve-all', { bulk });
    expect(reconcileEscalationUi(current, refs(2, 1), 5).next).toBe(current);
  });

  it('closes, approving nothing, when an escalation arrives after the list was shown', () => {
    const bulk = bulkState(refs(1, 2));
    const transition = reconcileEscalationUi(ui('escalation-approve-all', { bulk }), refs(1, 2, 3), 5);
    expect(transition.outcome).toBe('bulk-cancelled');
    expect(transition.next).toEqual({ mode: 'command', picker: null, bulk: null });
    expect(transition.message).toContain('nothing was approved');
    expect(transition.message).toContain('/approve all');
  });

  it('closes when a listed escalation expires or is replaced', () => {
    const bulk = bulkState(refs(1, 2), true);
    const expired = reconcileEscalationUi(ui('escalation-approve-all', { bulk }), refs(1), 5);
    expect(expired.outcome).toBe('bulk-cancelled');
    expect(expired.message).toContain('/approve+ all');
    const replaced = reconcileEscalationUi(ui('escalation-approve-all', { bulk }), [ref(1), ref(2, 'other')], 5);
    expect(replaced.outcome).toBe('bulk-cancelled');
  });
});

describe('sets of escalations', () => {
  it('compares display numbers and escalation ids, in any order', () => {
    expect(sameEscalationSet(refs(1, 2), refs(2, 1))).toBe(true);
    expect(sameEscalationSet(refs(1, 2), refs(1))).toBe(false);
    expect(sameEscalationSet(refs(1, 2), [ref(1), ref(2, 'x')])).toBe(false);
    expect(sameEscalationSet([ref(1), ref(1)], refs(1, 2))).toBe(false);
    // Either side: a list naming a request twice is never the pending set.
    expect(sameEscalationSet(refs(1, 2), [ref(1), ref(1)])).toBe(false);
  });

  it('keys an approve-all screen by its set and whether it whitelists', () => {
    expect(bulkApprovalKey(refs(2, 1), false)).toBe(bulkApprovalKey(refs(1, 2), false));
    expect(bulkApprovalKey(refs(1, 2), false)).not.toBe(bulkApprovalKey(refs(1, 2), true));
    expect(bulkApprovalKey(refs(1, 2), false)).not.toBe(bulkApprovalKey(refs(1, 2, 3), false));
  });
});
