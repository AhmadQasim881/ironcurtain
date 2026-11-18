/**
 * Proxy-wide bounds on the standard registry proxy's metadata work (EGR-4).
 *
 * The registry proxy runs in the trusted host process, next to the policy
 * engine, and the agent chooses which package metadata it fetches. npm
 * packuments reach tens of megabytes (`@prisma/client` 68 MB, `vite` 39 MB),
 * and before these bounds every request buffered its whole document, so a
 * burst of concurrent requests could exhaust host memory. One budget per proxy
 * now bounds:
 *
 * - how many metadata operations run at once. An operation is one metadata
 *   request or one tarball-backstop lookup, from its upstream fetches to the
 *   last byte of its response. Further operations wait in FIFO order rather
 *   than being refused, up to a queue bound;
 * - how many metadata bytes the proxy buffers at once, across operations. An
 *   operation reserves its document's declared length (or the per-response
 *   ceiling when it declares none) before it reads the body, and keeps the
 *   reservation until its response is written. Reservations are also granted
 *   in FIFO order;
 * - how large one metadata response may be ({@link RegistryMetadataLimits.maxResponseBytes}),
 *   how long one operation may take in all, and how long an upstream may stall.
 *
 * An operation holds at most one reservation and reserves only while it holds
 * a slot, and every holder finishes without waiting on another, so the queues
 * cannot deadlock. Waiting for a slot or for bytes ends early when the
 * operation is aborted (its client disconnected or its deadline passed).
 */

import { MAX_REGISTRY_METADATA_BYTES } from './registry-metadata.js';

const MIB = 1024 * 1024;

export interface RegistryMetadataLimits {
  /** Metadata bytes buffered at once across the proxy. At least {@link maxResponseBytes}. */
  readonly maxBufferedBytes: number;
  /** Metadata operations running at once; more wait in the queue. */
  readonly maxConcurrentOperations: number;
  /** Operations waiting for a slot; more are refused with 503. */
  readonly maxQueuedOperations: number;
  /** Largest metadata response read, buffered or streamed; a larger one fails closed. */
  readonly maxResponseBytes: number;
  /** One operation in all, from arrival (queueing included) to its response's last byte. */
  readonly operationTimeoutMs: number;
  /** An upstream metadata fetch that delivers nothing for this long is abandoned. */
  readonly upstreamIdleTimeoutMs: number;
}

/**
 * Production bounds. Four 60 MB packuments fit in the buffer at once; the
 * queue bound sits above the MITM proxy's 128 concurrent requests, so in
 * practice requests queue rather than fail. Five minutes covers a 68 MB
 * packument on a slow link (about 1.8 Mbit/s).
 */
export const DEFAULT_REGISTRY_METADATA_LIMITS: RegistryMetadataLimits = Object.freeze({
  maxBufferedBytes: 256 * MIB,
  maxConcurrentOperations: 8,
  maxQueuedOperations: 512,
  maxResponseBytes: MAX_REGISTRY_METADATA_BYTES,
  operationTimeoutMs: 5 * 60_000,
  upstreamIdleTimeoutMs: 30_000,
});

/** The defaults with `overrides` applied. Throws for a limit that is not a positive safe integer. */
export function resolveRegistryMetadataLimits(overrides: Partial<RegistryMetadataLimits> = {}): RegistryMetadataLimits {
  const resolved = { ...DEFAULT_REGISTRY_METADATA_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`registry metadata limit ${name} must be a positive integer, got ${String(value)}`);
    }
  }
  if (resolved.maxResponseBytes > resolved.maxBufferedBytes) {
    throw new Error('registry metadata maxResponseBytes must not exceed maxBufferedBytes');
  }
  return Object.freeze(resolved);
}

/** `queue-full`: too many operations are already waiting. `aborted`: the caller's signal fired while waiting. */
export type RegistryMetadataBudgetErrorCode = 'queue-full' | 'aborted';

export class RegistryMetadataBudgetError extends Error {
  constructor(
    readonly code: RegistryMetadataBudgetErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RegistryMetadataBudgetError';
  }
}

export interface RegistryMetadataBudgetSnapshot {
  readonly activeOperations: number;
  readonly queuedOperations: number;
  readonly bufferedBytes: number;
  /** Operations holding a slot and waiting for bytes. */
  readonly waitingForBytes: number;
  readonly peakActiveOperations: number;
  readonly peakBufferedBytes: number;
}

/** One operation's slot, and the bytes it buffers. */
export interface RegistryMetadataPermit {
  /** Waits (FIFO) until `bytes` more can be buffered. At most one reservation per permit. */
  reserve(bytes: number, signal: AbortSignal): Promise<void>;
  /** Gives back the reserved bytes above `bytes`, once the actual size is known. */
  shrink(bytes: number): void;
  /** Returns the slot and every reserved byte. Idempotent. */
  release(): void;
}

interface SlotWaiter {
  readonly signal: AbortSignal;
  readonly grant: () => void;
  readonly onAbort: () => void;
}

interface ByteWaiter {
  readonly permit: Permit;
  readonly bytes: number;
  readonly signal: AbortSignal;
  readonly grant: () => void;
  readonly onAbort: () => void;
  readonly cancel: () => void;
}

interface Permit extends RegistryMetadataPermit {
  reserved: number;
  waiter: ByteWaiter | undefined;
}

function abortedError(): RegistryMetadataBudgetError {
  return new RegistryMetadataBudgetError('aborted', 'registry metadata operation was aborted while waiting');
}

/** The metadata budget of one registry proxy. */
export class RegistryMetadataBudget {
  readonly limits: RegistryMetadataLimits;
  private active = 0;
  private buffered = 0;
  private peakActive = 0;
  private peakBuffered = 0;
  private readonly slotWaiters: SlotWaiter[] = [];
  private readonly byteWaiters: ByteWaiter[] = [];

  constructor(limits: Partial<RegistryMetadataLimits> = {}) {
    this.limits = resolveRegistryMetadataLimits(limits);
  }

  get snapshot(): RegistryMetadataBudgetSnapshot {
    return {
      activeOperations: this.active,
      queuedOperations: this.slotWaiters.length,
      bufferedBytes: this.buffered,
      waitingForBytes: this.byteWaiters.length,
      peakActiveOperations: this.peakActive,
      peakBufferedBytes: this.peakBuffered,
    };
  }

  /**
   * Waits (FIFO) for an operation slot. Rejects with `queue-full` when
   * {@link RegistryMetadataLimits.maxQueuedOperations} are already waiting, or
   * with `aborted` when `signal` fires first.
   */
  acquire(signal: AbortSignal): Promise<RegistryMetadataPermit> {
    if (signal.aborted) return Promise.reject(abortedError());
    if (this.slotWaiters.length === 0 && this.active < this.limits.maxConcurrentOperations) {
      return Promise.resolve(this.grantSlot());
    }
    if (this.slotWaiters.length >= this.limits.maxQueuedOperations) {
      return Promise.reject(new RegistryMetadataBudgetError('queue-full', 'registry metadata queue is full'));
    }
    return new Promise((resolve, reject) => {
      const waiter: SlotWaiter = {
        signal,
        grant: () => {
          signal.removeEventListener('abort', waiter.onAbort);
          resolve(this.grantSlot());
        },
        onAbort: () => {
          const index = this.slotWaiters.indexOf(waiter);
          if (index >= 0) this.slotWaiters.splice(index, 1);
          reject(abortedError());
        },
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
      this.slotWaiters.push(waiter);
    });
  }

  private grantSlot(): RegistryMetadataPermit {
    this.active += 1;
    this.peakActive = Math.max(this.peakActive, this.active);
    let released = false;
    const permit: Permit = {
      reserved: 0,
      waiter: undefined,
      reserve: (bytes, signal) => this.reserve(permit, bytes, signal),
      shrink: (bytes) => {
        if (released || bytes >= permit.reserved) return;
        this.buffered -= permit.reserved - Math.max(0, bytes);
        permit.reserved = Math.max(0, bytes);
        this.grantBytes();
      },
      release: () => {
        if (released) return;
        released = true;
        permit.waiter?.cancel();
        this.buffered -= permit.reserved;
        permit.reserved = 0;
        this.active -= 1;
        this.grantBytes();
        this.slotWaiters.shift()?.grant();
      },
    };
    return permit;
  }

  private reserve(permit: Permit, bytes: number, signal: AbortSignal): Promise<void> {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.limits.maxBufferedBytes) {
      return Promise.reject(new Error('registry metadata reservation is outside the buffer bound'));
    }
    if (permit.reserved > 0 || permit.waiter !== undefined) {
      return Promise.reject(new Error('a registry metadata operation reserves its buffer once'));
    }
    if (signal.aborted) return Promise.reject(abortedError());
    if (this.byteWaiters.length === 0 && this.buffered + bytes <= this.limits.maxBufferedBytes) {
      this.holdBytes(permit, bytes);
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const leave = (): void => {
        signal.removeEventListener('abort', waiter.onAbort);
        permit.waiter = undefined;
        const index = this.byteWaiters.indexOf(waiter);
        if (index >= 0) this.byteWaiters.splice(index, 1);
      };
      const waiter: ByteWaiter = {
        permit,
        bytes,
        signal,
        grant: () => {
          leave();
          this.holdBytes(permit, bytes);
          resolve();
        },
        onAbort: () => {
          leave();
          reject(abortedError());
          // The head of the queue may have changed.
          this.grantBytes();
        },
        cancel: () => {
          leave();
          reject(abortedError());
        },
      };
      permit.waiter = waiter;
      signal.addEventListener('abort', waiter.onAbort, { once: true });
      this.byteWaiters.push(waiter);
    });
  }

  private holdBytes(permit: Permit, bytes: number): void {
    permit.reserved = bytes;
    this.buffered += bytes;
    this.peakBuffered = Math.max(this.peakBuffered, this.buffered);
  }

  /** Grants waiting reservations in FIFO order while the head fits. */
  private grantBytes(): void {
    for (;;) {
      const head = this.byteWaiters.at(0);
      if (head === undefined || this.buffered + head.bytes > this.limits.maxBufferedBytes) return;
      head.grant();
    }
  }
}
