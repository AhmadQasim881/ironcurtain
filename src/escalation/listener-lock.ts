/**
 * Single-instance lock of `ironcurtain escalation-listener`, and the PID
 * liveness check the session registry and the mux use.
 *
 * The lock is a docker-workload/process-lock record: owner pid, OS
 * process-start identity and a random token, written in full under a unique
 * name and published with an atomic hard link. So two listeners starting
 * together cannot both win (a stale lock is reclaimed by exactly one of
 * them), a listener's release removes only the lock it published, and a lock
 * left by a crashed listener whose pid was later reused by another process
 * is recognized as stale instead of blocking every new listener (and making
 * the mux stop claiming unowned sessions) until that process exits.
 */

import {
  acquireProcessLock,
  inspectProcessLock,
  ProcessLockBusyError,
  type ProcessIdentityResolver,
  type ProcessLockHandle,
} from '../docker-workload/process-lock.js';

/** A held listener lock. */
export interface ListenerLock {
  readonly path: string;
  /** Releases the lock; idempotent, and never throws (a lock no longer ours is left alone). */
  release(): void;
}

/** Test seam; production asks the OS process table. */
export interface ListenerLockOptions {
  readonly processIdentityForPid?: ProcessIdentityResolver;
}

/**
 * Takes the listener lock without waiting. Returns undefined when a live
 * listener holds it (or when its owner cannot be checked, which counts as
 * held). Other failures (the directory does not exist, say) throw.
 */
export function acquireListenerLock(lockPath: string, options: ListenerLockOptions = {}): ListenerLock | undefined {
  let handle: ProcessLockHandle;
  try {
    handle = acquireProcessLock(
      lockPath,
      options.processIdentityForPid ? { processIdentityForPid: options.processIdentityForPid } : {},
    );
  } catch (err) {
    if (err instanceof ProcessLockBusyError) return undefined;
    throw err;
  }
  let released = false;
  return {
    path: lockPath,
    release() {
      if (released) return;
      released = true;
      try {
        handle.release();
      } catch {
        // Ownership was lost (the file was removed or replaced): it is not ours to remove.
      }
    },
  };
}

/**
 * Whether a live listener holds the lock at `lockPath`, by the same
 * adjudication acquisition applies (pid plus process-start identity), without
 * touching it. A lock whose owner cannot be checked counts as held.
 */
export function isListenerLockHeld(lockPath: string, options: ListenerLockOptions = {}): boolean {
  return (
    inspectProcessLock(
      lockPath,
      options.processIdentityForPid ? { processIdentityForPid: options.processIdentityForPid } : {},
    ).kind === 'held'
  );
}

/**
 * Checks if a PID is alive using signal 0. EPERM means the process exists
 * but belongs to another user: alive. (This cannot tell a reused PID from the
 * original process; the lock above records the process-start identity for
 * that.) Anything but a positive integer is not a process (signal 0 to pid 0
 * or a negative pid would probe a process group).
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
