/**
 * Limits for Code Mode chains (one `execute_code` script, run in a fresh V8
 * isolate by `code-mode-chain.ts`) and the admission control that bounds how
 * many of them live at once.
 *
 * Inside one chain, the runner bounds console output on the host side
 * ({@link DEFAULT_MAX_CONSOLE_BYTES}, {@link DEFAULT_MAX_CONSOLE_ENTRIES}):
 * the strings isolated-vm copies out of the isolate are host memory that
 * neither the isolate's `memoryLimit` nor the V8 heap limit covers.
 *
 * Across chains: the AI SDK runs one step's tool calls in parallel, and a
 * container agent can send any number of concurrent MCP requests, so without
 * a bound the number of live isolates -- and the host memory behind them --
 * is chosen by the untrusted agent. Two limits apply:
 *
 *   - **Per sandbox**: a small number of chains run at once; more wait in a
 *     bounded FIFO queue, and calls beyond the queue are refused at once.
 *   - **Per process**: the daemon hosts many sandboxes (web, cron, Signal
 *     sessions, workflow bundles), so the chains of all of them share one
 *     memory budget. A chain's weight is its isolate memory limit times
 *     {@link ISOLATE_MEMORY_OVERSHOOT_FACTOR}: isolated-vm documents the
 *     limit as a guideline that a determined script can exceed two to three
 *     times.
 *
 * A wait ends with a {@link ChainAdmissionError} when its signal aborts or its
 * deadline passes; the caller turns that into an ordinary `execute_code`
 * error. Leaf module.
 */

/** V8 heap limit of one `execute_code` isolate, in MB (isolated-vm's `memoryLimit`). */
export const DEFAULT_CHAIN_MEMORY_LIMIT_MB = 128;

/**
 * Console output one chain may produce, in UTF-8 bytes: about ten times what
 * the model is shown (`DEFAULT_RESULT_SIZE_LIMIT`). A script past it is stopped.
 */
export const DEFAULT_MAX_CONSOLE_BYTES = 1_048_576;

/** Console calls one chain may make (each one is a host array entry). */
export const DEFAULT_MAX_CONSOLE_ENTRIES = 10_000;

/**
 * How far a script can push an isolate past its `memoryLimit` before
 * isolated-vm disposes it ("a guideline an attacker can exceed 2-3x").
 */
export const ISOLATE_MEMORY_OVERSHOOT_FACTOR = 3;

/** Chains one builtin Code Mode session runs at once. */
export const DEFAULT_MAX_CONCURRENT_CHAINS = 2;

/**
 * Chains one Docker code-mode proxy runs at once. Several agent processes can
 * share one proxy (workflow lanes in a shared container), so it gets more
 * than a builtin session; the process-wide budget still bounds them all.
 */
export const CODE_MODE_PROXY_MAX_CONCURRENT_CHAINS = 4;

/** Chains that may wait for a slot in one sandbox; further calls are refused. */
export const DEFAULT_MAX_QUEUED_CHAINS = 16;

/**
 * Process-wide budget for the worst-case footprint of every live chain, in
 * MB: six chains at the default memory limit (2.25 GiB).
 */
export const PROCESS_CHAIN_MEMORY_BUDGET_MB = 6 * DEFAULT_CHAIN_MEMORY_LIMIT_MB * ISOLATE_MEMORY_OVERSHOOT_FACTOR;

/** Worst-case footprint of one chain whose isolate has `memoryLimitMb`, in MB. */
export function chainMemoryWeightMb(memoryLimitMb: number): number {
  return memoryLimitMb * ISOLATE_MEMORY_OVERSHOOT_FACTOR;
}

/** Why a chain was not admitted. */
export type ChainAdmissionErrorCode = 'CHAIN_QUEUE_FULL' | 'CHAIN_QUEUE_TIMEOUT' | 'CHAIN_CANCELLED';

/**
 * A chain that never got to run. Matched on `code` across module boundaries
 * ({@link isChainAdmissionError}).
 */
export class ChainAdmissionError extends Error {
  constructor(
    readonly code: ChainAdmissionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ChainAdmissionError';
  }
}

/** True for a {@link ChainAdmissionError} (matched on its `code`). */
export function isChainAdmissionError(err: unknown): err is ChainAdmissionError {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return code === 'CHAIN_QUEUE_FULL' || code === 'CHAIN_QUEUE_TIMEOUT' || code === 'CHAIN_CANCELLED';
}

/** Ends a wait for a slot. */
export interface SlotWaitOptions {
  /** Aborting it withdraws the waiter. */
  readonly signal?: AbortSignal;
  /** Epoch milliseconds after which the waiter gives up. */
  readonly deadlineMs?: number;
}

/** Returns the units a holder took. Idempotent. */
export type ReleaseSlot = () => void;

interface Waiter {
  readonly weight: number;
  readonly grant: (release: ReleaseSlot) => void;
  readonly cleanup: () => void;
}

/** Text for an abort reason: an Error's message, a string, or a default. */
export function describeAbortReason(reason: unknown, fallback: string): string {
  if (reason instanceof Error && reason.message) return reason.message;
  if (typeof reason === 'string' && reason) return reason;
  return fallback;
}

/**
 * A weighted counting semaphore with a bounded FIFO queue. Waiters are served
 * strictly in arrival order, so a heavy waiter at the head is never starved by
 * light ones behind it.
 */
export class WeightedSemaphore {
  private inUse = 0;
  private readonly waiters: Waiter[] = [];

  /**
   * @param capacity - total units; a single request heavier than this is
   *   clamped to it (it then runs alone instead of never running)
   * @param maxQueued - waiters allowed at once; further requests are refused
   * @param label - names the resource in refusal messages
   */
  constructor(
    private readonly capacity: number,
    private readonly maxQueued: number = Number.POSITIVE_INFINITY,
    private readonly label = 'execution slot',
  ) {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new Error(`WeightedSemaphore capacity must be a positive number (got ${capacity})`);
    }
  }

  /** Units currently held. */
  get used(): number {
    return this.inUse;
  }

  /** Requests currently waiting. */
  get queued(): number {
    return this.waiters.length;
  }

  /**
   * Takes `weight` units, waiting in FIFO order when they are not free.
   * Rejects with a {@link ChainAdmissionError} when the queue is full, the
   * signal aborts, or the deadline passes first.
   */
  acquire(weight: number, options: SlotWaitOptions = {}): Promise<ReleaseSlot> {
    const units = Math.min(Math.max(weight, 1), this.capacity);
    const { signal, deadlineMs } = options;
    if (signal?.aborted) {
      return Promise.reject(this.cancelled(signal));
    }
    if (this.waiters.length === 0 && this.inUse + units <= this.capacity) {
      this.inUse += units;
      return Promise.resolve(this.releaser(units));
    }
    if (this.waiters.length >= this.maxQueued) {
      return Promise.reject(
        new ChainAdmissionError(
          'CHAIN_QUEUE_FULL',
          `too many execute_code calls are waiting for a free ${this.label} (${this.maxQueued} queued); retry once the running ones finish`,
        ),
      );
    }
    if (deadlineMs !== undefined && deadlineMs <= Date.now()) {
      return Promise.reject(this.timedOut());
    }

    return new Promise<ReleaseSlot>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const withdraw = (err: ChainAdmissionError): void => {
        const index = this.waiters.indexOf(waiter);
        if (index === -1) return;
        this.waiters.splice(index, 1);
        cleanup();
        reject(err);
        // The head may have been blocking lighter waiters behind it.
        this.drain();
      };
      const onAbort = (): void => {
        withdraw(this.cancelled(signal));
      };
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const waiter: Waiter = { weight: units, grant: resolve, cleanup };
      this.waiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (deadlineMs !== undefined) {
        timer = setTimeout(
          () => {
            withdraw(this.timedOut());
          },
          Math.max(0, deadlineMs - Date.now()),
        );
        timer.unref();
      }
    });
  }

  private releaser(units: number): ReleaseSlot {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inUse -= units;
      this.drain();
    };
  }

  /** Grants waiters from the head of the queue while their units are free. */
  private drain(): void {
    while (this.waiters.length > 0) {
      const head = this.waiters[0];
      if (this.inUse + head.weight > this.capacity) return;
      this.waiters.shift();
      head.cleanup();
      this.inUse += head.weight;
      head.grant(this.releaser(head.weight));
    }
  }

  private cancelled(signal: AbortSignal | undefined): ChainAdmissionError {
    const why = describeAbortReason(signal?.reason, 'the call was cancelled');
    return new ChainAdmissionError('CHAIN_CANCELLED', `cancelled while waiting for a free ${this.label}: ${why}`);
  }

  private timedOut(): ChainAdmissionError {
    return new ChainAdmissionError(
      'CHAIN_QUEUE_TIMEOUT',
      `timed out waiting for a free ${this.label}: other execute_code calls are still running`,
    );
  }
}

/**
 * The budget every sandbox in this process draws on (see
 * {@link PROCESS_CHAIN_MEMORY_BUDGET_MB}). Its queue is bounded indirectly: a
 * chain waits here only while it holds one of its sandbox's few slots.
 */
export const processChainBudget = new WeightedSemaphore(
  PROCESS_CHAIN_MEMORY_BUDGET_MB,
  Number.POSITIVE_INFINITY,
  'process-wide Code Mode slot',
);
