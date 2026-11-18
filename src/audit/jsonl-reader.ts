/**
 * Streaming, bounded reader for JSONL logs (the tool-call audit logs).
 *
 * Audit logs grow with every tool call, so they are read in chunks and never
 * loaded whole. The file is opened without following a symlink and without
 * blocking (a FIFO or device at the path is refused), and a line longer than
 * the limit is skipped rather than buffered: tool arguments can be large, and
 * the reader must stay bounded whatever a log holds. Lines that are not
 * valid JSON (a write cut short by a crash, a hand edit) are counted and
 * skipped.
 */

import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

/** Default longest accepted line. Longer lines are skipped and counted. */
export const DEFAULT_MAX_JSONL_LINE_BYTES = 8 * 1024 * 1024;

const CHUNK_BYTES = 64 * 1024;
const NEWLINE = 0x0a;

/** Line counts collected while reading one file. */
export interface JsonlReadStats {
  /** Non-empty lines seen. */
  lines: number;
  /** Lines that were not valid JSON. */
  malformed: number;
  /** Lines longer than the limit (skipped unparsed). */
  oversized: number;
}

export function emptyJsonlReadStats(): JsonlReadStats {
  return { lines: 0, malformed: 0, oversized: 0 };
}

/** Raised when a path cannot be read as a regular file; `code` is the discriminant. */
export class JsonlReadError extends Error {
  readonly code: 'NOT_FOUND' | 'NOT_REGULAR_FILE' | 'IO_ERROR';
  constructor(code: JsonlReadError['code'], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'JsonlReadError';
    this.code = code;
  }
}

function errnoCode(err: unknown): string | undefined {
  const code = err instanceof Error ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Yields every JSON value in the file, in order. Malformed and oversized
 * lines update `stats` and are skipped. Throws {@link JsonlReadError} when
 * the file cannot be opened as a regular file.
 */
export async function* readJsonlValues(
  path: string,
  stats: JsonlReadStats = emptyJsonlReadStats(),
  maxLineBytes: number = DEFAULT_MAX_JSONL_LINE_BYTES,
): AsyncGenerator {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY);
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new JsonlReadError('NOT_FOUND', `no such file: ${path}`);
    if (code === 'ELOOP' || code === 'EMLINK') {
      throw new JsonlReadError('NOT_REGULAR_FILE', `refusing to follow a symlink: ${path}`);
    }
    throw new JsonlReadError('IO_ERROR', `cannot open ${path}`, { cause: err });
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new JsonlReadError('NOT_REGULAR_FILE', `not a regular file: ${path}`);

    const pending: Buffer[] = [];
    let pendingBytes = 0;
    // True while the rest of an oversized line is being skipped.
    let skipping = false;
    const chunk = Buffer.alloc(CHUNK_BYTES);

    // A parsed line, or undefined for a blank or malformed one.
    const finishLine = (line: Buffer): { readonly value: unknown } | undefined => {
      const text = line.toString('utf8').trim();
      if (text === '') return undefined;
      stats.lines += 1;
      try {
        return { value: JSON.parse(text) as unknown };
      } catch {
        stats.malformed += 1;
        return undefined;
      }
    };

    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, CHUNK_BYTES, null);
      if (bytesRead === 0) break;
      let start = 0;
      while (start < bytesRead) {
        const newline = chunk.indexOf(NEWLINE, start);
        const end = newline === -1 || newline >= bytesRead ? bytesRead : newline;
        if (!skipping) {
          const piece = chunk.subarray(start, end);
          if (pendingBytes + piece.length > maxLineBytes) {
            skipping = true;
            pending.length = 0;
            pendingBytes = 0;
          } else if (piece.length > 0) {
            pending.push(Buffer.from(piece));
            pendingBytes += piece.length;
          }
        }
        if (end === bytesRead) break; // the line continues in the next chunk
        if (skipping) {
          stats.lines += 1;
          stats.oversized += 1;
          skipping = false;
        } else {
          const parsed = finishLine(Buffer.concat(pending, pendingBytes));
          pending.length = 0;
          pendingBytes = 0;
          if (parsed !== undefined) yield parsed.value;
        }
        start = end + 1;
      }
    }
    // A last line without a newline: an append cut short, or the final record.
    if (skipping) {
      stats.lines += 1;
      stats.oversized += 1;
    } else if (pendingBytes > 0) {
      const parsed = finishLine(Buffer.concat(pending, pendingBytes));
      if (parsed !== undefined) yield parsed.value;
    }
  } finally {
    await handle.close();
  }
}
