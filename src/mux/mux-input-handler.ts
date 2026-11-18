/**
 * MuxInputHandler -- key routing state machine for the terminal multiplexer.
 *
 * Two input modes:
 * - PTY mode: all keystrokes go to the active PtyBridge except Ctrl-A
 * - Command mode: keystrokes collected in a line buffer, dispatched on Enter
 *
 * Ctrl-A toggles between modes (following screen/tmux convention).
 * Pressing Ctrl-A in PTY mode enters command mode; pressing it again
 * returns to PTY mode.
 *
 * Pickers and panels take the keyboard while open. The escalation picker
 * opens only on Ctrl-E (an arriving escalation never opens it), and its
 * decision keys, like `y` on the whitelist and approve-all confirmations,
 * count only once armed; see escalation-picker-state.ts for the rules.
 */

import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { expandTilde } from '../types/argument-roles.js';
import { PASTE_START, PASTE_END } from './paste-interceptor.js';
import type { InputMode, MuxAction, PendingRef } from './types.js';
import type { SessionSnapshot } from '../pty/session-scanner.js';
import type { PersonaSnapshot } from './persona-scanner.js';
import type { ProviderProfileSnapshot } from './provider-profile-snapshot.js';
import { hasSelectableProfiles } from './provider-profile-snapshot.js';
import type { WhitelistScope } from '../trusted-process/approval-whitelist.js';
import {
  bulkApprovalKey,
  decisionArmedAt,
  ESCALATION_ARMING_DELAY_MS,
  openEscalationPicker,
  reconcileEscalationUi,
  refocusEscalationPicker,
  whitelistConfirmView,
  type BulkApproveGroup,
  type BulkApproveState,
  type DisplayedBulkApproval,
  type DisplayedEscalation,
  type EscalationPickerState,
  type EscalationUiTransition,
} from './escalation-picker-state.js';

export type { BulkApproveGroup, BulkApproveState, EscalationPickerState } from './escalation-picker-state.js';

export type PickerPhase = 'menu' | 'browse';

export interface PickerState {
  phase: PickerPhase;
  // menu phase
  menuSelection: number; // 0, 1, or 2 (persona)
  menuItemCount: number; // 2 (no personas) or 3 (with personas)
  // browse phase
  inputPath: string;
  cursorPos: number;
  entries: string[]; // directory entries (dirs have trailing /)
  selectedIndex: number;
  scrollOffset: number;
  inList: boolean; // true when focus is in the entry list (vs. the input field)
  error: string | null;
  // persona context (set when persona selected, carried through browse phase)
  persona: string | null;
}

export interface ResumePickerState {
  sessions: SessionSnapshot[];
  selectedIndex: number;
  scrollOffset: number;
}

export interface PersonaPickerState {
  personas: PersonaSnapshot[];
  selectedIndex: number;
  scrollOffset: number;
}

/**
 * The workspace/persona selection carried into the provider-picker step, to be
 * combined with the chosen profile when the final `picker-spawn` is emitted.
 */
export interface PendingSpawnSelection {
  workspacePath?: string;
  persona?: string;
}

export interface ProviderPickerState {
  profiles: ProviderProfileSnapshot[];
  selectedIndex: number;
  scrollOffset: number;
  /** The workspace/persona chosen before this step. */
  pending: PendingSpawnSelection;
}

/**
 * Multi-line command output (`/sessions`, bulk resolve results) shown in a
 * dismissible bottom panel. Lines are display-sanitized by the renderer.
 */
export interface MessagePanelState {
  readonly title: string;
  readonly lines: readonly string[];
  /** First visible line; the renderer clamps it to what fits. */
  scrollOffset: number;
  /** The mode to restore when the panel is dismissed. */
  readonly previousMode: 'pty' | 'command';
}

export interface MuxInputHandler {
  /** Current input mode. */
  readonly mode: InputMode;

  /** Current command-mode input buffer (for display). */
  readonly inputBuffer: string;

  /** Cursor position within the input buffer. */
  readonly cursorPos: number;

  /** Current picker state (null when not in picker mode). */
  readonly pickerState: PickerState | null;

  /** Current resume picker state (null when not in resume picker mode). */
  readonly resumePickerState: ResumePickerState | null;

  /** Current persona picker state (null when not in persona picker mode). */
  readonly personaPickerState: PersonaPickerState | null;

  /** Current provider picker state (null when not in provider picker mode). */
  readonly providerPickerState: ProviderPickerState | null;

  /**
   * Enter picker mode (called by /new command handler). The optional
   * `profiles` snapshot drives the post-selection provider-picker step; when
   * only `native` is configured the step is skipped entirely.
   */
  enterPickerMode(personas?: PersonaSnapshot[], profiles?: ProviderProfileSnapshot[]): void;

  /** Enter resume picker mode with the given sessions. */
  enterResumePickerMode(sessions: SessionSnapshot[]): void;

  /** Exit resume picker mode and return to command mode. */
  exitResumePickerMode(): void;

  /** Re-enter picker browse phase with a validation error. */
  enterBrowseWithError(path: string, error: string, persona?: string): void;

  /** Exit picker mode and return to command mode (no side effects). */
  exitPickerMode(): void;

  /** Enter persona picker mode with the given personas. */
  enterPersonaPickerMode(personas: PersonaSnapshot[]): void;

  /** Exit persona picker mode and return to command mode. */
  exitPersonaPickerMode(): void;

  /** Exit provider picker mode and return to command mode (no side effects). */
  exitProviderPickerMode(): void;

  /** Current escalation picker state (null when not in escalation picker mode). */
  readonly escalationPickerState: EscalationPickerState | null;

  /**
   * Open the escalation picker on `focus` (the user pressed Ctrl-E). It
   * opens disarmed: decision keys count only after the arming delay. Nothing
   * opens it on its own; an arrival only rings, badges and banners.
   */
  enterEscalationPickerMode(focus: PendingRef, previousMode: 'pty' | 'command'): void;

  /** Exit escalation picker mode (return to previous mode). */
  exitEscalationPickerMode(): void;

  /** Dismiss (Esc) the escalation picker, returning to `targetMode` or the mode it was opened from. */
  dismissEscalationPicker(targetMode?: 'pty' | 'command'): void;

  /**
   * Move the picker's focus to `focus` (navigation). A different escalation
   * re-arms the picker, starts an open detail view at the top and cancels a
   * whitelist confirmation.
   */
  focusEscalation(focus: PendingRef): void;

  /**
   * Apply a change to the pending escalations (`pending` sorted by display
   * number): closes the picker when nothing is left, moves and re-arms its
   * focus when the focused one went away, and cancels the approve-all screen
   * when the set it listed changed. Never opens anything and never changes
   * any other mode. See `reconcileEscalationUi`.
   */
  reconcileEscalations(pending: readonly PendingRef[]): EscalationUiTransition;

  /** Switch the escalation picker between the summary and the full-detail view. */
  toggleEscalationDetailView(): void;

  /** Scroll the escalation detail view by `delta` lines (never below 0; the renderer clamps it to the content). */
  scrollEscalationDetailView(delta: number): void;

  /** Current approve-all confirmation state (null when that screen is not open). */
  readonly bulkApproveState: BulkApproveState | null;

  /**
   * Open the approve-all confirmation screen for exactly `reviewed` (every
   * pending escalation, `/approve all` or, with `whitelist`, `/approve+ all`;
   * with `group`, the members of one whitelist-pattern group, `/approve
   * group N`). It opens disarmed; `y` approves the listed set once every
   * line has been on screen and the arming delay has passed.
   */
  enterBulkApproveConfirm(
    reviewed: readonly PendingRef[],
    whitelist: boolean,
    previousMode: 'pty' | 'command',
    group?: BulkApproveGroup,
  ): void;

  /** Close the approve-all confirmation screen and return to the mode it was opened from. */
  exitBulkApproveConfirm(): void;

  /** Current message panel state (null when the panel is not open). */
  readonly messagePanelState: MessagePanelState | null;

  /** Show multi-line output in the message panel, remembering the mode to restore on dismiss. */
  enterMessagePanel(title: string, lines: readonly string[], previousMode: 'pty' | 'command'): void;

  /** Close the message panel and return to the mode it was opened from. */
  exitMessagePanel(): void;

  /**
   * Processes a key event from terminal-kit.
   * Returns a MuxAction describing what the orchestrator should do.
   *
   * @param rawCode - The raw bytes from terminal-kit's `data.code` field:
   *   Buffer for escape sequences, number for single ASCII chars. When
   *   provided, PTY mode forwards these bytes directly to the PTY. When
   *   omitted, PTY mode falls back to writing the key name string.
   */
  handleKey(key: string, rawCode?: Buffer | number): MuxAction;

  /**
   * Processes a paste event (text delivered via bracketed paste).
   * Returns a MuxAction describing what the orchestrator should do.
   */
  handlePaste(text: string): MuxAction;
}

/** terminal-kit key names for special keys. */
const CTRL_A = 'CTRL_A';
const ENTER = 'ENTER';
const ESCAPE = 'ESCAPE';
const CTRL_C = 'CTRL_C';
const BACKSPACE = 'BACKSPACE';
const DELETE = 'DELETE';
const LEFT = 'LEFT';
const RIGHT = 'RIGHT';
const UP = 'UP';
const DOWN = 'DOWN';
const TAB = 'TAB';
const HOME = 'HOME';
const END = 'END';
const CTRL_E = 'CTRL_E';
const SHIFT_TAB = 'SHIFT_TAB';
const PAGE_UP = 'PAGE_UP';
const PAGE_DOWN = 'PAGE_DOWN';

/** Lines scrolled by PageUp/PageDown in the message panel. */
const MESSAGE_PANEL_PAGE_LINES = 5;

/** Lines scrolled by PageUp/PageDown in the escalation detail view and the approve-all list. */
const DETAIL_VIEW_PAGE_LINES = 10;

/**
 * Scroll change for a key in the escalation detail view or the approve-all
 * list, or null when the key does not scroll. End jumps far past the
 * bottom; the renderer clamps the offset to the content, which only it can
 * measure.
 */
function scrollDelta(key: string, scrollOffset: number): number | null {
  switch (key) {
    case UP:
      return -1;
    case DOWN:
      return 1;
    case PAGE_UP:
      return -DETAIL_VIEW_PAGE_LINES;
    case PAGE_DOWN:
      return DETAIL_VIEW_PAGE_LINES;
    case HOME:
      return -scrollOffset;
    case END:
      return Number.MAX_SAFE_INTEGER - scrollOffset;
    default:
      return null;
  }
}

/** Scroll amount (in lines) for arrow-key and mouse-wheel scrolling. */
export const SCROLL_LINES = 3;

/**
 * Converts terminal-kit's raw code (from `data.code`) to a string
 * suitable for writing to a PTY.
 */
function rawCodeToString(rawCode: Buffer | number): string {
  return typeof rawCode === 'number' ? String.fromCharCode(rawCode) : rawCode.toString('utf8');
}

/**
 * Splits a path input into the directory portion and the filename prefix.
 */
function splitDirPrefix(inputPath: string): { dir: string; prefix: string } {
  const lastSlash = inputPath.lastIndexOf('/');
  if (lastSlash === -1) {
    return { dir: homedir(), prefix: inputPath };
  }
  return { dir: inputPath.slice(0, lastSlash) || '/', prefix: inputPath.slice(lastSlash + 1) };
}

// Cache for directory listings to avoid re-reading on every keystroke
// when only the prefix (filename portion) changes.
let _cachedDir: string | null = null;
let _cachedDirents: import('node:fs').Dirent[] = [];

/**
 * Reads directory entries for the picker's browse phase.
 * Returns entries matching the prefix, with trailing `/` for directories.
 * Directories are sorted first, then alphabetical.
 * Caches the raw directory listing; only re-reads when the directory changes.
 */
function refreshEntries(inputPath: string): string[] {
  const { dir: rawDir, prefix } = splitDirPrefix(inputPath);
  const dir = expandTilde(rawDir);

  try {
    if (dir !== _cachedDir) {
      _cachedDirents = readdirSync(dir, { withFileTypes: true });
      _cachedDir = dir;
    }

    const entries: { name: string; isDir: boolean }[] = [];
    for (const ent of _cachedDirents) {
      if (!ent.name.startsWith(prefix)) continue;
      if (ent.name.startsWith('.') && !prefix.startsWith('.')) continue;
      entries.push({ name: ent.name, isDir: ent.isDirectory() });
    }

    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return entries.map((e) => (e.isDir ? e.name + '/' : e.name));
  } catch {
    return [];
  }
}

/**
 * Finds the longest common prefix among a list of strings.
 */
function longestCommonPrefix(strings: string[]): string {
  if (strings.length === 0) return '';
  let prefix = strings[0];
  for (let i = 1; i < strings.length; i++) {
    while (!strings[i].startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
      if (prefix.length === 0) return '';
    }
  }
  return prefix;
}

export interface MuxInputHandlerOptions {
  initialMode?: InputMode;
  /**
   * Monotonic clock in milliseconds for the arming delay. Default
   * `performance.now`; tests inject a fake one. The renderer must use the
   * same clock (its `displayedEscalation.since` is compared with it).
   */
  now?: () => number;
  /** Arming delay in milliseconds. Default {@link ESCALATION_ARMING_DELAY_MS}. */
  armingDelayMs?: number;
  /**
   * What the escalation picker last drew in full; the app wires it to the
   * renderer's `displayedEscalation`. `a` approves and `w`/`W` whitelist
   * only the escalation drawn in full (summary or detail view) for at least
   * the arming delay: when the terminal is too small for the dialog the
   * renderer draws a notice instead, and approving, or whitelisting a
   * pattern, that the user never saw is swallowed. `y` on a whitelist
   * confirmation needs that confirmation, with the pattern it whitelists,
   * on screen. Denying needs no display. Omitted: the focused escalation
   * counts as drawn, in its current view, since forever, with both patterns.
   */
  displayedEscalation?: () => DisplayedEscalation | null;
  /**
   * What the approve-all screen last drew; the app wires it to the
   * renderer's `displayedBulkApproval`. `y` approves only when every line of
   * the listed set has been on screen for at least the arming delay.
   * Omitted: the whole list counts as seen since forever.
   */
  displayedBulkApproval?: () => DisplayedBulkApproval | null;
}

export function createMuxInputHandler(options?: MuxInputHandlerOptions): MuxInputHandler {
  let _mode: InputMode = options?.initialMode ?? 'pty';
  const clock = options?.now ?? ((): number => performance.now());
  const armingDelayMs = options?.armingDelayMs ?? ESCALATION_ARMING_DELAY_MS;
  let _inputBuffer = '';
  let _cursorPos = 0;
  let _pickerState: PickerState | null = null;
  let _resumePickerState: ResumePickerState | null = null;
  let _personaPickerState: PersonaPickerState | null = null;
  let _providerPickerState: ProviderPickerState | null = null;
  let _escalationPickerState: EscalationPickerState | null = null;
  let _bulkApproveState: BulkApproveState | null = null;
  let _messagePanelState: MessagePanelState | null = null;

  const displayedEscalation =
    options?.displayedEscalation ??
    ((): DisplayedEscalation | null => {
      const eps = _escalationPickerState;
      if (!eps) return null;
      return {
        displayNumber: eps.focusedDisplayNumber,
        escalationId: eps.focusedEscalationId,
        view: eps.whitelistConfirm ? whitelistConfirmView(eps.whitelistConfirm) : eps.detailView ? 'detail' : 'summary',
        since: Number.NEGATIVE_INFINITY,
        canWhitelist: true,
        canWhitelistDirectory: true,
      };
    });
  const displayedBulkApproval =
    options?.displayedBulkApproval ??
    ((): DisplayedBulkApproval | null => {
      const bulk = _bulkApproveState;
      if (!bulk) return null;
      return { setKey: bulkApprovalKey(bulk.reviewed, bulk.whitelist), seenAllSince: Number.NEGATIVE_INFINITY };
    });

  let _cachedPersonas: PersonaSnapshot[] = [];
  let _cachedProfiles: ProviderProfileSnapshot[] = [];

  function enterPickerMode(personas?: PersonaSnapshot[], profiles?: ProviderProfileSnapshot[]): void {
    _cachedPersonas = personas ?? [];
    _cachedProfiles = profiles ?? [];
    _mode = 'picker';
    _pickerState = {
      phase: 'menu',
      menuSelection: 0,
      menuItemCount: _cachedPersonas.length > 0 ? 3 : 2,
      inputPath: '',
      cursorPos: 0,
      entries: [],
      selectedIndex: 0,
      scrollOffset: 0,
      inList: false,
      error: null,
      persona: null,
    };
  }

  /** Resets entry selection and scroll after refreshing entries. */
  function resetEntrySelection(ps: PickerState): void {
    ps.entries = refreshEntries(ps.inputPath);
    ps.selectedIndex = 0;
    ps.scrollOffset = 0;
  }

  function initBrowsePhase(path?: string): void {
    if (!_pickerState) return;
    const browsePath = path ?? homedir() + '/';
    _pickerState.phase = 'browse';
    _pickerState.inputPath = browsePath;
    _pickerState.cursorPos = browsePath.length;
    _pickerState.inList = false;
    _pickerState.error = null;
    resetEntrySelection(_pickerState);
  }

  function enterBrowseWithError(path: string, error: string, persona?: string): void {
    _mode = 'picker';
    const resolvedPersona = persona ?? _pickerState?.persona ?? null;
    _pickerState = {
      phase: 'browse',
      menuSelection: 0,
      menuItemCount: 2,
      inputPath: path,
      cursorPos: path.length,
      entries: [],
      selectedIndex: 0,
      scrollOffset: 0,
      inList: false,
      error,
      persona: resolvedPersona,
    };
    resetEntrySelection(_pickerState);
  }

  function exitPickerMode(): void {
    _mode = 'command';
    _pickerState = null;
  }

  function enterResumePickerMode(sessions: SessionSnapshot[]): void {
    _mode = 'resume-picker';
    _resumePickerState = {
      sessions,
      selectedIndex: 0,
      scrollOffset: 0,
    };
  }

  function exitResumePickerMode(): void {
    _mode = 'command';
    _resumePickerState = null;
  }

  function enterPersonaPickerMode(personas: PersonaSnapshot[]): void {
    _mode = 'persona-picker';
    _personaPickerState = {
      personas,
      selectedIndex: 0,
      scrollOffset: 0,
    };
  }

  function exitPersonaPickerMode(): void {
    _mode = 'command';
    _personaPickerState = null;
  }

  function enterProviderPickerMode(pending: PendingSpawnSelection): void {
    _mode = 'provider-picker';
    // Default selection to the marked `isDefault` entry so Enter without
    // navigation spawns with the user's configured default profile.
    const defaultIndex = Math.max(
      0,
      _cachedProfiles.findIndex((p) => p.isDefault),
    );
    _providerPickerState = { profiles: _cachedProfiles, selectedIndex: defaultIndex, scrollOffset: 0, pending };
  }

  function exitProviderPickerMode(): void {
    _mode = 'command';
    _providerPickerState = null;
  }

  /**
   * Completes a workspace/persona selection. When selectable profiles are
   * configured, interposes the provider-picker step (carrying the pending
   * selection); otherwise emits the terminal `picker-spawn` immediately for a
   * zero-friction native default (§9.7 (3)).
   */
  function finishSelection(pending: PendingSpawnSelection): MuxAction {
    _pickerState = null;
    if (hasSelectableProfiles(_cachedProfiles)) {
      enterProviderPickerMode(pending);
      return { kind: 'redraw-picker' };
    }
    _mode = 'command';
    return spawnActionFor(pending, undefined);
  }

  /** Builds a `picker-spawn` action, omitting undefined fields. */
  function spawnActionFor(pending: PendingSpawnSelection, providerProfileName: string | undefined): MuxAction {
    return {
      kind: 'picker-spawn',
      ...(pending.workspacePath !== undefined ? { workspacePath: pending.workspacePath } : {}),
      ...(pending.persona !== undefined ? { persona: pending.persona } : {}),
      ...(providerProfileName !== undefined ? { providerProfileName } : {}),
    };
  }

  function handleProviderPickerKey(key: string): MuxAction {
    const pps = _providerPickerState;
    if (!pps || pps.profiles.length === 0) {
      // Defensive: the mode is only entered with a non-empty snapshot.
      if (key === ESCAPE || key === CTRL_C || key === ENTER) {
        exitProviderPickerMode();
        return { kind: 'picker-cancel' };
      }
      return { kind: 'none' };
    }

    if (key === ESCAPE || key === CTRL_C) {
      // Cancel the whole /new flow (the workspace/persona choice is discarded).
      exitProviderPickerMode();
      return { kind: 'picker-cancel' };
    }

    if (key === ENTER) {
      const selected = pps.profiles[pps.selectedIndex];
      const pending = pps.pending;
      exitProviderPickerMode();
      return spawnActionFor(pending, selected.name);
    }

    if (key === UP) {
      if (pps.selectedIndex > 0) {
        pps.selectedIndex--;
        if (pps.selectedIndex < pps.scrollOffset) {
          pps.scrollOffset = pps.selectedIndex;
        }
      }
      return { kind: 'redraw-picker' };
    }

    if (key === DOWN) {
      if (pps.selectedIndex < pps.profiles.length - 1) {
        pps.selectedIndex++;
      }
      return { kind: 'redraw-picker' };
    }

    return { kind: 'none' };
  }

  function handlePersonaPickerKey(key: string): MuxAction {
    const pps = _personaPickerState;
    if (!pps || pps.personas.length === 0) {
      if (key === ESCAPE || key === CTRL_C || key === ENTER) {
        _personaPickerState = null;
        _mode = 'command';
        return { kind: 'picker-cancel' };
      }
      return { kind: 'none' };
    }

    if (key === ESCAPE || key === CTRL_C) {
      // Return to the picker menu (not command mode). Preserve the cached
      // provider profiles so the post-selection provider-picker step is not
      // wrongly skipped after backing out of persona selection.
      _personaPickerState = null;
      enterPickerMode(_cachedPersonas, _cachedProfiles);
      return { kind: 'redraw-picker' };
    }

    if (key === ENTER) {
      const selected = pps.personas[pps.selectedIndex];
      // A stale policy no longer matches the persona's constitution, and a
      // malformed agent model or resource budget fails validation; the
      // session would refuse either, so neither is more selectable than an
      // uncompiled persona.
      if (!selected.compiled || selected.stale || selected.invalidOverrides !== undefined) {
        return { kind: 'none' };
      }
      // Transition to workspace browse phase with persona context
      exitPersonaPickerMode();
      _mode = 'picker';
      _pickerState = {
        phase: 'browse',
        menuSelection: 0,
        menuItemCount: 2,
        inputPath: selected.workspacePath + '/',
        cursorPos: selected.workspacePath.length + 1,
        entries: [],
        selectedIndex: 0,
        scrollOffset: 0,
        inList: false,
        error: null,
        persona: selected.name,
      };
      resetEntrySelection(_pickerState);
      return { kind: 'redraw-picker' };
    }

    if (key === UP) {
      if (pps.selectedIndex > 0) {
        pps.selectedIndex--;
        if (pps.selectedIndex < pps.scrollOffset) {
          pps.scrollOffset = pps.selectedIndex;
        }
      }
      return { kind: 'redraw-picker' };
    }

    if (key === DOWN) {
      if (pps.selectedIndex < pps.personas.length - 1) {
        pps.selectedIndex++;
      }
      return { kind: 'redraw-picker' };
    }

    return { kind: 'none' };
  }

  function handleResumePickerKey(key: string): MuxAction {
    const rps = _resumePickerState;
    if (!rps || rps.sessions.length === 0) {
      if (key === ESCAPE || key === CTRL_C || key === ENTER) {
        exitResumePickerMode();
        return { kind: 'picker-cancel' };
      }
      return { kind: 'none' };
    }

    if (key === ESCAPE || key === CTRL_C) {
      exitResumePickerMode();
      return { kind: 'picker-cancel' };
    }

    if (key === ENTER) {
      const selected = rps.sessions[rps.selectedIndex];
      exitResumePickerMode();
      return { kind: 'resume-spawn', sessionId: selected.sessionId, agent: selected.agent };
    }

    if (key === UP) {
      if (rps.selectedIndex > 0) {
        rps.selectedIndex--;
        if (rps.selectedIndex < rps.scrollOffset) {
          rps.scrollOffset = rps.selectedIndex;
        }
      }
      return { kind: 'redraw-picker' };
    }

    if (key === DOWN) {
      if (rps.selectedIndex < rps.sessions.length - 1) {
        rps.selectedIndex++;
      }
      return { kind: 'redraw-picker' };
    }

    return { kind: 'none' };
  }

  function executeMenuSelection(selection: number): MuxAction {
    if (selection === 0) {
      // Quick-spawn: no workspace, no persona. May still route through the
      // provider-picker step when profiles are configured.
      return finishSelection({});
    }
    if (selection === 1) {
      initBrowsePhase();
      return { kind: 'redraw-picker' };
    }
    // selection === 2: open persona picker directly from cached personas
    _pickerState = null;
    enterPersonaPickerMode(_cachedPersonas);
    return { kind: 'redraw-picker' };
  }

  function handleMenuKey(key: string): MuxAction {
    const ps = _pickerState;
    if (!ps) return { kind: 'none' };

    if (key === '1') return executeMenuSelection(0);
    if (key === '2') return executeMenuSelection(1);
    if (key === '3' && ps.menuItemCount >= 3) return executeMenuSelection(2);
    if (key === ENTER) return executeMenuSelection(ps.menuSelection);

    if (key === UP) {
      ps.menuSelection = Math.max(0, ps.menuSelection - 1);
      return { kind: 'redraw-picker' };
    }

    if (key === DOWN) {
      ps.menuSelection = Math.min(ps.menuItemCount - 1, ps.menuSelection + 1);
      return { kind: 'redraw-picker' };
    }

    if (key === ESCAPE || key === CTRL_C) {
      _mode = 'command';
      _pickerState = null;
      return { kind: 'picker-cancel' };
    }

    return { kind: 'none' };
  }

  function handleBrowseKey(key: string): MuxAction {
    const ps = _pickerState;
    if (!ps) return { kind: 'none' };
    ps.error = null;

    if (key === ESCAPE || key === CTRL_C) {
      if (ps.inList) {
        // Return from list to input field
        ps.inList = false;
        return { kind: 'redraw-picker' };
      }
      // Return to menu phase, restoring persona menu item if available
      ps.phase = 'menu';
      ps.menuSelection = 0;
      ps.menuItemCount = _cachedPersonas.length > 0 ? 3 : 2;
      ps.persona = null;
      return { kind: 'redraw-picker' };
    }

    // Tab completion (only when in input field)
    if (key === TAB && !ps.inList) {
      if (ps.entries.length === 0) {
        return { kind: 'none' };
      }

      const { dir: dirPart, prefix } = splitDirPrefix(ps.inputPath);
      const base = dirPart === homedir() && !ps.inputPath.includes('/') ? '' : dirPart + '/';

      if (ps.entries.length === 1) {
        ps.inputPath = base + ps.entries[0];
        ps.cursorPos = ps.inputPath.length;
        resetEntrySelection(ps);
      } else {
        const names = ps.entries.map((e) => e.replace(/\/$/, ''));
        const lcp = longestCommonPrefix(names);
        if (lcp.length > prefix.length) {
          ps.inputPath = base + lcp;
          ps.cursorPos = ps.inputPath.length;
          resetEntrySelection(ps);
        }
      }
      return { kind: 'redraw-picker' };
    }

    // Up/Down navigation
    if (key === DOWN) {
      if (!ps.inList) {
        // Move focus from input field into the entry list
        if (ps.entries.length > 0) {
          ps.inList = true;
          ps.selectedIndex = 0;
          ps.scrollOffset = 0;
        }
      } else if (ps.selectedIndex < ps.entries.length - 1) {
        ps.selectedIndex++;
      }
      return { kind: 'redraw-picker' };
    }

    if (key === UP) {
      if (ps.inList) {
        if (ps.selectedIndex > 0) {
          ps.selectedIndex--;
          if (ps.selectedIndex < ps.scrollOffset) {
            ps.scrollOffset = ps.selectedIndex;
          }
        } else {
          // At top of list — return focus to input field
          ps.inList = false;
        }
      }
      return { kind: 'redraw-picker' };
    }

    // When in list mode, Enter picks the entry into the input field
    if (key === ENTER && ps.inList) {
      if (ps.selectedIndex < ps.entries.length) {
        const selected = ps.entries[ps.selectedIndex];
        const { dir: dirPart } = splitDirPrefix(ps.inputPath);
        ps.inputPath = dirPart + '/' + selected;
        ps.cursorPos = ps.inputPath.length;
        ps.inList = false;
        resetEntrySelection(ps);
      }
      return { kind: 'redraw-picker' };
    }

    // When in input field, Enter submits the current path
    if (key === ENTER && !ps.inList) {
      if (ps.inputPath.trim()) {
        const workspacePath = ps.inputPath.replace(/\/+$/, '');
        return finishSelection(ps.persona ? { workspacePath, persona: ps.persona } : { workspacePath });
      }
      return { kind: 'redraw-picker' };
    }

    // Keys below only apply when focus is on the input field
    if (ps.inList) {
      return { kind: 'none' };
    }

    // Cursor movement within input path
    if (key === LEFT) {
      if (ps.cursorPos > 0) ps.cursorPos--;
      return { kind: 'redraw-picker' };
    }

    if (key === RIGHT) {
      if (ps.cursorPos < ps.inputPath.length) ps.cursorPos++;
      return { kind: 'redraw-picker' };
    }

    // Backspace
    if (key === BACKSPACE) {
      if (ps.cursorPos > 0) {
        ps.inputPath = ps.inputPath.slice(0, ps.cursorPos - 1) + ps.inputPath.slice(ps.cursorPos);
        ps.cursorPos--;
        resetEntrySelection(ps);
      }
      return { kind: 'redraw-picker' };
    }

    // Delete
    if (key === DELETE) {
      if (ps.cursorPos < ps.inputPath.length) {
        ps.inputPath = ps.inputPath.slice(0, ps.cursorPos) + ps.inputPath.slice(ps.cursorPos + 1);
        resetEntrySelection(ps);
      }
      return { kind: 'redraw-picker' };
    }

    // Printable character
    if (key.length === 1 && key.charCodeAt(0) >= 32) {
      ps.inputPath = ps.inputPath.slice(0, ps.cursorPos) + key + ps.inputPath.slice(ps.cursorPos);
      ps.cursorPos++;
      resetEntrySelection(ps);
      return { kind: 'redraw-picker' };
    }

    return { kind: 'none' };
  }

  function handlePickerKey(key: string): MuxAction {
    if (!_pickerState) return { kind: 'none' };
    if (_pickerState.phase === 'menu') return handleMenuKey(key);
    return handleBrowseKey(key);
  }

  function enterEscalationPickerMode(focus: PendingRef, previousMode: 'pty' | 'command'): void {
    _mode = 'escalation-picker';
    _escalationPickerState = openEscalationPicker(focus, previousMode, clock(), armingDelayMs);
  }

  function focusEscalation(focus: PendingRef): void {
    if (!_escalationPickerState) return;
    _escalationPickerState = refocusEscalationPicker(_escalationPickerState, focus, clock(), armingDelayMs);
  }

  function reconcileEscalations(pending: readonly PendingRef[]): EscalationUiTransition {
    const transition = reconcileEscalationUi(
      { mode: _mode, picker: _escalationPickerState, bulk: _bulkApproveState },
      pending,
      clock(),
      armingDelayMs,
    );
    _mode = transition.next.mode;
    _escalationPickerState = transition.next.picker;
    _bulkApproveState = transition.next.bulk;
    return transition;
  }

  function enterBulkApproveConfirm(
    reviewed: readonly PendingRef[],
    whitelist: boolean,
    previousMode: 'pty' | 'command',
    group?: BulkApproveGroup,
  ): void {
    _mode = 'escalation-approve-all';
    _bulkApproveState = {
      reviewed: [...reviewed],
      ...(group ? { group } : {}),
      whitelist,
      previousMode,
      scrollOffset: 0,
      armedAt: clock() + armingDelayMs,
    };
  }

  function exitBulkApproveConfirm(): void {
    // Already closed (a change to the pending set cancels it): nothing to restore.
    if (!_bulkApproveState) return;
    _mode = _bulkApproveState.previousMode;
    _bulkApproveState = null;
  }

  function toggleEscalationDetailView(): void {
    const eps = _escalationPickerState;
    if (!eps) return;
    eps.detailView = eps.detailView ? null : { scrollOffset: 0 };
  }

  function scrollEscalationDetailView(delta: number): void {
    const view = _escalationPickerState?.detailView;
    if (!view) return;
    view.scrollOffset = Math.max(0, view.scrollOffset + delta);
  }

  function enterMessagePanel(title: string, lines: readonly string[], previousMode: 'pty' | 'command'): void {
    _mode = 'message-panel';
    _messagePanelState = { title, lines: [...lines], scrollOffset: 0, previousMode };
  }

  function exitMessagePanel(): void {
    const prev = _messagePanelState?.previousMode ?? 'pty';
    _mode = prev;
    _messagePanelState = null;
  }

  function handleMessagePanelKey(key: string): MuxAction {
    const panel = _messagePanelState;
    if (!panel) return { kind: 'none' };

    if (key === ESCAPE || key === ENTER || key === CTRL_C || key === 'q') {
      return { kind: 'message-panel-dismiss' };
    }

    // Scrolling only moves the window; the renderer clamps the top end
    // because only it knows how many rows the panel has.
    if (key === UP || key === DOWN || key === PAGE_UP || key === PAGE_DOWN) {
      const step = key === UP || key === PAGE_UP ? -1 : 1;
      const lines = key === PAGE_UP || key === PAGE_DOWN ? MESSAGE_PANEL_PAGE_LINES : 1;
      const maxOffset = Math.max(0, panel.lines.length - 1);
      panel.scrollOffset = Math.min(maxOffset, Math.max(0, panel.scrollOffset + step * lines));
      return { kind: 'redraw-picker' };
    }

    return { kind: 'none' };
  }

  function exitEscalationPickerMode(): void {
    const prev = _escalationPickerState?.previousMode ?? 'pty';
    _mode = prev;
    _escalationPickerState = null;
  }

  function dismissEscalationPicker(targetMode?: 'pty' | 'command'): void {
    exitEscalationPickerMode();
    if (targetMode) {
      _mode = targetMode;
    }
  }

  /**
   * Restarts the arming window of an armed-input screen. Every key there
   * other than a decision that counts does this, the ones that navigate,
   * view or scroll included, so a decision counts only after a full delay
   * in which no other key came: text typed into the picker by mistake
   * ("va...", a Tab, an arrow before an `a`), a held key or a double tap
   * decides nothing.
   */
  function restartArming(state: { armedAt: number }): void {
    state.armedAt = clock() + armingDelayMs;
  }

  /**
   * A key that was not accepted on an armed-input screen: swallowed (never
   * forwarded to the PTY) and the arming window starts again
   * (`restartArming`). The redraw shows the "wait" hint.
   */
  function rearm(state: { armedAt: number }): MuxAction {
    restartArming(state);
    return { kind: 'redraw-picker' };
  }

  function resolveFocused(
    eps: EscalationPickerState,
    decision: 'approved' | 'denied',
    whitelist: false | WhitelistScope,
  ): MuxAction {
    return {
      kind: 'escalation-resolve',
      displayNumber: eps.focusedDisplayNumber,
      escalationId: eps.focusedEscalationId,
      decision,
      whitelist,
    };
  }

  /**
   * The focused escalation as the renderer last drew it, when that is the
   * escalation the picker is focused on; otherwise null.
   */
  function drawnFocus(eps: EscalationPickerState): DisplayedEscalation | null {
    const shown = displayedEscalation();
    if (!shown) return null;
    if (shown.displayNumber !== eps.focusedDisplayNumber || shown.escalationId !== eps.focusedEscalationId) {
      return null;
    }
    return shown;
  }

  /**
   * Escalation picker keys. Dismissing (Esc, Ctrl-C, Ctrl-A), navigating
   * and viewing decide nothing and always work, armed or not; like every
   * key other than a decision that counts, navigating and viewing restart
   * the arming window (moving to another escalation also re-arms through
   * `focusEscalation`). Decision keys count only once the picker is armed:
   * `d` (deny) and `D` (deny all) then act at once; `a` (approve), `w`
   * (open the confirmation of the exact whitelist pattern) and `W` (open the
   * confirmation of the directory-wide one, when the escalation offers it)
   * also need the escalation drawn in full for the whole arming delay.
   * Every other key, and a decision key that does not count yet, is
   * swallowed and restarts the arming window. There is no approve-all key:
   * bulk approval goes through the `/approve all` confirmation screen.
   */
  function handleEscalationPickerKey(key: string): MuxAction {
    const eps = _escalationPickerState;
    if (!eps) return { kind: 'none' };

    if (eps.whitelistConfirm) return handleWhitelistConfirmKey(eps, eps.whitelistConfirm, key);

    if (key === ESCAPE || key === CTRL_C) {
      return { kind: 'escalation-dismiss' };
    }

    if (key === CTRL_A) {
      return { kind: 'escalation-dismiss', targetMode: 'command' };
    }

    // Tab navigation: LEFT/SHIFT_TAB = prev, RIGHT/TAB = next. Restarts the
    // window even when the focus does not move (a single escalation), so a
    // Tab or an arrow right before `a` does not approve.
    if (key === RIGHT || key === TAB) {
      restartArming(eps);
      return { kind: 'escalation-navigate', direction: 'next' };
    }
    if (key === LEFT || key === SHIFT_TAB) {
      restartArming(eps);
      return { kind: 'escalation-navigate', direction: 'prev' };
    }

    // Detail view: 'v' toggles it, the arrow, page and Home/End keys scroll
    // it. Viewing never decides anything, so these work while disarmed; they
    // restart the window, so "va..." typed into the picker approves nothing.
    if (key === 'v') {
      toggleEscalationDetailView();
      return rearm(eps);
    }
    if (eps.detailView) {
      const delta = scrollDelta(key, eps.detailView.scrollOffset);
      if (delta !== null) {
        scrollEscalationDetailView(delta);
        return rearm(eps);
      }
    }

    const now = clock();
    if (now >= eps.armedAt) {
      if (key === 'd') return resolveFocused(eps, 'denied', false);
      if (key === 'D') return { kind: 'escalation-deny-all' };
      // Approving needs the request on screen in full, for the whole delay:
      // the "too small" notice or a request drawn a moment ago does not count.
      const shown = drawnFocus(eps);
      const shownLongEnough = shown !== null && now >= decisionArmedAt(eps.armedAt, shown.since, armingDelayMs);
      if (key === 'a' && shown && shownLongEnough) return resolveFocused(eps, 'approved', false);
      // Show the pattern in full first; `y` there approves and whitelists it.
      if (key === 'w' && shown && shownLongEnough && shown.canWhitelist) {
        eps.whitelistConfirm = 'exact';
        return rearm(eps);
      }
      if (key === 'W' && shown && shownLongEnough && shown.canWhitelistDirectory) {
        eps.whitelistConfirm = 'directory';
        return rearm(eps);
      }
    }
    return rearm(eps);
  }

  /**
   * Keys on a whitelist confirmation (`scope`: which pattern it shows):
   * `y` approves the focused escalation and whitelists that pattern, once
   * armed and with this confirmation (and so the complete pattern) on
   * screen; `n`, Esc and Ctrl-C go back to the escalation and restart the
   * window; Ctrl-A dismisses the picker to command mode. Anything else is
   * swallowed and re-arms.
   */
  function handleWhitelistConfirmKey(eps: EscalationPickerState, scope: WhitelistScope, key: string): MuxAction {
    if (key === 'n' || key === ESCAPE || key === CTRL_C) {
      eps.whitelistConfirm = false;
      return rearm(eps);
    }
    if (key === CTRL_A) {
      return { kind: 'escalation-dismiss', targetMode: 'command' };
    }
    if (key === 'y') {
      const now = clock();
      const shown = drawnFocus(eps);
      const offered = scope === 'directory' ? shown?.canWhitelistDirectory : shown?.canWhitelist;
      if (
        shown?.view === whitelistConfirmView(scope) &&
        offered === true &&
        now >= decisionArmedAt(eps.armedAt, shown.since, armingDelayMs)
      ) {
        return resolveFocused(eps, 'approved', scope);
      }
    }
    return rearm(eps);
  }

  /**
   * Keys on the approve-all confirmation. `y` approves exactly the listed
   * escalations, once armed and once every line of the list has been on
   * screen for the arming delay. `n`, Esc, Ctrl-C and Ctrl-A cancel; the
   * arrow, page and Home/End keys scroll and restart the window. Anything
   * else is swallowed and re-arms.
   */
  function handleBulkApproveKey(key: string): MuxAction {
    const bulk = _bulkApproveState;
    if (!bulk) return { kind: 'none' };

    if (key === 'n' || key === ESCAPE || key === CTRL_C || key === CTRL_A) {
      return { kind: 'escalation-approve-all-cancel' };
    }

    const delta = scrollDelta(key, bulk.scrollOffset);
    if (delta !== null) {
      bulk.scrollOffset = Math.max(0, bulk.scrollOffset + delta);
      return rearm(bulk);
    }

    if (key === 'y') {
      const now = clock();
      const shown = displayedBulkApproval();
      if (
        now >= bulk.armedAt &&
        shown?.setKey === bulkApprovalKey(bulk.reviewed, bulk.whitelist) &&
        shown.seenAllSince !== null &&
        now >= shown.seenAllSince + armingDelayMs
      ) {
        return {
          kind: 'escalation-approve-reviewed',
          reviewed: bulk.reviewed,
          whitelist: bulk.whitelist,
          ...(bulk.group ? { groupKey: bulk.group.key } : {}),
        };
      }
    }
    return rearm(bulk);
  }

  function handlePtyKey(key: string, rawCode?: Buffer | number): MuxAction {
    if (key === CTRL_A) {
      _mode = 'command';
      return { kind: 'enter-command-mode' };
    }

    if (key === CTRL_E) {
      return { kind: 'escalation-open' };
    }

    const data = rawCode != null ? rawCodeToString(rawCode) : key;
    return { kind: 'write-pty', data };
  }

  function handleCommandKey(key: string): MuxAction {
    // Ctrl-A in command mode returns to PTY mode
    if (key === CTRL_A) {
      _mode = 'pty';
      return { kind: 'enter-pty-mode' };
    }

    // Ctrl-E opens escalation picker
    if (key === CTRL_E) {
      return { kind: 'escalation-open' };
    }

    // Escape or Ctrl-C: clear buffer, stay in command mode
    if (key === ESCAPE || key === CTRL_C) {
      _inputBuffer = '';
      _cursorPos = 0;
      return { kind: 'redraw-input' };
    }

    // Enter: dispatch command or trusted input
    if (key === ENTER) {
      const text = _inputBuffer.trim();
      _inputBuffer = '';
      _cursorPos = 0;

      if (!text) {
        return { kind: 'redraw-input' };
      }

      // Commands start with /
      if (text.startsWith('/')) {
        const parts = text.slice(1).split(/\s+/);
        const command = parts[0].toLowerCase();
        const args = parts.slice(1);
        return { kind: 'command', command, args };
      }

      // Non-command text -> trusted input
      return { kind: 'trusted-input', text };
    }

    // Backspace
    if (key === BACKSPACE) {
      if (_cursorPos > 0) {
        _inputBuffer = _inputBuffer.slice(0, _cursorPos - 1) + _inputBuffer.slice(_cursorPos);
        _cursorPos--;
        return { kind: 'redraw-input' };
      }
      return { kind: 'none' };
    }

    // Delete
    if (key === DELETE) {
      if (_cursorPos < _inputBuffer.length) {
        _inputBuffer = _inputBuffer.slice(0, _cursorPos) + _inputBuffer.slice(_cursorPos + 1);
        return { kind: 'redraw-input' };
      }
      return { kind: 'none' };
    }

    // Arrow keys
    if (key === LEFT) {
      if (_cursorPos > 0) {
        _cursorPos--;
        return { kind: 'redraw-input' };
      }
      return { kind: 'none' };
    }

    if (key === RIGHT) {
      if (_cursorPos < _inputBuffer.length) {
        _cursorPos++;
        return { kind: 'redraw-input' };
      }
      return { kind: 'none' };
    }

    // Up: move to same column on previous line, or scroll if on first line
    if (key === UP) {
      const lastNl = _inputBuffer.lastIndexOf('\n', _cursorPos - 1);
      if (lastNl === -1) return { kind: 'scroll-up', amount: SCROLL_LINES };
      const col = _cursorPos - lastNl - 1;
      const prevNl = _inputBuffer.lastIndexOf('\n', lastNl - 1);
      const prevLineLen = lastNl - (prevNl + 1);
      _cursorPos = prevNl + 1 + Math.min(col, prevLineLen);
      return { kind: 'redraw-input' };
    }

    // Down: move to same column on next line, or scroll if on last line
    if (key === DOWN) {
      const lastNl = _inputBuffer.lastIndexOf('\n', _cursorPos - 1);
      const col = lastNl === -1 ? _cursorPos : _cursorPos - lastNl - 1;
      const nextNl = _inputBuffer.indexOf('\n', _cursorPos);
      if (nextNl === -1) return { kind: 'scroll-down', amount: SCROLL_LINES };
      const nextNextNl = _inputBuffer.indexOf('\n', nextNl + 1);
      const nextLineLen = nextNextNl === -1 ? _inputBuffer.length - nextNl - 1 : nextNextNl - nextNl - 1;
      _cursorPos = nextNl + 1 + Math.min(col, nextLineLen);
      return { kind: 'redraw-input' };
    }

    // Home: move cursor to beginning
    if (key === HOME) {
      _cursorPos = 0;
      return { kind: 'redraw-input' };
    }

    // End: move cursor to end
    if (key === END) {
      _cursorPos = _inputBuffer.length;
      return { kind: 'redraw-input' };
    }

    // Alt-1 through Alt-9: quick tab switching
    const altMatch = /^ALT_(\d)$/.exec(key);
    if (altMatch) {
      return { kind: 'command', command: 'tab', args: [altMatch[1]] };
    }

    // Regular printable character
    if (key.length === 1 && key.charCodeAt(0) >= 32) {
      _inputBuffer = _inputBuffer.slice(0, _cursorPos) + key + _inputBuffer.slice(_cursorPos);
      _cursorPos++;
      return { kind: 'redraw-input' };
    }

    return { kind: 'none' };
  }

  return {
    get mode() {
      return _mode;
    },
    get inputBuffer() {
      return _inputBuffer;
    },
    get cursorPos() {
      return _cursorPos;
    },
    get pickerState() {
      return _pickerState;
    },
    get resumePickerState() {
      return _resumePickerState;
    },
    get personaPickerState() {
      return _personaPickerState;
    },
    get providerPickerState() {
      return _providerPickerState;
    },

    enterPickerMode,
    enterResumePickerMode,
    exitResumePickerMode,
    enterPersonaPickerMode,
    exitPersonaPickerMode,
    exitProviderPickerMode,
    enterBrowseWithError,
    exitPickerMode,
    enterEscalationPickerMode,
    exitEscalationPickerMode,
    dismissEscalationPicker,
    focusEscalation,
    reconcileEscalations,
    toggleEscalationDetailView,
    scrollEscalationDetailView,
    enterBulkApproveConfirm,
    exitBulkApproveConfirm,
    enterMessagePanel,
    exitMessagePanel,

    get escalationPickerState() {
      return _escalationPickerState;
    },
    get bulkApproveState() {
      return _bulkApproveState;
    },
    get messagePanelState() {
      return _messagePanelState;
    },

    handleKey(key: string, rawCode?: Buffer | number): MuxAction {
      if (_mode === 'pty') {
        return handlePtyKey(key, rawCode);
      }
      if (_mode === 'picker') {
        return handlePickerKey(key);
      }
      if (_mode === 'resume-picker') {
        return handleResumePickerKey(key);
      }
      if (_mode === 'persona-picker') {
        return handlePersonaPickerKey(key);
      }
      if (_mode === 'provider-picker') {
        return handleProviderPickerKey(key);
      }
      if (_mode === 'escalation-picker') {
        return handleEscalationPickerKey(key);
      }
      if (_mode === 'escalation-approve-all') {
        return handleBulkApproveKey(key);
      }
      if (_mode === 'message-panel') {
        return handleMessagePanelKey(key);
      }
      return handleCommandKey(key);
    },

    handlePaste(text: string): MuxAction {
      if (!text) return { kind: 'none' };

      // A paste into the picker or the approve-all screen is input that was
      // not meant for it: swallowed, and the arming window starts again.
      if (_mode === 'escalation-picker' && _escalationPickerState) {
        return rearm(_escalationPickerState);
      }
      if (_mode === 'escalation-approve-all' && _bulkApproveState) {
        return rearm(_bulkApproveState);
      }

      if (_mode === 'pty') {
        return { kind: 'write-pty', data: PASTE_START + text + PASTE_END };
      }

      if (_mode === 'command') {
        // Preserve newlines (normalize line endings to \n)
        const sanitized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        _inputBuffer = _inputBuffer.slice(0, _cursorPos) + sanitized + _inputBuffer.slice(_cursorPos);
        _cursorPos += sanitized.length;
        return { kind: 'redraw-input' };
      }

      if (_pickerState?.phase === 'browse' && !_pickerState.inList) {
        // Paths are single-line: strip all newlines
        const sanitized = text.replace(/[\r\n]+/g, ' ');
        _pickerState.inputPath =
          _pickerState.inputPath.slice(0, _pickerState.cursorPos) +
          sanitized +
          _pickerState.inputPath.slice(_pickerState.cursorPos);
        _pickerState.cursorPos += sanitized.length;
        resetEntrySelection(_pickerState);
        return { kind: 'redraw-picker' };
      }

      return { kind: 'none' };
    },
  };
}
