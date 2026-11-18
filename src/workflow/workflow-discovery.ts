import { lstatSync, readdirSync, statSync, type Dirent, type Stats } from 'node:fs';
import { resolve } from 'node:path';
import { SESSION_METADATA_FILENAME } from '../config/paths.js';
import { loadSessionMetadataFromPath } from '../session/session-metadata.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import { errorMessage } from '../utils/error-message.js';
import { CHECKPOINT_FILENAME, PREVIOUS_CHECKPOINT_FILENAME } from './checkpoint.js';
import { isSafeWorkflowId, type WorkflowId } from './types.js';

export interface WorkflowRunSummary {
  readonly workflowId: WorkflowId;
  readonly directoryPath: string;
  readonly hasCheckpoint: boolean;
  readonly hasDefinition: boolean;
  readonly hasMessageLog: boolean;
  readonly mtime: Date;
  /**
   * Changes whenever the run directory or a file a past-run load reads
   * changes: it combines the directory's identity and mtime with the identity
   * (device, inode, size, mtime, ctime) of `checkpoint.json`,
   * `checkpoint.prev.json`, `definition.json` and `messages.jsonl`. Checkpoints
   * and definition copies are replaced by rename and the message log only
   * grows, so a value derived from these files can be memoized under this key
   * without reading them again. Discovery itself never reads them.
   */
  readonly filesKey: string;
}

/** Options for {@link discoverWorkflowRuns}. */
export interface DiscoverWorkflowRunsOptions {
  /**
   * Receives the reason a run directory was skipped because it could not be
   * examined (a permission error, a symlink loop). Defaults to stderr,
   * rendered safe for a terminal (the reason quotes names from the scanned
   * directory).
   */
  readonly warn?: (message: string) => void;
}

function warnOnStderr(message: string): void {
  process.stderr.write(`${toDisplayText(message)}\n`);
}

/** The entry is gone: removed, or a path component replaced by a non-directory, while we looked. */
function isGoneError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Identity of the file at `path` (following a symlink, as the probes always did), or undefined when absent. */
function fileIdentity(path: string): string | undefined {
  const stats = statSync(path, { throwIfNoEntry: false });
  return stats === undefined ? undefined : `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
}

/** Throws when a run file cannot be examined for any reason but its absence. */
function buildSummary(directoryPath: string, workflowId: WorkflowId, directoryStats: Stats): WorkflowRunSummary {
  const checkpoint = fileIdentity(resolve(directoryPath, CHECKPOINT_FILENAME));
  const previousCheckpoint = fileIdentity(resolve(directoryPath, PREVIOUS_CHECKPOINT_FILENAME));
  const definition = fileIdentity(resolve(directoryPath, 'definition.json'));
  const messageLog = fileIdentity(resolve(directoryPath, 'messages.jsonl'));
  return {
    workflowId,
    directoryPath,
    hasCheckpoint: checkpoint !== undefined,
    hasDefinition: definition !== undefined,
    hasMessageLog: messageLog !== undefined,
    mtime: directoryStats.mtime,
    filesKey: [
      `${directoryStats.dev}:${directoryStats.ino}:${directoryStats.mtimeMs}`,
      checkpoint ?? '-',
      previousCheckpoint ?? '-',
      definition ?? '-',
      messageLog ?? '-',
    ].join('|'),
  };
}

/** `readdirSync` that swallows ENOENT (returns `[]`); other errors propagate. */
function readDirEntries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Scan `baseDir` for workflow-run directories; one summary per immediate
 * subdirectory named like a run (a safe workflow id), sorted newest-first by
 * `mtime`. Other entries are not runs: `ironcurtain prune` moves a run it
 * removes aside to a dot-named directory first, for one. Missing `baseDir`
 * returns `[]` (mirrors `FileCheckpointStore.listAll()`); a `baseDir` that
 * cannot be read throws.
 *
 * A symlink is never a run. One bad entry never fails the scan, which would
 * hide every other run from `workflow inspect` and the daemon's past-runs
 * listing: a run directory removed mid-scan is skipped silently, and one that
 * cannot be examined (unreadable, a symlink loop at a probed name) is skipped
 * with a warning (see {@link DiscoverWorkflowRunsOptions.warn}).
 *
 * Only directory metadata is read, never a run's files: callers that need a
 * checkpoint load it once themselves, and can memoize what they derive from
 * it under {@link WorkflowRunSummary.filesKey}.
 */
export function discoverWorkflowRuns(baseDir: string, options: DiscoverWorkflowRunsOptions = {}): WorkflowRunSummary[] {
  const warn = options.warn ?? warnOnStderr;
  const entries = readDirEntries(baseDir);
  const summaries: WorkflowRunSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafeWorkflowId(entry.name)) continue;
    const directoryPath = resolve(baseDir, entry.name);
    try {
      const stats = lstatSync(directoryPath);
      if (!stats.isDirectory()) continue; // Replaced (by a symlink, say) since the readdir.
      summaries.push(buildSummary(directoryPath, entry.name, stats));
    } catch (err) {
      if (!isGoneError(err)) warn(`[workflow] Skipping run directory ${directoryPath}: ${errorMessage(err)}`);
    }
  }
  summaries.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return summaries;
}

/**
 * Recovers the `workspacePath` for a checkpoint-less past run from session-
 * metadata files written per state actor under
 * `<runDir>/containers/*\/states/*\/{SESSION_METADATA_FILENAME}`. Picks the
 * entry with the newest `createdAt`. Returns `undefined` when no usable file
 * is found.
 */
export function discoverWorkspacePathFromContainers(runDir: string): string | undefined {
  const containersDir = resolve(runDir, 'containers');
  let bestWorkspace: string | undefined;
  let bestCreatedAt = '';

  for (const container of readDirEntries(containersDir)) {
    if (!container.isDirectory()) continue;
    const statesDir = resolve(containersDir, container.name, 'states');
    for (const state of readDirEntries(statesDir)) {
      if (!state.isDirectory()) continue;
      const metadata = loadSessionMetadataFromPath(resolve(statesDir, state.name, SESSION_METADATA_FILENAME));
      if (!metadata?.workspacePath || !metadata.createdAt) continue;
      if (metadata.createdAt > bestCreatedAt) {
        bestCreatedAt = metadata.createdAt;
        bestWorkspace = metadata.workspacePath;
      }
    }
  }

  return bestWorkspace;
}

/**
 * Single-id variant of {@link discoverWorkflowRuns}; returns `undefined` when
 * the directory doesn't exist. Unlike the scan, it throws when the run cannot
 * be examined.
 */
export function summaryForId(baseDir: string, workflowId: WorkflowId): WorkflowRunSummary | undefined {
  const directoryPath = resolve(baseDir, workflowId);
  let stats;
  try {
    stats = statSync(directoryPath);
  } catch (err) {
    if (isGoneError(err)) return undefined;
    throw err;
  }
  if (!stats.isDirectory()) return undefined;
  return buildSummary(directoryPath, workflowId, stats);
}
