import type { WorkflowStopOptions } from './orchestrator.js';
import { installShutdownSignals, type ShutdownSignal } from '../utils/shutdown-signals.js';

/** Force-exit deadline after the first signal for the workflow CLI. */
export const WORKFLOW_FORCE_EXIT_MS = 30_000;

/**
 * Container-snapshot budget for a signal-driven workflow CLI shutdown. Half of
 * the force-exit window: a `snapshotOnStop` commit (a flattening export and
 * import that can take minutes) is cut short instead of being killed by the
 * force exit, and the container teardown that follows still fits before it.
 */
export const WORKFLOW_SIGNAL_SNAPSHOT_BUDGET_MS = 15_000;

/** The signals {@link installWorkflowShutdownSignals} can handle. */
export type WorkflowShutdownSignal = ShutdownSignal;

export interface WorkflowShutdownSignalOptions {
  readonly forceExitAfterMs?: number;
  readonly onFirstSignal?: (signal: NodeJS.Signals) => void;
  readonly forceExit?: (exitCode: number) => void;
  /**
   * The signals to handle; defaults to SIGINT, SIGTERM and SIGHUP. A signal
   * left out keeps Node's default action, which ends the process at once
   * without any teardown, under `nohup` too (Node resets an inherited ignored
   * SIGHUP to the default when it starts). See installDaemonShutdownSignals
   * for a daemon that must survive a hangup.
   */
  readonly signals?: readonly WorkflowShutdownSignal[];
}

/**
 * Stop options for `shutdownAll()` after the CLI caught `signal`: the runs
 * are recorded as interrupted by it (not as a user abort), and snapshots are
 * bounded by {@link WORKFLOW_SIGNAL_SNAPSHOT_BUDGET_MS}. Without a signal the
 * defaults apply.
 */
export function workflowStopOptionsForSignal(signal: NodeJS.Signals | undefined): WorkflowStopOptions {
  if (signal === undefined) return {};
  return { reason: `Workflow interrupted by ${signal}`, snapshotBudgetMs: WORKFLOW_SIGNAL_SNAPSHOT_BUDGET_MS };
}

/**
 * Installs bounded graceful shutdown and returns an exact unregister thunk.
 * The first SIGINT/SIGTERM/SIGHUP (or the `signals` given) aborts
 * `controller`, calls `onFirstSignal` and arms a force exit after
 * `forceExitAfterMs`; a later SIGINT or SIGTERM forces the exit at once (exit
 * code 128 + signal number). A repeated SIGHUP does not: a closing terminal
 * delivers two, and the teardown the first one started must still drain.
 * Used by the workflow CLI and by the daemon; the mechanics are the shared
 * ones in utils/shutdown-signals.ts.
 */
export function installWorkflowShutdownSignals(
  controller: AbortController,
  options: WorkflowShutdownSignalOptions = {},
): () => void {
  return installShutdownSignals(controller, {
    signals: options.signals,
    forceExitAfterMs: options.forceExitAfterMs ?? WORKFLOW_FORCE_EXIT_MS,
    onFirstSignal: options.onFirstSignal,
    forceExit: options.forceExit,
  });
}
