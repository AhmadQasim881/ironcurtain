/**
 * Escalation wait primitives: how a pending human (or in-process) decision
 * on an escalated tool call ends without a decision.
 *
 * A wait ends in one of three ways besides a decision, and none of them is a
 * human denial:
 *
 *   - **timed out**: nobody decided within the configured escalation timeout
 *     (`escalationTimeoutSeconds`);
 *   - **cancelled** by the coordinator: `close()` or a workflow policy swap
 *     (`loadPolicy`) must not wait out the escalation timeout behind a
 *     parked call; or by the call's own caller, whose cancellation signal
 *     aborted because nobody waits for the call any more (the Code Mode
 *     script that made it ended; see {@link callerCancellationSignal});
 *   - **withdrawn** by an in-process handler that knows nobody will decide
 *     any more (the workflow agent turn that raised it ended, the run was
 *     aborted). The handler rejects with {@link EscalationWithdrawnError} and
 *     the pipeline treats it as a cancellation.
 *
 * The first two travel as the `reason` of the `AbortSignal` handed to the
 * wait (an {@link EscalationAbortReason}); the security pipeline audits them
 * as `timed-out` / `cancelled` and tells the agent the same.
 *
 * Leaf module (no imports) so callers outside the trusted process, such as
 * the workflow orchestrator, can use the withdrawal error without loading
 * the pipeline.
 */

/**
 * Why an escalation wait was aborted. Set as the `reason` of the
 * `AbortSignal` handed to the wait: `timed-out` when the configured
 * escalation timeout elapsed, `cancelled` when the coordinator withdrew the
 * wait (teardown or a workflow policy swap). In-process handlers receive the
 * same signal and can read the reason to clean up their UI.
 */
export interface EscalationAbortReason {
  readonly kind: 'timed-out' | 'cancelled';
  readonly detail: string;
}

/** Builds an abort reason for `AbortController.abort(reason)`. */
export function escalationAbortReason(kind: EscalationAbortReason['kind'], detail: string): EscalationAbortReason {
  return { kind, detail };
}

/**
 * Reads the typed abort reason off a signal. `undefined` when the signal has
 * not aborted; an abort without a typed reason reads as a cancellation.
 */
export function readEscalationAbortReason(signal: AbortSignal): EscalationAbortReason | undefined {
  if (!signal.aborted) return undefined;
  const reason: unknown = signal.reason;
  if (
    reason !== null &&
    typeof reason === 'object' &&
    'kind' in reason &&
    'detail' in reason &&
    (reason.kind === 'timed-out' || reason.kind === 'cancelled') &&
    typeof reason.detail === 'string'
  ) {
    return { kind: reason.kind, detail: reason.detail };
  }
  return { kind: 'cancelled', detail: 'escalation wait aborted' };
}

/**
 * Combines a cancellation signal with the configured escalation timeout. The
 * returned signal aborts with a typed {@link EscalationAbortReason} on
 * whichever fires first; `dispose` clears the timer once the wait has
 * settled.
 */
export function escalationDeadlineSignal(
  cancelSignal: AbortSignal,
  timeoutMs: number,
): { readonly signal: AbortSignal; readonly dispose: () => void } {
  const timeoutController = new AbortController();
  const seconds = timeoutMs % 1000 === 0 ? String(timeoutMs / 1000) : (timeoutMs / 1000).toFixed(1);
  const timer = setTimeout(() => {
    timeoutController.abort(
      escalationAbortReason('timed-out', `no decision within the ${seconds}s escalation timeout`),
    );
  }, timeoutMs);
  // Node timers would keep the process alive for the full timeout; the
  // escalation wait itself is what keeps the call pending, not this timer.
  timer.unref();
  return {
    signal: AbortSignal.any([cancelSignal, timeoutController.signal]),
    dispose: () => clearTimeout(timer),
  };
}

/**
 * Why a caller cancelled a tool call, from the abort reason of its signal:
 * an Error's message, a string, or a generic text.
 */
export function describeCallerCancellation(reason: unknown): string {
  if (reason instanceof Error && reason.message) return reason.message;
  if (typeof reason === 'string' && reason) return reason;
  return 'the caller cancelled the tool call';
}

/**
 * Maps a tool call's cancellation signal (its caller stopped waiting, e.g.
 * the Code Mode script that made it ended) onto the escalation wait: the
 * returned signal aborts with a `cancelled` {@link EscalationAbortReason}
 * whose detail says why the caller cancelled. `dispose` detaches it once the
 * wait has settled.
 */
export function callerCancellationSignal(callerSignal: AbortSignal): {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  const onAbort = (): void => {
    controller.abort(escalationAbortReason('cancelled', describeCallerCancellation(callerSignal.reason)));
  };
  if (callerSignal.aborted) onAbort();
  else callerSignal.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      callerSignal.removeEventListener('abort', onAbort);
    },
  };
}

/** Resolves after `ms`, or as soon as `signal` aborts, whichever comes first. */
export function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolveSleep) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolveSleep();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolveSleep();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Outcome of {@link settleBeforeAbort}: the handler's value, or `settled: false` when the signal won. */
export type HandlerRace<T> = { readonly settled: true; readonly value: T } | { readonly settled: false };

/**
 * Races a handler's promise against the escalation signal. Resolves with the
 * handler's value when it settles first, or `{ settled: false }` when the
 * signal fires first; the handler's late settlement is then ignored (a late
 * rejection is swallowed so it cannot surface as an unhandled rejection). A
 * handler rejection before the abort propagates to the caller unchanged.
 */
export function settleBeforeAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<HandlerRace<T>> {
  if (signal.aborted) {
    pending.catch(() => {});
    return Promise.resolve({ settled: false });
  }
  return new Promise((resolveRace, rejectRace) => {
    let done = false;
    const onAbort = (): void => {
      if (done) return;
      done = true;
      pending.catch(() => {});
      resolveRace({ settled: false });
    };
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(
      (value) => {
        if (done) return;
        done = true;
        signal.removeEventListener('abort', onAbort);
        resolveRace({ settled: true, value });
      },
      (err: unknown) => {
        if (done) return;
        done = true;
        signal.removeEventListener('abort', onAbort);
        rejectRace(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** Error code carried by {@link EscalationWithdrawnError}. */
export const ESCALATION_WITHDRAWN_CODE = 'ESCALATION_WITHDRAWN';

/**
 * Rejection an in-process escalation handler uses to withdraw a pending
 * escalation that nobody will decide any more. The pipeline denies the call
 * as `cancelled` (with this message as the detail) instead of auditing a
 * human denial. Recognized by its `code` ({@link isEscalationWithdrawnError}),
 * not by `instanceof`, so it survives module boundaries.
 */
export class EscalationWithdrawnError extends Error {
  readonly code = ESCALATION_WITHDRAWN_CODE;

  constructor(detail: string) {
    super(detail);
    this.name = 'EscalationWithdrawnError';
  }
}

/** True for an {@link EscalationWithdrawnError} (matched on its `code`). */
export function isEscalationWithdrawnError(err: unknown): err is Error & { readonly code: string } {
  return err instanceof Error && (err as { code?: unknown }).code === ESCALATION_WITHDRAWN_CODE;
}
