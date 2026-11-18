/**
 * Resource bounds for the MITM proxy (`mitm-proxy.ts`): MITM-10 and MITM-14.
 *
 * The proxy runs inside the daemon or session process and shares its event
 * loop, memory and file descriptors with every other session there. A
 * compromised agent controls the client side of every connection on its own
 * bundle's proxy socket, so each proxy (one per bundle) bounds what that client
 * can pin:
 *
 * - how many decrypted requests, raw tunnels, TLS-terminated connections and
 *   client sockets are open at once;
 * - how many request-body bytes buffered requests hold, across the bundle
 *   ({@link BufferedBodyBudget}) and per request (the provider's
 *   `maxRequestBodyBytes`, default {@link DEFAULT_MAX_REQUEST_BODY_BYTES});
 * - how long a decrypted connection (or a port-80 passthrough tunnel served as
 *   HTTP) may sit without a request head or without traffic
 *   ({@link DecryptedConnectionMonitor}): the HTTP servers those connections
 *   are handed to never listen, so Node enforces none of its own header or
 *   request timeouts on them;
 * - how long a buffered body, an upstream response or a raw tunnel may stall.
 *
 * A request refused for size, budget, concurrency or time gets a complete JSON
 * error response with `Connection: close` ({@link writeRequestRefusal}). The
 * response is written as soon as the refusal is decided, and the rest of the
 * upload is read and discarded (bounded, {@link drainRequestBody}) before the
 * connection closes. Destroying the socket mid-upload instead makes fetch-style
 * clients report a reset and lose the error.
 */

import type * as http from 'node:http';
import type { Socket } from 'node:net';
import { isObjectWithProp } from '../utils/is-plain-object.js';

/**
 * Default ceiling for a buffered request body, raw and again once decoded:
 * Anthropic's documented 32 MB Messages API request limit. Providers with a
 * different documented limit set `ProviderConfig.maxRequestBodyBytes`.
 */
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;

/** Per-proxy (per-bundle) resource ceilings. Every field is a positive integer. */
export interface MitmResourceLimits {
  /** Requests (decrypted, or plain HTTP through the proxy) being handled at once; more get a 503. */
  readonly maxConcurrentRequests: number;
  /** Passthrough CONNECT tunnels (raw, SNI-pinned or port-80 HTTP) and WebSocket bridges open at once; more get a 503. */
  readonly maxConcurrentTunnels: number;
  /** TLS-terminated client connections open at once, handshakes included; more CONNECTs get a 503. */
  readonly maxConcurrentTlsConnections: number;
  /** Client sockets the outer listener accepts at once (`net.Server#maxConnections`); a backstop. */
  readonly maxClientConnections: number;
  /** Request-body bytes held by buffered requests across the proxy (raw, plus decoded when compressed). */
  readonly maxBufferedBodyBytes: number;
  /** A decrypted connection or port-80 tunnel with no request in progress must deliver a complete request head within this. */
  readonly requestHeadersTimeoutMs: number;
  /** A decrypted connection or port-80 tunnel with no bytes in either direction for this long is closed. */
  readonly connectionIdleTimeoutMs: number;
  /** A buffered request body that delivers no bytes for this long is refused (408). */
  readonly requestBodyIdleTimeoutMs: number;
  /** A buffered request body not complete within this long is refused (408). */
  readonly requestBodyTimeoutMs: number;
  /** The upstream must start its response (status and headers) within this long of the request. */
  readonly upstreamResponseHeadersTimeoutMs: number;
  /** An upstream exchange with no bytes in either direction for this long is aborted. */
  readonly upstreamIdleTimeoutMs: number;
  /** A raw tunnel or WebSocket bridge with no bytes in either direction for this long is closed. */
  readonly tunnelIdleTimeoutMs: number;
  /** Bytes of a refused upload read and discarded before the connection is closed anyway. */
  readonly refusedBodyDrainBytes: number;
  /** How long a refused upload is drained before the connection is closed anyway. */
  readonly refusedBodyDrainTimeoutMs: number;
}

const MIB = 1024 * 1024;
const MINUTE_MS = 60_000;

/**
 * Production ceilings. The counts leave room for an agent's parallel
 * completions plus a package manager's parallel downloads (yarn and bun use
 * about 50 sockets). The upstream deadlines match the 10-minute request
 * ceiling of the Anthropic and OpenAI SDKs, so a non-streaming completion the
 * client still waits for is never cut short; the decrypted-connection idle
 * limit sits above them as a backstop.
 */
export const DEFAULT_MITM_RESOURCE_LIMITS: MitmResourceLimits = Object.freeze({
  maxConcurrentRequests: 128,
  maxConcurrentTunnels: 64,
  maxConcurrentTlsConnections: 256,
  maxClientConnections: 512,
  maxBufferedBodyBytes: 128 * MIB,
  requestHeadersTimeoutMs: MINUTE_MS,
  connectionIdleTimeoutMs: 15 * MINUTE_MS,
  requestBodyIdleTimeoutMs: MINUTE_MS,
  requestBodyTimeoutMs: 5 * MINUTE_MS,
  upstreamResponseHeadersTimeoutMs: 10 * MINUTE_MS,
  upstreamIdleTimeoutMs: 10 * MINUTE_MS,
  tunnelIdleTimeoutMs: 10 * MINUTE_MS,
  refusedBodyDrainBytes: 64 * MIB,
  refusedBodyDrainTimeoutMs: 30_000,
});

const LIMIT_NAMES = Object.keys(DEFAULT_MITM_RESOURCE_LIMITS) as (keyof MitmResourceLimits)[];

/** The defaults with `overrides` applied. Throws for a limit that is not a positive safe integer. */
export function resolveMitmResourceLimits(overrides: Partial<MitmResourceLimits> = {}): MitmResourceLimits {
  const resolved: Record<keyof MitmResourceLimits, number> = { ...DEFAULT_MITM_RESOURCE_LIMITS };
  for (const name of LIMIT_NAMES) {
    const value = overrides[name] ?? DEFAULT_MITM_RESOURCE_LIMITS[name];
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`MITM resource limit ${name} must be a positive integer, got ${String(value)}`);
    }
    resolved[name] = value;
  }
  return Object.freeze(resolved);
}

/** Throws unless `bytes` is a usable per-request body ceiling (a positive safe integer). */
export function assertRequestBodyLimit(bytes: number, label: string): void {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error(`${label} must be a positive integer number of bytes, got ${String(bytes)}`);
  }
}

// ── Buffered-body budget ────────────────────────────────────────────────

/** One request's share of a {@link BufferedBodyBudget}. */
export interface BufferedBodyAccount {
  /** Bytes this account currently holds. */
  readonly chargedBytes: number;
  /** Charge `bytes`; false (and nothing charged) when the budget cannot hold them or the account is closed. */
  charge(bytes: number): boolean;
  /** Return everything this account charged and close it. Idempotent. */
  release(): void;
}

/**
 * The bytes buffered request bodies may hold across one proxy. A request
 * charges what it buffers (and, for a compressed body, what it decodes) to its
 * own account and keeps the charge until its exchange ends, since the
 * forwarded body stays referenced for the auth retry while the response
 * streams.
 */
export class BufferedBodyBudget {
  private used = 0;

  constructor(readonly maxBytes: number) {}

  get usedBytes(): number {
    return this.used;
  }

  openAccount(): BufferedBodyAccount {
    let charged = 0;
    let open = true;
    const charge = (bytes: number): boolean => {
      if (!open) return false;
      if (bytes <= 0) return true;
      if (this.used + bytes > this.maxBytes) return false;
      this.used += bytes;
      charged += bytes;
      return true;
    };
    const release = (): void => {
      if (!open) return;
      open = false;
      this.used -= charged;
      charged = 0;
    };
    return {
      get chargedBytes() {
        return charged;
      },
      charge,
      release,
    };
  }
}

/**
 * A runner that executes async tasks one at a time, in submission order: a
 * task starts only once every earlier task has settled, and a rejection
 * reaches its own caller without stopping later tasks. The proxy decodes
 * compressed bodies through one per bundle (see `decodeInTurn` in
 * mitm-proxy.ts), since each decode charges its output to the bundle's
 * {@link BufferedBodyBudget} as it goes.
 */
export function createSerialRunner(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const result = tail.then(task);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

// ── Bounded request-body reading ────────────────────────────────────────

export interface DrainLimits {
  /** Discard at most this many more bytes. */
  readonly maxBytes: number;
  /** Stop discarding after this long. */
  readonly timeoutMs: number;
}

/**
 * Read and discard the rest of `req` so a client that writes its whole body
 * before reading can still receive the response. Resolves (never rejects) at
 * the end of the body, when the client goes away, or when `limits` run out;
 * in the last case the stream is paused and the caller's `Connection: close`
 * response ends the connection.
 */
export function drainRequestBody(req: http.IncomingMessage, limits: DrainLimits): Promise<void> {
  if (req.complete || req.readableEnded || req.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    let drained = 0;
    let done = false;
    const timer = setTimeout(() => finish(true), limits.timeoutMs);
    timer.unref();
    const onData = (chunk: Buffer): void => {
      drained += chunk.length;
      if (drained > limits.maxBytes) finish(true);
    };
    const onEnd = (): void => finish(false);
    function finish(stopReading: boolean): void {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onEnd);
      req.off('close', onEnd);
      if (stopReading) req.pause();
      resolve();
    }
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onEnd);
    req.on('close', onEnd);
    req.resume();
  });
}

export interface RequestBodyReadOptions {
  /** Largest body accepted; a larger one is refused (`too-large`). */
  readonly maxBytes: number;
  /** The request's budget account; every buffered byte is charged to it. */
  readonly account: BufferedBodyAccount;
  /** Refuse (`timeout`) when no body bytes arrive for this long. */
  readonly idleTimeoutMs: number;
  /** Refuse (`timeout`) when the body is not complete after this long. */
  readonly totalTimeoutMs: number;
  /** How much of a refused body is drained before the caller closes. */
  readonly drain: DrainLimits;
}

/**
 * Outcome of {@link readRequestBody}. On `too-large` and `over-budget` nothing
 * is held any more and the rest of the upload is being drained; `drained`
 * resolves when the caller may end its refusal response.
 */
export type RequestBodyRead =
  | { readonly kind: 'complete'; readonly body: Buffer }
  | { readonly kind: 'too-large'; readonly declaredBytes?: number; readonly drained: Promise<void> }
  | { readonly kind: 'over-budget'; readonly drained: Promise<void> }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'failed'; readonly error: Error };

function declaredContentLength(req: http.IncomingMessage): number | undefined {
  const header = req.headers['content-length'];
  if (header === undefined || !/^[0-9]+$/u.test(header)) return undefined;
  const value = Number(header);
  return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * Buffer `req`'s body within `options.maxBytes` and the request's budget
 * account, never destroying the request: every refusal leaves the connection
 * able to carry the caller's error response. A declared `Content-Length` over
 * the limit is refused before a byte is buffered. On success the body's bytes
 * stay charged to the account; on any refusal or failure the account is
 * released.
 */
export function readRequestBody(req: http.IncomingMessage, options: RequestBodyReadOptions): Promise<RequestBodyRead> {
  if (req.destroyed) {
    options.account.release();
    return Promise.resolve({ kind: 'failed', error: new Error('client closed the request before its body was read') });
  }
  const declaredBytes = declaredContentLength(req);
  if (declaredBytes !== undefined && declaredBytes > options.maxBytes) {
    return Promise.resolve({ kind: 'too-large', declaredBytes, drained: drainRequestBody(req, options.drain) });
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let idleTimer = setTimeout(() => stop({ kind: 'timeout' }), options.idleTimeoutMs);
    idleTimer.unref();
    const totalTimer = setTimeout(() => stop({ kind: 'timeout' }), options.totalTimeoutMs);
    totalTimer.unref();

    const detach = (): void => {
      clearTimeout(idleTimer);
      clearTimeout(totalTimer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('close', onClose);
    };
    /** Settle without the body: drop what was buffered and return it to the budget. */
    const stop = (result: RequestBodyRead): void => {
      if (settled) return;
      settled = true;
      detach();
      chunks.length = 0;
      options.account.release();
      // A stalled or failed body is not drained; the caller's Connection: close response ends it.
      if (result.kind === 'timeout' || result.kind === 'failed') req.pause();
      resolve(result);
    };
    // The drain attaches its listeners in the same tick the reader detaches,
    // so no chunk and no 'end' can fall between the two.
    const refuse = (kind: 'too-large' | 'over-budget'): void => {
      if (settled) return;
      stop({ kind, drained: drainRequestBody(req, options.drain) });
    };
    function onData(chunk: Buffer): void {
      if (settled) return;
      if (size + chunk.length > options.maxBytes) {
        refuse('too-large');
        return;
      }
      if (!options.account.charge(chunk.length)) {
        refuse('over-budget');
        return;
      }
      size += chunk.length;
      chunks.push(chunk);
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => stop({ kind: 'timeout' }), options.idleTimeoutMs);
      idleTimer.unref();
    }
    function onEnd(): void {
      if (settled) return;
      settled = true;
      detach();
      resolve({ kind: 'complete', body: Buffer.concat(chunks, size) });
    }
    function onError(error: Error): void {
      stop({ kind: 'failed', error });
    }
    function onClose(): void {
      stop({ kind: 'failed', error: new Error('client closed the request before its body ended') });
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);
  });
}

// ── Refusal responses ───────────────────────────────────────────────────

export interface RequestRefusal {
  readonly status: 408 | 413 | 503;
  /** `error.type` in the JSON body (the Anthropic error vocabulary, which the OpenAI SDK also surfaces). */
  readonly errorType: 'timeout_error' | 'request_too_large' | 'overloaded_error';
  /** Safe to show the agent; prefixed with "IronCurtain proxy refused this request: ". */
  readonly message: string;
  readonly retryAfterSeconds?: number;
}

/** The JSON error body of a refusal; the shape both the Anthropic and OpenAI SDKs surface. */
export function refusalResponseBody(refusal: RequestRefusal): string {
  return JSON.stringify({
    type: 'error',
    error: { type: refusal.errorType, message: `IronCurtain proxy refused this request: ${refusal.message}` },
  });
}

/**
 * Answer a refused request with a complete JSON error and `Connection: close`.
 * With `drained`, the response is written at once but ended only when the
 * upload has been drained, so the connection stays open (and the error
 * deliverable) while a client that reads only after writing finishes its body.
 */
export function writeRequestRefusal(res: http.ServerResponse, refusal: RequestRefusal, drained?: Promise<void>): void {
  if (res.headersSent) {
    // Nothing coherent can follow a response that has already started.
    res.destroy();
    return;
  }
  const payload = refusalResponseBody(refusal);
  res.writeHead(refusal.status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    Connection: 'close',
    ...(refusal.retryAfterSeconds !== undefined ? { 'Retry-After': String(refusal.retryAfterSeconds) } : {}),
  });
  if (drained === undefined) {
    res.end(payload);
    return;
  }
  res.write(payload);
  void drained.then(() => {
    if (!res.writableEnded) res.end();
  });
}

/** Human-readable byte size for refusal messages and logs, e.g. `32 MiB` or `1536 bytes`. */
export function describeByteSize(bytes: number): string {
  return bytes % MIB === 0 ? `${bytes / MIB} MiB` : `${bytes} bytes`;
}

// ── Upstream deadlines ──────────────────────────────────────────────────

/** Error-code discriminant of an upstream exchange the proxy aborted on a deadline. */
export const UPSTREAM_TIMEOUT = 'UPSTREAM_TIMEOUT';

export class UpstreamTimeoutError extends Error {
  readonly code = UPSTREAM_TIMEOUT;

  constructor(message: string) {
    super(message);
    this.name = 'UpstreamTimeoutError';
  }
}

export function isUpstreamTimeoutError(error: unknown): boolean {
  return isObjectWithProp(error, 'code') && error.code === UPSTREAM_TIMEOUT;
}

/**
 * Bound one upstream request: its response must start within
 * `upstreamResponseHeadersTimeoutMs`, and the exchange is aborted after
 * `upstreamIdleTimeoutMs` without a byte in either direction (an SSE stream
 * rearms that on every event). Either deadline destroys the request with an
 * {@link UpstreamTimeoutError}, which reaches the caller's `error` handler.
 */
export function armUpstreamDeadlines(
  req: http.ClientRequest,
  limits: Pick<MitmResourceLimits, 'upstreamResponseHeadersTimeoutMs' | 'upstreamIdleTimeoutMs'>,
): void {
  const headersTimer = setTimeout(() => {
    req.destroy(
      new UpstreamTimeoutError(`upstream sent no response within ${limits.upstreamResponseHeadersTimeoutMs} ms`),
    );
  }, limits.upstreamResponseHeadersTimeoutMs);
  headersTimer.unref();
  const clearHeadersTimer = (): void => clearTimeout(headersTimer);
  req.once('response', clearHeadersTimer);
  req.once('upgrade', clearHeadersTimer);
  req.once('close', clearHeadersTimer);
  req.setTimeout(limits.upstreamIdleTimeoutMs, () => {
    req.destroy(new UpstreamTimeoutError(`upstream idle for ${limits.upstreamIdleTimeoutMs} ms`));
  });
}

// ── Decrypted-connection deadlines ──────────────────────────────────────

export type DecryptedConnectionExpiry = 'request-head' | 'idle';

interface MonitoredConnection {
  readonly socket: Socket;
  inFlightRequests: number;
  /** When the connection last became ready for a request head, while none is in flight. */
  awaitingRequestSince: number | undefined;
  lastBytesRead: number;
  lastBytesWritten: number;
  lastActivityAt: number;
}

/**
 * Explicit deadlines for the connections the proxy hands to an HTTP server
 * that never listens: TLS-terminated connections on its inner server, and the
 * approved port-80 passthrough tunnels it serves as HTTP. Node enforces
 * neither `headersTimeout` nor `requestTimeout` on such connections, and it
 * rewrites a socket's own timeout around every keep-alive request, so these
 * are tracked here instead:
 *
 * - `request-head`: a connection with no request in flight (fresh from its
 *   handshake, or after its last response) must complete a request head within
 *   `requestHeadersTimeoutMs`. This is the time-to-first-byte bound that stops
 *   a slow-header client from holding a connection.
 * - `idle`: no bytes in either direction for `connectionIdleTimeoutMs`.
 *
 * Expired connections are passed to `onExpired`, which closes them.
 */
export class DecryptedConnectionMonitor {
  private readonly connections = new Map<Socket, MonitoredConnection>();
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly limits: Pick<MitmResourceLimits, 'requestHeadersTimeoutMs' | 'connectionIdleTimeoutMs'>,
    private readonly onExpired: (socket: Socket, reason: DecryptedConnectionExpiry) => void,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.connections.size;
  }

  /** Start watching `socket` (until it closes). Its request-head deadline starts now. */
  track(socket: Socket): void {
    const now = this.now();
    this.connections.set(socket, {
      socket,
      inFlightRequests: 0,
      awaitingRequestSince: now,
      lastBytesRead: socket.bytesRead,
      lastBytesWritten: socket.bytesWritten,
      lastActivityAt: now,
    });
    socket.once('close', () => this.connections.delete(socket));
  }

  /**
   * Stop watching `socket` while it stays open: it was upgraded (to a
   * WebSocket bridge, say) and the HTTP deadlines no longer describe it; the
   * caller bounds what it became.
   */
  untrack(socket: Socket): void {
    this.connections.delete(socket);
  }

  /** A complete request head arrived on `socket`. */
  requestStarted(socket: Socket): void {
    const state = this.connections.get(socket);
    if (state === undefined) return;
    state.inFlightRequests += 1;
    state.awaitingRequestSince = undefined;
    state.lastActivityAt = this.now();
  }

  /** A request on `socket` has been answered (or abandoned). */
  requestFinished(socket: Socket): void {
    const state = this.connections.get(socket);
    if (state === undefined) return;
    state.inFlightRequests = Math.max(0, state.inFlightRequests - 1);
    if (state.inFlightRequests === 0) state.awaitingRequestSince = this.now();
  }

  /** Check every connection once; called periodically after {@link start}. */
  sweep(): void {
    const now = this.now();
    for (const state of [...this.connections.values()]) {
      const { socket } = state;
      if (socket.bytesRead !== state.lastBytesRead || socket.bytesWritten !== state.lastBytesWritten) {
        state.lastBytesRead = socket.bytesRead;
        state.lastBytesWritten = socket.bytesWritten;
        state.lastActivityAt = now;
      }
      let reason: DecryptedConnectionExpiry | undefined;
      if (
        state.inFlightRequests === 0 &&
        state.awaitingRequestSince !== undefined &&
        now - state.awaitingRequestSince >= this.limits.requestHeadersTimeoutMs
      ) {
        reason = 'request-head';
      } else if (now - state.lastActivityAt >= this.limits.connectionIdleTimeoutMs) {
        reason = 'idle';
      }
      if (reason !== undefined) {
        this.connections.delete(socket);
        this.onExpired(socket, reason);
      }
    }
  }

  /** Sweep periodically, at a quarter of the shorter deadline (between 25 ms and 5 s). */
  start(): void {
    if (this.sweepTimer !== undefined) return;
    const shortest = Math.min(this.limits.requestHeadersTimeoutMs, this.limits.connectionIdleTimeoutMs);
    const intervalMs = Math.min(5_000, Math.max(25, Math.floor(shortest / 4)));
    this.sweepTimer = setInterval(() => this.sweep(), intervalMs);
    this.sweepTimer.unref();
  }

  stop(): void {
    if (this.sweepTimer !== undefined) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    this.connections.clear();
  }
}
