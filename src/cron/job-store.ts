/**
 * Filesystem-backed store for job definitions and run records.
 *
 * Directory layout:
 *   ~/.ironcurtain/jobs/{jobId}/
 *     job.json              -- JobDefinition
 *     job.lock              -- advisory lock held while job.json is written
 *     generated/            -- per-job compiled policy artifacts
 *       compiled-policy.json
 *       dynamic-lists.json  -- (optional)
 *     workspace/            -- persistent agent workspace
 *     runs/                 -- run history
 *       2026-03-04T09-00-00.000Z.json
 *       latest.json         -- pointer to the newest record and the failure streak
 *
 * Tool annotations (tool-annotations.json) are always loaded from
 * the global location, never stored per-job.
 *
 * Every run adds a record; `ironcurtain prune` (retention.jobRuns.maxRecords)
 * removes all but the newest ones (see {@link listPrunableRunRecords}). The
 * `latest.json` pointer names the newest record and carries the job's failure
 * streak, so the job listings (`list-jobs`, `jobs.list`, daemon status) read
 * two small files per job instead of listing the whole directory. It is only
 * an index: a pointer that is missing, unreadable or names a record that is
 * gone is ignored and the directory is listed instead.
 *
 * job.json and run records are written atomically (temp file, fsync,
 * rename), so a crash or a full disk leaves the previous file, never a torn
 * one. job.json is validated against {@link jobDefinitionSchema} when it is
 * read: a file that is not valid JSON, lacks a field, or whose `id` does not
 * name its directory is *invalid*, which is reported as such (list-jobs and
 * doctor print `INVALID: <reason>`, job commands refuse with the reason)
 * instead of the job silently disappearing or reading as "not found".
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { resolve } from 'node:path';
import { z } from 'zod';
import { getJobsDir, getJobDir, getJobRunsDir } from '../config/paths.js';
import type { JobDefinition, JobId, RunRecord } from './types.js';
import { createJobId, InvalidJobError, JobNotFoundError, MAX_COUNTED_FAILURES } from './types.js';
import { withFileLock, getJobLockPath } from './file-lock.js';
import { atomicWriteTextSync } from '../util/atomic-write.js';
import { JOB_ID_PATTERN } from '../types/slug.js';

/** Longest invalid-reason text kept (a JSON parse error can quote the file). */
const MAX_REASON_LENGTH = 300;

/**
 * The rules for `budgetOverrides`: each limit is absent (the default applies),
 * `null` (no limit) or a positive number, a safe integer for tokens and steps.
 * The job wizard checks the limits it saves with these same field schemas.
 */
export const budgetOverridesSchema = z.object({
  maxTotalTokens: z.number().int().positive().nullable().optional(),
  maxSteps: z.number().int().positive().nullable().optional(),
  maxSessionSeconds: z.number().positive().nullable().optional(),
  maxEstimatedCostUsd: z.number().positive().nullable().optional(),
});

/**
 * The shape of a job.json. Fields this version does not know are kept
 * (`loose`), so rewriting a job (enable-job, say) never drops them. The
 * schedule is only required to be a string here: whether it is a valid cron
 * expression is checked when the job is scheduled, so a job with a bad
 * schedule is still listed (as `invalid schedule`) and can be fixed with
 * edit-job.
 */
export const jobDefinitionSchema = z
  .object({
    id: z.string().regex(JOB_ID_PATTERN, 'must be a job id (lowercase letters, digits, - and _)'),
    name: z.string(),
    schedule: z.string().min(1),
    taskDescription: z.string(),
    taskConstitution: z.string(),
    workspace: z.string().min(1).optional(),
    gitRepo: z.string().min(1).optional(),
    notifyOnEscalation: z.boolean(),
    notifyOnCompletion: z.boolean(),
    budgetOverrides: budgetOverridesSchema.optional(),
    persona: z.string().min(1).optional(),
    enabled: z.boolean(),
    memory: z.object({ enabled: z.boolean() }).optional(),
  })
  .loose();

/** What reading one job's job.json found. */
export type JobReadResult =
  | { readonly kind: 'ok'; readonly job: JobDefinition }
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid'; readonly error: InvalidJobError };

function jobFilePath(jobId: JobId): string {
  return resolve(getJobDir(jobId), 'job.json');
}

function truncateReason(reason: string): string {
  return reason.length > MAX_REASON_LENGTH ? `${reason.slice(0, MAX_REASON_LENGTH)}...` : reason;
}

function errorCode(err: unknown): string | undefined {
  return err instanceof Error && 'code' in err && typeof err.code === 'string' ? err.code : undefined;
}

/**
 * Validates the parsed content of a job.json found in the directory of
 * `jobId`. Returns the definition, or the reason it is invalid.
 */
function validateJobDefinition(jobId: string, raw: unknown): JobDefinition | string {
  const result = jobDefinitionSchema.safeParse(raw);
  if (!result.success) {
    return result.error.issues
      .map((issue) => (issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
      .join('; ');
  }
  if (result.data.id !== jobId) {
    return `id "${result.data.id}" does not match its job directory "${jobId}"`;
  }
  return result.data as unknown as JobDefinition;
}

/**
 * Why `job` would read back as invalid (see {@link readJob}), or undefined
 * when it would load. The definition itself is checked, before it is written,
 * so a value JSON cannot hold is refused rather than changed: a non-finite
 * budget limit would otherwise be written as `null`, which means "no limit".
 */
export function findJobDefinitionProblem(job: JobDefinition): string | undefined {
  const validated = validateJobDefinition(job.id, job);
  return typeof validated === 'string' ? validated : undefined;
}

/**
 * Reads and validates one job's job.json. Never throws for a problem with
 * the file itself: a missing file is `missing`, and an unreadable,
 * unparseable or schema-violating one is `invalid` with the reason.
 */
export function readJob(jobId: JobId): JobReadResult {
  const path = jobFilePath(jobId);
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (err) {
    const code = errorCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' };
    return { kind: 'invalid', error: new InvalidJobError(jobId, path, `cannot be read (${code ?? String(err)})`) };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: 'invalid', error: new InvalidJobError(jobId, path, truncateReason(`not valid JSON (${message})`)) };
  }
  const validated = validateJobDefinition(jobId, raw);
  if (typeof validated === 'string') {
    return { kind: 'invalid', error: new InvalidJobError(jobId, path, truncateReason(validated)) };
  }
  return { kind: 'ok', job: validated };
}

/**
 * Loads a job definition from disk. Returns undefined if the job does not
 * exist.
 *
 * @throws InvalidJobError (code `JOB_INVALID`) when its job.json exists but
 *   is invalid, so callers report "job.json is invalid: <reason>" instead of
 *   "not found".
 */
export function loadJob(jobId: JobId): JobDefinition | undefined {
  const result = readJob(jobId);
  if (result.kind === 'invalid') throw result.error;
  return result.kind === 'ok' ? result.job : undefined;
}

/** A job directory whose job.json is invalid (see {@link scanJobs}). */
export interface InvalidJobEntry {
  /** The job directory name. */
  readonly jobId: JobId;
  /** Path of the invalid job.json. */
  readonly path: string;
  readonly reason: string;
}

/** Every job on disk: the valid definitions, and the job directories whose job.json is invalid. */
export interface JobScan {
  readonly jobs: JobDefinition[];
  readonly invalid: InvalidJobEntry[];
}

/**
 * Reads every job directory. Entries whose name is not a job id, and
 * directories without a job.json, are not jobs and are skipped; a job.json
 * that is present but invalid is reported in `invalid`.
 */
export function scanJobs(): JobScan {
  const jobsDir = getJobsDir();
  const scan: JobScan = { jobs: [], invalid: [] };
  if (!existsSync(jobsDir)) return scan;

  let entries: string[];
  try {
    entries = readdirSync(jobsDir);
  } catch {
    return scan;
  }

  for (const entry of entries.sort()) {
    let jobId: JobId;
    try {
      jobId = createJobId(entry);
    } catch {
      continue; // not a job directory
    }
    const result = readJob(jobId);
    if (result.kind === 'ok') scan.jobs.push(result.job);
    else if (result.kind === 'invalid') {
      scan.invalid.push({ jobId, path: result.error.path, reason: result.error.reason });
    }
  }
  return scan;
}

/**
 * Loads all valid job definitions from disk. Invalid ones are left out; use
 * {@link scanJobs} to report them.
 */
export function loadAllJobs(): JobDefinition[] {
  return scanJobs().jobs;
}

/** Writes job.json atomically; the job directory must exist (never recreated here). */
function writeJobFile(job: JobDefinition): void {
  atomicWriteTextSync(jobFilePath(job.id), JSON.stringify(job, null, 2) + '\n', {
    createParentDirs: false,
    fsync: true,
  });
}

/**
 * Saves a job definition to disk. Creates the job directory as needed.
 * Holds the job's advisory lock while writing, so it never interleaves with
 * an {@link updateJob} of the same job in this or another process.
 */
export async function saveJob(job: JobDefinition): Promise<void> {
  const jobDir = getJobDir(job.id);
  mkdirSync(jobDir, { recursive: true });

  await withFileLock(getJobLockPath(jobDir), () => {
    writeJobFile(job);
  });
}

/** Holds the job's lock around `fn`; a job whose directory is gone is not found. */
async function withExistingJobLocked<T>(jobId: JobId, fn: () => T): Promise<T> {
  const jobDir = getJobDir(jobId);
  if (!existsSync(jobDir)) throw new JobNotFoundError(jobId);
  try {
    return await withFileLock(getJobLockPath(jobDir), fn);
  } catch (err) {
    // The directory went away before the lock file could be created.
    if (errorCode(err) === 'ENOENT') throw new JobNotFoundError(jobId);
    throw err;
  }
}

/** The current definition of `jobId` under its lock. */
function requireCurrentJob(jobId: JobId): JobDefinition {
  const current = readJob(jobId);
  if (current.kind === 'missing') throw new JobNotFoundError(jobId);
  if (current.kind === 'invalid') throw current.error;
  return current.job;
}

/**
 * Load-modify-save of one job under its lock: `update` receives the
 * definition on disk now and returns the one to save, so a concurrent change
 * (another enable/disable, an edit) is never overwritten with a stale copy.
 * Returns the saved definition.
 *
 * @throws JobNotFoundError when the job does not exist (also when it was
 *   removed meanwhile; it is never recreated), InvalidJobError when its
 *   job.json is invalid.
 */
export async function updateJob(
  jobId: JobId,
  update: (current: JobDefinition) => JobDefinition,
): Promise<JobDefinition> {
  return withExistingJobLocked(jobId, () => {
    const next = update(requireCurrentJob(jobId));
    if (next.id !== jobId) throw new Error(`updateJob cannot change a job's id (${jobId} -> ${next.id})`);
    writeJobFile(next);
    return next;
  });
}

/**
 * Saves the result of an interactive edit that started from `original`.
 * Only the fields the user changed (those that differ between `original`
 * and `edited`) are applied, onto the definition on disk now, so a change
 * made while the editor was open (a disable-job, say) is kept instead of
 * being overwritten with the copy loaded minutes earlier. Returns the saved
 * definition.
 *
 * @throws JobNotFoundError when the job was removed meanwhile (it is not
 *   recreated), InvalidJobError when its job.json became invalid.
 */
export async function saveEditedJob(original: JobDefinition, edited: JobDefinition): Promise<JobDefinition> {
  if (edited.id !== original.id) throw new Error(`an edit cannot change a job's id (${original.id} -> ${edited.id})`);
  return withExistingJobLocked(original.id, () => {
    const current = requireCurrentJob(original.id) as unknown as Record<string, unknown>;
    const before = original as unknown as Record<string, unknown>;
    const after = edited as unknown as Record<string, unknown>;
    const changed = new Set(
      [...Object.keys(before), ...Object.keys(after)].filter((key) => !isDeepStrictEqual(before[key], after[key])),
    );
    // A changed field takes the edited value (one the edit removed is left
    // out); every other field keeps the value on disk now.
    const merged = Object.fromEntries(
      [...new Set([...Object.keys(current), ...changed])]
        .map((key): [string, unknown] => [key, changed.has(key) ? after[key] : current[key]])
        .filter(([, value]) => value !== undefined),
    );
    const job = merged as unknown as JobDefinition;
    writeJobFile(job);
    return job;
  });
}

/** Deletes a job and all its artifacts (generated, workspace, runs). */
export function deleteJob(jobId: JobId): void {
  rmSync(getJobDir(jobId), { recursive: true, force: true });
}

/** Name of the newest-record pointer in a job's `runs/` directory. */
export const LATEST_RUN_POINTER_FILE = 'latest.json';

/**
 * Name of a run record file: its ISO start timestamp with `:` replaced by `-`
 * (`2026-03-04T09-00-00.000Z.json`), so names sort in start order. Only such
 * names are listed as records or ever removed by pruning.
 */
const RUN_RECORD_FILE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d{1,9})?Z\.json$/;

/** The file name a run record is saved under. */
function runRecordFileName(record: RunRecord): string {
  return record.startedAt.replace(/:/g, '-') + '.json';
}

/** What `runs/latest.json` holds. */
interface LatestRunPointer {
  readonly version: 1;
  /** File name of the newest run record. */
  readonly file: string;
  /** {@link countConsecutiveFailures} through that record (capped). */
  readonly consecutiveFailures: number;
}

/** The newest record and failure streak of a job, however they were found. */
interface LatestRunState {
  readonly file: string | undefined;
  readonly consecutiveFailures: number;
}

/**
 * Records a completed run, atomically, and points `runs/latest.json` at it.
 * Filenames are unique (timestamp-based), and the daemon runs one run of a
 * job at a time and holds the daemon lock (as does a local `run-job`), so no
 * lock is needed.
 *
 * Only the `runs/` directory is created: the job's own directory must still
 * exist, so a record for a job removed while it ran fails (ENOENT) instead of
 * recreating a stray `jobs/{jobId}/` tree after deleteJob() removed it.
 *
 * The pointer is an index, written after the record: when it cannot be
 * written the record is still saved, the stale pointer is removed (best
 * effort), and readers list the directory instead.
 */
export function saveRunRecord(jobId: JobId, record: RunRecord): void {
  const runsDir = getJobRunsDir(jobId);
  try {
    mkdirSync(runsDir);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }

  const filename = runRecordFileName(record);
  // The streak before this run, read before the new record exists.
  const previous = readLatestRunState(jobId);
  atomicWriteTextSync(resolve(runsDir, filename), JSON.stringify(record, null, 2) + '\n', {
    createParentDirs: false,
    fsync: true,
  });
  updateLatestRunPointer(jobId, filename, record, previous);
}

/** Points `runs/latest.json` at the record just saved as `filename`. Never throws. */
function updateLatestRunPointer(jobId: JobId, filename: string, record: RunRecord, previous: LatestRunState): void {
  const pointerPath = resolve(getJobRunsDir(jobId), LATEST_RUN_POINTER_FILE);
  try {
    let next: LatestRunState;
    if (!RUN_RECORD_FILE_RE.test(filename) || (previous.file !== undefined && previous.file >= filename)) {
      // Saved out of order (the clock went back) or over an existing record:
      // the incremental streak would be wrong, so count again from the files.
      next = scanLatestRunState(jobId);
    } else {
      next = {
        file: filename,
        consecutiveFailures:
          record.outcome.kind === 'error' ? Math.min(previous.consecutiveFailures + 1, MAX_COUNTED_FAILURES) : 0,
      };
    }
    if (next.file === undefined) {
      rmSync(pointerPath, { force: true });
      return;
    }
    const pointer: LatestRunPointer = { version: 1, file: next.file, consecutiveFailures: next.consecutiveFailures };
    atomicWriteTextSync(pointerPath, JSON.stringify(pointer) + '\n', { createParentDirs: false });
  } catch {
    try {
      rmSync(pointerPath, { force: true });
    } catch {
      // Readers check that the pointer names an existing record; a stale one
      // that names the previous record is the worst case.
    }
  }
}

/**
 * The pointer in `runs/latest.json` when it is valid and names a record that
 * exists; undefined otherwise (readers then list the directory).
 */
function readLatestRunPointer(jobId: JobId): LatestRunPointer | undefined {
  try {
    const runsDir = getJobRunsDir(jobId);
    const raw = JSON.parse(readFileSync(resolve(runsDir, LATEST_RUN_POINTER_FILE), 'utf-8')) as unknown;
    if (typeof raw !== 'object' || raw === null) return undefined;
    const { version, file, consecutiveFailures } = raw as Record<string, unknown>;
    if (version !== 1 || typeof file !== 'string' || !RUN_RECORD_FILE_RE.test(file)) return undefined;
    if (typeof consecutiveFailures !== 'number' || !Number.isSafeInteger(consecutiveFailures)) return undefined;
    if (consecutiveFailures < 0) return undefined;
    if (!existsSync(resolve(runsDir, file))) return undefined;
    return { version, file, consecutiveFailures: Math.min(consecutiveFailures, MAX_COUNTED_FAILURES) };
  } catch {
    return undefined;
  }
}

/** The newest record and the failure streak: from the pointer, else by listing the directory. */
function readLatestRunState(jobId: JobId): LatestRunState {
  return readLatestRunPointer(jobId) ?? scanLatestRunState(jobId);
}

/** {@link readLatestRunState} by listing the directory (no pointer). */
function scanLatestRunState(jobId: JobId): LatestRunState {
  const files = listRunFiles(jobId);
  return { file: files.at(0), consecutiveFailures: countFailuresInFiles(jobId, files) };
}

/**
 * Run record file names of a job, newest first (names are ISO start
 * timestamps, so a plain comparison orders them). The pointer, temporary
 * files and anything else not named like a record are left out.
 */
function listRunFiles(jobId: JobId): string[] {
  let runsDir: string;
  try {
    runsDir = getJobRunsDir(jobId);
  } catch {
    return [];
  }
  if (!existsSync(runsDir)) return [];

  let files: string[];
  try {
    files = readdirSync(runsDir).filter((f) => RUN_RECORD_FILE_RE.test(f));
  } catch {
    return [];
  }

  return files.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}

/** Run records of one job that retention would remove. */
export interface PrunableRunRecords {
  /** The job's `runs/` directory. */
  readonly runsDir: string;
  /** Run records kept (the newest ones). */
  readonly kept: number;
  /** File names of the older records, newest first. */
  readonly files: readonly string[];
}

/**
 * The run records of `jobId` beyond its newest `keep` (at least 1), which
 * pruning removes. The record `latest.json` points at is never among them.
 */
export function listPrunableRunRecords(jobId: JobId, keep: number): PrunableRunRecords {
  const runsDir = getJobRunsDir(jobId);
  const keepCount = Math.max(1, Math.floor(keep));
  const files = listRunFiles(jobId);
  const pointed = readLatestRunPointer(jobId)?.file;
  const older = files.slice(keepCount).filter((file) => file !== pointed);
  return { runsDir, kept: files.length - older.length, files: older };
}

/** Parses one run record file; undefined when it is unreadable or malformed. */
function readRunFile(jobId: JobId, file: string): RunRecord | undefined {
  try {
    return JSON.parse(readFileSync(resolve(getJobRunsDir(jobId), file), 'utf-8')) as RunRecord;
  } catch {
    return undefined;
  }
}

/**
 * Loads recent run records for a job, most recent first.
 * @param limit Maximum number of records to return (default 10).
 */
export function loadRecentRuns(jobId: JobId, limit: number = 10): RunRecord[] {
  const records: RunRecord[] = [];
  for (const file of listRunFiles(jobId).slice(0, limit)) {
    const record = readRunFile(jobId, file);
    // Skip malformed run records
    if (record) records.push(record);
  }
  return records;
}

/**
 * The newest run record of a job, or undefined when it has none. Reads the
 * record `latest.json` points at, so a job listing does not list every
 * record; without a usable pointer it is `loadRecentRuns(jobId, 1)[0]`.
 */
export function loadLatestRun(jobId: JobId): RunRecord | undefined {
  const pointer = readLatestRunPointer(jobId);
  const record = pointer === undefined ? undefined : readRunFile(jobId, pointer.file);
  return record ?? loadRecentRuns(jobId, 1)[0];
}

/** True for a parsed run record that carries the `outcome.kind` every record has. */
function hasOutcomeKind(record: unknown): record is RunRecord {
  if (typeof record !== 'object' || record === null || !('outcome' in record)) return false;
  const { outcome } = record;
  return typeof outcome === 'object' && outcome !== null && 'kind' in outcome && typeof outcome.kind === 'string';
}

/** The failure streak over `files` (newest first), skipping malformed records. */
function countFailuresInFiles(jobId: JobId, files: readonly string[]): number {
  let failures = 0;
  for (const file of files) {
    const record = readRunFile(jobId, file);
    if (!hasOutcomeKind(record)) continue;
    if (record.outcome.kind !== 'error') break;
    failures += 1;
    if (failures >= MAX_COUNTED_FAILURES) break;
  }
  return failures;
}

/**
 * Number of the job's most recent runs that ended in an error (outcome
 * `error`, any phase), counted newest first up to the first run that did
 * not, and capped at {@link MAX_COUNTED_FAILURES}. Zero when the latest run
 * succeeded or exhausted its budget, or when there are no runs. Malformed
 * records (unparseable, or JSON without an `outcome.kind`) are skipped.
 *
 * Taken from `latest.json`, which every saved record updates, so pruning old
 * records does not shorten a streak; without a usable pointer the records
 * are read.
 *
 * Never throws: daemon status and every job listing call it for each job
 * (status on the web UI's periodic broadcast), so one malformed record, or an
 * id that names no job directory, must not take those down. Such a job counts
 * as having no failures.
 */
export function countConsecutiveFailures(jobId: JobId): number {
  try {
    return readLatestRunState(jobId).consecutiveFailures;
  } catch {
    return 0;
  }
}
