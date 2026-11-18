/**
 * The escalation picker's state machine, as pure functions.
 *
 * An escalation never takes the keyboard. When one arrives the mux rings the
 * bell, updates the `[!N pending]` badge and shows a footer banner; the user
 * opens the picker with Ctrl-E. A key typed for the agent, for the `/new`
 * path browser or for a command-mode message therefore never lands in the
 * picker, and no other picker is ever cancelled to make room for it.
 *
 * Once the picker is open, a decision counts only when it is deliberate:
 *
 * - Arming. Decision keys (`a`, `d`, `w`, `W`, `D`, and `y` on a
 *   confirmation) are ignored for {@link ESCALATION_ARMING_DELAY_MS} after
 *   the picker opens, after every focus change (navigation, or the snap to
 *   another escalation when the focused one is resolved or expires) and
 *   after every other key, including the ones that navigate, view or
 *   scroll. An ignored key is swallowed, never forwarded to the agent's
 *   PTY, and restarts the window, so a decision counts only after a full
 *   window with no other key: a held key, a double tap or text typed into
 *   the picker by mistake decides nothing. Approving also needs the request
 *   to have been drawn in full for the whole window (the renderer reports
 *   what it drew and since when).
 * - Whitelisting. `w` and `W` only open a confirmation that shows the
 *   complete pattern `y` would whitelist: the exact one (`w`, what
 *   `/approve+` selects) or the directory-wide one (`W`, what `/approve+dir`
 *   selects, offered only when the escalation has one).
 * - Binding. A decision names the escalation the renderer drew (display
 *   number and escalation id), and the escalation manager refuses it when
 *   another request is pending under that number.
 * - Bulk approval. There is no single-key "approve all". `/approve all` and
 *   `/approve+ all` open a confirmation screen listing every pending
 *   escalation; `y` approves exactly that set once every line of the list
 *   has been on screen, and any change to the set cancels the screen. The
 *   manager also refuses an approval whose set no longer matches.
 * - Group approval. `/approve group N` (and `/approve+ group N`) opens the
 *   same screen for the escalations sharing #N's whitelist pattern (see
 *   escalation/escalation-groups.ts), headed by that pattern. The same rules
 *   hold with the group in place of the pending set: any change to the
 *   group's members cancels the screen, and the manager refuses a group
 *   approval whose set is no longer exactly the group.
 *
 * Every function takes the clock reading (`now`, milliseconds on a monotonic
 * clock) as a parameter, so the rules are unit-testable without timers. The
 * input handler owns the state and applies these functions to it.
 */

import type { WhitelistScope } from '../trusted-process/approval-whitelist.js';
import type { InputMode, PendingRef } from './types.js';

/**
 * How long decision keys stay ignored after the picker opens, after a focus
 * change and after any key that was not accepted (about the enable delay
 * browsers use for permission dialogs).
 */
export const ESCALATION_ARMING_DELAY_MS = 1000;

export interface EscalationPickerState {
  /**
   * The display number of the currently focused escalation tab.
   * This is NOT an array index -- it's the monotonic displayNumber from
   * PendingEscalation, which survives additions and removals.
   */
  focusedDisplayNumber: number;

  /** The escalation id of the focused request; decisions carry it. */
  focusedEscalationId: string;

  /**
   * The mode the user was in before the picker opened.
   * Used to restore when the picker is dismissed with Esc.
   */
  previousMode: 'pty' | 'command';

  /**
   * Full-detail view of the focused escalation: the complete reason, the
   * whitelist pattern and every argument as pretty-printed, sanitized JSON,
   * scrollable. `null` shows the summary view, which cuts long values and
   * reports what it hid as `(+N hidden, v to view)`. The renderer draws the
   * view; `toggleEscalationDetailView()` and `scrollEscalationDetailView()`
   * change it, and the key handler maps keys onto them.
   */
  detailView: { scrollOffset: number } | null;

  /**
   * Clock reading (ms) from which decision keys count. Set to now plus the
   * arming delay when the picker opens, when the focus changes, when the
   * whitelist confirmation opens and on every key other than a decision
   * that counts (navigating, viewing and scrolling included).
   */
  armedAt: number;

  /**
   * Which whitelist pattern of the focused escalation the box asks to
   * confirm, shown in full, before `y` approves and whitelists it: `exact`
   * after `w` (the first candidate, what `/approve+` selects), `directory`
   * after `W` (the directory-wide candidate, what `/approve+dir` selects).
   * `false` while no confirmation is open. Cleared by `n`/Esc and by any
   * focus change.
   */
  whitelistConfirm: false | WhitelistScope;
}

/** The whitelist-pattern group an approve-group screen lists (`/approve group N`). */
export interface BulkApproveGroup {
  /** The group's pattern key (`escalationGroupKey`). */
  readonly key: string;
  /** The shared pattern's description, shown as the screen's heading. */
  readonly description: string;
}

/** The approve-all confirmation screen (`/approve all`, `/approve+ all`, `/approve group N`). */
export interface BulkApproveState {
  /**
   * Every escalation pending when the screen opened (for a group, every
   * member of the group): what it lists and what `y` approves.
   */
  readonly reviewed: readonly PendingRef[];
  /** Set for `/approve group N`: the screen lists one group instead of every escalation. */
  readonly group?: BulkApproveGroup;
  /** `/approve+ all`: also whitelist each escalation's pattern (listed in full). */
  readonly whitelist: boolean;
  /** The mode to restore when the screen closes. */
  readonly previousMode: 'pty' | 'command';
  /** First visible line; the renderer clamps it to the content and writes it back. */
  scrollOffset: number;
  /** Clock reading (ms) from which `y` counts; see {@link EscalationPickerState.armedAt}. */
  armedAt: number;
}

/**
 * Which rendering of an escalation the picker box shows. The two whitelist
 * confirmations differ, so `y` can require the one for the pattern it
 * would whitelist.
 */
export type EscalationView = 'summary' | 'detail' | 'whitelist-confirm' | 'whitelist-directory-confirm';

/** The view that confirms the whitelist pattern of `scope`. */
export function whitelistConfirmView(scope: WhitelistScope): EscalationView {
  return scope === 'directory' ? 'whitelist-directory-confirm' : 'whitelist-confirm';
}

/**
 * What the latest overlay draw showed of the focused escalation in full
 * (`MuxRenderer.displayedEscalation`). `null` when it showed none: the
 * picker is closed, or the terminal was too small and a notice was drawn.
 */
export interface DisplayedEscalation {
  readonly displayNumber: number;
  readonly escalationId: string;
  readonly view: EscalationView;
  /**
   * Clock reading of the first draw in the current unbroken run of draws
   * that showed this escalation in full (in any view). A draw that showed
   * something else, or nothing, ends the run.
   */
  readonly since: number;
  /** The escalation offers a whitelist pattern, so `w` means something. */
  readonly canWhitelist: boolean;
  /** The escalation offers a directory-wide whitelist pattern, so `W` means something. */
  readonly canWhitelistDirectory: boolean;
}

/** What the latest overlay draw showed of the approve-all screen (`MuxRenderer.displayedBulkApproval`). */
export interface DisplayedBulkApproval {
  /** {@link bulkApprovalKey} of the listed set. */
  readonly setKey: string;
  /**
   * Clock reading at which every line of the list had been on screen (the
   * user scrolled through all of it, or it fit), or null while some line
   * has not been shown yet. Resizing restarts the count.
   */
  readonly seenAllSince: number | null;
}

/** Whether two references name the same pending request. */
export function sameEscalation(a: PendingRef, b: PendingRef): boolean {
  return a.displayNumber === b.displayNumber && a.escalationId === b.escalationId;
}

/**
 * Whether two lists name exactly the same pending requests, in any order.
 * A list that names a request twice matches no list: it cannot be the
 * pending set, which holds each request once.
 */
export function sameEscalationSet(a: readonly PendingRef[], b: readonly PendingRef[]): boolean {
  if (a.length !== b.length) return false;
  const key = (ref: PendingRef): string => `${ref.displayNumber}\u0000${ref.escalationId}`;
  const keysA = new Set(a.map(key));
  const keysB = new Set(b.map(key));
  return keysA.size === a.length && keysB.size === b.length && b.every((ref) => keysA.has(key(ref)));
}

/** Identifies what an approve-all screen lists: the set and whether it whitelists. */
export function bulkApprovalKey(reviewed: readonly PendingRef[], whitelist: boolean): string {
  const entries = [...reviewed]
    .sort((x, y) => x.displayNumber - y.displayNumber)
    .map((ref) => [ref.displayNumber, ref.escalationId]);
  return JSON.stringify([whitelist, entries]);
}

/**
 * The clock reading from which a decision on a drawn escalation counts: the
 * picker's own arming time, and at least one arming delay after the request
 * started to be shown in full.
 */
export function decisionArmedAt(armedAt: number, shownSince: number, armingDelayMs: number): number {
  return Math.max(armedAt, shownSince + armingDelayMs);
}

/**
 * Where the focus goes when the focused escalation is no longer pending:
 * the next one after it, or the last one when it was the last. `pending` is
 * sorted by display number. Undefined when nothing is pending.
 */
export function focusAfterRemoval(
  pending: readonly PendingRef[],
  removedDisplayNumber: number,
): PendingRef | undefined {
  return pending.find((ref) => ref.displayNumber > removedDisplayNumber) ?? pending[pending.length - 1];
}

/**
 * The escalation one tab to the right (`next`) or left (`prev`) of
 * `currentDisplayNumber`, wrapping around. When the current one is gone the
 * focus goes where {@link focusAfterRemoval} puts it. `pending` is sorted by
 * display number. Undefined when nothing is pending.
 */
export function navigateFocus(
  pending: readonly PendingRef[],
  currentDisplayNumber: number,
  direction: 'next' | 'prev',
): PendingRef | undefined {
  const index = pending.findIndex((ref) => ref.displayNumber === currentDisplayNumber);
  if (index === -1) return focusAfterRemoval(pending, currentDisplayNumber);
  const step = direction === 'next' ? 1 : -1;
  return pending[(index + step + pending.length) % pending.length];
}

/** A fresh picker focused on `focus`, disarmed until one arming delay from `now`. */
export function openEscalationPicker(
  focus: PendingRef,
  previousMode: 'pty' | 'command',
  now: number,
  armingDelayMs: number,
): EscalationPickerState {
  return {
    focusedDisplayNumber: focus.displayNumber,
    focusedEscalationId: focus.escalationId,
    previousMode,
    detailView: null,
    armedAt: now + armingDelayMs,
    whitelistConfirm: false,
  };
}

/**
 * The picker focused on `focus`. Moving to another escalation re-arms the
 * picker, starts an open detail view at the top and cancels a whitelist
 * confirmation; the same focus returns the state unchanged.
 */
export function refocusEscalationPicker(
  picker: EscalationPickerState,
  focus: PendingRef,
  now: number,
  armingDelayMs: number,
): EscalationPickerState {
  if (sameEscalation(focus, { displayNumber: picker.focusedDisplayNumber, escalationId: picker.focusedEscalationId })) {
    return picker;
  }
  return {
    ...picker,
    focusedDisplayNumber: focus.displayNumber,
    focusedEscalationId: focus.escalationId,
    detailView: picker.detailView ? { scrollOffset: 0 } : null,
    armedAt: now + armingDelayMs,
    whitelistConfirm: false,
  };
}

/** The escalation part of the mux input state. */
export interface EscalationUiState {
  readonly mode: InputMode;
  readonly picker: EscalationPickerState | null;
  readonly bulk: BulkApproveState | null;
}

/**
 * What a change to the pending escalations did: `refocused` moved the
 * picker to another escalation (and re-armed it), `picker-closed` closed it
 * because nothing is pending, `bulk-cancelled` closed the approve-all
 * screen because the set it listed changed.
 */
export type EscalationUiOutcome = 'unchanged' | 'refocused' | 'picker-closed' | 'bulk-cancelled';

export interface EscalationUiTransition {
  readonly next: EscalationUiState;
  readonly outcome: EscalationUiOutcome;
  /** Footer message for the user, when the change needs explaining. */
  readonly message?: string;
}

/**
 * Applies a change to the pending escalations (an arrival, a resolution, an
 * expiry, a session that went away) to the input state. Pure: `current` is
 * not modified.
 *
 * - No mode other than the escalation picker and the approve-all screen is
 *   ever changed: an arrival does not open the picker and does not cancel
 *   any other picker or panel.
 * - Picker open, nothing pending: it closes and the previous mode returns.
 * - Picker open, the focused escalation gone: the focus moves to the next
 *   escalation (or the last one) and the picker re-arms.
 * - Approve-all screen open and the set it lists changed in any way (for a
 *   group screen: the members of its group, from `PendingRef.groupKey`): the
 *   screen closes and the message says why.
 *
 * `pending` is sorted by display number.
 */
export function reconcileEscalationUi(
  current: EscalationUiState,
  pending: readonly PendingRef[],
  now: number,
  armingDelayMs: number = ESCALATION_ARMING_DELAY_MS,
): EscalationUiTransition {
  if (current.mode === 'escalation-picker' && current.picker) {
    const picker = current.picker;
    if (pending.length === 0) {
      return { next: { mode: picker.previousMode, picker: null, bulk: current.bulk }, outcome: 'picker-closed' };
    }
    const focus = { displayNumber: picker.focusedDisplayNumber, escalationId: picker.focusedEscalationId };
    if (pending.some((ref) => sameEscalation(ref, focus))) {
      return { next: current, outcome: 'unchanged' };
    }
    const target = focusAfterRemoval(pending, picker.focusedDisplayNumber) ?? pending[0];
    return {
      next: { ...current, picker: refocusEscalationPicker(picker, target, now, armingDelayMs) },
      outcome: 'refocused',
    };
  }

  if (current.mode === 'escalation-approve-all' && current.bulk) {
    const bulk = current.bulk;
    const group = bulk.group;
    const listed = group ? pending.filter((ref) => ref.groupKey === group.key) : pending;
    if (sameEscalationSet(bulk.reviewed, listed)) {
      return { next: current, outcome: 'unchanged' };
    }
    const prefix = bulk.whitelist ? '/approve+' : '/approve';
    const message = group
      ? `The group's escalations changed, so nothing was approved. Run ${prefix} group N again to review the group.`
      : `The pending escalations changed, so nothing was approved. Run ${prefix} all again to review the new list.`;
    return {
      next: { mode: bulk.previousMode, picker: current.picker, bulk: null },
      outcome: 'bulk-cancelled',
      message,
    };
  }

  // Any other mode: the bell, the badge and the footer banner announce an
  // arrival; the keyboard stays where the user put it.
  return { next: current, outcome: 'unchanged' };
}
