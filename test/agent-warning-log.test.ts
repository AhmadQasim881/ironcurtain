/**
 * The Code Mode proxy logs what agent connections trigger through this
 * bounded log; an agent controls both the rate and much of the text, and
 * every line is a synchronous append to the host's session log.
 */

import { describe, it, expect } from 'vitest';
import {
  AGENT_WARNING_BUDGET,
  AGENT_WARNING_DETAIL_CHARS,
  boundedDisplayDetail,
  createAgentWarningLog,
} from '../src/docker/agent-warning-log.js';

// eslint-disable-next-line no-control-regex
const RAW_CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

function harness(budget = 3, windowMs = 1_000) {
  const lines: string[] = [];
  let time = 0;
  const log = createAgentWarningLog({ write: (line) => lines.push(line), now: () => time, budget, windowMs });
  return {
    lines,
    log,
    advance(ms: number): void {
      time += ms;
    },
  };
}

describe('createAgentWarningLog', () => {
  it('writes at most the budget per window and counts the rest into one summary', () => {
    const { lines, log, advance } = harness(3, 1_000);
    for (let i = 0; i < 10; i++) log.warn('agent connection error', `bad frame ${i}`);
    expect(lines).toEqual([
      'agent connection error: bad frame 0',
      'agent connection error: bad frame 1',
      'agent connection error: bad frame 2',
    ]);

    // The next window reports what was suppressed, then writes again.
    advance(1_000);
    log.warn('agent connection error', 'bad frame 10');
    expect(lines.slice(3)).toEqual([
      '7 further agent connection warning(s) suppressed (limit 3 per 1s)',
      'agent connection error: bad frame 10',
    ]);
  });

  it('does not reset the budget before the window has elapsed', () => {
    const { lines, log, advance } = harness(2, 1_000);
    log.warn('e', '1');
    log.warn('e', '2');
    advance(999);
    log.warn('e', '3');
    expect(lines).toEqual(['e: 1', 'e: 2']);
  });

  it('flush() reports suppressed warnings once and is silent when there are none', () => {
    const { lines, log } = harness(1, 1_000);
    log.flush();
    expect(lines).toEqual([]);
    log.warn('e', 'a');
    log.warn('e', 'b');
    log.warn('e', 'c');
    log.flush();
    log.flush();
    expect(lines).toEqual(['e: a', '2 further agent connection warning(s) suppressed (limit 1 per 1s)']);
  });

  it('defaults to a small budget so a flood cannot grow the log', () => {
    const lines: string[] = [];
    const log = createAgentWarningLog({ write: (line) => lines.push(line) });
    for (let i = 0; i < 10_000; i++) log.warn('agent connection error', 'Unexpected token');
    expect(lines).toHaveLength(AGENT_WARNING_BUDGET);
  });

  it('bounds and escapes the untrusted detail', () => {
    const { lines, log } = harness();
    // V8 quotes raw input bytes in JSON syntax errors; an unknown-id response
    // is quoted back whole by the MCP SDK.
    log.warn('agent connection error', `Unexpected token '\u001b', "\u001b]52;c;ZXZpbA==\u0007\u009b2J\r\nFAKE"`);
    log.warn('agent connection error', `Received a response for an unknown message ID: ${'A'.repeat(5_000_000)}`);
    for (const line of lines) expect(RAW_CONTROL.test(line)).toBe(false);
    expect(lines[0]).toContain('\\u001b]52;c;');
    expect(lines[0]).toContain('\\r\\nFAKE');
    expect(lines[1].length).toBeLessThan(AGENT_WARNING_DETAIL_CHARS + 100);
    expect(lines[1]).toMatch(/\.\.\.\[\+\d+ chars\]$/u);
  });
});

describe('boundedDisplayDetail', () => {
  it('keeps short text intact apart from escaping', () => {
    expect(boundedDisplayDetail('plain text')).toBe('plain text');
    expect(boundedDisplayDetail('a\nb')).toBe('a\\nb');
  });

  it('caps the output even when every kept character needs an escape', () => {
    const out = boundedDisplayDetail('\u0001'.repeat(10_000), 300);
    expect(RAW_CONTROL.test(out)).toBe(false);
    expect(out.length).toBeLessThanOrEqual(300 * '\\u0001'.length + '...[+9700 chars]'.length);
    expect(out.endsWith('...[+9700 chars]')).toBe(true);
  });
});
