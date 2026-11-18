/**
 * AgentSlotPool -- the cap on concurrent workflow agent environments.
 *
 * A workflow agent environment is what an agent needs to run: a
 * shared-container bundle (one container, its proxies and coordinator,
 * however many agents run in it) or a workflow agent session that brings
 * its own (a per-state Docker container, or a builtin session's sandbox and
 * MCP relays). Without a cap, several workflows, or a wide fan-out of
 * non-shared lanes, start as many of these as they like and can exhaust the
 * host's CPU, memory or Docker networks.
 *
 * The orchestrator owns one pool, sized by `maxConcurrentAgentSessions`.
 * The daemon runs every workflow through a single orchestrator, so its pool
 * is daemon-wide; a CLI `workflow start` process has its own.
 *
 * Requests queue rather than fail: `acquire` resolves once enough slots are
 * free. The queue is strictly FIFO (a large request at the head is not
 * overtaken by later small ones, so it cannot starve). A request larger than
 * the whole pool can never be served and is refused at once with
 * {@link AgentSlotRequestError}; a waiting request ends when its signal
 * aborts.
 *
 * Deadlock freedom is the caller's side of the contract: a holder must not
 * wait for more slots while holding some. The orchestrator therefore
 * reserves every scope a shared-container run may mint in one request, and
 * takes one slot per non-shared session, released before its next session.
 */

/** Discriminant for {@link AgentSlotRequestError}. */
export const AGENT_SLOT_REQUEST_TOO_LARGE = 'AGENT_SLOT_REQUEST_TOO_LARGE';

/** A request for more slots than the pool has; it could never be served. */
export class AgentSlotRequestError extends Error {
  readonly code = AGENT_SLOT_REQUEST_TOO_LARGE;
  /**
   * @param subject - what needs the slots, as the start of the message
   *   (e.g. `Workflow "evolve" (one per shared container scope)`).
   */
  constructor(
    readonly requested: number,
    readonly capacity: number,
    subject = 'An agent slot request',
  ) {
    super(
      `${subject} needs ${requested} concurrent agent environments, but maxConcurrentAgentSessions allows only ` +
        `${capacity}. Raise maxConcurrentAgentSessions in ~/.ironcurtain/config.json, or use fewer container scopes.`,
    );
    this.name = 'AgentSlotRequestError';
  }
}

/** Slots held by one successful `acquire`. */
export interface AgentSlotLease {
  readonly slots: number;
  /** Returns the slots to the pool. Idempotent. */
  release(): void;
}

/** Pool occupancy, as reported to a request that has to wait. */
export interface AgentSlotUsage {
  readonly inUse: number;
  readonly capacity: number;
  /** Requests waiting, this one included. */
  readonly waiting: number;
}

export interface AcquireAgentSlotsOptions {
  /** Ends a waiting request: it is removed from the queue and rejects with the signal's reason. */
  readonly signal?: AbortSignal;
  /**
   * Called once, synchronously, when the request cannot be served at once and
   * joins the queue. A report only: an exception it throws is ignored, and the
   * request keeps waiting.
   */
  readonly onWait?: (usage: AgentSlotUsage) => void;
}

interface Waiter {
  readonly slots: number;
  readonly grant: () => void;
}

export class AgentSlotPool {
  readonly capacity: number;
  private used = 0;
  private readonly queue: Waiter[] = [];

  constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error(`Agent slot capacity must be a positive integer, got ${String(capacity)}`);
    }
    this.capacity = capacity;
  }

  /** Slots currently held. */
  get inUse(): number {
    return this.used;
  }

  /** Requests currently waiting. */
  get waiting(): number {
    return this.queue.length;
  }

  /**
   * Resolves with a lease on `slots` slots once they are free and every
   * earlier request has been served. Rejects at once with
   * {@link AgentSlotRequestError} when `slots` exceeds the pool, and with
   * the signal's reason when `options.signal` aborts first.
   */
  acquire(slots = 1, options: AcquireAgentSlotsOptions = {}): Promise<AgentSlotLease> {
    if (!Number.isSafeInteger(slots) || slots < 1) {
      return Promise.reject(new Error(`Agent slot request must be a positive integer, got ${String(slots)}`));
    }
    if (slots > this.capacity) {
      return Promise.reject(new AgentSlotRequestError(slots, this.capacity));
    }
    const { signal } = options;
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (this.queue.length === 0 && this.used + slots <= this.capacity) {
      return Promise.resolve(this.lease(slots));
    }

    return new Promise<AgentSlotLease>((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.queue.indexOf(waiter);
        if (index === -1) return;
        this.queue.splice(index, 1);
        reject(abortReason(signal));
        // The head may have been blocking smaller requests behind it.
        this.serveQueue();
      };
      const waiter: Waiter = {
        slots,
        grant: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve(this.lease(slots));
        },
      };
      this.queue.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        options.onWait?.({ inUse: this.used, capacity: this.capacity, waiting: this.queue.length });
      } catch {
        // Thrown out of this executor, the error would reject the promise while
        // the waiter stays queued: its later grant would take slots nobody can
        // release, shrinking the pool for good. The report is best-effort.
      }
    });
  }

  private lease(slots: number): AgentSlotLease {
    this.used += slots;
    let held = true;
    return {
      slots,
      release: () => {
        if (!held) return;
        held = false;
        this.used -= slots;
        this.serveQueue();
      },
    };
  }

  /** Grants queued requests in order while the head fits. */
  private serveQueue(): void {
    for (;;) {
      const head = this.queue.at(0);
      if (head === undefined || this.used + head.slots > this.capacity) return;
      this.queue.shift();
      head.grant();
    }
  }
}

function abortReason(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error) return reason;
  return new Error('Agent slot request was aborted', { cause: reason });
}
