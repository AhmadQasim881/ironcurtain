/**
 * PTY size bounds shared by every resize source (browser xterm via
 * `sessions.ptyResize`, the mux terminal, the initial spawn size).
 *
 * The daemon mirrors each PTY in a headless xterm whose buffer allocates a
 * `Uint32Array(3 * cols)` per row (rows + scrollback). An unbounded size from a
 * single `ptyResize` frame therefore allocates gigabytes of off-heap memory
 * that `--max-old-space-size` does not limit (20000x20000 measured at ~4.9 GB),
 * and node-pty writes `ws_col`/`ws_row` as unsigned shorts, so values above
 * 65535 silently wrap in the child while the headless terminal keeps the full
 * size. The bounds below are generous for any real display and are enforced
 * twice: by the RPC schema (reject) and inside `PtyBridge.resize` (clamp), so a
 * caller that bypasses the schema still cannot exhaust memory.
 *
 * The minimums are xterm's own (`MINIMUM_COLS = 2`, `MINIMUM_ROWS = 1`).
 */

export const PTY_MIN_COLS = 2;
export const PTY_MAX_COLS = 1000;
export const PTY_MIN_ROWS = 1;
export const PTY_MAX_ROWS = 500;

export interface PtySize {
  readonly cols: number;
  readonly rows: number;
}

function clampDimension(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  const truncated = Math.trunc(value);
  if (truncated < min) return min;
  if (truncated > max) return max;
  return truncated;
}

/**
 * Clamps a requested PTY size into the supported bounds. Non-finite values
 * (NaN, +/-Infinity) fall back to the minimum rather than throwing, so a bad
 * frame degrades to a tiny terminal instead of an unhandled error.
 */
export function clampPtySize(cols: number, rows: number): PtySize {
  return {
    cols: clampDimension(cols, PTY_MIN_COLS, PTY_MAX_COLS),
    rows: clampDimension(rows, PTY_MIN_ROWS, PTY_MAX_ROWS),
  };
}
