/**
 * One live process per session directory.
 *
 * A session directory holds state its running session owns exclusively: the
 * sandbox, the escalation directory with its user-context.json, the audit log
 * and the saved conversation (a builtin session's messages.jsonl, a container
 * agent's conversation state). Two processes running the same session (two
 * `--resume` of one ID, or a `--resume` of a session that is still running)
 * would interleave all of it. The process running a standalone session
 * therefore holds `resume.lock` in the directory from creation (or resume)
 * until the session has closed: builtin sessions, batch container sessions
 * (released once their bundle is torn down) and PTY sessions
 * (src/docker/pty-session.ts) alike, so all of them exclude each other, and
 * prune keeps a session whose lock a live process holds. A session on a
 * borrowed workflow bundle works in directories its orchestrator owns and
 * takes no claim.
 *
 * The lock is the crash-recoverable process lock: a lock left behind by a
 * process that died is reclaimed, a live owner's never is.
 */

import { resolve } from 'node:path';
import { SESSION_LOCK_FILENAME } from '../config/paths.js';
import { acquireProcessLock, ProcessLockBusyError, type ProcessLockHandle } from '../docker-workload/process-lock.js';
import * as logger from '../logger.js';
import { SessionError } from '../types/errors.js';
import { errorMessage } from '../utils/error-message.js';

/** Why the claim is taken, for the error message only. */
export type SessionClaimPurpose = 'start' | 'resume';

/**
 * Claims `sessionDir`, the existing directory of session `sessionId`, for
 * this process.
 *
 * @throws {SessionError} with code SESSION_INIT_FAILED when another live
 *   process holds the session, or the lock cannot be written.
 */
export function claimSessionDirectory(
  sessionDir: string,
  sessionId: string,
  purpose: SessionClaimPurpose,
): ProcessLockHandle {
  try {
    return acquireProcessLock(resolve(sessionDir, SESSION_LOCK_FILENAME));
  } catch (error) {
    if (error instanceof ProcessLockBusyError) {
      const owner = error.ownerPid !== undefined ? ` (pid ${error.ownerPid})` : '';
      throw new SessionError(
        `Cannot ${purpose} session "${sessionId}": it is already in use by a running session${owner}`,
        'SESSION_INIT_FAILED',
      );
    }
    throw new SessionError(
      `Cannot ${purpose} session "${sessionId}": cannot lock the session directory: ${errorMessage(error)}`,
      'SESSION_INIT_FAILED',
    );
  }
}

/**
 * Releases a claim without letting cleanup replace the session's outcome:
 * the process lock throws when its file vanished or was replaced, which is
 * logged here, never rethrown from a session's close().
 */
export function releaseSessionDirectory(lock: ProcessLockHandle): void {
  try {
    lock.release();
  } catch (error) {
    logger.warn(`[session] Failed to release session lock ${lock.path}: ${errorMessage(error)}`);
  }
}
