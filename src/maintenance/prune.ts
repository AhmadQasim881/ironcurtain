/**
 * Retention for the IronCurtain home: `ironcurtain prune`, and the daemon's
 * automatic prune (`retention.autoPrune`, off by default).
 *
 * What may be removed, per `retention` in config.json (null keeps forever):
 *
 * - session directories `sessions/<id>/` inactive for longer than
 *   `sessions.maxAgeDays`; with `sessions.maxBytes`, also the oldest ones
 *   while the sessions together take more;
 * - workflow run directories `workflow-runs/<id>/` (checkpoint, message log,
 *   default workspace, bundle logs, captures, dependency layers), the same way
 *   (`workflowRuns`). A run that can still be resumed is removed for its age
 *   only, never to meet the size cap;
 * - cron run records `jobs/<id>/runs/*.json` beyond the newest
 *   `jobRuns.maxRecords` of each job;
 * - shared workflow dependency bases `workflow-dependency-bases/<key>/` not
 *   used for `dependencyCaches.maxUnusedDays` (the next run that needs one
 *   rebuilds it).
 *
 * Nothing else is ever touched: only entries directly under those
 * directories, named like what they hold (a session id, a workflow id, a
 * record's timestamp name, a key), and real directories, never a symlink. A
 * workspace a session or run was given (`--workspace`) lives elsewhere and is
 * never removed; nor is the legacy `workflow-deps/` cache of earlier versions,
 * which an older process may still mount (the report names it).
 *
 * Activity is the newest modification time of a directory's direct entries;
 * a time more than a day ahead is not activity (an agent can set the times of
 * its own workspace). Nothing active within the last day is removed, whatever
 * the limits.
 *
 * Kept whatever their age, and reported as kept:
 *
 * - a live session: one the calling daemon runs (`liveSessionIds`), one whose
 *   PTY registration names a live process, one whose `resume.lock` a live
 *   process holds;
 * - a live workflow run: one the calling daemon runs (`liveWorkflowIds`), or
 *   whose `run.lock` a live process holds;
 * - a session or run with an owner lease record (`run/docker-owners/`): its
 *   containers may still exist and mount its directories, so it waits until
 *   the lease is gone (a clean teardown, or `ironcurtain gc --force`). While
 *   any lease record cannot be read, no session or run is pruned at all;
 * - a directory that holds a workspace still in use: the workspace a kept
 *   session or run records, or a cron job's workspace;
 * - a session of a workflow run that is kept (its audit log belongs to the run);
 * - a dependency base that a layer of a kept workflow run was seeded from, or
 *   whose provisioning lock is held;
 * - anything that cannot be inspected (fail closed). When the owner leases,
 *   the PTY registry, the cron jobs, or either of the sessions and runs
 *   directories cannot be read, no session or run is judged: they work in
 *   each other's directories.
 *
 * Removing a session or run directory first takes its own lock
 * (`resume.lock`, `run.lock`) the way a resume would, so a resume cannot start
 * on it meanwhile, then renames it aside to a dot-named tombstone (no scan
 * treats that as a session or run) and deletes the tombstone. A tombstone a
 * crash left behind is removed by the next prune. Sessions and runs go in an
 * order where whatever would keep an entry (its workflow run, an entry using a
 * workspace inside it) is handled first: when that one stays after all (a
 * resume took its lock after the prune planned), it keeps the entry too. A
 * dependency base is removed under its provisioning lock, after its use is
 * checked again. Only one prune runs at a time (`prune.lock`); a dry run reads
 * and never writes.
 *
 * Snapshot images of a removed workflow run become orphans, which the
 * snapshot sweep reclaims (`src/workflow/container-snapshots.ts`).
 */

import { randomBytes } from 'node:crypto';
import { constants, readdirSync, realpathSync } from 'node:fs';
import { lstat, open, readdir, realpath, rename, rm, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  getIronCurtainHome,
  getJobsDir,
  getPruneLockPath,
  getPtyRegistryDir,
  getSessionsDir,
  getWorkflowRunsDir,
  SESSION_LOCK_FILENAME,
  SESSION_METADATA_FILENAME,
  SESSION_STATE_FILENAME,
} from '../config/paths.js';
import { RETENTION_CONFIG_DEFAULTS, type ResolvedRetentionConfig } from '../config/user-config.js';
import { listPrunableRunRecords } from '../cron/job-store.js';
import type { JobId } from '../cron/types.js';
import { listOwnerLeaseBundleIds, type OwnerLeaseBundles } from '../docker/docker-resource-lifecycle.js';
import { isSessionSnapshot } from '../docker/pty-types.js';
import { provisionLockPath, tryAcquireProvisionLock } from '../docker/provision-lock.js';
import {
  isWorkflowDependencyKeyDir,
  legacyWorkflowDepsRoot,
  readWorkflowDependencyLastUsed,
  workflowDependencyBasesRoot,
  workflowRunDependencyRoot,
} from '../docker/workflow-dependency-cache.js';
import {
  acquireProcessLock,
  inspectProcessLock,
  ProcessLockBusyError,
  type ProcessIdentityResolver,
  type ProcessLockHandle,
} from '../docker-workload/process-lock.js';
import { isPidAlive } from '../escalation/listener-lock.js';
import { readUntrustedRegularFile } from '../hardened-fs.js';
import { expandTilde } from '../types/argument-roles.js';
import { JOB_ID_PATTERN } from '../types/slug.js';
import { errorMessage } from '../utils/error-message.js';
import { FileCheckpointStore, isCheckpointResumable, isWorkflowRunFileTooNewError } from '../workflow/checkpoint.js';
import { WORKFLOW_RUN_LOCK_FILENAME } from '../workflow/run-lock.js';
import { isSafeWorkflowId } from '../workflow/types.js';
import { formatBytes, measureTree } from './disk-usage.js';

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/** What retention covers. */
export type PruneCategory = 'sessions' | 'workflowRuns' | 'jobRuns' | 'dependencyCaches';

export const PRUNE_CATEGORIES: readonly PruneCategory[] = ['sessions', 'workflowRuns', 'jobRuns', 'dependencyCaches'];

/** One thing a prune removes (or, in a dry run, would remove). */
export interface PruneItem {
  readonly category: PruneCategory;
  /** Session id, workflow id, job id, dependency key, or a tombstone's name. */
  readonly id: string;
  /** The directory removed; for run records, the job's `runs/` directory. */
  readonly path: string;
  /** Why it goes, for the report. */
  readonly reason: string;
  /** Last activity (ms since the epoch), when known. */
  readonly lastActivityMs?: number;
  /** Allocated bytes it takes (measured before removal). */
  readonly bytes: number;
  /** Run records only: how many record files. */
  readonly count?: number;
}

/** Something past its limit that is kept, and why. */
export interface PruneKeptItem {
  readonly category: PruneCategory;
  readonly id: string;
  readonly path: string;
  readonly reason: string;
}

/** Something that should have been removed and was not. */
export interface PruneFailure {
  readonly item: PruneItem;
  readonly error: string;
}

export interface PruneReport {
  readonly dryRun: boolean;
  /** Removed, or in a dry run what would be removed. */
  readonly removed: readonly PruneItem[];
  /** Past a limit but kept (live, in use, unreadable, ...). */
  readonly kept: readonly PruneKeptItem[];
  readonly failed: readonly PruneFailure[];
  /** Categories that could not be judged, and remarks (legacy caches, unreadable leases). */
  readonly notes: readonly string[];
  /** The prune was aborted before it finished (the daemon is stopping). */
  readonly aborted: boolean;
}

/** Discriminant of {@link PruneBusyError}. */
export const PRUNE_BUSY = 'PRUNE_BUSY';

/** Another prune holds `prune.lock`. Match `code`, not `instanceof`. */
export class PruneBusyError extends Error {
  readonly code = PRUNE_BUSY;

  constructor(readonly ownerPid: number | undefined) {
    super(`Another prune is running${ownerPid === undefined ? '' : ` (pid ${ownerPid})`}`);
    this.name = 'PruneBusyError';
  }
}

export interface PruneOptions {
  /** Defaults to {@link RETENTION_CONFIG_DEFAULTS}. */
  readonly retention?: ResolvedRetentionConfig;
  /** Report what would be removed without changing anything. */
  readonly dryRun: boolean;
  /** Sessions the caller (the daemon) is running; never removed. */
  readonly liveSessionIds?: ReadonlySet<string>;
  /** Workflow runs the caller (the daemon) is running; never removed. */
  readonly liveWorkflowIds?: ReadonlySet<string>;
  /** Stops the prune between two removals. */
  readonly signal?: AbortSignal;
  /** Clock (ms since the epoch). Tests pin it. */
  readonly now?: () => number;
  /** Test seam for process-lock adjudication (production asks the OS). */
  readonly processIdentityForPid?: ProcessIdentityResolver;
  /** Test seam for PTY registration liveness (production signals the PID). */
  readonly isPidAlive?: (pid: number) => boolean;
  /** Test seam for the owner lease listing. */
  readonly listLeaseBundles?: () => OwnerLeaseBundles;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Nothing active within the last day is removed, whatever the limits say (a
 * size cap, or an age limit below a day): a session that is still starting
 * (building its image, before its container lease exists) or a run that was
 * just used must never look expendable.
 */
const MIN_IDLE_MS = DAY_MS;

/**
 * A modification time further in the future than this is not activity. An
 * agent can set the times of its own workspace (a direct entry of its session
 * or run directory, bind-mounted read-write), and a far-future time would
 * otherwise keep that directory from ever being pruned. The margin absorbs
 * clock skew of a networked home.
 */
const FUTURE_MTIME_TOLERANCE_MS = DAY_MS;

/**
 * Prefix of the name a directory is moved aside to before it is deleted. It
 * starts with a dot, so it is never a session id, workflow id or key: no scan
 * takes a tombstone for a session or run.
 */
export const PRUNE_TOMBSTONE_PREFIX = '.ironcurtain-pruned-';

/** Session directory names (the path-safe slug of `config/paths.ts`). */
const SESSION_DIR_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/** A PTY registration file, `session-<id>.json`. */
const PTY_REGISTRATION_RE = /^session-(.+)\.json$/;

/** Lock files (and their publication leftovers) a session or run directory holds; not activity. */
const LOCK_ARTIFACT_RE = /^(?:resume|run)\.lock(?:\.|$)/;

/** A shared dependency base's provisioned record, removed before the base itself. */
const PROVISIONED_RECORD_RE = /\.provisioned\.json$/;

/** Largest metadata, snapshot, registration or job.json file read. */
const MAX_SMALL_FILE_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------
// Internal model
// ---------------------------------------------------------------------------

/** A session or workflow run directory and what decides its fate. */
interface DirEntry {
  readonly category: 'sessions' | 'workflowRuns';
  readonly id: string;
  /** `<real root>/<id>`. */
  readonly path: string;
  /** `<root as configured>/<id>`, for comparing recorded workspace paths. */
  readonly lexicalPath: string;
  readonly lastActivityMs: number;
  /** Why it is kept whatever its age, or undefined when it may be removed. */
  readonly protectedBy: string | undefined;
  /** Workspaces it records (absolute paths as recorded). */
  readonly workspaceRefs: readonly string[];
  /** Sessions: the workflow run it is a state of. */
  readonly workflowRunId?: string;
  /** Runs: it can no longer be resumed (completed, or no checkpoint). Undefined when unknown. */
  readonly finished?: boolean;
  /** Runs: dependency keys its layers were seeded from. */
  readonly dependencyKeys?: readonly string[];
  /** Why it is selected for removal. */
  selected: string | undefined;
  /** Why it is kept although past a limit. */
  keptReason: string | undefined;
  bytes: number | undefined;
}

interface BaseEntry {
  readonly key: string;
  readonly path: string;
  readonly lastUsedMs: number;
  selected: string | undefined;
  keptReason: string | undefined;
}

interface RunRecordGroup {
  readonly jobId: string;
  readonly runsDir: string;
  readonly files: readonly string[];
  readonly kept: number;
}

interface Tombstone {
  readonly category: PruneCategory;
  readonly path: string;
}

/** The decisions of one prune. */
interface PrunePlan {
  readonly sessions: DirEntry[];
  readonly runs: DirEntry[];
  readonly bases: BaseEntry[];
  readonly runRecords: RunRecordGroup[];
  readonly tombstones: Tombstone[];
  readonly notes: string[];
}

class PruneContext {
  readonly retention: ResolvedRetentionConfig;
  readonly nowMs: number;
  readonly home: string;
  readonly identity: { processIdentityForPid?: ProcessIdentityResolver };
  readonly pidAlive: (pid: number) => boolean;
  readonly report: {
    removed: PruneItem[];
    kept: PruneKeptItem[];
    failed: PruneFailure[];
    notes: string[];
    aborted: boolean;
  } = { removed: [], kept: [], failed: [], notes: [], aborted: false };

  constructor(readonly options: PruneOptions) {
    this.retention = options.retention ?? RETENTION_CONFIG_DEFAULTS;
    this.nowMs = (options.now ?? Date.now)();
    this.home = getIronCurtainHome();
    this.identity =
      options.processIdentityForPid === undefined ? {} : { processIdentityForPid: options.processIdentityForPid };
    this.pidAlive = options.isPidAlive ?? isPidAlive;
  }

  get aborted(): boolean {
    return this.options.signal?.aborted === true;
  }

  keep(category: PruneCategory, id: string, path: string, reason: string): void {
    this.report.kept.push({ category, id, path, reason });
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Applies the retention policy to the IronCurtain home (see the module
 * comment), or with `dryRun` reports what it would remove.
 *
 * @throws PruneBusyError (code `PRUNE_BUSY`) when another prune is running
 *   (not for a dry run, which takes no lock).
 */
export async function runPrune(options: PruneOptions): Promise<PruneReport> {
  const ctx = new PruneContext(options);
  if (!(await isDirectory(ctx.home))) {
    // A fresh install: nothing to judge, and no home to create a lock in.
    return { dryRun: options.dryRun, ...ctx.report };
  }
  let lock: ProcessLockHandle | undefined;
  if (!options.dryRun) {
    try {
      lock = acquireProcessLock(getPruneLockPath(), ctx.identity);
    } catch (error) {
      if (error instanceof ProcessLockBusyError) throw new PruneBusyError(error.ownerPid);
      throw error;
    }
  }
  try {
    const plan = await planPrune(ctx);
    if (options.dryRun) {
      await reportPlan(ctx, plan);
    } else {
      await executePlan(ctx, plan);
    }
    ctx.report.notes.push(...plan.notes);
    ctx.report.aborted = ctx.aborted;
    return { dryRun: options.dryRun, ...ctx.report };
  } finally {
    if (lock !== undefined) releaseQuietly(lock);
  }
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

async function planPrune(ctx: PruneContext): Promise<PrunePlan> {
  const notes: string[] = [];
  const tombstones: Tombstone[] = [];
  let sessions: DirEntry[] = [];
  // Undefined while the runs could not be judged: then no dependency base goes either.
  let runs: DirEntry[] | undefined;

  const liveness = readSessionLiveness(ctx, notes);
  const jobWorkspaces = liveness === undefined ? undefined : readJobWorkspaces(notes);
  if (liveness !== undefined && jobWorkspaces !== undefined) {
    const scannedRuns = await scanWorkflowRuns(ctx, liveness.leases, tombstones, notes);
    const scannedSessions = await scanSessions(ctx, liveness, tombstones, notes);
    // Sessions and runs work in each other's workspaces, and a run's states
    // are sessions: without both, neither is judged.
    if (scannedRuns !== undefined && scannedSessions !== undefined) {
      runs = scannedRuns;
      sessions = scannedSessions;
      selectByAge(ctx, runs, ctx.retention.workflowRuns.maxAgeDays);
      selectByAge(ctx, sessions, ctx.retention.sessions.maxAgeDays);
      await selectBySize(ctx, runs, ctx.retention.workflowRuns.maxBytes, (entry) => entry.finished === true);
      await selectBySize(ctx, sessions, ctx.retention.sessions.maxBytes, () => true);
      protectReferenced(sessions, runs, jobWorkspaces);
    }
  }

  const bases = await scanDependencyBases(ctx, runs, tombstones, notes);
  const runRecords = scanRunRecords(ctx, notes);
  await noteLegacyDependencyCaches(ctx, notes);

  for (const entry of [...sessions, ...(runs ?? [])]) {
    if (entry.keptReason !== undefined) ctx.keep(entry.category, entry.id, entry.path, entry.keptReason);
  }
  for (const base of bases) {
    if (base.keptReason !== undefined) ctx.keep('dependencyCaches', base.key, base.path, base.keptReason);
  }
  return { sessions, runs: runs ?? [], bases, runRecords, tombstones, notes };
}

interface SessionLiveness {
  readonly leases: OwnerLeaseBundles;
  /** PTY sessions with a live (or unreadable) registration, by session id. */
  readonly pty: ReadonlyMap<string, number | undefined>;
}

/**
 * What says a session or run is live beyond its own lock. Fails closed: when
 * the owner leases (any one record of them) or the PTY registry cannot be
 * read, no session or run is judged at all.
 */
function readSessionLiveness(ctx: PruneContext, notes: string[]): SessionLiveness | undefined {
  let leases: OwnerLeaseBundles;
  try {
    leases = (ctx.options.listLeaseBundles ?? listOwnerLeaseBundleIds)();
  } catch (error) {
    notes.push(
      `Sessions and workflow runs were not pruned: the container owner leases cannot be read (${errorMessage(error)}).`,
    );
    return undefined;
  }
  if (leases.unreadable > 0) {
    // A record that cannot be read names no bundle, so the containers it may
    // hold (and the session or run directories they mount) are unknown. The
    // same ambiguity keeps `ironcurtain gc` from reclaiming anything of it.
    // A record still being written reads as unreadable too; the next prune
    // judges again.
    notes.push(
      `Sessions and workflow runs were not pruned: ${leases.unreadable} container owner lease record(s) ` +
        'in run/docker-owners/ cannot be read, so the containers they may hold cannot be matched to a session ' +
        'or run. `ironcurtain gc` removes the records of owners that are gone; inspect any record that remains.',
    );
    return undefined;
  }
  let pty: Map<string, number | undefined>;
  try {
    pty = readLivePtySessions(ctx);
  } catch (error) {
    notes.push(`Sessions and workflow runs were not pruned: the PTY registry cannot be read (${errorMessage(error)}).`);
    return undefined;
  }
  return { leases, pty };
}

/** PTY sessions whose registration names a live process; an unreadable registration counts as live. */
function readLivePtySessions(ctx: PruneContext): Map<string, number | undefined> {
  const live = new Map<string, number | undefined>();
  const registryDir = getPtyRegistryDir();
  let names: string[];
  try {
    names = readdirSync(registryDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return live;
    throw error;
  }
  for (const name of names) {
    const match = PTY_REGISTRATION_RE.exec(name);
    if (!match) continue;
    const fileId = match[1];
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        readUntrustedRegularFile(join(registryDir, name), { maxBytes: MAX_SMALL_FILE_BYTES }).bytes.toString('utf-8'),
      );
    } catch {
      live.set(fileId, undefined);
      continue;
    }
    const record = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    const pid = record.pid;
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid)) {
      live.set(fileId, undefined);
      continue;
    }
    if (!ctx.pidAlive(pid)) continue;
    live.set(fileId, pid);
    if (typeof record.sessionId === 'string') live.set(record.sessionId, pid);
  }
  return live;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(await realpath(path))).isDirectory();
  } catch {
    return false;
  }
}

/** `root` resolved through symlinks; undefined when it does not exist. */
async function realRootOf(root: string): Promise<string | undefined> {
  try {
    return await realpath(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** What is directly under one of the pruned roots. */
interface RootListing {
  /** Names of real directories named like what the root holds. */
  readonly names: string[];
  /** Tombstones a prune moved aside and did not finish deleting. */
  readonly tombstones: string[];
}

/** Names of the real directories directly under `realRoot`, plus tombstones a crashed prune left. */
async function listRootEntries(realRoot: string, accept: (name: string) => boolean): Promise<RootListing> {
  const names: string[] = [];
  const tombstones: string[] = [];
  for (const entry of await readdir(realRoot, { withFileTypes: true })) {
    if (entry.name.startsWith(PRUNE_TOMBSTONE_PREFIX)) {
      // A prune moved it aside and stopped before deleting it.
      if (entry.isDirectory()) tombstones.push(join(realRoot, entry.name));
      continue;
    }
    // withFileTypes reports a symlink as a symlink, never as its target.
    if (entry.isDirectory() && accept(entry.name)) names.push(entry.name);
  }
  return { names, tombstones };
}

/**
 * When a session or run directory was last active: the newest modification
 * time of its direct entries (logs, checkpoint, state files), its own when it
 * has none. Lock files are left out: taking or inspecting a lock is not use.
 * So are times far in the future (see {@link FUTURE_MTIME_TOLERANCE_MS}); when
 * nothing is left, the directory's own time (only the host changes it) is used.
 */
async function lastActivityOf(dir: string, nowMs: number): Promise<number> {
  const latestCredible = nowMs + FUTURE_MTIME_TOLERANCE_MS;
  let newest: number | undefined;
  for (const name of await readdir(dir)) {
    if (LOCK_ARTIFACT_RE.test(name)) continue;
    try {
      const stats = await lstat(join(dir, name));
      if (stats.mtimeMs <= latestCredible) newest = Math.max(newest ?? 0, stats.mtimeMs);
    } catch {
      // Vanished meanwhile.
    }
  }
  return newest ?? (await lstat(dir)).mtimeMs;
}

/** The PID that holds a process lock, or undefined when no live process holds it. */
function lockHolder(ctx: PruneContext, path: string): { readonly pid: number | undefined } | undefined {
  const state = inspectProcessLock(path, ctx.identity);
  return state.kind === 'held' ? { pid: state.ownerPid } : undefined;
}

function pidSuffix(pid: number | undefined): string {
  return pid === undefined ? '' : ` (pid ${pid})`;
}

/** Parses a small JSON file the host wrote; undefined when it is missing or unusable. */
function readSmallJson(path: string): unknown {
  try {
    return JSON.parse(readUntrustedRegularFile(path, { maxBytes: MAX_SMALL_FILE_BYTES }).bytes.toString('utf-8'));
  } catch {
    return undefined;
  }
}

function stringField(value: unknown, field: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = (value as Record<string, unknown>)[field];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/** The session directories, or undefined when the sessions directory cannot be read. */
async function scanSessions(
  ctx: PruneContext,
  liveness: SessionLiveness,
  tombstones: Tombstone[],
  notes: string[],
): Promise<DirEntry[] | undefined> {
  const root = getSessionsDir();
  let realRoot: string | undefined;
  let listing: RootListing;
  try {
    realRoot = await realRootOf(root);
    if (realRoot === undefined) return [];
    listing = await listRootEntries(realRoot, (name) => SESSION_DIR_NAME_RE.test(name));
  } catch (error) {
    notes.push(`Sessions and workflow runs were not pruned: ${root} cannot be read (${errorMessage(error)}).`);
    return undefined;
  }
  for (const path of listing.tombstones) tombstones.push({ category: 'sessions', path });

  const entries: DirEntry[] = [];
  for (const id of listing.names) {
    const path = join(realRoot, id);
    let lastActivityMs: number;
    try {
      lastActivityMs = await lastActivityOf(path, ctx.nowMs);
    } catch (error) {
      ctx.keep('sessions', id, path, `cannot be inspected: ${errorMessage(error)}`);
      continue;
    }
    const metadata = readSmallJson(join(path, SESSION_METADATA_FILENAME));
    const snapshot = readSmallJson(join(path, SESSION_STATE_FILENAME));
    const workspaceRefs = [
      stringField(metadata, 'workspacePath'),
      isSessionSnapshot(snapshot) ? snapshot.workspacePath : undefined,
    ].filter((ref): ref is string => ref !== undefined);
    const workflowRunId = stringField(metadata, 'workflowRunId');
    entries.push({
      category: 'sessions',
      id,
      path,
      lexicalPath: resolve(root, id),
      lastActivityMs,
      protectedBy: sessionProtection(ctx, liveness, id, path),
      workspaceRefs,
      ...(workflowRunId !== undefined ? { workflowRunId } : {}),
      selected: undefined,
      keptReason: undefined,
      bytes: undefined,
    });
  }
  return entries;
}

/** Why a session must stay whatever its age, or undefined. */
function sessionProtection(ctx: PruneContext, liveness: SessionLiveness, id: string, path: string): string | undefined {
  if (ctx.options.liveSessionIds?.has(id) === true) return 'the daemon is running it';
  if (liveness.pty.has(id)) return `a PTY session is running it${pidSuffix(liveness.pty.get(id))}`;
  if (liveness.leases.bundleIds.has(id)) {
    return 'its container resources may remain (`ironcurtain gc --force` reclaims them once their owner is gone)';
  }
  try {
    const holder = lockHolder(ctx, join(path, SESSION_LOCK_FILENAME));
    if (holder !== undefined) return `a running session holds it${pidSuffix(holder.pid)}`;
  } catch (error) {
    return `its lock cannot be inspected: ${errorMessage(error)}`;
  }
  return undefined;
}

/** The workflow run directories, or undefined when the runs directory cannot be read. */
async function scanWorkflowRuns(
  ctx: PruneContext,
  leases: OwnerLeaseBundles,
  tombstones: Tombstone[],
  notes: string[],
): Promise<DirEntry[] | undefined> {
  const root = getWorkflowRunsDir();
  let realRoot: string | undefined;
  let listing: RootListing;
  try {
    realRoot = await realRootOf(root);
    if (realRoot === undefined) return [];
    listing = await listRootEntries(realRoot, isSafeWorkflowId);
  } catch (error) {
    notes.push(`Sessions and workflow runs were not pruned: ${root} cannot be read (${errorMessage(error)}).`);
    return undefined;
  }
  for (const path of listing.tombstones) tombstones.push({ category: 'workflowRuns', path });

  const store = new FileCheckpointStore(realRoot, { warn: () => undefined });
  const entries: DirEntry[] = [];
  for (const id of listing.names) {
    if (!isSafeWorkflowId(id)) continue; // listed only when it is; narrows the type
    const path = join(realRoot, id);
    let lastActivityMs: number;
    try {
      lastActivityMs = await lastActivityOf(path, ctx.nowMs);
    } catch (error) {
      ctx.keep('workflowRuns', id, path, `cannot be inspected: ${errorMessage(error)}`);
      continue;
    }
    let finished: boolean | undefined;
    let workspaceRef: string | undefined;
    try {
      const record = store.loadRecord(id);
      finished = record === undefined || !isCheckpointResumable(record.checkpoint);
      workspaceRef = record?.checkpoint.workspacePath;
    } catch (error) {
      // Unknown: never removed for size; removed for age like any other run.
      finished = undefined;
      if (isWorkflowRunFileTooNewError(error)) {
        notes.push(`Workflow run ${id} was written by a newer IronCurtain; only its age is judged.`);
      }
    }
    entries.push({
      category: 'workflowRuns',
      id,
      path,
      lexicalPath: resolve(root, id),
      lastActivityMs,
      protectedBy: await runProtection(ctx, leases, id, path),
      workspaceRefs: workspaceRef === undefined ? [] : [workspaceRef],
      ...(finished !== undefined ? { finished } : {}),
      dependencyKeys: await listDependencyKeys(path),
      selected: undefined,
      keptReason: undefined,
      bytes: undefined,
    });
  }
  return entries;
}

/** Why a workflow run must stay whatever its age, or undefined. */
async function runProtection(
  ctx: PruneContext,
  leases: OwnerLeaseBundles,
  id: string,
  path: string,
): Promise<string | undefined> {
  if (ctx.options.liveWorkflowIds?.has(id) === true) return 'the daemon is running it';
  try {
    const holder = lockHolder(ctx, join(path, WORKFLOW_RUN_LOCK_FILENAME));
    if (holder !== undefined) return `it is running${pidSuffix(holder.pid)}`;
  } catch (error) {
    return `its lock cannot be inspected: ${errorMessage(error)}`;
  }
  let bundles: string[];
  try {
    bundles = await readdir(join(path, 'containers'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return `its bundles cannot be listed: ${errorMessage(error)}`;
  }
  if (bundles.some((bundle) => leases.bundleIds.has(bundle))) {
    return 'its container resources may remain (`ironcurtain gc --force` reclaims them once their owner is gone)';
  }
  return undefined;
}

/** Dependency keys of a run's layers (`<run>/deps/<key>`). */
async function listDependencyKeys(runDir: string): Promise<string[]> {
  try {
    return (await readdir(workflowRunDependencyRoot(runDir))).filter(isWorkflowDependencyKeyDir);
  } catch {
    return [];
  }
}

/** Idle for longer than `limitDays` (null: no limit), and never within the last day ({@link MIN_IDLE_MS}). */
function overLimit(ageMs: number, limitDays: number | null): boolean {
  return limitDays !== null && ageMs > limitDays * DAY_MS && ageMs >= MIN_IDLE_MS;
}

function ageDays(ctx: PruneContext, lastActivityMs: number): number {
  return Math.floor(Math.max(0, ctx.nowMs - lastActivityMs) / DAY_MS);
}

function selectByAge(ctx: PruneContext, entries: DirEntry[], maxAgeDays: number | null): void {
  for (const entry of entries) {
    if (!overLimit(ctx.nowMs - entry.lastActivityMs, maxAgeDays)) continue;
    if (entry.protectedBy !== undefined) {
      entry.keptReason = entry.protectedBy;
      continue;
    }
    entry.selected = `inactive for ${ageDays(ctx, entry.lastActivityMs)} days (limit ${maxAgeDays} days)`;
  }
}

async function sizeOf(ctx: PruneContext, entry: DirEntry): Promise<number> {
  entry.bytes ??= (await measureTree(entry.path, { signal: ctx.options.signal })).bytes;
  return entry.bytes;
}

/**
 * With a size cap, selects the oldest eligible entries until what stays fits.
 * Never selects a protected entry or one active within the last day.
 */
async function selectBySize(
  ctx: PruneContext,
  entries: DirEntry[],
  maxBytes: number | null,
  eligible: (entry: DirEntry) => boolean,
): Promise<void> {
  if (maxBytes === null || entries.length === 0) return;
  let total = 0;
  for (const entry of entries) {
    if (entry.selected === undefined) total += await sizeOf(ctx, entry);
  }
  const candidates = entries
    .filter(
      (entry) =>
        entry.selected === undefined &&
        entry.protectedBy === undefined &&
        ctx.nowMs - entry.lastActivityMs >= MIN_IDLE_MS &&
        eligible(entry),
    )
    .sort((left, right) => left.lastActivityMs - right.lastActivityMs);
  for (const entry of candidates) {
    if (total <= maxBytes) return;
    entry.selected = `among the oldest while the category is over its size limit (${formatBytes(maxBytes)})`;
    total -= entry.bytes ?? 0;
  }
}

/**
 * A recorded workspace path in every form that may name it: as written
 * (`~` expanded, resolved) and, when it exists, canonical. More forms can
 * only keep more, never remove more. Memoized per prune: many sessions (every
 * cron run, for one) record the same workspace.
 */
function workspaceForms(ref: string, cache: Map<string, readonly string[]>): readonly string[] {
  const cached = cache.get(ref);
  if (cached !== undefined) return cached;
  const spelled = resolve(expandTilde(ref));
  const forms = [spelled];
  try {
    const canonical = realpathSync.native(spelled);
    if (canonical !== spelled) forms.push(canonical);
  } catch {
    // Gone: only its spelling can match.
  }
  cache.set(ref, forms);
  return forms;
}

/** Every form of every workspace `entry` records. */
function workspaceFormsOf(entry: DirEntry, cache: Map<string, readonly string[]>): readonly string[] {
  return entry.workspaceRefs.flatMap((ref) => workspaceForms(ref, cache));
}

/**
 * The session and run directories by every path that names them (real, and
 * under the root as configured), so the ones holding a workspace are found by
 * walking up from it: a lookup per ancestor instead of a comparison with
 * every directory.
 */
class EntryIndex {
  private readonly byDir = new Map<string, DirEntry[]>();

  constructor(entries: readonly DirEntry[]) {
    for (const entry of entries) {
      for (const dir of new Set([entry.path, entry.lexicalPath])) {
        const known = this.byDir.get(dir);
        if (known === undefined) this.byDir.set(dir, [entry]);
        else known.push(entry);
      }
    }
  }

  /** The entries whose directory is `path` (absolute, normalized) or one of its ancestors. */
  holding(path: string): DirEntry[] {
    const found: DirEntry[] = [];
    for (let current = path; ; current = dirname(current)) {
      for (const entry of this.byDir.get(current) ?? []) {
        if (!found.includes(entry)) found.push(entry);
      }
      if (dirname(current) === current) return found;
    }
  }
}

/** A workspace a cron job uses. */
interface JobWorkspace {
  readonly workspace: string;
  readonly owner: string;
}

/**
 * The workspaces of the cron jobs (job.json read leniently: an invalid one
 * may still name one), or undefined when the jobs directory exists but cannot
 * be listed: any session or run directory might then hold a job's workspace,
 * so none is judged (fail closed).
 */
function readJobWorkspaces(notes: string[]): JobWorkspace[] | undefined {
  let names: string[];
  try {
    names = readdirSync(getJobsDir());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    notes.push(
      `Sessions and workflow runs were not pruned: ${getJobsDir()} cannot be read, so the workspaces of the ` +
        `cron jobs are unknown (${errorMessage(error)}).`,
    );
    return undefined;
  }
  const workspaces: JobWorkspace[] = [];
  for (const name of names) {
    if (!JOB_ID_PATTERN.test(name)) continue;
    const workspace = stringField(readSmallJson(join(getJobsDir(), name, 'job.json')), 'workspace');
    if (workspace !== undefined) workspaces.push({ workspace, owner: `cron job ${name}` });
  }
  return workspaces;
}

function describeOwner(entry: DirEntry): string {
  return `${entry.category === 'sessions' ? 'session' : 'workflow run'} ${entry.id}`;
}

/** Unselects `entry` (when selected) with `reason`; true when that changed it. */
function keepSelected(entry: DirEntry, reason: string): boolean {
  if (entry.selected === undefined) return false;
  entry.selected = undefined;
  entry.keptReason = reason;
  return true;
}

/**
 * Keeps every selected session or run that holds a workspace still in use
 * (by a kept session or run, or a cron job), and every session of a kept
 * workflow run. Repeats until nothing changes: an entry kept this way may in
 * turn use a workspace inside another selected one.
 */
function protectReferenced(sessions: DirEntry[], runs: DirEntry[], jobWorkspaces: readonly JobWorkspace[]): void {
  const formsCache = new Map<string, readonly string[]>();
  const jobUses = jobWorkspaces.map((job) => ({ forms: workspaceForms(job.workspace, formsCache), owner: job.owner }));
  const all = [...runs, ...sessions];
  const index = new EntryIndex(all);
  const runsById = new Map(runs.map((run) => [run.id, run]));
  for (let changed = true; changed;) {
    changed = false;
    for (const session of sessions) {
      const run = session.workflowRunId === undefined ? undefined : runsById.get(session.workflowRunId);
      if (run === undefined || run.selected !== undefined) continue;
      if (keepSelected(session, `it belongs to workflow run ${run.id}, which is kept`)) changed = true;
    }
    for (const use of jobUses) {
      for (const holder of use.forms.flatMap((form) => index.holding(form))) {
        if (keepSelected(holder, `it holds the workspace of ${use.owner}`)) changed = true;
      }
    }
    for (const user of all) {
      if (user.selected !== undefined) continue;
      for (const holder of workspaceFormsOf(user, formsCache).flatMap((form) => index.holding(form))) {
        if (holder !== user && keepSelected(holder, `it holds the workspace of ${describeOwner(user)}`)) {
          changed = true;
        }
      }
    }
  }
}

/** The selected sessions and runs in removal order, and what keeps each of them. */
interface RemovalOrder {
  readonly order: readonly DirEntry[];
  /**
   * For a selected entry, the selected entries whose staying keeps it: the
   * workflow run a session belongs to, and every entry that uses a workspace
   * inside it. Each of them comes before it in `order`, except within a cycle.
   */
  readonly keepers: ReadonlyMap<DirEntry, readonly DirEntry[]>;
}

/**
 * Orders the removal of the selected sessions and runs so that an entry goes
 * only after every selected entry whose staying would keep it (see
 * {@link RemovalOrder.keepers}). One of those may still stay at removal time
 * (it became live: a resume took its lock after planning), and it then keeps
 * what it needs, as {@link protectReferenced} does for what stays from the
 * start. Otherwise runs go before sessions, oldest first. Entries that keep
 * each other (two sessions working in each other's sandbox) form a cycle,
 * which is broken at one of its members; an entry waiting on the cycle still
 * comes after it.
 */
function removalOrder(plan: PrunePlan): RemovalOrder {
  const pending = [...selectedEntries(plan.runs), ...selectedEntries(plan.sessions)];
  const selected = new Set(pending);
  const keepers = new Map<DirEntry, DirEntry[]>();
  const link = (keeper: DirEntry, kept: DirEntry): void => {
    if (keeper === kept || !selected.has(keeper) || !selected.has(kept)) return;
    const known = keepers.get(kept);
    if (known === undefined) keepers.set(kept, [keeper]);
    else if (!known.includes(keeper)) known.push(keeper);
  };
  const index = new EntryIndex([...plan.runs, ...plan.sessions]);
  const formsCache = new Map<string, readonly string[]>();
  const runsById = new Map(plan.runs.map((run) => [run.id, run]));
  for (const entry of pending) {
    for (const holder of workspaceFormsOf(entry, formsCache).flatMap((form) => index.holding(form))) {
      link(entry, holder);
    }
    const run = entry.workflowRunId === undefined ? undefined : runsById.get(entry.workflowRunId);
    if (entry.category === 'sessions' && run !== undefined) link(run, entry);
  }

  // Passes over what is left, each taking every entry whose keepers are all
  // placed: one pass when nothing keeps anything, one more per link of the
  // longest chain otherwise.
  const order: DirEntry[] = [];
  const placed = new Set<DirEntry>();
  let remaining = pending;
  while (remaining.length > 0) {
    const deferred: DirEntry[] = [];
    for (const entry of remaining) {
      if ((keepers.get(entry) ?? []).every((keeper) => placed.has(keeper))) {
        order.push(entry);
        placed.add(entry);
      } else {
        deferred.push(entry);
      }
    }
    if (deferred.length === remaining.length) {
      // Nothing is ready: every entry left waits on another one left, so
      // following those waits comes back around a cycle. Its members keep
      // each other; take the one reached (never one that only waits on it).
      const seen = new Set<DirEntry>();
      let member = deferred[0];
      while (!seen.has(member)) {
        seen.add(member);
        member = (keepers.get(member) ?? []).find((keeper) => !placed.has(keeper)) ?? member;
      }
      order.push(member);
      placed.add(member);
      remaining = deferred.filter((entry) => entry !== member);
    } else {
      remaining = deferred;
    }
  }
  return { order, keepers };
}

/** Why `entry` stays with `keeper`, which stayed. */
function keptWith(keeper: DirEntry, entry: DirEntry): string {
  if (entry.category === 'sessions' && keeper.category === 'workflowRuns' && entry.workflowRunId === keeper.id) {
    return `it belongs to workflow run ${keeper.id}, which is kept`;
  }
  return `it holds the workspace of ${describeOwner(keeper)}, which is kept`;
}

async function scanDependencyBases(
  ctx: PruneContext,
  runs: readonly DirEntry[] | undefined,
  tombstones: Tombstone[],
  notes: string[],
): Promise<BaseEntry[]> {
  const maxUnusedDays = ctx.retention.dependencyCaches.maxUnusedDays;
  const root = workflowDependencyBasesRoot(ctx.home);
  let realRoot: string | undefined;
  let listing: RootListing;
  try {
    realRoot = await realRootOf(root);
    if (realRoot === undefined) return [];
    listing = await listRootEntries(realRoot, isWorkflowDependencyKeyDir);
  } catch (error) {
    notes.push(`Dependency caches were not pruned: ${root} cannot be read (${errorMessage(error)}).`);
    return [];
  }
  for (const path of listing.tombstones) tombstones.push({ category: 'dependencyCaches', path });
  if (maxUnusedDays === null) return [];

  // Keys a kept run has a layer of. When the runs could not be judged at
  // all, every base stays.
  const usedBy = new Map<string, string>();
  for (const run of runs ?? []) {
    if (run.selected !== undefined) continue;
    for (const key of run.dependencyKeys ?? []) usedBy.set(key, run.id);
  }

  const bases: BaseEntry[] = [];
  for (const key of listing.names) {
    const path = join(realRoot, key);
    let lastUsedMs: number;
    try {
      lastUsedMs = readWorkflowDependencyLastUsed(path) ?? (await lastActivityOf(path, ctx.nowMs));
    } catch (error) {
      ctx.keep('dependencyCaches', key, path, `cannot be inspected: ${errorMessage(error)}`);
      continue;
    }
    if (!overLimit(ctx.nowMs - lastUsedMs, maxUnusedDays)) continue;
    const base: BaseEntry = { key, path, lastUsedMs, selected: undefined, keptReason: undefined };
    bases.push(base);
    const user = usedBy.get(key);
    if (runs === undefined) {
      base.keptReason = 'workflow runs could not be checked for its use';
    } else if (user !== undefined) {
      base.keptReason = `a layer of workflow run ${user} was seeded from it`;
    } else if (inspectProcessLock(provisionLockPath(path), ctx.identity).kind === 'held') {
      base.keptReason = 'it is being provisioned or seeded';
    } else {
      base.selected = `unused for ${ageDays(ctx, lastUsedMs)} days (limit ${maxUnusedDays} days)`;
    }
  }
  return bases;
}

function scanRunRecords(ctx: PruneContext, notes: string[]): RunRecordGroup[] {
  const maxRecords = ctx.retention.jobRuns.maxRecords;
  if (maxRecords === null) return [];
  let names: string[];
  try {
    names = readdirSync(getJobsDir());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      notes.push(`Job run records were not pruned: ${getJobsDir()} cannot be read (${errorMessage(error)}).`);
    }
    return [];
  }
  const groups: RunRecordGroup[] = [];
  for (const name of names.sort()) {
    if (!JOB_ID_PATTERN.test(name)) continue;
    try {
      const prunable = listPrunableRunRecords(name as JobId, maxRecords);
      if (prunable.files.length > 0) groups.push({ jobId: name, ...prunable });
    } catch (error) {
      notes.push(`Run records of job ${name} were not pruned: ${errorMessage(error)}.`);
    }
  }
  return groups;
}

/** Names the legacy `workflow-deps/` tree, which pruning never removes. */
async function noteLegacyDependencyCaches(ctx: PruneContext, notes: string[]): Promise<void> {
  const legacy = legacyWorkflowDepsRoot(ctx.home);
  let stats;
  try {
    stats = await lstat(legacy);
  } catch {
    return;
  }
  if (!stats.isDirectory()) return;
  const usage = await measureTree(legacy, { signal: ctx.options.signal });
  notes.push(
    `${legacy} holds dependency caches of earlier IronCurtain versions (${formatBytes(usage.bytes)}). ` +
      'It is never removed automatically, because a process of such a version may still mount it; ' +
      'delete it once no earlier IronCurtain process is running.',
  );
}

// ---------------------------------------------------------------------------
// Reporting and execution
// ---------------------------------------------------------------------------

function dirItem(entry: DirEntry, reason: string, bytes: number): PruneItem {
  return {
    category: entry.category,
    id: entry.id,
    path: entry.path,
    reason,
    lastActivityMs: entry.lastActivityMs,
    bytes,
  };
}

async function runRecordItem(group: RunRecordGroup): Promise<PruneItem> {
  let bytes = 0;
  for (const file of group.files) {
    try {
      bytes += (await lstat(join(group.runsDir, file))).size;
    } catch {
      // Vanished meanwhile.
    }
  }
  return {
    category: 'jobRuns',
    id: group.jobId,
    path: group.runsDir,
    reason: `beyond the newest ${group.kept} run record(s)`,
    bytes,
    count: group.files.length,
  };
}

async function tombstoneItem(ctx: PruneContext, tombstone: Tombstone): Promise<PruneItem> {
  const usage = await measureTree(tombstone.path, { signal: ctx.options.signal });
  return {
    category: tombstone.category,
    id: basename(tombstone.path),
    path: tombstone.path,
    reason: 'left behind by an interrupted prune',
    bytes: usage.bytes,
  };
}

async function baseItem(ctx: PruneContext, base: BaseEntry, reason: string): Promise<PruneItem> {
  const usage = await measureTree(base.path, { signal: ctx.options.signal });
  return {
    category: 'dependencyCaches',
    id: base.key,
    path: base.path,
    reason,
    lastActivityMs: base.lastUsedMs,
    bytes: usage.bytes,
  };
}

/** Selected entries, oldest first. */
function selectedEntries(entries: readonly DirEntry[]): DirEntry[] {
  return entries
    .filter((entry) => entry.selected !== undefined)
    .sort((left, right) => left.lastActivityMs - right.lastActivityMs);
}

/** A dry run: what would be removed, measured. */
async function reportPlan(ctx: PruneContext, plan: PrunePlan): Promise<void> {
  for (const tombstone of plan.tombstones) ctx.report.removed.push(await tombstoneItem(ctx, tombstone));
  for (const group of plan.runRecords) ctx.report.removed.push(await runRecordItem(group));
  for (const entry of [...selectedEntries(plan.runs), ...selectedEntries(plan.sessions)]) {
    ctx.report.removed.push(dirItem(entry, entry.selected ?? '', await sizeOf(ctx, entry)));
  }
  for (const base of plan.bases) {
    if (base.selected !== undefined) ctx.report.removed.push(await baseItem(ctx, base, base.selected));
  }
}

async function executePlan(ctx: PruneContext, plan: PrunePlan): Promise<void> {
  for (const tombstone of plan.tombstones) {
    if (ctx.aborted) return;
    const item = await tombstoneItem(ctx, tombstone);
    const error = await removeTree(tombstone.path);
    if (error === undefined) ctx.report.removed.push(item);
    else ctx.report.failed.push({ item, error });
  }

  for (const group of plan.runRecords) {
    if (ctx.aborted) return;
    await removeRunRecords(ctx, group);
  }

  // An entry goes only after whatever would keep it: a session after its
  // run, a directory holding a workspace after the entries using it. One of
  // those that stays after all (it became live, or could not be removed)
  // keeps it. Bases go last: a base a staying run was seeded from stays too.
  const { order, keepers } = removalOrder(plan);
  const stayed = new Set<DirEntry>();
  for (const entry of order) {
    if (ctx.aborted) return;
    const keeper = keepers.get(entry)?.find((candidate) => stayed.has(candidate));
    if (keeper !== undefined) {
      ctx.keep(entry.category, entry.id, entry.path, keptWith(keeper, entry));
      stayed.add(entry);
      continue;
    }
    const lockName = entry.category === 'sessions' ? SESSION_LOCK_FILENAME : WORKFLOW_RUN_LOCK_FILENAME;
    if (!(await removeDirEntry(ctx, entry, lockName))) stayed.add(entry);
  }

  const keysStillUsed = new Set(
    [...stayed].filter((entry) => entry.category === 'workflowRuns').flatMap((entry) => entry.dependencyKeys ?? []),
  );
  for (const base of plan.bases) {
    if (ctx.aborted) return;
    if (base.selected === undefined) continue;
    if (keysStillUsed.has(base.key)) {
      ctx.keep('dependencyCaches', base.key, base.path, 'a workflow run seeded from it is kept');
      continue;
    }
    await removeDependencyBase(ctx, base, base.selected);
  }
}

async function removeRunRecords(ctx: PruneContext, group: RunRecordGroup): Promise<void> {
  const item = await runRecordItem(group);
  let removed = 0;
  let bytes = 0;
  const errors: string[] = [];
  for (const file of group.files) {
    const path = join(group.runsDir, file);
    try {
      const size = (await lstat(path)).size;
      await unlink(path);
      removed += 1;
      bytes += size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      errors.push(`${file}: ${errorMessage(error)}`);
    }
  }
  if (removed > 0) ctx.report.removed.push({ ...item, count: removed, bytes });
  if (errors.length > 0) {
    ctx.report.failed.push({ item, error: `${errors.length} record(s) could not be removed (${errors[0]})` });
  }
}

/** Moves `path` aside to a tombstone beside it and returns the tombstone. */
async function moveAside(path: string): Promise<string> {
  const tombstone = join(dirname(path), `${PRUNE_TOMBSTONE_PREFIX}${basename(path)}-${randomBytes(6).toString('hex')}`);
  await rename(path, tombstone);
  return tombstone;
}

function releaseQuietly(lock: ProcessLockHandle): void {
  try {
    lock.release();
  } catch {
    // The lock file moved away with its directory: nothing is left to release.
  }
}

/**
 * Removes a session or run directory: takes its lock the way a resume would
 * (a live owner keeps it), moves it aside, and deletes it. Returns whether it
 * is gone (or out of the way, as a tombstone the next prune deletes).
 */
async function removeDirEntry(ctx: PruneContext, entry: DirEntry, lockName: string): Promise<boolean> {
  const item = dirItem(entry, entry.selected ?? '', await sizeOf(ctx, entry));
  let lock: ProcessLockHandle;
  try {
    lock = acquireProcessLock(join(entry.path, lockName), ctx.identity);
  } catch (error) {
    if (error instanceof ProcessLockBusyError) {
      ctx.keep(entry.category, entry.id, entry.path, `it became live${pidSuffix(error.ownerPid)}`);
    } else {
      ctx.report.failed.push({ item, error: `cannot lock it: ${errorMessage(error)}` });
    }
    return false;
  }
  let tombstone: string;
  try {
    tombstone = await moveAside(entry.path);
  } catch (error) {
    releaseQuietly(lock);
    ctx.report.failed.push({ item, error: `cannot move it aside: ${errorMessage(error)}` });
    return false;
  }
  releaseQuietly(lock);
  const error = await removeTree(tombstone);
  if (error === undefined) ctx.report.removed.push(item);
  else ctx.report.failed.push({ item, error: `moved aside to ${tombstone}, but not deleted: ${error}` });
  return true;
}

/**
 * Removes a shared dependency base under its provisioning lock, after its
 * last use is read again: a run that seeded from it meanwhile keeps it.
 */
async function removeDependencyBase(ctx: PruneContext, base: BaseEntry, reason: string): Promise<void> {
  const item = await baseItem(ctx, base, reason);
  let lock: ProcessLockHandle | undefined;
  try {
    lock = tryAcquireProvisionLock(base.path, ctx.identity);
  } catch (error) {
    ctx.report.failed.push({ item, error: `cannot lock it: ${errorMessage(error)}` });
    return;
  }
  if (lock === undefined) {
    ctx.keep('dependencyCaches', base.key, base.path, 'it is being provisioned or seeded');
    return;
  }
  let tombstone: string;
  try {
    const lastUsed = readWorkflowDependencyLastUsed(base.path) ?? (await lastActivityOf(base.path, ctx.nowMs));
    if (!overLimit(ctx.nowMs - lastUsed, ctx.retention.dependencyCaches.maxUnusedDays)) {
      ctx.keep('dependencyCaches', base.key, base.path, 'a run used it while the prune ran');
      return;
    }
    // Forget the provisioned records first, so a crash midway leaves a base
    // that is rebuilt, never one trusted half-deleted.
    for (const name of await readdir(base.path)) {
      if (PROVISIONED_RECORD_RE.test(name)) await rm(join(base.path, name), { force: true });
    }
    tombstone = await moveAside(base.path);
  } catch (error) {
    ctx.report.failed.push({ item, error: errorMessage(error) });
    return;
  } finally {
    releaseQuietly(lock);
  }
  const error = await removeTree(tombstone);
  if (error === undefined) ctx.report.removed.push(item);
  else ctx.report.failed.push({ item, error: `moved aside to ${tombstone}, but not deleted: ${error}` });
}

// ---------------------------------------------------------------------------
// Tree removal
// ---------------------------------------------------------------------------

/** Makes every real directory under `root` writable by its owner, never following a symlink. */
async function makeDirectoriesWritable(root: string): Promise<void> {
  const pending = [root];
  for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
    let handle;
    try {
      handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    } catch {
      continue; // a symlink, not a directory, or not ours
    }
    try {
      await handle.chmod(0o700);
    } catch {
      // Owned by someone else (root, through an agent's sudo); rm reports it.
    } finally {
      await handle.close();
    }
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      continue;
    }
    for (const name of names) pending.push(join(directory, name));
  }
}

/**
 * Deletes a tree that nothing live uses any more (a tombstone). A read-only
 * directory is made writable and the deletion retried. Returns the error, or
 * undefined once the tree is gone.
 */
async function removeTree(path: string): Promise<string | undefined> {
  try {
    await rm(path, { recursive: true, force: true });
    return undefined;
  } catch {
    // Retry below once read-only directories are writable.
  }
  try {
    await makeDirectoriesWritable(path);
    await rm(path, { recursive: true, force: true });
    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
}
