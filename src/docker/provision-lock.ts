/**
 * Host-side lock that serializes provisioning of a shared, content-keyed cache:
 * the workflow dependency base (`workflow-dependency-cache.ts`) and the Apple
 * selected-agent artifact cache (`selected-agent-artifact.ts`).
 *
 * Concurrent runs that need the same cache would otherwise both find it
 * unprovisioned and race on wiping and repopulating it. In-container `flock` on a
 * bind mount does NOT serialize across containers on Docker Desktop / macOS
 * (VirtioFS does not propagate file locks), but every provisioner is a host
 * process, so the lock lives on the host.
 *
 * Ownership and takeover use the Docker-workload process lock
 * (`../docker-workload/process-lock.ts`):
 *
 * - The complete owner record (PID, OS process-start identity, random token) is
 *   written first and published with an atomic hard link, so a contender never
 *   sees a half-written owner.
 * - A contender reclaims a lock only when the owner PID is gone or now belongs to
 *   a different process (PID reuse). It captures the exact inode it judged stale
 *   with a rename and restores a racer's freshly published lock instead of
 *   deleting it, so two contenders that both judge one lock stale still leave
 *   exactly one holder.
 * - Release unlinks only the inode this holder published.
 * - A live holder is never stolen from, however long it holds the lock. Waiters
 *   poll and give up after `maxWaitMs` instead.
 *
 * This replaces an earlier `mkdir` + `meta.json` lock whose check-then-delete
 * takeover could delete a lock another waiter had just acquired (two holders),
 * and whose release removed the lock unconditionally. The lock file uses a new
 * name (`<cacheDir>.provision-lock`) so a directory left behind by a crashed
 * holder of the old lock (`<cacheDir>.lock/`) can never block it.
 */

import {
  acquireProcessLock,
  ProcessLockBusyError,
  type ProcessIdentityResolver,
  type ProcessLockHandle,
} from '../docker-workload/process-lock.js';
import { errorMessage } from '../utils/error-message.js';
import * as logger from '../logger.js';

/** Polling interval while waiting for a contended lock. */
const DEFAULT_RETRY_INTERVAL_MS = 200;

/** Default wait budget; must exceed the worst-case provisioning time. */
const DEFAULT_MAX_WAIT_MS = 25 * 60_000;

const LOCK_SUFFIX = '.provision-lock';

/** Options for {@link withProvisionLock} and {@link tryAcquireProvisionLock}. */
export interface ProvisionLockOptions {
  /**
   * Max time to wait for a contended lock before giving up. Must exceed the
   * worst-case provisioning time so a waiter does not abandon while the holder
   * is mid-install. Defaults to 25 minutes.
   */
  readonly maxWaitMs?: number;
  /** Polling interval while the lock is held by a live owner. Defaults to 200 ms. */
  readonly retryIntervalMs?: number;
  /**
   * Test seam: resolves a PID to its OS process-start identity, or `undefined`
   * when the process is gone. Production uses the host process table.
   */
  readonly processIdentityForPid?: ProcessIdentityResolver;
}

/** The lock file guarding `cacheDir`: a sibling, never inside the cache itself. */
export function provisionLockPath(cacheDir: string): string {
  return `${cacheDir}${LOCK_SUFFIX}`;
}

/**
 * One non-blocking acquisition attempt. Returns the held lock, or `undefined`
 * when a live process (possibly this one) holds it. A stale lock (dead owner or
 * reused PID) is reclaimed as part of the attempt. Any other failure, such as an
 * unwritable parent directory or an unknown own process identity, throws.
 */
export function tryAcquireProvisionLock(
  cacheDir: string,
  options: Pick<ProvisionLockOptions, 'processIdentityForPid'> = {},
): ProcessLockHandle | undefined {
  try {
    return acquireProcessLock(
      provisionLockPath(cacheDir),
      options.processIdentityForPid === undefined ? {} : { processIdentityForPid: options.processIdentityForPid },
    );
  } catch (error) {
    if (error instanceof ProcessLockBusyError) return undefined;
    throw error;
  }
}

/**
 * Runs `fn` while holding the host-side provisioning lock for `cacheDir`.
 *
 * Serializes concurrent provisioning of the same content-keyed cache so the
 * second run blocks until the first finishes and then observes the populated
 * cache. Throws if the lock cannot be acquired within `maxWaitMs`.
 *
 * Release verifies ownership. If the published lock is no longer the inode this
 * call installed, the critical section may not have been exclusive, so a
 * successful `fn` is turned into an error rather than reported as done. When
 * `fn` itself throws, its error wins and the release failure is only logged.
 */
export async function withProvisionLock<T>(
  cacheDir: string,
  fn: () => Promise<T>,
  options: ProvisionLockOptions = {},
): Promise<T> {
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const retryIntervalMs = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
  const lockPath = provisionLockPath(cacheDir);
  const deadline = Date.now() + maxWaitMs;

  let handle = tryAcquireProvisionLock(cacheDir, options);
  while (handle === undefined) {
    if (Date.now() >= deadline) {
      throw new Error(`Failed to acquire provisioning lock: ${lockPath} (timed out after ${maxWaitMs}ms)`);
    }
    await new Promise((resolveTimer) => setTimeout(resolveTimer, retryIntervalMs));
    handle = tryAcquireProvisionLock(cacheDir, options);
  }

  let result: T;
  try {
    result = await fn();
  } catch (error) {
    try {
      handle.release();
    } catch (releaseError) {
      logger.warn(`withProvisionLock: releasing ${lockPath} failed: ${errorMessage(releaseError)}`);
    }
    throw error;
  }
  handle.release();
  return result;
}
