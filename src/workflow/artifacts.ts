import {
  readFileSync,
  mkdirSync,
  existsSync,
  lstatSync,
  opendirSync,
  realpathSync,
  type Dir,
  type Dirent,
  type Stats,
} from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import {
  appendRegularFileNoFollow,
  copyRegularFileBelow,
  displaceEntryNoFollow,
  ensureDirectoryBelow,
  ensureRealDirectoryNoFollow,
  readUntrustedRegularFile,
  UntrustedFileError,
  writeFileNoFollowAtomic,
  type EnsureRealDirectoryResult,
  type UntrustedFileErrorCode,
} from '../hardened-fs.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import { WORKFLOW_ARTIFACT_DIR, type WorkflowId } from './types.js';

// ---------------------------------------------------------------------------
// Shared filesystem helpers (used by orchestrator, prompt-builder, and manager)
//
// Everything below `<workspace>/.workflow/` is written by agents, and in Docker
// mode the workspace is a read-write bind mount: an agent can plant a symlink
// (to `/`, to a host home directory), a FIFO or a device link at any name, and
// can swap entries while the host looks at them. The walkers here therefore
// never follow symlinks, never open anything, tolerate entries that vanish
// mid-walk, and stop after a bounded number of entries and levels, so a hostile
// tree costs the host at most a bounded synchronous walk.
// ---------------------------------------------------------------------------

export interface CollectedFile {
  /** Path relative to the root directory, using forward slashes. */
  readonly relativePath: string;
  /** Absolute path on disk. */
  readonly fullPath: string;
}

/** Bounds for one synchronous walk of an agent-writable tree. */
export interface WalkLimits {
  /** Directory entries (of any type) examined before the walk stops. */
  readonly maxEntries: number;
  /** Directory levels below the root the walk descends into. */
  readonly maxDepth: number;
}

/** Bounds for walking one `.workflow/<output>` artifact directory. */
export const ARTIFACT_WALK_LIMITS: WalkLimits = { maxEntries: 100_000, maxDepth: 64 };

export interface WalkVisitor {
  /** Called for each regular file with its lstat. Return true to stop the walk. */
  file(fullPath: string, stats: Stats): boolean;
  /** Return false to skip a subdirectory (its own entry still counts against the budget). */
  enterDirectory?(fullPath: string, name: string): boolean;
}

export interface WalkOutcome {
  /** True when an entry or depth limit cut the walk short, so the visit was partial. */
  readonly truncated: boolean;
  /** True when the visitor asked to stop. */
  readonly stopped: boolean;
}

/**
 * Walks the tree under `root` without following symlinks: every entry is
 * lstat-ed, only real subdirectories are entered, and only regular files reach
 * the visitor (symlinks, FIFOs, sockets and devices are skipped, never opened).
 * Entries that vanish, change type or become unreadable mid-walk are skipped,
 * so a concurrent writer cannot fail the walk. Directories are read
 * incrementally (`opendir`), so `limits.maxEntries` bounds the work even for a
 * directory with millions of entries.
 *
 * `root` itself is opened as given: callers pass a trusted root or check it
 * first (see {@link resolveArtifactOutputDir}). A missing or unreadable root is
 * an empty walk.
 */
export function walkTreeNoFollow(root: string, limits: WalkLimits, visitor: WalkVisitor): WalkOutcome {
  let remaining = limits.maxEntries;
  let truncated = false;
  let stopped = false;

  const walkLevel = (dir: string, depth: number): void => {
    let handle: Dir;
    try {
      handle = opendirSync(dir);
    } catch {
      return; // Removed, replaced by a non-directory, or unreadable: skip it.
    }
    try {
      while (!stopped) {
        let entry: Dirent | null;
        try {
          entry = handle.readSync();
        } catch {
          return;
        }
        if (entry === null) return;
        if (remaining <= 0) {
          truncated = true;
          return;
        }
        remaining--;

        const fullPath = resolve(dir, entry.name);
        let stats: Stats;
        try {
          stats = lstatSync(fullPath);
        } catch {
          continue; // Deleted or made unreadable between readdir and lstat.
        }
        if (stats.isDirectory()) {
          if (visitor.enterDirectory && !visitor.enterDirectory(fullPath, entry.name)) continue;
          if (depth >= limits.maxDepth) {
            truncated = true;
            continue;
          }
          walkLevel(fullPath, depth + 1);
        } else if (stats.isFile() && visitor.file(fullPath, stats)) {
          stopped = true;
        }
      }
    } finally {
      handle.closeSync();
    }
  };

  walkLevel(root, 0);
  return { truncated, stopped };
}

/** lstat-based type of the entry at `path`, never following a final symlink. */
function entryKind(path: string): 'absent' | 'directory' | 'file' | 'symlink' | 'other' {
  let stats: Stats;
  try {
    stats = lstatSync(path);
  } catch {
    return 'absent';
  }
  if (stats.isSymbolicLink()) return 'symlink';
  if (stats.isDirectory()) return 'directory';
  return stats.isFile() ? 'file' : 'other';
}

/**
 * Recursively walks a directory and returns all regular files (not directories
 * or symlinks). Results are sorted by relative path for deterministic ordering.
 * A root that is missing, a symlink or not a directory yields no files, and the
 * walk is bounded by {@link ARTIFACT_WALK_LIMITS} (a partial list past them).
 */
export function collectFilesRecursive(dir: string): CollectedFile[] {
  if (entryKind(dir) !== 'directory') return [];

  const results: CollectedFile[] = [];
  walkTreeNoFollow(dir, ARTIFACT_WALK_LIMITS, {
    file: (fullPath) => {
      results.push({ relativePath: relative(dir, fullPath).split(sep).join('/'), fullPath });
      return false;
    },
  });
  results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return results;
}

/**
 * Recursively checks whether a directory contains any regular files.
 * More efficient than collectFilesRecursive when you only need a boolean.
 * A root that is a symlink or not a directory has no files, and a tree with no
 * regular file within {@link ARTIFACT_WALK_LIMITS} counts as empty.
 */
export function hasAnyFiles(dir: string): boolean {
  if (entryKind(dir) !== 'directory') return false;
  return walkTreeNoFollow(dir, ARTIFACT_WALK_LIMITS, { file: () => true }).stopped;
}

/** Entries of an artifact root examined by {@link listArtifactOutputNames} before it stops. */
export const ARTIFACT_LISTING_MAX_ENTRIES = 10_000;

/** The artifact output directories found by {@link listArtifactOutputNames}. */
export type ArtifactOutputListing =
  | { readonly kind: 'missing' }
  /** The root is a symlink, a file or another non-directory: not followed, not listed. */
  | { readonly kind: 'not_directory' }
  | {
      readonly kind: 'ok';
      /** Sorted. */
      readonly names: readonly string[];
      /** True when the entry limit cut the listing short. */
      readonly truncated: boolean;
    };

/**
 * Names of the artifact output directories directly under `artifactDir` (a
 * workspace's `.workflow`), for display. The tree is agent-writable, so
 * nothing is followed: a root that is not a real directory is not listed, and
 * inside it only real directories count (symlinks, dangling or not, files and
 * other entries are skipped, as are entries that vanish mid-listing). At most
 * `maxEntries` entries are examined.
 */
export function listArtifactOutputNames(
  artifactDir: string,
  maxEntries = ARTIFACT_LISTING_MAX_ENTRIES,
): ArtifactOutputListing {
  const kind = entryKind(artifactDir);
  if (kind === 'absent') return { kind: 'missing' };
  if (kind !== 'directory') return { kind: 'not_directory' };

  const names: string[] = [];
  const outcome = walkTreeNoFollow(
    artifactDir,
    { maxEntries, maxDepth: 0 },
    {
      file: () => false,
      enterDirectory: (_fullPath, name) => {
        names.push(name);
        return false;
      },
    },
  );
  names.sort();
  return { kind: 'ok', names, truncated: outcome.truncated };
}

// ---------------------------------------------------------------------------
// Contained artifact roots
// ---------------------------------------------------------------------------

/** Why an artifact output directory was refused (see {@link resolveArtifactOutputDir}). */
export type ArtifactDirRejection = 'invalid_name' | 'symlink' | 'outside_workspace';

export type ArtifactDirCheck =
  | { readonly kind: 'ok'; readonly dir: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'rejected'; readonly reason: ArtifactDirRejection; readonly path: string };

function isCanonicalPathWithin(candidate: string, root: string): boolean {
  if (root === sep) return candidate.startsWith(sep);
  return candidate === root || candidate.startsWith(root + sep);
}

/**
 * Resolves the directory of artifact output `name` (`<artifactDir>/<name>`)
 * for a host-side walk, refusing anything an agent could use to point the host
 * elsewhere. The artifact root (`.workflow` itself) and every component of
 * `name` must lstat as a real directory, and the result's realpath must lie
 * inside the workspace's realpath:
 *
 * - `ok`: safe to walk.
 * - `missing`: absent, or not a directory (an agent that wrote a file where a
 *   directory belongs simply has not produced the artifact).
 * - `rejected`: a symlink at the root or any component (`.workflow/plan -> /`),
 *   a directory that resolves outside the workspace, or an output name that is
 *   not a plain relative path. Callers treat it as missing and should report
 *   it as a security event.
 *
 * The usual no-`openat` caveat applies: an entry swapped right after this
 * check is not detected, which the walkers' entry and depth caps bound.
 */
export function resolveArtifactOutputDir(workspacePath: string, artifactDir: string, name: string): ArtifactDirCheck {
  const segments = name.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..' || s.includes('\\') || s.includes('\0'))) {
    return { kind: 'rejected', reason: 'invalid_name', path: name };
  }

  // `.workflow` itself first, then each component of the output name.
  let dir = artifactDir;
  const chain = [artifactDir];
  for (const segment of segments) {
    dir = join(dir, segment);
    chain.push(dir);
  }
  for (const path of chain) {
    const kind = entryKind(path);
    if (kind === 'symlink') return { kind: 'rejected', reason: 'symlink', path };
    if (kind !== 'directory') return { kind: 'missing' };
  }

  let realDir: string;
  let realWorkspace: string;
  try {
    realDir = realpathSync(dir);
    realWorkspace = realpathSync(workspacePath);
  } catch {
    return { kind: 'missing' };
  }
  if (!isCanonicalPathWithin(realDir, realWorkspace)) {
    return { kind: 'rejected', reason: 'outside_workspace', path: dir };
  }
  return { kind: 'ok', dir };
}

// ---------------------------------------------------------------------------
// Workspace setup (`.workflow/`, the task description, `.gitignore`)
// ---------------------------------------------------------------------------

const TASK_DIR_NAME = 'task';
const TASK_DESCRIPTION_FILE = 'description.md';
/** Readable by the agent whatever uid the container maps it to; never group/world writable. */
const TASK_DESCRIPTION_MODE = 0o644;
/** A `.gitignore` larger than this is left alone instead of read or appended to. */
export const GITIGNORE_MAX_BYTES = 1024 * 1024;
const GITIGNORE_MODE = 0o644;

export interface PreparedArtifactDir {
  /** `<workspace>/.workflow`, through the workspace's canonical path. */
  readonly artifactDir: string;
  /** One line per agent-planted entry that had to be moved aside or replaced. */
  readonly warnings: readonly string[];
}

function noteDisplaced(result: EnsureRealDirectoryResult, warnings: string[]): void {
  if (result.displacedTo !== undefined) {
    warnings.push(`${result.path} was not a real directory; moved it aside to ${result.displacedTo}`);
  }
}

/**
 * Creates (or re-validates) the workflow-owned `.workflow/` and `.workflow/task/`
 * directories in a possibly reused, agent-writable workspace, and (re)writes
 * `.workflow/task/description.md`.
 *
 * Nothing already at those names is followed or written through: a symlink,
 * FIFO or other non-directory at `.workflow` or `.workflow/task` is moved
 * aside before the directory is created, and the description is written to a
 * fresh exclusive temporary file renamed over the name (so a symlink, FIFO or
 * hard link there is replaced, never opened). A directory squatting on the
 * description's name is moved aside too. Each of these is reported in
 * `warnings`. Throws {@link UntrustedFileError} if an entry keeps changing.
 */
export function prepareWorkflowArtifactDir(workspacePath: string, taskDescription: string): PreparedArtifactDir {
  const warnings: string[] = [];
  const workspaceRoot = realpathSync(workspacePath);

  const artifact = ensureRealDirectoryNoFollow(workspaceRoot, WORKFLOW_ARTIFACT_DIR);
  noteDisplaced(artifact, warnings);
  const task = ensureRealDirectoryNoFollow(artifact.path, TASK_DIR_NAME);
  noteDisplaced(task, warnings);

  const descriptionPath = join(task.path, TASK_DESCRIPTION_FILE);
  const existing = entryKind(descriptionPath);
  if (existing === 'directory') {
    const displaced = displaceEntryNoFollow(task.path, TASK_DESCRIPTION_FILE);
    if (displaced !== undefined) warnings.push(`${descriptionPath} was a directory; moved it aside to ${displaced}`);
  } else if (existing === 'symlink' || existing === 'other') {
    const what = existing === 'symlink' ? 'a symbolic link' : 'a special file';
    warnings.push(`${descriptionPath} was ${what}; replaced it without following it`);
  }
  writeFileNoFollowAtomic(task.path, TASK_DESCRIPTION_FILE, taskDescription, TASK_DESCRIPTION_MODE);

  return { artifactDir: artifact.path, warnings };
}

/**
 * Makes each workspace-relative directory in `writablePaths` (a read-only
 * state's `.workflow/<output>` directories, see `src/workflow/workspace-access.ts`)
 * a real directory below the workspace before the state's session or bundle
 * starts, and returns one warning per agent-planted entry moved aside.
 *
 * The state writes these directories through the filesystem MCP tool, whose
 * policy check resolves every path it is given: a component an earlier,
 * read-write state left as a symlink (`.workflow/reviews -> ../src`) would make
 * every write there resolve elsewhere and be denied. Each component is
 * therefore made a real directory with `ensureRealDirectoryNoFollow`, walking
 * down from the workspace root: a symlink or file at a name is moved aside,
 * never followed, and the directories are created with the host's own
 * permissions. Throws {@link UntrustedFileError} if an entry keeps changing.
 * Every path must be a plain relative path (validated with the definition).
 */
export function prepareWritableOutputDirs(workspacePath: string, writablePaths: readonly string[]): string[] {
  const warnings: string[] = [];
  const workspaceRoot = realpathSync(workspacePath);
  for (const writablePath of writablePaths) {
    let parent = workspaceRoot;
    for (const component of writablePath.split('/')) {
      const result = ensureRealDirectoryNoFollow(parent, component);
      noteDisplaced(result, warnings);
      parent = result.path;
    }
  }
  return warnings;
}

export type WorkflowGitignoreResult =
  | { readonly status: 'already_listed' | 'appended' | 'created' }
  | { readonly status: 'skipped'; readonly reason: string };

function untrustedFileErrorCode(error: unknown): UntrustedFileErrorCode | undefined {
  return error instanceof UntrustedFileError ? error.code : undefined;
}

function gitignoreSkipReason(code: UntrustedFileErrorCode, error: unknown): string {
  switch (code) {
    case 'SYMLINK':
      return 'it is a symbolic link';
    case 'NOT_REGULAR_FILE':
      return 'it is not a regular file';
    case 'HARD_LINKED':
      return 'it has more than one hard link';
    case 'TOO_LARGE':
      return `it is larger than ${GITIGNORE_MAX_BYTES} bytes`;
    case 'CHANGED':
      return 'it changed while it was being updated';
    default:
      return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Ensures the workflow artifact directory is listed in the workspace root's
 * `.gitignore`, without following, blocking on or growing without bound
 * whatever is at that name. A missing file is created exclusively; an existing
 * one must be a single-link regular file no larger than
 * {@link GITIGNORE_MAX_BYTES} and is appended to through a no-follow
 * descriptor. Anything else (a symlink to a host file or `/dev/zero`, a FIFO,
 * a hard link, an oversized file) is left untouched and reported as `skipped`
 * so the caller can warn: a missing ignore entry is a cosmetic problem, not a
 * reason to fail the run.
 */
export function ensureWorkflowGitignored(workspacePath: string): WorkflowGitignoreResult {
  const gitignorePath = join(realpathSync(workspacePath), '.gitignore');
  const dirEntry = `${WORKFLOW_ARTIFACT_DIR}/`;

  let content: string | undefined;
  try {
    content = readUntrustedRegularFile(gitignorePath, { maxBytes: GITIGNORE_MAX_BYTES }).bytes.toString('utf-8');
  } catch (error) {
    const code = untrustedFileErrorCode(error);
    if (code === undefined) throw error;
    if (code !== 'NOT_FOUND') return { status: 'skipped', reason: gitignoreSkipReason(code, error) };
  }

  if (content !== undefined) {
    const lines = content.split('\n');
    if (lines.some((line) => line.trim() === dirEntry || line.trim() === WORKFLOW_ARTIFACT_DIR)) {
      return { status: 'already_listed' };
    }
  }

  const suffix = content === undefined || content.endsWith('\n') ? '' : '\n';
  try {
    appendRegularFileNoFollow(gitignorePath, `${suffix}${dirEntry}\n`, {
      maxBytes: GITIGNORE_MAX_BYTES,
      create: content === undefined,
      mode: GITIGNORE_MODE,
    });
  } catch (error) {
    const code = untrustedFileErrorCode(error);
    if (code === undefined) throw error;
    return { status: 'skipped', reason: gitignoreSkipReason(code, error) };
  }
  return { status: content === undefined ? 'created' : 'appended' };
}

// ---------------------------------------------------------------------------
// Artifact versioning
// ---------------------------------------------------------------------------

/**
 * Copies output artifact directories to versioned backups before a state
 * is re-entered. Agents always write to the same canonical paths — versioning
 * is transparent to them.
 *
 * On the Nth visit (N > 1), each output's directory is copied to `<name>.v<N-1>`.
 * For example, the second visit creates `.v1`, the third creates `.v2`.
 *
 * Idempotency: if anything already exists at the versioned name (e.g., on
 * resume), the copy is skipped to avoid overwriting a clean snapshot with
 * corrupted data.
 *
 * The copy runs while the agent's container may still be live (a shared
 * container, a peer fan-out lane, a background process), so it is built from
 * the no-follow helpers rather than a recursive `cpSync`, which writes through
 * a symlink planted inside the half-built snapshot and so lets an agent
 * overwrite any host file with content it chose:
 *
 * - The output must pass {@link resolveArtifactOutputDir} against the trusted
 *   root (`workspacePath`, or the directory holding `artifactDir` when it is
 *   not given): a symlinked output or `.workflow` root is not copied.
 * - The source is walked with {@link walkTreeNoFollow}, and each regular file
 *   is copied by `copyRegularFileBelow`: read through a contained, no-follow,
 *   non-blocking descriptor (never a host file reached through a swapped
 *   link), written to a file created exclusively below the root and located
 *   again before any byte is written (never through anything already at the
 *   name). Symlinks, FIFOs, sockets and devices are not copied, and entries
 *   that vanish or change type mid-copy are skipped.
 * - A snapshot runs synchronously on the daemon's event loop, so it walks at
 *   most {@link SNAPSHOT_WALK_LIMITS} and copies at most
 *   {@link SNAPSHOT_MAX_BYTES} bytes (artifact outputs are documents; past the
 *   caps the snapshot is partial and reported).
 *
 * Any other failure stops that output's snapshot (leaving what was copied so
 * far) and is reported on stderr; it never aborts the run.
 */
export function snapshotArtifacts(
  artifactDir: string,
  outputs: readonly string[],
  visitNumber: number,
  unversionedArtifacts: ReadonlySet<string>,
  workspacePath?: string,
): void {
  if (visitNumber <= 1) return;

  const versionSuffix = `.v${visitNumber - 1}`;
  const root = resolve(workspacePath ?? dirname(artifactDir));
  const artifactRelative = relative(root, artifactDir).split(sep).join('/');

  for (const output of outputs) {
    if (unversionedArtifacts.has(output)) continue;

    const check = resolveArtifactOutputDir(root, artifactDir, output);
    if (check.kind !== 'ok') continue;

    const src = resolve(artifactDir, output);
    const dest = resolve(artifactDir, `${output}${versionSuffix}`);
    if (entryKind(dest) !== 'absent') continue;

    try {
      copyArtifactTree(
        root,
        check.dir,
        joinRelative(artifactRelative, output),
        joinRelative(artifactRelative, `${output}${versionSuffix}`),
      );
    } catch (err) {
      // Best-effort: a single failed copy must not abort a long-running agent run.
      // Write directly to stderr to bypass any console hijacking
      // (logger.setup() redirects console.error to a log file). The message can
      // name agent-created paths, so it is rendered terminal-safe.
      const message = toDisplayText(err instanceof Error ? err.message : String(err));
      process.stderr.write(`[workflow] snapshotArtifacts: failed to copy "${src}" to "${dest}": ${message}\n`);
    }
  }
}

/**
 * Bounds for walking one output into its snapshot. Tighter than
 * {@link ARTIFACT_WALK_LIMITS} because every file is also copied, with a
 * contained, no-follow open at each end (tens of microseconds per file).
 */
export const SNAPSHOT_WALK_LIMITS: WalkLimits = { maxEntries: 20_000, maxDepth: 64 };

/** At most this many bytes are copied into one artifact snapshot (`<name>.v<N>`). */
export const SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024;

/**
 * `copyRegularFileBelow` failures that mean the entry vanished, changed type or
 * has a name the helpers do not accept: nothing was written, so the entry is
 * skipped rather than failing the whole snapshot.
 */
const SKIPPED_SNAPSHOT_ENTRY_CODES: ReadonlySet<UntrustedFileErrorCode> = new Set<UntrustedFileErrorCode>([
  'NOT_FOUND',
  'SYMLINK',
  'NOT_REGULAR_FILE',
  'INVALID_PATH',
]);

/** Joins `/`-separated relative paths, dropping empty parts. */
function joinRelative(...parts: string[]): string {
  return parts.filter((part) => part !== '').join('/');
}

/**
 * Copies the regular files under `sourceDir` (`<root>/<sourceRelative>`, already
 * checked by {@link resolveArtifactOutputDir}) to `<root>/<destRelative>`,
 * recreating their directories. See {@link snapshotArtifacts}.
 */
function copyArtifactTree(root: string, sourceDir: string, sourceRelative: string, destRelative: string): void {
  let remainingBytes = SNAPSHOT_MAX_BYTES;
  const { truncated } = walkTreeNoFollow(sourceDir, SNAPSHOT_WALK_LIMITS, {
    file: (fullPath, stats) => {
      const relativePath = relative(sourceDir, fullPath).split(sep).join('/');
      try {
        remainingBytes -= copyRegularFileBelow(
          root,
          joinRelative(sourceRelative, relativePath),
          joinRelative(destRelative, relativePath),
          { maxBytes: remainingBytes, mode: stats.mode & 0o777, createParents: true },
        );
      } catch (error) {
        const code = untrustedFileErrorCode(error);
        if (code === 'TOO_LARGE') {
          throw new Error(`more than ${SNAPSHOT_MAX_BYTES} bytes to copy; the snapshot is partial`, { cause: error });
        }
        if (code === undefined || !SKIPPED_SNAPSHOT_ENTRY_CODES.has(code)) throw error;
      }
      return false;
    },
  });
  if (truncated) {
    throw new Error(
      `more than ${SNAPSHOT_WALK_LIMITS.maxEntries} entries or ${SNAPSHOT_WALK_LIMITS.maxDepth} levels; the snapshot is partial`,
    );
  }
  // An output without regular files still gets its (empty) snapshot directory.
  ensureDirectoryBelow(root, destRelative);
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/** Manages artifact directories and files for workflow state transitions. */
export interface ArtifactManager {
  /** Ensure the artifact directory structure exists for a workflow. Returns artifact dir path. */
  initialize(workflowId: WorkflowId): string;

  /** Read an artifact file's content. Returns undefined if not found. */
  read(workflowId: WorkflowId, artifactName: string): string | undefined;

  /** List all files in an artifact subdirectory. */
  listArtifactFiles(workflowId: WorkflowId, artifactName: string): string[];

  /** Check which expected outputs are missing. Returns list of missing artifact names. */
  findMissing(workflowId: WorkflowId, expectedOutputs: readonly string[]): string[];

  /** Compute SHA-256 hash of artifact directories' contents. Deterministic ordering. */
  computeHash(workflowId: WorkflowId, artifactNames: readonly string[]): string;
}

// ---------------------------------------------------------------------------
// File-based implementation
// ---------------------------------------------------------------------------

/**
 * File-based artifact manager. Each workflow gets an artifact directory at
 * `{baseDir}/{workflowId}/artifacts/`. Within that, each artifact name
 * maps to a subdirectory containing one or more files.
 */
export class FileArtifactManager implements ArtifactManager {
  constructor(private readonly baseDir: string) {}

  initialize(workflowId: WorkflowId): string {
    const artifactDir = this.artifactDir(workflowId);
    mkdirSync(artifactDir, { recursive: true });
    return artifactDir;
  }

  read(workflowId: WorkflowId, artifactName: string): string | undefined {
    const dir = resolve(this.artifactDir(workflowId), artifactName);
    if (!existsSync(dir)) return undefined;

    // Try convention name first, then fall back to first file
    const conventionPath = resolve(dir, `${artifactName}.md`);
    if (existsSync(conventionPath)) {
      return readFileSync(conventionPath, 'utf-8');
    }

    const files = collectFilesRecursive(dir);
    if (files.length === 0) return undefined;

    return readFileSync(files[0].fullPath, 'utf-8');
  }

  listArtifactFiles(workflowId: WorkflowId, artifactName: string): string[] {
    const dir = resolve(this.artifactDir(workflowId), artifactName);
    return collectFilesRecursive(dir).map((f) => f.relativePath);
  }

  findMissing(workflowId: WorkflowId, expectedOutputs: readonly string[]): string[] {
    const artifactDir = this.artifactDir(workflowId);
    const missing: string[] = [];

    for (const name of expectedOutputs) {
      const dir = resolve(artifactDir, name);
      if (!hasAnyFiles(dir)) {
        missing.push(name);
      }
    }

    return missing;
  }

  computeHash(workflowId: WorkflowId, artifactNames: readonly string[]): string {
    const hash = createHash('sha256');
    const artifactDir = this.artifactDir(workflowId);

    for (const name of [...artifactNames].sort()) {
      const dir = resolve(artifactDir, name);
      const files = collectFilesRecursive(dir);
      for (const file of files) {
        let stats: Stats;
        try {
          stats = lstatSync(file.fullPath);
        } catch {
          continue; // Removed after the walk listed it.
        }
        hash.update(`${file.relativePath}:${stats.size}:${stats.mtimeMs}`);
      }
    }

    return hash.digest('hex');
  }

  /** Get the artifact directory path for a workflow. */
  artifactDirFor(workflowId: WorkflowId): string {
    return this.artifactDir(workflowId);
  }

  private artifactDir(workflowId: WorkflowId): string {
    return resolve(this.baseDir, workflowId, 'artifacts');
  }
}
