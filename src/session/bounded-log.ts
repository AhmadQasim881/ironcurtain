/**
 * The newest entries of an append-only series, for the in-memory logs a
 * session keeps (its turns and diagnostics). A Signal or web session can run
 * for days, so these must not grow for the session's whole lifetime; older
 * entries remain in the session's files (interactions.jsonl, audit.jsonl,
 * session.log). `total` counts every entry ever appended, so numbering that
 * depends on it (turn numbers, turn counts) stays monotonic after old
 * entries are dropped.
 *
 * Leaf module.
 */

/** Turns a session keeps in memory (`Session.getHistory()`). */
export const SESSION_TURN_HISTORY_LIMIT = 200;

/** Diagnostic events a session keeps in memory (`Session.getDiagnosticLog()`). */
export const SESSION_DIAGNOSTIC_LOG_LIMIT = 2_000;

export class BoundedLog<T> {
  private readonly entries: T[] = [];
  private appended = 0;

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`BoundedLog capacity must be a positive integer, got ${capacity}`);
    }
  }

  /** Appends `entry`, dropping the oldest entry once the log is full. */
  push(entry: T): void {
    this.entries.push(entry);
    this.appended++;
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
  }

  /** The retained entries, oldest first (at most `capacity`). Live: later pushes change it. */
  get items(): readonly T[] {
    return this.entries;
  }

  /** Every entry ever appended, dropped ones included. */
  get total(): number {
    return this.appended;
  }
}
