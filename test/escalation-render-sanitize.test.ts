/**
 * Agent-derived escalation text must reach the host terminal only as inert,
 * visible characters, and the approval UIs must show the whole request.
 *
 * Covers the mux escalation picker (summary and detail view), the mux
 * command-mode panel, the mux footer flash and message panel, the standalone
 * listener dashboard and the builtin CLI banner. The mux surfaces render
 * through a real terminal-kit Terminal captured in memory, and the captured
 * bytes are replayed into a headless xterm to read the screen as the user
 * would see it.
 */

import { afterEach, describe, expect, it } from 'vitest';
import xtermHeadless from '@xterm/headless';

import { createMuxRenderer, type MuxRenderer, type MuxRendererDeps } from '../src/mux/mux-renderer.js';
import type { EscalationPickerState, MessagePanelState } from '../src/mux/mux-input-handler.js';
import { bulkApprovalKey, type BulkApproveState } from '../src/mux/escalation-picker-state.js';
import type { InputMode, MuxTab } from '../src/mux/types.js';
import type { PtyBridge } from '../src/pty/pty-bridge.js';
import type { EscalationWatcher } from '../src/escalation/escalation-watcher.js';
import type { PtySessionRegistration } from '../src/docker/pty-types.js';
import type { EscalationRequest } from '../src/session/types.js';
import {
  addEscalation,
  addSession,
  createInitialState,
  resolveEscalation,
  type ListenerState,
} from '../src/escalation/listener-state.js';
import { buildDashboard } from '../src/escalation/listener-command.js';
import { formatEscalationBanner, renderAgentMarkdown } from '../src/session/cli-transport.js';
import {
  captureTerminalKit,
  TERMINAL_CONTROL,
  withoutTerminalKitSequences,
  type CapturedTerminalKit,
} from './helpers/terminal-kit-capture.js';

const { Terminal } = xtermHeadless;

const ESC = '\u001b';
const BEL = '\u0007';

/** Every class of hostile payload, spread over the fields an agent controls. */
const HOSTILE_REQUEST: EscalationRequest = {
  escalationId: 'esc-1',
  serverName: `fs${ESC}[31m`,
  toolName: 'write_file%s',
  arguments: {
    path: `/tmp/x${ESC}[2J${ESC}[H`, // CSI clear screen + home
    content: `${ESC}]52;c;cm0gLXJmIH4K${BEL}`, // OSC 52 clipboard write
    mode: '\u009b31m\u009d0;t\u009c', // 8-bit CSI and OSC
    note: 'file\u202etxt.exe ^R100% %s %d', // bidi override, terminal-kit markup, format specifiers
    flags: ['a', 1, true], // non-string argument
    count: 42, // sixth argument
  },
  reason: `Write outside sandbox ${ESC}[1A\r hidden %s ^Y`,
  context: { 'Working directory': `/w${ESC}[2K` },
  whitelistCandidates: [{ description: `Allow fs/write_file within /tmp/${ESC}]0;title${BEL}` }],
};

/** What the hostile fields must look like once escaped (JSON quoting for argument values). */
const ESCAPED = {
  tool: 'fs\\u001b[31m/write_file%s',
  path: 'path: "/tmp/x\\u001b[2J\\u001b[H"',
  content: 'content: "\\u001b]52;c;cm0gLXJmIH4K\\u0007"',
  mode: 'mode: "\\u009b31m\\u009d0;t\\u009c"',
  note: 'note: "file\\u202etxt.exe ^R100% %s %d"',
  flags: 'flags: ["a",1,true]',
  count: 'count: 42',
  reason: 'Write outside sandbox \\u001b[1A\\r hidden %s ^Y',
  whitelist: 'Allow fs/write_file within /tmp/\\u001b]0;title\\u0007',
  context: 'Working directory: "/w\\u001b[2K"',
};

/**
 * Text with data hidden in code points that display as nothing: variation
 * selectors (one per byte, "emoji smuggling") and a Hangul filler.
 */
const HIDDEN_PAYLOAD = `Looks good${String.fromCodePoint(0xe0100, 0xe0101, 0xfe00)}\u3164`;
const ESCAPED_HIDDEN_PAYLOAD = 'Looks good\\u{e0100}\\u{e0101}\\ufe00\\u3164';

/** Raw hostile fragments that must never appear in anything written to a terminal. */
const RAW_FRAGMENTS = [`${ESC}]52`, `${ESC}]0;`, BEL, '\u009b', '\u009d', '\u009c', '\u202e', '\r'];

const REGISTRATION: PtySessionRegistration = {
  sessionId: 'abcdef1234567890',
  escalationDir: '/nonexistent/escalations',
  label: `claude-code: task ${ESC}[2J ^R %s`,
  startedAt: new Date().toISOString(),
  pid: 4242,
};

function listenerStateWith(...requests: EscalationRequest[]): ListenerState {
  const watcher = {
    start: () => undefined,
    stop: () => undefined,
    resolve: () => true,
  } as unknown as EscalationWatcher;
  let state = addSession(createInitialState(), REGISTRATION, watcher);
  for (const request of requests) state = addEscalation(state, REGISTRATION.sessionId, request);
  return state;
}

function expectNoHostileBytes(output: string): void {
  for (const fragment of RAW_FRAGMENTS) expect(output).not.toContain(fragment);
  // Only terminal-kit's own CSI sequences may remain; strip them and nothing a terminal acts on may be left.
  expect(withoutTerminalKitSequences(output)).not.toMatch(TERMINAL_CONTROL);
}

/** chalk's SGR styling is legitimate; everything else a terminal acts on must be gone. */
function withoutSgr(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/gu, '');
}

interface RenderedMux {
  readonly capture: CapturedTerminalKit;
  readonly renderer: MuxRenderer;
}

const renderers: MuxRenderer[] = [];

afterEach(() => {
  for (const renderer of renderers.splice(0)) renderer.destroy();
});

/** An open picker focused on escalation `n` (`esc-n`), armed long ago. */
function picker(n: number, detailView: { scrollOffset: number } | null = null): EscalationPickerState {
  return {
    focusedDisplayNumber: n,
    focusedEscalationId: `esc-${n}`,
    previousMode: 'pty',
    detailView,
    armedAt: 0,
    whitelistConfirm: false,
  };
}

/** A clock the test moves by hand (the renderer's `now`). */
function fakeClock(start = 100_000): { now: () => number; advance: (ms: number) => void } {
  let time = start;
  return {
    now: () => time,
    advance: (ms) => {
      time += ms;
    },
  };
}

async function renderMux(options: {
  cols: number;
  rows: number;
  mode: InputMode;
  state: ListenerState;
  picker?: EscalationPickerState | null;
  bulk?: BulkApproveState | null;
  panel?: MessagePanelState | null;
  now?: () => number;
}): Promise<RenderedMux> {
  const capture = await captureTerminalKit(options.cols, options.rows);
  const bridge = {
    terminal: new Terminal({ cols: options.cols, rows: options.rows - 3, allowProposedApi: true }),
    alive: true,
  } as unknown as PtyBridge;
  const tab: MuxTab = {
    number: 1,
    bridge,
    label: `claude-code ${ESC}[2J ^R %s`,
    escalationAvailable: true,
    scrollOffset: null,
  };
  const deps: MuxRendererDeps = {
    getActiveTab: () => tab,
    getTabs: () => [tab],
    getActiveTabIndex: () => 0,
    getMode: () => options.mode,
    getInputBuffer: () => '',
    getCursorPos: () => 0,
    getEscalationState: () => options.state,
    getPendingCount: () => options.state.pendingEscalations.size,
    getPickerState: () => null,
    getResumePickerState: () => null,
    getPersonaPickerState: () => null,
    getProviderPickerState: () => null,
    getEscalationPickerState: () => options.picker ?? null,
    getBulkApproveState: () => options.bulk ?? null,
    getMessagePanelState: () => options.panel ?? null,
    getScrollOffset: () => null,
    ...(options.now ? { now: options.now } : {}),
  };
  const renderer = createMuxRenderer(capture.term, options.cols, options.rows, deps);
  renderers.push(renderer);
  renderer.fullRedraw();
  return { capture, renderer };
}

describe('mux escalation picker', () => {
  it('shows every hostile field as literal escaped text and emits no control bytes from the request', async () => {
    const state = listenerStateWith(HOSTILE_REQUEST);
    const { capture } = await renderMux({
      cols: 100,
      rows: 30,
      mode: 'escalation-picker',
      state,
      picker: picker(1, null),
    });

    const output = await capture.output();
    expectNoHostileBytes(output);

    const screen = await capture.screen();
    expect(screen.scrolledRows).toBe(0);
    const text = screen.rows.join('\n');
    // Tab bar, tool header, all six arguments (string values JSON-quoted), reason and whitelist line.
    expect(screen.rows[0]).toContain('#1 claude-code \\u001b[2J ^R %s');
    expect(text).toContain(`Session #1  ${ESCAPED.tool}`);
    for (const fragment of Object.values(ESCAPED)) {
      if (fragment !== ESCAPED.context) expect(text).toContain(fragment);
    }
    expect(text).toContain(`Reason: ${ESCAPED.reason}`);
    expect(text).toContain(`/approve+ ${ESCAPED.whitelist}`);
    // Nothing was cut, so the title does not claim otherwise.
    expect(text).not.toContain('truncated');
  });

  it('shows a payload hidden in variation selectors and fillers as escapes', async () => {
    const state = listenerStateWith({ ...HOSTILE_REQUEST, arguments: { body: HIDDEN_PAYLOAD } });
    const { capture } = await renderMux({
      cols: 100,
      rows: 30,
      mode: 'escalation-picker',
      state,
      picker: picker(1, null),
    });

    expect(withoutTerminalKitSequences(await capture.output())).not.toMatch(/\p{Default_Ignorable_Code_Point}/u);
    const text = (await capture.screen()).rows.join('\n');
    expect(text).toContain(`body: "${ESCAPED_HIDDEN_PAYLOAD}"`);
  });

  it('keeps the reason and whitelist rows when arguments overflow and reports the hidden count', async () => {
    const manyArgs: Record<string, unknown> = {};
    for (let i = 0; i < 12; i++) manyArgs[`argument_${i}`] = `value number ${i} ${'x'.repeat(40)}`;
    const state = listenerStateWith({ ...HOSTILE_REQUEST, arguments: manyArgs });
    const { capture } = await renderMux({
      cols: 80,
      rows: 16,
      mode: 'escalation-picker',
      state,
      picker: picker(1, null),
    });

    const screen = await capture.screen();
    const text = screen.rows.join('\n');
    expect(text).toMatch(/Arguments: \(\+\d+ hidden, v to view\)/u);
    expect(text).toContain('Reason: Write outside sandbox');
    expect(text).toContain('/approve+ Allow fs/write_file');
    expectNoHostileBytes(await capture.output());
  });

  it('detail view shows the complete arguments as pretty-printed, escaped JSON', async () => {
    const state = listenerStateWith(HOSTILE_REQUEST);
    const { capture } = await renderMux({
      cols: 120,
      rows: 50,
      mode: 'escalation-picker',
      state,
      picker: picker(1, { scrollOffset: 0 }),
    });

    expectNoHostileBytes(await capture.output());
    const text = (await capture.screen()).rows.join('\n');
    expect(text).toContain('Escalation [1] details');
    expect(text).toContain('"path": "/tmp/x\\u001b[2J\\u001b[H"');
    expect(text).toContain('"content": "\\u001b]52;c;cm0gLXJmIH4K\\u0007"');
    expect(text).toContain('"mode": "\\u009b31m\\u009d0;t\\u009c"');
    expect(text).toContain('"note": "file\\u202etxt.exe ^R100% %s %d"');
    expect(text).toContain('"flags": [');
    expect(text).toContain('"count": 42');
    expect(text).toContain(`Reason: ${ESCAPED.reason}`);
    expect(text).toContain(`/approve+ ${ESCAPED.whitelist}`);
    expect(text).toContain(ESCAPED.context);
  });

  it('clamps the detail view scroll to the content and writes it back', async () => {
    const pickerState = picker(1, { scrollOffset: Number.MAX_SAFE_INTEGER });
    const { capture } = await renderMux({
      cols: 80,
      rows: 16,
      mode: 'escalation-picker',
      state: listenerStateWith(HOSTILE_REQUEST),
      picker: pickerState,
    });

    const offset = pickerState.detailView?.scrollOffset ?? -1;
    expect(offset).toBeGreaterThan(0);
    expect(offset).toBeLessThan(40);
    const text = (await capture.screen()).rows.join('\n');
    const position = /lines (\d+)-(\d+) of (\d+)/u.exec(text);
    expect(position?.[1]).toBe(String(offset + 1));
    expect(position?.[2]).toBe(position?.[3]); // the last page is shown
  });

  it('announces in the title when the summary had to cut the reason', async () => {
    const longReason = `Write outside sandbox: ${'/very/long/path'.repeat(12)}`;
    const { capture } = await renderMux({
      cols: 100,
      rows: 30,
      mode: 'escalation-picker',
      state: listenerStateWith({ ...HOSTILE_REQUEST, reason: longReason }),
      picker: picker(1, null),
    });
    const text = (await capture.screen()).rows.join('\n');
    expect(text).toContain('Escalation (truncated: v shows all)');
    expect(text).toContain('Reason: Write outside sandbox: /very/long/path');
  });

  it('shows a notice instead of a partial dialog when the terminal cannot hold the reserved rows', async () => {
    const { capture } = await renderMux({
      cols: 100,
      rows: 12,
      mode: 'escalation-picker',
      state: listenerStateWith(HOSTILE_REQUEST),
      picker: picker(1, null),
    });

    expectNoHostileBytes(await capture.output());
    const screen = await capture.screen();
    expect(screen.scrolledRows).toBe(0);
    const text = screen.rows.join('\n');
    expect(text).toContain('Escalation [1] pending: the terminal is too small to show it.');
    expect(text).not.toContain('Reason:');
    expect(text).not.toContain('/approve+');
  });

  it('reports which escalation is on screen in full, and since when, so approval can require it', async () => {
    const state = listenerStateWith(HOSTILE_REQUEST);
    const clock = fakeClock();
    const pickerState = picker(1, null);
    const summary = await renderMux({
      cols: 100,
      rows: 30,
      mode: 'escalation-picker',
      state,
      picker: pickerState,
      now: clock.now,
    });
    const firstShown = clock.now();
    expect(summary.renderer.displayedEscalation).toEqual({
      displayNumber: 1,
      escalationId: 'esc-1',
      view: 'summary',
      since: firstShown,
      canWhitelist: true,
      canWhitelistDirectory: false,
    });
    // Redraws of the same escalation, in either view, keep the time it was first shown.
    clock.advance(400);
    summary.renderer.redrawPty();
    pickerState.detailView = { scrollOffset: 0 };
    summary.renderer.redrawPty();
    expect(summary.renderer.displayedEscalation).toMatchObject({ view: 'detail', since: firstShown });
    pickerState.detailView = null;

    // Resized below what the dialog needs: the notice replaces it and nothing counts as shown.
    summary.renderer.resize(100, 12);
    summary.renderer.fullRedraw();
    expect(summary.renderer.displayedEscalation).toBeNull();
    // Shown again: the arming delay counts from now, not from the first time.
    clock.advance(5_000);
    summary.renderer.resize(100, 30);
    summary.renderer.redrawPty();
    expect(summary.renderer.displayedEscalation).toMatchObject({ displayNumber: 1, since: clock.now() });

    const detail = await renderMux({
      cols: 100,
      rows: 30,
      mode: 'escalation-picker',
      state,
      picker: picker(1, { scrollOffset: 0 }),
    });
    expect(detail.renderer.displayedEscalation?.displayNumber).toBe(1);
    expect(detail.renderer.displayedEscalation?.view).toBe('detail');

    // Too short for the summary, but the scrollable detail view the notice points to fits.
    const shortDetail = await renderMux({
      cols: 100,
      rows: 12,
      mode: 'escalation-picker',
      state,
      picker: picker(1, { scrollOffset: 0 }),
    });
    expect(shortDetail.renderer.displayedEscalation?.displayNumber).toBe(1);
    expect((await shortDetail.capture.screen()).rows.join('\n')).toContain('Escalation [1] details');

    // A focus that names another request than the one pending under its number draws nothing.
    const replaced = await renderMux({
      cols: 100,
      rows: 30,
      mode: 'escalation-picker',
      state,
      picker: { ...picker(1, null), focusedEscalationId: 'esc-other' },
    });
    expect(replaced.renderer.displayedEscalation).toBeNull();

    const tooNarrow = await renderMux({
      cols: 10,
      rows: 30,
      mode: 'escalation-picker',
      state,
      picker: picker(1, null),
    });
    expect(tooNarrow.renderer.displayedEscalation).toBeNull();

    const stale = await renderMux({
      cols: 100,
      rows: 30,
      mode: 'escalation-picker',
      state,
      picker: picker(7, null),
    });
    expect(stale.renderer.displayedEscalation).toBeNull();

    const closed = await renderMux({ cols: 100, rows: 30, mode: 'command', state });
    expect(closed.renderer.displayedEscalation).toBeNull();
  });
});

describe('mux escalation picker: arming, whitelist confirmation and approve all', () => {
  const SECOND: EscalationRequest = {
    escalationId: 'esc-2',
    serverName: 'proxy',
    toolName: 'add_proxy_domain',
    arguments: { domain: `exfil.example${ESC}[2K` },
    reason: 'Adding network domains requires human review',
    humanOnly: true,
  };

  it('the hint bar says to wait while disarmed and has no approve-all key once armed', async () => {
    const clock = fakeClock();
    const pickerState = { ...picker(1), armedAt: clock.now() + 1000 };
    const { capture, renderer } = await renderMux({
      cols: 100,
      rows: 30,
      mode: 'escalation-picker',
      state: listenerStateWith(HOSTILE_REQUEST, { ...HOSTILE_REQUEST, escalationId: 'esc-2' }),
      picker: pickerState,
      now: clock.now,
    });
    let text = (await capture.screen()).rows.join('\n');
    expect(text).toContain('wait  decision keys unlock in a moment');
    expect(text).not.toContain(' a  approve');

    clock.advance(1001);
    capture.reset();
    renderer.fullRedraw();
    text = (await capture.screen()).rows.join('\n');
    expect(text).not.toContain('wait');
    expect(text).toContain(' a  approve  d  deny  w  approve+  D  deny all  ←→  switch  Esc  dismiss');
    expect(text).not.toMatch(/ A {2}(all|approve)/u);
  });

  it('the whitelist confirmation shows the complete pattern, however long, and only then counts as shown', async () => {
    const clock = fakeClock();
    const longPattern = `Allow fs/write_file within /srv/${'deeply/nested/'.repeat(14)}${ESC}]0;t${BEL}end`;
    const request = { ...HOSTILE_REQUEST, whitelistCandidates: [{ description: longPattern }] };
    const confirm: EscalationPickerState = { ...picker(1), whitelistConfirm: 'exact' };
    const { capture, renderer } = await renderMux({
      cols: 100,
      rows: 30,
      mode: 'escalation-picker',
      state: listenerStateWith(request),
      picker: confirm,
      now: clock.now,
    });

    expectNoHostileBytes(await capture.output());
    const rows = (await capture.screen()).rows;
    const text = rows.join('\n');
    expect(text).toContain('Approve [1] and whitelist');
    expect(text).toContain('y approves this call and, for the rest of this session, every call that');
    // The wrapped rows, joined, give back the whole escaped pattern.
    // Pattern rows are the box rows indented by two cells (the intro and the header by none).
    const shownPattern = rows.map((row) => /^\s*│ {3}(\S.*?)\s*│\s*$/u.exec(row)?.[1] ?? '').join('');
    expect(shownPattern).toBe(
      'Allow fs/write_file within /srv/' + 'deeply/nested/'.repeat(14) + '\\u001b]0;t\\u0007end',
    );
    expect(renderer.displayedEscalation).toMatchObject({ displayNumber: 1, view: 'whitelist-confirm' });

    // Too short for the pattern: a notice, and nothing counts as shown.
    renderer.resize(100, 12);
    renderer.fullRedraw();
    expect(renderer.displayedEscalation).toBeNull();
    expect((await capture.screen()).rows.join('\n')).toContain('too small to show the whitelist pattern in full');
  });

  it('the approve-all screen lists every escalation with tool, arguments, reason and pattern, escaped', async () => {
    const clock = fakeClock();
    const state = listenerStateWith(HOSTILE_REQUEST, SECOND);
    const reviewed = [
      { displayNumber: 1, escalationId: 'esc-1' },
      { displayNumber: 2, escalationId: 'esc-2' },
    ];
    const bulk: BulkApproveState = { reviewed, whitelist: true, previousMode: 'command', scrollOffset: 0, armedAt: 0 };
    const { capture, renderer } = await renderMux({
      cols: 100,
      rows: 40,
      mode: 'escalation-approve-all',
      state,
      bulk,
      now: clock.now,
    });

    expectNoHostileBytes(await capture.output());
    const text = (await capture.screen()).rows.join('\n');
    expect(text).toContain('Approve and whitelist 1 escalation?');
    expect(text).toContain(`[1] Session #1  ${ESCAPED.tool}`);
    expect(text).toContain(ESCAPED.path);
    expect(text).toContain(`Reason: ${ESCAPED.reason}`);
    expect(text).toContain(`/approve+ ${ESCAPED.whitelist}`);
    expect(text).toContain('[2] Session #1  proxy/add_proxy_domain');
    expect(text).toContain('domain: "exfil.example\\u001b[2K"');
    expect(text).toContain('human-only: stays pending; approve it on its own with /approve 2');
    // Everything fit: the whole list has been seen since this draw; y unlocks after the delay.
    expect(renderer.displayedBulkApproval).toEqual({
      setKey: bulkApprovalKey(reviewed, true),
      seenAllSince: clock.now(),
    });
    expect(text).toContain('wait  y unlocks in a moment');
    clock.advance(1001);
    capture.reset();
    renderer.fullRedraw();
    expect((await capture.screen()).rows.join('\n')).toContain(' y  approve and whitelist 1');
  });

  it('the approve-all list counts as seen only once every line has been on screen', async () => {
    const clock = fakeClock();
    const requests = Array.from({ length: 8 }, (_, i) => ({ ...HOSTILE_REQUEST, escalationId: `esc-${i + 1}` }));
    const reviewed = requests.map((r, i) => ({ displayNumber: i + 1, escalationId: r.escalationId }));
    const bulk: BulkApproveState = { reviewed, whitelist: false, previousMode: 'command', scrollOffset: 0, armedAt: 0 };
    const { capture, renderer } = await renderMux({
      cols: 100,
      rows: 20,
      mode: 'escalation-approve-all',
      state: listenerStateWith(...requests),
      bulk,
      now: clock.now,
    });
    expect(renderer.displayedBulkApproval?.seenAllSince).toBeNull();
    expect((await capture.screen()).rows.join('\n')).toContain('scroll to review every line first');

    // Jumping to the end skips the middle: still not seen.
    bulk.scrollOffset = Number.MAX_SAFE_INTEGER;
    renderer.redrawPty();
    const lastPage = bulk.scrollOffset;
    expect(lastPage).toBeGreaterThan(0);
    expect(renderer.displayedBulkApproval?.seenAllSince).toBeNull();

    // Scrolling through every page completes it, at the draw that showed the last unseen line.
    const jumpedAt = clock.now();
    const drawnAt: number[] = [];
    for (let offset = 0; offset <= lastPage; offset += 5) {
      clock.advance(10);
      bulk.scrollOffset = offset;
      renderer.redrawPty();
      drawnAt.push(clock.now());
    }
    const seenAllSince = renderer.displayedBulkApproval?.seenAllSince ?? null;
    expect(seenAllSince).not.toBeNull();
    expect(drawnAt).toContain(seenAllSince);
    expect(seenAllSince).toBeGreaterThan(jumpedAt);

    // A narrower box rewraps the list: it must be seen again.
    renderer.resize(70, 20);
    renderer.fullRedraw();
    expect(renderer.displayedBulkApproval?.seenAllSince).toBeNull();
  });
});

/** HOSTILE_REQUEST offering the exact pattern and, second, a hostile directory-wide one. */
const TWO_PATTERNS: EscalationRequest = {
  ...HOSTILE_REQUEST,
  whitelistCandidates: [
    { description: 'Allow fs/write_file write-path /srv/data/report.md', scope: 'exact' },
    { description: `Allow fs/w write-path within /srv${ESC}]0;t${BEL} (recursive)`, scope: 'directory' },
  ],
};
const ESCAPED_DIRECTORY_PATTERN = 'Allow fs/w write-path within /srv\\u001b]0;t\\u0007 (recursive)';

describe('mux escalation picker: exact and directory-wide patterns', () => {
  it('shows both patterns behind their commands and offers W only when there is a directory-wide one', async () => {
    const clock = fakeClock();
    const { capture, renderer } = await renderMux({
      cols: 110,
      rows: 34,
      mode: 'escalation-picker',
      state: listenerStateWith(TWO_PATTERNS),
      picker: picker(1),
      now: clock.now,
    });
    expectNoHostileBytes(await capture.output());
    clock.advance(1001);
    capture.reset();
    renderer.fullRedraw();
    const text = (await capture.screen()).rows.join('\n');
    expect(text).toContain('/approve+ Allow fs/write_file write-path /srv/data/report.md');
    expect(text).toContain(`/approve+dir ${ESCAPED_DIRECTORY_PATTERN}`);
    expect(text).toContain(' a  approve  d  deny  w  approve+  W  approve+dir');
    expect(renderer.displayedEscalation).toMatchObject({ canWhitelist: true, canWhitelistDirectory: true });

    const exactOnly = await renderMux({
      cols: 110,
      rows: 34,
      mode: 'escalation-picker',
      state: listenerStateWith(HOSTILE_REQUEST),
      picker: picker(1),
    });
    const exactText = (await exactOnly.capture.screen()).rows.join('\n');
    expect(exactText).not.toContain('approve+dir');
    expect(exactOnly.renderer.displayedEscalation).toMatchObject({ canWhitelist: true, canWhitelistDirectory: false });
  });

  it('the W confirmation shows the directory-wide pattern in full and says it is recursive', async () => {
    const clock = fakeClock();
    const confirm: EscalationPickerState = { ...picker(1), whitelistConfirm: 'directory' };
    const { capture, renderer } = await renderMux({
      cols: 100,
      rows: 30,
      mode: 'escalation-picker',
      state: listenerStateWith(TWO_PATTERNS),
      picker: confirm,
      now: clock.now,
    });
    expectNoHostileBytes(await capture.output());
    const text = (await capture.screen()).rows.join('\n');
    expect(text).toContain('Approve [1] and whitelist the directory');
    expect(text).toContain('It is recursive');
    expect(text).toContain(ESCAPED_DIRECTORY_PATTERN);
    expect(text).not.toContain('/srv/data/report.md');
    expect(renderer.displayedEscalation).toMatchObject({ displayNumber: 1, view: 'whitelist-directory-confirm' });
    clock.advance(1001);
    capture.reset();
    renderer.fullRedraw();
    expect((await capture.screen()).rows.join('\n')).toContain(' y  approve and whitelist the directory');
  });

  it('the w confirmation shows the exact pattern, not the directory-wide one', async () => {
    const confirm: EscalationPickerState = { ...picker(1), whitelistConfirm: 'exact' };
    const { capture, renderer } = await renderMux({
      cols: 100,
      rows: 30,
      mode: 'escalation-picker',
      state: listenerStateWith(TWO_PATTERNS),
      picker: confirm,
    });
    const text = (await capture.screen()).rows.join('\n');
    expect(text).toContain('Allow fs/write_file write-path /srv/data/report.md');
    expect(text).not.toContain('(recursive)');
    expect(renderer.displayedEscalation).toMatchObject({ view: 'whitelist-confirm' });
  });

  it('a W confirmation for an escalation without a directory-wide pattern draws a notice, never a box', async () => {
    const confirm: EscalationPickerState = { ...picker(1), whitelistConfirm: 'directory' };
    const { capture, renderer } = await renderMux({
      cols: 100,
      rows: 30,
      mode: 'escalation-picker',
      state: listenerStateWith(HOSTILE_REQUEST),
      picker: confirm,
    });
    expect((await capture.screen()).rows.join('\n')).toContain('offers no directory-wide whitelist pattern');
    expect(renderer.displayedEscalation).toBeNull();
  });

  it('the command-mode panel and the detail view list both patterns', async () => {
    const panel = await renderMux({ cols: 120, rows: 30, mode: 'command', state: listenerStateWith(TWO_PATTERNS) });
    const panelText = (await panel.capture.screen()).rows.join('\n');
    expect(panelText).toContain('/approve+ Allow fs/write_file write-path /srv/data/report.md');
    expect(panelText).toContain(`/approve+dir ${ESCAPED_DIRECTORY_PATTERN}`);

    const detail = await renderMux({
      cols: 120,
      rows: 50,
      mode: 'escalation-picker',
      state: listenerStateWith(TWO_PATTERNS),
      picker: picker(1, { scrollOffset: 0 }),
    });
    const detailText = (await detail.capture.screen()).rows.join('\n');
    expect(detailText).toContain('/approve+ Allow fs/write_file write-path /srv/data/report.md');
    expect(detailText).toContain(`/approve+dir ${ESCAPED_DIRECTORY_PATTERN}`);
  });
});

describe('mux footer banner for pending escalations', () => {
  it('announces a pending escalation in PTY mode, escaped, without opening anything', async () => {
    const { capture, renderer } = await renderMux({
      cols: 120,
      rows: 24,
      mode: 'pty',
      state: listenerStateWith(HOSTILE_REQUEST),
    });
    expectNoHostileBytes(await capture.output());
    const screen = await capture.screen();
    expect(screen.rows[23]).toContain(
      `! Escalation [1] ${ESCAPED.tool} is waiting for your decision · Ctrl-E to review`,
    );
    expect(screen.rows.join('\n')).not.toContain('Reason:');
    expect(renderer.displayedEscalation).toBeNull();
  });

  it('names the newest of several, and says how to get there from another picker', async () => {
    const state = listenerStateWith(HOSTILE_REQUEST, { ...HOSTILE_REQUEST, escalationId: 'esc-2' });
    const panel: MessagePanelState = { title: 'Sessions', lines: ['one'], scrollOffset: 0, previousMode: 'pty' };
    const { capture } = await renderMux({ cols: 120, rows: 24, mode: 'message-panel', state, panel });
    const bottom = (await capture.screen()).rows[23];
    expect(bottom).toContain(`! 2 escalations pending, newest [2] ${ESCAPED.tool}`);
    expect(bottom).toContain('Esc out, then Ctrl-E to review');
  });

  it('command mode lists them in its panel and no longer suggests /approve all', async () => {
    const state = listenerStateWith(HOSTILE_REQUEST, { ...HOSTILE_REQUEST, escalationId: 'esc-2' });
    const { capture } = await renderMux({ cols: 120, rows: 24, mode: 'command', state });
    const text = (await capture.screen()).rows.join('\n');
    expect(text).toContain('/deny all  Ctrl-E review');
    expect(text).not.toContain('/approve all');
    expect(text).not.toContain('waiting for your decision');
  });
});

describe('mux command-mode escalation panel', () => {
  it('escapes every field and reports hidden arguments instead of dropping the reason or whitelist line', async () => {
    const manyArgs: Record<string, unknown> = {};
    for (let i = 0; i < 8; i++) manyArgs[`argument_${i}`] = `value-${i}-${'y'.repeat(20)}`;
    const state = listenerStateWith({ ...HOSTILE_REQUEST, arguments: manyArgs });
    const { capture } = await renderMux({ cols: 80, rows: 24, mode: 'command', state });

    expectNoHostileBytes(await capture.output());
    const screen = await capture.screen();
    expect(screen.scrolledRows).toBe(0);
    const text = screen.rows.join('\n');
    expect(text).toContain(`[1] Session #1  ${ESCAPED.tool}`);
    expect(text).toContain('(+8 hidden, Ctrl-E, v to view)');
    expect(text).toContain(`Reason: ${ESCAPED.reason}`);
    expect(text).toContain(`/approve+ ${ESCAPED.whitelist}`);
  });

  it('shows all arguments, including the fourth and a non-string one, when they fit', async () => {
    const state = listenerStateWith({
      ...HOSTILE_REQUEST,
      arguments: { a: 'one', b: 'two', c: 'three', d: 'four', e: [1, 2] },
      whitelistCandidates: undefined,
    });
    const { capture } = await renderMux({ cols: 100, rows: 24, mode: 'command', state });
    const text = (await capture.screen()).rows.join('\n');
    expect(text).toContain('a: "one"  b: "two"  c: "three"  d: "four"  e: [1,2]');
  });
});

describe('mux footer flash and message panel', () => {
  it('collapses a multi-line flash to one sanitized row and never scrolls the screen', async () => {
    const state = listenerStateWith();
    const { capture, renderer } = await renderMux({ cols: 80, rows: 24, mode: 'pty', state });
    renderer.showMessage(`Spawned session ${ESC}[2J ^R %s\nsecond line\nthird line`);

    const output = await capture.output();
    expect(output).not.toContain('\n');
    expectNoHostileBytes(output);

    const screen = await capture.screen();
    expect(screen.scrolledRows).toBe(0);
    expect(screen.rows[0]).toContain('#1 claude-code');
    expect(screen.rows[23]).toContain('Spawned session \\u001b[2J ^R %s (+2 more)');
  });

  it('cuts an over-long flash before the last column so the bottom row cannot wrap', async () => {
    const state = listenerStateWith();
    const { capture, renderer } = await renderMux({ cols: 40, rows: 12, mode: 'pty', state });
    renderer.showMessage('m'.repeat(200));

    const screen = await capture.screen();
    expect(screen.scrolledRows).toBe(0);
    expect(screen.rows[0]).toContain('#1 claude-code');
    expect(screen.rows[11]).toMatch(/^ {2}m+…$/u);
    expect(screen.rows[11].length).toBeLessThanOrEqual(37);
  });

  it('renders the message panel lines sanitized, with title and hint bar', async () => {
    const state = listenerStateWith();
    const panel: MessagePanelState = {
      title: 'Sessions',
      lines: [`[1] abcdef12 label ^R %s`, `[2] 12345678 ${ESC}[2J${BEL}other`],
      scrollOffset: 0,
      previousMode: 'command',
    };
    const { capture } = await renderMux({ cols: 80, rows: 24, mode: 'message-panel', state, panel });

    expectNoHostileBytes(await capture.output());
    const text = (await capture.screen()).rows.join('\n');
    expect(text).toContain('Sessions');
    expect(text).toContain('[1] abcdef12 label ^R %s');
    expect(text).toContain('[2] 12345678 \\u001b[2J\\u0007other');
    expect(text).toContain('Esc');
  });

  it('clamps the message panel scroll to what fits and writes it back', async () => {
    const panel: MessagePanelState = {
      title: 'Sessions',
      lines: ['one', 'two', 'three'],
      scrollOffset: 2,
      previousMode: 'command',
    };
    const { capture } = await renderMux({
      cols: 80,
      rows: 24,
      mode: 'message-panel',
      state: listenerStateWith(),
      panel,
    });
    expect(panel.scrollOffset).toBe(0); // all three lines fit: nothing to scroll
    expect((await capture.screen()).rows.join('\n')).toContain('one');
  });
});

describe('escalation listener dashboard', () => {
  it('shows every argument (JSON for non-strings) with no control bytes from the request', () => {
    let state = listenerStateWith(HOSTILE_REQUEST, { ...HOSTILE_REQUEST, escalationId: 'esc-2' });
    state = resolveEscalation(state, 2, 'approved');

    const dashboard = buildDashboard(state);
    const plain = withoutSgr(dashboard);
    expect(plain).not.toMatch(TERMINAL_CONTROL);
    for (const fragment of RAW_FRAGMENTS) expect(plain).not.toContain(fragment);

    expect(plain).toContain(`Tool:    ${ESCAPED.tool}`);
    expect(plain).toContain(`Args:    ${ESCAPED.path}`);
    expect(plain).toContain(ESCAPED.content);
    expect(plain).toContain(ESCAPED.mode);
    expect(plain).toContain(ESCAPED.note); // fourth argument
    expect(plain).toContain(ESCAPED.flags); // non-string argument
    expect(plain).toContain(ESCAPED.count);
    expect(plain).toContain(`Reason:  ${ESCAPED.reason}`);
    expect(plain).toContain(ESCAPED.context);
    expect(plain).toContain(`/approve+ 1: ${ESCAPED.whitelist}`);
    // Session label and history entries are sanitized too.
    expect(plain).toContain('claude-code: task \\u001b[2J ^R %s');
    expect(plain).toContain(`${ESCAPED.tool}  APPROVED`);
  });

  it('shows a payload hidden in variation selectors and fillers as escapes', () => {
    const state = listenerStateWith({ ...HOSTILE_REQUEST, arguments: { body: HIDDEN_PAYLOAD } });
    const plain = withoutSgr(buildDashboard(state));
    expect(plain).toContain(`body: "${ESCAPED_HIDDEN_PAYLOAD}"`);
    expect(plain).not.toMatch(/\p{Default_Ignorable_Code_Point}/u);
  });

  it('marks a cut argument value explicitly instead of hiding its tail silently', () => {
    const state = listenerStateWith({ ...HOSTILE_REQUEST, arguments: { content: 'z'.repeat(1000) } });
    const plain = withoutSgr(buildDashboard(state));
    expect(plain).toMatch(/content: "z+\.\.\.\[\+\d+ chars\]/u);
  });

  it('survives a request file whose arguments are not an object', () => {
    const malformed = { ...HOSTILE_REQUEST, arguments: null } as unknown as EscalationRequest;
    const plain = withoutSgr(buildDashboard(listenerStateWith(malformed)));
    expect(plain).toContain(`Tool:    ${ESCAPED.tool}`);
    expect(plain).not.toContain('Args:');
    expect(plain).toContain(`Reason:  ${ESCAPED.reason}`);
  });
});

describe('builtin CLI transport', () => {
  it('escalation banner escapes arguments, context, reason, tool and whitelist text', () => {
    const banner = formatEscalationBanner(HOSTILE_REQUEST);
    const plain = withoutSgr(banner);
    expect(plain).not.toMatch(TERMINAL_CONTROL);
    for (const fragment of RAW_FRAGMENTS) expect(plain).not.toContain(fragment);

    expect(plain).toContain(`Tool:      ${ESCAPED.tool}`);
    expect(plain).toContain('"path": "/tmp/x\\u001b[2J\\u001b[H"');
    expect(plain).toContain('"mode": "\\u009b31m\\u009d0;t\\u009c"'); // JSON leaves C1 raw; the banner must not
    expect(plain).toContain('"count": 42');
    expect(plain).toContain(`  ${ESCAPED.context}`);
    expect(plain).toContain(`Reason:    ${ESCAPED.reason}`);
    expect(plain).toContain(`    ${ESCAPED.whitelist}`);
  });

  it('escalation banner shows a payload hidden in variation selectors and fillers as escapes', () => {
    const plain = withoutSgr(formatEscalationBanner({ ...HOSTILE_REQUEST, arguments: { body: HIDDEN_PAYLOAD } }));
    expect(plain).toContain(`"body": "${ESCAPED_HIDDEN_PAYLOAD}"`);
    expect(plain).not.toMatch(/\p{Default_Ignorable_Code_Point}/u);
  });

  it('escalation banner shows each whitelist pattern behind the command that adds it', () => {
    const plain = withoutSgr(formatEscalationBanner(TWO_PATTERNS));
    expect(plain).not.toMatch(TERMINAL_CONTROL);
    expect(plain).toContain('Whitelist patterns:');
    expect(plain).toContain('    /approve+     Allow fs/write_file write-path /srv/data/report.md');
    expect(plain).toContain(`    /approve+dir  ${ESCAPED_DIRECTORY_PATTERN}`);
    expect(plain).toContain('Type /approve, /approve+ or /approve+dir (approve & whitelist), or /deny');

    const single = withoutSgr(formatEscalationBanner(HOSTILE_REQUEST));
    expect(single).toContain('Whitelist pattern:');
    expect(single).toContain(`    /approve+     ${ESCAPED.whitelist}`);
    expect(single).not.toContain('/approve+dir');
  });

  it('strips terminal sequences from agent markdown before rendering it', () => {
    const rendered = renderAgentMarkdown(`# Done\n\nSaved ${ESC}]52;c;cm0gLXJmIH4K${BEL}the file${ESC}[2J${ESC}[H.\n`);
    expect(rendered).not.toContain(']52;c');
    expect(rendered).not.toContain(BEL);
    expect(withoutSgr(rendered)).not.toMatch(TERMINAL_CONTROL);
    expect(rendered).toContain('Saved the file');
    expect(renderAgentMarkdown(`${ESC}[2J`)).toBe('');
  });

  it('shows bidi overrides and isolates in agent markdown as escapes, in prose and in code', () => {
    const rendered = renderAgentMarkdown(
      'Open invoice\u202Etxt.exe now.\n\nRun `rm -rf \u2066~/safe\u2069`\n\n```\ncat \u202Dlog\u202C\n```\n',
    );
    for (const control of ['\u202E', '\u2066', '\u2069', '\u202D', '\u202C']) expect(rendered).not.toContain(control);
    expect(rendered).toContain('invoice\\u202etxt.exe');
    expect(rendered).toContain('\\u2066~/safe\\u2069');
    expect(rendered).toContain('\\u202dlog\\u202c');
  });
});
