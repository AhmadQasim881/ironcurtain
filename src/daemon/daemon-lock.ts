/**
 * The daemon singleton lock, `{home}/daemon.lock`.
 *
 * One IronCurtain daemon runs per IronCurtain home. `IronCurtainDaemon.start()`
 * takes this lock before it logs, binds the control socket or schedules
 * anything, and holds it until shutdown, so a second daemon fails here and
 * `ironcurtain daemon` exits non-zero instead of running every cron job a
 * second time.
 *
 * CLI job commands that fall back to local execution (because no daemon
 * answered on the control socket) hold the same lock while they run. A daemon
 * whose socket merely did not answer still holds it, so the fallback refuses
 * rather than running the job beside that daemon, and no daemon can start
 * while the local command runs.
 *
 * Built on docker-workload/process-lock: the owner record (pid, OS
 * process-start identity, random token) is published atomically, a crashed
 * owner's lock is reclaimed, and a reused pid is never mistaken for the owner.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { getDaemonLockPath } from '../config/paths.js';
import { acquireProcessLock, ProcessLockBusyError, type ProcessLockHandle } from '../docker-workload/process-lock.js';

/** Error code of {@link DaemonLockBusyError}; catch on this, not `instanceof`. */
export const DAEMON_LOCK_BUSY = 'DAEMON_LOCK_BUSY';

/** Another live process (a daemon, or a local job command) holds the daemon lock. */
export class DaemonLockBusyError extends Error {
  readonly code = DAEMON_LOCK_BUSY;
  readonly lockPath: string;
  readonly ownerPid: number | undefined;

  constructor(lockPath: string, ownerPid?: number) {
    super(
      `${ownerPid === undefined ? 'Another process' : `Process ${ownerPid}`} holds the IronCurtain daemon lock ` +
        `${lockPath}: an IronCurtain daemon, or a daemon job command running without one, is already running.`,
    );
    this.name = 'DaemonLockBusyError';
    this.lockPath = lockPath;
    this.ownerPid = ownerPid;
  }
}

/** Discriminant check for {@link DaemonLockBusyError} that also works across module copies. */
export function isDaemonLockBusyError(error: unknown): error is DaemonLockBusyError {
  return error !== null && typeof error === 'object' && (error as { code?: unknown }).code === DAEMON_LOCK_BUSY;
}

/** A held daemon lock. */
export interface DaemonLock {
  readonly path: string;
  /** Releases the lock; idempotent. Throws if another process took over the lock file. */
  release(): void;
}

/**
 * Takes the daemon lock without waiting.
 *
 * Creates the IronCurtain home (owner-only) when it does not exist yet. The
 * lock is also released when the process exits through `process.exit()`;
 * after a crash the next acquirer reclaims it because the recorded owner is
 * gone.
 *
 * @throws DaemonLockBusyError when a live process holds the lock.
 */
export function acquireDaemonLock(lockPath: string = getDaemonLockPath()): DaemonLock {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });

  let handle: ProcessLockHandle;
  try {
    handle = acquireProcessLock(lockPath);
  } catch (error) {
    if (error instanceof ProcessLockBusyError) throw new DaemonLockBusyError(lockPath, error.ownerPid);
    throw error;
  }

  const releaseOnExit = (): void => {
    try {
      handle.release();
    } catch {
      // The process is exiting; a lock we no longer own is not ours to clean up.
    }
  };
  process.once('exit', releaseOnExit);

  let released = false;
  return {
    path: lockPath,
    release() {
      if (released) return;
      released = true;
      process.removeListener('exit', releaseOnExit);
      handle.release();
    },
  };
}
