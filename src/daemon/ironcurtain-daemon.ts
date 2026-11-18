/**
 * IronCurtainDaemon -- Unified daemon managing both Signal-initiated
 * interactive sessions and cron-scheduled headless sessions.
 *
 * Lifecycle:
 *   1. start() -- takes the daemon singleton lock (one daemon per IronCurtain
 *      home), binds the control socket (fatal on failure), loads and
 *      schedules jobs, starts Signal (if configured, and unless another
 *      process holds the Signal transport lock: then cron-only)
 *   2. Runs indefinitely, processing Signal messages and cron triggers
 *   3. shutdown() -- stops CLI intake, aborts and tears down workflow runs
 *      (bounded), then unschedules all jobs, cancels cron runs in progress,
 *      ends all sessions, disconnects, waits (bounded) for the cancelled runs
 *      to record their outcome, releases the locks
 *
 * Both Signal and cron sessions are managed through a shared SessionManager
 * instance. This enables unified escalation routing: a cron job's escalation
 * banner goes out over Signal with its own reply code, and `approve <code>`
 * works for both Signal-initiated and cron-initiated sessions.
 */

import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { syncGitRepo, type GitSyncResult } from '../cron/git-sync.js';
import { createStandaloneSession } from '../session/index.js';
import { loadConfig } from '../config/index.js';
import { loadUserConfig } from '../config/user-config.js';
import {
  getJobWorkspaceDir,
  getJobGeneratedDir,
  getJobDir,
  getJobRepoMirrorDir,
  getWebUiStatePath,
  getWorkflowWorkspaceLocksDir,
} from '../config/paths.js';
import {
  parseSessionId,
  type SessionMode,
  type SessionId,
  type EscalationRequest,
  type Session,
  type SessionOptions,
} from '../session/types.js';
import { SessionManager, type SessionSource } from '../session/session-manager.js';
import { HeadlessTransport } from '../cron/headless-transport.js';
import { shouldAutoSaveMemory } from '../memory/auto-save.js';
import { buildCronSystemPromptAugmentation } from '../session/prompts.js';
import { createCronScheduler, type CronScheduler, type JobTrigger } from '../cron/cron-scheduler.js';
import {
  loadAllJobs,
  loadJob,
  readJob,
  scanJobs,
  saveJob,
  updateJob,
  deleteJob,
  saveRunRecord,
  loadLatestRun,
  countConsecutiveFailures,
} from '../cron/job-store.js';
import { compileTaskPolicy } from '../cron/compile-task-policy.js';
import { checkJobPolicy } from '../cron/job-policy.js';
import { failedServerNames } from '../cron/partial-compile.js';
import { findPersonaOverridesProblem } from '../persona/persona-overrides.js';
import {
  formatRunNotification,
  formatRunRefusal,
  readRunSummary,
  retireRunSummary,
  RunNoticeCollector,
  RUN_SUMMARY_FILE,
} from '../cron/run-summary.js';
import type { JobDefinition, JobId, RunRecord, RunOutcome, RunFailurePhase } from '../cron/types.js';
import { CRON_BUDGET_DEFAULTS, JobAlreadyRunningError, JobNotFoundError } from '../cron/types.js';
import { BudgetExhaustedError } from '../types/errors.js';
import { validateWorkspacePath } from '../session/workspace-validation.js';
import * as logger from '../logger.js';
import { getDaemonLogPath } from '../config/paths.js';
import { CONTAINER_WORKSPACE_DIR } from '../docker/agent-adapter.js';
import { getTokenStreamBus } from '../docker/token-stream-bus.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import {
  ControlSocketServer,
  type ControlRequestHandler,
  type DaemonStatus,
  type DaemonWebUiState,
  type FailingJobStatus,
  type JobListEntry,
  type JobRunStart,
  type RecompileJobResultDto,
  type RefreshListsRequest,
  type RefreshListsResultDto,
} from './control-socket.js';
import { acquireDaemonLock, type DaemonLock } from './daemon-lock.js';
import type { ProcessLockHandle } from '../docker-workload/process-lock.js';
import { claimWorkflowWorkspaceLock, isWorkflowLockBusyError, releaseWorkflowLock } from '../workflow/run-lock.js';
import { acquireSignalLock, isSignalLockBusyError, type SignalLock } from '../signal/signal-lock.js';
import type { LlmMetricsRuntimeLease } from '../llm-metrics/runtime.js';
import { processLogRotation } from '../maintenance/log-rotation.js';
import { PRUNE_BUSY, runPrune } from '../maintenance/prune.js';
import { summarizePruneReport } from '../maintenance/prune-format.js';
import { RETENTION_CONFIG_DEFAULTS, type ResolvedRetentionConfig } from '../config/user-config.js';

export type { SessionSource, ManagedSession } from '../session/session-manager.js';

export interface IronCurtainDaemonOptions {
  /** Session mode for both Signal and cron sessions. */
  readonly mode: SessionMode;

  /** When true, skip starting Signal transport. */
  readonly noSignal?: boolean;

  /** When set, starts the web UI server. */
  readonly webUi?: { port?: number; host?: string; devMode?: boolean };

  /**
   * Process-wide default for trajectory capture. Set via the daemon CLI
   * `--capture-traces` flag. Becomes the fallback for every session the
   * daemon launches; per-session JSON-RPC overrides win when present.
   * See docs/designs/mitm-token-trajectory-capture.md §10.
   */
  readonly captureTracesDefault?: boolean;

  /**
   * Enables the persona policy-mutation methods over the web UI. Set via the
   * daemon CLI `--allow-policy-mutation` flag. Off by default; CLI-only (not
   * config-persisted). When off, every web-UI persona-mutation method returns
   * POLICY_MUTATION_FORBIDDEN. See docs/designs/web-ui-policy-persona-management.md §7.
   */
  readonly allowPolicyMutation?: boolean;

  /**
   * How long `shutdown()` waits for its workflows to abort, snapshot and tear
   * down before it moves on. Defaults to
   * {@link DAEMON_WORKFLOW_SHUTDOWN_DEADLINE_MS}; tests shorten it.
   */
  readonly workflowShutdownDeadlineMs?: number;

  /**
   * With `retention.autoPrune`, how long after start the first automatic
   * prune runs. Defaults to {@link AUTO_PRUNE_START_DELAY_MS}; tests shorten it.
   */
  readonly autoPruneStartDelayMs?: number;
}

/**
 * With `retention.autoPrune`, the first automatic prune runs this long after
 * the daemon started (out of the way of start-up), then every
 * `retention.autoPruneIntervalHours`.
 */
export const AUTO_PRUNE_START_DELAY_MS = 60_000;

/** Longest `shutdown()` waits for an automatic prune it stopped to wind down. */
const AUTO_PRUNE_STOP_WAIT_MS = 10_000;

/** Node keeps timer delays in a signed 32-bit int; a longer one would fire at once. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Terminal reason recorded for runs stopped by a daemon shutdown. */
export const DAEMON_WORKFLOW_SHUTDOWN_REASON = 'Daemon shutdown';

/**
 * Upper bound on the workflow part of a daemon shutdown (abort, snapshot,
 * teardown of every run). Well below systemd's default `TimeoutStopSec`
 * (90 s) so the web UI, Signal and session teardown that follow still fit
 * before the service manager sends SIGKILL. An overrun is logged and the
 * shutdown continues; leftover containers are then reclaimed by the startup
 * reconciliation of the next Docker session (docker runtime) or
 * `ironcurtain gc`.
 */
export const DAEMON_WORKFLOW_SHUTDOWN_DEADLINE_MS = 60_000;

/**
 * Container-snapshot budget per run within the workflow shutdown deadline
 * (see `WorkflowStopOptions.snapshotBudgetMs`), leaving the rest for the
 * container teardown itself.
 */
export const DAEMON_WORKFLOW_SNAPSHOT_BUDGET_MS = 40_000;

/**
 * The daemon's signal handler forces the exit this long after the first
 * signal if the graceful shutdown has not finished: past the workflow
 * deadline, still before systemd's default 90 s SIGKILL so exit handlers run.
 */
export const DAEMON_FORCE_EXIT_MS = 85_000;

/**
 * Syncs a job's `gitRepo` into its workspace through the daemon-owned
 * mirror (never through the agent-writable workspace `.git`). Asynchronous
 * with per-operation timeouts, so a slow or hung remote never blocks the
 * daemon's event loop. Aborting `signal` kills the running git command.
 */
function syncJobGitRepo(
  job: JobDefinition,
  gitRepo: string,
  workspace: string,
  signal?: AbortSignal,
): Promise<GitSyncResult> {
  return syncGitRepo({
    uri: gitRepo,
    workspaceDir: workspace,
    mirrorDir: getJobRepoMirrorDir(job.id),
    managedWorkspace: job.workspace === undefined,
    ...(signal ? { signal } : {}),
  });
}

/**
 * The workspace a job runs in, in canonical form. A user-supplied
 * `job.workspace` (which may use `~`, be relative, or pass through symlinks)
 * is checked by validateWorkspacePath() and its canonical return value is
 * what the git sync, the session (allowedDirectory and Docker mount) and the
 * summary read all use, so the checked path is the path in use. The default
 * job workspace is derived by IronCurtain itself.
 *
 * @throws WorkspaceValidationError for an unsafe or missing custom workspace
 */
function resolveJobWorkspace(job: JobDefinition, protectedPaths: readonly string[]): string {
  return job.workspace === undefined
    ? getJobWorkspaceDir(job.id)
    : validateWorkspacePath(job.workspace, protectedPaths);
}

/**
 * Claims the workspace of a job run (`resolveJobWorkspace`): the lock keyed by
 * the directory's identity under `{home}/workflow-workspace-locks/`
 * (`src/workflow/run-lock.ts`), which every workflow run holds too. So two
 * jobs that share a custom workspace, or a job and a workflow, never run in
 * one directory at the same time, in this process or across processes, and
 * no git sync resets files under another run's agent. The job's own default
 * workspace is created first, as its git sync would.
 *
 * @throws WorkflowLockBusyError (code WORKFLOW_LOCK_BUSY) while a live run holds it
 */
function claimJobWorkspaceLock(job: JobDefinition, workspace: string): ProcessLockHandle {
  if (job.workspace === undefined) mkdirSync(workspace, { recursive: true });
  return claimWorkflowWorkspaceLock(getWorkflowWorkspaceLocksDir(), workspace);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Budget of a run that never had a session. */
const NO_BUDGET_SPENT: RunRecord['budget'] = { totalTokens: 0, stepCount: 0, elapsedSeconds: 0, estimatedCostUsd: 0 };

/**
 * The session's resource consumption, or nothing spent when it cannot be
 * read. Taken once the run is over, when the session's per-turn fields are
 * already reset: the run's consumption is the session total (the task turn
 * plus any memory auto-save turn). The cost keeps its source, so a run whose
 * cost nothing reported is recorded (and shown) as unknown, not as $0.00.
 */
function budgetSnapshot(session: Session): RunRecord['budget'] {
  try {
    const status = session.getBudgetStatus();
    const usage = status.cumulative;
    return {
      totalTokens: usage.totalTokens,
      stepCount: usage.stepCount,
      elapsedSeconds: usage.activeSeconds,
      estimatedCostUsd: usage.estimatedCostUsd,
      ...(status.costSource !== undefined ? { costSource: status.costSource } : {}),
    };
  } catch {
    return NO_BUDGET_SPENT;
  }
}

/** Why an in-progress run was stopped from outside. */
type JobRunCancellation = 'removed' | 'shutdown';

const CANCELLATION_MESSAGES: Record<JobRunCancellation, string> = {
  removed: 'Run cancelled: the job was removed',
  shutdown: 'Run cancelled: the daemon is shutting down',
};

/**
 * The reservation of one run of a job, held from the first statement of
 * executeJob() until its record is written. The object itself is the run's
 * token: cleanup releases the job only while the map still holds this object.
 */
interface ActiveJobRun {
  /** Session label once the run's session is registered; undefined while it is set up. */
  label: number | undefined;
  /** Set by removeJob()/shutdown(); the run stops at its next step. */
  cancelled: JobRunCancellation | undefined;
  /** Aborted on cancellation: kills a git sync in progress. */
  readonly abort: AbortController;
  /** Settles (never rejects) when the run has finished, its reservation released. */
  settled: Promise<void>;
}

/** Throws the cancellation as the run's failure once the run was cancelled. */
function throwIfCancelled(run: ActiveJobRun): void {
  if (run.cancelled !== undefined) throw new Error(CANCELLATION_MESSAGES[run.cancelled]);
}

/** Removes an escalation that was resolved before its session was registered. */
function dropEscalation(queue: EscalationRequest[], escalationId: string): void {
  const index = queue.findIndex((request) => request.escalationId === escalationId);
  if (index !== -1) queue.splice(index, 1);
}

/** A scheduled trigger waiting for a free run slot (see `cron.maxConcurrentRuns`). */
interface QueuedJobRun {
  readonly trigger: JobTrigger;
  readonly queuedAt: Date;
}

/** Longest removeJob()/shutdown() waits for a cancelled run to wind down. */
const CANCELLED_RUN_WAIT_MS = 10_000;

/** Waits for `promise` or `ms` milliseconds, whichever comes first. */
async function waitAtMost(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The resource limits of a cron job run, as session options. The cron
 * defaults replace the global limits as the run's baseline; a persona job's
 * persona `resourceBudget` sits above them, and the job's own
 * `budgetOverrides` above that (see session/model-budget-precedence.ts).
 */
function cronSessionBudgetOptions(
  job: Pick<JobDefinition, 'budgetOverrides'>,
): Pick<SessionOptions, 'resourceBudgetBaseline' | 'resourceBudgetOverrides'> {
  return {
    resourceBudgetBaseline: CRON_BUDGET_DEFAULTS,
    ...(job.budgetOverrides !== undefined ? { resourceBudgetOverrides: job.budgetOverrides } : {}),
  };
}

export class IronCurtainDaemon {
  private readonly mode: SessionMode;
  private readonly noSignal: boolean;
  private readonly sessionManager = new SessionManager();
  private readonly scheduler: CronScheduler;

  /** Time the daemon was started (for uptime calculation). */
  private startTime: Date | null = null;

  /**
   * The daemon's claim on the logger (daemon.log), taken by start() and
   * given back at shutdown. Process-wide: every line that no session binds
   * to its own claim goes to daemon.log, also while sessions are running,
   * and a session that ends gives back only its own claim.
   */
  private logClaim: logger.LoggerClaim | undefined;

  /**
   * The run in progress of each job, reserved synchronously when the run
   * starts (before the git sync and session creation), so at most one run of
   * a job exists at a time whether it was scheduled or started manually.
   */
  private readonly activeJobRuns = new Map<string, ActiveJobRun>();

  /**
   * Scheduled triggers waiting for a free run slot, oldest first, at most one
   * per job. Filled only while `cron.maxConcurrentRuns` runs are in progress;
   * each settled run starts the next waiting one.
   */
  private readonly queuedJobRuns = new Map<string, QueuedJobRun>();

  /**
   * Most runs the scheduler starts at once (`cron.maxConcurrentRuns`; null:
   * no limit). Read from the user config by start(); manual runs are never
   * refused but count toward it.
   */
  private maxConcurrentCronRuns: number | null = null;

  /**
   * Whether a fire time missed while the machine slept or the daemon was
   * blocked still runs once when the daemon notices (`cron.catchUpMissedRuns`,
   * read by start()). Off by default, as in standard cron.
   */
  private catchUpMissedRuns = false;

  /** Control socket server for CLI communication. */
  private controlSocket: ControlSocketServer | null = null;

  /** Singleton lock held from start() until shutdown() (null when not started). */
  private daemonLock: DaemonLock | null = null;

  /** Signal daemon instance (null if Signal not configured). */
  private signalDaemon: import('../signal/signal-bot-daemon.js').SignalBotDaemon | null = null;

  /**
   * The Signal transport lock (src/signal/signal-lock.ts), held from a
   * successful Signal start until shutdown() (null without Signal).
   */
  private signalLock: SignalLock | null = null;

  /** Web UI server (null if not enabled). */
  private webUiServer: import('../web-ui/web-ui-server.js').WebUiServer | null = null;

  /** Token stream bridge (null if web UI not enabled). */
  private tokenStreamBridge: import('../web-ui/token-stream-bridge.js').TokenStreamBridge | null = null;

  /**
   * The workflow manager behind the web UI (null if the web UI is not
   * enabled). Kept here so `shutdown()` can stop its runs: workflow sessions
   * are not in the SessionManager, and the web UI server does not own them.
   */
  private workflowManager: import('../workflow/workflow-manager.js').WorkflowManager | null = null;

  /** The one shutdown in progress; a second `shutdown()` call joins it. */
  private shutdownPromise: Promise<void> | null = null;

  /** See {@link IronCurtainDaemonOptions.workflowShutdownDeadlineMs}. */
  private readonly workflowShutdownDeadlineMs: number;

  /** Daemon-owned reference keeps the shared statistics writer/reader available to the web UI. */
  private metricsRuntime: LlmMetricsRuntimeLease | null = null;

  /** Web UI options from constructor. */
  private readonly webUiOptions: IronCurtainDaemonOptions['webUi'];

  /**
   * Reported in `status`, so `--ensure-daemon` can tell a daemon whose web UI
   * is still coming up (wait for it) from one that has none (fail at once).
   */
  private webUiState: DaemonWebUiState;

  /** Daemon-process-wide capture-traces default (set via CLI). */
  private readonly captureTracesDefault: boolean;

  /** Persona policy-mutation kill switch (set via CLI `--allow-policy-mutation`). */
  private readonly allowPolicyMutation: boolean;

  /** Control request handler (saved for web UI reuse). */
  private controlRequestHandler: ControlRequestHandler | null = null;

  /**
   * Tracks bridge labels allocated for workflow-owned agent sessions.
   * Workflow sessions don't go through SessionManager (they have no
   * Transport), so they need their own SessionId -> label map. Labels
   * are drawn from SessionManager.reserveLabel() to keep the label
   * space unified.
   *
   * Each `agent_started` mints a fresh SessionId (even when
   * `freshSession: false` reuses the AgentConversationId) and reserves
   * a fresh label. `agent_session_ended` always tears down. The map
   * is keyed by SessionId so the tear-down handler can recover the
   * label assigned at start time.
   */
  private readonly workflowAgentLabels = new Map<SessionId, number>();

  /** Resolve to exit the daemon. */
  private exitResolve: (() => void) | null = null;

  /** Timers of the automatic prune (`retention.autoPrune`); undefined when it is off. */
  private autoPruneTimers: { start: NodeJS.Timeout; interval: NodeJS.Timeout } | undefined;

  /** The automatic prune in progress, if any. Settles (never rejects) when it ends. */
  private autoPruneInFlight: Promise<void> | undefined;

  /** Stops an automatic prune in progress at shutdown. */
  private readonly autoPruneAbort = new AbortController();

  /** See {@link IronCurtainDaemonOptions.autoPruneStartDelayMs}. */
  private readonly autoPruneStartDelayMs: number;

  constructor(options: IronCurtainDaemonOptions) {
    this.mode = options.mode;
    this.noSignal = options.noSignal ?? false;
    this.webUiOptions = options.webUi;
    this.webUiState = options.webUi ? 'starting' : 'disabled';
    this.captureTracesDefault = options.captureTracesDefault ?? false;
    this.allowPolicyMutation = options.allowPolicyMutation ?? false;
    this.workflowShutdownDeadlineMs = options.workflowShutdownDeadlineMs ?? DAEMON_WORKFLOW_SHUTDOWN_DEADLINE_MS;
    this.autoPruneStartDelayMs = options.autoPruneStartDelayMs ?? AUTO_PRUNE_START_DELAY_MS;
    this.scheduler = createCronScheduler();
  }

  /**
   * Starts the daemon. Loads all enabled jobs, schedules them,
   * optionally starts the Signal transport.
   *
   * @throws DaemonLockBusyError (code `DAEMON_LOCK_BUSY`) when another daemon
   *   (or a local job command) already holds the daemon lock, and any error
   *   binding the control socket. Nothing has been scheduled or started then.
   */
  async start(): Promise<void> {
    // One daemon per IronCurtain home. Take the lock before logging, binding
    // the control socket or scheduling anything: a second daemon would run
    // every cron job a second time and take over the CLI's socket.
    this.daemonLock = acquireDaemonLock();

    let retention: ResolvedRetentionConfig;
    try {
      this.startTime = new Date();

      const startupUserConfig = loadUserConfig({ readOnly: true });
      retention = startupUserConfig.retention ?? RETENTION_CONFIG_DEFAULTS;

      // Set up file-based logger (redirects console.* to log file). The
      // daemon's own lines -- from its control socket, scheduled jobs,
      // Signal and the web UI alike -- go to daemon.log even while the
      // sessions it runs log to their own files. daemon.log rotates by size
      // (retention.logs).
      this.logClaim = logger.setup({
        logFilePath: getDaemonLogPath('daemon'),
        processWide: true,
        rotation: processLogRotation(retention),
      });

      const statisticsConfig = startupUserConfig.statistics;
      this.maxConcurrentCronRuns = startupUserConfig.cron?.maxConcurrentRuns ?? null;
      this.catchUpMissedRuns = startupUserConfig.cron?.catchUpMissedRuns ?? false;
      if (statisticsConfig.enabled) {
        try {
          const { acquireLlmMetricsRuntime } = await import('../llm-metrics/runtime.js');
          this.metricsRuntime = await acquireLlmMetricsRuntime({ retentionDays: statisticsConfig.retentionDays });
        } catch (error) {
          logger.warn(`[Daemon] LLM statistics unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      // CLI commands find the daemon through this socket. Without it they would
      // run jobs locally beside this daemon, so a failed bind is fatal.
      await this.startControlSocket();

      // Nested Docker: reclaim leases a crash or a failed teardown left
      // behind now, in the background, instead of when the next nested
      // session starts. Each lease's recovery is bounded; startup and jobs
      // never wait for it, and admission serializes with it per lease.
      void import('../docker-workload/workload-command.js')
        .then(({ reconcileDockerWorkloadLeasesAtStartup }) => reconcileDockerWorkloadLeasesAtStartup())
        .then((outcome) => {
          if (outcome !== undefined) logger.info(`[Daemon] ${outcome}`);
        })
        .catch((error: unknown) => {
          logger.warn(
            `[Daemon] nested-Docker lease recovery did not run: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    } catch (err) {
      await this.abortStartup();
      throw err;
    }

    // Load and schedule all enabled jobs. A job.json that is invalid (torn,
    // hand-edited, wrong id) is reported, never silently dropped.
    const { jobs, invalid: invalidJobs } = scanJobs();
    const enabledJobs = jobs.filter((j) => j.enabled);
    logger.info(`[Daemon] Loaded ${jobs.length} job(s), ${enabledJobs.length} enabled`);
    for (const entry of invalidJobs) {
      logger.warn(
        `[Daemon] Job ${entry.jobId} is not scheduled: ${entry.path} is invalid (${toDisplayText(entry.reason)})`,
      );
    }

    // Jobs are scheduled even when their policy is missing or stale: every
    // run re-checks (executeJob) and records a refusal, so a recompile takes
    // effect without a restart. Startup only reports them; it never compiles.
    const unrunnableJobs: string[] = [];
    for (const job of enabledJobs) {
      try {
        this.scheduleJob(job);
        const nextRun = this.scheduler.getNextRun(job.id);
        logger.info(`[Daemon] Scheduled job ${job.id}: ${job.schedule} (next: ${nextRun?.toISOString() ?? 'unknown'})`);
        const policyCheck = checkJobPolicy(job);
        if (!policyCheck.ok) {
          unrunnableJobs.push(job.id);
          logger.warn(`[Daemon] Job ${job.id} will not run until its policy is fixed: ${policyCheck.message}`);
        }
      } catch (err: unknown) {
        logger.warn(`[Daemon] Failed to schedule job ${job.id}: ${String(err)}`);
      }
    }

    // Start Signal daemon if configured and not disabled
    if (!this.noSignal) {
      try {
        await this.startSignalDaemon();
      } catch (err) {
        // Another process runs the Signal transport for this home: say who,
        // since the daemon carries on without it.
        if (isSignalLockBusyError(err)) process.stderr.write(`Signal transport not started: ${err.message}\n`);
        logger.warn(`[Daemon] Signal transport not available: ${err instanceof Error ? err.message : String(err)}`);
        logger.info('[Daemon] Continuing in cron-only mode');
      }
    }

    // Start web UI server if enabled
    if (this.webUiOptions) {
      try {
        await this.startWebUiServer();
        this.webUiState = 'listening';
      } catch (err) {
        this.webUiState = 'unavailable';
        logger.warn(`[Daemon] Web UI not available: ${err instanceof Error ? err.message : String(err)}`);
        logger.info('[Daemon] Continuing without web UI');
      }
    }

    this.startAutoPrune(retention);

    process.stderr.write('IronCurtain daemon started.\n');
    process.stderr.write('  Control socket: listening\n');
    if (enabledJobs.length > 0) {
      process.stderr.write(`  Scheduled jobs: ${enabledJobs.length}\n`);
    }
    if (unrunnableJobs.length > 0) {
      process.stderr.write(
        `  Jobs that will not run (policy missing or stale; see ironcurtain daemon list-jobs): ` +
          `${unrunnableJobs.join(', ')}\n`,
      );
    }
    if (invalidJobs.length > 0) {
      // Directory names are validated job ids, safe to print as-is.
      process.stderr.write(
        `  Jobs not loaded (job.json invalid; see ironcurtain daemon list-jobs): ` +
          `${invalidJobs.map((entry) => entry.jobId).join(', ')}\n`,
      );
    }
    if (this.signalDaemon) {
      process.stderr.write('  Signal transport: connected\n');
    }
    if (this.autoPruneTimers !== undefined) {
      process.stderr.write(`  Automatic prune: every ${retention.autoPruneIntervalHours}h\n`);
    }

    // Block until shutdown
    await new Promise<void>((resolve) => {
      this.exitResolve = resolve;
    });
  }

  /**
   * Graceful shutdown. Idempotent: a second call (a second signal handler, a
   * test) joins the shutdown already in progress.
   */
  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.runShutdown();
    return this.shutdownPromise;
  }

  private async runShutdown(): Promise<void> {
    logger.info('[Daemon] Shutting down...');

    // No new automatic prune; one in progress stops at its next removal.
    await this.stopAutoPrune();

    // Stop control socket first (reject new CLI commands)
    if (this.controlSocket) {
      try {
        await this.controlSocket.stop();
      } catch (err: unknown) {
        logger.warn(`[Daemon] Error stopping control socket: ${String(err)}`);
      }
      this.controlSocket = null;
    }

    // Stop the workflows while the web UI is still up, so connected clients
    // see each run's terminal `workflow.failed` event. The manager refuses
    // every workflow request from the moment this starts.
    await this.shutdownWorkflows();

    // Stop web UI server (ends web sessions)
    if (this.webUiServer) {
      try {
        await this.webUiServer.stop();
      } catch (err: unknown) {
        logger.warn(`[Daemon] Error stopping web UI: ${String(err)}`);
      }
      this.webUiServer = null;
      this.tokenStreamBridge = null;
      this.removeWebUiState();
    }

    // Unschedule all jobs; runs waiting for a slot never start.
    this.scheduler.unscheduleAll();
    this.queuedJobRuns.clear();

    // Shutdown Signal daemon first (ends Signal sessions via shared SessionManager)
    if (this.signalDaemon) {
      try {
        await this.signalDaemon.shutdown();
      } catch (err: unknown) {
        logger.warn(`[Daemon] Error shutting down Signal: ${String(err)}`);
      }
    }

    // Stop cron runs still being set up (a git sync is killed, a session that
    // is still starting is closed once it exists); running sessions end below.
    const activeRuns = [...this.activeJobRuns.values()];
    for (const run of activeRuns) this.cancelJobRun(run, 'shutdown');

    // End remaining sessions (cron sessions and any Signal stragglers)
    const remaining = this.sessionManager.all();
    await Promise.allSettled(
      remaining.map(async (s) => {
        const sessionId = s.session.getInfo().id;
        try {
          await this.sessionManager.end(s.label);
        } catch (err: unknown) {
          logger.warn(`[Daemon] Error ending session #${s.label}: ${String(err)}`);
        }
        getTokenStreamBus().endSession(sessionId);
        this.tokenStreamBridge?.closeSession(s.label);
      }),
    );

    // Give cancelled cron runs a bounded moment to record their outcome.
    if (activeRuns.length > 0) {
      await waitAtMost(
        Promise.all(activeRuns.map((run) => run.settled)).then(() => undefined),
        CANCELLED_RUN_WAIT_MS,
      );
    }

    await this.releaseMetricsRuntime();

    // Release the singleton locks only once every session has ended (and the
    // cancelled cron runs above have recorded their outcome, or run out of
    // time), so a new daemon, or a bot taking over Signal, cannot start while
    // this one is still tearing down.
    this.releaseSignalLock();
    this.releaseDaemonLock();

    // Give the daemon log back last. Once a run still winding down has
    // closed its session too, no claim is left and console.* is restored.
    this.releaseLogClaim();

    this.exitResolve?.();
  }

  /** Undoes a start() that failed after taking the lock (nothing was scheduled yet). */
  private async abortStartup(): Promise<void> {
    if (this.controlSocket) {
      try {
        await this.controlSocket.stop();
      } catch (err: unknown) {
        logger.warn(`[Daemon] Error stopping control socket: ${String(err)}`);
      }
      this.controlSocket = null;
    }
    await this.releaseMetricsRuntime();
    this.releaseDaemonLock();
    this.releaseLogClaim();
  }

  private releaseLogClaim(): void {
    logger.release(this.logClaim);
    this.logClaim = undefined;
  }

  private async releaseMetricsRuntime(): Promise<void> {
    if (!this.metricsRuntime) return;
    try {
      await this.metricsRuntime.release();
    } catch (error) {
      logger.warn(`[Daemon] Error closing LLM statistics: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.metricsRuntime = null;
  }

  private releaseSignalLock(): void {
    this.signalLock?.release();
    this.signalLock = null;
  }

  private releaseDaemonLock(): void {
    const lock = this.daemonLock;
    if (!lock) return;
    this.daemonLock = null;
    try {
      lock.release();
    } catch (err: unknown) {
      logger.warn(`[Daemon] Error releasing the daemon lock: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Aborts every workflow run with the daemon-shutdown reason: each gets its
   * `snapshotOnStop` snapshot (bounded), a terminal checkpoint, a
   * `run_terminal` marker and its Docker teardown, and its run and workspace
   * locks are released, so the next daemon (or a CLI) can resume it. Bounded
   * by the workflow shutdown deadline; an overrun is logged and the shutdown
   * moves on (the process exit then cuts the rest short).
   */
  private async shutdownWorkflows(): Promise<void> {
    const manager = this.workflowManager;
    if (!manager) return;
    this.workflowManager = null;

    let deadlineTimer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'deadline'>((resolve) => {
      deadlineTimer = setTimeout(() => resolve('deadline'), this.workflowShutdownDeadlineMs);
      deadlineTimer.unref();
    });
    try {
      const outcome = await Promise.race([
        manager
          .shutdown({ reason: DAEMON_WORKFLOW_SHUTDOWN_REASON, snapshotBudgetMs: DAEMON_WORKFLOW_SNAPSHOT_BUDGET_MS })
          .then(() => 'done' as const),
        deadline,
      ]);
      if (outcome === 'deadline') {
        logger.warn(
          `[Daemon] Workflow shutdown did not finish within ${Math.round(this.workflowShutdownDeadlineMs / 1000)}s; ` +
            'continuing. Leftover workflow containers are reclaimed by the next Docker session or `ironcurtain gc`.',
        );
      }
    } catch (err: unknown) {
      logger.warn(`[Daemon] Error shutting down workflows: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(deadlineTimer);
    }
  }

  // -----------------------------------------------------------------------
  // Job management (called by CLI subcommands)
  // -----------------------------------------------------------------------

  /**
   * Adds a new job. Runs the full policy compilation pipeline
   * before confirming. Schedules the job if enabled. A policy written without
   * some servers (they failed to compile) is logged as a warning; the job is
   * still saved as given.
   *
   * Not reachable over the control socket: the protocol has no `add-job`
   * request (the add-job wizard writes the job itself, see
   * saveNewJobWithPolicy), so a socket client can never hand the daemon a
   * whole job definition.
   */
  async addJob(job: JobDefinition): Promise<void> {
    // Validate a custom workspace before proceeding and use its canonical
    // form from here on (a raw `~/...` would otherwise be created literally
    // under the daemon's working directory).
    const workspace =
      job.workspace === undefined ? getJobWorkspaceDir(job.id) : resolveJobWorkspace(job, loadConfig().protectedPaths);

    // Ensure workspace exists
    mkdirSync(workspace, { recursive: true });

    // Clone git repo if specified
    if (job.gitRepo) {
      logger.info(`[Daemon] Cloning repo for job ${job.id}...`);
      const sync = await syncJobGitRepo(job, job.gitRepo, workspace);
      if (!sync.ok) {
        throw new Error(`Git clone ${sync.kind === 'sync_timeout' ? 'timed out' : 'failed'}: ${sync.message}`);
      }
      logger.info(`[Daemon] Repo cloned for job ${job.id} (${sync.branch} at ${sync.commit})`);
    }

    // Compile per-job policy
    logger.info(`[Daemon] Compiling task policy for job ${job.id}...`);
    const failedServers = failedServerNames(await compileTaskPolicy(job));
    if (failedServers.length > 0) {
      logger.warn(
        `[Daemon] Compiled policy for job ${job.id} without ${failedServers.join(', ')}: ` +
          'they failed to compile, so their tools are denied',
      );
    }

    // Save job definition
    await saveJob(job);

    // Schedule if enabled
    if (job.enabled) {
      this.scheduleJob(job);
      const nextRun = this.scheduler.getNextRun(job.id);
      logger.info(`[Daemon] Job ${job.id} scheduled. Next run: ${nextRun?.toISOString() ?? 'unknown'}`);
    }
  }

  /** (Re)schedules `job` with the daemon's trigger handler. @throws InvalidCronExpressionError */
  private scheduleJob(job: JobDefinition): void {
    this.scheduler.schedule(job, (j, trigger) => this.onJobTrigger(j, trigger));
  }

  /**
   * Removes a job. Stops any active run, unschedules, deletes files. An
   * unknown id is an error ({@link JobNotFoundError}), as for the other job
   * operations, rather than a silent success that reads as "removed".
   *
   * An active run is cancelled: a git sync in progress is killed, a session
   * that is still starting is closed as soon as it exists, and a running
   * session is ended here. The files are deleted once the run has wound down
   * (bounded by CANCELLED_RUN_WAIT_MS); the run writes no record for a
   * removed job.
   */
  async removeJob(jobId: JobId): Promise<void> {
    // An invalid job.json can still be removed: that is how it is cleaned up.
    if (readJob(jobId).kind === 'missing') throw new JobNotFoundError(jobId);

    this.queuedJobRuns.delete(jobId);
    const run = this.activeJobRuns.get(jobId);
    if (run) {
      this.cancelJobRun(run, 'removed');
      const managed = run.label === undefined ? undefined : this.sessionManager.get(run.label);
      if (managed) {
        await this.endJobSession(managed.session, managed.label);
      }
      await waitAtMost(run.settled, CANCELLED_RUN_WAIT_MS);
    }

    this.scheduler.unschedule(jobId);
    deleteJob(jobId);
    logger.info(`[Daemon] Removed job ${jobId}`);
  }

  /**
   * Enables a previously disabled job. Schedules it. The flag is set by a
   * locked load-modify-save, so a concurrent change to the job is kept.
   * @throws JobNotFoundError, InvalidJobError (code JOB_INVALID)
   */
  async enableJob(jobId: JobId): Promise<void> {
    const updated = await updateJob(jobId, (job) => ({ ...job, enabled: true }));
    this.scheduleJob(updated);
    logger.info(`[Daemon] Enabled job ${jobId}`);
  }

  /**
   * Disables a job. Unschedules it but preserves files.
   * @throws JobNotFoundError, InvalidJobError (code JOB_INVALID)
   */
  async disableJob(jobId: JobId): Promise<void> {
    await updateJob(jobId, (job) => ({ ...job, enabled: false }));
    this.scheduler.unschedule(jobId);
    this.queuedJobRuns.delete(jobId);
    logger.info(`[Daemon] Disabled job ${jobId}`);
  }

  /**
   * Reloads a job definition from disk and reschedules it. Also schedules a
   * job this daemon has never seen: `add-job` sends it once the job's policy
   * has compiled and the job is saved enabled, and `edit-job` after saving
   * (also when its recompile failed), so a job added while the daemon runs
   * gets its next run without a restart.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- must be async to satisfy ControlRequestHandler interface
  async reloadJob(jobId: JobId): Promise<void> {
    const read = readJob(jobId);
    if (read.kind === 'missing') throw new JobNotFoundError(jobId);
    if (read.kind === 'invalid') {
      // What is on disk now cannot run; do not keep running an older copy.
      this.scheduler.unschedule(jobId);
      this.queuedJobRuns.delete(jobId);
      logger.warn(`[Daemon] Reloaded job ${jobId}: unscheduled, ${toDisplayText(read.error.message)}`);
      throw read.error;
    }
    const job = read.job;

    this.scheduler.unschedule(jobId);

    if (job.enabled) {
      this.scheduleJob(job);
      const nextRun = this.scheduler.getNextRun(jobId);
      logger.info(`[Daemon] Reloaded job ${jobId}: rescheduled (next: ${nextRun?.toISOString() ?? 'unknown'})`);
    } else {
      this.queuedJobRuns.delete(jobId);
      logger.info(`[Daemon] Reloaded job ${jobId}: disabled, not scheduled`);
    }
  }

  /**
   * Re-runs policy compilation for an existing job, then reloads it so the
   * scheduled definition is the one the new policy was compiled from (a
   * scheduled snapshot with an older constitution would otherwise fail the
   * run-time policy check against the new policy). This is also the recovery
   * step `add-job` prints when its compile fails or leaves servers out: that
   * job was saved disabled and never scheduled, and once `enable-job` turns
   * it on it gets a next run.
   *
   * Resolves with the servers the written policy left out because they
   * failed to compile (the `recompile-job` reply, which the CLI reports with
   * exit status 2); the job is reloaded either way, as the policy was written.
   */
  async recompileJob(jobId: JobId): Promise<RecompileJobResultDto> {
    const job = loadJob(jobId);
    if (!job) throw new JobNotFoundError(jobId);

    const failedServers = failedServerNames(await compileTaskPolicy(job));
    if (failedServers.length > 0) {
      logger.warn(
        `[Daemon] Recompiled policy for job ${jobId} without ${failedServers.join(', ')}: ` +
          'they failed to compile, so their tools are denied',
      );
    } else {
      logger.info(`[Daemon] Recompiled policy for job ${jobId}`);
    }
    await this.reloadJob(jobId);
    return { failedServers };
  }

  /**
   * Re-resolves the dynamic lists of a persona's or a job's policy and
   * updates their per-server copies (`ironcurtain refresh-lists --persona` /
   * `--job`, run by the daemon). Names are validated by the refresh itself.
   */
  async refreshLists(request: RefreshListsRequest): Promise<RefreshListsResultDto> {
    // Offline pipeline code, loaded only when a refresh is requested.
    const { refreshDynamicLists } = await import('../pipeline/refresh-lists.js');
    const { target } = request;
    const summary = await refreshDynamicLists({
      target:
        target.kind === 'persona' ? { kind: 'persona', persona: target.name } : { kind: 'job', jobId: target.name },
      ...(request.list !== undefined ? { listName: request.list } : {}),
      withMcp: request.withMcp ?? true,
    });
    logger.info(`[Daemon] Refreshed ${summary.refreshed.length} dynamic list(s) for ${summary.target}`);
    return {
      target: summary.target,
      outputDir: summary.outputDir,
      refreshed: [...summary.refreshed],
      skipped: [...summary.skipped],
    };
  }

  /**
   * Starts a manual run of a job without waiting for it (the control
   * socket's accept-then-poll `run-job`, and the web UI's `jobs.run`). Does
   * not affect the cron schedule.
   *
   * The job is reserved before this returns. When no run starts, it throws
   * synchronously: JobAlreadyRunningError (code JOB_ALREADY_RUNNING) while a
   * scheduled or manual run of the job is still in progress, or
   * JobNotFoundError (code JOB_NOT_FOUND) for an unknown job. A caller can
   * therefore reply "accepted" only for a run that really started.
   */
  startJobRun(jobId: JobId): JobRunStart {
    const job = loadJob(jobId);
    if (!job) throw new JobNotFoundError(jobId);
    return { completion: this.executeJob(job) };
  }

  /**
   * Manually runs a job and resolves with its record (every outcome,
   * failures included): the CLI's local fallback when no daemon is running.
   * Rejects with JobAlreadyRunningError when a run of the job is still in
   * progress, and JobNotFoundError for an unknown job. Does not affect the
   * cron schedule.
   */
  async runJobNow(jobId: JobId): Promise<RunRecord> {
    return this.startJobRun(jobId).completion;
  }

  /**
   * Lists all valid jobs with their schedules, last run status and failure
   * streak. (Jobs whose job.json is invalid are not in it; `list-jobs`
   * reports them from disk, see scanJobs.)
   */
  listJobs(): JobListEntry[] {
    const jobs = loadAllJobs();
    return jobs.map((job) => ({
      job,
      nextRun: this.scheduler.getNextRun(job.id),
      lastRun: loadLatestRun(job.id),
      isRunning: this.activeJobRuns.has(job.id),
      isQueued: this.queuedJobRuns.has(job.id),
      consecutiveFailures: countConsecutiveFailures(job.id),
    }));
  }

  /** Returns a status snapshot for the control socket. */
  getStatus(): DaemonStatus {
    const jobs = loadAllJobs();
    const enabledJobs = jobs.filter((j) => j.enabled);
    const failingJobs: FailingJobStatus[] = jobs
      .map((job) => ({ jobId: job.id, name: job.name, consecutiveFailures: countConsecutiveFailures(job.id) }))
      .filter((entry) => entry.consecutiveFailures > 0)
      .sort((a, b) => b.consecutiveFailures - a.consecutiveFailures);

    // Find the earliest next fire time across all scheduled jobs
    let nextFireTime: Date | null = null;
    for (const job of enabledJobs) {
      const nextRun = this.scheduler.getNextRun(job.id);
      if (nextRun && (nextFireTime === null || nextRun < nextFireTime)) {
        nextFireTime = nextRun;
      }
    }

    const uptimeSeconds = this.startTime ? (Date.now() - this.startTime.getTime()) / 1000 : 0;

    return {
      uptimeSeconds,
      jobs: {
        total: jobs.length,
        enabled: enabledJobs.length,
        running: this.activeJobRuns.size,
        failing: failingJobs.length,
      },
      failingJobs,
      signalConnected: this.signalDaemon !== null,
      nextFireTime,
      webUi: this.webUiState,
    };
  }

  // -----------------------------------------------------------------------
  // Job execution
  // -----------------------------------------------------------------------

  /**
   * Called when a scheduled job fires. A fire time that was missed (the
   * machine slept, the daemon was blocked) runs only with
   * `cron.catchUpMissedRuns`. Skips the trigger while a previous run of the
   * job (scheduled or manual, still being set up or already running) has not
   * finished; queues it while `cron.maxConcurrentRuns` runs are in progress;
   * otherwise runs the job and announces it to web UI clients.
   */
  private async onJobTrigger(job: JobDefinition, trigger: JobTrigger): Promise<void> {
    if (trigger.kind === 'missed') {
      if (!this.catchUpMissedRuns) {
        logger.warn(
          `[Daemon] Job ${job.id} missed its run due ${trigger.scheduledFor.toISOString()} and was not run ` +
            '(set cron.catchUpMissedRuns to run a missed job once when the daemon notices)',
        );
        return;
      }
      logger.info(`[Daemon] Job ${job.id}: catching up the run due ${trigger.scheduledFor.toISOString()}`);
    }

    const active = this.activeJobRuns.get(job.id);
    if (active) {
      const where = active.label === undefined ? 'still starting' : `session #${active.label}`;
      logger.warn(`[Daemon] Skipping job ${job.id}: previous run still active (${where})`);
      this.signalDaemon
        ?.sendSignalMessage(`Skipped job "${job.name}": previous run still in progress.`)
        .catch(() => {});
      return;
    }

    if (this.maxConcurrentCronRuns !== null && this.activeJobRuns.size >= this.maxConcurrentCronRuns) {
      if (!this.queuedJobRuns.has(job.id)) {
        this.queuedJobRuns.set(job.id, { trigger, queuedAt: new Date() });
        logger.info(
          `[Daemon] Job ${job.id} is waiting for a run slot ` +
            `(${this.activeJobRuns.size} of at most ${this.maxConcurrentCronRuns} cron runs in progress)`,
        );
      }
      return;
    }

    await this.runTriggeredJob(job);
  }

  /** Runs a job the scheduler fired, announcing it to web UI clients. Never rejects. */
  private async runTriggeredJob(job: JobDefinition): Promise<void> {
    try {
      const completion = this.executeJob(job);
      this.webUiServer?.getEventBus().emit('job.started', { jobId: job.id, sessionLabel: 0 });
      const record = await completion;
      this.webUiServer?.getEventBus().emit('job.completed', { jobId: job.id, record });
    } catch (err: unknown) {
      logger.warn(`[Daemon] Job ${job.id} failed: ${String(err)}`);
    }
  }

  /**
   * Starts queued triggers while run slots are free, oldest first. A queued
   * job that is no longer scheduled (removed, disabled) is dropped; one whose
   * previous run is still active is skipped, as a trigger would be. A job
   * rescheduled while it waited runs with its current definition.
   */
  private startQueuedJobRuns(): void {
    for (const [jobId, queued] of [...this.queuedJobRuns]) {
      if (this.maxConcurrentCronRuns !== null && this.activeJobRuns.size >= this.maxConcurrentCronRuns) return;
      this.queuedJobRuns.delete(jobId);
      const job = this.scheduler.getScheduledJob(jobId as JobId);
      if (!job) continue;
      if (this.activeJobRuns.has(jobId)) {
        logger.warn(`[Daemon] Skipping queued job ${jobId}: a run of it is already in progress`);
        continue;
      }
      logger.info(
        `[Daemon] Starting job ${jobId}, queued since ${queued.queuedAt.toISOString()} ` +
          `(due ${queued.trigger.scheduledFor.toISOString()})`,
      );
      void this.runTriggeredJob(job);
    }
  }

  /**
   * Runs a job once: reserves it, locks its workspace, syncs its repository,
   * creates a session with the job's workspace and policy, runs it to
   * completion, and records the outcome. Every run that starts ends with a
   * run record, including one that fails before or while its session runs,
   * and with a Signal completion notice when the job asks for one (a run
   * refused before it started, for its policy or because another run holds
   * its workspace, always gets the refusal notice instead). The returned
   * promise does not reject for a failed run; its record says what happened.
   *
   * The reservation comes first and is synchronous: while a run of the job
   * has not finished, this throws JobAlreadyRunningError before anything of
   * the new run starts, so no second sync touches the workspace of a live
   * agent and no second session shares its escalation routing. The
   * reservation is released after the record has been written. Other jobs
   * and workflows that use the same directory are kept out by the workspace
   * lock (see runReservedJob).
   */
  private executeJob(job: JobDefinition): Promise<RunRecord> {
    const run = this.reserveJobRun(job.id);
    const completion = this.runReservedJob(job, run).finally(() => this.releaseJobRun(job.id, run));
    run.settled = completion.then(
      () => undefined,
      () => undefined,
    );
    return completion;
  }

  /** Reserves a run of `jobId` (see executeJob). @throws JobAlreadyRunningError */
  private reserveJobRun(jobId: JobId): ActiveJobRun {
    const active = this.activeJobRuns.get(jobId);
    if (active) throw new JobAlreadyRunningError(jobId, active.label);
    const run: ActiveJobRun = {
      label: undefined,
      cancelled: undefined,
      abort: new AbortController(),
      settled: Promise.resolve(),
    };
    this.activeJobRuns.set(jobId, run);
    return run;
  }

  /**
   * Releases a reservation, but only while the job is still reserved by this
   * run, and hands the freed slot to the oldest queued trigger.
   */
  private releaseJobRun(jobId: JobId, run: ActiveJobRun): void {
    if (this.activeJobRuns.get(jobId) === run) this.activeJobRuns.delete(jobId);
    this.startQueuedJobRuns();
  }

  /** Stops a run from outside: it ends at its next step (see runReservedJob). */
  private cancelJobRun(run: ActiveJobRun, reason: JobRunCancellation): void {
    run.cancelled ??= reason;
    run.abort.abort();
  }

  /**
   * The body of executeJob() for a reserved run. Failures are recorded with
   * the phase they happened in: `setup` (configuration, workspace, the policy
   * check, the workspace lock, session creation), `sync` (the git sync) or
   * `session` (the agent run). The session is always ended before the summary
   * is read and the record written. The workspace lock is held from before
   * the git sync until the session has ended and its summary has been read.
   */
  private async runReservedJob(job: JobDefinition, run: ActiveJobRun): Promise<RunRecord> {
    const startedAt = new Date().toISOString();
    let phase: RunFailurePhase = 'setup';
    let outcome: RunOutcome;
    let workspace: string | undefined;
    let workspaceLock: ProcessLockHandle | undefined;
    let session: Session | undefined;
    // Set when the run is refused before it starts: its policy check or
    // persona failed, or another run holds its workspace (see below).
    let refusal: string | undefined;
    let discardedChanges: string | null = null;
    let captureSummary = false;
    let budget = NO_BUDGET_SPENT;
    let escalationsEncountered = 0;
    let escalationsApproved = 0;
    // Escalations raised before the session is registered, routed right after.
    const earlyEscalations: EscalationRequest[] = [];
    // What the session reports for the user (a stale policy, an MCP server
    // that did not start, setuid or root-owned files the agent left behind,
    // up to its teardown): kept in the run record, as nobody watches the run.
    const notices = new RunNoticeCollector();

    try {
      const globalConfig = loadConfig();
      try {
        workspace = resolveJobWorkspace(job, globalConfig.protectedPaths);
      } catch (err) {
        throw new Error(`Invalid workspace: ${errorMessage(err)}`, { cause: err });
      }

      // Fail closed on the policy before anything else touches the workspace:
      // the job must have its own compiled policy (or its persona's), compiled
      // from its current constitution. Without this check a job whose compile
      // failed, was interrupted or never ran would run under the default
      // policy, and an edited job would run its new task under the old policy.
      const policyCheck = checkJobPolicy(job);
      if (!policyCheck.ok) {
        refusal = policyCheck.message;
        throw new Error(policyCheck.message);
      }
      // A persona job also runs with the persona's agent model and resource
      // limits. Malformed ones would refuse the session; refuse the run here
      // instead, before the workspace is touched, with the same notice as a
      // policy refusal: the persona needs fixing before any run can start.
      const overridesProblem = job.persona !== undefined ? findPersonaOverridesProblem(job.persona) : undefined;
      if (overridesProblem !== undefined) {
        refusal = overridesProblem;
        throw new Error(overridesProblem);
      }

      // One run per workspace. While another job's run or a workflow (in
      // this or another process) uses this directory, the run is refused
      // before the git sync could reset files under that run's agent and
      // before a second agent starts in it, with the refusal notice. Released
      // only once this run's session has ended (below).
      try {
        workspaceLock = claimJobWorkspaceLock(job, workspace);
      } catch (err) {
        if (isWorkflowLockBusyError(err)) {
          refusal = err.message;
          throw err;
        }
        throw new Error(`Could not lock the workspace: ${errorMessage(err)}`, { cause: err });
      }

      // Sync git repo if configured. A failed sync never runs the agent on a
      // half-synced workspace: the run ends here with an error record.
      if (job.gitRepo) {
        phase = 'sync';
        logger.info(`[Daemon] Syncing repo for job ${job.id}...`);
        const sync = await syncJobGitRepo(job, job.gitRepo, workspace, run.abort.signal);
        throwIfCancelled(run);
        if (!sync.ok) {
          throw new Error(`Git sync ${sync.kind === 'sync_timeout' ? 'timed out' : 'failed'}: ${sync.message}`);
        }
        for (const warning of sync.warnings) {
          logger.warn(`[Daemon] Git sync for job ${job.id}: ${warning}`);
        }
        discardedChanges = sync.discardedChanges;
        if (discardedChanges) {
          logger.info(`[Daemon] Discarded local changes in job ${job.id}:\n${discardedChanges}`);
        }
        logger.info(`[Daemon] Repo synced for job ${job.id} (${sync.branch} at ${sync.commit})`);
        phase = 'setup';
      }

      // A summary left by an earlier run must never be taken for this one's.
      try {
        retireRunSummary(workspace);
        captureSummary = true;
      } catch (err) {
        logger.warn(
          `[Daemon] Job ${job.id}: could not move the previous ${RUN_SUMMARY_FILE} aside, ` +
            `so this run's summary is not recorded: ${errorMessage(err)}`,
        );
      }

      // Build system prompt augmentation
      const augmentation = buildCronSystemPromptAugmentation({
        workspacePath: this.mode.kind === 'docker' ? CONTAINER_WORKSPACE_DIR : workspace,
      });

      // Create the headless transport. The auto-save gate gets the same scope
      // the session's memory gate does (the job, and the persona it runs as),
      // so a job or persona that opted out of memory is not asked to save to
      // a memory server it does not have.
      const transport = new HeadlessTransport({
        taskMessage: job.taskDescription,
        autoSaveMemory: shouldAutoSaveMemory(globalConfig, { job, ...(job.persona ? { persona: job.persona } : {}) }),
        dockerMode: this.mode.kind === 'docker',
      });

      // Create the session with per-job policy and escalation handler.
      // Auto-approver is disabled: cron sessions have no interactive user
      // context, so intent-matching against a user message is meaningless.
      // When job.persona is set, use the persona's compiled policy instead
      // of the job-specific generated dir. The escalation callbacks route by
      // this run's own label (run.label), never by a lookup on the job id.
      session = await createStandaloneSession({
        config: globalConfig,
        mode: this.mode,
        workspacePath: workspace,
        ...(job.persona ? { persona: job.persona } : { policyDir: getJobGeneratedDir(job.id) }),
        ...cronSessionBudgetOptions(job),
        jobId: job.id,
        systemPromptAugmentation: augmentation,
        disableAutoApprove: true,
        ...(this.captureTracesDefault ? { captureTracesOverride: true } : {}),
        onDiagnostic: notices.onDiagnostic,
        onEscalation: (request: EscalationRequest) => {
          escalationsEncountered++;
          if (run.label === undefined) earlyEscalations.push(request);
          else this.handleCronEscalation(request, job, run.label);
        },
        onEscalationResolved: (escalationId: string, decision: 'approved' | 'denied') => {
          if (decision === 'approved') escalationsApproved++;
          if (run.label === undefined) dropEscalation(earlyEscalations, escalationId);
          else this.sessionManager.clearPendingEscalation(run.label, escalationId);
        },
        // Each escalation expires on its own: the session's others stay pending.
        onEscalationExpired: (escalationId: string) => {
          if (run.label === undefined) dropEscalation(earlyEscalations, escalationId);
          // The Signal daemon also tells the user when the banner went out there.
          else if (this.signalDaemon) this.signalDaemon.expireEscalation(run.label, escalationId);
          else this.sessionManager.expireEscalation(run.label, escalationId);
        },
      });
      throwIfCancelled(run);

      // Register in session manager
      const source: SessionSource = { kind: 'cron', jobId: job.id, jobName: job.name };
      const label = this.sessionManager.register(session, transport, source);
      run.label = label;

      // Register with the token stream bridge so an active `observe --all`
      // subscription can route this session's events. The bridge may not
      // exist if the web UI is not enabled; registerSession is idempotent,
      // so re-registration from the web UI's event bus subscription is safe.
      this.tokenStreamBridge?.registerSession(label, session.getInfo().id);

      logger.info(`[Daemon] Started job ${job.id} as session #${label}`);
      for (const request of earlyEscalations.splice(0)) {
        this.handleCronEscalation(request, job, label);
      }

      phase = 'session';
      try {
        await transport.run(session);
        outcome = { kind: 'success' };
      } catch (err) {
        if (!(err instanceof BudgetExhaustedError)) throw err;
        outcome = { kind: 'budget_exhausted', dimension: err.dimension };
      }
      throwIfCancelled(run);
    } catch (err) {
      const message = run.cancelled === undefined ? errorMessage(err) : CANCELLATION_MESSAGES[run.cancelled];
      outcome = { kind: 'error', phase, message };
    } finally {
      if (session) {
        budget = budgetSnapshot(session);
        await this.endJobSession(session, run.label);
      }
    }

    // Read after teardown: no agent (and in Docker mode no container) is
    // left to swap the file while the daemon reads it. Still under the
    // workspace lock, so no other run has moved it aside or written its own.
    let summary: string | null = null;
    try {
      if (session !== undefined && workspace !== undefined && captureSummary) {
        const read = readRunSummary(workspace);
        if (read.problem) logger.warn(`[Daemon] Job ${job.id}: ${read.problem}`);
        summary = read.summary;
      }
    } finally {
      releaseWorkflowLock(workspaceLock, (message) => logger.warn(`[Daemon] Job ${job.id}: ${message}`));
    }

    const runNotices = notices.collected();
    for (const notice of runNotices ?? []) {
      // Display text already; one line in the daemon log.
      logger.warn(`[Daemon] Job ${job.id}: ${toDisplayText(notice)}`);
    }
    const record: RunRecord = {
      startedAt,
      completedAt: new Date().toISOString(),
      outcome,
      budget,
      summary,
      ...(runNotices !== undefined ? { notices: runNotices } : {}),
      escalationsEncountered,
      escalationsApproved,
      discardedChanges,
    };

    if (run.cancelled === 'removed') {
      logger.info(`[Daemon] Job ${job.id} was removed during its run; no run record is kept`);
      return record;
    }
    this.saveJobRunRecord(job, record);
    if (refusal !== undefined) {
      logger.warn(`[Daemon] Job ${job.id} not run: ${toDisplayText(refusal)}`);
      this.notifyRunRefused(job, refusal);
      return record;
    }
    this.notifyRunCompleted(job, record);
    if (outcome.kind === 'error') {
      // The message can carry agent- or remote-chosen text: keep the log line one safe line.
      logger.warn(`[Daemon] Job ${job.id} failed (${phase}): ${toDisplayText(outcome.message)}`);
    } else {
      logger.info(`[Daemon] Job ${job.id} completed: ${outcome.kind}`);
    }
    return record;
  }

  /**
   * Saves a run record. A failed write (ENOSPC, EIO, EROFS, ...) is logged,
   * never thrown, so it can neither skip the run's cleanup nor leave the job
   * marked running. A job whose directory is gone (removed while it ran) gets
   * no record, and its directory is not recreated. Neither does a job whose
   * hand-edited job.json carries an `id` that names no job directory (the
   * path lookup throws): its run still ends with the completion notice.
   */
  private saveJobRunRecord(job: JobDefinition, record: RunRecord): void {
    try {
      if (!existsSync(getJobDir(job.id))) {
        logger.info(`[Daemon] Job ${job.id} no longer exists; its run record is not saved`);
        return;
      }
      saveRunRecord(job.id, record);
    } catch (err) {
      logger.warn(`[Daemon] Could not save the run record of job ${job.id}: ${errorMessage(err)}`);
    }
  }

  /**
   * Sends the Signal completion notice (every outcome) when the job asks for
   * one. It quotes the agent-written summary line by line and goes out in
   * plain text (normal text mode), so nothing in it is taken as styling and
   * no line of it can pass for an escalation banner.
   */
  private notifyRunCompleted(job: JobDefinition, record: RunRecord): void {
    if (!job.notifyOnCompletion || !this.signalDaemon) return;
    this.signalDaemon
      .sendSignalMessage(formatRunNotification(job.name, record), { textMode: 'normal' })
      .catch(() => {});
  }

  /**
   * Sends the Signal notice for a run refused before it started (its policy
   * check, its persona, or its workspace in use by another run), whatever
   * the job's notification settings: a job that does not run needs someone
   * to recompile its policy or to look at what else uses its workspace. It
   * takes the place of the completion notice.
   */
  private notifyRunRefused(job: JobDefinition, reason: string): void {
    this.signalDaemon?.sendSignalMessage(formatRunRefusal(job.name, reason)).catch(() => {});
  }

  /**
   * Ends a cron run's session: through the SessionManager once it is
   * registered (so racing callers share one teardown), directly when it was
   * created but never registered. Then drops its token-stream state. Never
   * throws.
   */
  private async endJobSession(session: Session, label: number | undefined): Promise<void> {
    try {
      const sessionId = session.getInfo().id;
      if (label === undefined) {
        await session.close();
      } else {
        await this.sessionManager.end(label);
        this.tokenStreamBridge?.closeSession(label);
      }
      getTokenStreamBus().endSession(sessionId);
    } catch (err) {
      logger.warn(`[Daemon] Error ending a cron session: ${errorMessage(err)}`);
    }
  }

  // -----------------------------------------------------------------------
  // Escalation handling for cron sessions
  // -----------------------------------------------------------------------

  /**
   * Routes an escalation of the cron session registered as `label` (the
   * run's own session). The full request is recorded on the session either
   * way, so whoever decides (over Signal or in the web UI, which the
   * SessionManager tells) sees exactly what is asked, and every decision
   * goes through `SessionManager.resolveSessionEscalation`:
   * - Signal configured and the job notifies: the coded Signal banner goes
   *   out; it can be decided there or in the web UI until the escalation
   *   times out (escalationTimeoutSeconds).
   * - Signal not configured, and a browser is connected to the web UI: it
   *   waits there for a decision until it times out.
   * - Otherwise nobody can be asked, and it is denied at once.
   */
  private handleCronEscalation(request: EscalationRequest, job: JobDefinition, label: number): void {
    if (job.notifyOnEscalation && this.signalDaemon) {
      // Records the pending escalation and sends the same coded banner as a
      // Signal session's, naming the job: only `approve <code>` approves it.
      void this.signalDaemon.surfaceEscalation(label, request, { jobName: job.name });
      return;
    }

    if (!this.signalDaemon && this.webUiServer?.hasBrowserClient() === true) {
      this.sessionManager.recordEscalation(label, request);
      logger.info(
        `[Daemon] Escalation ${request.escalationId} of job ${job.id} (session #${label}) ` +
          'is waiting for a decision in the web UI',
      );
      return;
    }

    // Not announced: nobody is asked to decide an escalation denied at once.
    this.sessionManager.recordEscalation(label, request, { announce: false });
    this.sessionManager.resolveSessionEscalation(request.escalationId, 'denied').then(
      (result) => {
        if (!result.resolved) {
          logger.warn(`[Daemon] Escalation ${request.escalationId} was not denied: ${result.reason ?? 'unknown'}`);
        }
      },
      (err: unknown) => {
        logger.warn(`[Daemon] Denying escalation ${request.escalationId} failed: ${errorMessage(err)}`);
      },
    );
  }

  // -----------------------------------------------------------------------
  // Signal integration
  // -----------------------------------------------------------------------

  private async startSignalDaemon(): Promise<void> {
    const { resolveSignalConfig } = await import('../signal/signal-config.js');
    const { SignalBotDaemon } = await import('../signal/signal-bot-daemon.js');
    const { createSignalContainerManager } = await import('../signal/signal-container.js');
    const { createDockerManager } = await import('../docker/docker-manager.js');

    const userConfig = loadUserConfig();
    const signalConfig = resolveSignalConfig(userConfig);

    if (!signalConfig) {
      throw new Error('Signal is not configured. Run: ironcurtain setup-signal');
    }

    // One Signal transport per IronCurtain home: an `ironcurtain bot` already
    // attached to the container would get every message too. Taken before
    // the container is touched (SignalLockBusyError when another process
    // holds it), and held until shutdown() has ended the daemon's sessions.
    const signalLock = acquireSignalLock();

    let signalDaemon: import('../signal/signal-bot-daemon.js').SignalBotDaemon;
    try {
      process.stderr.write('Starting Signal transport...\n');
      const docker = createDockerManager();
      const containerManager = createSignalContainerManager(docker, signalConfig.container);

      signalDaemon = new SignalBotDaemon({
        config: signalConfig,
        containerManager,
        mode: this.mode,
        sessionManager: this.sessionManager,
        // Wire Signal-created sessions into the token stream bridge so that
        // an active `observe --all` subscription receives their events.
        // The bridge may not exist (web UI disabled) -- calls are null-safe.
        onSessionRegistered: (label, managed) => {
          this.tokenStreamBridge?.registerSession(label, managed.session.getInfo().id);
        },
        onSessionEnded: (label) => {
          this.tokenStreamBridge?.closeSession(label);
        },
      });

      // Await the connection phase (starts Docker, health check, WebSocket).
      // Throws if the container won't start or health check times out.
      await signalDaemon.connect();
    } catch (err) {
      signalLock.release();
      throw err;
    }

    this.signalLock = signalLock;
    this.signalDaemon = signalDaemon;

    // Run the blocking event loop in the background (blocks until shutdown)
    signalDaemon.run().catch((err: unknown) => {
      logger.warn(`[Daemon] Signal daemon exited: ${String(err)}`);
      this.signalDaemon = null;
    });
  }

  // -----------------------------------------------------------------------
  // Automatic prune (retention.autoPrune)
  // -----------------------------------------------------------------------

  /**
   * With `retention.autoPrune`, prunes the IronCurtain home shortly after
   * start and then every `retention.autoPruneIntervalHours` (see
   * src/maintenance/prune.ts). Off by default. The timers never keep the
   * process alive, and a run still going when the next is due is not doubled.
   */
  private startAutoPrune(retention: ResolvedRetentionConfig): void {
    if (!retention.autoPrune || this.autoPruneTimers !== undefined) return;
    const run = (): void => {
      if (this.autoPruneInFlight !== undefined || this.autoPruneAbort.signal.aborted) return;
      this.autoPruneInFlight = this.runAutoPrune(retention).finally(() => {
        this.autoPruneInFlight = undefined;
      });
    };
    const intervalMs = Math.min(MAX_TIMER_DELAY_MS, Math.max(1, retention.autoPruneIntervalHours) * 60 * 60 * 1000);
    const start = setTimeout(run, Math.min(MAX_TIMER_DELAY_MS, Math.max(0, this.autoPruneStartDelayMs)));
    const interval = setInterval(run, intervalMs);
    start.unref();
    interval.unref();
    this.autoPruneTimers = { start, interval };
  }

  /** One automatic prune, logged to daemon.log. Never rejects. */
  private async runAutoPrune(retention: ResolvedRetentionConfig): Promise<void> {
    try {
      const report = await runPrune({
        retention,
        dryRun: false,
        liveSessionIds: this.liveSessionIds(),
        liveWorkflowIds: this.liveWorkflowIds(),
        signal: this.autoPruneAbort.signal,
      });
      const summary = `[Daemon] ${summarizePruneReport(report)}`;
      if (report.failed.length > 0) logger.warn(summary);
      else logger.info(summary);
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === PRUNE_BUSY) {
        logger.info(`[Daemon] Automatic prune skipped: ${errorMessage(err)}`);
        return;
      }
      logger.warn(`[Daemon] Automatic prune failed: ${toDisplayText(errorMessage(err))}`);
    }
  }

  /** Clears the prune timers and gives a prune in progress a bounded moment to stop. */
  private async stopAutoPrune(): Promise<void> {
    if (this.autoPruneTimers !== undefined) {
      clearTimeout(this.autoPruneTimers.start);
      clearInterval(this.autoPruneTimers.interval);
      this.autoPruneTimers = undefined;
    }
    this.autoPruneAbort.abort();
    if (this.autoPruneInFlight !== undefined) await waitAtMost(this.autoPruneInFlight, AUTO_PRUNE_STOP_WAIT_MS);
  }

  /**
   * Session directories this daemon is using: its managed sessions (web,
   * Signal, cron) and the workflow agent sessions it tracks. Never resumed
   * here, so the session id names the directory. Pruning skips them however
   * long they have been idle.
   */
  private liveSessionIds(): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const managed of this.sessionManager.all()) {
      try {
        ids.add(managed.session.getInfo().id);
      } catch {
        // A session that cannot describe itself is protected by its own lock or lease.
      }
    }
    for (const sessionId of this.workflowAgentLabels.keys()) ids.add(sessionId);
    return ids;
  }

  /** Workflow runs this daemon's workflow manager is running (they also hold their run locks). */
  private liveWorkflowIds(): ReadonlySet<string> {
    const manager = this.workflowManager;
    if (!manager) return new Set();
    try {
      return new Set(manager.getOrchestrator().listActive());
    } catch {
      return new Set();
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  /** Binds the control socket; throws (fatal for start()) when it cannot. */
  private async startControlSocket(): Promise<void> {
    const handler: ControlRequestHandler = {
      getStatus: () => this.getStatus(),
      removeJob: (jobId) => this.removeJob(jobId as JobId),
      enableJob: (jobId) => this.enableJob(jobId as JobId),
      disableJob: (jobId) => this.disableJob(jobId as JobId),
      recompileJob: (jobId) => this.recompileJob(jobId as JobId),
      refreshLists: (request) => this.refreshLists(request),
      reloadJob: (jobId) => this.reloadJob(jobId as JobId),
      startJobRun: (jobId) => this.startJobRun(jobId as JobId),
      runJobNow: (jobId) => this.runJobNow(jobId as JobId),
      listJobs: () => this.listJobs(),
    };

    this.controlRequestHandler = handler;
    const controlSocket = new ControlSocketServer(this.withJobListNotifications(handler));
    await controlSocket.start();
    this.controlSocket = controlSocket;
  }

  /**
   * The control-socket view of `handler`: after a job is removed, enabled,
   * disabled, reloaded or recompiled from the CLI (add-job and edit-job reach
   * the daemon as `reload-job`), web UI clients are told (`job.list_changed`)
   * so their job list refreshes. The web UI's own `jobs.*` methods call
   * `handler` directly and emit the event themselves.
   */
  private withJobListNotifications(handler: ControlRequestHandler): ControlRequestHandler {
    const notifyAfter = async <T>(change: Promise<T>): Promise<T> => {
      const result = await change;
      this.webUiServer?.getEventBus().emit('job.list_changed', {});
      return result;
    };
    return {
      ...handler,
      removeJob: (jobId) => notifyAfter(handler.removeJob(jobId)),
      enableJob: (jobId) => notifyAfter(handler.enableJob(jobId)),
      disableJob: (jobId) => notifyAfter(handler.disableJob(jobId)),
      recompileJob: (jobId) => notifyAfter(handler.recompileJob(jobId)),
      reloadJob: (jobId) => notifyAfter(handler.reloadJob(jobId)),
    };
  }

  private async startWebUiServer(): Promise<void> {
    const { WebUiServer, viteDevOrigins } = await import('../web-ui/web-ui-server.js');
    const { WorkflowManager } = await import('../workflow/workflow-manager.js');
    const { TokenStreamBridge } = await import('../web-ui/token-stream-bridge.js');
    const { osSandboxNoticeForConfig } = await import('../trusted-process/sandbox-integration.js');

    if (!this.controlRequestHandler) {
      throw new Error('Control socket must be started before web UI');
    }

    // Dev mode allowlists the Vite dev server's origin (same port variable as
    // vite.config.ts) instead of skipping the Origin check.
    const devOrigins = this.webUiOptions?.devMode ? viteDevOrigins(process.env.IRONCURTAIN_WEB_UI_PORT) : undefined;

    // Create server first, then create WorkflowManager using the server's event bus
    const server = new WebUiServer({
      port: this.webUiOptions?.port ?? 7400,
      host: this.webUiOptions?.host ?? '127.0.0.1',
      handler: this.controlRequestHandler,
      sessionManager: this.sessionManager,
      mode: this.mode,
      maxConcurrentWebSessions: 5,
      devMode: this.webUiOptions?.devMode,
      devOrigins,
      captureTracesDefault: this.captureTracesDefault,
      allowPolicyMutation: this.allowPolicyMutation,
      // Owner id/pid for Docker-agent PTY sessions (registry ownership, §11 Q1).
      // The WebUiServer owns PTY session lifecycle, so its stop() (already
      // awaited in shutdown()) reaps the children -- no separate close here.
      daemonId: randomBytes(4).toString('hex'),
      daemonPid: process.pid,
      statisticsReader: this.metricsRuntime?.reader,
      // Web-UI diagnostic: PTY sessions show which MCP servers will not get
      // the OS sandbox they ask for (refused or unconfined), naming them.
      // Re-evaluated per session so installing bwrap/socat/rg takes effect.
      osSandboxNotice: () => osSandboxNoticeForConfig(loadConfig()),
    });
    const workflowManager = new WorkflowManager({
      eventBus: server.getEventBus(),
      enableSnapshotGc: true,
      // Opt-in only, matching the cron-session path above: set the override
      // solely when the daemon flag is present. Passing `false` here would
      // override (and disable) a user's `capture.enabled` config, since the
      // infrastructure factory resolves `override ?? userConfig.capture`.
      ...(this.captureTracesDefault ? { captureTraces: true } : {}),
    });
    // Owned by the daemon: shutdown() stops its runs (see shutdownWorkflows).
    this.workflowManager = workflowManager;
    server.setWorkflowManager(workflowManager);
    // Start the snapshot GC sweep + periodic timer now, at daemon boot,
    // rather than lazily on the first workflow request (which may never come).
    workflowManager.startBackgroundTasks();

    const bridge = new TokenStreamBridge(server);
    server.setTokenStreamBridge(bridge);
    this.tokenStreamBridge = bridge;

    // Belt-and-suspenders: the web UI also emits session.created / session.ended
    // events. registerSession is idempotent (Map.set overwrite), so repeat
    // registrations from this bus event and the direct executeJob()/Signal
    // paths are safe. Cron/Signal sessions are registered directly at their
    // creation sites because they do not go through the web UI event bus.
    server.getEventBus().subscribe((event, payload) => {
      if (event === 'session.created') {
        const { label } = payload as { label: number };
        const managed = this.sessionManager.get(label);
        if (managed) {
          bridge.registerSession(label, managed.session.getInfo().id);
        }
      } else if (event === 'session.ended') {
        bridge.closeSession((payload as { label: number }).label);
      } else if (event === 'workflow.agent_started') {
        // Workflow-owned agent sessions are not registered in
        // SessionManager (they run without a Transport). Map them
        // into the bridge here so token events produced by the
        // session reach `observe --all` subscribers. A fresh label
        // is reserved per agent session; `agent_session_ended` tears
        // it down unconditionally. `Session.getInfo().id` is freshly
        // minted per session even when `freshSession: false` reuses
        // the `AgentConversationId`, so every `agent_started` event
        // carries a distinct SessionId and reserving a fresh label is
        // always correct.
        const sid = parseSessionId((payload as { sessionId?: unknown }).sessionId);
        if (sid === undefined) return;
        const label = this.sessionManager.reserveLabel();
        this.workflowAgentLabels.set(sid, label);
        bridge.registerSession(label, sid);
      } else if (event === 'workflow.agent_session_ended') {
        // A fresh label is reserved per agent session; this handler
        // tears it down unconditionally (fires in the orchestrator's
        // finally block so success, failure, and abort paths all
        // converge here).
        const sid = parseSessionId((payload as { sessionId?: unknown }).sessionId);
        if (sid === undefined) return;
        const label = this.workflowAgentLabels.get(sid);
        if (label !== undefined) {
          this.workflowAgentLabels.delete(sid);
          bridge.closeSession(label);
        }
      }
    });

    let url: string;
    try {
      url = await server.start();
    } catch (err) {
      // The daemon carries on without a web UI, so nothing can reach this
      // manager: stop it now (its snapshot-GC timer included).
      this.workflowManager = null;
      await workflowManager.shutdown().catch((shutdownErr: unknown) => {
        logger.warn(`[Daemon] Error stopping the unused workflow manager: ${String(shutdownErr)}`);
      });
      throw err;
    }
    this.webUiServer = server;
    process.stderr.write(`  Web UI: ${url}\n`);
    if (this.webUiOptions?.devMode && devOrigins) {
      const token = url.split('token=')[1];
      process.stderr.write(`  Web UI (dev): ${devOrigins[0]}?token=${token}\n`);
    }

    // Persist connection info so CLI commands (e.g., `observe`) can connect
    this.writeWebUiState(server);
  }

  /**
   * Normalize a bind host into a host a CLI client can actually connect to.
   *
   * The daemon may bind to a wildcard address (0.0.0.0 or ::) to accept
   * connections on all interfaces, but wildcards are not valid *destination*
   * hosts, so persisting them verbatim would break `ironcurtain observe`.
   * The server's bind host is unchanged; only the persisted connect host is
   * normalized.
   */
  private getWebUiConnectHost(host: string | undefined): string {
    if (!host || host.trim() === '') return '127.0.0.1';
    const normalized = host.trim();
    if (normalized === '0.0.0.0') return '127.0.0.1';
    if (normalized === '::' || normalized === '[::]' || normalized === '::0') return 'localhost';
    return normalized;
  }

  /** Write web UI connection info to a well-known file for CLI consumers. */
  private writeWebUiState(server: import('../web-ui/web-ui-server.js').WebUiServer): void {
    const state = {
      port: server.getPort(),
      host: this.getWebUiConnectHost(this.webUiOptions?.host),
      token: server.getAuthToken(),
    };
    try {
      writeFileSync(getWebUiStatePath(), JSON.stringify(state) + '\n', { mode: 0o600 });
    } catch (err) {
      logger.warn(`[Daemon] Could not write web UI state: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Remove the web UI state file (called on shutdown). */
  private removeWebUiState(): void {
    try {
      unlinkSync(getWebUiStatePath());
    } catch {
      // File may not exist -- that's fine
    }
  }
}
