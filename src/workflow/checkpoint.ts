import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  type Stats,
} from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  isNoFollowAtomicTempName,
  readUntrustedRegularFile,
  UntrustedFileError,
  writeFileNoFollowAtomic,
} from '../hardened-fs.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import { VERSION } from '../version.js';
import { assertSafeWorkflowId, isSafeWorkflowId, type WorkflowId, type WorkflowCheckpoint } from './types.js';

// ---------------------------------------------------------------------------
// Run directory layout
// ---------------------------------------------------------------------------

/** The checkpoint inside a run directory (`<baseDir>/<workflowId>/`). */
export const CHECKPOINT_FILENAME = 'checkpoint.json';
/** The checkpoint as it was before the latest save; read when the current one is unusable. */
export const PREVIOUS_CHECKPOINT_FILENAME = 'checkpoint.prev.json';
/** A run's default workspace, created by `start()` when the caller supplies none. */
export const RUN_WORKSPACE_DIRNAME = 'workspace';
/** Per-run staged copy of the workflow package's `skills/` tree. */
export const RUN_SKILLS_DIRNAME = 'workflow-skills';
/** Per-run staged copy of the workflow package's `scripts/` tree. */
export const RUN_SCRIPTS_DIRNAME = 'workflow-scripts';

/**
 * Files that mark a directory as one run's directory rather than a base
 * directory of runs. A base directory never holds them at its top level, so a
 * scan or import refuses a directory that does (see `checkpoint-selection.ts`).
 */
export const RUN_DIRECTORY_MARKERS: readonly string[] = [CHECKPOINT_FILENAME, 'definition.json', 'messages.jsonl'];

// ---------------------------------------------------------------------------
// Format versions
// ---------------------------------------------------------------------------

/**
 * Version of the `checkpoint.json` format this build writes and the newest it
 * reads. 1 is the unversioned format of earlier releases; 2 adds
 * `schemaVersion`/`writerVersion` and `runDir`. Bump it whenever a change would
 * be misread by the current reader, and add the migration in `load`.
 */
export const CHECKPOINT_SCHEMA_VERSION = 2;

/** Version an unversioned run file is read as. */
const LEGACY_SCHEMA_VERSION = 1;

/**
 * A checkpoint or run definition copy was written in a format newer than this
 * build reads. Refused instead of misread: an older reader would otherwise
 * report a healthy run as corrupted, or silently drop the fields it does not
 * know (budget caps, for one). `code` is the discriminant for other modules.
 */
export class WorkflowRunFileTooNewError extends Error {
  readonly code = 'WORKFLOW_CHECKPOINT_TOO_NEW' as const;

  constructor(
    readonly path: string,
    readonly schemaVersion: number,
    readonly supportedVersion: number,
    readonly writerVersion: string | undefined,
  ) {
    const writer = writerVersion === undefined ? 'a newer IronCurtain' : `IronCurtain ${writerVersion}`;
    super(
      `${path} was written by ${writer} in format version ${schemaVersion}; this IronCurtain (${VERSION}) reads ` +
        `format ${supportedVersion} and older. Resume the run with that version or a newer one.`,
    );
    this.name = 'WorkflowRunFileTooNewError';
  }
}

export function isWorkflowRunFileTooNewError(err: unknown): err is WorkflowRunFileTooNewError {
  return err instanceof Error && 'code' in err && err.code === 'WORKFLOW_CHECKPOINT_TOO_NEW';
}

/**
 * Returns the format version of a parsed run file: absent means the legacy
 * unversioned format. A version newer than `supported` throws
 * {@link WorkflowRunFileTooNewError}; anything that is not a positive integer
 * is a malformed file.
 */
export function readRunFileSchemaVersion(
  path: string,
  parsed: Readonly<Record<string, unknown>>,
  supported: number,
): number {
  const version = parsed.schemaVersion;
  if (version === undefined) return LEGACY_SCHEMA_VERSION;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    throw new Error(`${path} has an invalid schemaVersion: ${JSON.stringify(version)}`);
  }
  if (version > supported) {
    const writer = parsed.writerVersion;
    throw new WorkflowRunFileTooNewError(path, version, supported, typeof writer === 'string' ? writer : undefined);
  }
  return version;
}

// ---------------------------------------------------------------------------
// Resumability predicate
// ---------------------------------------------------------------------------

/**
 * Resumable iff not completed. `finalStatus` is undefined for mid-run and
 * pre-B3b legacy checkpoints — both correctly resolve to `true`.
 *
 * Co-located with `WorkflowCheckpoint` storage so other modules can import
 * the predicate without pulling in CLI / session dependencies.
 */
export function isCheckpointResumable(cp: WorkflowCheckpoint): boolean {
  return cp.finalStatus?.phase !== 'completed';
}

// ---------------------------------------------------------------------------
// Run-local path rebasing
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `child` relative to `parent` when `child` is `parent` or inside it, else undefined (lexical). */
function relativeInside(parent: string, child: string): string | undefined {
  if (!isAbsolute(child)) return undefined;
  const rel = relative(parent, resolve(child));
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return rel;
}

/**
 * The run directory a checkpoint's paths were recorded against. Format 2
 * records it (`runDir`). Format 1 did not, but its run-local paths have a
 * fixed shape: the default workspace is `<runDir>/workspace` and the staged
 * trees are `<runDir>/workflow-skills|scripts`, where `<runDir>` is named after
 * the workflow id. The id is minted when the run starts, after any
 * user-chosen workspace already exists, so a user workspace never has that
 * shape by accident.
 */
function recordedRunDirOf(checkpoint: WorkflowCheckpoint, workflowId: WorkflowId): string | undefined {
  if (typeof checkpoint.runDir === 'string' && isAbsolute(checkpoint.runDir)) return resolve(checkpoint.runDir);
  const candidates: ReadonlyArray<readonly [string | undefined, string]> = [
    [checkpoint.workspacePath, RUN_WORKSPACE_DIRNAME],
    [checkpoint.workflowSkillsDir, RUN_SKILLS_DIRNAME],
    [checkpoint.workflowScriptsDir, RUN_SCRIPTS_DIRNAME],
  ];
  for (const [value, name] of candidates) {
    if (typeof value !== 'string' || !isAbsolute(value)) continue;
    const absolute = resolve(value);
    if (basename(absolute) === name && basename(dirname(absolute)) === workflowId) return dirname(absolute);
  }
  return undefined;
}

/**
 * Moves a checkpoint's run-local paths onto the run directory the run was
 * actually found in. A run directory travels as a unit (a moved
 * `IRONCURTAIN_HOME`, a restored backup, an imported external run), but the
 * checkpoint records absolute paths: resuming with them would recreate the
 * old location and continue in an empty workspace. Every path inside the
 * recorded run directory (see {@link recordedRunDirOf}) is rebased onto
 * `runDir`; paths outside it (a user-chosen `--workspace`) are kept, and
 * resume re-validates those. Rebasing can only ever move a path INTO `runDir`.
 * Returns the checkpoint unchanged when nothing moved.
 */
export function rebaseRunLocalPaths(
  checkpoint: WorkflowCheckpoint,
  workflowId: WorkflowId,
  runDir: string,
): WorkflowCheckpoint {
  const target = resolve(runDir);
  const recorded = recordedRunDirOf(checkpoint, workflowId);
  if (recorded === undefined || recorded === target) return checkpoint;

  const rebase = (value: string): string => {
    const rel = relativeInside(recorded, value);
    return rel === undefined ? value : resolve(target, rel);
  };
  const context = checkpoint.context as unknown;
  let rebasedContext = checkpoint.context;
  if (isPlainObject(context) && isPlainObject(context.artifacts)) {
    const artifacts: Record<string, string> = {};
    for (const [name, value] of Object.entries(context.artifacts)) {
      if (typeof value === 'string') artifacts[name] = rebase(value);
    }
    rebasedContext = { ...checkpoint.context, artifacts };
  }
  return {
    ...checkpoint,
    runDir: target,
    context: rebasedContext,
    ...(checkpoint.workspacePath !== undefined ? { workspacePath: rebase(checkpoint.workspacePath) } : {}),
    ...(checkpoint.workflowSkillsDir !== undefined ? { workflowSkillsDir: rebase(checkpoint.workflowSkillsDir) } : {}),
    ...(checkpoint.workflowScriptsDir !== undefined
      ? { workflowScriptsDir: rebase(checkpoint.workflowScriptsDir) }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/** A loaded checkpoint and where it came from. */
export interface LoadedCheckpointRecord {
  readonly checkpoint: WorkflowCheckpoint;
  /**
   * True when `checkpoint.json` was unusable (truncated, garbled, unreadable)
   * and the copy saved before it was returned instead. That copy is one
   * transition older; anything the damaged file referenced (a newer
   * snapshot image, say) is unknown, so destructive callers treat the run
   * as unreadable.
   */
  readonly recoveredFromPrevious: boolean;
}

/** Persistent storage for workflow checkpoints. */
export interface CheckpointStore {
  /** Save a checkpoint. Overwrites any previous checkpoint for this workflow. */
  save(workflowId: WorkflowId, checkpoint: WorkflowCheckpoint): void;

  /** Load the most recent checkpoint for a workflow. Returns undefined if none exists. */
  load(workflowId: WorkflowId): WorkflowCheckpoint | undefined;

  /**
   * Like {@link load}, also reporting whether a damaged checkpoint was
   * recovered from its previous copy. Optional for custom stores.
   */
  loadRecord?(workflowId: WorkflowId): LoadedCheckpointRecord | undefined;

  /** List workflow IDs that have checkpoints (for resume discovery). */
  listAll(): WorkflowId[];

  /** Remove a checkpoint (on workflow completion or abort). */
  remove(workflowId: WorkflowId): void;
}

// ---------------------------------------------------------------------------
// File-based implementation
// ---------------------------------------------------------------------------

/** Checkpoints hold the task text and agent output: owner-only. */
const CHECKPOINT_FILE_MODE = 0o600;
/** Upper bound on one checkpoint read; far above any real run's history. */
const MAX_CHECKPOINT_BYTES = 128 * 1024 * 1024;
/** A temporary file this old is a crashed writer's leftover, never a write in progress. */
const STALE_TEMP_FILE_AGE_MS = 10 * 60 * 1000;
/** Temporary names of the pre-versioning writer (`checkpoint.tmp.<uuid>`). */
const LEGACY_TEMP_NAME_RE = /^checkpoint\.tmp\.[0-9a-f-]{36}$/u;
/** Temporary hard link that becomes `checkpoint.prev.json`. */
const PREVIOUS_TEMP_PREFIX = `.${PREVIOUS_CHECKPOINT_FILENAME}.`;
const PREVIOUS_TEMP_NAME_RE = /^\.checkpoint\.prev\.json\.[0-9a-f]{16}\.tmp$/u;

export interface FileCheckpointStoreOptions {
  /**
   * Receives a warning when a damaged checkpoint is recovered from its
   * previous copy. Defaults to stderr, bypassing any console redirection,
   * with the text rendered safe for a terminal: it quotes the parse error,
   * which carries a snippet of the damaged file.
   */
  readonly warn?: (message: string) => void;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Minimal structural check of a parsed checkpoint; resume validates the rest. */
function assertCheckpointShape(path: string, value: unknown): asserts value is WorkflowCheckpoint {
  const problem = ((): string | undefined => {
    if (!isPlainObject(value)) return 'not a JSON object';
    if (value.machineState === undefined || value.machineState === null) return 'machineState is missing';
    if (!isPlainObject(value.context)) return 'context is missing';
    if (typeof value.timestamp !== 'string') return 'timestamp is missing';
    if (!Array.isArray(value.transitionHistory)) return 'transitionHistory is missing';
    if (typeof value.definitionPath !== 'string') return 'definitionPath is missing';
    for (const key of ['workspacePath', 'workflowSkillsDir', 'workflowScriptsDir', 'runDir', 'writerVersion']) {
      if (value[key] !== undefined && typeof value[key] !== 'string') return `${key} is not a string`;
    }
    if (value.containerSnapshots !== undefined) {
      if (!isPlainObject(value.containerSnapshots)) return 'containerSnapshots is not an object';
      for (const snapshot of Object.values(value.containerSnapshots)) {
        if (!isPlainObject(snapshot) || typeof snapshot.image !== 'string') return 'containerSnapshots is malformed';
      }
    }
    if (value.finalStatus !== undefined && !isPlainObject(value.finalStatus)) return 'finalStatus is not an object';
    if (value.usageSettlementPending !== undefined && typeof value.usageSettlementPending !== 'boolean') {
      return 'usageSettlementPending is not a boolean';
    }
    return undefined;
  })();
  if (problem !== undefined) throw new Error(`${path} is not a valid checkpoint: ${problem}`);
}

/**
 * Reads one checkpoint file without following a symlink and without reading
 * more than the cap, then parses, version-checks and shape-checks it. Returns
 * undefined only when nothing exists at the path.
 */
function readCheckpointFile(path: string): WorkflowCheckpoint | undefined {
  let bytes: Buffer;
  try {
    ({ bytes } = readUntrustedRegularFile(path, { maxBytes: MAX_CHECKPOINT_BYTES }));
  } catch (err) {
    if (err instanceof UntrustedFileError && err.code === 'NOT_FOUND') return undefined;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (err) {
    throw new Error(`${path} is not valid JSON (${bytes.length} bytes): ${messageOf(err)}`, { cause: err });
  }
  if (isPlainObject(parsed)) readRunFileSchemaVersion(path, parsed, CHECKPOINT_SCHEMA_VERSION);
  assertCheckpointShape(path, parsed);
  return parsed;
}

/** True when `path` holds a checkpoint this build reads (see {@link readCheckpointFile}). */
function isSoundCheckpointFile(path: string): boolean {
  try {
    return readCheckpointFile(path) !== undefined;
  } catch {
    return false;
  }
}

/** What `lstat` reports about a file, enough to tell whether it changed since. */
interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

function identityOf(stats: Stats): FileIdentity {
  return { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs };
}

function hasIdentity(stats: Stats, identity: FileIdentity | undefined): boolean {
  return (
    identity !== undefined &&
    stats.dev === identity.dev &&
    stats.ino === identity.ino &&
    stats.size === identity.size &&
    stats.mtimeMs === identity.mtimeMs &&
    stats.ctimeMs === identity.ctimeMs
  );
}

/**
 * File-based checkpoint store. Each workflow gets a directory at
 * `{baseDir}/{workflowId}/` holding `checkpoint.json` and, after the second
 * save, `checkpoint.prev.json`.
 *
 * A save is durable and atomic: the bytes go to an exclusively created
 * temporary file that is fsynced and renamed over `checkpoint.json`, and the
 * directory is fsynced after the rename, so a crash or power loss leaves
 * either the old or the new checkpoint, complete. The temporary file is
 * removed on every failure path, and temporary files a crashed process left
 * behind are swept on the run's first save. Before the rename the current
 * checkpoint is kept as `checkpoint.prev.json` (a hard link, or a copy where
 * links are unsupported), and `load` falls back to it when `checkpoint.json`
 * is unusable. Only a sound checkpoint ever becomes the previous copy, so a
 * damaged `checkpoint.json` never displaces the last good one.
 *
 * Workflow ids are checked to be single safe path segments, so no id can
 * read or write outside the base directory. Every save stamps
 * `schemaVersion`/`writerVersion`, and a checkpoint from a newer format is
 * refused with {@link WorkflowRunFileTooNewError} (never silently replaced by
 * the previous copy).
 */
export class FileCheckpointStore implements CheckpointStore {
  private readonly warn: (message: string) => void;
  /** Runs whose directory was swept for stale temporary files by this store. */
  private readonly sweptRuns = new Set<WorkflowId>();
  /**
   * Damaged checkpoints already reported, so a listing that reloads every
   * run (the web UI's past runs, on each refresh) warns once per file.
   */
  private readonly reportedRecoveries = new Set<string>();
  /**
   * Identity of the `checkpoint.json` this store last wrote, per run. A file
   * that still has it is the sound checkpoint written then and may become
   * the previous copy without being read again; any other file is checked
   * first (see `keepPreviousCopy`).
   */
  private readonly lastWritten = new Map<WorkflowId, FileIdentity>();

  constructor(
    private readonly baseDir: string,
    options: FileCheckpointStoreOptions = {},
  ) {
    this.warn = options.warn ?? ((message) => process.stderr.write(`${toDisplayText(message)}\n`));
  }

  save(workflowId: WorkflowId, checkpoint: WorkflowCheckpoint): void {
    const runDir = this.runDirFor(workflowId);
    mkdirSync(runDir, { recursive: true });
    // The run directory belongs to whoever owns the base directory (an agent
    // reaches only the workspace inside it), so a symlinked one (moved to a
    // larger disk, say) is followed. Only the checkpoint names themselves are
    // never followed.
    const dir = realpathSync(runDir);

    // Stamp the format first so it leads the file; the caller's own copy of
    // these fields (a checkpoint loaded earlier) never overrides the stamp.
    const record: Record<string, unknown> = { schemaVersion: CHECKPOINT_SCHEMA_VERSION, writerVersion: VERSION };
    for (const [key, value] of Object.entries(checkpoint)) {
      if (key !== 'schemaVersion' && key !== 'writerVersion') record[key] = value;
    }
    const content = JSON.stringify(record, null, 2);

    this.keepPreviousCopy(workflowId, dir);
    writeFileNoFollowAtomic(dir, CHECKPOINT_FILENAME, content, CHECKPOINT_FILE_MODE);
    try {
      this.lastWritten.set(workflowId, identityOf(lstatSync(resolve(dir, CHECKPOINT_FILENAME))));
    } catch {
      this.lastWritten.delete(workflowId);
    }
    this.reportedRecoveries.delete(resolve(runDir, CHECKPOINT_FILENAME));
    if (!this.sweptRuns.has(workflowId)) {
      this.sweptRuns.add(workflowId);
      removeStaleTempFiles(dir);
    }
  }

  load(workflowId: WorkflowId): WorkflowCheckpoint | undefined {
    return this.loadRecord(workflowId)?.checkpoint;
  }

  loadRecord(workflowId: WorkflowId): LoadedCheckpointRecord | undefined {
    const dir = this.runDirFor(workflowId);
    const currentPath = resolve(dir, CHECKPOINT_FILENAME);
    let current: WorkflowCheckpoint | undefined;
    try {
      current = readCheckpointFile(currentPath);
    } catch (err) {
      // A newer format is not damage: falling back would resume an older
      // state behind the newer writer's back.
      if (isWorkflowRunFileTooNewError(err)) throw err;
      const previousPath = resolve(dir, PREVIOUS_CHECKPOINT_FILENAME);
      let previous: WorkflowCheckpoint | undefined;
      try {
        previous = readCheckpointFile(previousPath);
      } catch (previousErr) {
        if (isWorkflowRunFileTooNewError(previousErr)) throw previousErr;
      }
      if (previous === undefined) throw err;
      if (!this.reportedRecoveries.has(currentPath)) {
        this.reportedRecoveries.add(currentPath);
        this.warn(
          `[workflow] Checkpoint ${currentPath} is unusable (${messageOf(err)}); ` +
            `using the previous checkpoint ${previousPath} from ${previous.timestamp}.`,
        );
      }
      return { checkpoint: previous, recoveredFromPrevious: true };
    }
    return current === undefined ? undefined : { checkpoint: current, recoveredFromPrevious: false };
  }

  listAll(): WorkflowId[] {
    if (!existsSync(this.baseDir)) return [];

    const entries = readdirSync(this.baseDir, { withFileTypes: true });
    const ids: WorkflowId[] = [];
    for (const entry of entries) {
      // A directory whose name is not a safe id was not created by a run
      // and could never be loaded; skip it rather than fail the listing.
      if (!entry.isDirectory() || !isSafeWorkflowId(entry.name)) continue;
      if (existsSync(resolve(this.baseDir, entry.name, CHECKPOINT_FILENAME))) {
        ids.push(entry.name);
      }
    }
    return ids;
  }

  remove(workflowId: WorkflowId): void {
    const dir = this.runDirFor(workflowId);
    this.lastWritten.delete(workflowId);
    // `force` ignores only a missing file; any other failure propagates.
    rmSync(resolve(dir, CHECKPOINT_FILENAME), { force: true });
    rmSync(resolve(dir, PREVIOUS_CHECKPOINT_FILENAME), { force: true });
  }

  private runDirFor(workflowId: WorkflowId): string {
    return resolve(this.baseDir, assertSafeWorkflowId(workflowId));
  }

  /**
   * Keeps the checkpoint about to be replaced as `checkpoint.prev.json`. A
   * hard link costs nothing and keeps `checkpoint.json` in place throughout,
   * so a concurrent reader never finds it missing; where the filesystem has
   * no hard links the bytes are copied. Best effort: a failure here never
   * blocks the save.
   *
   * Only a sound checkpoint replaces the previous copy: the file this store
   * wrote last (same identity), or one that reads as a checkpoint. A
   * damaged file (truncated, garbled, empty: the remnant of a crash, or of
   * the full disk that also fails saves) is left out, because the previous
   * copy is then the only good checkpoint, the one resume recovered from,
   * and replacing it would leave nothing to recover from if this save
   * failed as well.
   */
  private keepPreviousCopy(workflowId: WorkflowId, dir: string): void {
    const currentPath = resolve(dir, CHECKPOINT_FILENAME);
    let stats: Stats;
    try {
      stats = lstatSync(currentPath);
    } catch {
      return; // first save, or nothing usable to keep
    }
    if (!stats.isFile() || stats.size === 0) return;
    if (!hasIdentity(stats, this.lastWritten.get(workflowId)) && !isSoundCheckpointFile(currentPath)) return;
    const temporary = resolve(dir, `${PREVIOUS_TEMP_PREFIX}${randomBytes(8).toString('hex')}.tmp`);
    try {
      linkSync(currentPath, temporary);
      renameSync(temporary, resolve(dir, PREVIOUS_CHECKPOINT_FILENAME));
      return;
    } catch {
      rmSync(temporary, { force: true });
    }
    try {
      const { bytes } = readUntrustedRegularFile(currentPath, { maxBytes: MAX_CHECKPOINT_BYTES });
      writeFileNoFollowAtomic(dir, PREVIOUS_CHECKPOINT_FILENAME, bytes, CHECKPOINT_FILE_MODE);
    } catch (err) {
      this.warn(`[workflow] Could not keep the previous checkpoint in ${dir}: ${messageOf(err)}`);
    }
  }
}

/**
 * Removes temporary files that a writer killed mid-save left in a run
 * directory: ours (`writeFileNoFollowAtomic`'s and the previous-copy link)
 * and the pre-versioning writer's `checkpoint.tmp.<uuid>`. Only files older
 * than {@link STALE_TEMP_FILE_AGE_MS} are touched, so a save in progress in
 * another process is never disturbed.
 */
function removeStaleTempFiles(dir: string, nowMs = Date.now()): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!isNoFollowAtomicTempName(name) && !LEGACY_TEMP_NAME_RE.test(name) && !PREVIOUS_TEMP_NAME_RE.test(name)) {
      continue;
    }
    const path = resolve(dir, name);
    try {
      const stats = lstatSync(path);
      if (!stats.isFile() || nowMs - stats.mtimeMs < STALE_TEMP_FILE_AGE_MS) continue;
      unlinkSync(path);
    } catch {
      // Already gone, or not ours to remove.
    }
  }
}
