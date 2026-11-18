/**
 * Interrupt handling for commands that allocate external resources.
 *
 * Node's default SIGINT/SIGTERM/SIGHUP action kills the process without
 * running any `finally` block, so a Ctrl-C while a container, VM or network
 * exists leaves it behind (ora's signal-exit hook re-raises the signal when it
 * is the only listener). Installing these handlers before the first
 * allocation turns the first signal into an abort that the normal teardown
 * path observes; a second SIGINT or SIGTERM, or an optional deadline, forces
 * exit.
 *
 * A hangup is different: closing a terminal (or a multiplexer's PTY) delivers
 * SIGHUP twice, from the kernel and again from the session leader, and every
 * later write to that terminal fails with EIO. So a repeated SIGHUP never
 * forces exit, and once a shutdown signal has arrived stdio stream errors are
 * swallowed: an unhandled 'error' from a spinner frame would otherwise crash
 * the very teardown the signal started.
 *
 * Leaf module: no IronCurtain imports.
 */

import { constants } from 'node:os';

export const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
export type ShutdownSignal = (typeof SHUTDOWN_SIGNALS)[number];

export interface ShutdownSignalOptions {
  /**
   * The signals to handle; defaults to all of {@link SHUTDOWN_SIGNALS}. A
   * signal left out keeps Node's default action, which ends the process at
   * once without any teardown. That includes SIGHUP under `nohup`: Node resets
   * an inherited ignored disposition to the default when it starts, so only a
   * listener keeps a hangup from ending the process.
   */
  readonly signals?: readonly ShutdownSignal[];
  /** Force exit this long after the first signal. Omit to wait for teardown indefinitely. */
  readonly forceExitAfterMs?: number;
  /** Called once, on the first signal, just before the controller is aborted. */
  readonly onFirstSignal?: (signal: ShutdownSignal) => void;
  /** Exit hook for the second signal or the deadline. Defaults to `process.exit`. */
  readonly forceExit?: (exitCode: number) => void;
  /**
   * Streams whose 'error' events are ignored from the first signal until
   * uninstall (the terminal may be gone). Defaults to process.stdin, stdout
   * and stderr.
   */
  readonly stdio?: readonly Pick<NodeJS.EventEmitter, 'on' | 'off'>[];
}

/** Stdio errors after a shutdown signal (EIO from a hung-up terminal) are expected. */
function ignoreStdioError(): void {}

/** Conventional exit status of a process ended by `signal` (128 + signal number). */
export function signalExitCode(signal: NodeJS.Signals): number {
  return 128 + constants.signals[signal];
}

/**
 * Installs graceful shutdown on SIGINT, SIGTERM and SIGHUP (or the `signals`
 * given): the first signal aborts `controller` with a reason naming the
 * signal, a later SIGINT or SIGTERM forces exit (a repeated SIGHUP does not).
 * Returns a thunk that removes exactly the listeners it installed.
 */
export function installShutdownSignals(controller: AbortController, options: ShutdownSignalOptions = {}): () => void {
  const forceExit = options.forceExit ?? ((exitCode: number) => process.exit(exitCode));
  let firstSignal: ShutdownSignal | undefined;
  let forceExitTimer: ReturnType<typeof setTimeout> | undefined;
  /** Streams guarded since the first signal (resolved then, so install touches no stdio). */
  let guardedStdio: readonly Pick<NodeJS.EventEmitter, 'on' | 'off'>[] = [];

  const handleSignal = (signal: ShutdownSignal): void => {
    if (firstSignal) {
      // The rest of a hangup, not a request to hurry: keep tearing down.
      if (signal === 'SIGHUP') return;
      if (forceExitTimer) clearTimeout(forceExitTimer);
      forceExit(signalExitCode(signal));
      return;
    }

    firstSignal = signal;
    guardedStdio = options.stdio ?? [process.stdin, process.stdout, process.stderr];
    for (const stream of guardedStdio) stream.on('error', ignoreStdioError);
    options.onFirstSignal?.(signal);
    controller.abort(new ShutdownSignalError(signal));
    if (options.forceExitAfterMs !== undefined) {
      forceExitTimer = setTimeout(() => forceExit(signalExitCode(signal)), options.forceExitAfterMs);
      forceExitTimer.unref();
    }
  };

  // Keep named wrappers so teardown removes precisely what was installed.
  const handlers: Record<ShutdownSignal, () => void> = {
    SIGINT: () => handleSignal('SIGINT'),
    SIGTERM: () => handleSignal('SIGTERM'),
    SIGHUP: () => handleSignal('SIGHUP'),
  };
  const signals = [...new Set(options.signals ?? SHUTDOWN_SIGNALS)];
  for (const signal of signals) process.on(signal, handlers[signal]);

  return () => {
    if (forceExitTimer) clearTimeout(forceExitTimer);
    for (const signal of signals) process.off(signal, handlers[signal]);
    for (const stream of guardedStdio) stream.off('error', ignoreStdioError);
    guardedStdio = [];
  };
}

/**
 * Abort reason set by {@link installShutdownSignals}. Cross-module catchers
 * should test `code === 'SHUTDOWN_SIGNAL'` rather than `instanceof`.
 */
export class ShutdownSignalError extends Error {
  readonly code = 'SHUTDOWN_SIGNAL';

  constructor(readonly signal: ShutdownSignal) {
    super(`Interrupted by ${signal}`);
    this.name = 'ShutdownSignalError';
  }
}

/** The signal recorded as an abort reason, if the abort came from {@link installShutdownSignals}. */
export function shutdownSignalOf(signal: AbortSignal): ShutdownSignal | undefined {
  const reason: unknown = signal.reason;
  if (reason instanceof ShutdownSignalError) return reason.signal;
  return undefined;
}
