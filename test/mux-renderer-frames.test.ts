/**
 * Mux frames and damage tracking (TUI-11).
 *
 * Every redraw reaches the terminal as one write wrapped in synchronized
 * output; streaming output repaints only the PTY rows that changed; the tab
 * bar and footer are sent again only when they change; overlays also repaint
 * after adjacent PTY spans on covered rows; and an
 * overlay is composed into the frame, so PTY output never paints the cells
 * under the escalation dialog. The renderer draws through a real
 * terminal-kit Terminal captured in memory, and the bytes are replayed into
 * a headless xterm to read the screen the user sees.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import xtermHeadless from '@xterm/headless';

import {
  createMuxRenderer,
  readTerminalBuffer,
  renderCellSpan,
  type MuxRenderer,
  type TranslatedCell,
} from '../src/mux/mux-renderer.js';
import { createFrameWriter, SYNC_OUTPUT_BEGIN, SYNC_OUTPUT_END, type FrameStream } from '../src/mux/frame-writer.js';
import type { EscalationPickerState } from '../src/mux/mux-input-handler.js';
import type { InputMode, MuxTab } from '../src/mux/types.js';
import type { PtyBridge } from '../src/pty/pty-bridge.js';
import { addEscalation, addSession, createInitialState, type ListenerState } from '../src/escalation/listener-state.js';
import { captureTerminalKit, type CapturedTerminalKit } from './helpers/terminal-kit-capture.js';
import { stripTerminalSequences } from '../src/terminal/display-sanitize.js';
import { displayWidth } from '../src/terminal/display-width.js';

const { Terminal } = xtermHeadless;

const COLS = 100;
const ROWS = 30;

type HeadlessTerminal = InstanceType<typeof Terminal>;

function writeAndWait(terminal: HeadlessTerminal, data: string): Promise<void> {
  return new Promise((resolve) => {
    terminal.write(data, resolve);
  });
}

function listenerStateWithEscalation(): ListenerState {
  const watcher = { start: () => undefined, stop: () => undefined, getPending: () => [], resolve: () => true };
  let state = addSession(
    createInitialState(),
    {
      sessionId: 'session-1',
      escalationDir: '/nonexistent',
      label: 'claude-code',
      startedAt: new Date().toISOString(),
      pid: 4242,
    },
    watcher,
  );
  state = addEscalation(state, 'session-1', {
    escalationId: 'esc-1',
    serverName: 'filesystem',
    toolName: 'write_file',
    arguments: { path: '/etc/hosts' },
    reason: 'Writes outside the sandbox',
  });
  return state;
}

interface Harness {
  readonly capture: CapturedTerminalKit;
  readonly renderer: MuxRenderer;
  readonly xterm: HeadlessTerminal;
  mode: InputMode;
  scrollOffset: number | null;
  /** The command-mode input buffer; the cursor sits at its end. */
  input: string;
  state: ListenerState;
  picker: EscalationPickerState | null;
  /** The renderer's clock (ms), when the harness was asked for a fixed one. */
  now: number;
  /** While set, reading the agent's screen throws: a frame fails after its overlay was drawn. */
  failScreenReads: boolean;
}

const renderers: MuxRenderer[] = [];

afterEach(() => {
  for (const renderer of renderers.splice(0)) renderer.destroy();
  vi.restoreAllMocks();
});

async function harness(
  options: { mode?: InputMode; state?: ListenerState; picker?: EscalationPickerState; fixedClock?: boolean } = {},
): Promise<Harness> {
  const capture = await captureTerminalKit(COLS, ROWS);
  const xterm = new Terminal({ cols: COLS, rows: ROWS - 3, allowProposedApi: true });
  const h = {
    capture,
    xterm,
    mode: options.mode ?? 'pty',
    scrollOffset: null,
    input: '',
    state: options.state ?? createInitialState(),
    picker: options.picker ?? null,
    now: 0,
    failScreenReads: false,
  } as Omit<Harness, 'renderer'> & { renderer: MuxRenderer };
  const bridge = {
    get terminal(): HeadlessTerminal {
      if (h.failScreenReads) throw new Error('screen read failed');
      return xterm;
    },
    alive: true,
  } as unknown as PtyBridge;
  const tab: MuxTab = { number: 1, bridge, label: 'claude-code', escalationAvailable: true, scrollOffset: null };
  h.renderer = createMuxRenderer(capture.term, COLS, ROWS, {
    getActiveTab: () => tab,
    getTabs: () => [tab],
    getActiveTabIndex: () => 0,
    getMode: () => h.mode,
    getInputBuffer: () => h.input,
    getCursorPos: () => h.input.length,
    getEscalationState: () => h.state,
    getPendingCount: () => h.state.pendingEscalations.size,
    getPickerState: () => null,
    getResumePickerState: () => null,
    getPersonaPickerState: () => null,
    getProviderPickerState: () => null,
    getEscalationPickerState: () => h.picker,
    getMessagePanelState: () => null,
    getScrollOffset: () => h.scrollOffset,
    ...(options.fixedClock === true ? { now: () => h.now } : {}),
  });
  renderers.push(h.renderer);
  return h;
}

/** The lines `alpha 0` .. `alpha 4`, one per row, on the agent's screen. */
async function fiveLines(xterm: HeadlessTerminal): Promise<void> {
  await writeAndWait(xterm, ['alpha 0', 'alpha 1', 'alpha 2', 'alpha 3', 'alpha 4'].join('\r\n'));
}

describe('mux frames', () => {
  it('sends a redraw as one write, wrapped in synchronized output', async () => {
    const h = await harness();
    await fiveLines(h.xterm);
    const write = vi.spyOn(h.capture.term.stdout as FrameStream, 'write');

    h.renderer.fullRedraw();

    expect(write).toHaveBeenCalledTimes(1);
    const sent = String(write.mock.calls[0][0]);
    expect(sent.startsWith(SYNC_OUTPUT_BEGIN)).toBe(true);
    expect(sent.endsWith(SYNC_OUTPUT_END)).toBe(true);
    expect(sent).toContain('alpha 4');
    // The stream's own write is back once the frame is out.
    expect((h.capture.term.stdout as FrameStream).write).toBe(write);
  });

  it('streaming output repaints only the rows that changed', async () => {
    const h = await harness();
    await fiveLines(h.xterm);
    h.renderer.fullRedraw();
    h.capture.reset();

    // A spinner on the third row ticks.
    await writeAndWait(h.xterm, '\x1b[3;1Halpha 2 working');
    h.renderer.redrawPty();

    const output = await h.capture.output();
    expect(output).toContain('alpha 2 working');
    for (const untouched of ['alpha 0', 'alpha 1', 'alpha 3', 'alpha 4']) expect(output).not.toContain(untouched);
    // The footer and tab bar did not change, so they were not sent again.
    expect(output).not.toContain('PTY #1');
    expect(output.length).toBeLessThan(300);
    expect((await h.capture.screen()).rows[3].trimEnd()).toBe('alpha 2 working');
  });

  it('sends nothing when nothing changed', async () => {
    const h = await harness();
    await fiveLines(h.xterm);
    h.renderer.fullRedraw();
    h.capture.reset();

    h.renderer.redrawPty();
    h.renderer.redrawCommandArea();
    h.renderer.redrawTabBar();

    expect(await h.capture.output()).toBe('');
  });

  it('scheduled output frames send the changed row and leave the footer alone', async () => {
    const h = await harness();
    await fiveLines(h.xterm);
    h.renderer.fullRedraw();
    h.capture.reset();

    await writeAndWait(h.xterm, '\x1b[5;1Halpha 4 done');
    h.renderer.scheduleRedraw();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const output = await h.capture.output();
    expect(output).toContain('alpha 4 done');
    expect(output).not.toContain('alpha 0');
    expect(output).not.toContain('PTY #1');
  });

  it('redraws the footer only when what it shows changes', async () => {
    const h = await harness();
    h.renderer.fullRedraw();
    h.capture.reset();

    h.renderer.redrawCommandArea(); // PTY mode: the footer only
    expect(await h.capture.output()).toBe('');

    h.renderer.showMessage('Session #2 exited with code 0');
    expect(await h.capture.output()).toContain('Session #2 exited with code 0');
  });

  it('a resize starts the row cache over', async () => {
    const h = await harness();
    await fiveLines(h.xterm);
    h.renderer.fullRedraw();
    h.capture.reset();

    h.renderer.resize(COLS, ROWS);
    h.renderer.redrawPty();

    const output = await h.capture.output();
    for (const line of ['alpha 0', 'alpha 1', 'alpha 2', 'alpha 3', 'alpha 4']) expect(output).toContain(line);
  });

  it('a scroll position change starts the row cache over', async () => {
    const h = await harness();
    for (let i = 0; i < 60; i++) await writeAndWait(h.xterm, `line ${i}\r\n`);
    h.renderer.fullRedraw();
    h.capture.reset();

    h.scrollOffset = 0;
    h.renderer.redrawPty();

    const screen = await h.capture.screen();
    expect(screen.rows[1].trimEnd()).toBe('line 0');
  });

  it('repaints rows an overlay held once they are PTY rows again', async () => {
    const h = await harness({ mode: 'command' });
    for (let i = 0; i < 26; i++) await writeAndWait(h.xterm, `row ${i}\r\n`);
    await writeAndWait(h.xterm, 'row 26');
    h.renderer.fullRedraw();
    // The command overlay holds the bottom rows: the last line is not shown.
    expect((await h.capture.screen()).rows.join('\n')).not.toContain('row 26');

    h.mode = 'pty';
    h.renderer.redrawPty();
    expect((await h.capture.screen()).rows[27].trimEnd()).toBe('row 26');
  });

  it('rows a growing command overlay took are repainted when it shrinks again, in the same mode', async () => {
    const h = await harness({ mode: 'command' });
    await writeAndWait(h.xterm, Array.from({ length: ROWS - 3 }, (_, i) => `row ${i}`).join('\r\n'));
    h.renderer.fullRedraw();
    const before = (await h.capture.screen()).rows;

    // More input lines grow the overlay over the PTY rows above it...
    h.input = 'one\ntwo\nthree\nfour\nfive';
    h.renderer.redrawCommandArea();
    const grown = (await h.capture.screen()).rows;
    expect(grown.join('\n')).toContain('five');
    expect(grown.join('\n')).not.toContain('row 22');

    // ...and clearing the input gives them back, unchanged on the agent's
    // side: they must show its rows again, not the overlay's old lines.
    h.input = '';
    h.renderer.redrawCommandArea();
    expect((await h.capture.screen()).rows).toEqual(before);
  });
});

describe('mux overlay composition', () => {
  function picker(): EscalationPickerState {
    return {
      focusedDisplayNumber: 1,
      focusedEscalationId: 'esc-1',
      previousMode: 'pty',
      detailView: null,
      armedAt: 0,
      whitelistConfirm: false,
    };
  }

  it('repaints a covered row after its adjacent PTY spans in the same frame', async () => {
    const h = await harness({ mode: 'escalation-picker', state: listenerStateWithEscalation(), picker: picker() });
    h.renderer.fullRedraw();
    const before = await h.capture.screen();
    const dialogRow = before.rows.findIndex((row) => row.includes('Reason:'));
    expect(dialogRow).toBeGreaterThan(0);
    const dialogText = before.rows[dialogRow].trim();
    const start = await h.capture.output();

    // The agent fills its whole screen while the dialog is open.
    const fill = Array.from({ length: ROWS - 3 }, () => 'X'.repeat(COLS)).join('\r\n');
    await writeAndWait(h.xterm, `\x1b[H${fill}`);
    h.renderer.redrawPty();

    const frame = (await h.capture.output()).slice(start.length);
    // The unchanged overlay is restored after all adjacent PTY spans.
    expect(frame).toContain('Reason:');
    expect(frame).toContain('Escalation');
    expect(frame.lastIndexOf('X')).toBeLessThan(frame.indexOf('Reason:'));

    const after = await h.capture.screen();
    // The dialog row keeps the dialog in the middle; PTY cells fill both sides.
    expect(after.rows[dialogRow]).toContain(dialogText);
    expect(after.rows[dialogRow].startsWith('X')).toBe(true);
    expect(after.rows[dialogRow].endsWith('X')).toBe(true);
    // Rows above the dialog are all PTY output.
    expect(after.rows[1]).toBe('X'.repeat(COLS));
  });

  it('keeps an unchanged covered row and its overlay cached', async () => {
    const h = await harness({ mode: 'escalation-picker', state: listenerStateWithEscalation(), picker: picker() });
    h.renderer.fullRedraw();
    h.capture.reset();

    h.renderer.redrawPty();

    expect(await h.capture.output()).toBe('');
  });

  it('scheduled covered-row output is followed by an overlay repaint', async () => {
    const h = await harness({ mode: 'escalation-picker', state: listenerStateWithEscalation(), picker: picker() });
    h.renderer.fullRedraw();
    const dialogRow = (await h.capture.screen()).rows.findIndex((row) => row.includes('Reason:'));
    expect(dialogRow).toBeGreaterThan(0);
    h.capture.reset();

    // The viewport begins one screen row below its terminal buffer.
    await writeAndWait(h.xterm, `\x1b[${dialogRow};1Hsample`);
    h.renderer.scheduleRedraw();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const frame = await h.capture.output();
    expect(frame).toContain('sample');
    expect(frame).toContain('Reason:');
    expect(frame.indexOf('sample')).toBeLessThan(frame.indexOf('Reason:'));
  });

  it('a row the dialog stops covering is repainted in full', async () => {
    const h = await harness({ mode: 'escalation-picker', state: listenerStateWithEscalation(), picker: picker() });
    const fill = Array.from({ length: ROWS - 3 }, () => 'Y'.repeat(COLS)).join('\r\n');
    await writeAndWait(h.xterm, fill);
    h.renderer.fullRedraw();

    h.mode = 'pty';
    h.renderer.redrawPty();

    const screen = await h.capture.screen();
    for (let row = 1; row < ROWS - 2; row++) expect(screen.rows[row]).toBe('Y'.repeat(COLS));
  });

  it('a shorter dialog in the same mode gives the rows it no longer covers back to the PTY', async () => {
    const watcher = { start: () => undefined, stop: () => undefined, getPending: () => [], resolve: () => true };
    let state = addSession(
      createInitialState(),
      { sessionId: 's', escalationDir: '/nonexistent', label: 'x', startedAt: new Date().toISOString(), pid: 1 },
      watcher,
    );
    const manyArguments = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`arg${i}`, `value ${i}`]));
    state = addEscalation(state, 's', {
      escalationId: 'tall',
      serverName: 'filesystem',
      toolName: 'write_file',
      arguments: manyArguments,
      reason: 'The tall one',
    });
    state = addEscalation(state, 's', {
      escalationId: 'short',
      serverName: 'filesystem',
      toolName: 'read_file',
      arguments: { path: '/x' },
      reason: 'The short one',
    });
    const numberOf = (id: string): number =>
      [...state.pendingEscalations.values()].find((esc) => esc.request.escalationId === id)?.displayNumber ?? 0;
    const h = await harness({
      mode: 'escalation-picker',
      state,
      picker: { ...picker(), focusedDisplayNumber: numberOf('tall'), focusedEscalationId: 'tall' },
    });
    await writeAndWait(h.xterm, Array.from({ length: ROWS - 3 }, () => 'Z'.repeat(COLS)).join('\r\n'));
    h.renderer.fullRedraw();
    expect((await h.capture.screen()).rows.join('\n')).toContain('arg7');

    // Focus moves to the short escalation: same mode, smaller dialog.
    h.picker = { ...picker(), focusedDisplayNumber: numberOf('short'), focusedEscalationId: 'short' };
    h.renderer.redrawCommandArea();
    const incremental = (await h.capture.screen()).rows;
    expect(incremental.join('\n')).not.toContain('arg7');
    expect(incremental.join('\n')).toContain('The short one');

    // Exactly what a full redraw shows: the rows the tall dialog held are agent rows again.
    h.renderer.fullRedraw();
    expect(incremental).toEqual((await h.capture.screen()).rows);
  });

  it('a frame that fails after drawing its overlay sends nothing and counts no dialog as displayed', async () => {
    const h = await harness({
      mode: 'escalation-picker',
      state: listenerStateWithEscalation(),
      picker: picker(),
      fixedClock: true,
    });
    h.now = 1_000;
    h.renderer.fullRedraw();
    expect(h.renderer.displayedEscalation?.since).toBe(1_000);

    // The overlay is drawn first; reading the agent's screen then fails, so
    // the frame (dialog included) never reaches the terminal.
    h.now = 2_000;
    h.failScreenReads = true;
    h.capture.reset();
    expect(() => h.renderer.redrawPty()).toThrow('screen read failed');
    expect(await h.capture.output()).toBe('');
    expect(h.renderer.displayedEscalation).toBeNull();

    // The next frame that does reach the terminal sends the dialog again and
    // starts its time on screen over: the failed frame armed nothing.
    h.now = 3_000;
    h.failScreenReads = false;
    h.renderer.redrawPty();
    expect(await h.capture.output()).toContain('Reason:');
    expect(h.renderer.displayedEscalation?.since).toBe(3_000);
  });
});

describe('renderCellSpan', () => {
  function cell(char: string, width = 1, fg: TranslatedCell['fg'] = 'default'): TranslatedCell {
    return {
      char,
      width,
      fg,
      bg: 'default',
      bold: false,
      italic: false,
      underline: false,
      dim: false,
      inverse: false,
      strikethrough: false,
    };
  }

  it('renders one SGR per style run, only for the cells in the span', () => {
    const row = [cell('a'), cell('b'), cell('c', 1, 1), cell('d', 1, 1), cell('e')];
    expect(renderCellSpan(row, 1, 4)).toEqual({ text: '\x1b[0;39;49mb\x1b[0;38;5;1;49mcd', end: 4 });
  });

  it('draws a wide character cut by the span edge as blanks, never past the edge', () => {
    // A wide character in columns 1-2.
    const row = [cell('a'), cell('界', 2), cell('b')];
    expect(renderCellSpan(row, 0, 2).text).toBe('\x1b[0;39;49ma ');
    expect(renderCellSpan(row, 2, 4)).toEqual({ text: '\x1b[0;39;49m b', end: 4 });
    expect(renderCellSpan(row, 0, 4).text).toBe('\x1b[0;39;49ma界b');
  });

  it.each([
    { char: '😀', width: 1, expected: ' ' },
    { char: '界', width: 1, expected: ' ' },
    { char: 'a', width: 2, expected: '  ' },
    { char: '👩\u200d💻', width: 2, expected: '  ' },
    { char: 'a\u200b', width: 1, expected: ' ' },
    { char: 'a\u034f', width: 1, expected: ' ' },
    { char: '❤\ufe0f', width: 2, expected: '  ' },
  ])('blanks a cell with an unsafe host width or format sequence ($char, $width)', ({ char, width, expected }) => {
    const result = renderCellSpan([cell(char, width)], 0, width);
    expect(stripTerminalSequences(result.text)).toBe(expected);
    expect(result.end).toBe(width);
  });

  it('keeps matching wide, emoji and combining-mark cells', () => {
    const result = renderCellSpan([cell('界', 2), cell('😀', 2), cell('e\u0301')], 0, 5);
    expect(stripTerminalSequences(result.text)).toBe('界😀e\u0301');
    expect(result.end).toBe(5);
  });

  it('every clipped Unicode span stays within its recorded cell budget', () => {
    const row = [cell('a'), cell('😀'), cell('界', 2), cell('👩\u200d💻', 2), cell('b')];
    for (let from = 0; from < 7; from++) {
      for (let to = from + 1; to <= 7; to++) {
        const result = renderCellSpan(row, from, to);
        const shown = stripTerminalSequences(result.text);
        expect(displayWidth(shown)).toBe(result.end - from);
        expect(displayWidth(shown)).toBeLessThanOrEqual(to - from);
        expect(shown).not.toMatch(/\p{Default_Ignorable_Code_Point}/u);
      }
    }
  });

  it('composes a real headless Unicode row within its host width budget', async () => {
    const terminal = new Terminal({ cols: 20, rows: 2, allowProposedApi: true });
    try {
      await writeAndWait(terminal, '界 😀 👩\u200d💻');
      const row = readTerminalBuffer(terminal, 0, 1, 20)[0];
      const result = renderCellSpan(row, 0, 20);
      const shown = stripTerminalSequences(result.text);
      expect(displayWidth(shown)).toBe(result.end);
      expect(displayWidth(shown)).toBeLessThanOrEqual(20);
      expect(shown).not.toMatch(/\p{Default_Ignorable_Code_Point}/u);
    } finally {
      terminal.dispose();
    }
  });

  it('reports where a short row ends', () => {
    expect(renderCellSpan([cell('a')], 0, 10)).toEqual({ text: '\x1b[0;39;49ma', end: 1 });
    expect(renderCellSpan([], 0, 10)).toEqual({ text: '', end: 0 });
  });
});

describe('createFrameWriter', () => {
  function stream(): FrameStream & { readonly sent: string[] } {
    const sent: string[] = [];
    return {
      sent,
      write(chunk: string | Uint8Array): boolean {
        sent.push(String(chunk));
        return true;
      },
    };
  }

  it('collects the writes of a frame and sends them once, synchronized', () => {
    const out = stream();
    const frames = createFrameWriter(out);
    frames.frame(() => {
      out.write('a');
      out.write('b');
      frames.frame(() => out.write('c')); // a nested frame joins the outer one
    });
    expect(out.sent).toEqual([`${SYNC_OUTPUT_BEGIN}abc${SYNC_OUTPUT_END}`]);
  });

  it('sends nothing for an empty frame, and runs the epilogue only after output', () => {
    const out = stream();
    const frames = createFrameWriter(out);
    const epilogue = vi.fn(() => out.write('!'));
    frames.frame(() => undefined, epilogue);
    expect(out.sent).toEqual([]);
    expect(epilogue).not.toHaveBeenCalled();

    frames.frame(() => out.write('x'), epilogue);
    expect(out.sent).toEqual([`${SYNC_OUTPUT_BEGIN}x!${SYNC_OUTPUT_END}`]);
  });

  it('captures a part of a frame instead of sending it', () => {
    const out = stream();
    const frames = createFrameWriter(out);
    let part = '';
    frames.frame(() => {
      part = frames.capture(() => out.write('region'));
      out.write('row');
      frames.append(part);
    });
    expect(part).toBe('region');
    expect(out.sent).toEqual([`${SYNC_OUTPUT_BEGIN}rowregion${SYNC_OUTPUT_END}`]);
  });

  it('restores the stream when a draw throws', () => {
    const out = stream();
    const frames = createFrameWriter(out);
    expect(() =>
      frames.frame(() => {
        out.write('partial');
        throw new Error('draw failed');
      }),
    ).toThrow('draw failed');
    out.write('direct');
    expect(out.sent).toEqual(['direct']);
  });
});
