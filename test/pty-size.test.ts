/**
 * Unit tests for the PTY size bounds (src/pty/pty-size.ts) shared by the
 * `sessions.ptyResize` schema and `PtyBridge.resize`.
 */

import { describe, it, expect } from 'vitest';
import { clampPtySize, PTY_MAX_COLS, PTY_MAX_ROWS, PTY_MIN_COLS, PTY_MIN_ROWS } from '../src/pty/pty-size.js';

describe('clampPtySize', () => {
  it('passes in-range sizes through unchanged', () => {
    expect(clampPtySize(80, 24)).toEqual({ cols: 80, rows: 24 });
    expect(clampPtySize(PTY_MIN_COLS, PTY_MIN_ROWS)).toEqual({ cols: PTY_MIN_COLS, rows: PTY_MIN_ROWS });
    expect(clampPtySize(PTY_MAX_COLS, PTY_MAX_ROWS)).toEqual({ cols: PTY_MAX_COLS, rows: PTY_MAX_ROWS });
  });

  it('clamps oversized values to the maxima', () => {
    expect(clampPtySize(20_000, 20_000)).toEqual({ cols: PTY_MAX_COLS, rows: PTY_MAX_ROWS });
    expect(clampPtySize(1e6, 24)).toEqual({ cols: PTY_MAX_COLS, rows: 24 });
    expect(clampPtySize(80, 70_000)).toEqual({ cols: 80, rows: PTY_MAX_ROWS });
  });

  it('clamps undersized values to the minima', () => {
    expect(clampPtySize(0, 0)).toEqual({ cols: PTY_MIN_COLS, rows: PTY_MIN_ROWS });
    expect(clampPtySize(-10, -10)).toEqual({ cols: PTY_MIN_COLS, rows: PTY_MIN_ROWS });
    expect(clampPtySize(1, 1)).toEqual({ cols: PTY_MIN_COLS, rows: 1 });
  });

  it('truncates fractional values and maps non-finite values to the minima', () => {
    expect(clampPtySize(80.9, 24.2)).toEqual({ cols: 80, rows: 24 });
    expect(clampPtySize(Number.NaN, Number.NaN)).toEqual({ cols: PTY_MIN_COLS, rows: PTY_MIN_ROWS });
    expect(clampPtySize(Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY)).toEqual({
      cols: PTY_MIN_COLS,
      rows: PTY_MIN_ROWS,
    });
  });

  it('keeps the bounds within what node-pty can represent (unsigned short winsize)', () => {
    expect(PTY_MAX_COLS).toBeLessThanOrEqual(65_535);
    expect(PTY_MAX_ROWS).toBeLessThanOrEqual(65_535);
    expect(PTY_MIN_COLS).toBeGreaterThanOrEqual(2); // xterm MINIMUM_COLS
    expect(PTY_MIN_ROWS).toBeGreaterThanOrEqual(1); // xterm MINIMUM_ROWS
  });
});
