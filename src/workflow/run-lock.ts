/**
 * Cross-process ownership of workflow runs and their workspaces.
 *
 * Every orchestrator (the daemon's, a CLI `workflow start`, a
 * `workflow resume-standalone`) holds two locks for each run it executes,
 * from `start()` / `resume()` until the run is `terminalReady`:
 *
 * - the run lock `<baseDir>/<workflowId>/run.lock`, so no second process can
 *   resume, and so execute a second time, a run that is live elsewhere, and so
 *   run listings can tell "running in another process" from "interrupted";
 * - a workspace lock keyed by the workspace directory's identity (device and
 *   inode) under `{home}/workflow-workspace-locks/`, so two runs never write
 *   one workspace at the same time, whichever processes and base directories
 *   they use (an imported checkpoint keeps pointing at the workspace of the
 *   run it came from) and whichever name reaches it. Only that directory is
 *   locked; a workspace nested inside another run's workspace is not
 *   detected.
 *
 * Cron job runs take the same workspace lock (`runReservedJob` in
 * `src/daemon/ironcurtain-daemon.ts`), from before their git sync until their
 * session has ended, so jobs that share a workspace and workflows exclude
 * one another too.
 *
 * Both are the crash-recoverable process locks of
 * `src/docker-workload/process-lock.ts`: an owner record of PID, OS
 * process-start identity and a random token, so the next claimant reclaims a
 * crashed holder's lock and a reused PID is never mistaken for the holder.
 * The locks are not re-entrant: a second claim from the same process is
 * refused like any other, which is what keeps two orchestrators in one
 * process apart too.
 */

import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  acquireProcessLock,
  inspectProcessLock,
  ProcessLockBusyError,
  type ProcessLockHandle,
} from '../docker-workload/process-lock.js';
import { sha256Hex } from '../hash.js';
import { isSafeWorkflowId, type WorkflowId } from './types.js';

/** File name of the run lock inside a run's directory. */
export const WORKFLOW_RUN_LOCK_FILENAME = 'run.lock';

export type WorkflowLockKind = 'run' | 'workspace';

/**
 * A run or workspace lock is held by a live process. `code` is the
 * discriminant for callers in other modules; `ownerPid` is the holder when
 * its owner record could be read.
 */
export class WorkflowLockBusyError extends Error {
  readonly code = 'WORKFLOW_LOCK_BUSY' as const;

  constructor(
    readonly kind: WorkflowLockKind,
    /** The workflow id for a run lock, the canonical workspace path for a workspace lock. */
    readonly target: string,
    readonly ownerPid: number | undefined,
    options?: { readonly cause?: unknown },
  ) {
    const holder =
      ownerPid === undefined
        ? 'another IronCurtain process'
        : ownerPid === process.pid
          ? `this process (pid ${ownerPid})`
          : `another IronCurtain process (pid ${ownerPid})`;
    super(
      kind === 'run'
        ? `Workflow ${target} is running in ${holder}`
        : // The lock record does not say which kind of run holds it.
          `Workspace ${target} is in use by a workflow or cron job running in ${holder}`,
      options,
    );
    this.name = 'WorkflowLockBusyError';
  }
}

export function isWorkflowLockBusyError(err: unknown): err is WorkflowLockBusyError {
  return err instanceof WorkflowLockBusyError;
}

/**
 * `<baseDir>/<workflowId>/run.lock`. Workflow ids name a directory under the
 * base directory, so locks are only ever written for ids that are a single
 * plain path segment ({@link isSafeWorkflowId}; every minted id is a UUID): a
 * crafted id such as `../x` can never place a lock file elsewhere.
 */
export function getWorkflowRunLockPath(baseDir: string, workflowId: WorkflowId): string {
  if (!isSafeWorkflowId(workflowId)) {
    throw new Error(`Invalid workflow ID for a run lock: ${JSON.stringify(workflowId)}`);
  }
  return resolve(baseDir, workflowId, WORKFLOW_RUN_LOCK_FILENAME);
}

/**
 * Lock file for the existing workspace directory `workspacePath`:
 * `<lockDir>/<sha256(device:inode)>.lock`. The key is the directory itself,
 * not a spelling of its path, so every name that reaches it maps to one lock:
 * symlinks and `..` (which realpath would resolve too), but also the case and
 * Unicode-normalization variants that a case- or normalization-insensitive
 * filesystem (APFS, the macOS default) accepts for one directory, a bind
 * mount of it, and the directory after a rename. None of those are
 * canonicalized by realpath.
 */
export function getWorkspaceLockPath(lockDir: string, workspacePath: string): string {
  const { dev, ino } = statSync(workspacePath, { bigint: true });
  return resolve(lockDir, `${sha256Hex(`workspace-dir:${dev}:${ino}`)}.lock`);
}

/**
 * Claims the run lock of `workflowId`, creating the run directory when it does
 * not exist yet. Throws {@link WorkflowLockBusyError} when a live process holds
 * it; a crashed holder's lock is reclaimed.
 */
export function claimWorkflowRunLock(baseDir: string, workflowId: WorkflowId): ProcessLockHandle {
  const lockPath = getWorkflowRunLockPath(baseDir, workflowId);
  mkdirSync(resolve(baseDir, workflowId), { recursive: true });
  try {
    return acquireProcessLock(lockPath);
  } catch (err) {
    if (err instanceof ProcessLockBusyError) {
      throw new WorkflowLockBusyError('run', workflowId, err.ownerPid, { cause: err });
    }
    throw err;
  }
}

/**
 * Claims the workspace lock for `workspacePath`, an existing directory, for a
 * workflow run or a cron job run. The key is the directory's identity (see
 * {@link getWorkspaceLockPath}), so every name for one directory maps to the
 * same lock; the realpath only names it in the error. Throws
 * {@link WorkflowLockBusyError} when a live process holds it.
 */
export function claimWorkflowWorkspaceLock(lockDir: string, workspacePath: string): ProcessLockHandle {
  const canonical = realpathSync(workspacePath);
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  try {
    return acquireProcessLock(getWorkspaceLockPath(lockDir, canonical));
  } catch (err) {
    if (err instanceof ProcessLockBusyError) {
      throw new WorkflowLockBusyError('workspace', canonical, err.ownerPid, { cause: err });
    }
    throw err;
  }
}

/**
 * Whether a live process (this one included) holds the run lock of
 * `workflowId` under `baseDir`. A snapshot for listings; claiming is what
 * enforces exclusivity. Fails closed like acquisition: a lock that cannot be
 * read or adjudicated counts as held.
 */
export function isWorkflowRunLockHeld(baseDir: string, workflowId: WorkflowId): boolean {
  if (!isSafeWorkflowId(workflowId)) return false;
  return inspectProcessLock(getWorkflowRunLockPath(baseDir, workflowId)).kind === 'held';
}

/**
 * Releases a lock, reporting rather than throwing a failure (the process-lock
 * release refuses when the published inode vanished or was replaced, for
 * example because the run directory was deleted underneath it). A failed
 * release never replaces the run's real outcome; the next claimant reclaims
 * the lock once this process exits.
 */
export function releaseWorkflowLock(handle: ProcessLockHandle | undefined, report: (message: string) => void): void {
  if (!handle) return;
  try {
    handle.release();
  } catch (err) {
    report(`Failed to release workflow lock ${handle.path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
