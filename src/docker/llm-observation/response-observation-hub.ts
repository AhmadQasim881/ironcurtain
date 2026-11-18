/**
 * A bounded fan-out hub for passive response observation.
 *
 * Raw upstream bytes have one independent forwarding path. This hub accepts a
 * copy, decodes it once, frames SSE once, and isolates every observer behind
 * resource and exception boundaries.
 */

import {
  BoundedContentDecoder,
  type ContentDecoderFailure,
  type ContentDecoderLimits,
  type ContentDecoderSnapshot,
} from './content-decoder.js';
import {
  SseEventFramer,
  SseFramingError,
  type SseEventFrame,
  type SseEventFramerLimits,
  type SseFramingLimitExceeded,
} from './sse-event-framer.js';

export type ObservationConsumerDetachReason =
  | 'consumer-decoded-byte-limit'
  | 'consumer-event-count-limit'
  | 'consumer-callback-error'
  | 'consumer-returned-promise'
  | 'consumer-callback-time-limit'
  | 'consumer-callback-cpu-budget'
  | 'sse-framing-failure'
  | 'content-decoding-failure'
  | 'hub-input-queue-limit'
  | 'hub-aborted';

/** Volume limits after which a usage-scan consumer keeps receiving usage events instead of detaching. */
export type ObservationConsumerDegradeReason =
  'consumer-decoded-byte-limit' | 'consumer-event-count-limit' | 'sse-framing-failure';

export interface ObservationConsumerDetached {
  readonly consumerId: string;
  readonly reason: ObservationConsumerDetachReason;
  readonly message: string;
}

export interface ObservationConsumerDegraded {
  readonly consumerId: string;
  readonly reason: ObservationConsumerDegradeReason;
  readonly message: string;
}

export interface ResponseObservationConsumer {
  readonly id: string;
  /** Per-consumer cap; cannot exceed the shared decoder's cap. */
  readonly maxDecodedBytes?: number;
  readonly maxSseEvents?: number;
  /**
   * SSE consumers only. When this consumer's byte or event cap, or a limit of
   * the shared SSE framer, is exceeded, keep the consumer attached in
   * usage-scan mode: from then on it receives only the events that can carry
   * token usage or a protocol terminal (see `isUsageScanFrame`), so terminal
   * usage that arrives after the limit is still observed. Without it the
   * consumer is detached.
   */
  readonly usageScanAfterLimits?: boolean;
  /** Buffers are defensive copies and may be retained by the consumer. */
  readonly onDecodedChunk?: (chunk: Buffer) => void;
  readonly onSseEvent?: (frame: SseEventFrame) => void;
  readonly onEnd?: () => void;
  readonly onDetach?: (detached: ObservationConsumerDetached) => void;
  /** Called once when the consumer switches to usage-scan mode. */
  readonly onDegrade?: (degraded: ObservationConsumerDegraded) => void;
}

export interface ResponseObservationHubOptions {
  readonly contentEncoding?: string;
  readonly frameSse: boolean;
  readonly consumers: readonly ResponseObservationConsumer[];
  /**
   * Shared decoder limits. When a usage-scan consumer is attached the
   * defaults rise to 64 MiB compressed / 128 MiB decoded
   * (`USAGE_SCAN_DECODER_LIMITS`), so the usage scan can reach a terminal
   * event past the 32 MiB full-fidelity caps.
   */
  readonly decoderLimits?: Partial<ContentDecoderLimits>;
  readonly sseLimits?: Partial<SseEventFramerLimits>;
  /** Maximum raw bytes waiting for the asynchronous observation pump. */
  readonly maxQueuedCompressedBytes?: number;
  /** Maximum queued chunks, independently of their byte size. */
  readonly maxQueuedChunks?: number;
  /**
   * A callback whose thread CPU time exceeds this is slow. One slow callback
   * never detaches a consumer; `maxConsecutiveSlowCallbacks` in a row do.
   */
  readonly maxCallbackDurationMs?: number;
  /** Consecutive slow callbacks that detach a consumer. */
  readonly maxConsecutiveSlowCallbacks?: number;
  /** Total thread CPU time one consumer's callbacks may use over the response. */
  readonly maxConsumerCallbackCpuMs?: number;
  /**
   * Clock for callback costs, in milliseconds. Defaults to this thread's CPU
   * time, which preemption, other threads and blocking waits do not advance.
   */
  readonly callbackClockMs?: () => number;
  readonly onDecoderFailure?: (failure: ContentDecoderFailure) => void;
}

interface ConsumerState {
  readonly consumer: ResponseObservationConsumer;
  active: boolean;
  mode: 'full' | 'usage-scan';
  decodedBytes: number;
  sseEvents: number;
  slowCallbackStreak: number;
  callbackCpuMs: number;
  degraded?: ObservationConsumerDegraded;
  detached?: ObservationConsumerDetached;
}

export interface ResponseObservationConsumerSnapshot {
  readonly id: string;
  readonly active: boolean;
  readonly mode: 'full' | 'usage-scan';
  readonly decodedBytes: number;
  readonly sseEvents: number;
  readonly callbackCpuMs: number;
  readonly degraded?: ObservationConsumerDegraded;
  readonly detached?: ObservationConsumerDetached;
}

export interface ResponseObservationHubSnapshot {
  readonly decoder: ContentDecoderSnapshot;
  readonly queuedCompressedBytes: number;
  readonly endRequested: boolean;
  readonly framingFailure?: { readonly reason: string; readonly message: string };
  readonly consumers: readonly ResponseObservationConsumerSnapshot[];
}

const DEFAULT_CONSUMER_MAX_DECODED_BYTES = 32 * 1024 * 1024;
const DEFAULT_CONSUMER_MAX_SSE_EVENTS = 100_000;
const DEFAULT_MAX_CALLBACK_DURATION_MS = 25;
const DEFAULT_MAX_CONSECUTIVE_SLOW_CALLBACKS = 4;
/**
 * Generous next to a legitimate maximum: the metrics consumer spends about
 * 1-2 µs of CPU per event, so roughly 150 ms on a full 100k-event stream.
 * Only a pathological consumer reaches it, and a several times slower host
 * still has a wide margin.
 */
const DEFAULT_MAX_CONSUMER_CALLBACK_CPU_MS = 2_000;
const DEFAULT_MAX_QUEUED_COMPRESSED_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_QUEUED_CHUNKS = 65_536;
const MAX_CHUNKS_PER_PUMP = 64;

/**
 * Shared decoder defaults while a usage-scan consumer is attached. Full
 * fidelity stays capped per consumer (32 MiB, 100k events); past that only
 * usage events are delivered, until these totals are reached.
 */
const USAGE_SCAN_DECODER_LIMITS: Readonly<Pick<ContentDecoderLimits, 'maxCompressedBytes' | 'maxDecodedBytes'>> =
  Object.freeze({
    maxCompressedBytes: 64 * 1024 * 1024,
    maxDecodedBytes: 128 * 1024 * 1024,
  });

/**
 * Events that can carry token usage or a protocol terminal in the built-in
 * protocols: usage objects (`usage`, `usageMetadata`), Anthropic
 * `message_stop`, and the `[DONE]` sentinel. A cheap superset; the
 * consumer's protocol parser decides what the event means.
 */
export function isUsageScanFrame(frame: SseEventFrame): boolean {
  const data = frame.dataUtf8;
  return (
    data === '[DONE]' || frame.eventType === 'message_stop' || data.includes('usage') || data.includes('message_stop')
  );
}

function positiveLimit(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number`);
  return value;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    'then' in value &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/** CPU time of the calling thread, in milliseconds. */
function threadCpuMs(): number {
  const usage = process.threadCpuUsage();
  return (usage.user + usage.system) / 1_000;
}

/** Thread CPU time where the platform reports it; wall time otherwise, never a throwing clock. */
const defaultCallbackClockMs: () => number = (() => {
  try {
    threadCpuMs();
    return threadCpuMs;
  } catch {
    return () => performance.now();
  }
})();

function usageScanCapable(consumer: ResponseObservationConsumer): boolean {
  return consumer.usageScanAfterLimits === true && consumer.onSseEvent !== undefined;
}

/** The hub never participates in the upstream→client pipe. */
export class ResponseObservationHub {
  private readonly consumers: ConsumerState[];
  private readonly framer?: SseEventFramer;
  private readonly decoder: BoundedContentDecoder;
  private readonly maxCallbackDurationMs: number;
  private readonly maxConsecutiveSlowCallbacks: number;
  private readonly maxConsumerCallbackCpuMs: number;
  private readonly callbackClockMs: () => number;
  private readonly maxQueuedCompressedBytes: number;
  private readonly maxQueuedChunks: number;
  private readonly rawQueue: Buffer[] = [];
  private rawQueueHead = 0;
  private queuedCompressedBytes = 0;
  private pumpScheduled = false;
  private endRequested = false;
  private framingFailure?: { readonly reason: string; readonly message: string };
  private ended = false;

  constructor(options: ResponseObservationHubOptions) {
    this.maxCallbackDurationMs = positiveLimit(
      'maxCallbackDurationMs',
      options.maxCallbackDurationMs ?? DEFAULT_MAX_CALLBACK_DURATION_MS,
    );
    this.maxConsecutiveSlowCallbacks = positiveLimit(
      'maxConsecutiveSlowCallbacks',
      options.maxConsecutiveSlowCallbacks ?? DEFAULT_MAX_CONSECUTIVE_SLOW_CALLBACKS,
    );
    this.maxConsumerCallbackCpuMs = positiveLimit(
      'maxConsumerCallbackCpuMs',
      options.maxConsumerCallbackCpuMs ?? DEFAULT_MAX_CONSUMER_CALLBACK_CPU_MS,
    );
    this.callbackClockMs = options.callbackClockMs ?? defaultCallbackClockMs;
    this.maxQueuedCompressedBytes = positiveLimit(
      'maxQueuedCompressedBytes',
      options.maxQueuedCompressedBytes ?? DEFAULT_MAX_QUEUED_COMPRESSED_BYTES,
    );
    this.maxQueuedChunks = positiveLimit('maxQueuedChunks', options.maxQueuedChunks ?? DEFAULT_MAX_QUEUED_CHUNKS);
    const seenIds = new Set<string>();
    this.consumers = options.consumers.map((consumer) => {
      if (consumer.id.length === 0) throw new Error('observation consumer id must not be empty');
      if (seenIds.has(consumer.id)) throw new Error(`duplicate observation consumer id: ${consumer.id}`);
      seenIds.add(consumer.id);
      if (consumer.maxDecodedBytes !== undefined) positiveLimit('maxDecodedBytes', consumer.maxDecodedBytes);
      if (consumer.maxSseEvents !== undefined) positiveLimit('maxSseEvents', consumer.maxSseEvents);
      return {
        consumer,
        active: true,
        mode: 'full',
        decodedBytes: 0,
        sseEvents: 0,
        slowCallbackStreak: 0,
        callbackCpuMs: 0,
      };
    });
    const usageScan = options.frameSse && options.consumers.some(usageScanCapable);
    this.framer = options.frameSse
      ? new SseEventFramer({
          limits: options.sseLimits,
          // With a usage-scan consumer attached, framing limits degrade the
          // framer instead of ending it, so the scan can continue.
          ...(usageScan ? { onLimit: (exceeded: SseFramingLimitExceeded) => this.onFramingLimit(exceeded) } : {}),
        })
      : undefined;
    this.decoder = new BoundedContentDecoder({
      contentEncoding: options.contentEncoding,
      limits: usageScan ? { ...USAGE_SCAN_DECODER_LIMITS, ...options.decoderLimits } : options.decoderLimits,
      onDecodedChunk: (chunk) => this.onDecodedChunk(chunk),
      onEnd: () => this.onDecodedEnd(),
      onFailure: (failure) => {
        this.ended = true;
        this.clearRawQueue();
        for (const state of this.consumers) {
          if (state.active) this.detachConsumer(state, 'content-decoding-failure', failure.message);
        }
        try {
          options.onDecoderFailure?.(failure);
        } catch {
          // Health listeners are observation consumers too.
        }
      },
    });
  }

  /** Copy raw upstream bytes into observation. Never throws or backpressures. */
  write(chunk: Buffer): void {
    if (this.ended || this.endRequested || chunk.length === 0) return;
    if (
      this.queuedCompressedBytes + chunk.length > this.maxQueuedCompressedBytes ||
      this.rawQueue.length - this.rawQueueHead >= this.maxQueuedChunks
    ) {
      this.failInputQueue('response observation input queue limit exceeded');
      return;
    }
    // The upstream may reuse its chunk after listeners return. Own the copy
    // before yielding; no consumer callback runs in this forwarding stack.
    try {
      this.rawQueue.push(Buffer.from(chunk));
    } catch (error) {
      this.failInputQueue(error instanceof Error ? error.message : 'unable to copy observation input');
      return;
    }
    this.queuedCompressedBytes += chunk.length;
    this.schedulePump();
  }

  /** Finish decoding/framing. Completion callbacks are invoked at most once. */
  end(): void {
    if (this.ended || this.endRequested) return;
    this.endRequested = true;
    this.schedulePump();
  }

  abort(message = 'response observation aborted'): void {
    if (this.ended) return;
    this.ended = true;
    this.clearRawQueue();
    for (const state of this.consumers) {
      if (state.active) this.detachConsumer(state, 'hub-aborted', message);
    }
    this.decoder.detach('consumer-error', message);
  }

  snapshot(): ResponseObservationHubSnapshot {
    return Object.freeze({
      decoder: this.decoder.snapshot(),
      queuedCompressedBytes: this.queuedCompressedBytes,
      endRequested: this.endRequested,
      ...(this.framingFailure ? { framingFailure: this.framingFailure } : {}),
      consumers: Object.freeze(
        this.consumers.map((state) =>
          Object.freeze({
            id: state.consumer.id,
            active: state.active,
            mode: state.mode,
            decodedBytes: state.decodedBytes,
            sseEvents: state.sseEvents,
            callbackCpuMs: state.callbackCpuMs,
            ...(state.degraded ? { degraded: state.degraded } : {}),
            ...(state.detached ? { detached: state.detached } : {}),
          }),
        ),
      ),
    });
  }

  private schedulePump(): void {
    if (this.pumpScheduled || this.ended) return;
    this.pumpScheduled = true;
    setImmediate(() => {
      this.pumpScheduled = false;
      this.pumpOne();
    });
  }

  private pumpOne(): void {
    if (this.ended) return;
    let processed = 0;
    while (this.rawQueueHead < this.rawQueue.length && processed < MAX_CHUNKS_PER_PUMP) {
      const chunk = this.rawQueue[this.rawQueueHead++];
      this.queuedCompressedBytes -= chunk.length;
      try {
        this.decoder.write(chunk);
      } catch {
        this.abort('content decoder escaped its exception boundary');
        return;
      }
      processed += 1;
    }
    if (this.rawQueueHead < this.rawQueue.length) {
      this.schedulePump();
      return;
    }
    this.rawQueue.length = 0;
    this.rawQueueHead = 0;
    if (this.endRequested) {
      try {
        this.decoder.end();
      } catch {
        this.abort('content decoder end escaped its exception boundary');
      }
    }
  }

  private failInputQueue(message: string): void {
    if (this.ended) return;
    this.ended = true;
    this.clearRawQueue();
    for (const state of this.consumers) {
      if (state.active) this.detachConsumer(state, 'hub-input-queue-limit', message);
    }
    this.decoder.detach('consumer-error', message);
  }

  private onDecodedChunk(chunk: Buffer): void {
    if (!this.consumers.some((state) => state.active)) return;

    for (const state of this.consumers) {
      if (!state.active) continue;
      if (state.mode === 'usage-scan') {
        // Usage events are framed below; the shared decoder bounds the total.
        state.decodedBytes += chunk.length;
        continue;
      }
      const maxBytes = state.consumer.maxDecodedBytes ?? DEFAULT_CONSUMER_MAX_DECODED_BYTES;
      if (state.decodedBytes + chunk.length > maxBytes) {
        if (this.degradeOrDetach(state, 'consumer-decoded-byte-limit', 'consumer decoded-byte limit exceeded')) {
          state.decodedBytes += chunk.length;
        }
        continue;
      }
      state.decodedBytes += chunk.length;
      if (state.consumer.onDecodedChunk) {
        this.invokeConsumer(state, () => state.consumer.onDecodedChunk?.(Buffer.from(chunk)));
      }
    }
    if (this.ended) return;

    // Decoded-chunk consumers receive defensive copies, so framing cannot be
    // affected by consumer mutation even though byte limits are checked first.
    // A degraded (lenient) framer keeps framing for usage-scan consumers.
    if (this.framer && (!this.framingFailure || this.framer.degraded) && this.hasActiveSseConsumer()) {
      try {
        this.framer.feed(chunk, (frame) => this.deliverSseFrame(frame));
      } catch (error) {
        this.failFraming(error);
      }
    }
  }

  private hasActiveSseConsumer(): boolean {
    return this.consumers.some((state) => state.active && state.consumer.onSseEvent !== undefined);
  }

  private deliverSseFrame(frame: SseEventFrame): void {
    let usageFrame: boolean | undefined;
    for (const state of this.consumers) {
      if (!state.active || !state.consumer.onSseEvent) continue;
      let mode = state.mode;
      if (mode === 'full' && state.sseEvents >= (state.consumer.maxSseEvents ?? DEFAULT_CONSUMER_MAX_SSE_EVENTS)) {
        if (!this.degradeOrDetach(state, 'consumer-event-count-limit', 'consumer SSE event limit exceeded')) continue;
        mode = 'usage-scan';
      }
      if (mode === 'usage-scan') {
        usageFrame ??= isUsageScanFrame(frame);
        if (!usageFrame) continue;
      }
      state.sseEvents++;
      this.invokeConsumer(state, () => state.consumer.onSseEvent?.(frame));
    }
  }

  private onDecodedEnd(): void {
    if (this.ended) return;
    if (this.framer && (!this.framingFailure || this.framer.degraded)) {
      try {
        this.framer.finish((frame) => this.deliverSseFrame(frame));
      } catch (error) {
        this.failFraming(error);
      }
    }
    this.ended = true;
    for (const state of this.consumers) {
      if (state.active) this.invokeConsumer(state, () => state.consumer.onEnd?.());
    }
  }

  /** A lenient framer exceeded a limit: SSE consumers continue in usage-scan mode or detach. */
  private onFramingLimit(exceeded: SseFramingLimitExceeded): void {
    this.framingFailure = Object.freeze({ reason: exceeded.reason, message: exceeded.message });
    for (const state of this.consumers) {
      if (state.active && state.consumer.onSseEvent) {
        this.degradeOrDetach(state, 'sse-framing-failure', exceeded.message);
      }
    }
  }

  private failFraming(error: unknown): void {
    const reason = error instanceof SseFramingError ? error.reason : 'unexpected-framing-error';
    const message = error instanceof Error ? error.message : String(error);
    this.framingFailure = Object.freeze({ reason, message });
    for (const state of this.consumers) {
      if (state.active && state.consumer.onSseEvent) {
        this.detachConsumer(state, 'sse-framing-failure', message);
      }
    }
  }

  private invokeConsumer(state: ConsumerState, invoke: () => unknown): void {
    if (!state.active) return;
    const started = this.callbackClockMs();
    let result: unknown;
    try {
      result = invoke();
    } catch (error) {
      this.detachConsumer(state, 'consumer-callback-error', error instanceof Error ? error.message : String(error));
      return;
    }
    if (isPromiseLike(result)) {
      // Do not await a consumer on the forwarding event-loop path. Attach a
      // rejection handler solely to prevent an unhandled-rejection warning.
      void Promise.resolve(result).catch(() => {});
      this.detachConsumer(state, 'consumer-returned-promise', 'observation callbacks must be synchronous');
      return;
    }
    this.chargeCallback(state, Math.max(0, this.callbackClockMs() - started));
  }

  /**
   * One slow sample is noise (a GC pause, a page fault); only sustained cost
   * detaches: several slow callbacks in a row, or a spent per-consumer budget.
   */
  private chargeCallback(state: ConsumerState, elapsedMs: number): void {
    state.callbackCpuMs += elapsedMs;
    state.slowCallbackStreak = elapsedMs > this.maxCallbackDurationMs ? state.slowCallbackStreak + 1 : 0;
    if (state.slowCallbackStreak >= this.maxConsecutiveSlowCallbacks) {
      this.detachConsumer(
        state,
        'consumer-callback-time-limit',
        `observation callbacks exceeded ${this.maxCallbackDurationMs} ms ${state.slowCallbackStreak} times in a row`,
      );
    } else if (state.callbackCpuMs > this.maxConsumerCallbackCpuMs) {
      this.detachConsumer(state, 'consumer-callback-cpu-budget', 'observation callbacks exhausted their CPU budget');
    }
  }

  /**
   * Volume limits: a usage-scan consumer keeps receiving usage events; any
   * other consumer detaches. Returns whether the consumer is still attached.
   */
  private degradeOrDetach(state: ConsumerState, reason: ObservationConsumerDegradeReason, message: string): boolean {
    if (!state.active) return false;
    if (!usageScanCapable(state.consumer) || !this.framer) {
      this.detachConsumer(state, reason, message);
      return false;
    }
    if (state.mode === 'usage-scan') return true;
    state.mode = 'usage-scan';
    state.degraded = Object.freeze({ consumerId: state.consumer.id, reason, message });
    try {
      state.consumer.onDegrade?.(state.degraded);
    } catch {
      // A degrade notification cannot affect forwarding or other consumers.
    }
    return true;
  }

  private detachConsumer(state: ConsumerState, reason: ObservationConsumerDetachReason, message: string): void {
    if (!state.active) return;
    state.active = false;
    state.detached = Object.freeze({ consumerId: state.consumer.id, reason, message });
    try {
      state.consumer.onDetach?.(state.detached);
    } catch {
      // A detach callback cannot affect another consumer.
    }
    if (!this.ended && this.consumers.every((consumer) => !consumer.active)) {
      this.ended = true;
      this.clearRawQueue();
      this.decoder.detach('consumer-error', 'all response observation consumers detached');
    }
  }

  private clearRawQueue(): void {
    this.rawQueue.length = 0;
    this.rawQueueHead = 0;
    this.queuedCompressedBytes = 0;
  }
}
