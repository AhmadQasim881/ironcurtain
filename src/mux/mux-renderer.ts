/**
 * MuxRenderer -- composes all UI regions into terminal output
 * and draws to the real terminal with throttled rendering.
 *
 * UI regions (top to bottom):
 *   [tab bar]          1 row
 *   [pty viewport]     variable height (fills remaining space)
 *   [escalation panel] 0 or N rows (only in command mode with pending escalations)
 *   [hint bar]         1 row
 *   [input line]       0 or 1 row (only in command mode)
 *
 * The PTY viewport size is constant regardless of input mode.
 * Command-mode UI overlays the bottom of the viewport.
 *
 * Frames and damage tracking. Every redraw is one frame: everything it
 * draws is collected and sent to the terminal as a single write wrapped in
 * synchronized-output mode (frame-writer.ts), so the terminal never shows a
 * half-drawn state. Within a frame only what changed is sent:
 * - PTY rows: the bytes each viewport row was last drawn with are kept per
 *   tab (keyed by screen row) and a row is sent only when its bytes differ.
 *   The cache starts over on a full redraw (which clears the screen), a
 *   resize, another tab, mode or scroll position; rows an overlay takes
 *   over are dropped from it, so they are repainted when they come back.
 * - Overlays are composed into the frame, not painted over it: the overlay
 *   is drawn first into its own buffer and records the cells it covers, and
 *   PTY rows skip those cells, so streaming output never paints under the
 *   escalation dialog.
 * - The tab bar, the footer and the overlay are sent when their bytes
 *   differ from what was last sent for them (the footer, for one, changes
 *   only with the flash, the pending count, the scroll offset or the label).
 *   An overlay is also sent after any PTY span on a row it covers. A full
 *   redraw or a resize sends every region again.
 *
 * Untrusted text. Everything the overlays show that did not originate in
 * this process -- tool arguments, escalation reasons, whitelist descriptions,
 * server and tool names, session labels, workspace paths, directory entries,
 * picker descriptions, error messages -- is agent-influenced and reaches the
 * user's real terminal. terminal-kit's styled calls (`term(...)`,
 * `term.cyan(...)`) pass control bytes through verbatim and interpret `^`
 * markup and `%` format specifiers, so raw text could move the cursor,
 * overwrite the lines above it, set the clipboard or hide itself. Every such
 * string therefore goes through {@link untrusted}: display-escape (controls,
 * C1, bidi and invisible characters become visible `\u...` escapes), cut to
 * a cell budget measured in display cells, then escape terminal-kit markup.
 * Only the PTY viewport bypasses this, because it re-renders xterm-headless
 * cells through `term.noFormat()` with SGR built by this module. A cell whose
 * host display width differs from xterm's width, or which contains invisible
 * formatting, is blanked within its recorded columns.
 *
 * Reviewer context. An escalation can carry the session's task and the
 * human's last trusted message (trusted, written by the human) and the
 * agent's justification (UNTRUSTED, written by the agent). The picker, the
 * detail view and the approve-all list label each for what it is: the
 * agent's text is always prefixed `Agent says (untrusted):` (in the detail
 * view: headed, after the arguments, behind a gutter) and escaped on one
 * line, so its line breaks never lay out rows of their own. See
 * trusted-process/escalation-context.ts.
 */

/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */

import { performance } from 'node:perf_hooks';
import type { Terminal as TerminalType } from '@xterm/headless';
import {
  calculateLayout,
  isPickerMode,
  isBottomPanelPicker,
  type InputMode,
  type Layout,
  type MuxTab,
  type PendingRef,
} from './types.js';
import type { ListenerState, PendingEscalation } from '../escalation/listener-state.js';
import type {
  PickerState,
  ResumePickerState,
  PersonaPickerState,
  ProviderPickerState,
  MessagePanelState,
} from './mux-input-handler.js';
import {
  bulkApprovalKey,
  decisionArmedAt,
  ESCALATION_ARMING_DELAY_MS,
  whitelistConfirmView,
  type BulkApproveGroup,
  type BulkApproveState,
  type DisplayedBulkApproval,
  type DisplayedEscalation,
  type EscalationPickerState,
  type EscalationView,
} from './escalation-picker-state.js';
import { directoryCandidateIndex, type WhitelistScope } from '../trusted-process/approval-whitelist.js';
import { createSplashScreen, type SplashScreen } from './mux-splash.js';
import { createFrameWriter, type FrameStream } from './frame-writer.js';
import { formatRelativeTime, getWorkspaceLabel } from '../pty/session-scanner.js';
import { escapeTerminalKitMarkup, toDisplayText } from '../terminal/display-sanitize.js';
import { displayWidth, fitsWidth, truncateToWidth, wrapToWidth } from '../terminal/display-width.js';
import { escalationGroupKey, groupMembers } from '../escalation/escalation-groups.js';
import { displayedUserMessage } from '../escalation/escalation-review.js';

// -- xterm.js color mode constants (from IBufferCell.getFgColorMode/getBgColorMode) --
const CM_DEFAULT = 0;
const CM_P16 = 16777216; // 0x01000000
const CM_P256 = 33554432; // 0x02000000
const CM_RGB = 50331648; // 0x03000000

/** Formatting must not join or reorder independently positioned PTY cells. */
const PTY_CELL_FORMAT = /[\p{Default_Ignorable_Code_Point}\p{Cf}]/u;

/** Color type compatible with terminal-kit ScreenBufferHD. */
export type TermkitColor = number | { r: number; g: number; b: number } | 'default';

/** A cell translated from xterm.js buffer to terminal-kit format. */
export interface TranslatedCell {
  readonly char: string;
  readonly width: number;
  readonly fg: TermkitColor;
  readonly bg: TermkitColor;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly dim: boolean;
  readonly inverse: boolean;
  readonly strikethrough: boolean;
}

/** A visual line produced by soft-wrapping the input buffer. */
export interface VisualLine {
  /** Content of this visual line (no trailing \n). */
  readonly text: string;
  /** Character offset in the original buffer where this visual line starts. */
  readonly bufferOffset: number;
}

/**
 * Splits the input buffer into visual lines by honoring hard newlines
 * and soft-wrapping at `contentWidth` characters.
 */
export function computeVisualLines(buffer: string, contentWidth: number): VisualLine[] {
  if (buffer.length === 0) {
    return [{ text: '', bufferOffset: 0 }];
  }

  const width = Math.max(1, contentWidth);
  const result: VisualLine[] = [];
  const logicalLines = buffer.split('\n');
  let offset = 0;

  for (let i = 0; i < logicalLines.length; i++) {
    const line = logicalLines[i];
    if (line.length === 0) {
      result.push({ text: '', bufferOffset: offset });
    } else {
      for (let j = 0; j < line.length; j += width) {
        result.push({ text: line.slice(j, j + width), bufferOffset: offset + j });
      }
    }
    // Account for the \n character between logical lines
    offset += line.length + 1;
  }

  return result;
}

/**
 * Maps a buffer cursor position to a visual row and column
 * within the visual lines array.
 */
export function cursorToVisualPosition(lines: VisualLine[], cursorPos: number): { row: number; col: number } {
  // Walk backwards through lines to find the last one whose bufferOffset <= cursorPos
  // and where cursorPos <= bufferOffset + text.length.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.bufferOffset <= cursorPos && cursorPos <= line.bufferOffset + line.text.length) {
      return { row: i, col: cursorPos - line.bufferOffset };
    }
  }
  // Fallback: end of last line
  const last = lines[lines.length - 1];
  return { row: lines.length - 1, col: last.text.length };
}

/** Minimum render interval (~60 FPS). */
const MIN_RENDER_INTERVAL_MS = 16;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TerminalKit = any;

export interface MuxRenderer {
  /** Full redraw of all regions. */
  fullRedraw(): void;
  /** Incremental redraw of only the PTY viewport. */
  redrawPty(): void;
  /** Redraws just the tab bar. */
  redrawTabBar(): void;
  /** Redraws the command area (escalation panel + hint bar + input). */
  redrawCommandArea(): void;
  /** Handles terminal resize. */
  resize(cols: number, rows: number): void;
  /** Cleans up resources. */
  destroy(): void;
  /** Schedule a throttled PTY redraw. */
  scheduleRedraw(): void;
  /**
   * Shows a transient message in the footer that auto-clears. The footer is
   * the last screen row, so the message is collapsed to its first line
   * (display-sanitized) plus `(+N more)`, and cut to the terminal width: a
   * line feed or wrap there would scroll the alternate screen and shift the
   * whole layout. Multi-line output belongs in the message panel.
   */
  showMessage(message: string): void;
  /** Current layout. */
  readonly layout: Layout;
  /**
   * The escalation whose picker dialog (summary, detail view or whitelist
   * confirmation) the latest overlay draw showed in full, with the view and
   * the time it has been on screen since, or null when it showed none: the
   * picker is closed, or the terminal was too small and a notice was drawn
   * instead. Approvals are accepted only for this escalation, once it has
   * been shown for the arming delay (MuxInputHandlerOptions.displayedEscalation).
   */
  readonly displayedEscalation: DisplayedEscalation | null;
  /**
   * The approve-all list the latest overlay draw showed, and since when
   * every line of it has been on screen; null when it was not drawn.
   * `y` approves only a list seen completely (MuxInputHandlerOptions.displayedBulkApproval).
   */
  readonly displayedBulkApproval: DisplayedBulkApproval | null;
}

export interface MuxRendererDeps {
  getActiveTab: () => MuxTab | undefined;
  getTabs: () => MuxTab[];
  getActiveTabIndex: () => number;
  getMode: () => InputMode;
  getInputBuffer: () => string;
  getCursorPos: () => number;
  getEscalationState: () => ListenerState;
  getPendingCount: () => number;
  getPickerState: () => PickerState | null;
  getResumePickerState: () => ResumePickerState | null;
  getPersonaPickerState: () => PersonaPickerState | null;
  getProviderPickerState: () => ProviderPickerState | null;
  getEscalationPickerState: () => EscalationPickerState | null;
  /** The approve-all confirmation screen's state. Omitted: never open. */
  getBulkApproveState?: () => BulkApproveState | null;
  getMessagePanelState: () => MessagePanelState | null;
  /** Returns the active tab's scroll offset (null = live/bottom). */
  getScrollOffset: () => number | null;
  /**
   * Monotonic clock in milliseconds, the same one the input handler uses
   * for the arming delay. Default `performance.now`.
   */
  now?: () => number;
  /** Arming delay in milliseconds, as given to the input handler. Default {@link ESCALATION_ARMING_DELAY_MS}. */
  armingDelayMs?: number;
}

/** Widest session label drawn in the tab bar and footer, in cells. */
const MAX_TAB_LABEL_WIDTH = 48;

/**
 * Trusted prefixes of the reason and whitelist rows: the command that adds
 * each pattern (the exact one, and the directory-wide one when offered).
 */
const REASON_PREFIX = 'Reason: ';
const WHITELIST_PREFIX = '/approve+ ';
const DIRECTORY_WHITELIST_PREFIX = '/approve+dir ';
/** Trusted prefixes of the reviewer-context rows (see the module comment). */
const TASK_PREFIX = 'Task: ';
const USER_MESSAGE_PREFIX = 'You said: ';
const JUSTIFICATION_PREFIX = 'Agent says (untrusted): ';
/** The detail view's heading for the agent's justification, and the gutter on each of its rows. */
const DETAIL_JUSTIFICATION_HEADING = 'Agent says (UNTRUSTED: written by the agent, it authorizes nothing):';
const DETAIL_JUSTIFICATION_GUTTER = '  │ ';

/** The trusted prefix a reviewer-context or reason/whitelist row is drawn with. */
function rowPrefix(
  kind: 'reason' | 'whitelist' | 'whitelist-directory' | 'task' | 'user-message' | 'justification',
): string {
  switch (kind) {
    case 'reason':
      return REASON_PREFIX;
    case 'whitelist':
      return WHITELIST_PREFIX;
    case 'whitelist-directory':
      return DIRECTORY_WHITELIST_PREFIX;
    case 'task':
      return TASK_PREFIX;
    case 'user-message':
      return USER_MESSAGE_PREFIX;
    case 'justification':
      return JUSTIFICATION_PREFIX;
  }
}

/**
 * Untrusted text for a styled terminal-kit call: display-escaped, cut to
 * `maxWidth` cells when given (an ellipsis marks the cut), then terminal-kit
 * markup-escaped. `toDisplayText` is idempotent on its own output, so text
 * that was sanitized earlier (for example by the row planners below) may pass
 * through again.
 */
function untrusted(text: string, maxWidth?: number): string {
  const shown = toDisplayText(text);
  return escapeTerminalKitMarkup(maxWidth === undefined ? shown : truncateToWidth(shown, maxWidth));
}

/** `server/tool` for an escalation, display-sanitized. */
function toolLabel(request: PendingEscalation['request']): string {
  return `${toDisplayText(request.serverName)}/${toDisplayText(request.toolName)}`;
}

/** A region of the screen drawn whole, and sent only when its bytes change. */
type ScreenRegion = 'tabBar' | 'footer' | 'overlay';

/** Columns `[from, to)` of a screen row that the overlay covers. */
interface CoveredSpan {
  readonly from: number;
  readonly to: number;
}

/**
 * What the PTY viewport rows were last drawn with: the bytes of each screen
 * row (with the span the overlay covered), valid for one tab, mode, scroll
 * position, width and viewport position.
 */
interface ViewportRows {
  readonly tab: MuxTab;
  readonly mode: InputMode;
  readonly scrollOffset: number | null;
  readonly cols: number;
  readonly top: number;
  readonly rows: Map<number, string>;
}

/**
 * Creates a MuxRenderer.
 */
export function createMuxRenderer(term: TerminalKit, cols: number, rows: number, deps: MuxRendererDeps): MuxRenderer {
  /** Pending escalations offering a directory-wide pattern: each needs one more panel row. */
  function directoryPatternCount(): number {
    let count = 0;
    for (const esc of deps.getEscalationState().pendingEscalations.values()) {
      if (directoryCandidate(esc) !== undefined) count++;
    }
    return count;
  }

  let _cols = cols;
  let _rows = rows;
  let _layout = calculateLayout(_rows, deps.getMode(), deps.getPendingCount(), 1, directoryPatternCount());

  // Render throttling
  let renderScheduled = false;
  let lastRenderTime = 0;
  let renderTimeout: ReturnType<typeof setTimeout> | null = null;
  let _destroyed = false;

  // Splash screen (shown when no tabs exist)
  let _splash: SplashScreen | null = null;

  // Multiline input scroll offset (first visible visual line index)
  let _inputScrollOffset = 0;

  // Cached visual lines from recalcLayout(), reused by drawCommandOverlay()
  let _cachedVisualLines: VisualLine[] = [{ text: '', bufferOffset: 0 }];

  // -- Frames and damage tracking (see the module comment) --
  const frames = createFrameWriter(term.stdout as FrameStream | undefined);
  /** The bytes last sent for each region that is drawn whole; identical bytes are not sent again. */
  const _regionBytes = new Map<ScreenRegion, string>();
  /** The cells the overlay of the current frame covers, by screen row: PTY rows skip them. */
  let _covered = new Map<number, CoveredSpan>();
  /** What the viewport rows show, for the tab, mode and scroll position they were drawn for. */
  let _viewport: ViewportRows | null = null;
  /** Where the frame leaves the (hidden) cursor: the agent's cursor, or the input line's. */
  let _frameCursor: { readonly x: number; readonly y: number } | null = null;

  const clock = deps.now ?? ((): number => performance.now());
  const armingDelayMs = deps.armingDelayMs ?? ESCALATION_ARMING_DELAY_MS;
  const getBulkApproveState = deps.getBulkApproveState ?? ((): BulkApproveState | null => null);

  // The escalation whose picker dialog the latest overlay draw showed in
  // full, and the one before it (an unbroken run keeps its `since`).
  let _displayedEscalation: DisplayedEscalation | null = null;
  let _previousDisplayedEscalation: DisplayedEscalation | null = null;

  // The approve-all list the latest overlay draw showed, and which of its
  // lines have been on screen while it stayed open at this width.
  let _displayedBulkApproval: DisplayedBulkApproval | null = null;
  let _bulkSeen: {
    readonly setKey: string;
    readonly width: number;
    readonly seen: Uint8Array;
    unseen: number;
    seenAllSince: number | null;
  } | null = null;
  const _bulkLinesCache = new WeakMap<BulkApproveState, { width: number; lines: readonly BulkApprovalLine[] }>();

  // Redraw when the shown "wait" hint expires, so the user sees the keys unlock.
  let _armingTimer: ReturnType<typeof setTimeout> | null = null;

  // Transient flash message
  let _flashMessage: string | null = null;
  let _flashTimeout: ReturnType<typeof setTimeout> | null = null;
  const FLASH_DURATION_MS = 3000;

  // Escalation formatting caches. A pending escalation never changes, but the
  // overlays are redrawn with every frame of PTY output and an argument can
  // be megabytes long, so its summary lines and its detail view are computed
  // once per escalation and width. Keyed weakly: resolved escalations drop out.
  const _argLinesCache = new WeakMap<PendingEscalation, Map<number, readonly ArgLine[]>>();
  const _detailLinesCache = new WeakMap<PendingEscalation, { width: number; lines: readonly string[] }>();

  function argLinesFor(esc: PendingEscalation, width: number): readonly ArgLine[] {
    let byWidth = _argLinesCache.get(esc);
    if (!byWidth) {
      byWidth = new Map();
      _argLinesCache.set(esc, byWidth);
    }
    let lines = byWidth.get(width);
    if (!lines) {
      if (byWidth.size >= 4) byWidth.clear(); // a few widths per escalation: panel, picker, recent resizes
      lines = formatArgLines(esc.request.arguments, width);
      byWidth.set(width, lines);
    }
    return lines;
  }

  function detailLinesFor(esc: PendingEscalation, width: number): readonly string[] {
    const cached = _detailLinesCache.get(esc);
    if (cached?.width === width) return cached.lines;
    const lines = formatEscalationDetailLines(esc, width);
    _detailLinesCache.set(esc, { width, lines });
    return lines;
  }

  function bulkLinesFor(bulk: BulkApproveState, width: number): readonly BulkApprovalLine[] {
    const cached = _bulkLinesCache.get(bulk);
    if (cached?.width === width) return cached.lines;
    const lines = formatBulkApprovalLines(
      bulk.reviewed,
      deps.getEscalationState().pendingEscalations,
      width,
      bulk.whitelist,
      bulk.group,
    );
    _bulkLinesCache.set(bulk, { width, lines });
    return lines;
  }

  /**
   * Records that this draw shows `esc` in full in `view`. The `since` of an
   * unbroken run of draws of the same escalation is kept; anything else
   * starts a new run, so a request that was off screen (a notice, another
   * escalation, a closed picker) must be on screen again for the arming
   * delay before it can be approved.
   */
  function markEscalationDisplayed(esc: PendingEscalation, view: EscalationView): DisplayedEscalation {
    const previous = _previousDisplayedEscalation;
    const continuing =
      previous !== null &&
      previous.displayNumber === esc.displayNumber &&
      previous.escalationId === esc.request.escalationId;
    const shown: DisplayedEscalation = {
      displayNumber: esc.displayNumber,
      escalationId: esc.request.escalationId,
      view,
      since: continuing ? previous.since : clock(),
      canWhitelist: firstCandidate(esc) !== undefined && esc.request.humanOnly !== true,
      canWhitelistDirectory: directoryCandidate(esc) !== undefined && esc.request.humanOnly !== true,
    };
    _displayedEscalation = shown;
    return shown;
  }

  /**
   * Marks the approve-all lines `[scroll, scroll + rows)` as seen and returns
   * since when every line has been. Changing the set or the width starts the
   * count again (wrapping changes which text is on which line).
   */
  function markBulkLinesSeen(
    bulk: BulkApproveState,
    width: number,
    lineCount: number,
    scroll: number,
    rows: number,
  ): DisplayedBulkApproval {
    const setKey = bulkApprovalKey(bulk.reviewed, bulk.whitelist);
    let seen = _bulkSeen;
    if (seen === null || seen.setKey !== setKey || seen.width !== width || seen.seen.length !== lineCount) {
      seen = { setKey, width, seen: new Uint8Array(lineCount), unseen: lineCount, seenAllSince: null };
      _bulkSeen = seen;
    }
    for (let i = scroll; i < Math.min(lineCount, scroll + rows); i++) {
      if (seen.seen[i] === 0) {
        seen.seen[i] = 1;
        seen.unseen -= 1;
      }
    }
    if (seen.unseen === 0 && seen.seenAllSince === null) seen.seenAllSince = clock();
    _displayedBulkApproval = { setKey, seenAllSince: seen.seenAllSince };
    return _displayedBulkApproval;
  }

  /**
   * Schedules a redraw for when a "wait" hint on screen expires (`at` on the
   * deps clock). Only the latest request counts: every disarmed draw asks
   * again, and a key that re-arms moves the time.
   */
  function scheduleArmingRedraw(at: number): void {
    if (_destroyed) return;
    if (_armingTimer) clearTimeout(_armingTimer);
    const delay = Math.max(0, Math.ceil(at - clock())) + 2;
    _armingTimer = setTimeout(() => {
      _armingTimer = null;
      if (_destroyed) return;
      frame(() => {
        recalcLayout();
        drawBody(false);
      });
    }, delay);
    _armingTimer.unref();
  }

  /** A key hint: the key as a badge, then what it does. */
  type KeyHint = readonly [key: string, label: string];

  /**
   * Draws key hints left to right within `width` cells, skipping any that
   * would not fit (so put the ones that must stay, like Esc, early). Returns
   * the cells used. Labels are trusted literals.
   */
  function drawKeyHints(hints: readonly KeyHint[], width: number): number {
    let used = 0;
    for (const [key, label] of hints) {
      const badge = ` ${key} `;
      const text = ` ${label} `;
      const cells = displayWidth(badge) + displayWidth(text);
      if (used + cells > width) continue;
      term.bgWhite.black(badge);
      term.styleReset();
      term.dim(text);
      used += cells;
    }
    term.styleReset();
    return used;
  }

  /** The "wait" badge shown while decision keys are still disarmed, then `note`. Returns the cells used. */
  function drawWaitHint(note: string, width: number): number {
    const badge = ' wait ';
    const text = note ? ` ${note} ` : ' ';
    const cells = displayWidth(badge) + displayWidth(text);
    if (cells > width) return 0;
    term.bgYellow.black(badge);
    term.styleReset();
    term.dim(text);
    term.styleReset();
    return cells;
  }

  /** Content width for the input area: _cols minus 2-char left margin minus 2-char prompt prefix. */
  function contentWidth(): number {
    return Math.max(1, _cols - 4);
  }

  function recalcLayout(): void {
    if (deps.getMode() === 'command') {
      _cachedVisualLines = computeVisualLines(deps.getInputBuffer(), contentWidth());
    } else {
      _cachedVisualLines = [{ text: '', bufferOffset: 0 }];
      _inputScrollOffset = 0;
    }
    _layout = calculateLayout(
      _rows,
      deps.getMode(),
      deps.getPendingCount(),
      _cachedVisualLines.length,
      directoryPatternCount(),
    );
  }

  function moveTo(x: number, y: number): void {
    term.moveTo(x + 1, y + 1); // terminal-kit is 1-indexed
  }

  function clearLine(y: number): void {
    moveTo(0, y);
    term.eraseLine();
  }

  /** Forgets what is on screen: everything is sent again (after a clear or a resize). */
  function invalidateScreen(): void {
    _regionBytes.clear();
    _viewport = null;
  }

  /**
   * Runs one frame: one synchronized write of everything `draw` sends,
   * ending with the cursor where the frame wants it. A draw that throws
   * sends nothing, and nothing cached about the screen can be trusted.
   * Nor does anything count as displayed: the overlay is drawn (and an
   * escalation dialog or approve-all list recorded as shown) before the
   * rest of the frame, so a frame that fails later never reached the
   * terminal, and its dialog must not arm a decision key or carry its
   * `since` into the next frame.
   */
  function frame(draw: () => void): void {
    try {
      frames.frame(draw, () => {
        if (_frameCursor) moveTo(_frameCursor.x, _frameCursor.y);
      });
    } catch (err) {
      invalidateScreen();
      _displayedEscalation = null;
      _previousDisplayedEscalation = null;
      _displayedBulkApproval = null;
      _bulkSeen = null;
      throw err;
    }
  }

  /** Adds a region's bytes to the frame unless exactly these bytes were last sent for it. */
  function emitRegion(region: ScreenRegion, bytes: string): void {
    if (_regionBytes.get(region) === bytes) return;
    _regionBytes.set(region, bytes);
    frames.append(bytes);
  }

  /** Draws a region into its own buffer and sends it only when it changed (see {@link emitRegion}). */
  function drawRegion(region: ScreenRegion, draw: () => void): void {
    emitRegion(region, frames.capture(draw));
  }

  /** Records that the overlay covers columns `[from, to)` of screen row `y`. */
  function cover(y: number, from: number, to: number): void {
    const start = Math.max(0, from);
    const end = Math.min(_cols, to);
    if (end <= start) return;
    const previous = _covered.get(y);
    _covered.set(
      y,
      previous ? { from: Math.min(previous.from, start), to: Math.max(previous.to, end) } : { from: start, to: end },
    );
  }

  /**
   * The PTY viewport and the active overlay, composed: the overlay is drawn
   * first into its own buffer, recording the cells it covers; the viewport
   * rows then skip those cells; the footer (when asked) and the overlay
   * follow. The overlay is also sent when a covered row emitted PTY spans,
   * restoring its cells after those spans in the same synchronized frame.
   */
  function drawBody(withFooter: boolean): void {
    _covered = new Map();
    _frameCursor = null;
    const overlay = frames.capture(drawActiveOverlay);
    drawPtyViewport();
    if (withFooter) drawRegion('footer', drawFooter);
    emitRegion('overlay', overlay);
  }

  function drawTabBar(): void {
    clearLine(_layout.tabBarY);
    moveTo(0, _layout.tabBarY);

    const tabs = deps.getTabs();
    const activeIdx = deps.getActiveTabIndex();

    for (let i = 0; i < tabs.length; i++) {
      const tab = tabs[i];
      const isActive = i === activeIdx;
      const label = ` #${tab.number} ${untrusted(tab.label, MAX_TAB_LABEL_WIDTH)} `;

      if (isActive) {
        term.bgWhite.black(label);
      } else {
        term.bgDefaultColor.dim(label);
      }
    }

    // Escalation badge
    const pendingCount = deps.getPendingCount();
    if (pendingCount > 0) {
      const badge = ` [!${pendingCount} pending] `;
      const badgeX = Math.max(0, _cols - badge.length);
      moveTo(badgeX, _layout.tabBarY);
      term.bgYellow.black(badge);
    }

    term.styleReset();
    term.eraseLineAfter();
  }

  function tearDownSplash(): void {
    if (_splash) {
      _splash.stop();
      _splash = null;
    }
  }

  /** Returns the number of viewport rows reserved by the current overlay. */
  function activeOverlayRows(): number {
    const mode = deps.getMode();
    if (mode === 'command') return _layout.overlayRows;
    // Escalation picker floats over the full viewport -- no rows reserved.
    if (isBottomPanelPicker(mode)) return _layout.pickerRows;
    return 0;
  }

  function drawPtyViewport(): void {
    const activeTab = deps.getActiveTab();
    if (!activeTab) {
      // The splash (or the blanked viewport) may draw where an overlay is:
      // nothing cached about these rows or the overlay holds.
      _viewport = null;
      _regionBytes.delete('overlay');
      if (deps.getTabs().length === 0) {
        const reserved = activeOverlayRows();
        // Lazily create and start the splash screen
        if (!_splash) {
          _splash = createSplashScreen(term, _cols, _layout.ptyViewportRows, _layout.ptyViewportY, reserved);
          _splash.start();
        } else {
          // Update reserved rows in case mode changed (e.g. command -> picker)
          _splash.resize(_cols, _layout.ptyViewportRows, _layout.ptyViewportY, reserved);
        }
        _splash.draw();
      } else {
        tearDownSplash();
        for (let y = _layout.ptyViewportY; y < _layout.ptyViewportY + _layout.ptyViewportRows; y++) {
          clearLine(y);
        }
      }
      return;
    }

    tearDownSplash();

    const xtermTerminal = activeTab.bridge.terminal;
    const baseY = xtermTerminal.buffer.active.baseY;
    const scrollOffset = deps.getScrollOffset();
    const readFrom = scrollOffset ?? baseY;

    // Determine how many rows to render (skip overlay in command/bottom-panel picker mode).
    // Escalation picker floats over the full viewport -- no rows subtracted;
    // its rows skip the cells the dialog covers instead.
    const mode = deps.getMode();
    let visibleRows = _layout.ptyViewportRows;
    if (mode === 'command') visibleRows -= _layout.overlayRows;
    else if (isBottomPanelPicker(mode)) visibleRows -= _layout.pickerRows;
    visibleRows = Math.max(0, visibleRows);

    const viewport = viewportRowsFor(activeTab, mode, scrollOffset);
    const cells = readTerminalBuffer(xtermTerminal, readFrom, visibleRows, _cols);
    const top = _layout.ptyViewportY;
    for (let y = 0; y < visibleRows; y++) {
      drawViewportRow(viewport, top + y, cells[y]);
    }
    // Rows an overlay took over: forget them, so they are repainted once they
    // are PTY rows again.
    for (const screenY of [...viewport.rows.keys()]) {
      if (screenY < top || screenY >= top + visibleRows) viewport.rows.delete(screenY);
    }

    // Leave the cursor where xterm.js says it is (only when at live viewport)
    if (mode === 'pty' && scrollOffset === null) {
      const buffer = xtermTerminal.buffer.active;
      _frameCursor = { x: buffer.cursorX, y: top + buffer.cursorY };
    }
  }

  /**
   * The row cache for `tab` drawn in `mode` at `scrollOffset`: a new, empty
   * one when any of them, the width or the viewport's position changed.
   */
  function viewportRowsFor(tab: MuxTab, mode: InputMode, scrollOffset: number | null): ViewportRows {
    const current = _viewport;
    if (
      current?.tab === tab &&
      current.mode === mode &&
      current.scrollOffset === scrollOffset &&
      current.cols === _cols &&
      current.top === _layout.ptyViewportY
    ) {
      return current;
    }
    _viewport = { tab, mode, scrollOffset, cols: _cols, top: _layout.ptyViewportY, rows: new Map() };
    return _viewport;
  }

  /**
   * Draws one PTY row at screen row `screenY`, skipping the cells the
   * overlay covers, unless the same bytes were drawn there last time.
   */
  function drawViewportRow(viewport: ViewportRows, screenY: number, row: readonly TranslatedCell[]): void {
    const covered = _covered.get(screenY);
    if (covered && covered.from <= 0 && covered.to >= _cols) {
      // The overlay draws this whole row.
      viewport.rows.delete(screenY);
      return;
    }
    if (!covered) {
      const { text, end } = renderCellSpan(row, 0, _cols);
      if (viewport.rows.get(screenY) === text) return;
      viewport.rows.set(screenY, text);
      moveTo(0, screenY);
      term.noFormat(`${text}\x1b[0m`); // reset before eraseLineAfter
      // A row that fills the width needs no erase (with autowrap off, an
      // erase there could also take the character in the last column).
      if (end < _cols) term.eraseLineAfter();
      return;
    }
    const left = covered.from > 0 ? renderCellSpan(row, 0, covered.from) : undefined;
    const right = covered.to < _cols ? renderCellSpan(row, covered.to, _cols) : undefined;
    const key = `${covered.from}:${covered.to}\u0000${left?.text ?? ''}\u0000${right?.text ?? ''}`;
    if (viewport.rows.get(screenY) === key) return;
    viewport.rows.set(screenY, key);
    // A changed PTY span shares this row with the overlay. Restore the
    // overlay after the span even when its own bytes have not changed.
    _regionBytes.delete('overlay');
    if (left) {
      // Padded to the overlay's edge: erasing to the end of the line would wipe it.
      moveTo(0, screenY);
      term.noFormat(`${left.text}\x1b[0m${' '.repeat(Math.max(0, covered.from - left.end))}`);
    }
    if (right) {
      moveTo(covered.to, screenY);
      term.noFormat(`${right.text}\x1b[0m`);
      if (right.end < _cols) term.eraseLineAfter();
    }
  }

  function drawFooter(): void {
    const row1 = _layout.footerY;
    const row2 = _layout.footerY + 1;

    clearLine(row1);
    clearLine(row2);

    const activeTab = deps.getActiveTab();
    const mode = deps.getMode();
    const pendingCount = deps.getPendingCount();

    if (mode === 'pty') {
      // Row 1: status — tab label left, scroll indicator + escalation badge right
      moveTo(0, row1);
      const tabLabel = activeTab
        ? `PTY #${activeTab.number} ${untrusted(activeTab.label, MAX_TAB_LABEL_WIDTH)}`
        : 'No session';
      term.dim(`  [${tabLabel}]`);

      // Right-aligned badges: scroll indicator + escalation badge
      const scrollOffset = deps.getScrollOffset();
      const scrollBadge =
        scrollOffset !== null && activeTab
          ? ` [\u2191 ${activeTab.bridge.terminal.buffer.active.baseY - scrollOffset} lines] `
          : '';
      const escalationBadge = pendingCount > 0 ? ` [!${pendingCount} pending] ` : '';
      const rightContent = scrollBadge + escalationBadge;

      if (rightContent.length > 0) {
        moveTo(Math.max(0, _cols - rightContent.length), row1);
        if (scrollBadge) term.cyan(scrollBadge);
        if (escalationBadge) {
          term.bgYellow.black(escalationBadge);
          term.styleReset();
        }
      }
      term.eraseLineAfter();

      // Row 2: flash message, the pending-escalation banner, or guidance
      moveTo(0, row2);
      if (_flashMessage) {
        drawFlashMessage(_flashMessage);
      } else if (pendingCount > 0) {
        drawPendingBanner('Ctrl-E to review');
      } else {
        term('  ');
        term.bgWhite.black(' ^^A ');
        term.styleReset();
        const hint = ' command mode \u00b7 type a message to enable auto-approver \u00b7 Shift+drag to select';
        // The badge took 7 cells. Nothing may reach the last column of the
        // bottom row: a wrap there scrolls the alternate screen.
        term.dim(truncateToWidth(hint, Math.max(0, _cols - 8)));
      }
      term.styleReset();
      term.eraseLineAfter();
    } else {
      // Row 1: command mode — badge-style keys
      moveTo(0, row1);
      term('  ');
      term.bgWhite.black(' CMD ');
      term('  ');
      term.bgWhite.black(' ^^A ');
      term.styleReset();
      term.dim(' pty  ');
      term.bgWhite.black(' Esc ');
      term.styleReset();
      term.dim(' clear');
      term.eraseLineAfter();

      // Row 2: flash message, the pending-escalation banner while another
      // picker or panel holds the keyboard (the command-mode panel and the
      // escalation screens show the escalations themselves), or the hint
      moveTo(0, row2);
      if (_flashMessage) {
        drawFlashMessage(_flashMessage);
      } else if (
        pendingCount > 0 &&
        mode !== 'command' &&
        mode !== 'escalation-picker' &&
        mode !== 'escalation-approve-all'
      ) {
        drawPendingBanner('Esc out, then Ctrl-E to review');
      } else {
        term.dim(truncateToWidth('  type a message to send as trusted input to the agent', Math.max(0, _cols - 1)));
      }
      term.styleReset();
      term.eraseLineAfter();
    }
  }

  /**
   * Draws the (already single-line, display-sanitized) flash message on the
   * bottom row, cut so it can never reach the last column: a wrap there would
   * scroll the alternate screen.
   */
  function drawFlashMessage(message: string): void {
    term.yellow(escapeTerminalKitMarkup(truncateToWidth(`  ${message}`, Math.max(0, _cols - 3))));
  }

  /**
   * The footer banner announcing pending escalations: how many, the newest
   * one's number and tool, and how to review them. An arrival never takes
   * the keyboard; this banner, the bell and the `[!N pending]` badge are
   * how it is announced. Cut before the last column like the flash.
   */
  function drawPendingBanner(howToReview: string): void {
    const pending = [...deps.getEscalationState().pendingEscalations.values()];
    if (pending.length === 0) return;
    const newest = pending.reduce((a, b) => (b.displayNumber > a.displayNumber ? b : a));
    const what = `[${newest.displayNumber}] ${toolLabel(newest.request)}`;
    const text =
      pending.length === 1
        ? ` ! Escalation ${what} is waiting for your decision · ${howToReview} `
        : ` ! ${pending.length} escalations pending, newest ${what} · ${howToReview} `;
    term('  ');
    term.bgYellow.black(escapeTerminalKitMarkup(truncateToWidth(text, Math.max(0, _cols - 3))));
    term.styleReset();
  }

  function drawCommandOverlay(): void {
    if (deps.getMode() !== 'command') return;
    const startY = _layout.overlayY;

    let currentY = startY;

    // Escalation panel. Rows are planned first so the tool header, the reason
    // and the whitelist line of every shown escalation are always drawn;
    // arguments that do not fit are reported, never silently dropped.
    if (_layout.escalationPanelRows > 0) {
      const pendingEscalations = [...deps.getEscalationState().pendingEscalations.values()].sort(
        (a, b) => a.displayNumber - b.displayNumber,
      );
      const argWidth = Math.max(1, _cols - 6);
      const rows = planEscalationPanelRows(pendingEscalations, _layout.escalationPanelRows, argWidth, (esc) =>
        argLinesFor(esc, argWidth),
      );
      for (const row of rows) {
        clearLine(currentY);
        if (row.kind === 'header') {
          moveTo(2, currentY);
          const number = `[${row.displayNumber}]`;
          const session = ` Session #${row.sessionDisplayNumber}  `;
          term.yellow(number);
          term(session);
          term.cyan(untrusted(row.tool, Math.max(1, _cols - 2 - number.length - session.length)));
        } else {
          moveTo(6, currentY);
          drawEscalationRow(row, _cols - 6);
        }
        currentY++;
      }
      // Keep the panel's full height: rows the plan left unused stay blank.
      for (let i = rows.length; i < _layout.escalationPanelRows; i++) {
        clearLine(currentY);
        currentY++;
      }
    }

    // Hint bar
    clearLine(currentY);
    moveTo(2, currentY);
    const pendingCount = deps.getPendingCount();
    if (pendingCount > 0) {
      // `/approve all` is not advertised: it only opens a confirmation
      // screen, and reviewing one at a time (Ctrl-E) is the way to decide.
      term.cyan('/approve');
      term.dim(' N  ');
      term.cyan('/approve+');
      term.dim(' N  ');
      term.cyan('/deny');
      term.dim(' N  ');
      term.cyan('/deny all');
      term.dim('  ');
      term.cyan('Ctrl-E');
      term.dim(' review \u2502 ');
      term.cyan('/new');
      term.dim('  ');
      term.cyan('/quit');
    } else {
      term.cyan('/new');
      term.dim('  ');
      term.cyan('/resume');
      term.dim('  ');
      term.cyan('/tab');
      term.dim(' N  ');
      term.cyan('/close');
      term.dim('  ');
      term.cyan('/sessions');
      term.dim('  ');
      term.cyan('/quit');
    }
    term.styleReset();
    currentY++;

    // Multiline input area (visual lines cached by recalcLayout)
    const cp = deps.getCursorPos();
    const visualLines = _cachedVisualLines;
    const cursorVis = cursorToVisualPosition(visualLines, cp);
    const allocatedRows = _layout.inputLineRows;

    // Adjust scroll to keep cursor visible
    if (cursorVis.row < _inputScrollOffset) {
      _inputScrollOffset = cursorVis.row;
    } else if (cursorVis.row >= _inputScrollOffset + allocatedRows) {
      _inputScrollOffset = cursorVis.row - allocatedRows + 1;
    }

    // Render each visible visual line
    for (let i = 0; i < allocatedRows; i++) {
      const visLineIdx = _inputScrollOffset + i;
      clearLine(currentY);
      moveTo(2, currentY);

      // Prompt: "> " on the first visual line, "  " on continuation lines
      if (visLineIdx === 0) {
        term('> ');
      } else {
        term('  ');
      }

      // The buffer is user-typed or pasted text, so `^`, `%` and pasted
      // control characters must print literally rather than as markup.
      if (visLineIdx < visualLines.length) {
        const vLine = visualLines[visLineIdx];
        if (visLineIdx === cursorVis.row) {
          // This line contains the cursor
          term(untrusted(vLine.text.slice(0, cursorVis.col)));
          term.bgWhite.black(untrusted(cursorVis.col < vLine.text.length ? vLine.text[cursorVis.col] : ' '));
          term.styleReset();
          term(untrusted(vLine.text.slice(cursorVis.col + 1)));
        } else {
          term(untrusted(vLine.text));
        }
      } else if (i === 0) {
        // Empty buffer: show cursor on blank line
        term.bgWhite.black(' ');
        term.styleReset();
      }

      term.eraseLineAfter();
      currentY++;
    }

    // Position real terminal cursor for accessibility (the frame ends there)
    const cursorScreenRow = startY + _layout.escalationPanelRows + 1 + (cursorVis.row - _inputScrollOffset);
    _frameCursor = { x: 2 + 2 + cursorVis.col, y: cursorScreenRow };
    moveTo(_frameCursor.x, _frameCursor.y);
  }

  /**
   * Draws one planned escalation row (everything but the header) at the
   * current cursor position within `width` cells. Row texts are already
   * display-sanitized; prefixes are trusted literals.
   */
  function drawEscalationRow(row: Exclude<EscalationRow, { kind: 'header' }>, width: number): void {
    switch (row.kind) {
      case 'args-label':
        term.dim(untrusted(row.text, width));
        break;
      case 'arg':
        term(untrusted(row.text, width));
        break;
      case 'hidden':
      case 'more':
        term.dim(untrusted(row.text, width));
        break;
      case 'reason':
        term.dim(REASON_PREFIX);
        term.styleReset();
        term(untrusted(row.text, Math.max(1, width - REASON_PREFIX.length)));
        break;
      case 'whitelist':
        term.dim(WHITELIST_PREFIX);
        term.styleReset();
        term.cyan(untrusted(row.text, Math.max(1, width - WHITELIST_PREFIX.length)));
        break;
      case 'whitelist-directory':
        term.dim(DIRECTORY_WHITELIST_PREFIX);
        term.styleReset();
        term.cyan(untrusted(row.text, Math.max(1, width - DIRECTORY_WHITELIST_PREFIX.length)));
        break;
      case 'task':
      case 'user-message':
        term.green(rowPrefix(row.kind));
        term.styleReset();
        term(untrusted(row.text, Math.max(1, width - rowPrefix(row.kind).length)));
        break;
      case 'justification':
        term.yellow(JUSTIFICATION_PREFIX);
        term.styleReset();
        term.dim(untrusted(row.text, Math.max(1, width - JUSTIFICATION_PREFIX.length)));
        break;
      case 'group':
        term.dim(untrusted(row.text, width));
        break;
    }
    term.styleReset();
  }

  /**
   * Draws a single row of the escalation dialog box at the given screen
   * position, wrapped in box-drawing side borders. Content is rendered
   * by the `renderContent` callback which receives the inner width.
   */
  function drawBoxRow(y: number, boxX: number, innerWidth: number, renderContent: (w: number) => void): void {
    cover(y, boxX, boxX + innerWidth + 4);
    moveTo(boxX, y);
    term.brightCyan('\u2502');
    term(' ');
    // Clear the full inner area with spaces first to avoid stale characters
    // from previous redraws. We cannot use eraseLineAfter because that would
    // wipe PTY content to the right of the floating overlay.
    term(' '.repeat(innerWidth));
    // Move back and render content over the cleared area
    moveTo(boxX + 2, y);
    renderContent(innerWidth);
    moveTo(boxX + innerWidth + 2, y);
    term(' ');
    term.brightCyan('\u2502');
  }

  /** Geometry of the escalation box: centered, inner width clamped to the terminal. */
  function escalationBoxGeometry(): { innerWidth: number; boxWidth: number; boxX: number } | null {
    // Horizontal sizing: leave 3-column margin on each side, max 80 inner width.
    // Clamp to available columns so we never draw past the right edge.
    const boxMargin = 3;
    const maxInnerWidth = 80;
    const minBoxWidth = 12; // absolute minimum to show anything useful
    const innerWidth = Math.min(maxInnerWidth, Math.max(minBoxWidth - 4, _cols - boxMargin * 2 - 4));
    const boxWidth = innerWidth + 4; // 4 = border + space on each side
    if (boxWidth > _cols) return null; // terminal too narrow for overlay
    const boxX = Math.max(0, Math.floor((_cols - boxWidth) / 2));
    return { innerWidth, boxWidth, boxX };
  }

  function drawBoxTopBorder(y: number, boxX: number, boxWidth: number, title: string): void {
    cover(y, boxX, boxX + boxWidth);
    moveTo(boxX, y);
    const shownTitle = truncateToWidth(title, Math.max(0, boxWidth - 2));
    const borderAfterTitle = Math.max(0, boxWidth - 2 - displayWidth(shownTitle));
    term.brightCyan('┌' + escapeTerminalKitMarkup(shownTitle));
    term.brightCyan('─'.repeat(borderAfterTitle) + '┐');
    term.styleReset();
  }

  /**
   * Shown instead of the escalation dialog when the terminal cannot hold the
   * rows it must never drop (tool, reason, whitelist line, argument notice):
   * a dialog with those rows missing would pass for a complete one. The
   * escalation is then not displayed, so `a` and `w` do nothing until it is:
   * in a larger terminal, or in the scrollable detail view (`v`), which needs
   * fewer rows.
   */
  function drawEscalationTooSmallNotice(focused: PendingEscalation): void {
    drawTooSmallNotice(
      ` Escalation [${focused.displayNumber}] pending: the terminal is too small to show it. Enlarge it or press v to view it; d denies, Esc dismisses. `,
    );
  }

  /** One highlighted row in the middle of the viewport, cut before the last column. */
  function drawTooSmallNotice(notice: string): void {
    const y = _layout.ptyViewportY + Math.floor((_layout.ptyViewportRows - 1) / 2);
    cover(y, 0, _cols);
    clearLine(y);
    moveTo(0, y);
    term.bgYellow.black(escapeTerminalKitMarkup(truncateToWidth(notice, Math.max(1, _cols - 1))));
    term.styleReset();
  }

  function drawBoxSeparator(y: number, boxX: number, innerWidth: number): void {
    drawBoxRow(y, boxX, innerWidth, (w) => {
      term.dim('─'.repeat(w));
      term.styleReset();
    });
  }

  function drawBoxBottomBorder(y: number, boxX: number, boxWidth: number): void {
    cover(y, boxX, boxX + boxWidth);
    moveTo(boxX, y);
    term.brightCyan('└' + '─'.repeat(boxWidth - 2) + '┘');
    term.styleReset();
  }

  /** `Session #N  server/tool  12s ago`, shrinking the tool name and then the time to fit `w` cells. */
  function drawEscalationToolHeader(focused: PendingEscalation, w: number): void {
    const timeAgo = formatRelativeTime(focused.receivedAt.toISOString());
    const sessionPrefix = `Session #${focused.sessionDisplayNumber}  `;
    const toolName = toolLabel(focused.request);
    const timeSuffix = `  ${timeAgo}`;
    const totalLen = sessionPrefix.length + displayWidth(toolName) + timeSuffix.length;

    if (totalLen <= w) {
      // Everything fits
      term(sessionPrefix);
      term.cyan(escapeTerminalKitMarkup(toolName));
      term.dim(timeSuffix);
    } else {
      // Truncate the tool name to fit; drop time suffix if still too long
      const budgetForTool = w - sessionPrefix.length - timeSuffix.length;
      if (budgetForTool >= 4) {
        term(sessionPrefix);
        term.cyan(untrusted(toolName, budgetForTool));
        term.dim(timeSuffix);
      } else {
        // Not enough room for time suffix -- drop it entirely
        const toolBudget = w - sessionPrefix.length;
        if (toolBudget > 0) {
          term(sessionPrefix);
          term.cyan(untrusted(toolName, toolBudget));
        } else {
          term(truncate(sessionPrefix, w));
        }
      }
    }
    term.styleReset();
  }

  function drawEscalationPickerOverlay(): void {
    const eps = deps.getEscalationPickerState();
    if (!eps) return;

    const pending = deps.getEscalationState().pendingEscalations;
    const sortedEscalations = [...pending.values()].sort((a, b) => a.displayNumber - b.displayNumber);
    if (sortedEscalations.length === 0) return;

    // A focus that names another request than the one pending under its
    // number draws nothing, so nothing can be decided on it.
    const focused = pending.get(eps.focusedDisplayNumber);
    if (focused?.request.escalationId !== eps.focusedEscalationId) return;

    const geometry = escalationBoxGeometry();
    if (!geometry) {
      drawEscalationTooSmallNotice(focused);
      return;
    }

    if (eps.whitelistConfirm) {
      drawWhitelistConfirmation(focused, eps, eps.whitelistConfirm, geometry);
      return;
    }

    if (eps.detailView) {
      drawEscalationDetailView(focused, eps, eps.detailView, geometry);
      return;
    }

    const { innerWidth, boxWidth, boxX } = geometry;

    // Compute dialog dimensions -- centered in the PTY viewport
    const viewportRows = _layout.ptyViewportRows;
    const viewportY = _layout.ptyViewportY;

    // Content rows: tab bar + separator + header + separator + detail area + separator + hint bar.
    // The detail area is planned, not clipped: the reason, the whitelist line
    // and the argument notice are reserved and hidden arguments are reported.
    // It gets the rows the viewport can spare, giving up the 2-row top/bottom
    // margin before giving up content.
    const fixedContentRows = 6;
    const borderRows = 2;
    const withMargin = Math.max(0, viewportRows - borderRows - fixedContentRows - 4);
    const withoutMargin = Math.max(0, viewportRows - borderRows - fixedContentRows);
    const argLines = argLinesFor(focused, Math.max(1, innerWidth - 2));
    const groupSize = pendingGroupSize(focused, sortedEscalations);
    const wanted = planEscalationDetailRows(focused, Number.MAX_SAFE_INTEGER, innerWidth, argLines, groupSize).length;
    const detailBudget = wanted <= withMargin ? wanted : Math.min(wanted, withoutMargin);
    const detailRows = planEscalationDetailRows(focused, detailBudget, innerWidth, argLines, groupSize);

    const totalBoxHeight = fixedContentRows + detailRows.length + borderRows;
    if (totalBoxHeight > viewportRows) {
      drawEscalationTooSmallNotice(focused);
      return;
    }

    // The whole dialog fits and is drawn below.
    const shown = markEscalationDisplayed(focused, 'summary');
    const unlockAt = decisionArmedAt(eps.armedAt, shown.since, armingDelayMs);

    // Vertical centering within the viewport
    const startY = viewportY + Math.max(0, Math.floor((viewportRows - totalBoxHeight) / 2));

    let currentY = startY;

    // Anything the summary had to cut (hidden or shortened arguments, a long
    // reason or whitelist pattern) is announced where it cannot be missed.
    // The widths match drawEscalationRow's cuts; fitsWidth reads only the
    // head of a long reason or pattern, since this runs on every frame.
    const summaryCut = detailRows.some(
      (row) =>
        (row.kind === 'args-label' && row.text !== 'Arguments:') ||
        ((row.kind === 'reason' ||
          row.kind === 'whitelist' ||
          row.kind === 'whitelist-directory' ||
          row.kind === 'task' ||
          row.kind === 'user-message' ||
          row.kind === 'justification') &&
          !fitsWidth(row.text, Math.max(1, innerWidth - rowPrefix(row.kind).length))),
    );
    drawBoxTopBorder(currentY, boxX, boxWidth, summaryCut ? ' Escalation (truncated: v shows all) ' : ' Escalation ');
    currentY++;

    // Escalation tab bar
    drawBoxRow(currentY, boxX, innerWidth, (w) => {
      const tabs = sortedEscalations.map((esc) => ({
        displayNumber: esc.displayNumber,
        label: `[${esc.displayNumber}] ${toolLabel(esc.request)}`,
      }));
      const fitted = fitTabLabels(tabs, eps.focusedDisplayNumber, w);
      let written = 0;
      for (const tab of fitted) {
        const cell = ' ' + tab.label + ' ';
        if (tab.isFocused) {
          term.bgCyan.black(escapeTerminalKitMarkup(cell));
        } else {
          term.dim(escapeTerminalKitMarkup(cell));
        }
        term.styleReset();
        written += displayWidth(cell);
      }
      const pad = Math.max(0, w - written);
      if (pad > 0) term(' '.repeat(pad));
    });
    currentY++;

    drawBoxSeparator(currentY, boxX, innerWidth);
    currentY++;

    drawBoxRow(currentY, boxX, innerWidth, (w) => {
      drawEscalationToolHeader(focused, w);
    });
    currentY++;

    drawBoxSeparator(currentY, boxX, innerWidth);
    currentY++;

    // Detail rows — drawBoxRow pre-clears the inner area with spaces and
    // handles right-border positioning, so callbacks only need to write
    // content (no manual padding required).
    for (const row of detailRows) {
      drawBoxRow(currentY, boxX, innerWidth, (w) => {
        const indent = row.kind === 'arg' ? 2 : 0;
        if (indent > 0) term(' '.repeat(indent));
        if (row.kind !== 'header') drawEscalationRow(row, w - indent);
      });
      currentY++;
    }

    drawBoxSeparator(currentY, boxX, innerWidth);
    currentY++;

    // Hint bar. While the picker is disarmed (just opened, focus just moved,
    // a stray key) it says so instead of offering the decision keys. There
    // is no approve-all key: `/approve all` opens a confirmation screen.
    const multiple = sortedEscalations.length > 1;
    drawBoxRow(currentY, boxX, innerWidth, (w) => {
      const navigation: KeyHint[] = multiple ? [['←→', 'switch']] : [];
      if (clock() < unlockAt) {
        const used = drawWaitHint('decision keys unlock in a moment', w);
        drawKeyHints([['Esc', 'dismiss'], ...navigation, ['v', 'view']], w - used);
        scheduleArmingRedraw(unlockAt);
        return;
      }
      const hints: KeyHint[] = [
        ['a', 'approve'],
        ['d', 'deny'],
      ];
      if (shown.canWhitelist) hints.push(['w', 'approve+']);
      if (shown.canWhitelistDirectory) hints.push(['W', 'approve+dir']);
      if (multiple) hints.push(['D', 'deny all']);
      // Esc before the optional view hint: when space runs out, `v` goes first
      // (the arguments row and the title already point to it).
      hints.push(...navigation, ['Esc', 'dismiss'], ['v', 'view']);
      drawKeyHints(hints, w);
    });
    currentY++;

    drawBoxBottomBorder(currentY, boxX, boxWidth);
  }

  /**
   * `w` or `W` was pressed: the box shows the complete whitelist pattern of
   * `scope` (`exact`: the one `/approve+` selects; `directory`: the
   * directory-wide one `/approve+dir` selects, introduced as reaching every
   * file and subdirectory) and asks for `y`. When the pattern cannot be
   * shown in full, a notice replaces the box and nothing counts as
   * displayed, so `y` cannot whitelist a pattern the user did not see.
   */
  function drawWhitelistConfirmation(
    focused: PendingEscalation,
    eps: EscalationPickerState,
    scope: WhitelistScope,
    geometry: { innerWidth: number; boxWidth: number; boxX: number },
  ): void {
    const { innerWidth, boxWidth, boxX } = geometry;
    const candidate = scope === 'directory' ? directoryCandidate(focused) : firstCandidate(focused);
    if (!candidate || focused.request.humanOnly === true) {
      const what = scope === 'directory' ? 'directory-wide whitelist pattern' : 'whitelist pattern';
      drawTooSmallNotice(` Escalation [${focused.displayNumber}] offers no ${what}. Press n to go back. `);
      return;
    }

    const intro = wordWrap(
      scope === 'directory'
        ? 'y approves this call and, for the rest of this session, every call that matches this pattern. It is recursive: it covers every file in the directories it names and in all of their subdirectories:'
        : 'y approves this call and, for the rest of this session, every call that matches this pattern:',
      innerWidth,
    );
    const pattern = wrapToWidth(toDisplayText(candidate.description), Math.max(1, innerWidth - 2));
    // Borders, tool header, separator, intro, pattern, separator, hint bar.
    const totalBoxHeight = 2 + 2 + intro.length + pattern.length + 2;
    const viewportRows = _layout.ptyViewportRows;
    if (totalBoxHeight > viewportRows) {
      drawTooSmallNotice(
        ` Escalation [${focused.displayNumber}]: the terminal is too small to show the whitelist pattern in full. Enlarge it, or press n to go back. `,
      );
      return;
    }

    const shown = markEscalationDisplayed(focused, whitelistConfirmView(scope));
    const unlockAt = decisionArmedAt(eps.armedAt, shown.since, armingDelayMs);
    let currentY = _layout.ptyViewportY + Math.max(0, Math.floor((viewportRows - totalBoxHeight) / 2));

    drawBoxTopBorder(
      currentY,
      boxX,
      boxWidth,
      scope === 'directory'
        ? ` Approve [${focused.displayNumber}] and whitelist the directory `
        : ` Approve [${focused.displayNumber}] and whitelist `,
    );
    currentY++;
    drawBoxRow(currentY, boxX, innerWidth, (w) => {
      drawEscalationToolHeader(focused, w);
    });
    currentY++;
    drawBoxSeparator(currentY, boxX, innerWidth);
    currentY++;
    for (const line of intro) {
      drawBoxRow(currentY, boxX, innerWidth, () => {
        term(line);
      });
      currentY++;
    }
    for (const line of pattern) {
      drawBoxRow(currentY, boxX, innerWidth, (w) => {
        term('  ');
        term.cyan(untrusted(line, Math.max(1, w - 2)));
        term.styleReset();
      });
      currentY++;
    }
    drawBoxSeparator(currentY, boxX, innerWidth);
    currentY++;
    drawBoxRow(currentY, boxX, innerWidth, (w) => {
      if (clock() < unlockAt) {
        const used = drawWaitHint('y unlocks in a moment', w);
        drawKeyHints([['n', 'back']], w - used);
        scheduleArmingRedraw(unlockAt);
        return;
      }
      drawKeyHints(
        [
          ['y', scope === 'directory' ? 'approve and whitelist the directory' : 'approve and whitelist'],
          ['n', 'back'],
          ['Esc', 'back'],
        ],
        w,
      );
    });
    currentY++;
    drawBoxBottomBorder(currentY, boxX, boxWidth);
  }

  /**
   * Full-detail view of the focused escalation in the same box: the complete
   * reason, the whitelist patterns, the context and every argument as
   * pretty-printed, sanitized JSON, hard-wrapped to the box and scrollable.
   * Nothing is cut, so the approver can read exactly what `a` would approve.
   * The scroll offset is clamped to the content and written back, so paging
   * past the end does not pile up offset that must be scrolled back first.
   */
  function drawEscalationDetailView(
    focused: PendingEscalation,
    eps: EscalationPickerState,
    view: { scrollOffset: number },
    geometry: { innerWidth: number; boxWidth: number; boxX: number },
  ): void {
    const { innerWidth, boxWidth, boxX } = geometry;
    const viewportRows = _layout.ptyViewportRows;
    const viewportY = _layout.ptyViewportY;

    const lines = detailLinesFor(focused, innerWidth);
    const fixedRows = 4; // top border + separator + hint bar + bottom border
    const marginRows = viewportRows - fixedRows - lines.length >= 4 ? 4 : 0;
    const contentRows = Math.min(lines.length, Math.max(1, viewportRows - fixedRows - marginRows));
    if (fixedRows + contentRows > viewportRows) {
      drawEscalationTooSmallNotice(focused);
      return;
    }

    const shown = markEscalationDisplayed(focused, 'detail');
    const unlockAt = decisionArmedAt(eps.armedAt, shown.since, armingDelayMs);
    const maxScroll = Math.max(0, lines.length - contentRows);
    const scroll = Math.min(maxScroll, Math.max(0, view.scrollOffset));
    view.scrollOffset = scroll;
    const totalBoxHeight = fixedRows + contentRows;
    const startY = viewportY + Math.max(0, Math.floor((viewportRows - totalBoxHeight) / 2));
    let currentY = startY;

    drawBoxTopBorder(currentY, boxX, boxWidth, ` Escalation [${focused.displayNumber}] details `);
    currentY++;

    for (let i = 0; i < contentRows; i++) {
      const line = lines[scroll + i];
      drawBoxRow(currentY, boxX, innerWidth, (w) => {
        term(untrusted(line, w));
      });
      currentY++;
    }

    drawBoxSeparator(currentY, boxX, innerWidth);
    currentY++;

    drawBoxRow(currentY, boxX, innerWidth, (w) => {
      // The decision keys (a, d, w, W) work here too, once armed.
      let used = 0;
      if (clock() < unlockAt) {
        used += drawWaitHint('', w);
        scheduleArmingRedraw(unlockAt);
      }
      used += drawKeyHints(
        [
          ['↑↓', 'scroll'],
          ['v', 'summary'],
          ['Esc', 'dismiss'],
        ],
        w - used,
      );
      const position = `lines ${scroll + 1}-${scroll + contentRows} of ${lines.length}`;
      if (used + position.length + 2 <= w) {
        term(' '.repeat(w - used - position.length));
        term.dim(position);
      }
      term.styleReset();
    });
    currentY++;

    drawBoxBottomBorder(currentY, boxX, boxWidth);
  }

  /**
   * Bottom panel for multi-line command output (`/sessions`, bulk resolve
   * results). Lines are display-sanitized and cut to the terminal width; the
   * panel scrolls when there are more lines than rows.
   */
  function drawMessagePanelOverlay(): void {
    const panel = deps.getMessagePanelState();
    if (!panel) return;

    const startY = _layout.pickerY;
    const totalRows = _layout.pickerRows;
    if (totalRows < 3) return;

    let currentY = startY;
    const lineWidth = Math.max(1, _cols - 4);

    // Title
    clearLine(currentY);
    moveTo(2, currentY);
    term.cyan(untrusted(panel.title, lineWidth));
    term.eraseLineAfter();
    currentY++;

    const listRows = Math.max(0, totalRows - 2); // title + hint bar
    const maxScroll = Math.max(0, panel.lines.length - listRows);
    const scroll = Math.min(maxScroll, Math.max(0, panel.scrollOffset));
    panel.scrollOffset = scroll; // only the renderer knows how many rows fit

    for (let i = 0; i < listRows; i++) {
      clearLine(currentY);
      const idx = scroll + i;
      if (idx < panel.lines.length) {
        moveTo(2, currentY);
        term(untrusted(panel.lines[idx], lineWidth));
      }
      term.eraseLineAfter();
      currentY++;
    }

    // Hint bar
    clearLine(currentY);
    moveTo(2, currentY);
    term.bgWhite.black(' Esc ');
    term.styleReset();
    term.dim(' close  ');
    if (panel.lines.length > listRows) {
      term.bgWhite.black(' ↑↓ ');
      term.styleReset();
      const last = Math.min(panel.lines.length, scroll + listRows);
      term.dim(` scroll  (${scroll + 1}-${last} of ${panel.lines.length})`);
    }
    term.styleReset();
    term.eraseLineAfter();
  }

  /**
   * The approve-all confirmation: every escalation that `y` would approve
   * (or leave pending, for a human-only one) with its tool, arguments,
   * reason and, for `/approve+ all`, the complete whitelist pattern. The
   * list scrolls; `y` counts only once every line has been on screen for
   * the arming delay (tracked here, see markBulkLinesSeen). When even one
   * row of the list cannot be shown, a notice replaces the box.
   */
  function drawBulkApproveOverlay(): void {
    const bulk = getBulkApproveState();
    if (!bulk) return;

    const geometry = escalationBoxGeometry();
    const viewportRows = _layout.ptyViewportRows;
    const fixedRows = 4; // top border + separator + hint bar + bottom border
    if (!geometry || viewportRows < fixedRows + 1) {
      drawTooSmallNotice(
        bulk.group
          ? ' Approve group: the terminal is too small to list the escalations. Enlarge it, or press Esc. '
          : ' Approve all: the terminal is too small to list the escalations. Enlarge it, or press Esc. ',
      );
      return;
    }
    const { innerWidth, boxWidth, boxX } = geometry;

    const lines = bulkLinesFor(bulk, innerWidth);
    const marginRows = viewportRows - fixedRows - lines.length >= 4 ? 4 : 0;
    const contentRows = Math.min(lines.length, Math.max(1, viewportRows - fixedRows - marginRows));
    const maxScroll = Math.max(0, lines.length - contentRows);
    const scroll = Math.min(maxScroll, Math.max(0, bulk.scrollOffset));
    bulk.scrollOffset = scroll;

    const shown = markBulkLinesSeen(bulk, innerWidth, lines.length, scroll, contentRows);
    const unlockAt = shown.seenAllSince === null ? null : Math.max(bulk.armedAt, shown.seenAllSince + armingDelayMs);

    const pending = deps.getEscalationState().pendingEscalations;
    const approvable = bulk.reviewed.filter((ref) => pending.get(ref.displayNumber)?.request.humanOnly !== true).length;
    const noun = `${approvable} escalation${approvable === 1 ? '' : 's'}`;
    const scope = bulk.group ? 'group of ' : '';
    const title = bulk.whitelist ? ` Approve and whitelist ${scope}${noun}? ` : ` Approve ${scope}${noun}? `;

    const totalBoxHeight = fixedRows + contentRows;
    let currentY = _layout.ptyViewportY + Math.max(0, Math.floor((viewportRows - totalBoxHeight) / 2));

    drawBoxTopBorder(currentY, boxX, boxWidth, title);
    currentY++;

    for (let i = 0; i < contentRows; i++) {
      const line = lines[scroll + i];
      drawBoxRow(currentY, boxX, innerWidth, (w) => {
        const text = untrusted(line.text, w);
        if (line.kind === 'header') term.yellow(text);
        else if (line.kind === 'pattern') term.cyan(text);
        else if (line.kind === 'note') term.dim(text);
        else term(text);
        term.styleReset();
      });
      currentY++;
    }

    drawBoxSeparator(currentY, boxX, innerWidth);
    currentY++;

    drawBoxRow(currentY, boxX, innerWidth, (w) => {
      let used: number;
      if (unlockAt === null) {
        used = drawKeyHints(
          [
            ['↓', 'scroll to review every line first'],
            ['Esc', 'cancel'],
          ],
          w,
        );
      } else if (clock() < unlockAt) {
        used = drawWaitHint('y unlocks in a moment', w);
        used += drawKeyHints(
          [
            ['Esc', 'cancel'],
            ['↑↓', 'scroll'],
          ],
          w - used,
        );
        scheduleArmingRedraw(unlockAt);
      } else {
        used = drawKeyHints(
          [
            ['y', bulk.whitelist ? `approve and whitelist ${approvable}` : `approve ${approvable}`],
            ['Esc', 'cancel'],
            ['↑↓', 'scroll'],
          ],
          w,
        );
      }
      const position = `${scroll + 1}-${scroll + contentRows} of ${lines.length}`;
      if (lines.length > contentRows && used + position.length + 2 <= w) {
        term(' '.repeat(w - used - position.length));
        term.dim(position);
      }
      term.styleReset();
    });
    currentY++;

    drawBoxBottomBorder(currentY, boxX, boxWidth);
  }

  function drawActiveOverlay(): void {
    // Set again only by a complete escalation dialog or approve-all list
    // drawn below; an unbroken run of the same escalation keeps its `since`.
    _previousDisplayedEscalation = _displayedEscalation;
    _displayedEscalation = null;
    _displayedBulkApproval = null;
    const mode = deps.getMode();
    if (mode === 'command') {
      drawCommandOverlay();
    } else if (mode === 'picker') {
      drawPickerOverlay();
    } else if (mode === 'resume-picker') {
      drawResumePickerOverlay();
    } else if (mode === 'persona-picker') {
      drawPersonaPickerOverlay();
    } else if (mode === 'provider-picker') {
      drawProviderPickerOverlay();
    } else if (mode === 'escalation-picker') {
      drawEscalationPickerOverlay();
    } else if (mode === 'escalation-approve-all') {
      drawBulkApproveOverlay();
    } else if (mode === 'message-panel') {
      drawMessagePanelOverlay();
    }
    settleArmingState();
  }

  /**
   * After an overlay draw: a list that was not drawn (screen closed, or the
   * notice) must be scrolled through again before `y` counts, and with
   * nothing on screen that waits for arming no redraw is due.
   */
  function settleArmingState(): void {
    if (_displayedBulkApproval === null) _bulkSeen = null;
    if (_displayedEscalation === null && _displayedBulkApproval === null && _armingTimer) {
      clearTimeout(_armingTimer);
      _armingTimer = null;
    }
  }

  function drawPickerOverlay(): void {
    const ps = deps.getPickerState();
    if (!ps) return;

    const startY = _layout.pickerY;
    const totalRows = _layout.pickerRows;
    if (totalRows < 4) return; // not enough space

    if (ps.phase === 'menu') {
      drawPickerMenu(ps, startY, totalRows);
    } else {
      drawPickerBrowse(ps, startY, totalRows);
    }
  }

  function drawMenuOption(y: number, label: string, selected: boolean, boxWidth: number): void {
    clearLine(y);
    moveTo(2, y);
    term.cyan('\u2502');
    term(' ');
    if (selected) {
      term.bgCyan.black('>' + label);
      term.styleReset();
    } else {
      term(' ' + label);
    }
    const pad = Math.max(0, boxWidth - label.length - 2);
    term(' '.repeat(pad));
    term.cyan('\u2502');
  }

  function drawPickerMenu(ps: PickerState, startY: number, totalRows: number): void {
    const hasPersonas = ps.menuItemCount >= 3;
    const menuHeight = hasPersonas ? 5 : 4;
    const topPad = Math.max(0, Math.floor((totalRows - menuHeight) / 2));

    for (let y = startY; y < startY + totalRows; y++) {
      clearLine(y);
    }

    const y0 = startY + topPad;
    const boxWidth = Math.min(34, _cols - 4);

    // Top border
    moveTo(2, y0);
    term.cyan('\u250c /new ' + '\u2500'.repeat(Math.max(0, boxWidth - 6)) + '\u2510');

    drawMenuOption(y0 + 1, ' New sandbox', ps.menuSelection === 0, boxWidth);
    drawMenuOption(y0 + 2, ' Existing directory', ps.menuSelection === 1, boxWidth);
    if (hasPersonas) {
      drawMenuOption(y0 + 3, ' Use a persona', ps.menuSelection === 2, boxWidth);
    }

    // Bottom border
    const bottomY = hasPersonas ? y0 + 4 : y0 + 3;
    clearLine(bottomY);
    moveTo(2, bottomY);
    term.cyan('\u2514' + '\u2500'.repeat(boxWidth) + '\u2518');

    term.styleReset();
  }

  function drawPickerBrowse(ps: PickerState, startY: number, totalRows: number): void {
    // Row 0: path input line with cursor
    // Row 1: separator
    // Rows 2..N-2: entry list
    // Row N-1: hint bar (or error)
    let currentY = startY;

    // Path input line — render with visible cursor block
    clearLine(currentY);
    moveTo(2, currentY);
    term.cyan('Path: ');
    // The path is typed or pasted by the user; pasted text can carry control
    // characters and `^`/`%`, so it is display-escaped like any other text.
    const pathPrefix = 'Path: ';
    const beforeCursor = toDisplayText(ps.inputPath.slice(0, ps.cursorPos));
    const cursorChar = toDisplayText(ps.cursorPos < ps.inputPath.length ? ps.inputPath[ps.cursorPos] : ' ');
    const afterCursor = toDisplayText(ps.cursorPos < ps.inputPath.length ? ps.inputPath.slice(ps.cursorPos + 1) : '');
    term(escapeTerminalKitMarkup(beforeCursor));
    if (!ps.inList) {
      // Show block cursor when input field has focus
      term.bgWhite.black(escapeTerminalKitMarkup(cursorChar));
      term.styleReset();
    } else {
      term(escapeTerminalKitMarkup(cursorChar));
    }
    term(escapeTerminalKitMarkup(afterCursor));
    term.eraseLineAfter();
    const cursorX = 2 + pathPrefix.length + displayWidth(beforeCursor);
    currentY++;

    // Separator
    clearLine(currentY);
    moveTo(2, currentY);
    term.dim('\u2500'.repeat(Math.max(0, _cols - 4)));
    term.styleReset();
    currentY++;

    // Entry list
    const listRows = Math.max(0, totalRows - 3); // subtract input, separator, hint bar

    // Only adjust scroll when focus is in the list
    if (ps.inList) {
      if (ps.selectedIndex < ps.scrollOffset) {
        ps.scrollOffset = ps.selectedIndex;
      } else if (ps.selectedIndex >= ps.scrollOffset + listRows) {
        ps.scrollOffset = ps.selectedIndex - listRows + 1;
      }
    }

    for (let i = 0; i < listRows; i++) {
      clearLine(currentY);
      const entryIdx = ps.scrollOffset + i;
      if (entryIdx < ps.entries.length) {
        moveTo(2, currentY);
        // Directory entries are file names the agent may have created in a
        // workspace: display-escaped and cut to the row.
        const entry = untrusted(ps.entries[entryIdx], Math.max(1, _cols - 4));
        const isHighlighted = ps.inList && entryIdx === ps.selectedIndex;
        const isDir = ps.entries[entryIdx].endsWith('/');

        if (isHighlighted) {
          term.bgCyan.black('> ' + entry);
          term.styleReset();
        } else {
          term('  ');
          if (isDir) {
            term.cyan(entry);
          } else {
            term(entry);
          }
        }
      }
      term.eraseLineAfter();
      currentY++;
    }

    // Hint bar / error
    clearLine(currentY);
    moveTo(2, currentY);
    if (ps.error) {
      term.red(untrusted(ps.error, _cols - 4));
    } else if (ps.inList) {
      term.bgWhite.black(' Enter ');
      term.styleReset();
      term.dim(' pick  ');
      term.bgWhite.black(' Esc ');
      term.styleReset();
      term.dim(' back to input');
    } else {
      term.bgWhite.black(' Enter ');
      term.styleReset();
      term.dim(' submit  ');
      term.bgWhite.black(' Tab ');
      term.styleReset();
      term.dim(' complete  ');
      term.bgWhite.black(' \u2193 ');
      term.styleReset();
      term.dim(' browse  ');
      term.bgWhite.black(' Esc ');
      term.styleReset();
      term.dim(' back');
    }
    term.styleReset();
    term.eraseLineAfter();

    // Position terminal cursor on the input line (for accessibility)
    moveTo(cursorX, startY);
  }

  function drawResumePickerOverlay(): void {
    const rps = deps.getResumePickerState();
    if (!rps) return;

    const startY = _layout.pickerY;
    const totalRows = _layout.pickerRows;
    if (totalRows < 3) return;

    let currentY = startY;

    // Title
    clearLine(currentY);
    moveTo(2, currentY);
    term.cyan('/resume');
    term.dim(' \u2014 select a session to resume');
    term.eraseLineAfter();
    currentY++;

    if (rps.sessions.length === 0) {
      clearLine(currentY);
      moveTo(4, currentY);
      term.dim('No resumable sessions found');
      term.eraseLineAfter();
      currentY++;

      for (let y = currentY; y < startY + totalRows; y++) {
        clearLine(y);
      }
      return;
    }

    // Session list
    const listRows = Math.max(0, totalRows - 2); // title + hint bar

    // Scroll adjustment (render-time only; do not mutate rps)
    let scrollOffset = rps.scrollOffset;
    if (rps.selectedIndex < scrollOffset) {
      scrollOffset = rps.selectedIndex;
    } else if (rps.selectedIndex >= scrollOffset + listRows) {
      scrollOffset = rps.selectedIndex - listRows + 1;
    }

    for (let i = 0; i < listRows; i++) {
      clearLine(currentY);
      const idx = scrollOffset + i;
      if (idx < rps.sessions.length) {
        // Snapshots are read from mutable on-disk JSON; every field is untrusted text.
        const s = rps.sessions[idx];
        const isSelected = idx === rps.selectedIndex;
        const shortId = toDisplayText(s.sessionId.substring(0, 8));
        const agent = toDisplayText(s.agent);
        const label = toDisplayText(s.label);
        const timeAgo = formatRelativeTime(s.lastActivity);
        const workspaceLabel = getWorkspaceLabel(s);
        const workspace = workspaceLabel === undefined ? undefined : toDisplayText(workspaceLabel);
        const workspaceSuffix = workspace ? `  ${workspace}` : '';
        const line = `${shortId}  ${agent}  ${label}${workspaceSuffix}  ${timeAgo}  [${s.status}]`;

        moveTo(2, currentY);
        if (isSelected) {
          term.bgCyan.black('> ' + untrusted(line, Math.max(1, _cols - 6)));
          term.styleReset();
        } else {
          term('  ');
          term.dim(escapeTerminalKitMarkup(shortId));
          term('  ');
          term(untrusted(agent, Math.max(1, _cols - 14)));
          term('  ');
          // Fixed columns: "  " prefix (2) + shortId (8) + "  " (2) + agent + "  " (2) +
          // label + "  " (2) + timeAgo + "  " (2) + [status]
          const fixedWidth = 2 + 8 + 2 + displayWidth(agent) + 2 + 2 + timeAgo.length + 2 + s.status.length + 2;
          const availForLabelAndWs = Math.max(10, _cols - fixedWidth);
          if (workspace) {
            // Split available space: label gets half, workspace gets the rest
            const labelWidth = Math.max(5, Math.floor(availForLabelAndWs * 0.4));
            const wsWidth = Math.max(5, availForLabelAndWs - labelWidth - 2);
            term.cyan(untrusted(label, labelWidth));
            term('  ');
            term.yellow(untrusted(workspace, wsWidth));
          } else {
            term.cyan(untrusted(label, availForLabelAndWs));
          }
          term('  ');
          term.dim(timeAgo);
          term('  ');
          term.dim(`[${s.status}]`);
        }
      }
      term.eraseLineAfter();
      currentY++;
    }

    // Hint bar
    clearLine(currentY);
    moveTo(2, currentY);
    term.bgWhite.black(' Enter ');
    term.styleReset();
    term.dim(' resume  ');
    term.bgWhite.black(' Esc ');
    term.styleReset();
    term.dim(' cancel');
    term.styleReset();
    term.eraseLineAfter();
  }

  function drawPersonaPickerOverlay(): void {
    const pps = deps.getPersonaPickerState();
    if (!pps) return;

    const startY = _layout.pickerY;
    const totalRows = _layout.pickerRows;
    if (totalRows < 3) return;

    let currentY = startY;

    // Title
    clearLine(currentY);
    moveTo(2, currentY);
    term.cyan('/new');
    term.dim(' \u2014 select a persona');
    term.eraseLineAfter();
    currentY++;

    if (pps.personas.length === 0) {
      clearLine(currentY);
      moveTo(4, currentY);
      term.dim('No personas found');
      term.eraseLineAfter();
      currentY++;

      for (let y = currentY; y < startY + totalRows; y++) {
        clearLine(y);
      }
      return;
    }

    // Persona list
    const listRows = Math.max(0, totalRows - 2); // title + hint bar

    // Scroll adjustment
    let scrollOffset = pps.scrollOffset;
    if (pps.selectedIndex < scrollOffset) {
      scrollOffset = pps.selectedIndex;
    } else if (pps.selectedIndex >= scrollOffset + listRows) {
      scrollOffset = pps.selectedIndex - listRows + 1;
    }

    for (let i = 0; i < listRows; i++) {
      clearLine(currentY);
      const idx = scrollOffset + i;
      if (idx < pps.personas.length) {
        const p = pps.personas[idx];
        const isSelected = idx === pps.selectedIndex;
        // Persona names and descriptions come from files on disk: untrusted text.
        const usable = p.compiled && !p.stale && p.invalidOverrides === undefined;
        const status = !p.compiled
          ? ' [not compiled]'
          : p.stale
            ? ' [policy stale]'
            : p.invalidOverrides !== undefined
              ? ' [invalid model or limits]'
              : '';
        // A validated model ID is printable ASCII; escape it anyway.
        const model = p.agentModelId !== undefined ? ` (${toDisplayText(p.agentModelId)})` : '';
        const name = toDisplayText(p.name);
        const desc = truncate(
          toDisplayText(p.description),
          Math.max(10, _cols - displayWidth(name) - model.length - status.length - 10),
        );
        const line = `${name}  ${desc}${model}${status}`;

        moveTo(2, currentY);
        if (isSelected) {
          term.bgCyan.black('> ' + untrusted(line, Math.max(1, _cols - 6)));
          term.styleReset();
        } else {
          term('  ');
          if (usable) {
            term.cyan(untrusted(name, Math.max(1, _cols - 6)));
          } else {
            term.dim(untrusted(name, Math.max(1, _cols - 6)));
          }
          term('  ');
          term.dim(escapeTerminalKitMarkup(desc));
          if (model !== '') {
            term.cyan(escapeTerminalKitMarkup(model));
          }
          if (!usable) {
            term.yellow(status);
          }
        }
      }
      term.eraseLineAfter();
      currentY++;
    }

    // Hint bar
    clearLine(currentY);
    moveTo(2, currentY);
    term.bgWhite.black(' Enter ');
    term.styleReset();
    term.dim(' spawn  ');
    term.bgWhite.black(' Esc ');
    term.styleReset();
    term.dim(' cancel');
    term.styleReset();
    term.eraseLineAfter();
  }

  function drawProviderPickerOverlay(): void {
    const pps = deps.getProviderPickerState();
    if (!pps) return;

    const startY = _layout.pickerY;
    const totalRows = _layout.pickerRows;
    if (totalRows < 3) return;

    let currentY = startY;

    // Title
    clearLine(currentY);
    moveTo(2, currentY);
    term.cyan('/new');
    term.dim(' — select a provider profile');
    term.eraseLineAfter();
    currentY++;

    // Profile list
    const listRows = Math.max(0, totalRows - 2); // title + hint bar

    let scrollOffset = pps.scrollOffset;
    if (pps.selectedIndex < scrollOffset) {
      scrollOffset = pps.selectedIndex;
    } else if (pps.selectedIndex >= scrollOffset + listRows) {
      scrollOffset = pps.selectedIndex - listRows + 1;
    }

    for (let i = 0; i < listRows; i++) {
      clearLine(currentY);
      const idx = scrollOffset + i;
      if (idx < pps.profiles.length) {
        const p = pps.profiles[idx];
        const isSelected = idx === pps.selectedIndex;
        // Profile names and model labels come from the user's config file;
        // escaped anyway so `^`/`%` and odd characters print literally.
        const defaultMark = p.isDefault ? ' (default)' : '';
        const name = toDisplayText(p.name);
        const label = truncate(
          toDisplayText(p.primaryModelLabel),
          Math.max(10, _cols - displayWidth(name) - defaultMark.length - 12),
        );
        const line = `${name}  ${label}${defaultMark}`;

        moveTo(2, currentY);
        if (isSelected) {
          term.bgCyan.black('> ' + untrusted(line, Math.max(1, _cols - 6)));
          term.styleReset();
        } else {
          term('  ');
          term.cyan(untrusted(name, Math.max(1, _cols - 6)));
          term('  ');
          term.dim(escapeTerminalKitMarkup(label));
          if (p.isDefault) {
            term.dim(defaultMark);
          }
        }
      }
      term.eraseLineAfter();
      currentY++;
    }

    // Hint bar
    clearLine(currentY);
    moveTo(2, currentY);
    term.bgWhite.black(' Enter ');
    term.styleReset();
    term.dim(' spawn  ');
    term.bgWhite.black(' Esc ');
    term.styleReset();
    term.dim(' cancel');
    term.styleReset();
    term.eraseLineAfter();
  }

  return {
    get layout() {
      return _layout;
    },

    get displayedEscalation() {
      return _displayedEscalation;
    },

    get displayedBulkApproval() {
      return _displayedBulkApproval;
    },

    fullRedraw(): void {
      // One frame: the clear and the repaint reach the terminal together.
      frame(() => {
        recalcLayout();
        invalidateScreen();
        term.clear();
        drawRegion('tabBar', drawTabBar);
        drawBody(true);
      });
    },

    redrawPty(): void {
      frame(() => {
        recalcLayout();
        drawBody(false);
      });
    },

    redrawTabBar(): void {
      frame(() => {
        drawRegion('tabBar', drawTabBar);
      });
    },

    redrawCommandArea(): void {
      frame(() => {
        recalcLayout();
        const mode = deps.getMode();
        if (mode === 'command' || isPickerMode(mode)) {
          // The viewport repaints rows a previously larger overlay held
          // (e.g., after resolving an escalation). Pickers other than the
          // escalation screens show the pending banner in the footer.
          drawBody(mode !== 'command');
        } else {
          drawRegion('footer', drawFooter);
        }
      });
    },

    resize(newCols: number, newRows: number): void {
      _cols = newCols;
      _rows = newRows;
      invalidateScreen();
      recalcLayout();
      _splash?.resize(_cols, _layout.ptyViewportRows, _layout.ptyViewportY, activeOverlayRows());
    },

    destroy(): void {
      _destroyed = true;
      tearDownSplash();
      if (renderTimeout) {
        clearTimeout(renderTimeout);
        renderTimeout = null;
      }
      if (_armingTimer) {
        clearTimeout(_armingTimer);
        _armingTimer = null;
      }
      if (_flashTimeout) {
        clearTimeout(_flashTimeout);
        _flashTimeout = null;
      }
    },

    showMessage(message: string): void {
      _flashMessage = collapseFlashMessage(message);
      if (_flashTimeout) clearTimeout(_flashTimeout);
      _flashTimeout = setTimeout(() => {
        _flashMessage = null;
        _flashTimeout = null;
        if (_destroyed) return;
        frame(() => {
          drawRegion('footer', drawFooter);
        });
      }, FLASH_DURATION_MS);
      frame(() => {
        drawRegion('footer', drawFooter);
      });
    },

    scheduleRedraw(): void {
      if (_destroyed || renderScheduled) return;
      renderScheduled = true;

      const elapsed = Date.now() - lastRenderTime;
      const delay = Math.max(0, MIN_RENDER_INTERVAL_MS - elapsed);

      renderTimeout = setTimeout(() => {
        renderScheduled = false;
        lastRenderTime = Date.now();
        // Output frames send changed rows/regions and restore any overlay
        // whose covered rows emitted adjacent PTY spans.
        frame(() => {
          recalcLayout();
          drawBody(true);
        });
      }, delay);
    },
  };
}

// -- Cell translation --

function translateColor(mode: number, colorValue: number): TermkitColor {
  switch (mode) {
    case CM_DEFAULT:
      return 'default';
    case CM_P16:
    case CM_P256:
      return colorValue;
    case CM_RGB:
      return {
        r: (colorValue >> 16) & 0xff,
        g: (colorValue >> 8) & 0xff,
        b: colorValue & 0xff,
      };
    default:
      return 'default';
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function translateCell(cell: any): TranslatedCell | null {
  const width = cell.getWidth() as number;
  if (width === 0) return null; // Wide char placeholder

  const char = (cell.getChars() as string) || ' ';
  const fg = translateColor(cell.getFgColorMode() as number, cell.getFgColor() as number);
  const bg = translateColor(cell.getBgColorMode() as number, cell.getBgColor() as number);

  return {
    char,
    width,
    fg,
    bg,
    bold: (cell.isBold() as number) !== 0,
    italic: (cell.isItalic() as number) !== 0,
    underline: (cell.isUnderline() as number) !== 0,
    dim: (cell.isDim() as number) !== 0,
    inverse: (cell.isInverse() as number) !== 0,
    strikethrough: (cell.isStrikethrough() as number) !== 0,
  };
}

/**
 * Reads the headless terminal buffer and translates each cell.
 */
export function readTerminalBuffer(
  terminal: TerminalType,
  startRow: number,
  rows: number,
  cols: number,
): TranslatedCell[][] {
  const buffer = terminal.buffer.active;
  const result: TranslatedCell[][] = [];

  for (let y = 0; y < rows; y++) {
    const lineIndex = startRow + y;
    const line = buffer.getLine(lineIndex);
    if (!line) {
      result.push([]);
      continue;
    }

    const row: TranslatedCell[] = [];
    let reusableCell: ReturnType<typeof line.getCell> | undefined;
    for (let x = 0; x < cols; x++) {
      const cell = line.getCell(x, reusableCell);
      if (!cell) continue;
      reusableCell = cell;

      const translated = translateCell(cell);
      if (translated) row.push(translated);
    }
    result.push(row);
  }
  return result;
}

/**
 * Appends SGR color parameters for a single color slot (fg or bg).
 * `base` is 38 for foreground, 48 for background; the default-color
 * reset code is always base+1 (39 / 49).
 */
function pushColorSgr(sgr: number[], color: TermkitColor, base: 38 | 48): void {
  if (color === 'default') {
    sgr.push(base + 1);
  } else if (typeof color === 'number') {
    sgr.push(base, 5, color);
  } else {
    sgr.push(base, 2, color.r, color.g, color.b);
  }
}

/**
 * Builds the SGR parameter string for a cell's style attributes.
 */
export function buildSgrSequence(cell: TranslatedCell): string {
  const sgr: number[] = [0];

  if (cell.bold) sgr.push(1);
  if (cell.dim) sgr.push(2);
  if (cell.italic) sgr.push(3);
  if (cell.underline) sgr.push(4);
  if (cell.inverse) sgr.push(7);
  if (cell.strikethrough) sgr.push(9);

  pushColorSgr(sgr, cell.fg, 38);
  pushColorSgr(sgr, cell.bg, 48);

  return sgr.join(';');
}

export function colorEquals(a: TermkitColor, b: TermkitColor): boolean {
  if (a === b) return true;
  if (typeof a === 'object' && typeof b === 'object') {
    return a.r === b.r && a.g === b.g && a.b === b.b;
  }
  return false;
}

export function cellStyleEquals(a: TranslatedCell, b: TranslatedCell): boolean {
  return (
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.inverse === b.inverse &&
    a.strikethrough === b.strikethrough &&
    colorEquals(a.fg, b.fg) &&
    colorEquals(a.bg, b.bg)
  );
}

/**
 * The bytes that paint the cells of `row` (as read by
 * {@link readTerminalBuffer}) lying in columns `[from, to)`: consecutive
 * same-styled cells share one SGR sequence. A character cut by either edge,
 * containing invisible formatting, or whose host display width differs
 * from xterm's recorded width is drawn as blanks in its style, so nothing
 * is painted outside the span. `end` is the column after the last cell drawn
 * (the row can end before `to`). Pure; the PTY viewport compares the result
 * with what it drew last time and sends only rows that changed.
 */
export function renderCellSpan(
  row: readonly TranslatedCell[],
  from: number,
  to: number,
): { readonly text: string; readonly end: number } {
  let text = '';
  let end = from;
  let column = 0;
  let previous: TranslatedCell | null = null;
  for (const cell of row) {
    const start = column;
    column += cell.width;
    if (column <= from) continue;
    if (start >= to) break;
    const cut = start < from || column > to;
    const unsafeWidth = PTY_CELL_FORMAT.test(cell.char) || displayWidth(cell.char) !== cell.width;
    const chars = cut || unsafeWidth ? ' '.repeat(Math.min(column, to) - Math.max(start, from)) : cell.char;
    if (previous === null || !cellStyleEquals(previous, cell)) text += `\x1b[${buildSgrSequence(cell)}m`;
    text += chars;
    previous = cell;
    end = Math.min(column, to);
  }
  return { text, end };
}

// -- Escalation text formatting and row planning --
//
// Pure functions, exported for tests. Every string they return is already
// display-sanitized (toDisplayText): no control, C1, bidi or invisible
// characters remain, hidden characters show as `\u...` escapes. The drawing
// code only adds terminal-kit markup escaping on top. Because the escaping
// happens before any cut, a cut can shorten an escape's visible spelling
// (`\u00…`) but can never leave a fragment of a control sequence that the
// terminal would act on.

/** One packed line of `key: value` pairs and how many arguments it holds. */
export interface ArgLine {
  readonly text: string;
  /** Arguments whose pair starts on this line (used to count hidden arguments). */
  readonly args: number;
  /** A value on this line was cut to fit; the detail view shows it whole. */
  readonly cut: boolean;
}

/**
 * A planned row of the command-mode escalation panel or of the picker's
 * detail area. `header` is drawn with its own styling; the other kinds carry
 * display-sanitized text.
 */
export type EscalationRow =
  | {
      readonly kind: 'header';
      readonly displayNumber: number;
      readonly sessionDisplayNumber: number;
      readonly tool: string;
    }
  | { readonly kind: 'args-label'; readonly text: string }
  | { readonly kind: 'arg'; readonly text: string }
  | { readonly kind: 'hidden'; readonly text: string }
  | { readonly kind: 'reason'; readonly text: string }
  | { readonly kind: 'whitelist'; readonly text: string }
  | { readonly kind: 'whitelist-directory'; readonly text: string }
  /** Trusted: the session's task. */
  | { readonly kind: 'task'; readonly text: string }
  /** Trusted: the human's last message. */
  | { readonly kind: 'user-message'; readonly text: string }
  /** Untrusted: the agent's justification, drawn with its "untrusted" label. */
  | { readonly kind: 'justification'; readonly text: string }
  /** Trusted: other pending escalations share this one's pattern. */
  | { readonly kind: 'group'; readonly text: string }
  | { readonly kind: 'more'; readonly text: string };

/** Marks text that was cut short. */
const ELLIPSIS = '…';

function argumentEntries(args: unknown): Array<[string, unknown]> {
  if (typeof args !== 'object' || args === null) return [];
  return Object.entries(args);
}

/** The first `maxUnits` UTF-16 units of `text`, never ending inside a surrogate pair. */
function headOf(text: string, maxUnits: number): string {
  const end = Math.max(0, Math.floor(maxUnits));
  if (text.length <= end) return text;
  const last = text.charCodeAt(end - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end);
}

/** Display text plus whether it was cut short (and ends with an ellipsis). */
interface ShownText {
  readonly text: string;
  readonly cut: boolean;
}

/**
 * JSON for one value, cut to `maxLength` UTF-16 units when given. A long
 * string is serialized from its head only (the JSON of a prefix is a prefix
 * of the JSON when the cut falls between code points), so summarizing a
 * multi-megabyte argument costs no more than summarizing a short one.
 */
function formatJson(value: unknown, maxLength: number | undefined): ShownText {
  let json: string;
  let cut = false;
  if (typeof value === 'string' && maxLength !== undefined && value.length > maxLength) {
    json = JSON.stringify(headOf(value, maxLength)).slice(0, -1); // drop the closing quote
    cut = true;
  } else {
    // JSON.stringify is typed as returning string but yields undefined for
    // functions and symbols. Tool arguments come from JSON, so that cannot
    // happen; render the type name rather than crash the approval UI.
    const serialized = JSON.stringify(value) as string | undefined;
    json = serialized ?? typeof value;
  }
  if (maxLength !== undefined && json.length > maxLength) {
    json = headOf(json, maxLength);
    cut = true;
  }
  // The ellipsis is added even when the kept head would fit the row (a run
  // of zero-width marks, say), so a cut value never looks complete.
  return cut ? { text: `${toDisplayText(json)}${ELLIPSIS}`, cut } : { text: toDisplayText(json), cut };
}

const PLAIN_KEY = /^[A-Za-z_$][\w$-]*$/u;

/** Argument keys are agent-controlled too: quote any that is not a plain identifier. */
function formatArgKey(key: string, maxLength?: number): ShownText {
  if (PLAIN_KEY.test(key) && (maxLength === undefined || key.length <= maxLength)) {
    return { text: key, cut: false };
  }
  return formatJson(key, maxLength);
}

/**
 * One argument value as JSON (strings quoted, so a hidden character shows as
 * `\u001b` and a value's boundaries are unambiguous), display-escaped to a
 * single line. With `maxLength`, at most that many UTF-16 units of the JSON
 * are kept and a cut ends with an ellipsis.
 */
export function formatArgValue(value: unknown, maxLength?: number): string {
  return formatJson(value, maxLength).text;
}

/**
 * Formats tool-call arguments into packed display lines: each line holds as
 * many `key: value` pairs as fit within `maxWidth` cells, separated by double
 * spaces; a pair that does not fit starts a new line and is cut to the width
 * (by display cells, after escaping; an ellipsis marks the cut). Only the
 * head of each value is serialized, since one row can show no more.
 */
export function formatArgLines(args: Record<string, unknown>, maxWidth: number): ArgLine[] {
  const entries = argumentEntries(args);
  if (entries.length === 0) return [];

  const width = Math.max(1, Math.floor(maxWidth));
  // Enough UTF-16 units to fill a row even when every character is wide.
  const valueLimit = width * 2 + 16;
  const lines: ArgLine[] = [];
  let currentLine = '';
  let currentWidth = 0;
  let currentArgs = 0;
  let currentCut = false;
  const flush = (): void => {
    const text = truncateToWidth(currentLine, width);
    lines.push({ text, args: currentArgs, cut: currentCut || text !== currentLine });
  };

  for (const [key, value] of entries) {
    const shownKey = formatArgKey(key, valueLimit);
    const shownValue = formatJson(value, valueLimit);
    const pair = `${shownKey.text}: ${shownValue.text}`;
    const pairWidth = displayWidth(pair);
    const pairCut = shownKey.cut || shownValue.cut;

    if (currentArgs > 0 && currentWidth + 2 + pairWidth <= width) {
      currentLine += '  ' + pair;
      currentWidth += 2 + pairWidth;
      currentArgs += 1;
      currentCut ||= pairCut;
      continue;
    }
    if (currentArgs > 0) flush();
    currentLine = pair;
    currentWidth = pairWidth;
    currentArgs = 1;
    currentCut = pairCut;
  }
  flush();

  return lines;
}

/** The pattern `/approve+` (`w`) whitelists: the first candidate, which binds paths exactly. */
function firstCandidate(esc: PendingEscalation): { readonly description: string } | undefined {
  return esc.request.whitelistCandidates?.[0];
}

/** The pattern `/approve+dir` (`W`) whitelists: the directory-wide candidate, when there is one. */
function directoryCandidate(esc: PendingEscalation): { readonly description: string } | undefined {
  const index = directoryCandidateIndex(esc.request.whitelistCandidates);
  return index === undefined ? undefined : esc.request.whitelistCandidates?.[index];
}

/** A row that shows a whitelist pattern. */
type WhitelistRow = Extract<EscalationRow, { readonly kind: 'whitelist' | 'whitelist-directory' }>;

/** The whitelist rows of an escalation: `/approve+`'s pattern, then `/approve+dir`'s, as there are. */
function whitelistRows(esc: PendingEscalation): WhitelistRow[] {
  const rows: WhitelistRow[] = [];
  const exact = firstCandidate(esc);
  if (exact) rows.push({ kind: 'whitelist', text: toDisplayText(exact.description) });
  const directory = directoryCandidate(esc);
  if (directory) rows.push({ kind: 'whitelist-directory', text: toDisplayText(directory.description) });
  return rows;
}

/**
 * Plans the argument block within `budget` rows. When every line fits, the
 * block is the optional `Arguments:` label followed by the lines; the label
 * says `(values cut, <viewHint> to view)` when a line had to be cut to the
 * width. Otherwise the block says how many arguments were hidden and how to
 * see them in full (`viewHint`, e.g. `v`): on the label row when there is
 * one, as a trailing row otherwise. The agent controls argument order and
 * length and may place the decisive value past the cut, so a cut is never
 * silent.
 */
export function planArgumentRows(
  argLines: readonly ArgLine[],
  budget: number,
  viewHint: string,
  withLabel: boolean,
): EscalationRow[] {
  if (argLines.length === 0 || budget <= 0) return [];
  const labelRows = withLabel ? 1 : 0;
  if (labelRows + argLines.length <= budget) {
    const label = argLines.some((line) => line.cut) ? `Arguments: (values cut, ${viewHint} to view)` : 'Arguments:';
    const rows: EscalationRow[] = withLabel ? [{ kind: 'args-label', text: label }] : [];
    for (const line of argLines) rows.push({ kind: 'arg', text: line.text });
    return rows;
  }

  // One row carries the notice; the rest show as many lines as fit.
  const shown = Math.max(0, budget - 1);
  const hidden = argLines.slice(shown).reduce((count, line) => count + line.args, 0);
  const notice = `(+${hidden} hidden, ${viewHint} to view)`;
  const rows: EscalationRow[] = withLabel ? [{ kind: 'args-label', text: `Arguments: ${notice}` }] : [];
  for (const line of argLines.slice(0, shown)) rows.push({ kind: 'arg', text: line.text });
  if (!withLabel) rows.push({ kind: 'hidden', text: notice });
  return rows;
}

/**
 * Plans the escalation picker's detail area for a box of `innerWidth` cells:
 * the trusted reviewer context (task, the human's last message), the
 * argument block (indented by two cells), then the reason, the whitelist
 * lines, the agent's untrusted justification and, with `groupSize` of two
 * or more, the group hint. Everything but the argument block, plus one
 * argument row (when there are arguments: the label with the hidden count),
 * is reserved and always returned, even past `budget`, so the patterns that
 * `w` and `W` would whitelist are never pushed out by long arguments and
 * arguments are never dropped without a notice. Further argument rows fill
 * the rest of `budget`. A caller that cannot fit the result must not show a
 * partial dialog. `argLines` defaults to the arguments formatted for the box.
 */
export function planEscalationDetailRows(
  esc: PendingEscalation,
  budget: number,
  innerWidth: number,
  argLines: readonly ArgLine[] = formatArgLines(esc.request.arguments, Math.max(1, innerWidth - 2)),
  groupSize = 0,
): EscalationRow[] {
  const { request } = esc;
  // Reviewer context, one row each (the detail view shows it whole): the
  // trusted task and last message above the arguments, the agent's
  // untrusted justification below the reason, apart from the human's text.
  const head: EscalationRow[] = [];
  const userMessage = displayedUserMessage(request);
  if (request.taskSummary !== undefined) head.push({ kind: 'task', text: toDisplayText(request.taskSummary) });
  if (userMessage !== undefined) head.push({ kind: 'user-message', text: toDisplayText(userMessage.text) });
  const tail: EscalationRow[] = [{ kind: 'reason', text: toDisplayText(request.reason) }, ...whitelistRows(esc)];
  if (request.agentJustification !== undefined) {
    tail.push({ kind: 'justification', text: toDisplayText(request.agentJustification) });
  }
  if (groupSize >= 2) {
    tail.push({
      kind: 'group',
      text: `${groupSize} pending escalations share this pattern: /approve group ${esc.displayNumber} reviews them`,
    });
  }
  const argBudget = Math.max(argLines.length > 0 ? 1 : 0, budget - head.length - tail.length);
  return [...head, ...planArgumentRows(argLines, argBudget, 'v', true), ...tail];
}

/**
 * How many pending escalations, `esc` included, share `esc`'s whitelist
 * pattern (escalation/escalation-groups.ts); 0 when `esc` is never grouped.
 */
export function pendingGroupSize(esc: PendingEscalation, pending: Iterable<PendingEscalation>): number {
  const key = escalationGroupKey(esc.request);
  if (key === undefined) return 0;
  return groupMembers(pending, (other) => other.request, key).length;
}

/**
 * Plans the command-mode escalation panel within `panelRows` rows, argument
 * lines being `argWidth` cells wide. Every shown escalation gets its header,
 * at least one argument row (when it has arguments), its reason and its
 * whitelist lines; rows are shared evenly so one long argument list cannot
 * crowd the others out. An escalation whose reserved rows do not fit is not
 * shown at all and is counted in a trailing `[+N more ...]` row, so a partial
 * escalation never passes for a complete one and the notice never overwrites
 * content. `argLinesFor` defaults to formatting each escalation's arguments
 * for `argWidth`; the renderer passes a cached version.
 */
export function planEscalationPanelRows(
  pending: readonly PendingEscalation[],
  panelRows: number,
  argWidth: number,
  argLinesFor: (esc: PendingEscalation) => readonly ArgLine[] = (esc) =>
    formatArgLines(esc.request.arguments, argWidth),
): EscalationRow[] {
  if (pending.length === 0 || panelRows <= 0) return [];

  const attempt = (budget: number): { rows: EscalationRow[]; shown: number } => {
    const rows: EscalationRow[] = [];
    let shown = 0;
    for (const esc of pending) {
      const whitelist = whitelistRows(esc);
      const argLines = argLinesFor(esc);
      // header + reason + whitelist lines + one row for arguments (content or notice)
      const fixed = 2 + whitelist.length + (argLines.length > 0 ? 1 : 0);
      if (rows.length + fixed > budget) break;
      const share = Math.max(fixed, Math.floor(budget / pending.length));
      const argBudget = Math.min(budget - rows.length - (fixed - 1), share - (fixed - 1));
      rows.push({
        kind: 'header',
        displayNumber: esc.displayNumber,
        sessionDisplayNumber: esc.sessionDisplayNumber,
        tool: toolLabel(esc.request),
      });
      rows.push(...planArgumentRows(argLines, argLines.length > 0 ? argBudget : 0, 'Ctrl-E, v', false));
      rows.push({ kind: 'reason', text: toDisplayText(esc.request.reason) });
      rows.push(...whitelist);
      shown += 1;
    }
    return { rows, shown };
  };

  let plan = attempt(panelRows);
  if (plan.shown < pending.length) {
    plan = attempt(Math.max(0, panelRows - 1));
    // Hidden escalations are reviewed one at a time; approving them in bulk
    // unseen is not suggested.
    plan.rows.push({
      kind: 'more',
      text: `[+${pending.length - plan.shown} more — Ctrl-E to review them, or /deny all]`,
    });
  }
  return plan.rows;
}

/** One line of the approve-all list, display-sanitized; `kind` selects the styling. */
export interface BulkApprovalLine {
  readonly kind: 'header' | 'detail' | 'pattern' | 'note';
  readonly text: string;
}

/**
 * Word-wraps trusted text (no control characters, ASCII spaces between
 * words) into rows of at most `width` cells; a word longer than the row is
 * hard-wrapped.
 */
export function wordWrap(text: string, width: number): string[] {
  const limit = Math.max(1, Math.floor(width));
  const rows: string[] = [];
  let current = '';
  for (const word of text.split(' ')) {
    const candidate = current ? `${current} ${word}` : word;
    if (displayWidth(candidate) <= limit) {
      current = candidate;
      continue;
    }
    if (current) rows.push(current);
    const pieces = wrapToWidth(word, limit);
    current = pieces.pop() ?? '';
    rows.push(...pieces);
  }
  rows.push(current);
  return rows;
}

/**
 * The approve-all list for a box `width` cells wide: for every reviewed
 * escalation a header (`[N] Session #M  server/tool`), its arguments as
 * packed `key: value` lines (a cut value ends with an ellipsis and a note
 * says where to see it whole), its reason, and either the note that a
 * human-only escalation stays pending or, with `whitelist`, the complete
 * pattern `/approve+` would add (or that there is none). Every string is
 * display-sanitized. An escalation that is no longer pending under its
 * number says so.
 */
export function formatBulkApprovalLines(
  reviewed: readonly PendingRef[],
  pending: ReadonlyMap<number, PendingEscalation>,
  width: number,
  whitelist: boolean,
  group?: BulkApproveGroup,
): BulkApprovalLine[] {
  const lines: BulkApprovalLine[] = [];
  const indent = '    ';
  const inner = Math.max(1, width - indent.length);
  // Agent-derived text is hard-wrapped, so the rows joined give it back
  // exactly; trusted notes are word-wrapped.
  const push = (kind: BulkApprovalLine['kind'], text: string): void => {
    const rows = kind === 'note' ? wordWrap(text, inner) : wrapToWidth(text, inner);
    for (const row of rows) lines.push({ kind, text: `${indent}${row}` });
  };

  if (group) {
    // The pattern every listed call shares, in full. Approving the group
    // approves each call once; it whitelists nothing unless /approve+.
    for (const row of wrapToWidth(`Every call below matches: ${toDisplayText(group.description)}`, width)) {
      lines.push({ kind: 'pattern', text: row });
    }
  }

  for (const ref of [...reviewed].sort((a, b) => a.displayNumber - b.displayNumber)) {
    const esc = pending.get(ref.displayNumber);
    if (esc?.request.escalationId !== ref.escalationId) {
      lines.push({ kind: 'note', text: `[${ref.displayNumber}] no longer pending` });
      continue;
    }
    for (const row of wrapToWidth(
      `[${esc.displayNumber}] Session #${esc.sessionDisplayNumber}  ${toolLabel(esc.request)}`,
      width,
    )) {
      lines.push({ kind: 'header', text: row });
    }
    const argLines = formatArgLines(esc.request.arguments, inner);
    if (argLines.length === 0) push('note', '(no arguments)');
    for (const line of argLines) lines.push({ kind: 'detail', text: `${indent}${line.text}` });
    if (argLines.some((line) => line.cut)) {
      push('note', `(values cut: Esc, then Ctrl-E and v show escalation ${esc.displayNumber} in full)`);
    }
    push('detail', `Reason: ${toDisplayText(esc.request.reason)}`);
    // Reviewer context: the human's own last message on one row (the detail
    // view shows it whole), the agent's untrusted justification in full.
    const userMessage = displayedUserMessage(esc.request);
    if (userMessage !== undefined) {
      lines.push({
        kind: 'detail',
        text: `${indent}${truncateToWidth(`${USER_MESSAGE_PREFIX}${toDisplayText(userMessage.text)}`, inner)}`,
      });
    }
    if (esc.request.agentJustification !== undefined) {
      push('detail', `${JUSTIFICATION_PREFIX}${toDisplayText(esc.request.agentJustification)}`);
    }
    if (esc.request.humanOnly === true) {
      push('note', `human-only: stays pending; approve it on its own with /approve ${esc.displayNumber}`);
      continue;
    }
    if (whitelist) {
      const candidate = firstCandidate(esc);
      if (candidate) push('pattern', `/approve+ ${toDisplayText(candidate.description)}`);
      else push('note', 'no whitelist pattern: approved this once');
    }
  }
  return lines;
}

/**
 * Every line of the escalation detail view, hard-wrapped to `width` cells:
 * session and tool, the session's task and the human's last message (the
 * human's own text, line breaks kept), the complete reason, the whitelist
 * patterns (what `/approve+` and `/approve+dir` add), the context and all
 * arguments as pretty-printed JSON (strings quoted; hidden characters
 * visible as escapes), and last the agent's untrusted justification on its
 * own gutter. Nothing is cut; the view scrolls instead. The cost is linear
 * in the size of the request, so the renderer caches the result per
 * escalation and width.
 */
export function formatEscalationDetailLines(esc: PendingEscalation, width: number): string[] {
  const lines: string[] = [];
  const push = (text: string): void => {
    for (const row of wrapToWidth(text, width)) lines.push(row);
  };
  // Free text keeps its line breaks; every other control character is escaped.
  const pushMultiline = (prefix: string, text: string): void => {
    toDisplayText(text, { multiline: true })
      .replace(/\t/gu, '  ')
      .split('\n')
      .forEach((line, index) => push(`${index === 0 ? prefix : ' '.repeat(prefix.length)}${line}`));
  };

  push(`Session #${esc.sessionDisplayNumber}  ${toolLabel(esc.request)}`);
  const { request } = esc;
  // Trusted reviewer context first: what the human asked for.
  if (request.taskSummary !== undefined) pushMultiline(TASK_PREFIX, request.taskSummary);
  const userMessage = displayedUserMessage(request);
  if (userMessage !== undefined) {
    const when = userMessage.sentAt !== undefined ? ` (${formatRelativeTime(userMessage.sentAt)})` : '';
    pushMultiline(`You said${when}: `, userMessage.text);
  }
  push(`Reason: ${toDisplayText(esc.request.reason)}`);
  for (const row of whitelistRows(esc)) {
    push(`${row.kind === 'whitelist-directory' ? DIRECTORY_WHITELIST_PREFIX : WHITELIST_PREFIX}${row.text}`);
  }
  if (esc.request.context) {
    for (const [key, value] of Object.entries(esc.request.context)) {
      push(`${toDisplayText(key)}: ${formatArgValue(value)}`);
    }
  }

  if (argumentEntries(esc.request.arguments).length === 0) {
    push('Arguments: (none)');
  } else {
    push('Arguments:');
    const json = JSON.stringify(esc.request.arguments, null, 2) as string | undefined;
    for (const jsonLine of toDisplayText(json ?? '{}', { multiline: true }).split('\n')) {
      push(`  ${jsonLine}`);
    }
  }

  // The agent's own text comes last, after the call it is about, as one
  // escaped paragraph (a line break shows as `\n`) with the gutter on every
  // row. Nothing in it can start a row of its own, imitate the arguments or
  // the other rows, or push the real arguments off the first screen: this
  // view takes decisions once armed, and a small terminal opens it directly.
  if (request.agentJustification !== undefined) {
    push(DETAIL_JUSTIFICATION_HEADING);
    const rowWidth = Math.max(1, width - displayWidth(DETAIL_JUSTIFICATION_GUTTER));
    for (const row of wrapToWidth(toDisplayText(request.agentJustification), rowWidth)) {
      lines.push(`${DETAIL_JUSTIFICATION_GUTTER}${row}`);
    }
  }
  return lines;
}

/**
 * Collapses a flash message to the single line the footer can hold: the
 * first line, display-sanitized, plus `(+N more)` when there were more.
 */
export function collapseFlashMessage(message: string): string {
  const lines = message.split(/\r\n|\n|\r/u);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const first = toDisplayText(lines[0]);
  const extra = lines.length - 1;
  return extra > 0 ? `${first} (+${extra} more)` : first;
}

/** Cuts `str` to `maxLen` display cells, marking the cut with an ellipsis. */
export function truncate(str: string, maxLen: number): string {
  return truncateToWidth(str, maxLen);
}

/**
 * Computes which tab labels to render in the escalation tab bar,
 * truncating the focused tab if needed. Returns an array of
 * { label, isFocused } entries that fit within `width` cells.
 *
 * Exported for testing.
 */
export function fitTabLabels(
  tabs: { displayNumber: number; label: string }[],
  focusedDisplayNumber: number,
  width: number,
): { label: string; isFocused: boolean }[] {
  const result: { label: string; isFocused: boolean }[] = [];
  let written = 0;
  for (const tab of tabs) {
    const isFocused = tab.displayNumber === focusedDisplayNumber;
    const cellWidth = displayWidth(tab.label) + 2; // +2 for surrounding spaces
    if (written + cellWidth > width) {
      // Truncate the focused tab to fit; need at least 3 cols: space + 1 char + space
      const remaining = width - written;
      if (isFocused && remaining >= 3) {
        const truncatedLabel = truncate(tab.label, remaining - 2);
        result.push({ label: truncatedLabel, isFocused: true });
      }
      break;
    }
    result.push({ label: tab.label, isFocused });
    written += cellWidth;
  }
  return result;
}
