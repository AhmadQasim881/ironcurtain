/**
 * Past-run checkpoint selection helpers.
 *
 * Both the CLI (`workflow resume-standalone`) and the daemon's
 * `WorkflowManager.importExternalCheckpoint` need to scan a base directory
 * for resumable workflow runs and pick the most recent. Centralized here
 * so both paths use the same enumeration + filter + sort logic.
 *
 * Sort comparator: ISO-8601 string compare on `checkpoint.timestamp`. Both
 * the previous CLI implementation (`new Date(...).getTime()`) and the
 * previous daemon implementation (`a > b` string compare) produce the same
 * order; string compare is one fewer allocation per row.
 */

import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { toDisplayText } from '../terminal/display-sanitize.js';
import { discoverWorkflowRuns } from './workflow-discovery.js';
import {
  isCheckpointResumable,
  isWorkflowRunFileTooNewError,
  RUN_DIRECTORY_MARKERS,
  RUN_SCRIPTS_DIRNAME,
  RUN_SKILLS_DIRNAME,
  RUN_WORKSPACE_DIRNAME,
  type FileCheckpointStore,
} from './checkpoint.js';
import { isWorkflowRunLockHeld } from './run-lock.js';
import { WorkflowResumeError } from './errors.js';
import { isSafeWorkflowId, type WorkflowCheckpoint, type WorkflowId } from './types.js';

/** A resumable past run paired with its loaded checkpoint. */
export interface ResumableCheckpoint {
  readonly workflowId: WorkflowId;
  readonly checkpoint: WorkflowCheckpoint;
}

/**
 * Names that occur inside one run's directory. A scan that meets them is
 * looking at a run directory (or a copy of its contents), never at a run: a
 * run's own workspace in particular is agent-writable, so a checkpoint found
 * there must never be treated as a run to resume. Minted ids are UUIDs, so
 * no real run is named like this.
 */
const RESERVED_RUN_ENTRY_NAMES: ReadonlySet<string> = new Set([
  RUN_WORKSPACE_DIRNAME,
  RUN_SKILLS_DIRNAME,
  RUN_SCRIPTS_DIRNAME,
  'containers',
  'states',
  'bundle',
  'artifacts',
]);

/**
 * Refuses a directory that is itself a run directory (it holds a checkpoint,
 * definition copy or message log at its top level) where a base directory of
 * runs is expected. Passing `<baseDir>/<id>` instead of `<baseDir>` is an easy
 * mistake (`workflow watch` takes a run directory), and it would make the
 * run's own entries look like runs: including the agent-writable workspace,
 * where an agent can plant a checkpoint and a definition of its own choosing.
 */
export function assertWorkflowRunsBaseDir(baseDir: string): void {
  const marker = RUN_DIRECTORY_MARKERS.find((name) => existsSync(resolve(baseDir, name)));
  if (marker === undefined) return;
  throw new WorkflowResumeError(
    'WORKFLOW_INVALID_BASE_DIR',
    `${resolve(baseDir)} is a workflow run directory (it contains ${marker}), not a directory of runs. ` +
      `Pass the directory that contains it (${resolve(baseDir, '..')}) and select the run with --workflow-id.`,
  );
}

/**
 * True when both paths name the same directory: compared canonically
 * (`realpath`) where they exist, lexically otherwise. A base directory of runs
 * reached through a symlink or another spelling is the same base directory,
 * and must be treated as such (an import of it is no import at all).
 */
export function isSameDirectory(a: string, b: string): boolean {
  const canonical = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  return canonical(a) === canonical(b);
}

/**
 * Writes a skipped run's reason to stderr, bypassing console redirection. The
 * reason can quote the damaged file (V8 puts a snippet of the input in a JSON
 * parse error), and a scanned directory may come from anywhere, so it is
 * rendered safe for a terminal.
 */
function warnSkipped(message: string): void {
  process.stderr.write(`${toDisplayText(message)}\n`);
}

/**
 * Returns every resumable past run under `baseDir`, sorted newest-first by
 * `checkpoint.timestamp` (ISO-8601 string compare).
 *
 * "Resumable" means: the directory is named like a run (a safe id, not one of
 * {@link RESERVED_RUN_ENTRY_NAMES}), it has a checkpoint file, the checkpoint
 * loads successfully, {@link isCheckpointResumable} returns true (i.e. the
 * checkpoint is not in a `completed` final phase), and the run is not running
 * in a live process (its run lock is not held; see run-lock.ts). A run whose
 * checkpoint fails to load is reported on stderr and skipped, so one damaged
 * run never hides the others. Throws `WORKFLOW_INVALID_BASE_DIR` when
 * `baseDir` is itself a run directory (see {@link assertWorkflowRunsBaseDir}).
 */
export function findResumableCheckpoints(baseDir: string, store: FileCheckpointStore): ResumableCheckpoint[] {
  assertWorkflowRunsBaseDir(baseDir);
  const candidates: ResumableCheckpoint[] = [];
  for (const run of discoverWorkflowRuns(baseDir)) {
    if (!run.hasCheckpoint) continue;
    if (!isSafeWorkflowId(run.workflowId) || RESERVED_RUN_ENTRY_NAMES.has(run.workflowId)) continue;
    if (isWorkflowRunLockHeld(baseDir, run.workflowId)) continue;
    let cp: WorkflowCheckpoint | undefined;
    try {
      cp = store.load(run.workflowId);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const kind = isWorkflowRunFileTooNewError(err) ? 'was written by a newer IronCurtain' : 'failed to load';
      warnSkipped(`[workflow] Skipping ${run.workflowId}: its checkpoint ${kind}: ${reason}`);
      continue;
    }
    if (!cp || !isCheckpointResumable(cp)) continue;
    candidates.push({ workflowId: run.workflowId, checkpoint: cp });
  }
  candidates.sort((a, b) => {
    if (a.checkpoint.timestamp === b.checkpoint.timestamp) return 0;
    return a.checkpoint.timestamp < b.checkpoint.timestamp ? 1 : -1;
  });
  return candidates;
}

/**
 * Returns the most recent resumable past run under `baseDir`, or `undefined`
 * if none exist. Convenience wrapper over {@link findResumableCheckpoints}.
 */
export function findLatestResumableCheckpoint(
  baseDir: string,
  store: FileCheckpointStore,
): ResumableCheckpoint | undefined {
  return findResumableCheckpoints(baseDir, store)[0];
}
