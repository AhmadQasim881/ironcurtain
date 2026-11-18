/**
 * Tool result truncation utility.
 *
 * Truncates oversized tool results before they reach the LLM to prevent
 * "prompt is too long" errors. The audit log (written at the trusted
 * process level) preserves full untruncated results for forensics.
 *
 * Strategy: serialize the value to JSON, measure that, and if it exceeds
 * the budget, truncate the JSON string with a head/tail split.
 */

/** 100 KB ≈ 25K tokens, matching Claude Code's cap. */
export const DEFAULT_RESULT_SIZE_LIMIT = 100_000;

/** Returns the configured result size limit (bytes). */
export function getResultSizeLimit(): number {
  const envVal = process.env['RESULT_SIZE_LIMIT'];
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_RESULT_SIZE_LIMIT;
}

export interface TruncationResult {
  value: unknown;
  truncated: boolean;
  originalSize: number;
  finalSize: number;
}

/**
 * Truncates a single string to fit within `maxBytes`, keeping ~80% from
 * the head and ~20% from the tail with a marker in between.
 */
export function truncateString(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf-8');
  if (buf.length <= maxBytes) return s;

  const truncatedBytes = buf.length - maxBytes;
  const realMarker = `\n[... truncated ${truncatedBytes} bytes ...]\n`;
  const markerBytes = Buffer.byteLength(realMarker, 'utf-8');

  const available = maxBytes - markerBytes;
  if (available <= 0) return realMarker;

  const headBytes = Math.floor(available * 0.8);
  const tailBytes = available - headBytes;

  const head = buf.subarray(0, headBytes).toString('utf-8');
  const tail = tailBytes > 0 ? buf.subarray(buf.length - tailBytes).toString('utf-8') : '';

  return head + realMarker + tail;
}

/**
 * Truncates a tool result value to fit within `budget` bytes.
 *
 * Serializes the value to JSON, and if it exceeds the budget, replaces
 * it with a truncated string (head/tail with marker). When the value
 * fits, it's returned as-is (zero-copy).
 */
export function truncateResult(value: unknown, budget?: number): TruncationResult {
  const limit = budget ?? getResultSizeLimit();

  const json = JSON.stringify(value);
  // JSON.stringify returns undefined for undefined input (TS types don't reflect this)
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime: JSON.stringify(undefined) returns undefined
  if (json === undefined) {
    return { value, truncated: false, originalSize: 0, finalSize: 0 };
  }
  const originalSize = Buffer.byteLength(json, 'utf-8');

  if (originalSize <= limit) {
    return { value, truncated: false, originalSize, finalSize: originalSize };
  }

  const truncated = truncateString(json, limit);
  const finalSize = Buffer.byteLength(truncated, 'utf-8');
  return { value: truncated, truncated: true, originalSize, finalSize };
}

/** Formats bytes as a human-readable KB string. */
export function formatKB(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)}KB`;
}

// ---------------------------------------------------------------------------
// execute_code output: console lines and result under one budget
// ---------------------------------------------------------------------------

/** Room kept for the marker line {@link truncateLines} inserts. */
const LINES_MARKER_RESERVE = 96;

/** Smallest remainder worth filling with the cut-off part of a line. */
const MIN_PARTIAL_LINE_BYTES = 64;

/** Size of console lines as text: their UTF-8 bytes plus one newline each. */
export function linesSize(lines: readonly string[]): number {
  let size = 0;
  for (const line of lines) size += Buffer.byteLength(line, 'utf-8') + 1;
  return size;
}

export interface LinesTruncation {
  lines: string[];
  truncated: boolean;
  originalSize: number;
  finalSize: number;
}

/**
 * Truncates console lines to `maxBytes` (measured like {@link linesSize}),
 * keeping whole lines from the head (about 80% of the budget) and from the
 * tail (the rest) with one marker line between them. A line that only
 * partly fits at the edge of either part is cut with {@link truncateString}.
 * The tail keeps the script's last lines, where a failed script reports its
 * error.
 */
export function truncateLines(lines: readonly string[], maxBytes: number): LinesTruncation {
  const sizes = lines.map((line) => Buffer.byteLength(line, 'utf-8') + 1);
  const originalSize = sizes.reduce((sum, size) => sum + size, 0);
  if (originalSize <= maxBytes) {
    return { lines: [...lines], truncated: false, originalSize, finalSize: originalSize };
  }

  const available = Math.max(0, maxBytes - LINES_MARKER_RESERVE);
  const headBudget = Math.floor(available * 0.8);
  const tailBudget = available - headBudget;

  const head: string[] = [];
  let headUsed = 0;
  let next = 0;
  while (next < lines.length && headUsed + sizes[next] <= headBudget) {
    head.push(lines[next]);
    headUsed += sizes[next];
    next++;
  }
  if (next < lines.length && headBudget - headUsed >= MIN_PARTIAL_LINE_BYTES) {
    const partial = truncateString(lines[next], headBudget - headUsed - 1);
    head.push(partial);
    headUsed += Buffer.byteLength(partial, 'utf-8') + 1;
    next++;
  }

  const tail: string[] = [];
  let tailUsed = 0;
  let last = lines.length - 1;
  while (last >= next && tailUsed + sizes[last] <= tailBudget) {
    tail.unshift(lines[last]);
    tailUsed += sizes[last];
    last--;
  }
  if (last >= next && tailBudget - tailUsed >= MIN_PARTIAL_LINE_BYTES) {
    const partial = truncateString(lines[last], tailBudget - tailUsed - 1);
    tail.unshift(partial);
    tailUsed += Buffer.byteLength(partial, 'utf-8') + 1;
  }

  const marker = `[... console output truncated: ${originalSize - headUsed - tailUsed} of ${originalSize} bytes omitted ...]`;
  const kept = [...head, marker, ...tail];
  return { lines: kept, truncated: true, originalSize, finalSize: linesSize(kept) };
}

/**
 * Splits one output budget between a script's console output and its result
 * so the two together stay within `budget`. A part smaller than half the
 * budget keeps its full size and the other part gets the rest; when both are
 * larger, each gets half.
 */
export function splitOutputBudget(
  consoleSize: number,
  resultSize: number,
  budget: number,
): { consoleBudget: number; resultBudget: number } {
  if (consoleSize + resultSize <= budget) return { consoleBudget: consoleSize, resultBudget: resultSize };
  const half = Math.floor(budget / 2);
  if (consoleSize <= half) return { consoleBudget: consoleSize, resultBudget: budget - consoleSize };
  if (resultSize <= half) return { consoleBudget: budget - resultSize, resultBudget: resultSize };
  return { consoleBudget: half, resultBudget: budget - half };
}

export interface ExecutionOutputTruncation {
  /** Console lines to show (with a marker line when some were cut). */
  console: string[];
  /** The result, or its truncated JSON text. */
  result: unknown;
  truncated: boolean;
  /** Console size plus result JSON size before truncation, in bytes. */
  originalSize: number;
  finalSize: number;
}

/**
 * Bounds what one `execute_code` call hands the model: its console lines and
 * its result share `budget` bytes (see {@link splitOutputBudget}). Truncating
 * only the result let a script return megabytes of console output, more than
 * the model's context and the loop detector's hashing could take. The result
 * is measured and cut as JSON, like {@link truncateResult}.
 */
export function truncateExecutionOutput(
  logs: readonly string[],
  result: unknown,
  budget: number = getResultSizeLimit(),
): ExecutionOutputTruncation {
  const consoleSize = linesSize(logs);
  const resultJson = JSON.stringify(result) as string | undefined;
  const resultSize = resultJson === undefined ? 0 : Buffer.byteLength(resultJson, 'utf-8');
  const { consoleBudget, resultBudget } = splitOutputBudget(consoleSize, resultSize, budget);

  const lines = truncateLines(logs, consoleBudget);
  let boundedResult: unknown = result;
  let resultFinalSize = resultSize;
  let resultTruncated = false;
  if (resultJson !== undefined && resultSize > resultBudget) {
    const text = truncateString(resultJson, resultBudget);
    boundedResult = text;
    resultFinalSize = Buffer.byteLength(text, 'utf-8');
    resultTruncated = true;
  }

  return {
    console: lines.lines,
    result: boundedResult,
    truncated: lines.truncated || resultTruncated,
    originalSize: consoleSize + resultSize,
    finalSize: lines.finalSize + resultFinalSize,
  };
}
