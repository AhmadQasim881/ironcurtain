# Design: Cron Mode

**Status (2026-11-14):** Implemented: cron jobs run in the daemon (`src/cron/`, `src/daemon/`) and are managed with `ironcurtain daemon add-job`, `edit-job`, `list-jobs`, `run-job`, `recompile-job` and related commands; each job runs under a policy compiled from its own task constitution. The scheduler no longer uses `node-cron`: `src/cron/cron-scheduler.ts` computes fire times itself and polls every 30 seconds.

**Date:** 2026-03-04
**Author:** IronCurtain Engineering

> **Note (2026-03):** References to `memory.md` as a cross-run memory mechanism in this document are historical. Persistent agent memory is now handled by the memory MCP server (see `memory-mcp-server-v2.md`). The `last-run.md` workspace file is still used.

## 1. Problem Statement

IronCurtain currently supports two interaction patterns: single-shot tasks (`ironcurtain start "task"`) and interactive sessions (CLI or Signal bot). Both require a human to initiate the work. Many valuable use cases -- GitHub issue triage, daily code health checks, scheduled backups, inbox summaries -- are inherently periodic and should run unattended on a schedule.

Adding cron capability requires solving several interrelated problems:

1. **Scheduling infrastructure.** A long-running process that fires agent sessions at cron-scheduled times.
2. **Headless escalation.** The policy engine may escalate tool calls that require human approval, but there is no interactive human present. The default must be safe (auto-deny), with an optional path to notify and wait for approval via Signal.
3. **Per-job policy scoping.** A job that triages GitHub issues should be able to list issues and add labels, but must not push code or delete files. The global constitution is too broad -- each job needs a task-scoped whitelist compiled from its English description.
4. **Cross-run persistence.** Scheduled jobs run repeatedly. The agent needs a stable workspace to maintain state across runs (what it did last time, what changed since then).
5. **Daemon unification.** The existing `ironcurtain bot` command already runs a long-lived daemon for Signal. Running a second daemon for cron doubles operational complexity. A unified daemon should handle both.

### Motivating example: GitHub Issue Triage

**Task description:** "Triage open GitHub issues on the ironcurtain repo: label each issue by type (bug/feature/question/docs), add a comment on issues that haven't been updated in 14+ days asking for status, and close issues with no response for 30+ days. Write a brief summary of what you did."

**Expected per-job policy behavior:**

- Allow: `github.list_issues`, `github.get_issue`, `github.add_label`, `github.create_comment`, `github.update_issue`
- Escalate: `github.close_issue` (consequential -- even though the task authorizes it for stated conditions, the per-job compiler should recognize "close issues" as an explicit allowance and generate an `allow` rule for `close_issue` when the task description specifically authorizes it)
- Deny (default fallthrough): everything else -- `filesystem.write_file` outside workspace, `github.create_pull_request`, `exec.*`, etc.

**Expected run lifecycle:**

1. Cron fires at 09:00 daily
2. Daemon creates a session with the job's workspace and per-job policy
3. Agent reads `workspace/memory.md` for context from previous runs
4. Agent triages issues, writes actions to `workspace/last-run.md`
5. If `close_issue` was compiled as `escalate` and Signal is configured with `notifyOnEscalation: true`, the daemon sends a Signal message and waits for approval
6. On completion, daemon sends a Signal notification with the summary (if `notifyOnCompletion: true`)
7. Run outcome recorded to `~/.ironcurtain/jobs/{jobId}/runs/{timestamp}.json`

## 2. Design Overview

Cron Mode is implemented as an extension of the daemon lifecycle. A new `IronCurtainDaemon` class composes the existing `SignalBotDaemon` (for Signal transport) with a `CronScheduler` (for timed job execution). Both register `ManagedSession` entries via a shared `SessionManager` (extracted from `SignalBotDaemon`), enabling Signal-based escalation approval for cron-initiated sessions.

```
                          ironcurtain daemon
                                |
                     +----------+-----------+
                     |                      |
              IronCurtainDaemon             |
              (unified lifecycle)           |
                     |                      |
          +----------+----------+           |
          |                     |           |
   SignalBotDaemon       CronScheduler      |
   (WebSocket + sessions) (node-cron)       |
          |                     |           |
          +-----+-------+------+           |
                |       |                   |
           ManagedSession Map               |
           (shared, label-keyed)            |
                |                           |
         +------+------+                   |
         |             |                   |
   Signal sessions  Cron sessions          |
   (interactive)    (headless)             |
         |             |                   |
         +------+------+                   |
                |                          |
         Escalation routing                |
         (approve <code> / deny <code>)    |
                                           |
                                  ~/.ironcurtain/jobs/
                                  +-- {jobId}/
                                  |   +-- job.json
                                  |   +-- generated/
                                  |   |   +-- compiled-policy.json
                                  |   |   +-- dynamic-lists.json (optional)
                                  |   +-- workspace/
                                  |   |   +-- memory.md
                                  |   |   +-- last-run.md
                                  |   +-- repo.git/  (gitRepo jobs: daemon-owned
                                  |   |              bare mirror, never mounted)
                                  |   +-- runs/
                                  |       +-- 2026-03-04T09-00-00.000Z.json
                                  |       +-- latest.json  (newest record +
                                  |                         failure streak)
                                  +-- {jobId2}/
                                      +-- ...

Note: tool-annotations.json is NOT stored per-job. Annotations
are always loaded from the global location (~/.ironcurtain/generated/
or the package-bundled fallback). Only compiled-policy.json (and
optionally dynamic-lists.json) are per-job artifacts.
```

## 3. Key Design Decisions

### 1. Unified `IronCurtainDaemon` composes `SignalBotDaemon` via extracted `SessionManager`.

**Rationale:** `SignalBotDaemon` has a well-defined responsibility (Signal WebSocket management, identity verification, message routing) and is already complex at ~900 lines. Cron scheduling is an orthogonal concern. Composition via a new `IronCurtainDaemon` class keeps both focused.

The session map and its lifecycle methods are extracted from `SignalBotDaemon` into a standalone `SessionManager` class. `IronCurtainDaemon` owns the `SessionManager` and passes it to both `SignalBotDaemon` and `CronScheduler`. This makes `SessionManager` the single owner of all session state, and decouples session lifecycle from any specific transport.

### 2. Cron sessions are `ManagedSession` entries in the shared session map.

**Rationale:** This is the key insight that makes escalation routing work for free. When a cron job hits an escalation and Signal is configured, the daemon hands it to `SignalBotDaemon.surfaceEscalation(label, request, { jobName })`, the same path an interactive session uses: the banner names the job (`ESCALATION [#7 cron: issue-triage] code K7Q2`), shows the arguments, and the user replies `approve K7Q2` just as they would for an interactive session. No new escalation mechanism is needed. (Approvals quote the banner's code rather than the session label, so a late reply cannot land on a different escalation; see "Escalation Banners and Replies" in `signal-transport.md`.)

Cron sessions are distinguished from Signal sessions by a `source` discriminant on `ManagedSession` (`'signal' | 'cron'`). This controls cleanup behavior (cron sessions auto-close on completion; Signal sessions wait for user input) and notification routing.

### 3. Headless escalation: auto-deny unless a human can be asked (Signal, or the web UI).

**Rationale:** Unattended jobs must fail safe. Auto-deny is the only safe default when no human is present. However, for jobs where the user wants human-in-the-loop oversight (e.g., closing GitHub issues), the daemon can notify via Signal and wait for a response, and without Signal it can wait for a decision in the web UI while a browser is connected to it.

The timeout behavior is: wait up to `escalationTimeoutSeconds` (from global config, default 300s). If no response arrives, auto-deny. The job continues with the denial (the agent sees a denied tool call and can adapt). This reuses the existing proxy-side escalation timeout mechanism -- the proxy writes a request file, polls for a response file, and times out if none appears.

Routing (`IronCurtainDaemon.handleCronEscalation`):

- **Signal configured, `notifyOnEscalation` true:** the coded Signal banner goes out (`SignalBotDaemon.surfaceEscalation`). The escalation is also shown in the web UI and can be decided in either place.
- **Signal not configured:** the escalation waits for a decision in the web UI when a browser is connected to it at that moment (an authenticated WebSocket client whose handshake carried an Origin; the CLI clients send none), up to the timeout. With no browser connected it is denied at once. `notifyOnEscalation` does not apply.
- **Signal configured, `notifyOnEscalation` false:** denied at once, even while a browser is connected.

Every case records the full request (server, tool, arguments, reason, context, whitelist candidates, and the reviewer context the session attached: the job's task and the agent's untrusted justification) on the session (`SessionManager.recordEscalation`), never an id-only placeholder, and every decision, the automatic deny included, goes through `SessionManager.resolveSessionEscalation`. The record carries no group key, so a cron escalation is decided on its own in the web UI, never as part of a group approval. The SessionManager tells its listeners about each pending, resolved and expired escalation, and the web UI server pushes those of cron and Signal sessions to browsers as `escalation.created` / `escalation.resolved` / `escalation.expired` (web sessions announce their own). An escalation denied at once is not announced (nobody is asked). The web UI never offers Approve, and `escalations.resolve` refuses an approval, for a pending escalation that does not name its server, tool and arguments; it can still be denied.

### 4. Per-job persistent workspace at `~/.ironcurtain/jobs/{jobId}/workspace/`.

**Rationale:** Each job needs stable state across runs. Using the existing `workspacePath` mechanism in `SessionOptions` is the natural fit -- the session factory already supports pointing `allowedDirectory` at an existing directory. The workspace persists indefinitely; the agent is instructed (via system prompt augmentation) to maintain `memory.md` and `last-run.md` as cross-run coordination files.

**Git sync (`gitRepo` jobs, `src/cron/git-sync.ts`).** The workspace, `.git` included, is agent-writable (bind-mounted read-write in Docker mode, the `allowedDirectory` in Code Mode), so host git never runs against it: a repository's own config, hooks, attributes and gitfile/`commondir` redirects would run agent-chosen programs on the host and let the agent choose what the daemon fetches. Before each run (and when a job is added) the daemon instead:

1. computes the discarded changes from the daemon-owned mirror `~/.ironcurtain/jobs/{jobId}/repo.git` (outside the workspace, never mounted, a protected path for Code Mode): the work tree against the commit the previous sync checked out, with a temporary index, `--no-ext-diff --no-textconv` and attributes from that commit;
2. fetches the validated `job.gitRepo` URL into the mirror with an explicit refspec (never a named remote), with `GIT_ALLOW_PROTOCOL` limited to the URL's scheme; a changed `gitRepo` re-clones the mirror;
3. builds a fresh `.git` from the mirror in a host-private staging directory, moves the workspace `.git` (directory, gitfile or symlink) aside without following it, hard-resets the tracked files with the staged git dir (files the new commit no longer tracks are deleted, untracked files are kept), and installs the staged `.git` so the agent keeps a working clone with `origin` set to `gitRepo` without the credentials a URL can embed (`stripUrlCredentials`: the whole userinfo of an http(s) URL, the password of any other). Embedded credentials stay host-side, in `job.json` and the mirror's config, and only IronCurtain's own fetches use them; an agent that pushes needs credentials of its own.

Every git command is asynchronous with a per-operation timeout and a process-group kill (`runGit`), uses `hardenedGitEnv` (no prompts or askpass, ssh `BatchMode`/`ConnectTimeout`/`ServerAlive*`, http low-speed limits, no LLM provider keys), and names its repository with `--git-dir`. A failed or timed-out sync (`sync_error`/`sync_timeout`) ends the run with an error record before any session starts. A user-supplied `workspace` must be empty the first time it is synced. The agent's local git history does not survive a sync.

### 5. Per-job policy replaces global constitution (not layered on top).

**Rationale:** The global constitution is designed for general-purpose interactive sessions. A cron job has a narrow, well-defined scope. Layering per-job rules on top of the global constitution would be confusing (which wins?) and would allow the broad global rules to permit operations the job should not perform. Instead, the per-job policy is authoritative:

Evaluation order for cron sessions:

1. Structural invariants (always, hardcoded) -- protected paths, sandbox containment, unknown tools
2. Per-job compiled rules (from `~/.ironcurtain/jobs/{jobId}/generated/compiled-policy.json`)
3. Default deny (no matching rule)

The global constitution is not consulted. This makes the per-job policy a true whitelist: only operations explicitly generated from the task description are permitted.

### 6. Policy compilation reuses the existing pipeline via `PipelineRunner`.

**Rationale:** The existing pipeline (`constitution-compiler.ts`, `policy-verifier.ts`, scenario generation, verify-and-repair loop) is battle-tested and handles content-hash caching, multi-turn repair, and structural conflict filtering. Duplicating this for per-job compilation would be a maintenance burden.

Instead, a `PipelineRunner` class (see Section 4.7) encapsulates the full compile-verify-repair loop behind a `run(config)` method. The `constitutionKind` discriminant selects the prompt variant:

- `'constitution'`: existing broad-principle compilation (used by `compile.ts` CLI)
- `'task-policy'`: whitelist-generation from task description (used by `compileTaskPolicy()`)

The `PipelineRunConfig` parameterizes:

- Input: `constitutionInput` -- task description string or constitution markdown
- Output: `outputDir` -- `~/.ironcurtain/jobs/{jobId}/generated/` for per-job
- Annotations: `toolAnnotationsDir` -- always the global generated directory
- Content hash: computed over the input text and prompt variant

Tool annotations (`tool-annotations.json`) are loaded from the global generated directory. Per-job compilation does not re-annotate tools -- that is a global operation run via `ironcurtain annotate-tools`.

### 7. Cron sessions get a `source: 'cron'` label and are visible in `/sessions`.

**Rationale:** Signal users need to see cron sessions alongside interactive ones for escalation management. The `/sessions` command output distinguishes them:

```
Sessions:
  #1 [signal] turns: 3, budget: 12%
  #5 [cron: issue-triage] running, budget: 8%
  #6 [cron: code-health] completed 2m ago
```

Cron session labels use the same numeric sequence as Signal sessions. This keeps escalation routing uniform -- `approve <code>`, `approve+ <code>`, `deny #5`, `details <code>` (or `/show <code>`) and `/pending` work regardless of whether session #5 is Signal- or cron-initiated.

### 8. Skip-on-overlap for concurrent runs of the same job.

**Rationale:** If a job fires while a previous run of the same job is still active, the new run is skipped with a warning notification via Signal (if configured). Queuing introduces unbounded backlog risk for jobs that consistently exceed their schedule interval. Skipping is the safer default for unattended systems -- the next scheduled invocation will pick up where the previous one should have finished.

The daemon tracks `activeJobRuns: Map<JobId, ActiveJobRun>` to detect overlap. A run is reserved synchronously as the first step of `executeJob()`, before its git sync and before its session is created (Docker image preparation can take minutes), and the reservation is released only after the run's record is written. The reservation object is the run's token: cleanup removes the map entry only while it still holds that object. The label is filled in once the session is registered. Manual runs go through the same reservation: `startJobRun()` (the control socket's accept-then-poll `run-job` and web `jobs.run`, both of which reply before the run ends) throws, and `runJobNow()` (the CLI's local fallback when no daemon is running) rejects, a `JOB_ALREADY_RUNNING` error (`JobAlreadyRunningError`) before anything starts, so neither `run-job` nor `jobs.run` replies "accepted" for a run that does not happen. Overlapping runs would otherwise sync the workspace under a live agent (dropping its unpushed commits) and share the job's escalation routing. `listJobs()` reports `isRunning` from the moment of reservation, so the web UI's Run button is disabled while a run is still starting.

The reservation is per job. Two jobs whose `workspace` is the same directory, or a job and a workflow run on it, are kept apart by the workspace lock workflow runs take (`claimWorkflowWorkspaceLock` in `src/workflow/run-lock.ts`): a crash-recoverable process lock under `~/.ironcurtain/workflow-workspace-locks/`, keyed by the directory's device and inode, so every name for the directory maps to one lock and processes exclude one another. A run claims it after its policy checks and before its git sync (a job's default workspace is created first when missing) and releases it once its session has ended and its summary has been read. While another job's run or a workflow holds it, the run is refused without a sync or a session: an `error` record (phase `setup`, `Workspace <path> is in use by a workflow or cron job running in ... (pid N)`) and the Signal "Not run" notice. A workspace nested inside another run's workspace is not detected.

### 9. Budget defaults for scheduled jobs differ from interactive sessions.

**Rationale:** Interactive sessions have a 30-minute wall-clock limit (appropriate for human-supervised work). Scheduled jobs may need to process many items (e.g., triage 50 issues) but should have tighter cost controls since they run unattended. Per-job `budgetOverrides` allow tuning per task.

Default budget for cron sessions:

- `maxTotalTokens`: 500,000 (lower than interactive 1M -- triage is focused)
- `maxSteps`: 100 (lower than interactive 200 -- prevent runaway loops)
- `maxSessionSeconds`: 3,600 (1 hour -- higher than interactive 30min; batch processing takes time)
- `maxEstimatedCostUsd`: 2.00 (lower than interactive $5 -- cost discipline for recurring jobs)

### 10. Run history is recorded to per-job `runs/` directory.

**Rationale:** Each completed run writes a summary to `~/.ironcurtain/jobs/{jobId}/runs/{timestamp}.json`. This provides an audit trail and enables the `daemon logs <id>` command to show recent run outcomes. Run records include: start time, end time, budget consumed, completion status (success/budget-exhausted/error), and a summary extracted from `last-run.md` if available.

**Retention.** Records accumulate one per run (a job every five minutes writes about 105,000 a year). `ironcurtain prune` (and the daemon with `retention.autoPrune`) keeps the newest `retention.jobRuns.maxRecords` (200 by default) of each job and removes the rest. `runs/latest.json` names the newest record and carries the failure streak, updated by every saved record, so `list-jobs`, `jobs.list` and `daemon status` read two small files per job instead of listing the directory, and pruning old records never shortens a streak. The pointer is only an index: when it is missing, unreadable, or names a record that is gone, the directory is listed as before. See [retention-and-prune.md](retention-and-prune.md).

Every run that starts produces a record, so an unattended job cannot fail silently: an invalid workspace, a missing or stale policy (§11.6), a failed git sync, a session that cannot be created (Docker down, missing credentials) and a failing agent session all end with an `error` outcome whose `phase` says where (`setup`, `sync` or `session`), and with the Signal completion notice when `notifyOnCompletion` is set. A run refused for its policy instead always gets a Signal "Not run" notice when Signal is configured, whatever `notifyOnCompletion` says, since the job will not run until someone recompiles it. So does a run refused because another job's run or a workflow holds its workspace (decision 8). A failure to write the record (ENOSPC, EIO, EROFS) is logged and never skips the run's cleanup, and no record is written for a job removed while it ran (the store never recreates a removed job's directory). `list-jobs`, the web UI, Signal `/jobs` and `daemon status` show each job's consecutive-failure count (`countConsecutiveFailures`: error runs in a row, newest first, capped at 100).

## 4. Interface Definitions

### 4.1 Job Definition

```typescript
// src/cron/types.ts

/**
 * Stable, user-chosen identifier for a cron job.
 * Must be a valid slug: lowercase alphanumeric, hyphens, underscores.
 * Branded to prevent mixing with other string identifiers.
 */
export type JobId = string & { readonly __brand: 'JobId' };

/** Validates and creates a JobId from a user-provided string. */
export function createJobId(raw: string): JobId {
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(raw)) {
    throw new Error(
      `Invalid job ID "${raw}": must be 1-63 chars, ` +
        `lowercase alphanumeric, hyphens, or underscores, ` +
        `starting with a letter or digit`,
    );
  }
  return raw as JobId;
}

/**
 * Persisted job definition. Stored as JSON at
 * ~/.ironcurtain/jobs/{jobId}/job.json.
 *
 * Invariant: the constitution input for per-job policy compilation
 * (`task` here; `taskConstitution` in the implementation) is recorded
 * in the compiled policy as its sha256 `constitutionHash`. The daemon
 * recomputes that hash before every run and refuses the run (error
 * RunRecord) when the policy is missing or was compiled from different
 * text (see §11.6).
 */
export interface JobDefinition {
  /** Stable user-chosen slug. Matches the directory name. */
  readonly id: JobId;

  /** Human-friendly display name. */
  readonly name: string;

  /** Standard cron expression (5 fields: min hour dom mon dow). */
  readonly schedule: string;

  /**
   * English task description. This is the "constitution" input
   * for per-job policy compilation. The LLM generates a whitelist
   * of allow/escalate rules covering exactly what this description
   * requires.
   */
  readonly task: string;

  /**
   * Working directory for this job. Persists across runs.
   * Default: ~/.ironcurtain/jobs/{jobId}/workspace/
   */
  readonly workspace?: string;

  /**
   * When true and Signal is configured, the daemon sends the Signal
   * banner and waits for approval (the web UI can decide too). When
   * false while Signal is configured, escalations are auto-denied.
   * Without Signal this flag does not apply: an escalation waits in
   * the web UI while a browser is connected, else it is auto-denied.
   */
  readonly notifyOnEscalation: boolean;

  /**
   * When true and Signal is configured, the daemon sends a Signal
   * message with the run summary on completion.
   */
  readonly notifyOnCompletion: boolean;

  /**
   * Per-job resource budget overrides. Null fields inherit from
   * the cron-specific defaults (not the interactive defaults).
   * Omit entirely to use cron defaults.
   */
  readonly budgetOverrides?: Partial<JobBudgetOverrides>;

  /** Whether this job is active. Disabled jobs are not scheduled. */
  readonly enabled: boolean;
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
```

### 4.2 Run Record

```typescript
// src/cron/types.ts (continued)

/**
 * Outcome status for a completed run.
 */
export type RunOutcome =
  | { readonly kind: 'success' }
  | { readonly kind: 'budget_exhausted'; readonly dimension: string }
  | {
      readonly kind: 'error';
      readonly message: string;
      /** setup | sync | session; absent in records written before phases were recorded. */
      readonly phase?: RunFailurePhase;
    };

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
    /** Docker sessions: where the cost comes from; `unknown` is shown as "unknown", not $0.00. */
    readonly costSource?: BudgetCostSource;
  };

  /**
   * Brief summary the run wrote to last-run.md at the workspace root, read
   * after the session ended (src/cron/run-summary.ts): control sequences and
   * characters removed, bidi controls escaped, truncated to 2000 chars. Null
   * if this run wrote none (the previous run's file is moved to
   * previous-run.md before every run) or it is not a regular file.
   */
  readonly summary: string | null;

  /** Whether any escalations were surfaced during this run. */
  readonly escalationsEncountered: number;

  /** Whether any escalations were approved (vs. denied or timed out). */
  readonly escalationsApproved: number;
}
```

### 4.3 Job Store

```typescript
// src/cron/job-store.ts

import type { JobDefinition, JobId, RunRecord } from './types.js';

/**
 * Filesystem-backed store for job definitions and run records.
 *
 * Directory layout:
 *   ~/.ironcurtain/jobs/{jobId}/
 *     job.json              -- JobDefinition
 *     generated/            -- per-job compiled policy artifacts
 *       compiled-policy.json
 *       dynamic-lists.json  -- (optional)
 *     workspace/            -- persistent agent workspace
 *     runs/                 -- run history
 *       2026-03-04T09:00:00.000Z.json
 *
 * Tool annotations (tool-annotations.json) are always loaded from
 * the global location (~/.ironcurtain/generated/ or package fallback),
 * never stored per-job.
 */

/** Returns the jobs base directory: ~/.ironcurtain/jobs/ */
export function getJobsDir(): string;

/** Returns the directory for a specific job: ~/.ironcurtain/jobs/{jobId}/ */
export function getJobDir(jobId: JobId): string;

/** Returns the generated artifacts directory for a job. */
export function getJobGeneratedDir(jobId: JobId): string;

/** Returns the workspace directory for a job. */
export function getJobWorkspaceDir(jobId: JobId): string;

/** Returns the runs directory for a job. */
export function getJobRunsDir(jobId: JobId): string;

/**
 * Reads and validates one job.json (zod schema; its `id` must name its
 * directory): `ok`, `missing`, or `invalid` with the reason. Never throws
 * for a problem with the file.
 */
export function readJob(jobId: JobId): JobReadResult;

/**
 * Loads a job definition from disk. Returns undefined if not found.
 * @throws InvalidJobError (code JOB_INVALID) for an invalid job.json.
 */
export function loadJob(jobId: JobId): JobDefinition | undefined;

/** Every job directory: the valid definitions and the invalid job.json files (with reasons). */
export function scanJobs(): { jobs: JobDefinition[]; invalid: InvalidJobEntry[] };

/** Loads all valid job definitions from disk (scanJobs().jobs). */
export function loadAllJobs(): JobDefinition[];

/**
 * Saves a job definition atomically (temp file, fsync, rename; trailing
 * newline) under the job's advisory lock. Creates the job directory.
 */
export function saveJob(job: JobDefinition): Promise<void>;

/** Load-modify-save under the job's lock (enable-job, disable-job). */
export function updateJob(jobId: JobId, update: (current: JobDefinition) => JobDefinition): Promise<JobDefinition>;

/**
 * Saves an interactive edit: only the fields changed since `original` are
 * applied, onto the definition on disk now, under the lock.
 */
export function saveEditedJob(original: JobDefinition, edited: JobDefinition): Promise<JobDefinition>;

/** Deletes a job and all its artifacts (generated, workspace, runs). */
export function deleteJob(jobId: JobId): void;

/** Records a completed run, atomically; never recreates a removed job's directory. */
export function saveRunRecord(jobId: JobId, record: RunRecord): void;

/**
 * Loads recent run records for a job, most recent first.
 * @param limit Maximum number of records to return (default 10).
 */
export function loadRecentRuns(jobId: JobId, limit?: number): RunRecord[];
```

**Validation and atomic writes.** `job.json` and run records are written to a unique temp file, fsynced and renamed into place, so a crash or a full disk leaves the previous file, never a torn one; `job.json` keeps its trailing newline. `job.json` is validated on every read (field types, a positive-number-or-null budget override, an `id` that names its directory; fields this version does not know are kept). An invalid file is not dropped silently: `list-jobs` (with or without a daemon) and `doctor` show `INVALID: <reason>`, the daemon logs it and names it at startup, job commands answer "its job.json is invalid (...)" instead of "Job not found", and `remove-job` still removes it. A schedule that does not parse does not make the job invalid (it is listed as `invalid schedule` and edit-job can fix it).

**Locking.** Writes of `job.json` hold `jobs/{jobId}/job.lock`, a `docker-workload/process-lock` record (pid, OS process-start identity, random token, published atomically with a hard link): a contender waits while a live owner holds it (never stealing it on a timeout), a crashed owner's lock is reclaimed by exactly one contender, and release removes only the lock this process published. `enable-job`/`disable-job` load, modify and save under the lock; `edit-job` applies only the fields the user changed onto the definition on disk at save time, so a change made while the editor was open (a `disable-job`) is kept.

### 4.4 Cron Scheduler

```typescript
// src/cron/cron-scheduler.ts

import type { JobDefinition, JobId } from './types.js';

/** `scheduled`: reached on time (at most 5 minutes late); `missed`: long past (sleep, blocked loop). */
export interface JobTrigger {
  readonly kind: 'scheduled' | 'missed';
  readonly scheduledFor: Date;
}

/**
 * Callback invoked when a scheduled job fires.
 * The daemon implements this to create a session.
 */
export type JobTriggerCallback = (job: JobDefinition, trigger: JobTrigger) => Promise<void>;

/**
 * Manages cron schedules for all enabled jobs, with a built-in 5-field
 * parser. Each job's next fire time is cached; a 30 s poll fires the jobs
 * whose time has come and computes their next one.
 *
 * Invariant: at most one schedule exists per jobId at any time.
 * Calling schedule() for an already-scheduled job replaces the
 * previous schedule.
 */
export interface CronScheduler {
  /**
   * Registers a job's schedule. The callback fires at each
   * scheduled time. Does not fire immediately.
   *
   * @throws InvalidCronExpressionError if the cron expression
   * in job.schedule is invalid or can never fire (a day of month
   * that occurs in none of its months, e.g. `0 0 31 2 *`).
   */
  schedule(job: JobDefinition, onTrigger: JobTriggerCallback): void;

  /** Removes a job's schedule. No-op if not scheduled. */
  unschedule(jobId: JobId): void;

  /** Removes all schedules. Called during shutdown. */
  unscheduleAll(): void;

  /** The cached next fire time, or undefined if the job is not scheduled. */
  getNextRun(jobId: JobId): Date | undefined;

  /** The definition a job is scheduled with (for runs waiting for a slot). */
  getScheduledJob(jobId: JobId): JobDefinition | undefined;
}

/** Creates a CronScheduler with built-in cron expression parsing. */
export function createCronScheduler(options?: { now?: () => Date; pollIntervalMs?: number }): CronScheduler;
```

**Next fire times** are computed by field arithmetic over local wall-clock time (jumping whole months, days and hours), never by scanning minute by minute, and are cached: status broadcasts and job listings read the cache. Nothing within the ten-year search horizon (every expression that parses fires within eight years: `0 0 29 2 *` from 2096 waits for 2104) is `undefined`, never an invented date. With day-of-week `*`, a day of month that occurs in none of the expression's months is rejected when parsed (`0 0 31 2 *`, `0 0 30 2 *`; Feb 29 is allowed); with day-of-week restricted, cron's OR rule makes such a job run on the weekdays.

**DST (Vixie cron rules).** A *fixed-time* job (minute and hour fields that do not start with `*`) fires each scheduled wall-clock minute at most once: in the repeated hour after a fall-back, at its first occurrence. A minute skipped by a spring-forward transition fires at the first minute after the gap for a fixed-time job (`30 2 * * *` runs at 03:00 on that day, once however many of its minutes the gap held). A *wildcard* job (minute or hour field starting with `*`, Vixie's MIN_STAR / HR_STAR) runs on every real minute that matches: it skips the gap and runs at its next minute that exists, and in the repeated fall-back hour it runs at both occurrences (`*/20 * * * *` keeps running every 20 minutes, `0 * * * *` runs at both 01:00s).

**Missed and late fires.** A fire time the poll reaches up to 5 minutes late (a briefly blocked event loop) runs as scheduled. One reached later (the machine slept) is a `missed` trigger, one per job however many fire times the gap covered: the daemon runs it once only with `cron.catchUpMissedRuns` (config.json, default off, as in standard cron) and otherwise logs it. Runs missed while the daemon was not running are not caught up. A clock set back (by more than a minute) recomputes every next fire time; after a set back of at most 3 hours (an NTP correction, say) a fixed-time job does not run again a time it already ran, while wildcard jobs run on, and a bigger set back starts afresh (Vixie cron).

**Concurrency cap.** `cron.maxConcurrentRuns` (config.json, default no limit) caps the runs the scheduler starts: a scheduled trigger that would exceed it waits in a FIFO queue (once per job) and starts when a run finishes, with the job's current scheduled definition; a job removed or disabled meanwhile is dropped. Manual runs (`run-job`, the web UI) are never refused but count toward the limit. `list-jobs` shows a waiting job as `QUEUED`.

### 4.5 IronCurtainDaemon

```typescript
// src/daemon/ironcurtain-daemon.ts

import type { SessionMode } from '../session/types.js';
import type { SessionManager, ManagedSession, SessionSource } from '../session/session-manager.js';
import type { SignalBotDaemon } from '../signal/signal-bot-daemon.js';
import type { CronScheduler } from '../cron/cron-scheduler.js';
import type { JobDefinition, JobId, RunRecord } from '../cron/types.js';

// SessionSource and ManagedSession are defined in src/session/session-manager.ts
// and re-exported here for convenience. See Section 4.6 for their definitions.
export type { SessionSource, ManagedSession } from '../session/session-manager.js';

export interface IronCurtainDaemonOptions {
  /** Session mode for both Signal and cron sessions. */
  readonly mode: SessionMode;
}

/**
 * Unified daemon managing both Signal-initiated interactive sessions
 * and cron-scheduled headless sessions.
 *
 * Lifecycle:
 *   1. start() -- takes the daemon singleton lock, binds the control socket
 *      (fatal on failure), loads jobs, starts Signal (if configured),
 *      schedules jobs
 *   2. Runs indefinitely, processing Signal messages and cron triggers
 *   3. shutdown() -- unschedules all jobs, cancels cron runs in progress
 *      (each records its outcome, bounded), ends all sessions, disconnects,
 *      releases the lock
 *
 * Session map is unified: both Signal and cron sessions share a single
 * Map<number, ManagedSession> with a shared label counter. This enables
 * Signal-based escalation approval for cron sessions via "approve <code>".
 */
export class IronCurtainDaemon {
  /**
   * Starts the daemon. Loads all enabled jobs, schedules them,
   * optionally starts the Signal transport. Returns a promise
   * that resolves when shutdown() is called. Rejects (with code
   * DAEMON_LOCK_BUSY) when another daemon holds the lock, and when
   * the control socket cannot be bound (see Section 8.7).
   */
  start(): Promise<void>;

  /** Graceful shutdown. Ends all sessions, unschedules all jobs. */
  shutdown(): Promise<void>;

  // --- Job management (called by CLI subcommands) ---

  /**
   * Adds a new job. Runs the full policy compilation pipeline
   * synchronously before confirming. Schedules the job if enabled; a policy
   * written without some servers (they failed to compile) is logged as a
   * warning. Not reachable over the control socket (no `add-job` request).
   * @throws on invalid job definition or compilation failure
   */
  addJob(job: JobDefinition): Promise<void>;

  /** Removes a job. Stops any active run, unschedules, deletes files. */
  removeJob(jobId: JobId): Promise<void>;

  /** Enables a previously disabled job. Schedules it. */
  enableJob(jobId: JobId): void;

  /** Disables a job. Unschedules it but preserves files. */
  disableJob(jobId: JobId): void;

  /**
   * Re-runs policy compilation for an existing job, then reloads it.
   * Resolves with the servers the written policy left out because they
   * failed to compile (the `recompile-job` reply, `{ failedServers }`).
   */
  recompileJob(jobId: JobId): Promise<RecompileJobResultDto>;

  /**
   * Starts a manual run and returns at once with its completion (the
   * control socket's accept-then-poll `run-job`, and web `jobs.run`). Does
   * not affect the cron schedule. The job is reserved before this returns;
   * it throws JOB_ALREADY_RUNNING (or JOB_NOT_FOUND) synchronously when no
   * run starts.
   */
  startJobRun(jobId: JobId): { readonly completion: Promise<RunRecord> };

  /**
   * Manually triggers a job run and waits for it (the CLI's local fallback
   * when no daemon is running). Does not affect the cron schedule.
   * Returns the run record on completion (every outcome is a record);
   * rejects with JOB_ALREADY_RUNNING while a run of the job is in progress.
   */
  runJobNow(jobId: JobId): Promise<RunRecord>;

  /** Lists all jobs with their schedules, last run status and failure streak. */
  listJobs(): Array<{
    job: JobDefinition;
    nextRun: Date | undefined;
    lastRun: RunRecord | undefined;
    isRunning: boolean;
    consecutiveFailures: number;
  }>;
}
```

**Message routing guard:** When the daemon's `forwardToSession()` is called (i.e., a Signal user sends a follow-up message), it must check `managed.source.kind` before forwarding:

```typescript
private async forwardToSession(label: number, text: string): Promise<void> {
  const managed = this.sessionManager.get(label);
  if (!managed) return;

  if (managed.source.kind !== 'signal') {
    logger.warn(
      `[Daemon] Ignoring message for cron session #${label} ` +
        `(job: ${managed.source.jobName}) -- cron sessions do not accept follow-up messages`,
    );
    this.signalDaemon?.sendSignalMessage(
      `Session #${label} is a cron job (${managed.source.jobName}). ` +
        `It does not accept messages. Use escalation commands (approve/deny <code>) instead.`,
    ).catch(() => {});
    return;
  }

  // Narrow transport to SignalSessionTransport for forwardMessage()
  const transport = managed.transport as SignalSessionTransport;
  // ... existing forwarding logic ...
}
```

Note: the escalation machinery (`surfaceEscalation`, `expireEscalation`, `handleEscalationReply`) is source-agnostic. It records each escalation in `managed.pendingEscalations` (a session can have several pending at once, each expiring on its own) and resolves it through `SessionManager.resolveSessionEscalation()`, so an `approve <code>` reply works identically whether session #5 is Signal-initiated or cron-initiated.

### 4.6 SessionManager

```typescript
// src/session/session-manager.ts

import type { Session, Transport } from './types.js';
import type { JobId } from '../cron/types.js';

/**
 * Source discriminant for managed sessions.
 * Determines cleanup behavior, notification routing, and
 * message forwarding eligibility.
 *
 * - 'signal': interactive session created via Signal message.
 *   Accepts follow-up messages via forwardToSession().
 * - 'cron': headless session created by the cron scheduler.
 *   Does NOT accept follow-up messages -- forwardToSession()
 *   logs a warning and returns for cron sessions.
 */
export type SessionSource =
  { readonly kind: 'signal' } | { readonly kind: 'cron'; readonly jobId: JobId; readonly jobName: string };

/**
 * Unified managed session entry. Used for both Signal-initiated
 * interactive sessions and cron-initiated headless sessions.
 *
 * The transport field uses the base Transport interface, not
 * SignalSessionTransport, because cron sessions use HeadlessTransport.
 * Code that needs Signal-specific methods (e.g., forwardMessage())
 * must guard on source.kind === 'signal' and narrow the transport type.
 *
 * The escalation machinery (handleEscalationReply, setPendingEscalation,
 * clearPendingEscalation) requires NO changes -- it operates on
 * session.resolveEscalation() directly, which works identically for
 * both session kinds. Escalation state lives on ManagedSession and
 * is source-agnostic.
 */
export interface ManagedSession {
  readonly label: number;
  readonly session: Session;
  readonly transport: Transport;
  readonly source: SessionSource;
  messageInFlight: boolean;
  /** Every pending escalation, by id (see daemon-web-ui.md section 6.1). */
  readonly pendingEscalations: Map<string, PendingEscalationData>;
  /** Ids of the pending escalations whose resolution is in progress. */
  readonly escalationsResolving: Set<string>;
}

/**
 * Owns all managed session state. Both SignalBotDaemon and
 * CronScheduler delegate to this class for session registration,
 * lookup, and teardown.
 *
 * Invariants:
 * - Labels are monotonically increasing integers starting at 1.
 * - At most one session exists per label.
 * - currentLabel is always either null (no sessions) or a valid
 *   label in the sessions map.
 */
export class SessionManager {
  private sessions = new Map<number, ManagedSession>();
  private nextLabel = 1;

  /**
   * The currently "focused" session label for Signal message routing.
   * When a Signal message arrives without an explicit #N prefix, it
   * is routed to this session. Null when no sessions are active.
   *
   * Only updated by register() for Signal sessions (source.kind === 'signal').
   * Cron sessions do not accept follow-up messages, so registering one
   * must not steal the Signal user's focus -- the next untagged Signal
   * message should still go to the interactive session the user was
   * talking to, not to a background cron job that cannot process it.
   *
   * On end(): if the ended session was currentLabel, switches to the
   * most recently registered remaining Signal session (or null if
   * none remain). Cron sessions are skipped during this fallback search.
   */
  currentLabel: number | null = null;

  /**
   * Registers a new session and returns its assigned label.
   *
   * For Signal sessions (source.kind === 'signal'): sets currentLabel
   * to the new session, matching the existing SignalBotDaemon behavior
   * where the most recently created session receives untagged messages.
   *
   * For cron sessions (source.kind === 'cron'): the session is added
   * to the map and assigned a label, but currentLabel is NOT changed.
   * This prevents background cron jobs from stealing Signal focus.
   */
  register(session: Session, transport: Transport, source: SessionSource): number;

  /**
   * Ends a session by label: closes the transport, closes the
   * session, and removes it from the map. If the ended session
   * was currentLabel, switches to the most recently registered
   * remaining Signal session (skipping cron sessions), or null
   * if no Signal sessions remain.
   *
   * No-op if the label does not exist.
   */
  end(label: number): Promise<void>;

  /** Returns the ManagedSession for a label, or undefined. */
  get(label: number): ManagedSession | undefined;

  /** Returns all managed sessions (snapshot). */
  all(): readonly ManagedSession[];

  // --- Escalation state management ---

  /**
   * Records the full request (server, tool, arguments, reason, context,
   * whitelist candidates) as the session's pending escalation, awaiting
   * human approval, and tells the escalation listeners (the web UI pushes
   * it to browsers). Called when an escalation event fires on any session
   * (Signal or cron). `announce: false` for one about to be denied
   * automatically. There is no id-only form: a placeholder without the
   * tool and arguments could be approved blind.
   */
  recordEscalation(label: number, request: EscalationRequest, options?: { announce?: boolean }): PendingEscalationData | undefined;

  /** Clears a session's pending escalation (after a decision). */
  clearPendingEscalation(label: number): void;

  /** Clears it because the proxy timed it out, telling the listeners. */
  expireEscalation(label: number): string | undefined;

  /**
   * The single resolution path (Signal replies, the web UI, the cron
   * auto-deny); tells the listeners the outcome.
   */
  resolveSessionEscalation(escalationId: string, decision: 'approved' | 'denied'): Promise<EscalationResolutionResult>;

  /** Listeners for pending / resolved / expired escalations. */
  subscribeEscalationEvents(listener: (event: SessionEscalationEvent) => void): () => void;

  /**
   * Returns sessions that have pending escalations.
   * Used when the user replies a bare "deny" (only one may be
   * pending) or a code that must match a pending escalation.
   */
  withPendingEscalation(): readonly ManagedSession[];
}
```

**What `SignalBotDaemon` retains after this extraction:**

`SignalBotDaemon` retains only Signal-specific concerns:

- WebSocket connection to signal-cli container (connect, reconnect, health checks)
- Message parsing and command dispatch (`/quit`, `/new`, `/sessions`, `/budget`, `/help`)
- Identity verification (fingerprint checks, TTL cache)
- Control command handling (approve, deny, session switching)
- Markdown-to-Signal formatting and message splitting

It no longer owns `this.sessions`, `this.nextLabel`, or `this.currentLabel`. Instead, it receives a `SessionManager` reference in its constructor and calls:

- `sessionManager.register()` to create Signal sessions
- `sessionManager.get(label)` / `sessionManager.currentLabel` for message routing
- `sessionManager.end(label)` when the user runs `/quit`
- `sessionManager.recordEscalation()` / `expireEscalation()` / `resolveSessionEscalation()` for escalation state
- `sessionManager.all()` for the `/sessions` command

**What `CronScheduler` callbacks do:**

The `IronCurtainDaemon.onJobTrigger()` callback (not the scheduler itself) calls:

- `sessionManager.register(session, headlessTransport, { kind: 'cron', jobId, jobName })` when a job fires
- `sessionManager.end(label)` when the job completes

The `CronScheduler` itself has no knowledge of `SessionManager` -- it only fires callbacks.

### 4.7 PipelineRunner and Task Policy Compiler

The existing pipeline's internal functions (`compilePolicyRules`, `generateTestScenarios`, `verifyCompiledPolicy`) are currently tightly coupled to `PipelineConfig` and the global output directory. Rather than threading an `outputDir` parameter through three separate function signatures, the pipeline is refactored behind a `PipelineRunner` abstraction that encapsulates the full compile-verify-repair loop.

```typescript
// src/pipeline/pipeline-runner.ts

import type { CompiledPolicyFile } from './types.js';
import type { MCPServerConfig } from '../config/types.js';

/**
 * Selects the LLM prompt variant for policy compilation.
 *
 * - 'constitution': broad-principle compilation from a constitution
 *   document. Produces rules covering general filesystem, git, web,
 *   etc. categories. This is the existing behavior.
 * - 'task-policy': whitelist-generation from an English task
 *   description. Produces the MINIMUM set of allow/escalate rules
 *   for exactly what the task requires. Everything not explicitly
 *   covered falls through to default deny.
 */
export type ConstitutionKind = 'constitution' | 'task-policy';

/**
 * Configuration for a single pipeline run (compile + verify + repair).
 */
export interface PipelineRunConfig {
  /**
   * The input text for compilation.
   * - For 'constitution': the combined constitution markdown
   *   (base + user extension).
   * - For 'task-policy': the English task description.
   */
  readonly constitutionInput: string;

  /**
   * Controls which LLM prompt variant is used.
   * See ConstitutionKind for the two variants.
   */
  readonly constitutionKind: ConstitutionKind;

  /**
   * Directory where compiled-policy.json, test-scenarios.json,
   * and optionally dynamic-lists.json are written.
   */
  readonly outputDir: string;

  /**
   * Directory where tool-annotations.json is read from.
   * Always the global annotations dir -- never per-job.
   */
  readonly toolAnnotationsDir: string;

  /**
   * Sandbox boundary for structural invariant checks during
   * policy verification.
   */
  readonly allowedDirectory: string;

  /** Protected paths for structural invariant injection. */
  readonly protectedPaths: string[];

  /**
   * MCP server configs (for domain allowlist extraction).
   * Required for both constitution and task-policy modes to preserve
   * the structural domain-gate for URL-role arguments. Optional only
   * because callers that have no URL-role tools can omit it safely.
   */
  readonly mcpServers?: Record<string, MCPServerConfig>;

  /** Path to write LLM interaction logs. */
  readonly llmLogPath?: string;

  /**
   * Whether to include the handwritten scenarios (universal,
   * constitution-independent invariants) as ground truth.
   * Default true for both 'constitution' and 'task-policy': a task
   * policy must not allow writes or moves under /etc either. Each
   * server gets only the scenarios that name it.
   */
  readonly includeHandwrittenScenarios?: boolean;

  /** Progress callback for CLI output. */
  readonly onProgress?: (message: string) => void;
}

/**
 * Encapsulates the full policy compilation pipeline:
 * compile rules -> generate scenarios -> verify -> repair loop.
 *
 * Constructed with LLM model references (shared across runs).
 * The run() method executes a single compilation with the given config.
 */
export class PipelineRunner {
  constructor(models: PipelineModels);

  /**
   * Runs the full pipeline. Returns the compiled policy on success.
   * Uses content-hash caching: if the inputHash matches the existing
   * artifact, returns immediately without LLM calls.
   *
   * @throws on compilation or verification failure after repair attempts
   */
  run(config: PipelineRunConfig): Promise<CompiledPolicyFile>;
}

/**
 * LLM model references shared across pipeline runs.
 * Created once by the daemon or CLI, reused for multiple compilations.
 */
export interface PipelineModels {
  readonly compilationModel: import('ai').LanguageModel;
  readonly verificationModel: import('ai').LanguageModel;
  readonly cacheStrategy: import('../session/prompt-cache.js').PromptCacheStrategy;
}

/** Creates PipelineModels from user config. */
export async function createPipelineModels(): Promise<PipelineModels>;
```

The existing `compile.ts` CLI `main()` becomes a thin wrapper:

```typescript
// In compile.ts main():
const models = await createPipelineModels();
const runner = new PipelineRunner(models);
await runner.run({
  constitutionInput: config.constitutionText,
  constitutionKind: 'constitution',
  outputDir: config.generatedDir,
  toolAnnotationsDir: config.generatedDir, // same dir for global
  allowedDirectory: config.allowedDirectory,
  protectedPaths: config.protectedPaths,
  includeHandwrittenScenarios: true,
});
```

The new `compileTaskPolicy()` convenience function (`src/cron/compile-task-policy.ts`) takes the job, so the policy is compiled, verified and linted against the workspace the job really runs in:

```typescript
/** The directory a job's sessions run in: job.workspace (a leading ~ expanded), or jobs/<id>/workspace. */
export function getJobRunWorkspace(job: Pick<JobDefinition, 'id' | 'workspace'>): string {
  return resolve(job.workspace !== undefined ? expandTilde(job.workspace) : getJobWorkspaceDir(job.id));
}

/**
 * Compiles a job's task-scoped policy into <jobDir>/generated/.
 *
 * Loads MCP server configs via loadConfig() to preserve the structural
 * domain-gate protection for URL-role arguments. Without mcpServers,
 * the pipeline would not know which domains are allowed for tools with
 * fetch-url or git-remote-url roles, and cron sessions using those
 * tools would lose domain allowlist enforcement.
 */
export async function compileTaskPolicy(
  job: TaskPolicyJob,
  globalAnnotationsDir?: string,
): Promise<CompiledPolicyFile> {
  const config = loadConfig();
  const outputDir = resolve(getJobDir(job.id), 'generated');
  const runner = new PipelineRunner(await createPipelineModels(outputDir));
  return runner.run({
    constitutionInput: job.taskConstitution,
    constitutionKind: 'task-policy',
    outputDir,
    toolAnnotationsDir: globalAnnotationsDir ?? getUserGeneratedDir(),
    toolAnnotationsFallbackDir: getPackageGeneratedDir(),
    allowedDirectory: getJobRunWorkspace(job), // the sandbox for the prompt, the verifier and the lint
    protectedPaths: config.protectedPaths,
    mcpServers: config.mcpServers,
    includeHandwrittenScenarios: true, // the universal invariants hold for task policies too
    prefilterText: job.taskConstitution,
    allowBroadDomains: false, // task text is drafted from untrusted input; it cannot opt in
  });
}
```

Like every compile, the run applies the deterministic rule checks of `docs/designs/per-server-policy-compilation.md` ("Deterministic Rule Checks"); a task policy can never opt in to broad domain access.

### 4.8 System Prompt Augmentation

```typescript
// Addition to src/session/prompts.ts

/**
 * Context injected into the system prompt for cron-initiated sessions.
 */
export interface CronPromptContext {
  /** The English task description from the job definition. */
  readonly taskDescription: string;

  /** Absolute path to the persistent workspace directory. */
  readonly workspacePath: string;
}

/**
 * Builds the system prompt augmentation for cron sessions.
 * Appended to the standard system prompt (from buildSystemPrompt).
 */
export function buildCronSystemPromptAugmentation(context: CronPromptContext): string;
```

### 4.9 SessionOptions Extension

```typescript
// Addition to src/session/types.ts

export interface SessionOptions {
  // ... existing fields ...

  /**
   * When set, loads compiled-policy.json (and optionally
   * dynamic-lists.json) from this directory instead of the global
   * generated directory. Tool annotations are always loaded from
   * the global location regardless of this setting.
   *
   * Used by cron sessions to load task-scoped policy.
   */
  policyDir?: string;

  /**
   * Additional content appended to the system prompt.
   * Used by cron sessions to inject task context and workspace
   * conventions. Not used for Docker sessions.
   */
  systemPromptAugmentation?: string;
}
```

### 4.10 Headless Escalation Transport

```typescript
// src/cron/headless-transport.ts

import { BaseTransport } from '../session/base-transport.js';
import type { Session, EscalationRequest } from '../session/types.js';

/**
 * Minimal transport for headless cron sessions.
 *
 * Unlike SignalSessionTransport which blocks run() indefinitely,
 * HeadlessTransport's run() resolves when the single-shot task
 * message completes. It does not accept follow-up messages.
 *
 * Escalation handling is configured via the constructor:
 * - When a notifier is provided, escalations are surfaced via Signal
 *   and the session waits for external resolution (via daemon).
 * - When no notifier is provided, escalations are auto-denied
 *   immediately by writing the response file.
 */
export class HeadlessTransport extends BaseTransport {
  constructor(options: {
    /** The initial task message to send. */
    readonly taskMessage: string;
    /**
     * Optional callback invoked when an escalation is surfaced.
     * When provided, the transport sets the pending escalation
     * on the ManagedSession and waits for external resolution.
     * When absent, escalations are auto-denied immediately.
     */
    readonly onEscalation?: (request: EscalationRequest) => void;
    readonly onEscalationExpired?: () => void;
    readonly onDiagnostic?: (event: import('../session/types.js').DiagnosticEvent) => void;
  });

  protected async runSession(session: Session): Promise<void>;

  /** Returns the agent's response from the task. */
  getResponse(): string | undefined;

  close(): void;
}
```

## 5. Task Policy Compiler Prompt Design

The per-job compilation uses a variant system prompt that instructs the LLM to produce a task-scoped whitelist rather than a broad constitution-based policy:

```typescript
const TASK_POLICY_SYSTEM_PROMPT_TEMPLATE = `You are compiling a task-scoped security policy for an automated scheduled job. The job runs unattended on a schedule. Your goal is to generate the MINIMUM set of policy rules required for this specific task -- nothing more.

## Task Description

{taskDescription}

## Tool Annotations

These are the available tools and their classified capabilities:

{annotationsSummary}

## Structural Invariants (handled automatically -- do NOT generate rules for these)

1. **Protected paths** -- reads/writes/deletes to these paths are automatically denied:
{protectedPaths}

2. **Workspace containment** -- operations within the job's workspace ({workspacePath}) are automatically allowed.

3. **Default deny** -- if no compiled rule matches, the operation is DENIED. You do NOT need catch-all rules.

## Instructions

Generate an ORDERED list of policy rules (first match wins) that allow EXACTLY the operations this task needs. Be a strict whitelist:

1. **Allow** operations the task explicitly describes or clearly requires.
   - "label each issue by type" -> allow github.add_label
   - "add a comment" -> allow github.create_comment
   - "close issues with no response for 30+ days" -> allow github.close_issue (the task explicitly authorizes this)

2. **Escalate** operations that are consequential AND only implicitly needed.
   - If the task says "fix bugs" but doesn't mention specific files, escalate write operations.
   - If an operation could cause data loss and the task doesn't explicitly authorize it, escalate.

3. **Omit** operations the task does not need. Default deny handles them.
   - Do NOT generate rules for tools unrelated to the task.
   - Do NOT generate broad "allow all reads" rules unless the task requires broad read access.

4. **Filesystem access**: The agent's workspace is automatically allowed. Only generate rules for filesystem access OUTSIDE the workspace if the task requires it.

5. **Side-effect-free operations**: Reading and listing operations for tools the task uses should generally be allowed. The task cannot operate without discovering available data.

{ruleFormat}`;
```

The `{ruleFormat}` placeholder is filled with `RULE_FORMAT_DOCUMENTATION` -- the shared constant extracted from `buildCompilerSystemPrompt()` in `constitution-compiler.ts` (see Section 6.6). This constant contains the rule schema (name, description, principle, if/then) and structural invariant documentation, identical between both prompt variants.

## 6. Integration Points

### 6.1 Policy Loading Parameterization (`src/config/index.ts`)

Per-job sessions use a **split load path**: policy files come from the per-job directory, while tool annotations always come from the global location.

The `loadGeneratedPolicy()` signature is updated to accept separate directories:

```typescript
export interface PolicyLoadOptions {
  /** Directory for compiled-policy.json and dynamic-lists.json. */
  readonly policyDir: string;
  /** Directory for tool-annotations.json (always global). */
  readonly toolAnnotationsDir: string;
  /** Fallback directory for missing artifacts (package-bundled defaults). */
  readonly fallbackDir?: string;
}

export function loadGeneratedPolicy(options: PolicyLoadOptions): {
  compiledPolicy: CompiledPolicyFile;
  toolAnnotations: ToolAnnotationsFile;
  dynamicLists: DynamicListsFile | undefined;
};
```

For interactive sessions, both directories point to the same global location (backward-compatible behavior). For cron sessions, they diverge:

```typescript
// In createBuiltinSession():
const policyDir = options.policyDir ?? config.generatedDir;
const toolAnnotationsDir = config.generatedDir; // always global
const { compiledPolicy, toolAnnotations, dynamicLists } = loadGeneratedPolicy({
  policyDir,
  toolAnnotationsDir,
  fallbackDir: getPackageGeneratedDir(),
});
```

This ensures tool annotations are never duplicated or stale per-job. When new tools are added globally via `ironcurtain annotate-tools`, all jobs see the updated annotations immediately without per-job recompilation of annotations.

### 6.2 Session Factory Changes (`src/session/index.ts`)

The `buildSessionConfig()` function is extended to accept the `policyDir` override:

```typescript
function buildSessionConfig(
  config: IronCurtainConfig,
  effectiveSessionId: string,
  sessionId: SessionId,
  resumeSessionId?: string,
  workspacePath?: string,
  policyDir?: string, // NEW
): SessionDirConfig {
  // ... existing logic ...

  const sessionConfig = {
    ...config,
    allowedDirectory: sandboxDir,
    // Override generated dir when per-job policy is provided
    generatedDir: policyDir ?? config.generatedDir,
    // ... other fields ...
  };

  return { config: sessionConfig /* ... */ };
}
```

### 6.3 System Prompt Augmentation (`src/session/agent-session.ts`)

When `options.systemPromptAugmentation` is set, it is appended to the base system prompt:

```typescript
// In AgentSession.initialize():
let rawPrompt = buildSystemPrompt(serverListings, this.config.allowedDirectory);
if (this.systemPromptAugmentation) {
  rawPrompt += '\n\n' + this.systemPromptAugmentation;
}
this.systemPrompt = this.cacheStrategy.wrapSystemPrompt(rawPrompt);
```

The cron augmentation content:

```typescript
export function buildCronSystemPromptAugmentation(context: CronPromptContext): string {
  return `## Scheduled Task Mode

You are running as an automated scheduled task. There is no interactive user present.

### Your Task

${context.taskDescription}

### Workspace

Your persistent workspace is: ${context.workspacePath}
This directory persists across runs. Use it for cross-run state:

- **workspace/memory.md** -- Your notes for yourself. Read this at the start of each run to recall context from previous runs. Update it with anything you want to remember for next time (last processed item, patterns observed, recurring issues, etc.).
- **workspace/last-run.md** -- Write a structured summary here before finishing. Include:
  - Date and time of this run
  - Actions taken (with counts: "Labeled 12 issues, commented on 3, closed 1")
  - Any issues encountered or items skipped
  - Recommendations for next run (if any)

### Headless Behavior

- If a tool call is denied, do NOT retry it. Note the denial in your summary and continue with other work.
- If a tool call requires approval and no human responds in time, it will be auto-denied. Continue without that operation.
- Work efficiently: this is a recurring job, not an exploration. Focus on the task.
- Always write workspace/last-run.md before finishing, even if the task failed.`;
}
```

The current prompt (`src/session/prompts.ts`) names `last-run.md` at the workspace root and also lists `previous-run.md`: before every run the daemon moves the previous run's `last-run.md` there (see section 11.9), so the agent can still read the earlier recommendations while the daemon only ever records what this run wrote.

### 6.4 Budget Override Merge for Cron Sessions

The daemon does not patch the config with the job's limits. It hands the session factory two layers, and `buildSessionConfig` lays them, field by field, around the persona's own `resourceBudget` (persona jobs only; see "Per-Persona Agent Model and Resource Limits" in [persona-system.md](persona-system.md) and `src/session/model-budget-precedence.ts`):

```typescript
/** Cron-specific budget defaults (differ from interactive defaults). */
const CRON_BUDGET_DEFAULTS: Required<JobBudgetOverrides> = {
  maxTotalTokens: 500_000,
  maxSteps: 100,
  maxSessionSeconds: 3_600,
  maxEstimatedCostUsd: 2.0,
};

function cronSessionBudgetOptions(
  job: Pick<JobDefinition, 'budgetOverrides'>,
): Pick<SessionOptions, 'resourceBudgetBaseline' | 'resourceBudgetOverrides'> {
  return {
    resourceBudgetBaseline: CRON_BUDGET_DEFAULTS,
    ...(job.budgetOverrides !== undefined ? { resourceBudgetOverrides: job.budgetOverrides } : {}),
  };
}
```

The merge order is: global `resourceBudget` < cron defaults < the persona's `resourceBudget` (a job with `persona` set) < per-job `budgetOverrides`. A `null` value in `budgetOverrides` (or in the persona's limits) disables that limit (e.g., `maxSessionSeconds: null` removes the wall-clock timeout). The cron defaults set all four limits, so of the global interactive limits only `warnThresholdPercent` still reaches a cron session; a job without a persona therefore runs exactly as before: cron defaults, then its own overrides.

### 6.5 Daemon-to-Signal Bridge for Cron Escalations

When a cron session surfaces an escalation (see decision 3 for the routing):

```typescript
// IronCurtainDaemon.handleCronEscalation(request, job, label)
if (job.notifyOnEscalation && this.signalDaemon) {
  // Records the full request (the web UI shows it too) and sends the
  // coded banner naming the job. The proxy-side timeout is the deadline.
  void this.signalDaemon.surfaceEscalation(label, request, { jobName: job.name });
} else if (!this.signalDaemon && this.webUiServer?.hasBrowserClient()) {
  // Pushed to the browsers (escalation.created); waits for a decision there.
  this.sessionManager.recordEscalation(label, request);
} else {
  // Nobody can be asked: denied at once, through the one resolution path.
  this.sessionManager.recordEscalation(label, request, { announce: false });
  void this.sessionManager.resolveSessionEscalation(request.escalationId, 'denied');
}
```

An expiry (`onEscalationExpired`) goes through `SignalBotDaemon.expireEscalation` (which tells the Signal user) or `SessionManager.expireEscalation`; either way browsers get `escalation.expired`.

As implemented, the escalation callbacks are created before the session (and so its label) exists. They capture the run's own reservation (`ActiveJobRun`), whose `label` is assigned right after `sessionManager.register()`, and never look the label up by job id. An escalation raised before registration is queued and routed as soon as the label exists; one resolved or expired before then is dropped from the queue.

### 6.6 Pipeline Parameterization (`src/pipeline/pipeline-runner.ts`)

The existing pipeline internals (`compilePolicyRules`, `generateTestScenarios`, `verifyCompiledPolicy`) are encapsulated behind `PipelineRunner` (see Section 4.7). The `constitutionKind` flag selects the appropriate LLM prompt variant:

- **`'constitution'`** uses the existing `buildCompilerSystemPrompt()` -- broad-principle compilation from a constitution document. This is the current behavior, unchanged.
- **`'task-policy'`** uses `buildTaskCompilerSystemPrompt()` -- whitelist-generation from an English task description. Instructs the LLM to generate the minimum set of allow/escalate rules. Everything not covered falls through to default deny.

The `{ruleFormat}` section (rule schema documentation, structural invariant descriptions) is extracted from `buildCompilerSystemPrompt()` into a shared constant `RULE_FORMAT_DOCUMENTATION` used by both prompt variants.

The existing `compile.ts` CLI `main()` becomes a thin wrapper over `PipelineRunner.run()` with `constitutionKind: 'constitution'`. Its public interface is unchanged. The new `compileTaskPolicy()` convenience function (see Section 4.7) wraps `PipelineRunner.run()` with `constitutionKind: 'task-policy'` and task-appropriate defaults (per-job output directory, workspace as sandbox boundary).

**Handwritten scenarios:** Per-job compilation includes `getHandwrittenScenarios()`, like every compile. The scenarios in `src/pipeline/handwritten-scenarios.ts` are universal invariants (writes and moves under `/etc` must not be allowed, whatever the constitution or task says), and each server gets only the ones that name it, so a GitHub triage job gets none while a job that compiles `filesystem` rules is verified against them. They are ground truth the judge cannot correct, and the task-policy compiler prompt shows them like the constitution prompt does. Everything else is generated from the task description. The `includeHandwrittenScenarios` flag on `PipelineRunConfig` defaults to `true` for both modes (tests turn it off for fake servers).

## 7. Component Relationships

```
ironcurtain daemon (CLI entry point)
        |
        v
  IronCurtainDaemon
  (unified lifecycle owner)
        |
        +---> SessionManager (owns all session state)
        |       |
        |       +---> Map<number, ManagedSession>
        |       +---> register(), end(), get(), all()
        |       +---> setPendingEscalation(), clearPendingEscalation()
        |       +---> currentLabel (for Signal routing)
        |
        +---> SignalBotDaemon (optional, when Signal configured)
        |       |
        |       +---> WebSocket connection to signal-cli
        |       +---> Message parsing, identity verification, commands
        |       +---> Calls sessionManager.register() for Signal sessions
        |       +---> Calls sessionManager.get() for message routing
        |       +---> Does NOT own session map (delegates to SessionManager)
        |
        +---> CronScheduler (node-cron)
        |       |
        |       +---> Fires JobTriggerCallback at scheduled times
        |       +---> Manages per-job cron tasks
        |
        +---> JobStore (filesystem)
        |       |
        |       +---> Reads/writes ~/.ironcurtain/jobs/{id}/job.json
        |       +---> Reads/writes run records
        |
        +---> Per-job policy compilation
                |
                +---> compileTaskPolicy() (wraps PipelineRunner)
                +---> Reads global tool-annotations.json
                +---> Writes to ~/.ironcurtain/jobs/{id}/generated/

Session creation flow (cron):
  1. CronScheduler fires -> IronCurtainDaemon.onJobTrigger(job)
  2. Check overlap (skip if same job already running)
  3. Create HeadlessTransport with task message
  4. createSession({
       config: patchedConfig,
       workspacePath: jobWorkspaceDir,
       policyDir: jobGeneratedDir,
       systemPromptAugmentation: buildCronSystemPromptAugmentation(job),
       onEscalation: createCronEscalationHandler(managed, job),
     })
  5. sessionManager.register(session, transport, { kind: 'cron', jobId, jobName })
  6. HeadlessTransport.run(session) -> sends task message
  7. On completion: record RunRecord, send notification,
     sessionManager.end(label)
```

## 8. CLI Commands

### 8.1 `ironcurtain daemon`

Starts the unified daemon: the Signal transport and the `CronScheduler`, which loads the configured jobs from `~/.ironcurtain/jobs/`.

```
ironcurtain daemon [options]
  -a, --agent <name>  Agent mode (same as start)
  --no-signal         Skip Signal transport (cron-only mode)
```

**`ironcurtain bot` is not an alias.** It stays the Signal transport alone, without the scheduler, as it was before the daemon existed: it takes only `-a`/`--agent` (as `-a X`, `--agent X` or `--agent=X`) and `--help`, parsed strictly, and refuses a subcommand with a pointer to `ironcurtain daemon`, which owns the job commands. (An earlier alias routed `bot <subcommand>`, and through a non-strict parse also `bot --agent X`, to a full daemon with the scheduler, while `bot` and `bot --agent=X` ran the Signal transport alone.)

### 8.2 `ironcurtain daemon add-job`

Interactive wizard for creating a new job. Runs policy compilation synchronously before confirming. The job is saved disabled while its policy compiles and is enabled only once a policy compiled from its constitution exists, so a failed or interrupted compile never leaves a schedulable job without a policy (§11.6).

```
ironcurtain daemon add-job

Interactive prompts:
  Job ID (slug): issue-triage
  Display name: GitHub Issue Triage
  Schedule (cron): 0 9 * * *
  Task description: (multi-line, ends with empty line)
    Triage open GitHub issues on the ironcurtain repo...
  Notify on escalation? (y/n): y
  Notify on completion? (y/n): y

Compiling task policy...
  [1/3] Compiling task policy: 6 rules compiled (4.2s)
  [2/3] Generating test scenarios: 15 scenarios (8.1s)
  [3/3] Verifying policy: 1 round (3.4s)

Job "issue-triage" created. Next run: 2026-03-05 09:00:00
```

The wizard uses `@clack/prompts` (already a dependency, used by `config-command.ts`). The cron expression is validated immediately via `CronScheduler.schedule()` (which throws `InvalidCronExpressionError` on invalid input). If validation fails, the wizard re-prompts rather than writing a job file that would fail at runtime.

As implemented, `add-job` and `edit-job` share one review loop (`runJobReviewLoop` in `src/cron/job-commands.ts`) with a step per field, each showing its current value. Besides the fields above, it sets or clears a custom `workspace` (checked with `validateWorkspacePath()` against the protected paths the daemon checks before every run, stored as the canonical path it returns; empty means the default workspace), a `persona` (only an existing one, loaded to check; a persona job needs no task constitution) and the `budgetOverrides` (per limit: a number, `none` for `null`, or empty to keep the default, each checked with the job store's `budgetOverridesSchema`). Confirming is refused while the definition would read back from `job.json` as invalid (`findJobDefinitionProblem`). For a persona job `add-job` compiles no task policy: `saveNewJobWithPolicy` checks the persona as the daemon does before every run (its policy with `checkJobPolicy`, its agent model and resource limits with `findPersonaOverridesProblem`), and the persona picker flags a persona that would fail either check. A job with a git repository and a custom workspace is cloned into that workspace as the daemon syncs it (`managedWorkspace: false`: it must be empty the first time and is never created).

The wizard writes the job files to disk and compiles the policy itself, whether or not a daemon is running. There is no `add-job` control-socket request: the daemon never accepts a whole job definition from a socket client (Section 8.7). A running daemon loads jobs only at startup, so once the policy has compiled and the job is saved enabled, `add-job` sends `reload-job` over the control socket; `reloadJob` reads the job from disk and schedules it even though the daemon has never seen it, and the wizard reports the next run. `edit-job` sends `reload-job` after saving, also when its recompile failed (§11.6). If no daemon is reachable, the wizard says the job runs once the daemon is started. If the daemon refuses the reload, the job is saved but not scheduled: the wizard says so and exits 1; if a daemon took the request but no answer came back, the wizard says it could not confirm that the job was scheduled and exits 1 (`list-jobs` shows whether it was). If the compile fails, the job stays saved but disabled and is not sent to the daemon (there is no policy to run it under); the printed recovery steps are `recompile-job`, which compiles and then reloads the job, and `enable-job`, which schedules it. A compile that wrote the policy without some servers ends the same way, with exit status 2 and the servers named (§8.5). `list-jobs` against a running daemon flags an enabled job that the scheduler does not hold as `NOT SCHEDULED`. When the web UI is running, job changes made through the control socket emit `job.list_changed`, so its job list refreshes.

### 8.3 `ironcurtain daemon list-jobs`

```
ironcurtain daemon list-jobs

Jobs:
  issue-triage     GitHub Issue Triage          0 9 * * *    next: 2026-03-05 09:00
                   Last run: 2026-03-04 09:00 — success (12 issues triaged)
  code-health      Daily Code Health Check      0 8 * * 1-5  next: 2026-03-05 08:00
                   Last run: 2026-03-04 08:00 — success (all checks passed)
  backup-notes     Backup Notes to Repo         0 22 * * *   DISABLED
                   Last run: 2026-03-01 22:00 — error (git push denied)
```

### 8.4 `ironcurtain daemon run-job <id>`

One-shot manual trigger for testing. Does not affect the cron schedule.

With a daemon running, the run happens in the daemon: `run-job` is accept-then-poll (the daemon replies with a run id at once and the CLI polls `run-job-status` until the run ends), so a run of any length is reported and never also started in the CLI process. While a run of the job (scheduled, CLI or web) is still in progress, including one still in its git sync or session start, the daemon answers with an error (`Job "<id>" is already running`, from `JobAlreadyRunningError`) instead of accepting, and the CLI exits 1 (decision 8). Ctrl-C stops waiting; the run continues in the daemon. Without a daemon the CLI runs the job itself while holding the daemon lock (Section 8.7), in the session mode the command resolved (`--agent` included), and first prints preflight's host-model warnings (a model the session would use has no credentials, so it falls back or turns the feature off): the job's headless session shows them nowhere else.

```
ironcurtain daemon run-job issue-triage
Running job "issue-triage"...
  [session #8] Sending task: "Triage open GitHub issues..."
  [session #8] Completed in 45s, budget: 23%
  Summary: Labeled 12 issues, commented on 3 stale issues, closed 1 unresponsive issue.
```

### 8.5 Other commands

```
ironcurtain daemon remove-job <id> [-f]  Delete job and all artifacts (asks first unless -f)
ironcurtain daemon disable-job <id>      Stop scheduling, preserve files
ironcurtain daemon enable-job <id>       Resume scheduling
ironcurtain daemon recompile-job <id>    Re-run policy compilation, then reload (schedules it if enabled)
ironcurtain daemon logs <id> [--runs N]  Show recent run summaries (default: 5)
```

A compile that writes the job's policy without some servers (they failed to compile, are listed in the policy's `failedServers` and have no rules, so the job's calls to their tools are denied until a compile succeeds) is reported by every job command that compiles, with the servers named and exit status 2, as for `persona compile` and `compile-policy` (`src/cron/partial-compile.ts`). `recompile-job` keeps the job's enabled state and, through a daemon, reloads the job as usual: the daemon's reply names the servers (`{ failedServers }`, `RecompileJobResultDto`). `edit-job` reports them after saving and reloading. `add-job` saves such a job disabled and does not send it to the daemon, as after a failed compile: `recompile-job` retries the compile and `enable-job` schedules the job (alone, under the policy as it is).

`remove-job` asks for confirmation before anything is deleted, whether a running daemon or the CLI itself then deletes the job; `-f`/`--force` skips the question. An unknown id is an error (`Job not found: <id>`, exit 1; the web UI's `jobs.*` methods report it as `JOB_NOT_FOUND`), never a silent success. Run summaries, outcome messages and other agent-written text in `list-jobs`, `logs` and `run-job` output are printed with control characters shown as visible escapes.

### 8.6 CLI Architecture

All `daemon` subcommands are routed through `src/daemon/daemon-command.ts`, which is registered in `src/cli.ts`:

```typescript
// In src/cli.ts switch statement (`args`: the arguments after the command name):
case 'daemon': {
  const { runDaemonCommand } = await import('./daemon/daemon-command.js');
  await runDaemonCommand(args);
  break;
}
```

The `runDaemonCommand()` function parses the sub-subcommand (`add-job`, `list-jobs`, etc.) and dispatches accordingly. When no sub-subcommand is given, it starts the daemon. `src/cli.ts` hands it exactly the arguments after `daemon` (`src/cli-routing.ts`), and leaves the V8 sandbox preflight to it: only the two paths that run agent sessions in the CLI process, starting the daemon and a `run-job` no daemon took, check that isolated-vm loads and then resolve the session mode (container-runtime probe and credential checks, printing the `Mode:` line). `list-jobs`, `status`, `logs`, `add-job`, `edit-job` and the other job commands need neither, so they work on a host where isolated-vm cannot load or Docker is down; a `run-job` a running daemon takes is checked by that daemon. A session mode that cannot be resolved (`PreflightError`) ends the command with its message and exit 1.

### 8.7 Control socket and the daemon lock

CLI job commands reach a running daemon over a Unix domain socket at `~/.ironcurtain/daemon.sock` (`src/daemon/control-socket.ts`). The protocol is one JSON request line (at most 1 MiB, validated against a strict zod schema: `ping`, `status`, `list-jobs`, `remove-job`, `enable-job`, `disable-job`, `recompile-job`, `reload-job`, `run-job`, `run-job-status`) and one JSON response line. `status` also reports the web UI state (`disabled`, `starting`, `listening` or `unavailable`), so `workflow ... --ensure-daemon`, which never spawns a daemon while one answers here, waits for a web UI that is still starting and fails at once (`DAEMON_WITHOUT_WEB_UI`) only when there is none.

**One daemon per home.** `start()` takes `~/.ironcurtain/daemon.lock` (`src/daemon/daemon-lock.ts`, built on `docker-workload/process-lock`: pid plus OS process-start identity, so a crashed owner's lock is reclaimed) before it logs, binds the socket or schedules anything. A second `ironcurtain daemon` exits non-zero. A control socket that cannot be bound is fatal. The Signal transport has a lock of its own, `~/.ironcurtain/signal.lock` (`src/signal/signal-lock.ts`), which `ironcurtain bot` takes too: the daemon takes it before it touches the signal-cli container and gives it back at the end of `shutdown()`, and when a bot holds it the daemon starts without Signal and says so on stderr. `ironcurtain daemon --no-signal` takes only the daemon lock, so it can run beside a bot.

**Forwarding rules.** The client reports one of three outcomes. *Unreachable* (no socket, a stale socket, or no connection within 2 s) is the only one after which a CLI command may run locally, and it then does so while holding the daemon lock: a daemon whose socket did not answer still holds that lock, so the command refuses instead of doing the work beside it, and no daemon can start until the local command finishes. *Response* is the daemon's answer. *Failed* (the daemon took the request but dropped the connection, sent a bad reply or timed out) ends the command with an error; the daemon may already be doing the work, so it is never repeated locally. The server's 30 s idle timeout applies only until a full request line has arrived.

**Access control.** Node has no SO_PEERCRED, so the filesystem is the access control: the daemon makes the IronCurtain home owner-only (0700) before it binds, binds the socket at a temporary name, chmods it 0600 and renames it into place, so it never exists with umask-derived permissions and a live daemon's socket is never unlinked.

## 9. Run Lifecycle (Detailed)

```
CronScheduler fires
        |
        v
IronCurtainDaemon.onJobTrigger(job)          startJobRun (CLI run-job, web jobs.run) / runJobNow (CLI local fallback)
        |                                            |
        v                                            |
Check activeJobRuns.has(job.id)?                     |
  YES -> log skip, notify Signal if configured,      |
         return                                      |
  NO  -> continue                                    |
        |                                            |
        +--------------------------------------------+
        |
        v
executeJob: reserve the job synchronously (first statement, no await before it)
  already reserved -> throw JOB_ALREADY_RUNNING (manual runs; nothing started)
        |
        v
try {                                                          phase: setup
  Load config; workspace = job.workspace
    ? validateWorkspacePath(job.workspace) (canonical: ~, relative, symlinks resolved)
    : ~/.ironcurtain/jobs/{jobId}/workspace
        |
        v
  checkJobPolicy(job): policy missing or stale (§11.6)
    -> throw (error RunRecord below, no session, Signal "Not run" notice)
  job.persona: findPersonaOverridesProblem(persona): malformed agentModelId
    or resourceBudget -> throw (same as a policy refusal)
        |
        v
  Claim the workspace lock (decision 8; default workspace created first)
    held by another job's run or a workflow -> throw (error RunRecord below,
    no sync, no session, Signal "Not run" notice)
        |
        v
  If job.gitRepo: await syncGitRepo (mirror, decision 4;     phase: sync
    removeJob/shutdown abort it)
    FAILED/TIMED OUT -> throw (error RunRecord below, no session)
    OK               -> remember discardedChanges for the RunRecord
        |
        v
  Move last-run.md to previous-run.md (rename, never opened) phase: setup
        |
        v
  createSession({
    config: patchedConfig,
    workspacePath: canonical workspace,
    policyDir: job generated dir,
    systemPromptAugmentation: cron context,
    onEscalation: routed by this run's own label (queued until it exists),
  })
        |
        v
  sessionManager.register(session, transport, { source: 'cron', jobId })
  run.label = label (route queued escalations)
        |
        v
  HeadlessTransport.run(session)                             phase: session
    |
    +---> session.sendMessage(taskMessage)
    |       +---> Agent runs autonomously
    |       +---> Policy engine evaluates against per-job rules
    |       +---> Escalations: auto-deny or Signal notify+wait
    |       +---> Agent writes last-run.md at the workspace root
    v
} catch -> outcome { kind: 'error', phase, message } (or the cancellation)
finally {
  Budget snapshot; sessionManager.end(label); token bus + bridge cleanup
  Re-claim the daemon logger
}
        |
        v
Read last-run.md (after teardown: no-follow, non-blocking, <= 8 KiB,
  control characters stripped, <= 2000 chars)
Release the workspace lock
Build RunRecord (outcome, budget, summary)
If the job was removed during the run: no record, no notification
Else: saveRunRecord (a write failure is logged, never thrown)
      Refused (policy, persona, workspace in use) && Signal configured:
        sendSignalMessage("[cron: issue-triage] Not run: Job \"issue-triage\" has a stale compiled policy: ...")
      Else if notifyOnCompletion && Signal configured (every outcome):
        sendSignalMessage(formatRunNotification(...), { textMode: 'normal' })
        -> plain text: "[cron: issue-triage] Completed (45s, $0.12)" (the
           cost reads "unknown" when nothing reported one and "≥ $x" when
           only some exchanges did; see RunRecord.budget.costSource), then
           "Summary written by the job's agent:" and the summary with every
           line quoted as "│ ..." and display-escaped, so it cannot pass for
           a banner or IronCurtain's own text
        |
        v
Release the reservation (only if it is still this run's)
```

## 10. Walkthrough: GitHub Issue Triage

**Setup:**

```
$ ironcurtain daemon add-job
  Job ID: issue-triage
  Name: GitHub Issue Triage
  Schedule: 0 9 * * *
  Task: Triage open GitHub issues on the ironcurtain repo: label each
        issue by type (bug/feature/question/docs), add a comment on
        issues that haven't been updated in 14+ days asking for status,
        and close issues with no response for 30+ days. Write a brief
        summary of what you did.
  Notify on escalation: yes
  Notify on completion: yes

  Compiling task policy...
```

**Per-job policy compilation produces:**

```json
{
  "rules": [
    {
      "name": "allow-github-read-issues",
      "description": "Allow listing and reading GitHub issues for triage",
      "principle": "Task: triage requires reading issue data",
      "if": { "server": ["github"], "tool": ["list_issues", "get_issue", "list_issue_comments"] },
      "then": "allow"
    },
    {
      "name": "allow-github-label",
      "description": "Allow adding labels to issues for classification",
      "principle": "Task: label each issue by type",
      "if": { "server": ["github"], "tool": ["add_label"] },
      "then": "allow"
    },
    {
      "name": "allow-github-comment",
      "description": "Allow commenting on issues to ask for status",
      "principle": "Task: add a comment on stale issues",
      "if": { "server": ["github"], "tool": ["create_comment"] },
      "then": "allow"
    },
    {
      "name": "allow-github-close-issue",
      "description": "Allow closing issues with no response for 30+ days",
      "principle": "Task: close issues with no response for 30+ days",
      "if": { "server": ["github"], "tool": ["close_issue", "update_issue"] },
      "then": "allow"
    },
    {
      "name": "escalate-github-other",
      "description": "Escalate any other GitHub operations not explicitly authorized",
      "principle": "Least privilege: task does not authorize other GitHub operations",
      "if": { "server": ["github"] },
      "then": "escalate"
    }
  ]
}
```

Note: `close_issue` is `allow` (not `escalate`) because the task description explicitly authorizes closing issues under stated conditions. The LLM recognizes "close issues with no response for 30+ days" as explicit authorization. If the user had written a vaguer task like "help manage issues," `close_issue` would be `escalate`.

**First run at 09:00:**

1. Agent starts, reads `workspace/memory.md` -- file does not exist yet (first run).
2. Agent calls `github.list_issues` -- allowed by rule `allow-github-read-issues`.
3. Agent calls `github.add_label` for 12 issues -- allowed.
4. Agent calls `github.create_comment` on 3 stale issues -- allowed.
5. Agent calls `github.update_issue` (close) on 1 unresponsive issue -- allowed.
6. Agent writes `workspace/last-run.md`:
   ```
   # Run Summary: 2026-03-04 09:00

   ## Actions
   - Labeled 12 issues (5 bug, 4 feature, 2 question, 1 docs)
   - Commented on 3 issues with no activity for 14+ days
   - Closed 1 issue (#47) with no response for 35 days

   ## Notes for Next Run
   - Issue #52 has a complex bug report, may need label refinement
   - Issue #48 was commented today; check for response next run
   ```
7. Agent writes `workspace/memory.md`:
   ```
   # Issue Triage Memory

   ## Last processed: 2026-03-04 09:00
   ## Pending follow-ups:
   - #48: commented 2026-03-04, awaiting response (28 days since original activity)
   - #52: labeled as bug, complex report
   ```
8. Daemon reads `workspace/last-run.md`, records RunRecord.
9. Daemon sends Signal notification:
   ```
   [cron: issue-triage] Completed (45s, $0.12)
   Labeled 12 issues, commented on 3, closed 1.
   ```

**Second run at 09:00 next day:**

1. Agent reads `workspace/memory.md` -- sees pending follow-ups.
2. Agent checks #48 -- user responded, removes from pending list.
3. Continues with normal triage of new issues.

**Escalation scenario (if close_issue were compiled as `escalate`):**

1. Agent calls `github.close_issue` -- policy escalates.
2. Proxy writes escalation request file, daemon detects it.
3. Daemon sends Signal: `ESCALATION [#5 cron: issue-triage] code K7Q2`, the tool `github/close_issue`, the reason and `Reply "approve K7Q2" or "deny K7Q2"`, then the arguments (`issue_number: 47`, ...).
4. User replies `approve K7Q2` via Signal.
5. Daemon resolves escalation, agent continues.

## 11. Security Considerations

### 11.1 Per-job policy is a strict whitelist

The per-job policy's default-deny posture means a cron job can only perform operations that the policy compilation explicitly authorized from the task description. A compromised or confused agent in the issue-triage job cannot delete files, push code, or access unrelated servers.

### 11.2 Workspace isolation

Each job's workspace is scoped to `~/.ironcurtain/jobs/{jobId}/workspace/`. The sandbox containment structural invariant ensures filesystem operations outside this directory are denied (unless per-job rules explicitly allow them). Cross-job workspace access is impossible, except for jobs that name the same custom `workspace`: they share its files, but their runs never overlap (decision 8).

### 11.3 Headless escalation is fail-safe

When no human can be asked, escalations are auto-denied immediately: Signal is configured but the job's `notifyOnEscalation` is false, or Signal is not configured and no browser is connected to the web UI. The agent sees a denied tool call and must adapt. This is conservative -- the job may fail to complete some operations, but it cannot perform unauthorized actions. An escalation that does wait (on Signal, or in the web UI while a browser is connected) is denied by the proxy when nobody decides within `escalationTimeoutSeconds`, and only a request whose server, tool and arguments are shown can be approved.

### 11.4 Budget limits prevent runaway costs

Cron-specific budget defaults are lower than interactive defaults. Per-job `budgetOverrides` allow further tightening. The `BudgetExhaustedError` terminates the session cleanly, and the run record captures the exhaustion event.

### 11.5 Job definition integrity

Job files are stored under `~/.ironcurtain/` which is a protected path in the structural invariants. The agent cannot modify its own job definition or policy through policy-mediated tool calls. Its workspace (by default `~/.ironcurtain/jobs/<id>/workspace/`, which holds `last-run.md`) is its writable `allowedDirectory` by design, so it can change what it leaves there for later runs; persistent memory goes through the memory MCP server. Direct filesystem access outside the workspace is denied.

### 11.6 A job runs only under the policy compiled from its own constitution

`add-job` saves the job **disabled**, runs the full verify-and-repair compile into the job's `generated/` directory, checks that the written `compiled-policy.json` records the hash of the job's `taskConstitution`, and only then saves the job enabled. A compile that fails, or is interrupted (Ctrl-C), leaves the job on disk but disabled; `recompile-job` followed by `enable-job` completes it. So does a compile that wrote the policy without some servers (`failedServers`, §8.5): the job is left disabled and `add-job` exits 2, naming them.

The policy is also checked at run time, so a hand-written `job.json` or a later edit cannot slip through. Before each run, `executeJob` (`src/cron/job-policy.ts`) requires that `jobs/{id}/generated/compiled-policy.json` exists and that its `constitutionHash` equals the sha256 of the job's current `taskConstitution` (for a job with `persona`, that the persona's policy matches the persona's `constitution.md`). Otherwise no session is created: the run ends with an `error` RunRecord (phase `setup`) naming the fix (`ironcurtain daemon recompile-job <id>`) and a Signal "Not run" notification when Signal is configured. A persona job is refused the same way, before the git sync, when the persona's `agentModelId` or `resourceBudget` is malformed (`findPersonaOverridesProblem` in `src/persona/persona-overrides.ts`); the session factory would refuse it anyway. There is no override for unattended runs. `edit-job` recompiles the policy of a job without a persona when its constitution or workspace (the directory the policy is compiled against) changed or the existing policy is missing or stale; if that compile fails, the job is still saved, so it will not run until a recompile succeeds. The `constitutionHash` check cannot notice a changed workspace, so a workspace change first moves the job's own policy aside (`revokeJobPolicy`, to `generated/compiled-policy.revoked.json`, the name a persona's revoked policy gets), also for a persona job, whose own policy would otherwise apply again once the persona is removed. Neither `add-job` nor `edit-job` compiles a persona job's own task policy, which it never runs under: `add-job` saves it enabled only when the persona passes the run-time checks, and `edit-job` reports a persona that does not. The daemon never compiles at startup; it lists jobs whose policy is missing or stale in its startup output and log.

As a second layer, `buildSessionConfig` refuses any per-job or per-persona `policyDir` that has no `compiled-policy.json` instead of letting the policy loaders fall back to the package's default policy.

A resumed session (`ironcurtain start --resume <id>`) restores its `policyDir` from session metadata and never passes `executeJob`. When that directory is a job's own `generated/` directory, `buildSessionConfig` checks it against the job's current `taskConstitution` (`checkJobPolicyDir` in `src/cron/job-policy.ts`) and refuses a stale policy. Because a resume is interactive, the user may override with `--allow-stale-policy`, which warns on the terminal and in the session log.

### 11.7 Signal identity verification applies to cron escalations

Cron escalation notifications and approvals flow through the same Signal transport, with the same identity verification (fail-closed, TTL-cached fingerprint checks). A SIM-swap attack cannot approve cron escalations any more than it can approve interactive ones.

### 11.8 Task description is the trust root for per-job policy

The per-job compiled policy is only as good as the task description. A vague task description ("do whatever needs doing") would produce a broad policy. The LLM compiler is instructed to be a strict whitelist, but the ultimate scope is bounded by the user's description. The compilation wizard should warn about overly broad descriptions.

### 11.9 The run summary is untrusted agent output

`last-run.md` lives in the agent-writable workspace (a read-write bind mount in Docker mode), so the agent can make it a symlink to a host secret, a FIFO, a device link or a huge sparse file. The daemon touches it only through `src/cron/run-summary.ts`: before a run it renames the previous file to `previous-run.md` (a rename moves the entry itself; nothing is opened or followed), so a run that writes no summary is never credited with the previous one; after the session has been torn down it reads at most 8 KiB with `readUntrustedRegularFile` (`O_NOFOLLOW | O_NONBLOCK`, regular files only), so a symlink is not followed and a FIFO never blocks the daemon's event loop. Terminal escape sequences and control characters are removed and bidi controls shown as escapes before the text reaches the run record, logs or the Signal notice. The text is also the agent's own words, so the Signal completion notice fences it: under "Summary written by the job's agent:" every line is quoted as `│ ...`, remaining invisible and format characters are shown as escapes, the cut is marked with its omitted count, and the notice goes out in plain text (normal text mode). No line of it can start like an escalation banner (`[#`) or render as styled text.

## 12. Testing Strategy

### 12.1 Unit tests

| Component                             | Test file                           | Key scenarios                                                                                                              |
| ------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `JobStore`                            | `test/job-store.test.ts`            | CRUD operations, directory creation, run record persistence, malformed JSON handling                                       |
| `CronScheduler`                       | `test/cron-scheduler.test.ts`       | Schedule/unschedule, next-run calculation, overlap detection, `InvalidCronExpressionError` on bad expressions              |
| `SessionManager`                      | `test/session-manager.test.ts`      | Register/end lifecycle, label auto-increment, currentLabel switching, escalation state, `withPendingEscalation()`          |
| `HeadlessTransport`                   | `test/headless-transport.test.ts`   | Single-shot message delivery, auto-deny escalation, Signal-notify escalation, response capture                             |
| `PipelineRunner`                      | `test/pipeline-runner.test.ts`      | `ConstitutionKind` prompt variant selection, content-hash caching, outputDir isolation, `includeHandwrittenScenarios` flag |
| `compileTaskPolicy()`                 | `test/task-policy-compiler.test.ts` | Task description to rules, cache hit, cache invalidation, verification failure handling                                    |
| `buildCronSystemPromptAugmentation()` | `test/cron-prompts.test.ts`         | Prompt content verification, workspace path injection                                                                      |
| `IronCurtainDaemon`                   | `test/ironcurtain-daemon.test.ts`   | Job lifecycle (add/remove/enable/disable), overlap skip, shutdown cleanup                                                  |
| `IronCurtainDaemon.executeJob()`      | `test/daemon-execute-job.test.ts`   | Reservation (long sync, same-minute triggers, `jobs.run`), workspace lock, recorded outcomes, canonical workspace, summary |
| `run-summary.ts`                      | `test/cron-run-summary.test.ts`     | Retiring and reading an untrusted `last-run.md` (symlink, FIFO, size, control characters), notification text               |

### 12.2 Integration tests

**Per-job policy compilation** (`test/task-policy-integration.test.ts`):

- Compile the GitHub issue triage task description against real tool annotations.
- Verify the produced rules allow the expected tools and deny others.
- Verify against a real PolicyEngine instance.
- Requires `INTEGRATION_TEST=true` (makes LLM calls).

**Cron session lifecycle** (`test/cron-session-integration.test.ts`):

- Create a job with a simple task ("list files in the workspace and write a summary").
- Run it via `runJobNow()`.
- Verify the workspace contains `last-run.md`.
- Verify the RunRecord was written.
- Requires a running filesystem MCP server.

### 12.3 Mock strategy

- `CronScheduler`: mock implementation that exposes a `trigger(jobId)` method for synchronous testing.
- `SessionManager`: real instance (lightweight, no I/O) -- test session registration, lookup, and escalation state directly.
- `SignalBotDaemon`: mock that records `sendSignalMessage()` calls for notification verification.
- `Session`: existing mock session from test infrastructure.
- LLM: mock model for unit tests; real model for integration tests.

## 13. Files Changed

| File                                    | Change                                                                                                                                                                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/cron/types.ts`                     | **New.** `JobId`, `JobDefinition`, `JobBudgetOverrides`, `RunOutcome`, `RunRecord`.                                                                                                                                                     |
| `src/cron/job-store.ts`                 | **New.** Filesystem-backed CRUD for jobs and run records.                                                                                                                                                                               |
| `src/cron/cron-scheduler.ts`            | **New.** `CronScheduler` interface and `node-cron` implementation (as built, no `node-cron`: the scheduler computes fire times itself and polls every 30 seconds).                                                                      |
| `src/cron/headless-transport.ts`        | **New.** `HeadlessTransport` for single-shot cron sessions.                                                                                                                                                                             |
| `src/daemon/ironcurtain-daemon.ts`      | **New.** `IronCurtainDaemon` composing Signal + cron. Imports and re-exports `SessionSource`, `ManagedSession` from `session-manager.ts`.                                                                                               |
| `src/daemon/daemon-command.ts`          | **New.** CLI entry point for `ironcurtain daemon` and subcommands.                                                                                                                                                                      |
| `src/pipeline/pipeline-runner.ts`       | **New.** `PipelineRunner` class, `ConstitutionKind`, `PipelineRunConfig`, `PipelineModels`. Encapsulates compile-verify-repair loop.                                                                                                    |
| `src/pipeline/task-policy-compiler.ts`  | **New.** `compileTaskPolicy()` convenience wrapper over `PipelineRunner` with task-policy defaults.                                                                                                                                     |
| `src/pipeline/compile.ts`               | **Refactored:** `main()` becomes thin CLI wrapper over `PipelineRunner.run()`. Existing behavior unchanged.                                                                                                                             |
| `src/pipeline/constitution-compiler.ts` | Extract `RULE_FORMAT_DOCUMENTATION` constant for shared use by both prompt variants.                                                                                                                                                    |
| `src/config/index.ts`                   | Update `loadGeneratedPolicy()` to accept `PolicyLoadOptions` (split policyDir / toolAnnotationsDir). Existing callers updated to pass both dirs pointing to global location.                                                            |
| `src/session/types.ts`                  | Add `policyDir?` and `systemPromptAugmentation?` to `SessionOptions`.                                                                                                                                                                   |
| `src/session/index.ts`                  | Thread `policyDir` into `buildSessionConfig()`. Override `generatedDir` when set.                                                                                                                                                       |
| `src/session/agent-session.ts`          | Append `systemPromptAugmentation` to system prompt in `initialize()`.                                                                                                                                                                   |
| `src/session/prompts.ts`                | Add `CronPromptContext` and `buildCronSystemPromptAugmentation()`.                                                                                                                                                                      |
| `src/config/paths.ts`                   | Add `getJobsDir()`, `getJobDir()`, `getJobGeneratedDir()`, `getJobWorkspaceDir()`, `getJobRunsDir()`.                                                                                                                                   |
| `src/session/session-manager.ts`        | **New.** `SessionManager` class extracted from `SignalBotDaemon`. Owns session map, labels, escalation state. Defines and exports `SessionSource` and `ManagedSession` types (canonical location -- daemon re-exports for convenience). |
| `src/signal/signal-bot-daemon.ts`       | **Refactored:** session map and lifecycle methods extracted to `SessionManager`. Retains Signal WebSocket, identity verification, message parsing, and command handling. Accepts `SessionManager` via constructor.                      |
| `src/cli.ts`                            | Add `daemon` case routing to `daemon-command.ts`. `bot` stays the Signal transport alone (Section 8.1).                                                                                                                                 |
| `package.json`                          | Add `node-cron` dependency (not added: the scheduler has no cron library).                                                                                                                                                              |

## 14. Migration Plan

### Phase 1: Foundation types and job store (1 PR)

1. Create `src/cron/types.ts` with `JobId`, `JobDefinition`, `RunRecord`, etc.
2. Create `src/cron/job-store.ts` with filesystem CRUD.
3. Add path helpers to `src/config/paths.ts`.
4. Unit tests for job store.

### Phase 2: Session parameterization (1 PR)

1. Add `policyDir` and `systemPromptAugmentation` to `SessionOptions`.
2. Thread `policyDir` through `buildSessionConfig()` in `src/session/index.ts`.
3. Append augmentation in `AgentSession.initialize()`.
4. Add `buildCronSystemPromptAugmentation()` to `src/session/prompts.ts`.
5. Unit tests verifying session creates with custom policy dir and augmented prompt.

### Phase 3: PipelineRunner and task policy compiler (1 PR)

1. Create `src/pipeline/pipeline-runner.ts` with `PipelineRunner`, `ConstitutionKind`, `PipelineRunConfig`.
2. Extract `RULE_FORMAT_DOCUMENTATION` from `buildCompilerSystemPrompt()` in `constitution-compiler.ts` into a shared constant.
3. Refactor `compile.ts` `main()` to be a thin wrapper over `PipelineRunner.run()` with `constitutionKind: 'constitution'`. Existing CLI behavior is unchanged.
4. Create `src/pipeline/task-policy-compiler.ts` with `compileTaskPolicy()` convenience wrapper using `constitutionKind: 'task-policy'` (now `src/cron/compile-task-policy.ts`, which includes the universal handwritten invariants).
5. Integration test: compile the issue triage task against real annotations.

### Phase 4: Headless transport and cron scheduler (1 PR)

1. Create `src/cron/headless-transport.ts`.
2. Create `src/cron/cron-scheduler.ts` with `node-cron` integration (as built, it computes fire times itself and polls every 30 seconds).
3. Add `node-cron` to `package.json` (not done: no cron library is used).
4. Unit tests for both components.

### Phase 5: SessionManager extraction and unified daemon (1 PR)

1. Create `src/session/session-manager.ts` -- extract session map, label counter, escalation state management, and `currentLabel` from `SignalBotDaemon`.
2. Refactor `SignalBotDaemon` to accept `SessionManager` via constructor. Remove internal session map. All session operations delegate to `SessionManager`.
3. Create `src/daemon/ironcurtain-daemon.ts` -- owns `SessionManager`, composes `SignalBotDaemon` + `CronScheduler`.
4. Create `src/daemon/daemon-command.ts` with subcommand routing.
5. Register `daemon` in `src/cli.ts`. `bot` keeps running the Signal transport alone (see Section 8.1).
6. Integration test: start daemon, add job, trigger manually, verify run record.

### Phase 6: CLI polish and documentation (1 PR)

1. Implement `add-job` interactive wizard using `@clack/prompts`.
2. Implement `list-jobs`, `logs`, `remove-job`, `disable-job`, `enable-job`, `recompile-job`.
3. Update help text in `src/cli.ts`.
4. User-facing documentation.

## 15. Future Extensions

### 15.1 Web dashboard for job monitoring

A local web UI showing job status, run history, and budget trends. Reads the same `~/.ironcurtain/jobs/` filesystem structure.

### 15.2 Job chaining

Allow jobs to trigger other jobs on completion (e.g., "after issue triage, run code health check"). Would require a DAG scheduler extension.

### 15.3 Adaptive scheduling

Adjust cron frequency based on workload (e.g., check issues hourly during active development, daily otherwise). Requires the agent to signal scheduling hints via workspace files.

### 15.4 Cross-job shared context

Allow jobs to read (but not write) other jobs' workspaces for information sharing. Requires policy extension to model cross-job read access.

### 15.5 Approval templates

For recurring escalation patterns, allow the user to pre-approve certain escalation types for a job (e.g., "always approve close_issue for issue-triage"). This would be a per-job auto-approve configuration layered on top of the existing auto-approver infrastructure.
