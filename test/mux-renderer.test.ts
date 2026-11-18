import { describe, it, expect } from 'vitest';
import type { Terminal as TerminalType } from '@xterm/headless';
import xtermHeadless from '@xterm/headless';
const { Terminal } = xtermHeadless;
import {
  readTerminalBuffer,
  buildSgrSequence,
  cellStyleEquals,
  colorEquals,
  computeVisualLines,
  cursorToVisualPosition,
  truncate,
  fitTabLabels,
  formatArgLines,
  formatArgValue,
  planArgumentRows,
  planEscalationDetailRows,
  planEscalationPanelRows,
  formatEscalationDetailLines,
  formatBulkApprovalLines,
  wordWrap,
  collapseFlashMessage,
  type ArgLine,
  type TranslatedCell,
  type TermkitColor,
} from '../src/mux/mux-renderer.js';
import type { PendingEscalation } from '../src/escalation/listener-state.js';
import { TERMINAL_CONTROL } from './helpers/terminal-kit-capture.js';
import type { EscalationRequest } from '../src/session/types.js';

/** Helper: write data to terminal and wait for it to be processed. */
function writeSync(terminal: TerminalType, data: string): Promise<void> {
  return new Promise((resolve) => {
    terminal.write(data, resolve);
  });
}

describe('readTerminalBuffer', () => {
  it('translates basic text correctly', async () => {
    const terminal = new Terminal({ cols: 10, rows: 5, allowProposedApi: true });
    await writeSync(terminal, 'Hello');

    const cells = readTerminalBuffer(terminal, 0, 1, 10);
    expect(cells).toHaveLength(1);

    const row = cells[0];
    expect(row.length).toBeGreaterThanOrEqual(5);
    expect(row[0].char).toBe('H');
    expect(row[1].char).toBe('e');
    expect(row[2].char).toBe('l');
    expect(row[3].char).toBe('l');
    expect(row[4].char).toBe('o');
  });

  it('empty cells are spaces', () => {
    const terminal = new Terminal({ cols: 10, rows: 5, allowProposedApi: true });
    // Don't write anything -- buffer should be all spaces

    const cells = readTerminalBuffer(terminal, 0, 1, 10);
    expect(cells).toHaveLength(1);

    for (const cell of cells[0]) {
      expect(cell.char).toBe(' ');
    }
  });

  it('handles multiple rows', async () => {
    const terminal = new Terminal({ cols: 10, rows: 5, allowProposedApi: true });
    await writeSync(terminal, 'Line1\r\nLine2');

    const cells = readTerminalBuffer(terminal, 0, 2, 10);
    expect(cells).toHaveLength(2);

    expect(cells[0][0].char).toBe('L');
    expect(cells[0][4].char).toBe('1');
    expect(cells[1][0].char).toBe('L');
    expect(cells[1][4].char).toBe('2');
  });

  it('reads correct number of rows and columns', () => {
    const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });

    const cells = readTerminalBuffer(terminal, 0, 5, 40);
    expect(cells).toHaveLength(5);
    for (const row of cells) {
      expect(row.length).toBeLessThanOrEqual(40);
    }
  });

  it('translates default colors', async () => {
    const terminal = new Terminal({ cols: 10, rows: 5, allowProposedApi: true });
    await writeSync(terminal, 'A');

    const cells = readTerminalBuffer(terminal, 0, 1, 10);
    const cell = cells[0][0];

    // Default colors should be 'default' or 0
    expect(cell.fg === 'default' || cell.fg === 0).toBe(true);
    expect(cell.bg === 'default' || cell.bg === 0).toBe(true);
  });

  it('translates bold attribute', async () => {
    const terminal = new Terminal({ cols: 20, rows: 5, allowProposedApi: true });
    // ESC[1m enables bold, ESC[0m resets
    await writeSync(terminal, '\x1b[1mBold\x1b[0m');

    const cells = readTerminalBuffer(terminal, 0, 1, 20);
    expect(cells[0][0].bold).toBe(true);
    expect(cells[0][0].char).toBe('B');
  });

  it('translates 256-color palette', async () => {
    const terminal = new Terminal({ cols: 20, rows: 5, allowProposedApi: true });
    // ESC[38;5;196m sets fg to color 196 (red)
    await writeSync(terminal, '\x1b[38;5;196mRed\x1b[0m');

    const cells = readTerminalBuffer(terminal, 0, 1, 20);
    expect(cells[0][0].char).toBe('R');
    expect(cells[0][0].fg).toBe(196);
  });

  it('translates 24-bit RGB colors', async () => {
    const terminal = new Terminal({ cols: 20, rows: 5, allowProposedApi: true });
    // ESC[38;2;255;128;0m sets fg to RGB(255, 128, 0)
    await writeSync(terminal, '\x1b[38;2;255;128;0mOrange\x1b[0m');

    const cells = readTerminalBuffer(terminal, 0, 1, 20);
    const fg = cells[0][0].fg;
    expect(typeof fg).toBe('object');
    if (typeof fg === 'object') {
      expect(fg.r).toBe(255);
      expect(fg.g).toBe(128);
      expect(fg.b).toBe(0);
    }
  });

  it('translates multiple attributes', async () => {
    const terminal = new Terminal({ cols: 20, rows: 5, allowProposedApi: true });
    // Bold + italic + underline
    await writeSync(terminal, '\x1b[1;3;4mStyled\x1b[0m');

    const cells = readTerminalBuffer(terminal, 0, 1, 20);
    const cell = cells[0][0];
    expect(cell.bold).toBe(true);
    expect(cell.italic).toBe(true);
    expect(cell.underline).toBe(true);
  });

  it('returns empty row for out-of-bounds line', () => {
    const terminal = new Terminal({ cols: 10, rows: 5, allowProposedApi: true });

    // Request rows beyond what has content
    const cells = readTerminalBuffer(terminal, 100, 1, 10);
    expect(cells).toHaveLength(1);
    expect(cells[0]).toHaveLength(0);
  });

  it('reads from baseY to show current viewport after scrollback', async () => {
    const terminal = new Terminal({ cols: 80, rows: 5, allowProposedApi: true });

    // Write 10 lines to force scrollback (only 5 fit in the viewport)
    for (let i = 0; i < 10; i++) {
      await writeSync(terminal, `Line ${i}\r\n`);
    }

    const baseY = terminal.buffer.active.baseY;
    expect(baseY).toBeGreaterThan(0);

    // Reading from baseY should show the current viewport (latest lines)
    const viewportCells = readTerminalBuffer(terminal, baseY, 5, 80);
    expect(viewportCells[0][0].char).toBe('L');
    // First viewport line should be Line 6 (lines 0-5 scrolled off)
    const firstLine = viewportCells[0]
      .map((c) => c.char)
      .join('')
      .trim();
    expect(firstLine).toContain('Line 6');

    // Reading from 0 would show stale scrollback (Line 0), not the viewport
    const staleContent = readTerminalBuffer(terminal, 0, 5, 80);
    const staleLine = staleContent[0]
      .map((c) => c.char)
      .join('')
      .trim();
    expect(staleLine).toContain('Line 0');
  });
});

// Helper to create a TranslatedCell with defaults
function makeCell(overrides: Partial<TranslatedCell> = {}): TranslatedCell {
  return {
    char: ' ',
    width: 1,
    fg: 'default',
    bg: 'default',
    bold: false,
    italic: false,
    underline: false,
    dim: false,
    inverse: false,
    strikethrough: false,
    ...overrides,
  };
}

describe('colorEquals', () => {
  it('matches identical default colors', () => {
    expect(colorEquals('default', 'default')).toBe(true);
  });

  it('matches identical palette numbers', () => {
    expect(colorEquals(196, 196)).toBe(true);
  });

  it('rejects different palette numbers', () => {
    expect(colorEquals(196, 42)).toBe(false);
  });

  it('matches identical RGB objects', () => {
    expect(colorEquals({ r: 255, g: 128, b: 0 }, { r: 255, g: 128, b: 0 })).toBe(true);
  });

  it('rejects different RGB objects', () => {
    expect(colorEquals({ r: 255, g: 128, b: 0 }, { r: 0, g: 128, b: 255 })).toBe(false);
  });

  it('rejects mixed types', () => {
    expect(colorEquals('default', 196)).toBe(false);
    expect(colorEquals(196, { r: 0, g: 0, b: 0 })).toBe(false);
    expect(colorEquals('default', { r: 0, g: 0, b: 0 })).toBe(false);
  });
});

describe('cellStyleEquals', () => {
  it('matches identical default cells', () => {
    expect(cellStyleEquals(makeCell(), makeCell())).toBe(true);
  });

  it('ignores char and width differences', () => {
    expect(cellStyleEquals(makeCell({ char: 'A', width: 1 }), makeCell({ char: 'Z', width: 2 }))).toBe(true);
  });

  it('detects bold difference', () => {
    expect(cellStyleEquals(makeCell({ bold: true }), makeCell({ bold: false }))).toBe(false);
  });

  it('detects fg color difference', () => {
    expect(cellStyleEquals(makeCell({ fg: 196 }), makeCell({ fg: 42 }))).toBe(false);
  });

  it('detects bg color difference', () => {
    expect(cellStyleEquals(makeCell({ bg: { r: 0, g: 0, b: 0 } }), makeCell({ bg: 'default' }))).toBe(false);
  });

  it('matches cells with identical non-default attributes', () => {
    const style = { bold: true, italic: true, fg: 196 as TermkitColor, bg: { r: 10, g: 20, b: 30 } as TermkitColor };
    expect(cellStyleEquals(makeCell(style), makeCell(style))).toBe(true);
  });
});

describe('buildSgrSequence', () => {
  it('produces reset + default colors for plain cell', () => {
    const sgr = buildSgrSequence(makeCell());
    expect(sgr).toBe('0;39;49');
  });

  it('includes bold code', () => {
    const sgr = buildSgrSequence(makeCell({ bold: true }));
    expect(sgr).toContain(';1;');
  });

  it('includes 256-color fg', () => {
    const sgr = buildSgrSequence(makeCell({ fg: 196 }));
    expect(sgr).toContain('38;5;196');
  });

  it('includes RGB bg', () => {
    const sgr = buildSgrSequence(makeCell({ bg: { r: 10, g: 20, b: 30 } }));
    expect(sgr).toContain('48;2;10;20;30');
  });

  it('includes multiple attributes', () => {
    const sgr = buildSgrSequence(makeCell({ bold: true, italic: true, underline: true }));
    // Should start with 0 (reset) then have 1, 3, 4
    expect(sgr).toMatch(/^0;1;3;4;/);
  });
});

describe('computeVisualLines', () => {
  it('empty string produces one empty visual line', () => {
    const lines = computeVisualLines('', 20);
    expect(lines).toEqual([{ text: '', bufferOffset: 0 }]);
  });

  it('short string fits in one visual line', () => {
    const lines = computeVisualLines('hello', 20);
    expect(lines).toEqual([{ text: 'hello', bufferOffset: 0 }]);
  });

  it('wraps at contentWidth', () => {
    const lines = computeVisualLines('abcdefghij', 5);
    expect(lines).toEqual([
      { text: 'abcde', bufferOffset: 0 },
      { text: 'fghij', bufferOffset: 5 },
    ]);
  });

  it('handles hard newlines', () => {
    const lines = computeVisualLines('abc\ndef', 20);
    expect(lines).toEqual([
      { text: 'abc', bufferOffset: 0 },
      { text: 'def', bufferOffset: 4 },
    ]);
  });

  it('handles mixed hard newlines and wrapping', () => {
    const lines = computeVisualLines('abcde\nfghij', 3);
    expect(lines).toEqual([
      { text: 'abc', bufferOffset: 0 },
      { text: 'de', bufferOffset: 3 },
      { text: 'fgh', bufferOffset: 6 },
      { text: 'ij', bufferOffset: 9 },
    ]);
  });

  it('trailing newline produces an empty visual line', () => {
    const lines = computeVisualLines('abc\n', 20);
    expect(lines).toEqual([
      { text: 'abc', bufferOffset: 0 },
      { text: '', bufferOffset: 4 },
    ]);
  });

  it('multiple consecutive newlines produce empty visual lines', () => {
    const lines = computeVisualLines('a\n\nb', 20);
    expect(lines).toEqual([
      { text: 'a', bufferOffset: 0 },
      { text: '', bufferOffset: 2 },
      { text: 'b', bufferOffset: 3 },
    ]);
  });
});

describe('cursorToVisualPosition', () => {
  it('cursor at start', () => {
    const lines = computeVisualLines('hello', 20);
    expect(cursorToVisualPosition(lines, 0)).toEqual({ row: 0, col: 0 });
  });

  it('cursor at end of single line', () => {
    const lines = computeVisualLines('hello', 20);
    expect(cursorToVisualPosition(lines, 5)).toEqual({ row: 0, col: 5 });
  });

  it('cursor at wrap point belongs to next line', () => {
    const lines = computeVisualLines('abcdefghij', 5);
    // Position 5 is start of second visual line
    expect(cursorToVisualPosition(lines, 5)).toEqual({ row: 1, col: 0 });
  });

  it('cursor after hard newline', () => {
    const lines = computeVisualLines('abc\ndef', 20);
    // Position 4 is 'd' on second line
    expect(cursorToVisualPosition(lines, 4)).toEqual({ row: 1, col: 0 });
  });

  it('cursor at end of buffer with trailing newline', () => {
    const lines = computeVisualLines('abc\n', 20);
    // Position 4 is on the empty line after \n
    expect(cursorToVisualPosition(lines, 4)).toEqual({ row: 1, col: 0 });
  });

  it('cursor in middle of wrapped second line', () => {
    const lines = computeVisualLines('abcdefghij', 5);
    // Position 7 is 'h', col 2 of second visual line
    expect(cursorToVisualPosition(lines, 7)).toEqual({ row: 1, col: 2 });
  });
});

describe('truncate', () => {
  it('returns string unchanged when within limit', () => {
    expect(truncate('hello', 10)).toBe('hello');
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('truncates with ellipsis when over limit', () => {
    expect(truncate('hello world', 5)).toBe('hell\u2026');
    expect(truncate('abcdef', 3)).toBe('ab\u2026');
  });
});

describe('fitTabLabels', () => {
  const makeTabs = (...names: string[]) =>
    names.map((name, i) => ({ displayNumber: i + 1, label: `[${i + 1}] ${name}` }));

  it('fits all tabs when width is sufficient', () => {
    const tabs = makeTabs('server/tool');
    const result = fitTabLabels(tabs, 1, 50);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ label: '[1] server/tool', isFocused: true });
  });

  it('fits multiple tabs', () => {
    const tabs = makeTabs('a/b', 'c/d');
    // [1] a/b = 7 chars + 2 spaces = 9; [2] c/d = 7 + 2 = 9; total = 18
    const result = fitTabLabels(tabs, 2, 20);
    expect(result).toHaveLength(2);
    expect(result[0].isFocused).toBe(false);
    expect(result[1].isFocused).toBe(true);
  });

  it('truncates focused tab when it overflows', () => {
    const tabs = makeTabs('longservername/longtoolname');
    // Label: "[1] longservername/longtoolname" = 30 chars, needs 32 with spaces
    const result = fitTabLabels(tabs, 1, 15);
    expect(result).toHaveLength(1);
    expect(result[0].isFocused).toBe(true);
    // 15 width - 2 spaces = 13 chars for label, truncated with ellipsis
    expect(result[0].label.length).toBe(13);
    expect(result[0].label).toMatch(/\u2026$/);
  });

  it('does not render focused tab when remaining space is less than 3', () => {
    const tabs = makeTabs('a/b', 'longservername/longtoolname');
    // First tab "[1] a/b" = 7 + 2 = 9 written
    // Remaining = 10 - 9 = 1, which is < 3
    const result = fitTabLabels(tabs, 2, 10);
    expect(result).toHaveLength(1);
    expect(result[0].isFocused).toBe(false);
  });

  it('renders focused tab with exactly 3 remaining columns', () => {
    const tabs = makeTabs('a/b', 'longservername/longtoolname');
    // First tab "[1] a/b" = 7 + 2 = 9 written
    // Remaining = 12 - 9 = 3, which is exactly 3 → fits 1 char
    const result = fitTabLabels(tabs, 2, 12);
    expect(result).toHaveLength(2);
    expect(result[1].isFocused).toBe(true);
    expect(result[1].label.length).toBe(1);
  });

  it('never exceeds width', () => {
    const tabs = makeTabs('server/tool', 'another/tool', 'third/tool');
    for (const width of [3, 5, 10, 15, 20, 30, 50]) {
      const result = fitTabLabels(tabs, 2, width);
      const totalWritten = result.reduce((sum, t) => sum + t.label.length + 2, 0);
      expect(totalWritten).toBeLessThanOrEqual(width);
    }
  });

  it('skips non-focused tabs that do not fit', () => {
    const tabs = makeTabs('longservername/longtoolname');
    // Not focused, so don't truncate — just skip
    const result = fitTabLabels(tabs, 999, 10);
    expect(result).toHaveLength(0);
  });

  it('measures wide labels in display cells', () => {
    const tabs = [{ displayNumber: 1, label: '[1] 日本/x' }]; // 4 + 4 + 2 = 10 cells
    expect(fitTabLabels(tabs, 1, 12)).toEqual([{ label: '[1] 日本/x', isFocused: true }]);
    const cut = fitTabLabels(tabs, 1, 11);
    expect(cut[0].label).toBe('[1] 日本\u2026');
  });
});

describe('truncate counts display cells', () => {
  it('treats wide characters as two cells', () => {
    expect(truncate('日本語テキスト', 7)).toBe('日本語\u2026');
    expect(truncate('ab日', 4)).toBe('ab日');
    expect(truncate('ab日', 3)).toBe('ab\u2026');
  });
});

// --- Escalation text formatting and row planning ---

const ESC = '\u001b';

function pendingEscalation(overrides: Partial<EscalationRequest> & { displayNumber?: number } = {}): PendingEscalation {
  const { displayNumber = 1, ...request } = overrides;
  return {
    sessionId: 's1',
    sessionDisplayNumber: 1,
    displayNumber,
    receivedAt: new Date(),
    request: {
      escalationId: `e${displayNumber}`,
      serverName: 'fs',
      toolName: 'write_file',
      arguments: {},
      reason: 'reason',
      ...request,
    },
  };
}

describe('formatArgValue', () => {
  it('renders values as JSON with hidden characters visible', () => {
    expect(formatArgValue('plain')).toBe('"plain"');
    expect(formatArgValue(`a${ESC}[2Jb`)).toBe('"a\\u001b[2Jb"');
    expect(formatArgValue('\u009b\u202e')).toBe('"\\u009b\\u202e"');
    expect(formatArgValue(42)).toBe('42');
    expect(formatArgValue(null)).toBe('null');
    expect(formatArgValue({ a: [1, 'x'] })).toBe('{"a":[1,"x"]}');
    expect(formatArgValue(undefined)).toBe('undefined');
  });

  it('keeps at most maxLength units of the JSON and marks the cut', () => {
    expect(formatArgValue('abcdef', 8)).toBe('"abcdef"');
    expect(formatArgValue('abcdefghij', 8)).toBe('"abcdefg\u2026');
    expect(formatArgValue({ list: [1, 2, 3, 4] }, 8)).toBe('{"list":\u2026');
    // A string is serialized from its head: escapes in the head stay visible, the tail is never read.
    expect(formatArgValue(`${ESC}${'x'.repeat(100)}`, 10)).toBe('"\\u001bxxx\u2026');
    // The cut never splits a surrogate pair into lone halves.
    expect(formatArgValue('ab😀cd', 3)).toBe('"ab\u2026');
  });
});

describe('formatArgLines', () => {
  it('packs pairs by display cells, quotes strings and counts arguments per line', () => {
    const lines = formatArgLines({ a: 'x', b: 'y', long: 'z'.repeat(30) }, 20);
    expect(lines).toEqual([
      { text: 'a: "x"  b: "y"', args: 2, cut: false },
      { text: 'long: "zzzzzzzzzzzz\u2026', args: 1, cut: true },
    ]);
  });

  it('quotes keys that are not plain identifiers and escapes control characters in keys', () => {
    const lines = formatArgLines({ 'path: "/safe"  evil': 'x', [`k${ESC}`]: 1 }, 200);
    expect(lines).toEqual([{ text: '"path: \\"/safe\\"  evil": "x"  "k\\u001b": 1', args: 2, cut: false }]);
  });

  it('measures wide characters in cells', () => {
    const lines = formatArgLines({ a: '日本語', b: 'x' }, 14);
    expect(lines).toEqual([
      { text: 'a: "日本語"', args: 1, cut: false },
      { text: 'b: "x"', args: 1, cut: false },
    ]);
  });

  it('returns no lines for empty or non-object arguments', () => {
    expect(formatArgLines({}, 20)).toEqual([]);
    expect(formatArgLines(null as unknown as Record<string, unknown>, 20)).toEqual([]);
  });

  it('marks a value cut even when what is kept renders narrower than the row', () => {
    // 200 combining marks take no cells: without the explicit mark the cut would be invisible.
    const lines = formatArgLines({ a: `x${'\u0301'.repeat(200)}tail` }, 20);
    expect(lines).toHaveLength(1);
    expect(lines[0].cut).toBe(true);
    expect(lines[0].text.endsWith('…')).toBe(true);
    expect(lines[0].text).not.toContain('tail');
  });

  it('summarizes a multi-megabyte argument as cheaply as a short one', () => {
    const huge = { path: '/tmp/out.txt', content: `${'line of file content\n'.repeat(250_000)}\u202e` };
    const started = performance.now();
    for (let i = 0; i < 50; i++) formatArgLines(huge, 76);
    const elapsed = performance.now() - started;
    const lines = formatArgLines(huge, 76);
    expect(lines.map((line) => line.text)).toEqual([
      'path: "/tmp/out.txt"',
      `content: "${'line of file content\\n'.repeat(4).slice(0, 65)}…`,
    ]);
    expect(lines[1].cut).toBe(true);
    // Serializing and escaping the whole 5 MB value 50 times takes many seconds.
    expect(elapsed).toBeLessThan(2000);
  });
});

describe('planArgumentRows', () => {
  const lines: ArgLine[] = [
    { text: 'a: 1  b: 2', args: 2, cut: false },
    { text: 'c: 3', args: 1, cut: false },
    { text: 'd: 4  e: 5  f: 6', args: 3, cut: false },
  ];

  it('returns the label and every line when they fit', () => {
    expect(planArgumentRows(lines, 4, 'v', true)).toEqual([
      { kind: 'args-label', text: 'Arguments:' },
      { kind: 'arg', text: 'a: 1  b: 2' },
      { kind: 'arg', text: 'c: 3' },
      { kind: 'arg', text: 'd: 4  e: 5  f: 6' },
    ]);
    expect(planArgumentRows(lines, 3, 'v', false).map((r) => r.kind)).toEqual(['arg', 'arg', 'arg']);
  });

  it('puts the hidden count on the label row and shows as many lines as fit', () => {
    expect(planArgumentRows(lines, 2, 'v', true)).toEqual([
      { kind: 'args-label', text: 'Arguments: (+4 hidden, v to view)' },
      { kind: 'arg', text: 'a: 1  b: 2' },
    ]);
    expect(planArgumentRows(lines, 1, 'v', true)).toEqual([
      { kind: 'args-label', text: 'Arguments: (+6 hidden, v to view)' },
    ]);
  });

  it('adds a trailing hidden row when there is no label', () => {
    expect(planArgumentRows(lines, 2, 'Ctrl-E, v', false)).toEqual([
      { kind: 'arg', text: 'a: 1  b: 2' },
      { kind: 'hidden', text: '(+4 hidden, Ctrl-E, v to view)' },
    ]);
    expect(planArgumentRows(lines, 1, 'Ctrl-E, v', false)).toEqual([
      { kind: 'hidden', text: '(+6 hidden, Ctrl-E, v to view)' },
    ]);
  });

  it('returns nothing for no arguments or no budget', () => {
    expect(planArgumentRows([], 5, 'v', true)).toEqual([]);
    expect(planArgumentRows(lines, 0, 'v', true)).toEqual([]);
  });

  it('says on the label when a shown line had a value cut', () => {
    const cutLines: ArgLine[] = [lines[0], { text: 'content: "abc…', args: 1, cut: true }];
    expect(planArgumentRows(cutLines, 3, 'v', true)[0]).toEqual({
      kind: 'args-label',
      text: 'Arguments: (values cut, v to view)',
    });
  });
});

describe('planEscalationDetailRows', () => {
  const esc = pendingEscalation({
    arguments: { a: 'x'.repeat(50), b: 'y'.repeat(50), c: 'z'.repeat(50) },
    reason: `why ${ESC}[1A`,
    whitelistCandidates: [{ description: 'Allow t ^R' }],
  });

  it('reserves the reason and whitelist rows before any argument row', () => {
    const rows = planEscalationDetailRows(esc, 3, 40);
    expect(rows).toEqual([
      { kind: 'args-label', text: 'Arguments: (+3 hidden, v to view)' },
      { kind: 'reason', text: 'why \\u001b[1A' },
      { kind: 'whitelist', text: 'Allow t ^R' },
    ]);
  });

  it('shows everything when the budget allows', () => {
    const rows = planEscalationDetailRows(esc, 10, 80);
    expect(rows.map((r) => r.kind)).toEqual(['args-label', 'arg', 'arg', 'arg', 'reason', 'whitelist']);
    expect(rows[1].kind === 'arg' && rows[1].text.startsWith('a: "xxxx')).toBe(true);
  });

  it('returns the reserved rows even past the budget, never a silently partial dialog', () => {
    // The caller sees more rows than it asked for and shows a "too small" notice instead.
    for (const budget of [0, 1, 2]) {
      expect(planEscalationDetailRows(esc, budget, 40)).toEqual([
        { kind: 'args-label', text: 'Arguments: (+3 hidden, v to view)' },
        { kind: 'reason', text: 'why \\u001b[1A' },
        { kind: 'whitelist', text: 'Allow t ^R' },
      ]);
    }
    const bare = pendingEscalation({ arguments: {}, whitelistCandidates: undefined });
    expect(planEscalationDetailRows(bare, 0, 40)).toEqual([{ kind: 'reason', text: 'reason' }]);
  });

  it('labels the arguments when a value was cut to the width even though every line is shown', () => {
    const rows = planEscalationDetailRows(esc, 10, 40);
    expect(rows.map((r) => r.kind)).toEqual(['args-label', 'arg', 'arg', 'arg', 'reason', 'whitelist']);
    expect(rows[0]).toEqual({ kind: 'args-label', text: 'Arguments: (values cut, v to view)' });
  });

  it('reserves the directory-wide pattern line after the exact one when there is one', () => {
    const both = pendingEscalation({
      arguments: { a: 'x'.repeat(50), b: 'y'.repeat(50), c: 'z'.repeat(50) },
      reason: 'why',
      whitelistCandidates: [
        { description: 'Allow t /a/f', scope: 'exact' },
        { description: 'Allow t within /a (recursive)', scope: 'directory' },
      ],
    });
    expect(planEscalationDetailRows(both, 0, 40)).toEqual([
      { kind: 'args-label', text: 'Arguments: (+3 hidden, v to view)' },
      { kind: 'reason', text: 'why' },
      { kind: 'whitelist', text: 'Allow t /a/f' },
      { kind: 'whitelist-directory', text: 'Allow t within /a (recursive)' },
    ]);
    // A candidate not marked directory-wide is never shown as the /approve+dir line.
    const unmarked = pendingEscalation({
      whitelistCandidates: [{ description: 'Allow t /a/f' }, { description: 'Allow t elsewhere' }],
    });
    expect(planEscalationDetailRows(unmarked, 10, 40).map((r) => r.kind)).not.toContain('whitelist-directory');
  });
});

describe('planEscalationPanelRows', () => {
  const first = pendingEscalation({
    displayNumber: 1,
    arguments: { a: '1', b: '2', c: '3' },
    whitelistCandidates: [{ description: 'Allow a' }],
  });
  const second = pendingEscalation({ displayNumber: 2, arguments: { p: 'q' }, whitelistCandidates: undefined });

  it('gives an escalation its header, one argument row, reason and whitelist line within four rows', () => {
    expect(planEscalationPanelRows([first], 4, 40).map((r) => r.kind)).toEqual([
      'header',
      'arg',
      'reason',
      'whitelist',
    ]);
    // Too narrow for every pair on one line: the single argument row becomes the notice.
    const narrow = planEscalationPanelRows([first], 4, 20);
    expect(narrow.map((r) => r.kind)).toEqual(['header', 'hidden', 'reason', 'whitelist']);
    expect(narrow[1]).toEqual({ kind: 'hidden', text: '(+3 hidden, Ctrl-E, v to view)' });
    expect(narrow[0]).toEqual({ kind: 'header', displayNumber: 1, sessionDisplayNumber: 1, tool: 'fs/write_file' });
  });

  it('never shows a partial escalation and appends a more row that does not displace content', () => {
    const rows = planEscalationPanelRows([first, second], 6, 40);
    expect(rows.map((r) => r.kind)).toEqual(['header', 'arg', 'reason', 'whitelist', 'more']);
    // Hidden escalations are reviewed one at a time: approving them in bulk, unseen, is not suggested.
    expect(rows[4]).toEqual({ kind: 'more', text: '[+1 more \u2014 Ctrl-E to review them, or /deny all]' });
  });

  it('shows every escalation when the rows suffice', () => {
    const rows = planEscalationPanelRows([first, second], 7, 40);
    expect(rows.map((r) => r.kind)).toEqual(['header', 'arg', 'reason', 'whitelist', 'header', 'arg', 'reason']);
  });

  it('returns nothing for no escalations or no rows', () => {
    expect(planEscalationPanelRows([], 8, 40)).toEqual([]);
    expect(planEscalationPanelRows([first], 0, 40)).toEqual([]);
  });

  it('reserves a fifth row for an escalation that also offers a directory-wide pattern', () => {
    const both = pendingEscalation({
      displayNumber: 3,
      arguments: { a: '1' },
      whitelistCandidates: [
        { description: 'Allow a /p/f', scope: 'exact' },
        { description: 'Allow a within /p (recursive)', scope: 'directory' },
      ],
    });
    expect(planEscalationPanelRows([both], 5, 40).map((r) => r.kind)).toEqual([
      'header',
      'arg',
      'reason',
      'whitelist',
      'whitelist-directory',
    ]);
    // Four rows cannot hold it: it is not shown partially.
    expect(planEscalationPanelRows([both], 4, 40).map((r) => r.kind)).toEqual(['more']);
  });
});

describe('formatEscalationDetailLines', () => {
  it('includes session, tool, full reason, whitelist, context and every argument as JSON, wrapped', () => {
    const esc = pendingEscalation({
      serverName: 'fs',
      toolName: 'write',
      arguments: { path: '/p', n: 1, list: ['a'] },
      reason: 'r'.repeat(30),
      context: { 'Working directory': `/w${ESC}` },
      whitelistCandidates: [{ description: 'Allow fs/write within /p' }],
    });
    const lines = formatEscalationDetailLines(esc, 20);
    expect(lines.join('\n')).not.toContain('/approve+dir');
    expect(lines[0]).toBe('Session #1  fs/write');
    expect(lines.slice(1, 3)).toEqual(['Reason: rrrrrrrrrrrr', 'rrrrrrrrrrrrrrrrrr']);
    expect(lines.join('\n')).toContain('/approve+ Allow fs/w');
    expect(lines.join('')).toContain('Working directory: "/w\\u001b"');
    expect(lines).toContain('Arguments:');
    expect(lines).toContain('    "path": "/p",');
    expect(lines).toContain('    "n": 1,');
    expect(lines).toContain('      "a"');
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(20);
  });

  it('says when there are no arguments', () => {
    expect(formatEscalationDetailLines(pendingEscalation({ arguments: {} }), 40)).toContain('Arguments: (none)');
  });
});

describe('collapseFlashMessage', () => {
  it('keeps the first line, sanitized, and counts the rest', () => {
    expect(collapseFlashMessage('one')).toBe('one');
    expect(collapseFlashMessage(`one ${ESC}[2J\ntwo\nthree`)).toBe('one \\u001b[2J (+2 more)');
    expect(collapseFlashMessage('one\r\ntwo\n')).toBe('one (+1 more)');
  });
});

describe('wordWrap', () => {
  it('breaks between words and hard-wraps a word longer than the row', () => {
    expect(wordWrap('y approves this call and every call', 12)).toEqual([
      'y approves',
      'this call',
      'and every',
      'call',
    ]);
    expect(wordWrap('a abcdefghij b', 4)).toEqual(['a', 'abcd', 'efgh', 'ij b']);
    expect(wordWrap('', 5)).toEqual(['']);
  });
});

describe('formatBulkApprovalLines', () => {
  const plain = pendingEscalation({
    displayNumber: 1,
    arguments: { path: `/etc/${ESC}[2Japp.conf`, mode: 420 },
    whitelistCandidates: [{ description: `Allow write_file within /etc${ESC}]0;x` }],
  });
  const humanOnly = pendingEscalation({
    displayNumber: 2,
    serverName: 'proxy',
    toolName: 'add_proxy_domain',
    arguments: { domain: 'api.example.com' },
    humanOnly: true,
  });
  const pending = new Map([
    [1, plain],
    [2, humanOnly],
  ]);
  const reviewed = [
    { displayNumber: 2, escalationId: 'e2' },
    { displayNumber: 1, escalationId: 'e1' },
  ];

  it('lists every escalation in order with tool, escaped arguments and reason', () => {
    const lines = formatBulkApprovalLines(reviewed, pending, 80, false);
    expect(lines).toEqual([
      { kind: 'header', text: '[1] Session #1  fs/write_file' },
      { kind: 'detail', text: '    path: "/etc/\\u001b[2Japp.conf"  mode: 420' },
      { kind: 'detail', text: '    Reason: reason' },
      { kind: 'header', text: '[2] Session #1  proxy/add_proxy_domain' },
      { kind: 'detail', text: '    domain: "api.example.com"' },
      { kind: 'detail', text: '    Reason: reason' },
      { kind: 'note', text: '    human-only: stays pending; approve it on its own with /approve 2' },
    ]);
  });

  it('with /approve+ all, shows the complete pattern each escalation would whitelist', () => {
    const lines = formatBulkApprovalLines(reviewed, pending, 30, true);
    const pattern = lines.filter((line) => line.kind === 'pattern').map((line) => line.text.slice(4)); // drop only the indent
    expect(pattern.join('')).toBe('/approve+ Allow write_file within /etc\\u001b]0;x');
    expect(lines.every((line) => !TERMINAL_CONTROL.test(line.text))).toBe(true);
  });

  it('says when a value was cut and where to see it whole, and when an escalation is gone', () => {
    const long = pendingEscalation({ displayNumber: 3, arguments: { content: 'x'.repeat(500) } });
    const lines = formatBulkApprovalLines(
      [
        { displayNumber: 3, escalationId: 'e3' },
        { displayNumber: 4, escalationId: 'e4' },
      ],
      new Map([[3, long]]),
      40,
      false,
    );
    expect(lines.some((line) => line.kind === 'note' && line.text.includes('values cut'))).toBe(true);
    expect(lines.at(-1)).toEqual({ kind: 'note', text: '[4] no longer pending' });
  });
});
