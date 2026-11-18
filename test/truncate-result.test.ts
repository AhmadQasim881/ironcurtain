import { describe, it, expect, afterEach } from 'vitest';
import {
  DEFAULT_RESULT_SIZE_LIMIT,
  getResultSizeLimit,
  truncateString,
  truncateResult,
  formatKB,
  linesSize,
  splitOutputBudget,
  truncateExecutionOutput,
  truncateLines,
} from '../src/session/truncate-result.js';

describe('truncateString', () => {
  it('returns the string unchanged if it fits', () => {
    expect(truncateString('hello', 100)).toBe('hello');
  });

  it('truncates a large string with head/tail and marker', () => {
    const s = 'a'.repeat(10_000);
    const result = truncateString(s, 2000);
    expect(result.length).toBeLessThan(s.length);
    expect(result).toContain('[... truncated');
    expect(result).toContain('bytes ...]');
  });

  it('preserves ~80% head and ~20% tail', () => {
    const s = 'a'.repeat(10_000);
    const result = truncateString(s, 2000);

    const markerIndex = result.indexOf('\n[... truncated');
    const afterMarker = result.indexOf('bytes ...]\n') + 'bytes ...]\n'.length;
    const headPart = result.substring(0, markerIndex);
    const tailPart = result.substring(afterMarker);

    // Head should be roughly 4x the tail size
    expect(headPart.length).toBeGreaterThan(tailPart.length * 2);
  });

  it('includes accurate byte count in marker', () => {
    const s = 'x'.repeat(5000);
    const result = truncateString(s, 1000);
    const match = result.match(/truncated (\d+) bytes/);
    expect(match).not.toBeNull();
    const truncatedBytes = parseInt(match![1], 10);
    expect(truncatedBytes).toBe(4000);
  });

  it('handles multi-byte characters without corruption', () => {
    const s = '€'.repeat(2000); // 3 bytes each = 6000 bytes
    const result = truncateString(s, 1000);

    expect(result).toContain('[... truncated');

    // The result should be valid UTF-8 (round-trips cleanly)
    const encoded = Buffer.from(result, 'utf-8');
    const decoded = encoded.toString('utf-8');
    expect(decoded).toBe(result);
  });
});

describe('truncateResult', () => {
  it('passes small result through unchanged (same reference)', () => {
    const value = { content: [{ type: 'text', text: 'hello' }] };
    const result = truncateResult(value, 1000);
    expect(result.truncated).toBe(false);
    expect(result.value).toBe(value); // same reference, zero-copy
    expect(result.originalSize).toBe(result.finalSize);
  });

  it('truncates a large object to a string with marker', () => {
    const bigText = 'x'.repeat(50_000);
    const value = { content: [{ type: 'text', text: bigText }] };
    const result = truncateResult(value, 5000);
    expect(result.truncated).toBe(true);
    expect(typeof result.value).toBe('string');
    expect(result.value as string).toContain('[... truncated');
    expect(result.finalSize).toBeLessThanOrEqual(5000);
  });

  it('originalSize reflects the JSON serialization size', () => {
    const s = 'a'.repeat(10_000);
    const result = truncateResult(s, 2000);
    expect(result.truncated).toBe(true);
    // JSON.stringify wraps the string in quotes: "aaa..."
    expect(result.originalSize).toBe(Buffer.byteLength(JSON.stringify(s), 'utf-8'));
  });

  it('does not mutate the original value', () => {
    const original = { text: 'a'.repeat(10_000) };
    const originalText = original.text;
    truncateResult(original, 2000);
    expect(original.text).toBe(originalText);
  });

  it('handles null input', () => {
    const r = truncateResult(null, 1000);
    expect(r.value).toBeNull();
    expect(r.truncated).toBe(false);
    expect(r.originalSize).toBe(4); // "null"
  });

  it('handles undefined input', () => {
    const r = truncateResult(undefined, 1000);
    // JSON.stringify(undefined) returns undefined, not a string
    expect(r.truncated).toBe(false);
  });

  it('handles non-string primitives', () => {
    const r = truncateResult(42, 1000);
    expect(r.value).toBe(42);
    expect(r.truncated).toBe(false);
    expect(r.originalSize).toBe(2); // "42"
  });
});

describe('getResultSizeLimit', () => {
  const originalEnv = process.env['RESULT_SIZE_LIMIT'];

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env['RESULT_SIZE_LIMIT'] = originalEnv;
    } else {
      delete process.env['RESULT_SIZE_LIMIT'];
    }
  });

  it('returns default when env var is not set', () => {
    delete process.env['RESULT_SIZE_LIMIT'];
    expect(getResultSizeLimit()).toBe(DEFAULT_RESULT_SIZE_LIMIT);
  });

  it('reads RESULT_SIZE_LIMIT from environment', () => {
    process.env['RESULT_SIZE_LIMIT'] = '50000';
    expect(getResultSizeLimit()).toBe(50_000);
  });

  it('falls back to default for invalid values', () => {
    process.env['RESULT_SIZE_LIMIT'] = 'not-a-number';
    expect(getResultSizeLimit()).toBe(DEFAULT_RESULT_SIZE_LIMIT);
  });

  it('falls back to default for negative values', () => {
    process.env['RESULT_SIZE_LIMIT'] = '-100';
    expect(getResultSizeLimit()).toBe(DEFAULT_RESULT_SIZE_LIMIT);
  });
});

describe('formatKB', () => {
  it('formats bytes as KB', () => {
    expect(formatKB(1024)).toBe('1.0KB');
    expect(formatKB(102400)).toBe('100.0KB');
    expect(formatKB(1536)).toBe('1.5KB');
  });
});

describe('truncateLines', () => {
  it('returns lines unchanged when they fit', () => {
    const lines = ['a', 'bb', 'ccc'];
    const out = truncateLines(lines, 100);
    expect(out).toEqual({ lines, truncated: false, originalSize: 9, finalSize: 9 });
  });

  it('keeps head and tail lines around one marker, within the budget', () => {
    const lines = Array.from({ length: 1_000 }, (_, i) => `line ${i}`.padEnd(50, '.'));
    const out = truncateLines(lines, 5_000);
    expect(out.truncated).toBe(true);
    expect(out.finalSize).toBeLessThanOrEqual(5_000);
    expect(out.finalSize).toBe(linesSize(out.lines));
    expect(out.lines[0]).toBe(lines[0]);
    expect(out.lines.at(-1)).toBe(lines.at(-1));
    const markers = out.lines.filter((line) => line.startsWith('[... console output truncated'));
    expect(markers).toHaveLength(1);
    expect(markers[0]).toContain(`of ${linesSize(lines)} bytes omitted`);
    // About 80% of the kept lines come from the head.
    const markerAt = out.lines.indexOf(markers[0]);
    expect(markerAt).toBeGreaterThan((out.lines.length - 1) * 0.7);
  });

  it('always keeps the last line, where a failed script reports its error', () => {
    const lines = [...Array.from({ length: 200 }, () => 'z'.repeat(1_000)), '[ERROR] Code execution failed: boom'];
    const out = truncateLines(lines, 10_000);
    expect(out.lines.at(-1)).toBe('[ERROR] Code execution failed: boom');
    expect(out.finalSize).toBeLessThanOrEqual(10_000);
  });

  it('cuts a single oversized line instead of dropping it', () => {
    const out = truncateLines(['q'.repeat(100_000)], 4_000);
    expect(out.truncated).toBe(true);
    expect(out.lines[0]).toContain('[... truncated');
    expect(out.finalSize).toBeLessThanOrEqual(4_000);
  });
});

describe('splitOutputBudget', () => {
  it('keeps both parts whole when they fit', () => {
    expect(splitOutputBudget(10, 20, 100)).toEqual({ consoleBudget: 10, resultBudget: 20 });
  });

  it('gives a small part its full size and the rest to the other', () => {
    expect(splitOutputBudget(10, 500, 100)).toEqual({ consoleBudget: 10, resultBudget: 90 });
    expect(splitOutputBudget(500, 10, 100)).toEqual({ consoleBudget: 90, resultBudget: 10 });
  });

  it('halves the budget when both parts are large', () => {
    expect(splitOutputBudget(500, 500, 100)).toEqual({ consoleBudget: 50, resultBudget: 50 });
  });
});

describe('truncateExecutionOutput', () => {
  it('passes small output through unchanged (same result reference)', () => {
    const result = { ok: true };
    const out = truncateExecutionOutput(['hello'], result, 1_000);
    expect(out.truncated).toBe(false);
    expect(out.console).toEqual(['hello']);
    expect(out.result).toBe(result);
  });

  it('bounds console output and result together', () => {
    const logs = Array.from({ length: 5_000 }, (_, i) => `log ${i}`.padEnd(100, '-'));
    const out = truncateExecutionOutput(logs, { blob: 'b'.repeat(200_000) }, 50_000);
    expect(out.truncated).toBe(true);
    expect(out.finalSize).toBeLessThanOrEqual(50_000);
    expect(linesSize(out.console)).toBeLessThanOrEqual(25_000);
    expect(typeof out.result).toBe('string');
    expect(out.result as string).toContain('[... truncated');
    expect(out.originalSize).toBe(linesSize(logs) + JSON.stringify({ blob: 'b'.repeat(200_000) }).length);
  });

  it('truncates a huge console even when the result is tiny', () => {
    const logs = Array.from({ length: 20_000 }, () => 'x'.repeat(50));
    const out = truncateExecutionOutput(logs, 7, 10_000);
    expect(out.result).toBe(7);
    expect(out.truncated).toBe(true);
    expect(linesSize(out.console)).toBeLessThanOrEqual(10_000);
  });

  it('handles a script that returned nothing', () => {
    const out = truncateExecutionOutput([], undefined, 100);
    expect(out).toMatchObject({ console: [], result: undefined, truncated: false, originalSize: 0 });
  });
});
