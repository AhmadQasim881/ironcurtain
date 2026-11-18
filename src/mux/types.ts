/**
 * Shared types for the terminal multiplexer (`ironcurtain mux`).
 */

import type { PtyBridge } from '../pty/pty-bridge.js';
import type { WhitelistScope } from '../trusted-process/approval-whitelist.js';

/**
 * Input mode for the mux. `message-panel` shows multi-line command output
 * (`/sessions`, bulk resolve results) in a dismissible bottom panel instead of
 * the one-row footer flash, which cannot hold more than one line.
 * `escalation-approve-all` is the confirmation screen that `/approve all` and
 * `/approve+ all` open: it lists every pending escalation and approves
 * exactly that set (see escalation-picker-state.ts). `/approve group N`
 * opens the same screen for the escalations sharing #N's whitelist pattern.
 */
export type InputMode =
  | 'pty'
  | 'command'
  | 'picker'
  | 'resume-picker'
  | 'persona-picker'
  | 'provider-picker'
  | 'escalation-picker'
  | 'escalation-approve-all'
  | 'message-panel';

/** Whether the mode is any picker variant. */
export function isPickerMode(mode: InputMode): boolean {
  return (
    mode === 'picker' ||
    mode === 'resume-picker' ||
    mode === 'persona-picker' ||
    mode === 'provider-picker' ||
    mode === 'escalation-picker' ||
    mode === 'escalation-approve-all' ||
    mode === 'message-panel'
  );
}

/**
 * Whether the mode is a bottom-panel picker that claims viewport rows.
 * The escalation picker and the approve-all confirmation are excluded --
 * they render as floating overlays on top of the full PTY viewport.
 */
export function isBottomPanelPicker(mode: InputMode): boolean {
  return (
    mode === 'picker' ||
    mode === 'resume-picker' ||
    mode === 'persona-picker' ||
    mode === 'provider-picker' ||
    mode === 'message-panel'
  );
}

/**
 * A pending escalation as the mux UI refers to it: the display number the
 * user sees and the request it stands for. Display numbers are never reused,
 * and the escalation id binds a decision to the request that was on screen.
 */
export interface PendingRef {
  readonly displayNumber: number;
  readonly escalationId: string;
  /**
   * The whitelist-pattern group the request belongs to
   * (`escalationGroupKey`), when it is groupable. Set by
   * `MuxEscalationManager.pendingRefs()`; never part of a ref's identity.
   */
  readonly groupKey?: string;
}

/** A single tab in the mux. */
export interface MuxTab {
  /** Sequential tab number (1-based, for display). */
  readonly number: number;
  /** The PtyBridge instance for this tab. */
  readonly bridge: PtyBridge;
  /** Display label for the tab. */
  label: string;
  /** Persona name if this tab was spawned with a persona. */
  persona?: string;
  /** Whether escalation watching is available for this session. */
  escalationAvailable: boolean;
  /** Scroll offset into xterm buffer (null = live/bottom). */
  scrollOffset: number | null;
}

/**
 * Actions produced by the input handler for the orchestrator to execute.
 */
export type MuxAction =
  | { readonly kind: 'none' }
  | { readonly kind: 'write-pty'; readonly data: string }
  | { readonly kind: 'enter-command-mode' }
  | { readonly kind: 'enter-pty-mode' }
  | { readonly kind: 'command'; readonly command: string; readonly args: string[] }
  | { readonly kind: 'trusted-input'; readonly text: string }
  | { readonly kind: 'redraw-input' }
  | { readonly kind: 'enter-picker-mode' }
  | {
      readonly kind: 'picker-spawn';
      readonly workspacePath?: string;
      readonly persona?: string;
      readonly providerProfileName?: string;
    }
  | { readonly kind: 'picker-cancel' }
  | { readonly kind: 'redraw-picker' }
  | { readonly kind: 'resume-spawn'; readonly sessionId: string; readonly agent: string }
  | { readonly kind: 'persona-spawn'; readonly persona: string; readonly taskScope?: string }
  | { readonly kind: 'escalation-open' }
  | { readonly kind: 'escalation-dismiss'; readonly targetMode?: 'command' }
  | { readonly kind: 'escalation-navigate'; readonly direction: 'next' | 'prev' }
  | {
      readonly kind: 'escalation-resolve';
      readonly displayNumber: number;
      /**
       * The escalation the picker showed under `displayNumber`. The manager
       * refuses the decision when another request is pending under it.
       */
      readonly escalationId: string;
      readonly decision: 'approved' | 'denied';
      /**
       * The whitelist pattern to add with an approval: `exact` (the first
       * candidate, `w`) or `directory` (the directory-wide one, `W`);
       * `false` for none.
       */
      readonly whitelist: false | WhitelistScope;
    }
  | { readonly kind: 'escalation-deny-all' }
  | {
      /**
       * `y` on the approve-all screen: approve exactly the escalations it
       * listed. With `groupKey` the screen listed one group (`/approve
       * group N`), and the approval is refused unless the listed set is
       * still exactly that group.
       */
      readonly kind: 'escalation-approve-reviewed';
      readonly reviewed: readonly PendingRef[];
      readonly whitelist: boolean;
      readonly groupKey?: string;
    }
  | { readonly kind: 'escalation-approve-all-cancel' }
  | { readonly kind: 'message-panel-dismiss' }
  | { readonly kind: 'scroll-up'; readonly amount: number }
  | { readonly kind: 'scroll-down'; readonly amount: number }
  | { readonly kind: 'quit' };

/**
 * Layout calculations for the screen regions.
 */
export interface Layout {
  /** Y position of the tab bar (always 0). */
  readonly tabBarY: number;
  /** Y position of the PTY viewport. */
  readonly ptyViewportY: number;
  /** Height of the PTY viewport in rows (CONSTANT -- never changes on mode switch). */
  readonly ptyViewportRows: number;
  /** Y position of the footer. */
  readonly footerY: number;
  /** Total overlay rows in command mode (0 in PTY mode). */
  readonly overlayRows: number;
  /** Y position where overlay starts. */
  readonly overlayY: number;
  /** Height of the escalation panel within the overlay. */
  readonly escalationPanelRows: number;
  /** Rows available for the picker overlay (half of viewport). */
  readonly pickerRows: number;
  /** Y position where the picker overlay starts. */
  readonly pickerY: number;
  /** Actual number of input rows allocated (after clamping). */
  readonly inputLineRows: number;
}

// Layout constants
const TAB_BAR_ROWS = 1;
const FOOTER_ROWS = 2;
const HINT_BAR_ROWS = 1;
const MIN_INPUT_LINE_ROWS = 1;
export const MAX_INPUT_LINE_ROWS = 6;
const ESCALATION_ROWS_PER_ITEM = 4;
const MAX_ESCALATION_PANEL_ROWS = 12;

/**
 * Calculates the screen layout.
 *
 * The PTY viewport is CONSTANT: totalRows - TAB_BAR_ROWS - FOOTER_ROWS.
 * In command mode, the overlay paints over the bottom rows of the PTY viewport.
 *
 * @param inputLineRows - Number of input rows requested (default 1). Clamped
 *   between MIN_INPUT_LINE_ROWS and MAX_INPUT_LINE_ROWS, then further clamped
 *   by available viewport space.
 * @param extraEscalationRows - Rows the escalation panel needs beyond
 *   ESCALATION_ROWS_PER_ITEM per escalation (default 0): one for each pending
 *   escalation that offers a directory-wide whitelist pattern, whose line the
 *   panel reserves next to the exact pattern's.
 */
export function calculateLayout(
  totalRows: number,
  mode: InputMode,
  pendingCount: number,
  inputLineRows = 1,
  extraEscalationRows = 0,
): Layout {
  // Ensure footer fits on screen; degrade gracefully on tiny terminals
  const footerRows = Math.min(FOOTER_ROWS, Math.max(0, totalRows - TAB_BAR_ROWS));
  const ptyViewportRows = Math.max(1, totalRows - TAB_BAR_ROWS - footerRows);

  let overlayRows = 0;
  let escalationPanelRows = 0;
  let allocatedInputRows = MIN_INPUT_LINE_ROWS;

  if (mode === 'command') {
    if (pendingCount > 0) {
      escalationPanelRows = Math.min(
        pendingCount * ESCALATION_ROWS_PER_ITEM + Math.max(0, extraEscalationRows),
        MAX_ESCALATION_PANEL_ROWS,
      );
    }
    const actualInputRows = Math.min(Math.max(inputLineRows, MIN_INPUT_LINE_ROWS), MAX_INPUT_LINE_ROWS);
    // Ensure overlay fits at least the hint bar + 1 input row, even on tiny terminals.
    const minOverlay = Math.min(ptyViewportRows, HINT_BAR_ROWS + MIN_INPUT_LINE_ROWS);
    overlayRows = Math.max(
      minOverlay,
      Math.min(escalationPanelRows + HINT_BAR_ROWS + actualInputRows, Math.floor(ptyViewportRows / 2), ptyViewportRows),
    );
    // Clamp escalation panel to fit within overlay budget, reserving
    // space for the hint bar and at least one input row.
    escalationPanelRows = Math.min(escalationPanelRows, Math.max(0, overlayRows - HINT_BAR_ROWS - MIN_INPUT_LINE_ROWS));
    allocatedInputRows = Math.max(MIN_INPUT_LINE_ROWS, overlayRows - escalationPanelRows - HINT_BAR_ROWS);
  }

  // Bottom-panel pickers claim viewport rows; escalation-picker floats over the full viewport.
  const pickerRows = isBottomPanelPicker(mode) ? Math.min(Math.floor(ptyViewportRows / 2), ptyViewportRows) : 0;
  const pickerY = TAB_BAR_ROWS + ptyViewportRows - pickerRows;

  return {
    tabBarY: 0,
    ptyViewportY: TAB_BAR_ROWS,
    ptyViewportRows,
    footerY: TAB_BAR_ROWS + ptyViewportRows,
    overlayRows,
    overlayY: TAB_BAR_ROWS + ptyViewportRows - overlayRows,
    escalationPanelRows,
    pickerRows,
    pickerY,
    inputLineRows: mode === 'command' ? allocatedInputRows : 1,
  };
}
