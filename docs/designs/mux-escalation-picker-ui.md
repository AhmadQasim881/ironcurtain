# Mux Escalation Picker UI -- Feasibility Analysis

**Status (2026-11-14):** Implemented (`src/mux/escalation-picker-state.ts`, `src/mux/mux-escalation-manager.ts`). Section 5 describes the current behaviour: an arriving escalation never takes the keyboard, and Ctrl-E opens the picker.

## 1. Current Escalation UX Flow

### How escalations surface today

The mux has two input modes relevant to escalations: **PTY mode** (keystrokes go to the active child process) and **command mode** (keystrokes go to a line editor). The user toggles between them with Ctrl-A.

When an escalation arrives (current behaviour, section 5; nothing takes the keyboard):

1. `MuxEscalationManager.onEscalation` fires, triggers a BEL character (`\x07`) to the terminal
2. The tab bar and the PTY-mode footer redraw with a yellow `[!N pending]` badge (right-aligned)
3. The footer's second row shows a banner: `! Escalation [N] server/tool is waiting for your decision · Ctrl-E to review` (or `! K escalations pending, newest [N] server/tool`); while `/new`, `/resume` or another panel holds the keyboard it ends `Esc out, then Ctrl-E to review`
4. The user presses **Ctrl-E** to open the escalation picker, or **Ctrl-A** to enter command mode

In command mode, the overlay paints over the bottom of the PTY viewport:

```
[escalation panel]  -- 0 to MAX_ESCALATION_PANEL_ROWS (12) rows
[hint bar]          -- 1 row: shows /approve N, /deny N, etc.
[input line]        -- 1-6 rows: the command/trusted-input editor
```

The escalation panel shows each pending escalation in up to 4 rows:
- Header: `[N] Session #M  server/tool`
- Arguments: packed `key: value` pairs
- Reason line
- Whitelist candidate line (if applicable)

An overflow indicator shows `[+N more -- Ctrl-E to review them, or /deny all]` when not all fit. It no longer suggests `/approve all`: escalations that are not on screen are reviewed one at a time.

### How the user resolves escalations

The user types a slash command in the input line:
- `/approve 3` -- approve escalation #3
- `/approve+ 3` -- approve and whitelist the exact pattern (the first candidate: paths bound exactly)
- `/approve+dir 3` -- approve and whitelist the directory-wide pattern (paths widened to their directories, recursively), when the escalation offers one; otherwise nothing is resolved and the footer says so
- `/deny 3` -- deny escalation #3
- `/approve all`, `/approve+ all` -- open the approve-all confirmation screen, which lists every pending escalation; nothing is approved until `y` there (section 5.4)
- `/approve group 3`, `/approve+ group 3` -- open the same screen for the escalations sharing #3's whitelist pattern (section 6.2)
- `/deny all` -- deny all pending

The number comes from the `[N]` display number shown in the escalation panel. The command is parsed in `handleCommand()` in `mux-app.ts`, which calls `escalationManager.resolve(num, decision, { whitelist })` with `whitelist` set to `'exact'`, `'directory'` or `false`. `/approve+dir all` is refused: a directory-wide pattern is chosen one escalation at a time.

### Pain points with the current flow

1. **Two-step interaction**: the user must read the display number from the panel, then type it back. This is error-prone when multiple escalations are pending.
2. **No per-item navigation**: there's no way to "focus" a specific escalation to inspect it more closely before deciding.
3. **Limited visibility**: the panel maxes out at 12 rows (3 escalations at 4 rows each). With many pending escalations, the user sees only a few plus an overflow count.
4. **No inline approve/deny**: each resolution requires typing a full command, pressing Enter, reading the flash message. Batch operations (`/approve all`) exist but are all-or-nothing.

## 2. Existing Picker/Overlay Patterns

The codebase already has **three picker overlay implementations** that follow an identical pattern:

| Picker | Mode name | Trigger | State type | Renderer |
|--------|-----------|---------|------------|----------|
| New session | `picker` | `/new` command | `PickerState` | `drawPickerOverlay()` |
| Resume session | `resume-picker` | `/resume` command | `ResumePickerState` | `drawResumePickerOverlay()` |
| Persona | `persona-picker` | `/new` -> "Use a persona" | `PersonaPickerState` | `drawPersonaPickerOverlay()` |

### Common picker pattern

All three pickers follow this architecture:

**Input handler** (`mux-input-handler.ts`):
- Dedicated `InputMode` enum value (e.g. `'resume-picker'`)
- Dedicated state interface with `selectedIndex`, `scrollOffset`, items array
- Dedicated key handler function (arrow keys to navigate, Enter to select, Esc to cancel)
- Enter/exit functions that set the mode and create/null the state
- `isPickerMode()` helper that matches all picker variants

**Renderer** (`mux-renderer.ts`):
- Dedicated `draw*PickerOverlay()` function per picker type
- Bottom-panel pickers use `_layout.pickerY` and `_layout.pickerRows` for positioning (bottom half of viewport)
- The escalation picker is a floating overlay that renders centered over the full PTY viewport (no reserved rows)
- Highlighted item shown with `term.bgCyan.black('> ...')`

**Types** (`types.ts`):
- `isBottomPanelPicker()` matches picker/resume-picker/persona-picker (claim viewport rows)
- `isPickerMode()` matches all pickers including escalation-picker
- `calculateLayout()` only reserves `pickerRows` for bottom-panel pickers

**App** (`mux-app.ts`):
- `handleAction()` dispatches picker actions (`enter-picker-mode`, `picker-cancel`, `picker-spawn`, etc.)
- `MuxRendererDeps` provides getter for each picker state
- `drawActiveOverlay()` dispatches to the correct draw function based on mode

### Input routing

The key routing is clean and centralized in `MuxInputHandler.handleKey()`:

```
if mode === 'pty'            -> handlePtyKey()      -- all keys to PTY except Ctrl-A
if mode === 'picker'         -> handlePickerKey()    -- arrow/enter/esc
if mode === 'resume-picker'  -> handleResumePickerKey()
if mode === 'persona-picker' -> handlePersonaPickerKey()
if mode === 'command'        -> handleCommandKey()   -- line editor
```

While a picker is open, PTY input is **fully blocked** -- keystrokes don't reach the child process. This is acceptable because pickers are brief, user-initiated interactions. That premise only holds while every picker, the escalation picker included, opens because the user asked for it. An escalation picker that opened on its own (the original design in section 3.5) took keystrokes typed for the agent, for the `/new` path browser or for a command-mode message and read them as decisions: `a` approved, `w` whitelisted, `A` approved everything. It also cancelled the other pickers, so the rest of a path typed into `/new` went to the agent's PTY. The escalation picker therefore opens only on Ctrl-E, and its decision keys are armed only after a delay (section 5).

### Rendering model

The mux uses **terminal-kit** for cursor positioning and styled output, plus **xterm.js headless** for PTY buffer management. There are no real "layers" -- the renderer paints regions sequentially from top to bottom: tab bar, PTY viewport, footer, then whichever overlay is active. Overlays paint over the bottom rows of the PTY viewport. The PTY viewport size is constant; overlays just reduce the number of rows the PTY renderer draws.

## 3. Implementation Design: Tab-Per-Escalation Picker

### 3.1 Design Overview

The escalation picker uses a **tab-per-escalation** model: each pending escalation gets a full-detail view. Left/Right arrows (or Tab/Shift-Tab) switch between escalations. The currently viewed escalation is always shown with full detail. Single-key presses (a/d) resolve the focused escalation once the picker is armed; `w` first shows the exact whitelist pattern and `y` confirms it (section 5).

The picker opens only when the user presses **Ctrl-E**; an arriving escalation rings the bell and shows the badge and a footer banner instead (the original design auto-opened it, see section 3.5). It **auto-closes** when all escalations are resolved. The user can dismiss it with Esc to return to PTY/command mode, and re-open it with Ctrl-E. Sections 3.2 to 3.14 record the original design; where they differ from section 5, section 5 describes the code.

### 3.2 Type Definitions

#### InputMode addition (`src/mux/types.ts`)

```typescript
export type InputMode = 'pty' | 'command' | 'picker' | 'resume-picker' | 'persona-picker' | 'escalation-picker';

export function isPickerMode(mode: InputMode): boolean {
  return mode === 'picker' || mode === 'resume-picker' || mode === 'persona-picker' || mode === 'escalation-picker';
}
```

#### EscalationPickerState (`src/mux/mux-input-handler.ts`)

```typescript
export interface EscalationPickerState {
  /**
   * The display number of the currently focused escalation tab.
   * This is NOT an array index -- it's the monotonic displayNumber from
   * PendingEscalation, which survives additions and removals.
   */
  focusedDisplayNumber: number;

  /**
   * The mode the user was in before the picker opened.
   * Used to restore when the picker is dismissed with Esc.
   */
  previousMode: 'pty' | 'command';

  /**
   * Whether the picker was dismissed by the user (Esc).
   * When true, auto-open is suppressed until a NEW escalation arrives
   * (one whose displayNumber is higher than any seen when dismissed).
   * Reset to false when a new escalation triggers auto-open.
   */
  dismissed: boolean;

  /**
   * The highest displayNumber that was pending when the user last
   * dismissed the picker. Auto-open only fires for escalations with
   * displayNumber > this value.
   */
  dismissedAtNumber: number;
}
```

The `dismissed` and `dismissedAtNumber` fields live on the handler (not on the state object that gets nulled), since they must survive across dismiss/re-open cycles. They are separate tracking variables in the handler closure (original design: both were removed with auto-open; the current state, with `focusedEscalationId`, `armedAt` and `whitelistConfirm`, is in `src/mux/escalation-picker-state.ts`, section 5):

```typescript
// Inside createMuxInputHandler closure:
let _escalationPickerState: EscalationPickerState | null = null;
let _escalationDismissed = false;
let _escalationDismissedAtNumber = 0;
```

#### New MuxAction variants (`src/mux/types.ts`)

```typescript
export type MuxAction =
  // ... existing variants ...
  | { readonly kind: 'escalation-resolve'; readonly displayNumber: number; readonly decision: 'approved' | 'denied'; readonly whitelist: boolean }
  | { readonly kind: 'escalation-resolve-all'; readonly decision: 'approved' | 'denied'; readonly whitelist: boolean }
  | { readonly kind: 'escalation-dismiss' }
  | { readonly kind: 'escalation-open' }
  // ... rest of existing variants ...
```

### 3.3 Input Handler Behavior

#### Enter/exit functions

```typescript
function enterEscalationPickerMode(
  focusedDisplayNumber: number,
  previousMode: 'pty' | 'command',
): void {
  _mode = 'escalation-picker';
  _escalationPickerState = {
    focusedDisplayNumber,
    previousMode,
  };
  _escalationDismissed = false;
}

function exitEscalationPickerMode(): void {
  const prev = _escalationPickerState?.previousMode ?? 'pty';
  _mode = prev;
  _escalationPickerState = null;
}

function dismissEscalationPicker(highestPendingNumber: number): void {
  _escalationDismissed = true;
  _escalationDismissedAtNumber = highestPendingNumber;
  exitEscalationPickerMode();
}
```

Both `enterEscalationPickerMode` and `dismissEscalationPicker` are public methods on the `MuxInputHandler` interface so `mux-app.ts` can call them.

#### Key handler: `handleEscalationPickerKey(key)`

The table describes the current code. "Armed" means the arming delay has passed since the picker opened, since the last focus change and since the last key other than a decision that counts, navigating, viewing and scrolling included (section 5.2); "shown" means the renderer drew the focused escalation in full, as that same request, for at least the delay (sections 4.2 and 5.3). A key that does not count is swallowed, never forwarded to the PTY, and restarts the delay.

| Key | Action |
|-----|--------|
| `RIGHT`, `TAB` | Move to next escalation tab (wrap around); re-arms, even when the focus does not move -> `{ kind: 'escalation-navigate', direction: 'next' }` |
| `LEFT`, `SHIFT_TAB` | Move to previous escalation tab (wrap around); re-arms, even when the focus does not move -> `{ kind: 'escalation-navigate', direction: 'prev' }` |
| `a` | Armed and shown: resolve focused escalation as approved -> `{ kind: 'escalation-resolve', displayNumber, escalationId, decision: 'approved', whitelist: false }` |
| `d` | Armed: resolve focused escalation as denied -> `{ kind: 'escalation-resolve', displayNumber, escalationId, decision: 'denied', whitelist: false }` (the request need not be on screen: denying is safe) |
| `w` | Armed, shown and the request offers a pattern: open the whitelist confirmation, which shows the complete pattern and re-arms -> `{ kind: 'redraw-picker' }` |
| `y` (whitelist confirmation) | Armed and the confirmation drawn in full: approve and whitelist -> `{ kind: 'escalation-resolve', ..., decision: 'approved', whitelist: true }`; `n`, Esc and Ctrl-C go back to the escalation and re-arm |
| `A` (shift-a) | Nothing: there is no single-key approve-all (a stray key, so it re-arms). Bulk approval goes through `/approve all` (section 5.4) |
| `D` (shift-d) | Armed: deny ALL -> `{ kind: 'escalation-deny-all' }` |
| `ESCAPE`, `CTRL_C` | Dismiss picker, armed or not -> `{ kind: 'escalation-dismiss' }` |
| `CTRL_A` | Dismiss picker, enter command mode (same as Esc but always goes to command) -> `{ kind: 'escalation-dismiss', targetMode: 'command' }` |
| `v` | Toggle the full-detail view of the focused escalation (section 4.3), armed or not; re-arms -> `{ kind: 'redraw-picker' }` |
| `UP`, `DOWN`, `PAGE_UP`, `PAGE_DOWN`, `HOME`, `END` | Scroll the detail view when it is open; re-arms -> `{ kind: 'redraw-picker' }`; in the summary view a stray key |
| any other key, a paste | Swallowed, re-arms -> `{ kind: 'redraw-picker' }` (the hint bar shows `wait`) |

Implementation of tab navigation (original sketch, before arming and binding):

```typescript
function handleEscalationPickerKey(key: string): MuxAction {
  const eps = _escalationPickerState;
  if (!eps) return { kind: 'none' };

  if (key === ESCAPE || key === CTRL_C) {
    return { kind: 'escalation-dismiss' };
  }

  if (key === CTRL_A) {
    return { kind: 'escalation-dismiss' };
  }

  // Tab navigation: LEFT/SHIFT_TAB = prev, RIGHT/TAB = next
  if (key === RIGHT || key === TAB) {
    return { kind: 'escalation-navigate', direction: 'next' };
  }
  if (key === LEFT || key === 'SHIFT_TAB') {
    return { kind: 'escalation-navigate', direction: 'prev' };
  }

  // Single-key resolve actions
  if (key === 'a') {
    return { kind: 'escalation-resolve', displayNumber: eps.focusedDisplayNumber, decision: 'approved', whitelist: false };
  }
  if (key === 'd') {
    return { kind: 'escalation-resolve', displayNumber: eps.focusedDisplayNumber, decision: 'denied', whitelist: false };
  }
  if (key === 'w') {
    return { kind: 'escalation-resolve', displayNumber: eps.focusedDisplayNumber, decision: 'approved', whitelist: true };
  }

  // Batch resolve (shift keys)
  if (key === 'A') {
    return { kind: 'escalation-resolve-all', decision: 'approved', whitelist: false };
  }
  if (key === 'D') {
    return { kind: 'escalation-resolve-all', decision: 'denied', whitelist: false };
  }

  return { kind: 'none' };
}
```

Note: unlike other pickers where the input handler mutates state in-place and returns `{ kind: 'redraw-picker' }`, the escalation picker emits `{ kind: 'escalation-navigate', direction }` because the input handler does not have access to the live pending escalations list. Navigation is handled by `mux-app.ts` which reads the sorted display numbers from `escalationManager` and updates `eps.focusedDisplayNumber`.

This requires one additional MuxAction variant:

```typescript
| { readonly kind: 'escalation-navigate'; readonly direction: 'next' | 'prev' }
```

The reason navigation is an action (unlike other pickers): the input handler does **not** hold a copy of the pending escalations list. Other pickers snapshot their items on enter. The escalation picker references live state from `escalationManager`, so `mux-app.ts` handles the navigation by reading the live sorted display numbers and updating `focusedDisplayNumber`.

#### Ctrl-E interception in PTY and command modes

In `handlePtyKey()`:

```typescript
function handlePtyKey(key: string): MuxAction {
  if (key === CTRL_A) {
    _mode = 'command';
    return { kind: 'enter-command-mode' };
  }
  if (key === 'CTRL_E') {
    return { kind: 'escalation-open' };
  }
  return { kind: 'write-pty', data: KEY_TO_SEQUENCE[key] ?? key };
}
```

In `handleCommandKey()`:

```typescript
// Add after the CTRL_A check:
if (key === 'CTRL_E') {
  return { kind: 'escalation-open' };
}
```

#### handleKey routing addition

```typescript
handleKey(key: string): MuxAction {
  if (_mode === 'pty') return handlePtyKey(key);
  if (_mode === 'picker') return handlePickerKey(key);
  if (_mode === 'resume-picker') return handleResumePickerKey(key);
  if (_mode === 'persona-picker') return handlePersonaPickerKey(key);
  if (_mode === 'escalation-picker') return handleEscalationPickerKey(key);
  return handleCommandKey(key);
}
```

### 3.4 Tab Index to Display Number Mapping

The picker does **not** use array indices. It stores `focusedDisplayNumber` directly -- the monotonically increasing number from `PendingEscalation.displayNumber`. This is critical because:

1. Escalations can expire or be resolved while the picker is open, removing entries from the middle.
2. New escalations can arrive, adding entries at the end.
3. Display numbers are what the user sees in the tab header, so the mapping is direct and unambiguous.

Navigation computes the sorted display number list on every key press:

```typescript
// In mux-app.ts handleAction for 'escalation-navigate':
function navigateEscalationTab(direction: 'next' | 'prev'): void {
  const eps = inputHandler.escalationPickerState;
  if (!eps) return;

  const sortedNums = [...escalationManager.state.pendingEscalations.keys()].sort((a, b) => a - b);
  if (sortedNums.length === 0) return;

  const currentIdx = sortedNums.indexOf(eps.focusedDisplayNumber);
  let newIdx: number;

  if (currentIdx === -1) {
    // Focused escalation was resolved/expired -- snap to nearest
    newIdx = 0;
  } else if (direction === 'next') {
    newIdx = (currentIdx + 1) % sortedNums.length;
  } else {
    newIdx = (currentIdx - 1 + sortedNums.length) % sortedNums.length;
  }

  eps.focusedDisplayNumber = sortedNums[newIdx];
}
```

### 3.5 Arrival, Auto-Close and Focus Snap

The original design auto-opened the picker from the escalation manager's `onChange` callback whenever a new escalation arrived, from any mode, cancelling an open `/new`, resume, persona or provider picker or message panel first, and suppressed that only until a higher display number arrived after an Esc. The next key the user typed, for the agent or for a host-side picker, became a decision (audit finding TUI-1). That behaviour is gone.

#### Where it hooks in

`onChange` in `mux-app.ts` still fires on every escalation state change, but the transition rules live in a pure, clock-injected function, `reconcileEscalationUi(current, pending, now, armingDelayMs)` in `src/mux/escalation-picker-state.ts`, which the input handler applies (`MuxInputHandler.reconcileEscalations(pending)`) and the app only redraws after:

```typescript
escalationManager.onChange(() => {
  const transition = inputHandler.reconcileEscalations(escalationManager.pendingRefs());
  if (transition.outcome === 'picker-closed' || transition.outcome === 'bulk-cancelled') {
    renderer.fullRedraw();
  } else {
    renderer.redrawTabBar();
    renderer.redrawCommandArea();
  }
  if (transition.message) showMessage(transition.message);
});
```

`pending` is the list of pending escalations as `{ displayNumber, escalationId }`, sorted by display number. The function never changes any mode other than the escalation picker and the approve-all screen.

#### Edge cases

| Scenario | Behavior |
|----------|----------|
| User in PTY, an escalation arrives | Nothing takes the keyboard: BEL, the `[!N pending]` badge and the footer banner. Keys keep going to the agent. Ctrl-E opens the picker. |
| User in command mode typing, an escalation arrives | The input buffer and the mode stay as they are; the escalation panel above the input shows it. Ctrl-E opens the picker (`previousMode = 'command'`, buffer preserved). |
| User in another picker or panel (`/new`, resume, persona, provider, message panel), an escalation arrives | That picker stays open with everything typed into it; the footer banner says `Esc out, then Ctrl-E to review`. |
| User opens the picker with Ctrl-E | Focus on the lowest pending number; disarmed for the arming delay (section 5.2). |
| User dismisses with Esc | Picker closes; badge and banner stay while anything is pending. |
| User resolves focused escalation (a/d/w), more remain | Picker stays open. Focus moves to the next escalation (the next higher display number), or to the last one if the resolved one was the last, and the picker re-arms: a second key pressed within the delay decides nothing. |
| User resolves focused escalation, none remain | Auto-close: returns to `previousMode`. |
| Escalation expires while picker is open and focused on it | Same as resolved: focus moves to the next (or last) escalation and the picker re-arms. |
| Escalation expires while picker is open but focused on different one | Tab disappears; focus and arming unchanged. |
| A new escalation arrives while picker is open | New tab appears; focus and arming unchanged. |
| All escalations expire while picker is open | Auto-close: returns to `previousMode`. |
| Approve-all screen open, the pending set changes in any way | The screen closes, nothing is approved, and the footer says to run `/approve all` again (section 5.4). |

### 3.6 Action Handling in mux-app.ts

Original sketch. The current handlers open the picker only from `escalation-open` (Ctrl-E) on the lowest pending escalation, pass `{ whitelist, escalationId }` to `resolve()` so the manager refuses a decision on another request than the one shown, and replace `escalation-resolve-all` with `escalation-deny-all` (`D`, `/deny all`) and `escalation-approve-reviewed` (`y` on the approve-all screen, section 5.4).

```typescript
// Add to handleAction() switch:

case 'escalation-open': {
  if (escalationManager.pendingCount === 0) {
    showMessage('No pending escalations');
    break;
  }
  const sortedNums = [...escalationManager.state.pendingEscalations.keys()].sort((a, b) => a - b);
  const previousMode: 'pty' | 'command' =
    inputHandler.mode === 'command' ? 'command' : 'pty';
  inputHandler.enterEscalationPickerMode(sortedNums[0], previousMode);
  renderer.fullRedraw();
  break;
}

case 'escalation-dismiss': {
  const highestPending = escalationManager.pendingCount > 0
    ? Math.max(...escalationManager.state.pendingEscalations.keys())
    : 0;
  inputHandler.dismissEscalationPicker(highestPending);
  renderer.fullRedraw();
  break;
}

case 'escalation-navigate': {
  navigateEscalationTab(action.direction);
  renderer.redrawCommandArea();
  break;
}

case 'escalation-resolve': {
  const message = escalationManager.resolve(action.displayNumber, action.decision, action.whitelist);
  showMessage(message);
  // After resolve, if picker still open, the onChange callback handles
  // focus adjustment and auto-close.
  renderer.redrawTabBar();
  renderer.redrawCommandArea();
  break;
}

case 'escalation-resolve-all': {
  const message = escalationManager.resolveAll(action.decision, action.whitelist);
  showMessage(message);
  // onChange callback will auto-close the picker since pendingCount -> 0
  renderer.redrawTabBar();
  renderer.redrawCommandArea();
  break;
}
```

### 3.7 Renderer Layout

#### Overlay sizing

The escalation picker renders as a **floating overlay** centered over the full PTY viewport. Unlike bottom-panel pickers (which claim `_layout.pickerRows`), the escalation picker does not reserve any viewport rows — `isBottomPanelPicker()` excludes `'escalation-picker'`, so `calculateLayout()` sets `pickerRows = 0`. The overlay dimensions are computed dynamically in `drawEscalationPickerOverlay()` based on content and terminal size.

#### Visual layout: single escalation

```
  Escalation [3]  (1 of 1)
  ──────────────────────────────────────────────────────────
  Session #1  filesystem/write_file                    12s ago
  ──────────────────────────────────────────────────────────
  Arguments:
    path: /home/user/project/src/main.ts
    content: (248 chars) "import { foo } from './bar';\n..."
  Reason:
    write outside sandbox
  Whitelist:
    /approve+ will whitelist: write_file to /home/user/project/src/
  ──────────────────────────────────────────────────────────
   a  approve    d  deny    w  approve+    Esc  dismiss
```

#### Visual layout: multiple escalations (2+)

```
  [3] filesystem/write_file    >[4] filesystem/delete_file    [5] git/push
  ──────────────────────────────────────────────────────────
  Session #1  filesystem/delete_file                     8s ago
  ──────────────────────────────────────────────────────────
  Arguments:
    path: /home/user/project/old-module.ts
  Reason:
    delete outside sandbox
  ──────────────────────────────────────────────────────────
   a  approve    d  deny    w  approve+    D  deny all    ←→  switch    Esc  dismiss
```

(There is no `A approve all` key: see section 5.4. While the picker is disarmed the hint bar reads `wait  decision keys unlock in a moment` instead of offering the decision keys; `w` appears only when the request offers a whitelist pattern.)

#### Row allocation within the overlay

```
Row 0:        Tab bar (display numbers, focused tab highlighted)
Row 1:        Separator
Row 2:        Tool header (Session #N  server/tool  time-ago)
Row 3:        Separator
Rows 4..N-2:  Detail area (arguments, reason, whitelist -- scrollable if overflow)
Row N-1:      Separator
Row N:        Hint bar (key bindings)
```

Fixed rows: tab bar (1) + 2 separators (2) + tool header (1) + hint bar (1) = 5 rows overhead. Remaining rows go to the detail area. With a typical 12-row picker overlay, that gives 7 rows for detail content, which is generous for most tool calls.

#### drawEscalationPickerOverlay() implementation sketch

```typescript
function drawEscalationPickerOverlay(): void {
  const eps = deps.getEscalationPickerState();
  if (!eps) return;

  // Floating overlay: compute dimensions dynamically (no reserved layout rows).
  // See actual implementation for full sizing/centering logic.

  const pending = deps.getEscalationState().pendingEscalations;
  const sortedEscalations = [...pending.values()].sort((a, b) => a.displayNumber - b.displayNumber);

  if (sortedEscalations.length === 0) return; // auto-close should handle this

  const focused = pending.get(eps.focusedDisplayNumber);
  if (!focused) return; // stale focus, onChange will fix

  let currentY = startY;

  // Row 0: Tab bar -- each escalation gets a tab label
  clearLine(currentY);
  moveTo(2, currentY);
  for (const esc of sortedEscalations) {
    const isFocused = esc.displayNumber === eps.focusedDisplayNumber;
    const label = ` [${esc.displayNumber}] ${esc.request.serverName}/${esc.request.toolName} `;
    if (isFocused) {
      term.bgCyan.black(label);
      term.styleReset();
    } else {
      term.dim(label);
    }
    term(' ');
  }
  term.eraseLineAfter();
  currentY++;

  // Separator
  clearLine(currentY);
  moveTo(2, currentY);
  term.dim('\u2500'.repeat(Math.max(0, _cols - 4)));
  term.styleReset();
  currentY++;

  // Tool header
  clearLine(currentY);
  moveTo(2, currentY);
  const timeAgo = formatTimeSince(focused.receivedAt);
  term(`Session #${focused.sessionDisplayNumber}  `);
  term.cyan(`${focused.request.serverName}/${focused.request.toolName}`);
  term.dim(`  ${timeAgo}`);
  term.eraseLineAfter();
  currentY++;

  // Separator
  clearLine(currentY);
  moveTo(2, currentY);
  term.dim('\u2500'.repeat(Math.max(0, _cols - 4)));
  term.styleReset();
  currentY++;

  // Detail area: arguments, reason, whitelist
  const detailRows = totalRows - 5; // 5 = tab bar + 2 separators + header + hint bar
  let detailLinesUsed = 0;

  // Arguments
  const argLines = formatArgLines(focused.request.arguments, _cols - 8);
  if (argLines.length > 0) {
    clearLine(currentY);
    moveTo(4, currentY);
    term.dim('Arguments:');
    currentY++;
    detailLinesUsed++;

    for (const line of argLines) {
      if (detailLinesUsed >= detailRows) break;
      clearLine(currentY);
      moveTo(6, currentY);
      term(truncate(line, _cols - 8));
      term.eraseLineAfter();
      currentY++;
      detailLinesUsed++;
    }
  }

  // Reason
  if (detailLinesUsed < detailRows) {
    clearLine(currentY);
    moveTo(4, currentY);
    term.dim('Reason: ');
    term(truncate(focused.request.reason, _cols - 14));
    term.eraseLineAfter();
    currentY++;
    detailLinesUsed++;
  }

  // Whitelist candidates
  if (
    detailLinesUsed < detailRows &&
    focused.request.whitelistCandidates &&
    focused.request.whitelistCandidates.length > 0
  ) {
    const candidate = focused.request.whitelistCandidates[0];
    clearLine(currentY);
    moveTo(4, currentY);
    term.dim('/approve+ ');
    term.cyan(truncate(candidate.description, _cols - 16));
    if (candidate.warning) {
      term.yellow(` (${candidate.warning})`);
    }
    term.eraseLineAfter();
    currentY++;
    detailLinesUsed++;
  }

  // Fill remaining detail rows with blank
  while (detailLinesUsed < detailRows) {
    clearLine(currentY);
    currentY++;
    detailLinesUsed++;
  }

  // Hint bar
  clearLine(currentY);
  moveTo(2, currentY);
  term.bgWhite.black(' a ');
  term.styleReset();
  term.dim(' approve  ');
  term.bgWhite.black(' d ');
  term.styleReset();
  term.dim(' deny  ');
  term.bgWhite.black(' w ');
  term.styleReset();
  term.dim(' approve+  ');
  if (sortedEscalations.length > 1) {
    term.bgWhite.black(' A ');
    term.styleReset();
    term.dim(' all  ');
    term.bgWhite.black(' D ');
    term.styleReset();
    term.dim(' deny all  ');
    term.bgWhite.black(' \u2190\u2192 ');
    term.styleReset();
    term.dim(' switch  ');
  }
  term.bgWhite.black(' Esc ');
  term.styleReset();
  term.dim(' dismiss');
  term.eraseLineAfter();
}
```

#### Wire into drawActiveOverlay

```typescript
function drawActiveOverlay(): void {
  const mode = deps.getMode();
  if (mode === 'command') drawCommandOverlay();
  else if (mode === 'picker') drawPickerOverlay();
  else if (mode === 'resume-picker') drawResumePickerOverlay();
  else if (mode === 'persona-picker') drawPersonaPickerOverlay();
  else if (mode === 'escalation-picker') drawEscalationPickerOverlay();
}
```

#### Helper: formatTimeSince

```typescript
function formatTimeSince(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}
```

### 3.8 Live Update Behavior

Unlike other pickers that snapshot their data on open, the escalation picker reads live state from `escalationManager.state.pendingEscalations` on every render. This is the fundamental difference from other pickers and it drives several design choices:

| Event | Effect on picker |
|-------|-----------------|
| New escalation arrives while picker is open | New tab appears in tab bar. Focus stays on current tab. Tab bar redraws. |
| Focused escalation is resolved by user (a/d/w) | Tab disappears. Focus moves to the next tab (or the last one if it was last) and the picker re-arms. If none remain, auto-close. |
| Focused escalation expires (timeout) | Same as resolved: focus moves to the next (or last) tab and the picker re-arms. |
| Non-focused escalation expires | Tab disappears from tab bar. No focus change. |
| All escalations resolved/expired | Auto-close fires. Mode returns to `previousMode`. |

The renderer always reads the live `pendingEscalations` map; it never caches. The `onChange` callback in `mux-app.ts` applies `reconcileEscalationUi` (section 3.5), which handles focus correction, re-arming and auto-close, before triggering a redraw.

### 3.9 MuxRendererDeps Addition

```typescript
export interface MuxRendererDeps {
  // ... existing deps ...
  getEscalationPickerState: () => EscalationPickerState | null;
}
```

Wired in `mux-app.ts`:

```typescript
getEscalationPickerState: () => inputHandler.escalationPickerState,
```

### 3.10 MuxInputHandler Interface Additions

```typescript
export interface MuxInputHandler {
  // ... existing members ...

  /** Current escalation picker state (null when not in escalation picker mode). */
  readonly escalationPickerState: EscalationPickerState | null;

  /** Open the picker (Ctrl-E) on `focus`, disarmed for the arming delay. */
  enterEscalationPickerMode(focus: PendingRef, previousMode: 'pty' | 'command'): void;

  /** Exit escalation picker mode (return to previous mode). */
  exitEscalationPickerMode(): void;

  /** Dismiss (Esc) the escalation picker. */
  dismissEscalationPicker(targetMode?: 'pty' | 'command'): void;

  /** Move the focus (navigation); another escalation re-arms the picker. */
  focusEscalation(focus: PendingRef): void;

  /** Apply a change to the pending escalations (`reconcileEscalationUi`, section 3.5). */
  reconcileEscalations(pending: readonly PendingRef[]): EscalationUiTransition;

  /** The approve-all confirmation screen (section 5.4). */
  readonly bulkApproveState: BulkApproveState | null;
  enterBulkApproveConfirm(reviewed: readonly PendingRef[], whitelist: boolean, previousMode: 'pty' | 'command'): void;
  exitBulkApproveConfirm(): void;
}
```

The original interface also had `escalationDismissed` and `escalationDismissedAtNumber`, which suppressed auto-open after an Esc; both went away with auto-open.

### 3.11 Interaction with Command-Mode Escalation Panel

The existing command-mode escalation panel (in `drawCommandOverlay()`) is **kept as-is**. It continues to show escalation details when the user is in command mode and the escalation picker is not open.

Rationale: the command-mode panel serves a different purpose -- it is passive context while the user types commands. The `/approve` and `/deny` commands continue to work. Power users who prefer typing over the picker can still use the old flow. The escalation picker is an accelerator, not a replacement.

The original design auto-opened the picker over command mode when an escalation arrived, which turned the message being typed into decisions. Now an arrival leaves command mode, its buffer and its cursor alone; the panel above the input shows the new escalation, and Ctrl-E opens the picker when the user chooses to.

### 3.12 Footer Hint Update

When in PTY mode with pending escalations, the footer currently shows:

```
N escalation(s) pending -- /approve, /approve+, or /deny
```

This changes to a highlighted banner with the Ctrl-E binding, naming the newest escalation (its tool display-sanitized like every agent-derived string, section 4.1):

```
 ! Escalation [N] server/tool is waiting for your decision · Ctrl-E to review
 ! K escalations pending, newest [N] server/tool · Ctrl-E to review
```

The banner is the second footer row in PTY mode and in every picker or panel other than the escalation screens (there it ends `Esc out, then Ctrl-E to review`); a flash message takes the row for its three seconds. Command mode keeps its own hint, since its escalation panel lists the escalations. The longer `/approve` command hints are no longer needed in the footer since the picker makes them discoverable. The slash commands still work in command mode; they just are not advertised in PTY mode anymore.

### 3.13 Files to Modify

| File | Changes |
|------|---------|
| `src/mux/types.ts` | Add `'escalation-picker'` to `InputMode`. Update `isPickerMode()`. Add 5 new `MuxAction` variants (`escalation-resolve`, `escalation-resolve-all`, `escalation-dismiss`, `escalation-open`, `escalation-navigate`). |
| `src/mux/mux-input-handler.ts` | Add `EscalationPickerState` interface. Add `_escalationPickerState`, `_escalationDismissed`, `_escalationDismissedAtNumber` closure vars. Add `handleEscalationPickerKey()`. Add `enterEscalationPickerMode()`, `exitEscalationPickerMode()`, `dismissEscalationPicker()`. Add Ctrl-E handling to `handlePtyKey()` and `handleCommandKey()`. Wire into `handleKey()` dispatch. Expose new state/methods on returned interface. |
| `src/mux/mux-renderer.ts` | Add `drawEscalationPickerOverlay()`. Add `formatTimeSince()` helper. Wire into `drawActiveOverlay()`. Add `getEscalationPickerState` to `MuxRendererDeps`. Update PTY-mode footer hint text for Ctrl-E. |
| `src/mux/mux-app.ts` | Handle new action kinds in `handleAction()`. Add `navigateEscalationTab()` helper. Rewrite `escalationManager.onChange()` callback for auto-open/auto-close logic. Pass `getEscalationPickerState` to renderer deps. |

No new files needed. The pattern is established well enough that all changes fit into existing modules.

### 3.14 Testing Strategy

The input handler is a pure state machine (key in, action out). Tests for the escalation picker follow the same pattern as existing picker tests:

1. **Key mapping tests**: verify each key produces the correct `MuxAction` variant.
2. **Enter/exit tests**: verify mode transitions and `previousMode` preservation.
3. **Arming**: with an injected clock (`MuxInputHandlerOptions.now`), keys inside the arming window, right after a focus snap, held down or typed as text decide nothing and are never forwarded; `A` does nothing (`test/mux-input-handler.test.ts`).
4. **Navigation and transitions**: `navigateFocus`, `focusAfterRemoval` and `reconcileEscalationUi` are pure functions in `src/mux/escalation-picker-state.ts`, tested directly with explicit clock readings (`test/mux-escalation-picker-state.test.ts`): wraparound, the snap to the next escalation and its re-arming, auto-close, an arrival that changes no mode, and the approve-all screen cancelled by a changed set.

The original plan tested the auto-open logic in the `onChange` callback at integration level; that logic moved into `reconcileEscalationUi`, so the callback in `mux-app.ts` only applies the result and redraws. The manager's refusals (a stale escalation id, a stale approve-all set) are tested against real escalation files (`test/mux-escalation-manager.test.ts`).

The renderer was originally not unit-tested (consistent with existing pickers). Its row planners and text formatters are now pure exported functions with unit tests (`test/mux-renderer.test.ts`), and the drawn output is tested end to end through a real terminal-kit Terminal (section 4.1).

### 3.15 Estimated Effort

This is a **medium feature** (2-3 days). The tab-per-escalation model is simpler than a list+detail split view (no scroll state within the list, no list/detail phase toggle), but the auto-open/auto-close logic and live update handling add complexity beyond a static picker.

## 4. Untrusted Text, Row Reservation, Detail View and Message Panel

This section records how the picker, the command-mode panel and the footer were hardened after the audit (findings TUI-2, TPM-15, SES-7, RED-4, TUI-7 and TUI-16). It supersedes the panel description in section 1 and the rendering sketches in section 3.7 where they differ.

### 4.1 Every agent-derived string is display-safe

Tool arguments, reasons, whitelist descriptions, server and tool names, session labels and context values come from the agent and are drawn on the host terminal. terminal-kit's `term(...)` and styled calls pass control bytes through verbatim and interpret `^` markup and `%` format specifiers (`%s` renders as `(undefined)`, `^r` changes the colour), so an argument could repaint the tool line, write the clipboard with OSC 52 or make the terminal type a reply into the picker. The renderer therefore has one helper, `untrusted(text, maxWidth?)`, used for every such string:

1. `toDisplayText` (`src/terminal/display-sanitize.ts`): C0 and C1 controls, DEL, bidi overrides and isolates, zero-width and other format characters, and variation selectors, Hangul fillers and the other default-ignorable code points become visible `\u...` escapes (an ordinary emoji keeps its one presentation selector); nothing is dropped.
2. `truncateToWidth` (`src/terminal/display-width.ts`): the cut is measured in display cells after escaping, so CJK and emoji text cannot overrun the box border, and since the control characters are already escaped a cut can only shorten an escape's visible spelling, never leave a fragment the terminal acts on; an ellipsis marks the cut.
3. `escapeTerminalKitMarkup`: `^` becomes `^^` and `%` becomes `%%`, so the styled call prints the text literally.

String argument values are shown JSON-quoted (`path: "/tmp/x\u001b[2J"`), so hidden characters are visible as escapes and a value's boundaries are unambiguous; non-string values are JSON too. Keys that are not plain identifiers are quoted as well. The command-mode input echo, the `/new` path field and directory entries, and the resume, persona and provider pickers go through the same pipeline, so typed, pasted or file-system `^`, `%` and control characters print literally.

`test/escalation-render-sanitize.test.ts` renders a hostile escalation (ESC, BEL, CSI, OSC 52, 8-bit C1, bidi override, `^` and `%`) through a real terminal-kit Terminal writing into memory, asserts that no control byte from the request reaches the stream, and replays the bytes into a headless xterm to check that the screen shows the literal escaped spellings.

### 4.2 Rows are planned, not clipped

`planEscalationDetailRows(esc, budget, innerWidth, argLines?)` (picker) and `planEscalationPanelRows(pending, panelRows, argWidth, argLinesFor?)` (command-mode panel) are pure functions in `mux-renderer.ts` that decide what each row shows before anything is drawn:

- In the picker, the tool header has a fixed row, and the reason row, the whitelist rows (`/approve+ <pattern>` when there is a candidate, then `/approve+dir <pattern>` when there is a directory-wide one) and one argument row (when there are arguments) are reserved: the planner returns them even when the budget is smaller. The patterns that `w` and `W` would whitelist are never pushed out by long arguments, and arguments are never dropped without a notice. When the viewport cannot hold the box with those rows, the renderer draws a one-row notice (`Escalation [N] pending: the terminal is too small to show it ...`) instead of a dialog that would pass for complete. The renderer reports which escalation its latest draw showed in full (`MuxRenderer.displayedEscalation`: the summary dialog or the detail view, `null` for the notice, a closed picker or a focus with nothing to draw), and the app passes that to the input handler (`MuxInputHandlerOptions.displayedEscalation`; the record also carries the escalation id, the view and since when it has been on screen, section 5.3): `a`, `w` and `W` are swallowed for an escalation that is not on screen, so nothing is approved or whitelisted unseen. `d` and Esc keep working, and `v` opens the detail view, which needs fewer rows than the summary and, once drawn, counts as on screen.
- Arguments that do not fit are reported, never silently dropped: the picker's label row reads `Arguments: (+N hidden, v to view)`, or `Arguments: (values cut, v to view)` when every line is shown but a value had to be cut to the width; the command-mode panel appends `(+N hidden, Ctrl-E, v to view)`. N counts hidden arguments. When the summary cuts anything (arguments, a long reason or whitelist pattern), the box title reads `Escalation (truncated: v shows all)`.
- In the command-mode panel every shown escalation gets its header, at least one argument row, its reason and its whitelist lines (`calculateLayout` gives the panel one more row per escalation that offers a directory-wide pattern). Rows are shared evenly between escalations, and an escalation whose reserved rows do not fit is not shown at all; it is counted in a trailing `[+N more -- Ctrl-E to review them, or /deny all]` row that never overwrites content (it no longer suggests approving unseen escalations in bulk).
- The picker box takes the detail rows the viewport can spare, giving up its 2-row top and bottom margin before giving up content.

Cost: the overlays are drawn with every frame of PTY output. An overlay is sent when its bytes change or after adjacent PTY spans are emitted on a row it covers; the latter repaint follows those spans in the same synchronized frame. PTY cells with uncertain host widths or invisible formatting become styled spaces within their recorded columns (see `terminal-multiplexer.md` section 3.3). An argument can be megabytes long (a `write_file` body), so a summary row serializes only the head of each value (`formatArgValue(value, maxLength)`; the JSON of a string's head is a prefix of the JSON of the string), the width helpers stop reading once a cut is known, and the renderer caches each escalation's argument lines and detail-view lines per width (`WeakMap` keyed by the pending escalation, which never changes).

### 4.3 Detail view

`EscalationPickerState.detailView` (`null` for the summary view, `{ scrollOffset }` for the detail view) selects a full-detail rendering of the focused escalation inside the same box: session and tool, the complete reason, the whitelist patterns (behind `/approve+` and `/approve+dir`), the context and every argument as pretty-printed, sanitized JSON (`formatEscalationDetailLines`), hard-wrapped to the box and scrollable. Nothing is cut, so the approver can read exactly what `a` would approve. `v` toggles the view; the arrow keys, PageUp/PageDown, Home and End scroll it. The input handler owns the state (`toggleEscalationDetailView()`, `scrollEscalationDetailView(delta)`); the renderer clamps the offset to the content and writes it back, so paging past the end does not accumulate. Navigating to another escalation, or a focus snap after the focused one is resolved or expires, starts the view at the top. Viewing keys decide nothing; the decision keys (`a`, `d`, `w`, `W`) work from both views, as long as the view is drawn (section 4.2).

### 4.4 Footer flash and message panel

The footer is the last screen row. A message with a line feed, or one longer than the row, scrolls the alternate screen and shifts the tab bar and viewport until the next full redraw. `showMessage` now collapses the message to its first line (display-sanitized) plus `(+N more)` and cuts it to the terminal width, and the fixed footer hints are cut the same way. Multi-line output goes to the message panel instead: `message-panel` is a bottom-panel picker mode (`MessagePanelState { title, lines, scrollOffset, previousMode }`) that claims the bottom half of the viewport like `/new`; `/sessions` always opens it, and `/deny all`, the picker's `D` and the approve-all confirmation open it when more than one result line comes back. Esc, Enter, `q` and Ctrl-C emit `message-panel-dismiss`, which restores the previous mode; arrows and PageUp/PageDown scroll; other keys are swallowed rather than forwarded to the PTY. A new escalation does not cancel the panel (nothing auto-opens); the footer banner announces it. As a guard for anything the renderer misses, the app resets autowrap (`ESC[?7l`) while fullscreen and restores it on shutdown and at exit.

## 5. Arrival, Arming, Binding and Bulk Approval

This section records how escalation input was changed after the audit (findings TUI-1 and TUI-8). It supersedes sections 3.1, 3.3, 3.5 and 3.6 where they differ. The state machine is in `src/mux/escalation-picker-state.ts` (pure functions, the clock passed in); the input handler owns the state and applies it.

### 5.1 An arrival never takes the keyboard

When an escalation arrives the manager rings the bell (BEL), the tab bar and the PTY-mode footer show the `[!N pending]` badge, and the footer shows a banner naming the newest escalation (section 3.12). Nothing else changes: the picker opens only on Ctrl-E, and no other picker or panel is cancelled to make room for it, so a path typed into `/new`, a command-mode message or keys meant for the agent stay where the user typed them. `reconcileEscalationUi` changes no mode other than the escalation picker's and the approve-all screen's (section 3.5).

### 5.2 Arming

Decision keys (`a`, `d`, `w`, `W`, `D`, and `y` on a confirmation) count only once the picker is armed, `ESCALATION_ARMING_DELAY_MS` (1 s) after the latest of:

- the picker opening (Ctrl-E);
- a focus change: navigation to another escalation, or the snap to the next one when the focused escalation is resolved or expires;
- opening a whitelist confirmation (`w` or `W`);
- any other key: a decision key pressed too early, a key with no meaning in the picker, a paste, and also the keys that navigate (←/→, Tab, even with a single escalation), view (`v`), scroll the detail view or go back from the whitelist confirmation.

A key that does not count is swallowed, never forwarded to the agent's PTY, and restarts the delay (`EscalationPickerState.armedAt`). So a double tap after a resolve does not approve the next escalation, a held key's auto-repeat never decides, and a sentence typed into the picker (Ctrl-E is also "end of line" in shells and readline, so an accidental open is plausible) decides nothing: a decision counts only when no other key came in the second before it, so "va..." (`v` toggles the view) or a Tab right before an `a` approves nothing either. Dismissing (Esc, Ctrl-C, Ctrl-A), navigating (←/→, Tab) and viewing (`v`, and the scroll keys in the detail view) decide nothing and work while disarmed; apart from dismissing, they restart the delay like any other key. While disarmed the hint bar reads `wait  decision keys unlock in a moment` and the renderer schedules a redraw for the moment the keys unlock. The clock is monotonic (`performance.now`), shared by the input handler and the renderer and injectable for tests, so a wall-clock step neither skips nor stretches the delay.

### 5.3 Decisions bound to what was drawn

The renderer reports what its latest overlay draw showed in full (`MuxRenderer.displayedEscalation`): display number, escalation id, view (`summary`, `detail`, `whitelist-confirm` or `whitelist-directory-confirm`), whether the request offers a whitelist pattern and a directory-wide one, and `since`, the start of the unbroken run of draws that showed this request in full. A notice, another escalation or a closed picker ends the run, so a request that reappears (after the terminal was enlarged, say) is new on screen again.

- `a` approves, and `w` or `W` opens a whitelist confirmation, only for the focused escalation drawn in full, as the same request, for the whole delay (`decisionArmedAt(armedAt, since, delay)`). `d` and `D` need only the arming: denying unseen is safe.
- Every decision carries the escalation id (`escalation-resolve.escalationId`), and `MuxEscalationManager.resolve(n, decision, { whitelist, escalationId })` refuses it, writing nothing, when another request is pending under number `n` ("Escalation #n was not resolved: it is not the request that was shown"). Display numbers are never reused, so this is a backstop for the binding, not the main control.
- `w` no longer whitelists at once. It replaces the box with a confirmation that shows the complete pattern `/approve+` would select (hard-wrapped, display-sanitized) and re-arms; `y` approves and whitelists once armed and only while that confirmation is drawn in full; `n`, Esc and Ctrl-C go back (and restart the delay). When the pattern does not fit, a notice replaces the box and `y` does nothing. A request without a pattern (a human-only escalation never has one) has no `w`.
- `W` does the same for the directory-wide pattern (`/approve+dir`), when the request offers one: its confirmation (`EscalationPickerState.whitelistConfirm === 'directory'`, view `whitelist-directory-confirm`) is titled `Approve [N] and whitelist the directory` and says the pattern is recursive. `y` whitelists the pattern of the confirmation that is on screen and nothing else: after `W` it needs the directory-wide confirmation drawn, after `w` the exact one.

### 5.4 Bulk approval

There is no single-key approve-all: `A` in the picker is a stray key (it also caught Caps Lock slips of `a`). `D` (deny all) stays, since denying everything is fail-closed.

`/approve all` and `/approve+ all` in command mode open the approve-all confirmation (`escalation-approve-all` mode, `BulkApproveState`), a floating box like the picker's that lists every pending escalation (`formatBulkApprovalLines`): `[N] Session #M  server/tool`, its arguments as packed, escaped `key: value` lines (a cut value ends with an ellipsis and a note says where to see it whole), its reason, and for `/approve+ all` the complete pattern each would whitelist. Human-only escalations are listed with "stays pending; approve it on its own". When nothing but human-only escalations is pending, the screen does not open and the footer says to approve them one at a time.

- `y` approves exactly the listed set (`escalation-approve-reviewed` with the reviewed `{ displayNumber, escalationId }` list) once the screen is armed and once every line of the list has been on screen for the delay. The renderer tracks which lines it drew while the screen stayed open at one width (`MuxRenderer.displayedBulkApproval`); jumping to the end does not count the lines skipped, and a resize that rewraps the list starts the count again. Until then the hint reads `scroll to review every line first`.
- Any change to the pending set while the screen is open (an arrival, an expiry, a resolution elsewhere) closes it, approving nothing, and the footer says to run the command again. `MuxEscalationManager.approveAll(reviewed, { whitelist })` refuses too, resolving nothing, unless the pending set is exactly `reviewed`.
- `n`, Esc, Ctrl-C and Ctrl-A cancel; the arrow, page and Home/End keys scroll and, like any other key, restart the delay, so `y` counts only after a full delay with no other key.
- `/deny all` and `D` deny every pending escalation at once (`MuxEscalationManager.denyAll`).
- The command-mode overflow row and hint bar no longer suggest `/approve all`.

### 5.5 Standalone listener

`ironcurtain escalation-listener` has no picker; every decision is a typed command and Enter, so it needs no arming. Its bulk approval follows the same rule as the mux: `/approve all` and `/approve+ all` without a code approve nothing and print every pending escalation (tool, every argument, reason, for `/approve+ all` the pattern, human-only ones marked) with the command that approves exactly that set, `/approve all <code>`. The code (`bulkApprovalCode`) is the first six hex digits of a SHA-256 over the set (display number, session and escalation id of each) and the variant, so it is void as soon as anything arrives, expires or is resolved, and the code for `/approve all` does not work for `/approve+ all`. A stale or wrong code is refused with the current listing. Human-only escalations stay pending either way.

## 6. Reviewer Context and Group Approval

This section records the reviewer context and the grouped approval added for audit finding DTL-12. Two-person (quorum) approval (DTL-14) was deferred by the owner and does not exist.

### 6.1 Reviewer context

An escalation request can carry three more fields besides the call (`EscalationRequest` in `src/session/types.ts`; `src/trusted-process/escalation-context.ts`):

- `lastTrustedUserMessage` (TRUSTED): the human's most recent message, `{ text, sentAt? }`. The pipeline reads it when the call goes to a human, from the same source as the auto-approver: for a PTY session only what the trusted-input bar wrote (`source: 'mux-trusted-input'`), never what the session itself recorded. Unlike the auto-approver it also shows a stale message, with the time it was sent; nothing is approved on its strength.
- `taskSummary` (TRUSTED): the first human message of the session, attached by the session (`SessionTaskSummary`). PTY sessions have none.
- `agentJustification` (UNTRUSTED): the optional `justification` the agent passed to the `execute_code` chain that issued the call. The coordinator reads it when the call enters (`ToolCallCoordinator.setAgentJustificationProvider`); it is attributed only while exactly one chain runs (`src/sandbox/chain-justifications.ts`). It never reaches the auto-approver, the policy engine or the whitelist.

The picker summary plans one reserved row each (`planEscalationDetailRows`): `Task:` and `You said:` above the arguments (the message is left out when it is the task itself, as in a one-shot or cron session: `displayedUserMessage`), and `Agent says (untrusted):` below the whitelist row, set apart from the human's text. Each row is cut to the width; a cut marks the box title `truncated: v shows all`, and the detail view (`formatEscalationDetailLines`) shows all three in full. The task and the message keep their line breaks and come first. The justification comes last, after the arguments, under `Agent says (UNTRUSTED: written by the agent, it authorizes nothing):`, as one escaped paragraph (a line break shows as `\n`) with a `│` gutter on every row: the detail view takes decisions once armed and is where a small terminal sends the user, so the agent's text must not be able to lay out rows that imitate the arguments, or push the real arguments off the first screen with blank lines. The approve-all and approve-group lists show `You said:` cut to one row and the justification in full on one escaped line. All three go through `untrusted()` like every agent-derived string (section 4.1).

### 6.2 Group approval

Pending escalations whose first whitelist candidate -- the exact pattern `/approve+` selects -- is the same pattern form a group (`src/escalation/escalation-groups.ts`). The key is `WhitelistCandidateIpc.patternKey`, a JSON encoding of server, tool and constraints written by the pipeline (`whitelistPatternKey`): the description alone is ambiguous, since a directory name can contain the `, ` that separates constraint labels. A human-only escalation and one whose first candidate has no key, or is not the exact one, never group. The directory-wide candidate (`/approve+dir`, `W`) never forms a group: widening to a directory is chosen one escalation at a time, so writes to different files of one directory are approved one by one, and `/approve+ group N` whitelists each member's exact pattern only. Groups span sessions (each session surfaces one escalation at a time); `MuxEscalationManager.pendingRefs()` stamps each ref with its `groupKey`, and `groupOf(n)` returns #n's group.

- When the focused escalation shares its pattern with others, the picker adds a row: `N pending escalations share this pattern: /approve group <n> reviews them`.
- `/approve group N` (and `/approve+ group N`, which whitelists each member's pattern in its own session) opens the approve-all screen for the group's members (`BulkApproveState.group`), headed by `Every call below matches: <pattern>`. It refuses when #N is not pending, not groupable, or alone in its group. All the rules of section 5.4 hold with the group in place of the pending set: `y` counts only once armed and once every line was on screen; `reconcileEscalationUi` closes the screen when the group's members change (an arrival outside the group does not); `MuxEscalationManager.approveGroup(reviewed, key, { whitelist })` approves nothing unless `reviewed` is exactly the group pending now, and approves each member once.
