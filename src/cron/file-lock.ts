/**
 * Advisory file locking for the job store.
 *
 * Built on docker-workload/process-lock, the lock shared by the daemon,
 * session and workflow locks: the owner record (pid, OS process-start
 * identity, random token) is written in full under a unique name and
 * published with an atomic hard link, so a contender never sees a lock
 * without its owner; a lock whose owner died (or whose pid was reused by
 * another process) is reclaimed by exactly one contender, which captures the
 * exact inode it judged stale; and release removes the lock only while it is
 * still the inode this process published. A live owner's lock is never taken
 * over, however long it is held: a contender waits, and gives up after
 * {@link DEFAULT_MAX_WAIT_MS}.
 *
 * This is designed for short-lived critical sections (load-modify-save of a
 * job.json), not long-held process-level locks. For process singleton
 * enforcement, see src/daemon/daemon-lock.ts and
 * src/escalation/listener-lock.ts.
 */

import { resolve } from 'node:path';
import {
  acquireProcessLock,
  ProcessLockBusyError,
  type ProcessIdentityResolver,
  type ProcessLockHandle,
} from '../docker-workload/process-lock.js';
import * as logger from '../logger.js';

/** Retry interval while waiting for a lock. */
const RETRY_INTERVAL_MS = 50;

/** Longest a contender waits for a live owner to release the lock. */
export const DEFAULT_MAX_WAIT_MS = 10_000;

/** A held advisory lock. */
export interface FileLock {
  readonly path: string;
  /**
   * Releases the lock; idempotent. Throws when the lock is no longer the one
   * this process published (its job directory was deleted meanwhile, say),
   * and then removes nothing.
   */
  release(): void;
}

export interface AcquireFileLockOptions {
  /** How long to wait for a live owner (default {@link DEFAULT_MAX_WAIT_MS}); 0 tries once. */
  readonly maxWaitMs?: number;
  /** Test seam; production asks the OS process table. */
  readonly processIdentityForPid?: ProcessIdentityResolver;
}

/**
 * Acquires the advisory lock at `lockPath`, waiting while a live process
 * holds it. Resolves undefined when the wait times out. Any other failure
 * (the lock's directory does not exist, the filesystem refuses the write)
 * rejects.
 */
export async function acquireLock(
  lockPath: string,
  options: AcquireFileLockOptions = {},
): Promise<FileLock | undefined> {
  const deadline = Date.now() + (options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
  for (;;) {
    let handle: ProcessLockHandle;
    try {
      handle = acquireProcessLock(
        lockPath,
        options.processIdentityForPid ? { processIdentityForPid: options.processIdentityForPid } : {},
      );
    } catch (err) {
      if (!(err instanceof ProcessLockBusyError)) throw err;
      if (Date.now() >= deadline) return undefined;
      await new Promise((done) => setTimeout(done, RETRY_INTERVAL_MS));
      continue;
    }
    return { path: lockPath, release: () => handle.release() };
  }
}

/**
 * Executes a function while holding an advisory file lock.
 *
 * Acquires the lock, runs the function, and releases the lock in a finally
 * block. Throws if the lock cannot be acquired within the wait. A lock that
 * was lost while `fn` ran (its directory was removed by a job deletion) is
 * logged rather than thrown: `fn` has already done its work.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => T | Promise<T>,
  options: AcquireFileLockOptions = {},
): Promise<T> {
  const lock = await acquireLock(lockPath, options);
  if (!lock) {
    throw new Error(
      `Failed to acquire file lock: ${lockPath} (still held by another process after ` +
        `${options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS}ms)`,
    );
  }

  try {
    return await fn();
  } finally {
    try {
      lock.release();
    } catch (err) {
      logger.warn(`[file-lock] ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Returns the conventional lock file path for a job directory:
 * `{jobDir}/job.lock`. (Older versions used a `job.json.lock/` directory;
 * one left behind by a crash is ignored.)
 */
export function getJobLockPath(jobDir: string): string {
  return resolve(jobDir, 'job.lock');
}
