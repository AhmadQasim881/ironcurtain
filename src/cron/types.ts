/**
 * Cron Mode types -- job definitions, run records, and budget overrides.
 *
 * These types are used by the job store, cron scheduler, daemon,
 * and CLI commands.
 */

import { validateSlug } from '../types/slug.js';
import type { BudgetCostSource } from '../session/types.js';

/**
 * Stable, user-chosen identifier for a cron job.
 * Must be a valid slug: lowercase alphanumeric, hyphens, underscores.
 * Branded to prevent mixing with other string identifiers.
 */
export type JobId = string & { readonly __brand: 'JobId' };

/** Validates and creates a JobId from a user-provided string. */
export function createJobId(raw: string): JobId {
  validateSlug(raw, 'job ID');
  return raw as JobId;
}

/**
 * A job operation named a job that does not exist. Callers in other layers
 * (the web UI maps it to the `JOB_NOT_FOUND` RPC error) branch on `code`
 * rather than `instanceof`; see {@link isJobNotFoundError}.
 */
export class JobNotFoundError extends Error {
  readonly code = 'JOB_NOT_FOUND' as const;

  constructor(readonly jobId: string) {
    super(`Job not found: ${jobId}`);
    this.name = 'JobNotFoundError';
  }
}

/** Discriminant check for {@link JobNotFoundError} (no `instanceof`). */
export function isJobNotFoundError(err: unknown): err is Error & { readonly code: 'JOB_NOT_FOUND' } {
  return err instanceof Error && (err as { code?: unknown }).code === 'JOB_NOT_FOUND';
}

/**
 * A job operation named a job whose job.json exists but cannot be used: it is
 * not valid JSON, misses or mistypes a field, or its `id` does not name its
 * directory. Distinct from {@link JobNotFoundError} so the user is told to
 * fix (or remove) the file rather than that the job does not exist. Callers
 * in other layers branch on `code` (see {@link isInvalidJobError}).
 */
export class InvalidJobError extends Error {
  readonly code = 'JOB_INVALID' as const;

  constructor(
    readonly jobId: string,
    /** Path of the invalid job.json. */
    readonly path: string,
    /** Why it is invalid. Can quote the file's content: display it escaped. */
    readonly reason: string,
  ) {
    super(`Job "${jobId}" cannot be used: its job.json is invalid (${reason})`);
    this.name = 'InvalidJobError';
  }
}

/** Discriminant check for {@link InvalidJobError} (no `instanceof`). */
export function isInvalidJobError(err: unknown): err is InvalidJobError {
  return err instanceof Error && (err as { code?: unknown }).code === 'JOB_INVALID';
}

/** Per-job memory configuration. Same shape as PersonaMemoryConfig. */
export interface JobMemoryConfig {
  /**
   * Whether the memory MCP server is mounted into sessions for this
   * job. Defaults to true when this whole block is absent. The global
   * kill switch (`userConfig.memory.enabled`) ANDs with this: if the
   * global is off, memory is off regardless of this field.
   */
  readonly enabled: boolean;
}

/**
 * Persisted job definition. Stored as JSON at
 * ~/.ironcurtain/jobs/{jobId}/job.json.
 *
 * Invariant: `taskConstitution` is the input for per-job policy
 * compilation, and the compiled policy records its sha256 as
 * `constitutionHash`. Before every run the daemon recomputes that hash
 * (src/cron/job-policy.ts) and refuses the run, recording an error
 * RunRecord, when the policy is missing or was compiled from different
 * text; editing the constitution therefore requires a recompile
 * (`edit-job` does it, or `recompile-job`). A job with `persona` set is
 * checked against the persona's policy instead.
 */
export interface JobDefinition {
  /** Stable user-chosen slug. Matches the directory name. */
  readonly id: JobId;

  /** Human-friendly display name. */
  readonly name: string;

  /** Standard cron expression (5 fields: min hour dom mon dow). */
  readonly schedule: string;

  /**
   * English task description sent to the agent as its work prompt.
   */
  readonly taskDescription: string;

  /**
   * English constitution text used as the policy compilation input.
   * Describes what the agent is and is not permitted to do.
   */
  readonly taskConstitution: string;

  /**
   * Working directory for this job. Persists across runs.
   * Default: ~/.ironcurtain/jobs/{jobId}/workspace/
   * A custom one is checked with validateWorkspacePath() before every run
   * (add-job and edit-job store the canonical path it returns), and the
   * job's task policy is compiled against it: changing it needs a
   * recompile, which the run-time policy check cannot detect (it compares
   * the constitution hash only). edit-job revokes the old policy and
   * recompiles; after a hand edit, run recompile-job.
   */
  readonly workspace?: string;

  /**
   * Optional git repository URI to clone into the workspace.
   * Before every run the daemon fetches it into a daemon-owned mirror
   * (~/.ironcurtain/jobs/{jobId}/repo.git), rebuilds the workspace .git
   * from that mirror and hard-resets the tracked files to the remote's
   * default branch (untracked files preserved). Changing it re-clones the
   * mirror. See src/cron/git-sync.ts.
   */
  readonly gitRepo?: string;

  /**
   * When true and Signal is configured, the daemon sends the escalation's
   * Signal banner and waits for approval (up to escalationTimeoutSeconds);
   * the escalation can also be decided in the web UI. When false while
   * Signal is configured, escalations are auto-denied. When Signal is not
   * configured, this flag does not apply: an escalation waits for approval
   * in the web UI while a browser client is connected to it, and is
   * auto-denied when none is.
   */
  readonly notifyOnEscalation: boolean;

  /**
   * When true and Signal is configured, the daemon sends a Signal
   * message with the run summary on completion.
   */
  readonly notifyOnCompletion: boolean;

  /**
   * Per-job resource budget overrides, field by field. An absent field
   * leaves the limit to the persona's `resourceBudget` (for a persona job),
   * else to the cron-specific defaults; `null` removes the limit (see
   * session/model-budget-precedence.ts).
   */
  readonly budgetOverrides?: Partial<JobBudgetOverrides>;

  /**
   * Optional persona name. When set, the job runs under this persona's
   * compiled policy (and its agent model and resource limits) instead of
   * a policy compiled from taskConstitution, which is then not used at
   * all: add-job and edit-job neither require nor compile it.
   */
  readonly persona?: string;

  /** Whether this job is active. Disabled jobs are not scheduled. */
  readonly enabled: boolean;

  /**
   * Optional memory configuration. Absent = use defaults (memory on,
   * subject to the global kill switch). Present = explicit per-job
   * choice, persisted across upgrades.
   */
  readonly memory?: JobMemoryConfig;
}

/**
 * Budget fields that can be overridden per-job.
 * All fields are nullable: null means "disable this limit".
 */
export interface JobBudgetOverrides {
  readonly maxTotalTokens: number | null;
  readonly maxSteps: number | null;
  readonly maxSessionSeconds: number | null;
  readonly maxEstimatedCostUsd: number | null;
}

/**
 * Where a failed run stopped:
 * - `setup`: before the agent ran (configuration, workspace validation, the
 *   job's policy check, preparing the workspace, creating the session);
 * - `sync`: the pre-run git sync of `gitRepo`;
 * - `session`: while the agent session ran.
 */
export type RunFailurePhase = 'setup' | 'sync' | 'session';

/**
 * Outcome status for a completed run.
 */
export type RunOutcome =
  | { readonly kind: 'success' }
  | { readonly kind: 'budget_exhausted'; readonly dimension: string }
  | {
      readonly kind: 'error';
      readonly message: string;
      /** Where the run failed. Absent in records written before phases were recorded. */
      readonly phase?: RunFailurePhase;
    };

/**
 * Longest failure streak countConsecutiveFailures() counts (it reads one run
 * record per failed run); a longer streak reports this value.
 */
export const MAX_COUNTED_FAILURES = 100;

/** Discriminant of {@link JobAlreadyRunningError}; match on it rather than `instanceof`. */
export const JOB_ALREADY_RUNNING = 'JOB_ALREADY_RUNNING';

/**
 * Refusal to start a run of a job whose previous run (scheduled or manual)
 * has not finished yet. Raised before anything of the new run starts.
 */
export class JobAlreadyRunningError extends Error {
  readonly code = JOB_ALREADY_RUNNING;

  constructor(
    readonly jobId: string,
    /** Session label of the run in progress; undefined while it is still being set up. */
    readonly sessionLabel?: number,
  ) {
    super(
      `Job "${jobId}" is already running` +
        (sessionLabel === undefined ? ' (its session is starting)' : ` (session #${sessionLabel})`),
    );
    this.name = 'JobAlreadyRunningError';
  }
}

/** True for a {@link JobAlreadyRunningError}, recognized by its `code` so other layers need not import the class. */
export function isJobAlreadyRunningError(error: unknown): error is JobAlreadyRunningError {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === JOB_ALREADY_RUNNING;
}

/**
 * Persisted run record. Written to
 * ~/.ironcurtain/jobs/{jobId}/runs/{timestamp}.json
 * after each run completes.
 */
export interface RunRecord {
  /** ISO 8601 start time. Also used as the filename. */
  readonly startedAt: string;

  /** ISO 8601 end time. */
  readonly completedAt: string;

  /** How the run ended. */
  readonly outcome: RunOutcome;

  /**
   * What the run consumed: the session's cumulative totals over every turn
   * (the task and any memory auto-save turn). `elapsedSeconds` is active time.
   */
  readonly budget: {
    readonly totalTokens: number;
    readonly stepCount: number;
    readonly elapsedSeconds: number;
    readonly estimatedCostUsd: number;
    /**
     * Where `estimatedCostUsd` comes from (see `BudgetCostSource`). Absent in
     * records of sessions that price every step themselves and in older
     * records; `unknown` means no cost was reported (shown as "unknown").
     */
    readonly costSource?: BudgetCostSource;
  };

  /**
   * Brief summary the run's agent wrote to last-run.md at the workspace root,
   * read after the session ended (see src/cron/run-summary.ts): terminal
   * control sequences and control characters removed, bidi controls shown as
   * escapes, truncated to 2000 characters. Null when the run wrote none (the
   * previous run's file is moved to previous-run.md before every run), when
   * last-run.md is not a regular file, or when the run never reached its
   * session.
   */
  readonly summary: string | null;

  /**
   * The notices the run's session reported for the user (see
   * `isSessionNotice` in src/session/startup-notices.ts): a stale compiled
   * policy, an MCP server that did not start, setuid/setgid or root-owned
   * files the agent left in its host mounts, ... One entry per notice, its
   * display text (line feeds kept), bounded in number and length (see
   * src/cron/run-summary.ts). Absent when there were none, and in older
   * records.
   */
  readonly notices?: readonly string[];

  /** Whether any escalations were surfaced during this run. */
  readonly escalationsEncountered: number;

  /** Whether any escalations were approved (vs. denied or timed out). */
  readonly escalationsApproved: number;

  /**
   * git diff --stat of the tracked-file changes the pre-run sync discarded,
   * relative to the commit the previous sync checked out (never upstream
   * changes). Null when there were none or no previous sync was recorded.
   */
  readonly discardedChanges: string | null;
}

/** Cron-specific budget defaults (differ from interactive defaults). */
export const CRON_BUDGET_DEFAULTS: Required<JobBudgetOverrides> = {
  maxTotalTokens: 500_000,
  maxSteps: 100,
  maxSessionSeconds: 3_600,
  maxEstimatedCostUsd: 2.0,
};
