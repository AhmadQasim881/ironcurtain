import { isSqliteBusyError } from './storage-errors.js';

const RETRY_DELAYS_MS = [10, 25, 50] as const;
const waitBuffer = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export const SQLITE_BUSY_TIMEOUT_MS = 250;

/** Synchronous because node:sqlite operations run in the dedicated persistence worker. */
export function withSqliteBusyRetry<Value>(operation: () => Value): Value {
  for (let attempt = 0; ; attempt++) {
    try {
      return operation();
    } catch (error) {
      if (attempt >= RETRY_DELAYS_MS.length || !isSqliteBusyError(error)) throw error;
      const delayMs = RETRY_DELAYS_MS[attempt] as number;
      Atomics.wait(waitBuffer, 0, 0, delayMs);
    }
  }
}
