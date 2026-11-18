/**
 * `ironcurtain observe` writes untrusted token-stream text to the host
 * terminal (TUI-6): model output, and tool results the MITM copies from the
 * agent's own requests. ESC sequences (CSI, OSC 52 clipboard writes, window
 * titles), C1 controls and other control characters in any event field must
 * never reach stdout raw, in the plain renderer, the TUI text panel, the
 * status bar or the rain; the views show the text inertly instead.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  renderConnectionLost,
  renderEvent,
  renderSessionEnded,
  type RenderOptions,
} from '../src/observe/observe-renderer.js';
import { createTextPanel, type TextPanelOptions } from '../src/observe/observe-tui-text-panel.js';
import { createRainEngine } from '../src/observe/observe-tui-rain.js';
import { createObserveTui } from '../src/observe/observe-tui.js';
import { calculateTuiLayout } from '../src/observe/observe-tui-types.js';
import { observedField, observedLine, observedProse, isDrawableRainChar } from '../src/observe/observe-text.js';
import type { TokenStreamEvent } from '../src/docker/token-stream-types.js';

const ESC = '\u001b';
const BEL = '\u0007';

/** Every class of hostile payload: CSI, OSC 52 and title, 8-bit C1 CSI/OSC, BEL, CR, BS, bidi. */
const HOSTILE = [
  `${ESC}[2J${ESC}[6n`,
  `${ESC}]52;c;SGVsbG8=${BEL}`,
  `${ESC}]0;pwned${ESC}\\`,
  '\u009b31m\u009d0;t\u009c',
  '\r\b',
  'file‮txt',
].join('|');

/** Raw fragments that must never be written. */
const RAW_FRAGMENTS = [
  `${ESC}[2J`,
  `${ESC}[6n`,
  `${ESC}]52`,
  `${ESC}]0;`,
  BEL,
  '\u009b',
  '\u009d',
  '\u009c',
  '\r',
  '\b',
];

/** The views' own sequences: cursor positioning, erase line, SGR, cursor and screen modes. */
// eslint-disable-next-line no-control-regex
const OWN_SEQUENCES = /\u001b\[(?:\d+;\d+H|K|[0-9;]*m|\?(?:25|1049)[hl]|2J)/gu;

/** Control characters a terminal acts on (line feed aside). */
// eslint-disable-next-line no-control-regex
const TERMINAL_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u;

/** Fails when anything but the views' own sequences could act on the terminal. */
function expectInert(output: string): void {
  for (const fragment of RAW_FRAGMENTS) expect(output).not.toContain(fragment);
  expect(output.replace(OWN_SEQUENCES, '')).not.toMatch(TERMINAL_CONTROL);
  // The bidi override is shown, never applied.
  expect(output).not.toContain('‮');
}

const ts = 1_700_000_000_000;

/** One event of every kind, each field carrying the hostile payload. */
function hostileEvents(): TokenStreamEvent[] {
  return [
    { kind: 'message_start', model: `model${HOSTILE}`, timestamp: ts },
    { kind: 'text_delta', text: `Hello ${HOSTILE}\nsecond line ${HOSTILE}\npartial ${HOSTILE}`, timestamp: ts },
    { kind: 'tool_use', toolName: `tool${HOSTILE}`, inputDelta: '', timestamp: ts },
    {
      kind: 'tool_use',
      toolName: '',
      inputDelta: JSON.stringify({ path: HOSTILE, [`k${HOSTILE}`]: 1 }),
      timestamp: ts,
    },
    {
      kind: 'tool_result',
      toolUseId: 'tu-1',
      toolName: 'bash',
      content: `result ${HOSTILE}`,
      isError: false,
      timestamp: ts,
    },
    { kind: 'error', message: `boom ${HOSTILE}`, timestamp: ts },
    { kind: 'raw', eventType: `ping${HOSTILE}`, data: `data ${HOSTILE}`, timestamp: ts },
    { kind: 'message_end', stopReason: `end${HOSTILE}`, inputTokens: 1, outputTokens: 2, timestamp: ts },
  ] as TokenStreamEvent[];
}

describe('observe text helpers', () => {
  it('prose keeps its line breaks and text but loses every sequence and control', () => {
    expect(observedProse(`a${ESC}[31mred${ESC}[0m\r\nb${BEL}\tc`)).toBe('ared\nb\tc');
    expect(observedProse('x‮y')).toBe('x\\u202ey');
  });

  it('a split sequence leaves only inert text behind', () => {
    // A delta that ends in the middle of an OSC 52 write, and the rest.
    const parts = [`text${ESC}`, `]52;c;SGVsbG8=${BEL}more`].map(observedProse);
    expect(parts.join('')).toBe('text]52;c;SGVsbG8=more');
    expect(parts.join('')).not.toMatch(TERMINAL_CONTROL);
  });

  it('a panel line has no tab or line feed; a field shows controls as escapes', () => {
    expect(observedLine('a\tb\nc')).toBe('a b c');
    expect(observedField(`x${ESC}[2J\u009b`)).toBe('x\\u001b[2J\\u009b');
    expect(observedField(42)).toBe('42');
  });

  it('the rain draws printable characters only', () => {
    expect(isDrawableRainChar('a')).toBe(true);
    expect(isDrawableRainChar('界')).toBe(true);
    for (const c of [ESC, BEL, '\r', '\n', '\u009b', '‮', '​', '']) expect(isDrawableRainChar(c)).toBe(false);
  });
});

describe('plain observe renderer', () => {
  const modes: Record<string, RenderOptions> = {
    text: { raw: false, json: false, showLabel: true },
    raw: { raw: true, json: false, showLabel: true },
  };

  for (const [name, options] of Object.entries(modes)) {
    it(`writes no hostile byte from any event field (${name} mode)`, () => {
      const output = hostileEvents()
        .map((event) => renderEvent(3, event, options) ?? '')
        .join('');
      expectInert(output);
      if (options.raw) {
        // Fields are shown with their controls as visible escapes.
        expect(output).toContain('[tool: tool\\u001b[2J\\u001b[6n|');
        expect(output).toContain('[error] boom \\u001b[2J');
      }
      // Prose keeps its text: complete sequences are removed, the bidi
      // override is shown as an escape.
      expect(output).toContain('Hello |||||file\\u202etxt');
    });
  }

  it('--json escapes C1 and every other terminal control, and still parses to the same event', () => {
    for (const event of hostileEvents()) {
      const output = renderEvent(3, event, { raw: true, json: true, showLabel: false }) ?? '';
      expect(output).not.toMatch(TERMINAL_CONTROL);
      expect(output).not.toContain('‮');
      expect(JSON.parse(output)).toEqual({ label: 3, ...event });
    }
  });

  it('session-ended and connection-lost reasons are shown escaped', () => {
    expectInert(renderSessionEnded(3, `done ${HOSTILE}`));
    expectInert(renderConnectionLost(`closed ${HOSTILE}`));
    expect(renderConnectionLost(`x${ESC}]52;c;AA${BEL}`)).toContain('x\\u001b]52;c;AA\\u0007');
  });
});

describe('observe TUI text panel', () => {
  const options: TextPanelOptions = { raw: true, showLabel: true, debug: true };

  it('renders finalized and partial lines, tool names, inputs, results and errors without hostile bytes', () => {
    const panel = createTextPanel(30, 90, 40);
    for (const event of hostileEvents()) panel.appendEvent(2, event, options);
    // The tool accumulator flushes on the next non-tool event (already
    // sent); flush the last one explicitly as well.
    panel.flushToolAccumulator(2, true);

    const output = panel.render();
    expectInert(output);
    expect(output).toContain('Hello |||||file\\u202etxt');
    expect(output).toContain('partial |||||file\\u202etxt');
    expect(output).toContain('tool\\u001b[2J');
    expect(output).toContain('boom \\u001b[2J');
  });

  it('a thinking delta and an execute_code input are sanitized too', () => {
    const panel = createTextPanel(0, 90, 40);
    panel.appendEvent(
      1,
      {
        kind: 'raw',
        eventType: 'content_block_delta',
        data: JSON.stringify({ delta: { type: 'thinking_delta', thinking: `think ${HOSTILE}\nmore` } }),
        timestamp: ts,
      },
      options,
    );
    panel.appendEvent(1, { kind: 'tool_use', toolName: 'execute_code', inputDelta: '', timestamp: ts }, options);
    panel.appendEvent(
      1,
      {
        kind: 'tool_use',
        toolName: '',
        inputDelta: JSON.stringify({ code: `const x = 1; // ${HOSTILE}\nrun()` }),
        timestamp: ts,
      },
      options,
    );
    panel.flushToolAccumulator(1, false);

    const output = panel.render();
    expectInert(output);
    expect(output).toContain('think |||||file\\u202etxt');
    expect(output).toContain('const x = 1; //');
  });

  it('session-ended and connection-lost reasons are sanitized', () => {
    const panel = createTextPanel(0, 90, 10);
    panel.sessionEnded(1, `gone ${HOSTILE}`, true);
    panel.connectionLost(`closed ${HOSTILE}`);
    expectInert(panel.render());
  });
});

describe('observe TUI rain', () => {
  it('never queues or draws an undrawable character', () => {
    const rng = (() => {
      let seed = 1;
      return { random: () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646 };
    })();
    const engine = createRainEngine({ layout: calculateTuiLayout(120, 40), rng });
    engine.enqueueTokens(Array.from(HOSTILE).map((char) => ({ char, kind: 'text' as const })));
    engine.enqueueWord(`word${ESC}c${HOSTILE}`, 'text');
    engine.enqueueWord(`${ESC}${BEL}`, 'text');

    let output = '';
    for (let frame = 0; frame < 400; frame++) {
      engine.tick();
      output += engine.render();
    }
    expectInert(output);
  });
});

describe('observe TUI', () => {
  let written: string[];
  let writeImpl: typeof process.stdout.write;

  beforeEach(() => {
    vi.useFakeTimers();
    written = [];
    writeImpl = process.stdout.write;
    process.stdout.write = (chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    };
    Object.defineProperty(process.stdout, 'columns', { value: 120, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true });
  });

  afterEach(() => {
    process.stdout.write = writeImpl;
    vi.useRealTimers();
  });

  it('writes no hostile byte to stdout: text panel, status bar (model, tool name) and rain', () => {
    const tui = createObserveTui({ raw: true, showLabel: true, debug: true });
    tui.start();
    try {
      tui.pushEvents(5, hostileEvents());
      // A tool in progress shows its name in the status bar.
      tui.pushEvents(5, [{ kind: 'tool_use', toolName: `bar${HOSTILE}`, inputDelta: '', timestamp: ts }]);
      vi.advanceTimersByTime(2_000);
      tui.connectionLost(`lost ${HOSTILE}`);
      vi.advanceTimersByTime(500);
    } finally {
      tui.destroy();
    }
    const output = written.join('');
    expect(output.length).toBeGreaterThan(0);
    expectInert(output);
    expect(output).toContain('bar\\u001b[2J');
  });
});
