/**
 * One accepted stream socket (Unix domain or TCP) bridged to the MCP SDK's
 * `Transport` interface with newline-delimited JSON framing -- the same wire
 * format as the SDK's `StdioServerTransport`.
 *
 * `UdsServerTransport` and `TcpServerTransport` wrap every accepted
 * connection in one of these, so each client has its own read buffer and,
 * in multi-client mode, its own MCP `Server` (hence its own JSON-RPC id
 * space). The hardening mirrors `StdioServerTransport`; none of it may be
 * weakened, because the peer is the untrusted agent in the container and
 * this code runs inside the host process that owns the policy kernel:
 *
 * - A malformed frame (invalid JSON, or JSON that is not a JSON-RPC message)
 *   is reported through `onerror`; the connection stays up and the next
 *   valid frame is delivered. `JsonRpcReadBuffer.readLine()` consumes the bad
 *   line before parsing it, so the read loop cannot spin on it.
 * - A frame larger than `maxBufferSize` (the SDK's 10 MiB by default) is
 *   reported through `onerror` and destroys this socket only. `append()` has
 *   already discarded the buffer at that point, so the remainder of the
 *   oversized line would otherwise be parsed as garbage.
 * - An exception thrown by `onmessage` is reported through `onerror` instead
 *   of escaping the socket's 'data' handler, which would take the whole host
 *   process (and, under the daemon, every other session) down with it.
 *
 * Fixed-size pages and a scan cursor make copying and framing linear in
 * incoming bytes, even across incomplete reads. Code Mode uses a tighter
 * 1 MiB unread-byte cap on both listener types.
 *
 * One more bound has no counterpart in `StdioServerTransport`: what is
 * queued for a peer that does not read it. Everything `send()` writes stays
 * in this process's memory until the peer takes it, and a peer can keep
 * sending requests (pings cost it nothing) without ever reading a reply.
 * Each queued reply costs far more than its own bytes: the MCP SDK keeps the
 * request it answers (its abort controller, handler context and promise
 * chain) until the write completes, about 2 KiB per reply, so 4 MiB of
 * 40-byte ping replies would pin some 230 MiB of heap. The send side is
 * therefore bounded per connection in messages as well as in bytes:
 *
 * - Past `sendHighWaterMessages` messages (1,024 by default) or
 *   `sendHighWaterMark` bytes (4 MiB) queued, this connection stops reading:
 *   the socket is paused, so the kernel's flow control holds the peer's
 *   further requests, and frames already received wait unparsed in the read
 *   buffer. Reading resumes once the peer has taken everything queued (the
 *   last pending write completes; this does not wait for 'drain', which
 *   never follows a queue smaller than the socket's own
 *   `writableHighWaterMark`). A slow or briefly stalled reader is throttled
 *   and loses nothing.
 * - The SDK answers a request after the frame that carried it has been
 *   delivered, so the queue only grows once the frames parsed so far have
 *   been handed over. Reading therefore yields to the event loop once every
 *   {@link SOCKET_TRANSPORT_FRAMES_BETWEEN_YIELDS} frames: the replies to
 *   those frames are queued, and counted, before more are parsed. Without
 *   this a resumed socket hands over everything it buffered while paused at
 *   once (up to about 128 KiB, some 3,000 pings) before the first of their
 *   replies is counted.
 * - Pausing cannot stop the replies to requests read before it, so past
 *   `maxSendBufferMessages` messages (16,384) or `maxSendBufferSize` bytes
 *   (32 MiB) queued the connection is reported through `onerror` and
 *   destroyed, this one only. A legitimate reply is far smaller: an
 *   `execute_code` reply is bounded by the result size limit (100 KB by
 *   default) and a relayed backend reply by the SDK's 10 MiB read limit.
 */

import type { Socket } from 'node:net';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import { deserializeMessage, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import { JsonRpcReadBuffer } from './json-rpc-read-buffer.js';

/**
 * Default cap on simultaneously open connections per listening transport.
 * Every agent process in the container holds one connection (plus transient
 * health probes on TCP); the cap only bounds a runaway or hostile client.
 */
export const SOCKET_TRANSPORT_DEFAULT_MAX_CONNECTIONS = 64;

/** Default bytes queued for the peer past which a connection stops reading. */
export const SOCKET_TRANSPORT_DEFAULT_SEND_HIGH_WATER_MARK = 4 * 1024 * 1024;

/** Default bytes queued for the peer past which a connection is dropped. */
export const SOCKET_TRANSPORT_DEFAULT_MAX_SEND_BUFFER_SIZE = 32 * 1024 * 1024;

/** Default messages queued for the peer past which a connection stops reading. */
export const SOCKET_TRANSPORT_DEFAULT_SEND_HIGH_WATER_MESSAGES = 1024;

/** Default messages queued for the peer past which a connection is dropped. */
export const SOCKET_TRANSPORT_DEFAULT_MAX_SEND_BUFFER_MESSAGES = 16 * 1024;

/**
 * Frames a connection delivers before it yields to the event loop once, so
 * that the replies to them are queued (and counted against the send-side
 * bounds) before it parses more.
 */
export const SOCKET_TRANSPORT_FRAMES_BETWEEN_YIELDS = 256;

export interface SocketConnectionTransportOptions {
  /**
   * Bytes the listener already consumed from the socket before handing it
   * over (`TcpServerTransport` reads the first bytes to tell a health probe
   * from MCP traffic). Delivered ahead of any later 'data' event.
   */
  readonly initialData?: Buffer;
  /** Per-connection cap on unread bytes; defaults to the SDK's 10 MiB. */
  readonly maxBufferSize?: number;
  /**
   * Bytes queued for the peer (sent but not yet taken by it) past which the
   * connection stops reading until the peer has taken everything queued.
   * Defaults to {@link SOCKET_TRANSPORT_DEFAULT_SEND_HIGH_WATER_MARK}.
   */
  readonly sendHighWaterMark?: number;
  /**
   * Bytes queued for the peer past which the connection is dropped. Defaults
   * to {@link SOCKET_TRANSPORT_DEFAULT_MAX_SEND_BUFFER_SIZE}.
   */
  readonly maxSendBufferSize?: number;
  /**
   * Messages queued for the peer past which the connection stops reading,
   * like `sendHighWaterMark`. Defaults to
   * {@link SOCKET_TRANSPORT_DEFAULT_SEND_HIGH_WATER_MESSAGES}.
   */
  readonly sendHighWaterMessages?: number;
  /**
   * Messages queued for the peer past which the connection is dropped.
   * Defaults to {@link SOCKET_TRANSPORT_DEFAULT_MAX_SEND_BUFFER_MESSAGES}.
   */
  readonly maxSendBufferMessages?: number;
}

/** Normalizes a thrown value for the `onerror` callback. */
export function toTransportError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export class SocketConnectionTransport implements Transport {
  private readonly socket: Socket;
  private readonly readBuffer: JsonRpcReadBuffer;
  private readonly sendHighWaterMark: number;
  private readonly maxSendBufferSize: number;
  private readonly sendHighWaterMessages: number;
  private readonly maxSendBufferMessages: number;
  private initialData: Buffer | undefined;
  private started = false;
  /** Messages passed to send() whose write has not completed yet. */
  private queued = 0;
  /** Reading is paused until the peer has taken everything queued for it. */
  private sendBackpressure = false;
  /** Frames delivered since reading last yielded to the event loop. */
  private framesSinceYield = 0;
  /** Reading is paused until the scheduled yield to the event loop has run. */
  private yielding = false;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(socket: Socket, options?: SocketConnectionTransportOptions) {
    this.socket = socket;
    this.readBuffer = new JsonRpcReadBuffer(options?.maxBufferSize);
    this.sendHighWaterMark = options?.sendHighWaterMark ?? SOCKET_TRANSPORT_DEFAULT_SEND_HIGH_WATER_MARK;
    this.maxSendBufferSize = options?.maxSendBufferSize ?? SOCKET_TRANSPORT_DEFAULT_MAX_SEND_BUFFER_SIZE;
    this.sendHighWaterMessages = options?.sendHighWaterMessages ?? SOCKET_TRANSPORT_DEFAULT_SEND_HIGH_WATER_MESSAGES;
    this.maxSendBufferMessages = options?.maxSendBufferMessages ?? SOCKET_TRANSPORT_DEFAULT_MAX_SEND_BUFFER_MESSAGES;
    this.initialData = options?.initialData;

    // An accepted socket must have an 'error' listener from the moment it
    // exists: an unhandled 'error' event is thrown out of the event loop.
    socket.on('error', (err) => this.onerror?.(err));
    // 'close' fires exactly once -- for a peer disconnect, an error, or our
    // own close() -- so it is the single source of truth for onclose.
    socket.once('close', () => this.onclose?.());
    // Keep incoming bytes in the socket's own buffer until start() installs
    // the data handler: Protocol.connect() installs the callbacks first and
    // only then calls start(). Without this, data arriving in between would
    // be emitted with nobody listening and lost.
    socket.pause();
  }

  /** True once the underlying socket is destroyed, by either side. */
  get destroyed(): boolean {
    return this.socket.destroyed;
  }

  /** Bytes passed to `send()` that the peer has not taken yet (the socket's `writableLength`). */
  get writableLength(): number {
    return this.socket.writableLength;
  }

  /** Messages passed to `send()` whose write has not completed yet (the peer has not taken them). */
  get queuedMessages(): number {
    return this.queued;
  }

  /** True while reading is paused because the peer has not taken what is queued for it. */
  get readingPaused(): boolean {
    return this.sendBackpressure;
  }

  /** Begins delivering frames. Idempotent. */
  start(): Promise<void> {
    if (!this.started) {
      this.started = true;
      this.socket.on('data', this.handleData);
      const initial = this.initialData;
      this.initialData = undefined;
      if (initial && initial.length > 0) this.handleData(initial);
      // Starts the socket reading, unless something already holds it back:
      // replies queued before start() for a peer that has not taken them.
      this.pump();
    }
    return Promise.resolve();
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- options included for Transport interface compliance
  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    const socket = this.socket;
    if (socket.destroyed) {
      throw new Error('Socket connection is closed');
    }
    return new Promise<void>((resolve, reject) => {
      // Serialized first: a message that cannot be serialized rejects this
      // send without being counted as queued.
      const frame = serializeMessage(message);
      this.queued++;
      // Node calls this exactly once per write, never synchronously, also
      // for a write that a destroy discards.
      socket.write(frame, (err) => {
        this.queued--;
        if (err) reject(err);
        else resolve();
        if (this.queued === 0 && this.sendBackpressure) {
          // The peer has taken everything queued for it: read again,
          // starting with the frames held back in the read buffer.
          this.sendBackpressure = false;
          this.pump();
        }
      });
      // Synchronously, before anything else can be queued or parsed. Inside
      // the executor, so a throwing onerror rejects this send instead of
      // orphaning it.
      this.limitSendQueue();
    });
  }

  /** Destroys the socket; resolves once it has closed. onclose fires via the 'close' event. */
  async close(): Promise<void> {
    const socket = this.socket;
    if (socket.destroyed) return;
    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
      socket.destroy();
    });
  }

  /**
   * Bounds what is queued for the peer after each write (see the module
   * comment): past a hard cap the connection is dropped, past a high-water
   * mark reading pauses until the peer has taken everything queued.
   */
  private limitSendQueue(): void {
    const socket = this.socket;
    const bytes = socket.writableLength;
    const messages = this.queued;
    const overBytes = bytes > this.maxSendBufferSize;
    if (overBytes || messages > this.maxSendBufferMessages) {
      // Dropped before it is reported, so the drop holds whatever onerror does.
      socket.destroy();
      const limit = overBytes
        ? `maximum size of ${this.maxSendBufferSize} bytes`
        : `maximum of ${this.maxSendBufferMessages} messages`;
      this.onerror?.(
        new Error(
          `Socket send buffer exceeded ${limit} ` +
            `(${messages} messages, ${bytes} bytes not taken by the peer); connection closed`,
        ),
      );
      return;
    }
    if (!this.sendBackpressure && (bytes > this.sendHighWaterMark || messages > this.sendHighWaterMessages)) {
      this.sendBackpressure = true;
      socket.pause();
    }
  }

  private readonly handleData = (chunk: Buffer): void => {
    // Bytes for a socket that is already gone (e.g. buffered before an
    // overflow destroyed it) are dropped rather than parsed.
    if (this.socket.destroyed) return;
    try {
      this.readBuffer.append(chunk);
    } catch (error) {
      // Overflow: the buffer is already empty and the rest of this line
      // would arrive as garbage. Drop this connection only.
      this.socket.destroy();
      this.onerror?.(toTransportError(error));
      return;
    }
    this.pump();
  };

  /**
   * Delivers what the read buffer holds and lets the socket flow once every
   * complete frame is delivered. The only place reading resumes, so nothing
   * else can undo a pause.
   */
  private pump(): void {
    if (!this.started) return;
    if (this.processReadBuffer()) this.socket.resume();
  }

  /**
   * Delivers the complete frames in the read buffer. Returns false if it
   * stopped early with reading paused: while the send queue holds reading
   * back (every frame parsed would queue another reply for a peer that is not
   * taking them; the rest follows once it has), at a yield to the event loop
   * (the rest follows on the next turn), or for good once the socket is gone.
   */
  private processReadBuffer(): boolean {
    for (;;) {
      if (this.sendBackpressure || this.yielding || this.socket.destroyed) return false;
      if (this.framesSinceYield >= SOCKET_TRANSPORT_FRAMES_BETWEEN_YIELDS) {
        this.yieldToEventLoop();
        return false;
      }
      try {
        const line = this.readBuffer.readLine();
        if (line === null) return true;
        // Malformed lines consume the same turn budget as valid messages.
        this.framesSinceYield++;
        const message = deserializeMessage(line);
        this.onmessage?.(message);
      } catch (error) {
        // A malformed line, or an onmessage handler that threw. The bad line
        // has already been consumed, so carrying on is safe.
        this.onerror?.(toTransportError(error));
      }
    }
  }

  /**
   * Pauses reading until the next turn of the event loop. By then the
   * replies to the frames just delivered have been sent (and counted against
   * the send-side bounds), so a peer that is not reading them is held back
   * before more of its frames are parsed.
   */
  private yieldToEventLoop(): void {
    this.yielding = true;
    this.socket.pause();
    setImmediate(() => {
      this.yielding = false;
      this.framesSinceYield = 0;
      this.pump();
    });
  }
}
