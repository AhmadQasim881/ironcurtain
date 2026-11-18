/**
 * Tails a JSONL audit log file and emits DiagnosticEvent callbacks
 * for each new entry. Uses fs.watchFile() for change notification and
 * tracks the file read offset to parse only new lines.
 *
 * The security pipeline appends a write-ahead `dispatching` record before
 * it forwards an allowed call and an outcome record once the call settles
 * (see `AuditLog`). The tailer reports outcomes only, so consumers keep
 * seeing one diagnostic per tool call.
 *
 * Reads are line-exact: when a read ends inside a line (the writer's append
 * was still in progress), the tailer keeps those bytes and completes the
 * line on the next read, so no entry split across two reads is lost. Where
 * tailing starts is the caller's choice (`startOffset`): a log shared with
 * earlier sessions (a workflow bundle's, a resumed session's) is tailed from
 * its end, so a session reports only its own entries and never re-reads the
 * history.
 */

import { openSync, readSync, fstatSync, closeSync, watchFile, unwatchFile } from 'node:fs';
import type { DiagnosticEvent } from '../session/types.js';
import { isDispatchingAuditEntry, type AuditEntry } from '../types/audit.js';

/** Upper bound on one read from the log; a larger backlog is read in several. */
const READ_CHUNK_BYTES = 1024 * 1024;

/**
 * A line longer than this is skipped instead of buffered whole. Entries carry
 * tool arguments and results, so they can be large, but not this large for a
 * one-line preview.
 */
export const MAX_AUDIT_LINE_BYTES = 64 * 1024 * 1024;

const NEWLINE = 0x0a;

export interface AuditLogTailerOptions {
  /**
   * Where tailing starts: a byte offset (default `0`, the whole file), or
   * `'end'` for the file's size when the tailer is constructed, so only
   * entries appended from then on are reported. An offset inside a line skips
   * the rest of that line (it belongs to an entry written before the start).
   * An offset past the end of the file, or a missing file, is treated like a
   * truncated log: tailing starts over at 0.
   */
  readonly startOffset?: number | 'end';
  /** Longest line kept for parsing; a longer one is skipped. Defaults to {@link MAX_AUDIT_LINE_BYTES}. */
  readonly maxLineBytes?: number;
}

/** Where tailing starts, and whether a line starts there. */
interface StartPosition {
  readonly offset: number;
  readonly atLineStart: boolean;
}

function startPosition(path: string, startOffset: number | 'end'): StartPosition {
  if (startOffset !== 'end' && (!Number.isSafeInteger(startOffset) || startOffset < 0)) {
    throw new RangeError(`startOffset must be a non-negative integer or 'end', got ${startOffset}`);
  }
  if (startOffset === 0) return { offset: 0, atLineStart: true };
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return { offset: 0, atLineStart: true }; // Not created yet: everything written to it is new.
  }
  try {
    const size = fstatSync(fd).size;
    const offset = startOffset === 'end' ? size : startOffset;
    // Past the end: start over at 0 now, like a truncated log. Keeping the
    // offset until the first read would start inside whatever the log had
    // grown to by then, mid-line and unnoticed.
    if (offset === 0 || offset > size) return { offset: 0, atLineStart: true };
    const byte = Buffer.alloc(1);
    return { offset, atLineStart: readSync(fd, byte, 0, 1, offset - 1) === 1 && byte[0] === NEWLINE };
  } catch {
    return { offset: 0, atLineStart: true }; // Unreadable: reads fail too until it is fixed.
  } finally {
    closeSync(fd);
  }
}

export class AuditLogTailer {
  /** File offset of the next byte to read. */
  private offset: number;
  /** Bytes read since the last newline: the start of a line still being written. */
  private carry: Buffer[] = [];
  private carryBytes = 0;
  /** Discard bytes up to and including the next newline (a line begun before the start, or oversized). */
  private skippingLine: boolean;
  private watching = false;
  private readonly maxLineBytes: number;
  private readonly auditLogPath: string;
  private readonly onDiagnostic: (event: DiagnosticEvent) => void;
  /** This tailer's own `watchFile` listener, so `stop()` removes only it. */
  private readonly onChange = (): void => this.readNewEntries();

  constructor(
    auditLogPath: string,
    onDiagnostic: (event: DiagnosticEvent) => void,
    options: AuditLogTailerOptions = {},
  ) {
    this.auditLogPath = auditLogPath;
    this.onDiagnostic = onDiagnostic;
    this.maxLineBytes = options.maxLineBytes ?? MAX_AUDIT_LINE_BYTES;
    const start = startPosition(auditLogPath, options.startOffset ?? 0);
    this.offset = start.offset;
    this.skippingLine = !start.atLineStart;
  }

  start(): void {
    if (this.watching) return;
    this.watching = true;
    watchFile(this.auditLogPath, { interval: 100 }, this.onChange);
  }

  stop(): void {
    if (this.watching) {
      // Passing the listener stops only this tailer: sessions sharing one log
      // (workflow fan-out lanes on one bundle) keep their own watchers.
      unwatchFile(this.auditLogPath, this.onChange);
      this.watching = false;
    }
  }

  /**
   * Read and process every complete entry appended since the last read.
   * Never throws: diagnostics are best effort, and this also runs as a
   * `watchFile` listener, where an exception would go uncaught.
   */
  readNewEntries(): void {
    let fd: number;
    try {
      fd = openSync(this.auditLogPath, 'r');
    } catch {
      return; // File may not exist yet
    }

    try {
      const size = fstatSync(fd).size;
      if (size < this.offset) {
        // Truncated or replaced: what was carried belonged to the old file.
        this.offset = 0;
        this.resetCarry();
        this.skippingLine = false;
      }
      while (this.offset < size) {
        const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, size - this.offset));
        const bytesRead = readSync(fd, chunk, 0, chunk.length, this.offset);
        if (bytesRead <= 0) break;
        this.offset += bytesRead;
        this.consume(chunk.subarray(0, bytesRead));
      }
    } catch {
      // Unreadable (EIO, a directory at the path): no diagnostics this time.
    } finally {
      closeSync(fd);
    }
  }

  /** Processes each line `chunk` completes and carries an unfinished last one. */
  private consume(chunk: Buffer): void {
    let lineStart = 0;
    let newline = chunk.indexOf(NEWLINE);
    while (newline !== -1) {
      const piece = chunk.subarray(lineStart, newline);
      if (this.skippingLine) {
        this.skippingLine = false;
      } else if (this.carryBytes + piece.length > this.maxLineBytes) {
        this.resetCarry();
      } else {
        const line = this.carryBytes === 0 ? piece : Buffer.concat([...this.carry, piece]);
        this.resetCarry();
        this.processLine(line);
      }
      lineStart = newline + 1;
      newline = chunk.indexOf(NEWLINE, lineStart);
    }

    const rest = chunk.subarray(lineStart);
    if (rest.length === 0 || this.skippingLine) return;
    if (this.carryBytes + rest.length > this.maxLineBytes) {
      this.resetCarry();
      this.skippingLine = true;
      return;
    }
    // Copied: a view would pin the whole chunk until the line completes.
    this.carry.push(Buffer.from(rest));
    this.carryBytes += rest.length;
  }

  private resetCarry(): void {
    this.carry = [];
    this.carryBytes = 0;
  }

  private processLine(line: Buffer): void {
    if (line.length === 0) return;
    try {
      const entry = JSON.parse(line.toString('utf8')) as AuditEntry;
      // Write-ahead records precede the outcome record for the same
      // call; the outcome is the one worth a diagnostic.
      if (isDispatchingAuditEntry(entry)) return;
      this.onDiagnostic({
        kind: 'tool_call',
        toolName: `${entry.serverName}.${entry.toolName}`,
        preview: this.buildPreview(entry),
      });
    } catch {
      // Ignore malformed lines and records that are not tool calls
    }
  }

  private buildPreview(entry: AuditEntry): string {
    const status = entry.result.status;
    const args = JSON.stringify(entry.arguments);
    const preview = args.length > 80 ? `${args.substring(0, 80)}...` : args;
    return `[${status}] ${preview}`;
  }
}
