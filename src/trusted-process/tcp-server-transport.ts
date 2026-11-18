/**
 * TCP server transport for the MCP SDK.
 *
 * Listens on a configurable TCP host and port and wraps every accepted
 * connection in its own {@link SocketConnectionTransport}, with the same
 * newline-delimited JSON framing as StdioServerTransport. This is the TCP
 * equivalent of UdsServerTransport, used on macOS where Docker Desktop's
 * VirtioFS does not support Unix domain sockets in bind mounts. The caller
 * controls the bind address: 127.0.0.1 for loopback-only or 0.0.0.0 for all
 * interfaces (which MUST be paired with `allowRemoteAddress`).
 *
 * Per-connection hardening is shared with the UDS transport: a private read
 * buffer per client, malformed frames reported through `onerror` without
 * touching the process or other clients, an oversized frame dropping only
 * the socket it arrived on, and a client that leaves its responses unread
 * being throttled (its connection stops reading) and, past a hard cap,
 * dropped.
 *
 * Two modes, exactly as UdsServerTransport:
 *
 * - **Multi-client** (`onconnection` set): each MCP connection is handed to
 *   the callback, which connects a fresh MCP `Server` to it; clients get
 *   separate JSON-RPC id spaces and are never evicted. `CodeModeProxy` uses
 *   this mode.
 * - **Single-client** (`onconnection` unset): the listener is the `Transport`
 *   passed to `Server.connect()`; the first MCP connection is served and
 *   further ones are refused while it is open. `mcp-proxy-server`'s
 *   `PROXY_TCP_PORT` mode uses this.
 *
 * Connections are classified by their first bytes: the Docker sidecar's
 * startup gate sends {@link TCP_TRANSPORT_HEALTH_REQUEST}, which is answered
 * locally and never becomes an MCP connection (the socket is closed as soon
 * as the answer is flushed, so a peer that keeps its side open holds neither
 * a connection slot nor `close()`); anything else is MCP traffic. An
 * unclassified connection is bounded by `firstByteTimeoutMs`, and the number
 * of simultaneously open connections by `maxConnections` -- connections Node
 * drops at that cap are reported through `onerror`.
 */

import { createServer, type Server as NetServer, type Socket } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { createServer as createTlsServer, type TlsOptions } from 'node:tls';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  SOCKET_TRANSPORT_DEFAULT_MAX_CONNECTIONS,
  SocketConnectionTransport,
  toTransportError,
} from './socket-connection-transport.js';

export interface TcpServerTransportOptions {
  /** Optional TLS for the sidecar-to-host hop across a shared external bridge. */
  readonly tls?: TlsOptions;
  /** Optional 32-byte, lowercase hexadecimal per-bundle credential. */
  readonly requiredToken?: string;
  /** Per-connection unread-byte cap; defaults to 10 MiB. */
  readonly maxBufferSize?: number;
  /**
   * Connection-source filter. When set, an incoming connection whose
   * `socket.remoteAddress` fails the predicate is destroyed before any
   * data is read. Used when binding 0.0.0.0 for a host-only container
   * network (tcp-hostonly topology) so only the agent VM's subnet can
   * reach the unauthenticated MCP endpoint.
   */
  readonly allowRemoteAddress?: (remoteAddress: string | undefined) => boolean;
  /** Maximum time an unclassified connection may wait to send its first bytes. */
  readonly firstByteTimeoutMs?: number;
  /** Cap on simultaneously open connections; extra ones are dropped on accept. */
  readonly maxConnections?: number;
}

/** Side-effect-free liveness exchange used by the Docker sidecar startup gate. */
export const TCP_TRANSPORT_HEALTH_REQUEST = 'IRONCURTAIN_HEALTH/1\n';
export const TCP_TRANSPORT_HEALTH_RESPONSE = 'IRONCURTAIN_OK/1\n';
export const TCP_TRANSPORT_AUTH_PREFIX = 'IRONCURTAIN_AUTH/1 ';
const TOKEN_PATTERN = /^[a-f0-9]{64}$/u;
const AUTH_FRAME_BYTES = TCP_TRANSPORT_AUTH_PREFIX.length + 64 + 1;

/** Canonical admission preface; the token must never be placed in process arguments. */
export function tcpTransportAuthFrame(token: string): string {
  if (!TOKEN_PATTERN.test(token)) throw new Error('TCP transport token must be 32 bytes of lowercase hexadecimal');
  return `${TCP_TRANSPORT_AUTH_PREFIX}${token}\n`;
}

export class TcpServerTransport implements Transport {
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly allowRemoteAddress?: (remoteAddress: string | undefined) => boolean;
  private readonly firstByteTimeoutMs: number;
  private readonly maxConnections: number;
  private readonly maxBufferSize?: number;
  private readonly requiredToken?: Buffer;
  private readonly tls?: TlsOptions;
  private server: NetServer | null = null;
  /** Single-client mode: the MCP connection currently being served. */
  private active: SocketConnectionTransport | null = null;
  /** Every live MCP connection, so close() can tear them all down. */
  private readonly connections = new Set<SocketConnectionTransport>();
  /**
   * Every accepted socket until it closes, whatever it turned out to be
   * (unclassified, health probe, MCP), so close() never waits on a peer.
   */
  private readonly sockets = new Set<Socket>();
  private _port: number | null = null;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  /**
   * Multi-client mode. Receives each accepted MCP connection as its own
   * transport; the callback typically connects a fresh MCP `Server` to it
   * (which installs the callbacks and calls `start()`). When set, this
   * listener's own `onmessage`/`send` surface is unused.
   */
  onconnection?: (connection: SocketConnectionTransport) => void;

  constructor(host: string, port: number, options?: TcpServerTransportOptions) {
    this.host = host;
    this.requestedPort = port;
    this.allowRemoteAddress = options?.allowRemoteAddress;
    this.firstByteTimeoutMs = options?.firstByteTimeoutMs ?? 5_000;
    this.maxConnections = options?.maxConnections ?? SOCKET_TRANSPORT_DEFAULT_MAX_CONNECTIONS;
    this.maxBufferSize = options?.maxBufferSize;
    this.tls = options?.tls;
    if (options?.requiredToken !== undefined) {
      tcpTransportAuthFrame(options.requiredToken);
      this.requiredToken = Buffer.from(options.requiredToken, 'hex');
    }
  }

  /** The actual port the server is listening on. Only valid after start(). */
  get port(): number {
    if (this._port === null) {
      throw new Error('TcpServerTransport has not been started');
    }
    return this._port;
  }

  /**
   * Starts listening on the TCP port.
   * Resolves once the server is bound and ready for connections.
   * Idempotent: subsequent calls are no-ops (the MCP SDK's
   * server.connect() calls start() internally).
   */
  async start(): Promise<void> {
    if (this.server) return;

    const server =
      this.tls === undefined
        ? createServer((socket) => this.handleConnection(socket))
        : createTlsServer({ ...this.tls, minVersion: 'TLSv1.2', handshakeTimeout: this.firstByteTimeoutMs }, (socket) =>
            this.handleConnection(socket),
          );
    server.maxConnections = this.maxConnections;
    if (this.tls !== undefined) {
      // TLS only calls handleConnection after a successful handshake. Track
      // the underlying TCP sockets too, so pending handshakes share the cap
      // and close() cannot wait for their peer or handshake deadline.
      server.on('connection', (socket: Socket) => {
        if (this.allowRemoteAddress && !this.allowRemoteAddress(socket.remoteAddress)) {
          socket.destroy();
          return;
        }
        this.sockets.add(socket);
        socket.once('close', () => this.sockets.delete(socket));
      });
      server.on('tlsClientError', () => {
        this.onerror?.(new Error('TCP transport TLS handshake failed'));
      });
    }
    // Node closes connections over the cap before 'connection'; say so, or
    // an agent process beyond the cap just sees its connection vanish.
    server.on('drop', () => {
      this.onerror?.(new Error(`Connection refused: ${this.maxConnections} connections already open`));
    });
    this.server = server;

    return new Promise<void>((resolve, reject) => {
      let listening = false;
      server.on('error', (err) => {
        if (listening) {
          this.onerror?.(err);
        } else {
          this.server = null;
          reject(err);
        }
      });
      server.listen(this.requestedPort, this.host, () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          this._port = addr.port;
        }
        listening = true;
        resolve();
      });
    });
  }

  /** Single-client mode: writes to the connection being served. */
  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    const connection = this.active;
    if (!connection || connection.destroyed) {
      throw new Error('No active TCP connection to send message to');
    }
    await connection.send(message, options);
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    // Stop accepting first, so no connection can slip in while the live ones
    // are being torn down; the close callback fires once they have all gone.
    const serverClosed = server
      ? new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
      : Promise.resolve();

    await Promise.all([...this.connections].map((connection) => connection.close()));
    this.connections.clear();
    this.active = null;
    // Whatever is left: unclassified connections, and health probes still
    // flushing their answer. The server's close callback waits on them.
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await serverClosed;

    this.onclose?.();
  }

  private handleConnection(socket: Socket): void {
    // Drop connections from disallowed sources before reading anything.
    if (this.allowRemoteAddress && !this.allowRemoteAddress(socket.remoteAddress)) {
      socket.destroy();
      return;
    }

    const onAcceptError = (err: Error): void => {
      this.onerror?.(err);
    };
    socket.on('error', onAcceptError);
    this.sockets.add(socket);

    // Classify by the first bytes. A health probe is answered locally and
    // never becomes an MCP connection; everything else is MCP traffic. Several
    // connections may be unclassified at once (parallel lanes connect
    // together); each is bounded by the first-byte timeout, and all of them by
    // the connection cap.
    const firstByteTimer = setTimeout(() => socket.destroy(), this.firstByteTimeoutMs);
    firstByteTimer.unref();
    let buffered: Buffer = Buffer.alloc(0);
    let authenticated = this.requiredToken === undefined;
    let credential: Buffer = Buffer.alloc(0);
    const inspectFirstBytes = (chunk: Buffer): void => {
      let data = chunk;
      if (!authenticated) {
        const newline = chunk.indexOf(0x0a);
        const length = newline < 0 ? chunk.length : newline + 1;
        if (credential.length + length > AUTH_FRAME_BYTES) {
          socket.destroy();
          return;
        }
        credential = Buffer.concat([credential, chunk.subarray(0, length)]);
        if (newline < 0) {
          if (credential.length === AUTH_FRAME_BYTES) socket.destroy();
          return;
        }
        const line = credential.toString('utf8');
        const token = line.slice(TCP_TRANSPORT_AUTH_PREFIX.length, -1);
        if (
          credential.length !== AUTH_FRAME_BYTES ||
          !line.startsWith(TCP_TRANSPORT_AUTH_PREFIX) ||
          !TOKEN_PATTERN.test(token) ||
          this.requiredToken === undefined ||
          !timingSafeEqual(Buffer.from(token, 'hex'), this.requiredToken)
        ) {
          socket.destroy();
          return;
        }
        authenticated = true;
        credential = Buffer.alloc(0);
        data = chunk.subarray(length);
        if (data.length === 0) return;
      }
      buffered = buffered.length === 0 ? data : Buffer.concat([buffered, data]);
      const text = buffered.toString('utf8');
      if (TCP_TRANSPORT_HEALTH_REQUEST.startsWith(text) && buffered.length < TCP_TRANSPORT_HEALTH_REQUEST.length) {
        return;
      }
      socket.off('data', inspectFirstBytes);
      clearTimeout(firstByteTimer);
      if (text === TCP_TRANSPORT_HEALTH_REQUEST) {
        // Close as soon as the answer is flushed. Merely ending our side
        // would leave the socket open for as long as the peer keeps its own
        // side open, holding a connection slot and stalling close().
        socket.end(TCP_TRANSPORT_HEALTH_RESPONSE, () => socket.destroy());
        return;
      }

      // Removing the only 'data' listener leaves the stream flowing, which
      // would discard whatever arrives next; hold it until the connection
      // transport starts reading. From here on that transport also owns
      // error reporting.
      socket.pause();
      socket.off('error', onAcceptError);
      this.acceptMcpConnection(socket, buffered);
    };
    socket.on('data', inspectFirstBytes);

    socket.once('close', () => {
      clearTimeout(firstByteTimer);
      this.sockets.delete(socket);
    });
  }

  private acceptMcpConnection(socket: Socket, initialData: Buffer): void {
    if (!this.onconnection && this.active && !this.active.destroyed) {
      // Single-client mode: never evict the client being served.
      socket.destroy();
      return;
    }

    const connection = new SocketConnectionTransport(socket, { initialData, maxBufferSize: this.maxBufferSize });
    this.connections.add(connection);
    socket.once('close', () => {
      this.connections.delete(connection);
      if (this.active === connection) this.active = null;
    });

    if (this.onconnection) {
      try {
        this.onconnection(connection);
      } catch (error) {
        this.onerror?.(toTransportError(error));
        void connection.close();
      }
      return;
    }

    // Single-client mode: bridge the connection to this transport's callbacks.
    // Its onclose is deliberately not bridged -- a client disconnect must not
    // read as the listener closing.
    this.active = connection;
    connection.onmessage = (message) => this.onmessage?.(message);
    connection.onerror = (error) => this.onerror?.(error);
    void connection.start();
  }
}
