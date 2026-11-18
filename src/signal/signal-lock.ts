/**
 * The Signal transport lock, `{home}/signal.lock`.
 *
 * One process per IronCurtain home runs the Signal transport: `ironcurtain
 * bot`, or `ironcurtain daemon` unless `--no-signal`. Both attach to the same
 * signal-cli container (`signal.container`) and its receive stream, so a
 * second one would also handle every incoming message (starting a second
 * agent session for the same task) or take some of them, and would manage
 * (restart, recreate) the container the first one uses. Whoever starts the
 * transport takes this lock before it touches the container and holds it
 * until the transport has shut down: a second `ironcurtain bot` exits naming
 * the owner, and a daemon starts without Signal.
 *
 * This lock is separate from the daemon lock (src/daemon/daemon-lock.ts):
 * `ironcurtain daemon --no-signal` and `ironcurtain bot` may run side by side.
 *
 * Built on docker-workload/process-lock: the owner record (pid, OS
 * process-start identity, random token) is published atomically, a crashed
 * owner's lock is reclaimed, and a reused pid is never mistaken for the owner.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { getSignalLockPath } from '../config/paths.js';
import { acquireProcessLock, ProcessLockBusyError, type ProcessLockHandle } from '../docker-workload/process-lock.js';

/** Error code of {@link SignalLockBusyError}; catch on this, not `instanceof`. */
export const SIGNAL_LOCK_BUSY = 'SIGNAL_LOCK_BUSY';

/** Another live process (a bot, or a daemon with the Signal transport) holds the Signal lock. */
export class SignalLockBusyError extends Error {
  readonly code = SIGNAL_LOCK_BUSY;
  readonly lockPath: string;
  readonly ownerPid: number | undefined;

  constructor(lockPath: string, ownerPid?: number) {
    super(
      `${ownerPid === undefined ? 'Another process' : `Process ${ownerPid}`} holds the IronCurtain Signal lock ` +
        `${lockPath}: an ironcurtain bot, or an ironcurtain daemon with the Signal transport, ` +
        'already runs Signal for this home.',
    );
    this.name = 'SignalLockBusyError';
    this.lockPath = lockPath;
    this.ownerPid = ownerPid;
  }
}

/** Discriminant check for {@link SignalLockBusyError} that also works across module copies. */
export function isSignalLockBusyError(error: unknown): error is SignalLockBusyError {
  return error !== null && typeof error === 'object' && (error as { code?: unknown }).code === SIGNAL_LOCK_BUSY;
}

/** A held Signal lock. */
export interface SignalLock {
  readonly path: string;
  /** Releases the lock; idempotent, and never throws (a lock no longer ours is left alone). */
  release(): void;
}

/**
 * Takes the Signal lock without waiting.
 *
 * Creates the IronCurtain home (owner-only) when it does not exist yet. The
 * lock is also released when the process exits through `process.exit()`;
 * after a crash the next acquirer reclaims it because the recorded owner is
 * gone.
 *
 * @throws SignalLockBusyError when a live process holds the lock.
 */
export function acquireSignalLock(lockPath: string = getSignalLockPath()): SignalLock {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });

  let handle: ProcessLockHandle;
  try {
    handle = acquireProcessLock(lockPath);
  } catch (error) {
    if (error instanceof ProcessLockBusyError) throw new SignalLockBusyError(lockPath, error.ownerPid);
    throw error;
  }

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    process.removeListener('exit', release);
    try {
      handle.release();
    } catch {
      // Ownership was lost (the file was removed or replaced): it is not ours to remove.
    }
  };
  process.once('exit', release);
  return { path: lockPath, release };
}
