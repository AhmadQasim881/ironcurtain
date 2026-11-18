/**
 * Cross-process lock around a short, synchronous read-modify-write of one
 * file that several IronCurtain processes may update at once: config.json
 * (the daemon's web UI, `ironcurtain config`, setup-signal, any load that
 * backfills defaults) and the OAuth token files (`ironcurtain auth`, every MCP
 * relay that refreshes a token).
 *
 * The lock is `<file>.lock` next to the file and is managed by the
 * crash-recoverable process lock (`../docker-workload/process-lock.ts`): the
 * owner record (PID, OS process-start identity, random token) is published
 * atomically; a lock whose owner died, or whose PID now belongs to another
 * process, is reclaimed without ever deleting a racer's fresh lock; release
 * removes only the lock this holder published; a live holder is never stolen
 * from, however long it holds the lock.
 *
 * Callers are synchronous, so a contended lock is waited for by sleeping the
 * thread (`Atomics.wait`) between attempts. That briefly blocks the event loop
 * of the waiting process, which is acceptable only because every critical
 * section is a few milliseconds (read, parse, one fsync'd atomic write). A
 * waiter that cannot get the lock within `maxWaitMs` gives up with
 * {@link FileLockTimeoutError} (`code: 'FILE_LOCK_TIMEOUT'`) and runs nothing.
 *
 * The lock is not reentrant: asking for a lock this thread already holds
 * throws immediately instead of waiting for itself.
 */

import { resolve } from 'node:path';

import {
  acquireProcessLock,
  ProcessLockBusyError,
  type ProcessIdentityResolver,
  type ProcessLockHandle,
} from '../docker-workload/process-lock.js';

/** Default wait budget for a contended lock; holders keep it for milliseconds. */
const DEFAULT_MAX_WAIT_MS = 10_000;

/** Pause between acquisition attempts while a live process holds the lock. */
const DEFAULT_RETRY_INTERVAL_MS = 10;

const LOCK_SUFFIX = '.lock';

/** Shared cell for {@link sleepSync}; nothing ever notifies it, so every wait runs to its timeout. */
const sleepCell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

/** Lock paths this thread holds right now (reentrancy guard). */
const heldLocks = new Set<string>();

export interface FileLockOptions {
  /** Give up after waiting this long for a live holder. Defaults to 10 s. */
  readonly maxWaitMs?: number;
  /** Sleep between attempts while the lock is busy. Defaults to 10 ms. */
  readonly retryIntervalMs?: number;
  /** Test seam: resolves a PID to its OS process-start identity (see process-lock.ts). */
  readonly processIdentityForPid?: ProcessIdentityResolver;
}

/** A contended lock was still held by a live process when the wait budget ran out. */
export class FileLockTimeoutError extends Error {
  readonly code = 'FILE_LOCK_TIMEOUT';
  readonly lockPath: string;
  readonly ownerPid: number | undefined;

  constructor(lockPath: string, ownerPid: number | undefined, waitedMs: number) {
    super(
      `Timed out after ${waitedMs}ms waiting for ${lockPath}` +
        (ownerPid === undefined ? '' : ` (held by pid ${ownerPid})`) +
        '. Nothing was written. If no IronCurtain process is running, remove the lock file and retry.',
    );
    this.name = 'FileLockTimeoutError';
    this.lockPath = lockPath;
    this.ownerPid = ownerPid;
  }
}

/** The lock file guarding `filePath`: a sibling named `<file>.lock`. */
export function fileLockPath(filePath: string): string {
  return `${resolve(filePath)}${LOCK_SUFFIX}`;
}

/**
 * Runs `fn` while holding the cross-process lock for `filePath`, waiting up to
 * `maxWaitMs` for a live holder to finish. The directory of `filePath` must
 * exist. The lock is released when `fn` returns or throws; if `fn` threw, its
 * error wins over a release failure. A release failure after a successful `fn`
 * is thrown (the critical section may not have been exclusive).
 */
export function withFileLockSync<T>(filePath: string, fn: () => T, options: FileLockOptions = {}): T {
  const lockPath = fileLockPath(filePath);
  if (heldLocks.has(lockPath)) {
    throw new Error(`file lock is not reentrant; this thread already holds ${lockPath}`);
  }
  const handle = acquireWithWait(lockPath, options);
  heldLocks.add(lockPath);
  let result: T;
  try {
    result = fn();
  } catch (error) {
    heldLocks.delete(lockPath);
    try {
      handle.release();
    } catch {
      // fn's error is the one the caller needs; the lock file is left for the next taker to reclaim.
    }
    throw error;
  }
  heldLocks.delete(lockPath);
  handle.release();
  return result;
}

function acquireWithWait(lockPath: string, options: FileLockOptions): ProcessLockHandle {
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const retryIntervalMs = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
  const lockOptions =
    options.processIdentityForPid === undefined ? {} : { processIdentityForPid: options.processIdentityForPid };
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    try {
      return acquireProcessLock(lockPath, lockOptions);
    } catch (error) {
      if (!(error instanceof ProcessLockBusyError)) throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new FileLockTimeoutError(lockPath, error.ownerPid, maxWaitMs);
      sleepSync(Math.min(retryIntervalMs, remaining));
    }
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(sleepCell, 0, 0, ms);
}
