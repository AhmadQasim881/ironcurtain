/**
 * UDS (Unix Domain Socket) server transport for the MCP SDK.
 *
 * Listens on a Unix domain socket and wraps every accepted connection in its
 * own {@link SocketConnectionTransport}: each client has a private read
 * buffer, a malformed frame is reported through `onerror` without touching
 * the process or any other client, and an oversized frame drops only the
 * socket it arrived on. Nothing a client sends can throw out of a socket
 * event handler. A client that leaves its responses unread is throttled
 * (its connection stops reading) and, past a hard cap, dropped -- that
 * client only.
 *
 * Two modes:
 *
 * - **Multi-client** (`onconnection` set): every accepted connection is
 *   handed to the callback, which connects a fresh MCP `Server` to it.
 *   Clients get separate JSON-RPC id spaces and a newcomer never evicts an
 *   existing client. `CodeModeProxy` runs in this mode because every agent
 *   process in the container (parallel workflow fan-out lanes, a nested CLI,
 *   a stray background process) opens its own connection to the proxy
 *   socket.
 * - **Single-client** (`onconnection` unset): the listener itself is the
 *   `Transport` passed to `Server.connect()`. The first connection is served;
 *   while it is open, further connections are refused (closed on accept) so
 *   a second client can neither take over the agent's connection nor receive
 *   its responses. `mcp-proxy-server`'s `PROXY_SOCKET_PATH` mode uses this.
 *
 * In both modes the number of simultaneously open connections is capped
 * (`maxConnections`, default {@link SOCKET_TRANSPORT_DEFAULT_MAX_CONNECTIONS});
 * connections beyond the cap are dropped on accept and reported through
 * `onerror`.
 */

import { createServer, type Server as NetServer, type Socket } from 'node:net';
import { unlinkSync, existsSync } from 'node:fs';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  SOCKET_TRANSPORT_DEFAULT_MAX_CONNECTIONS,
  SocketConnectionTransport,
  toTransportError,
} from './socket-connection-transport.js';

export interface UdsServerTransportOptions {
  /** Per-connection unread-byte cap; defaults to 10 MiB. */
  readonly maxBufferSize?: number;
  /** Cap on simultaneously open connections; extra ones are dropped on accept. */
  readonly maxConnections?: number;
}

export class UdsServerTransport implements Transport {
  private readonly socketPath: string;
  private readonly maxConnections: number;
  private readonly maxBufferSize?: number;
  private server: NetServer | null = null;
  /** Single-client mode: the connection currently being served. */
  private active: SocketConnectionTransport | null = null;
  /** Every live connection, so close() can tear them all down. */
  private readonly connections = new Set<SocketConnectionTransport>();

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  /**
   * Multi-client mode. Receives each accepted connection as its own
   * transport; the callback typically connects a fresh MCP `Server` to it
   * (which installs the callbacks and calls `start()`). When set, this
   * listener's own `onmessage`/`send` surface is unused.
   */
  onconnection?: (connection: SocketConnectionTransport) => void;

  constructor(socketPath: string, options?: UdsServerTransportOptions) {
    this.socketPath = socketPath;
    this.maxConnections = options?.maxConnections ?? SOCKET_TRANSPORT_DEFAULT_MAX_CONNECTIONS;
    this.maxBufferSize = options?.maxBufferSize;
  }

  /**
   * Starts listening on the Unix domain socket.
   * Resolves once the server is bound and ready for connections.
   * Idempotent: the MCP SDK's `Server.connect()` calls `start()` itself.
   */
  async start(): Promise<void> {
    if (this.server) return;

    // Clean up stale socket file from a previous run
    if (existsSync(this.socketPath)) {
      unlinkSync(this.socketPath);
    }

    const server = createServer((socket) => this.handleConnection(socket));
    server.maxConnections = this.maxConnections;
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
      server.listen(this.socketPath, () => {
        listening = true;
        resolve();
      });
    });
  }

  /** Single-client mode: writes to the connection being served. */
  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    const connection = this.active;
    if (!connection || connection.destroyed) {
      throw new Error('No active UDS connection to send message to');
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
    await serverClosed;

    // Clean up the socket file
    if (existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath);
      } catch {
        /* ignore cleanup errors */
      }
    }

    this.onclose?.();
  }

  private handleConnection(socket: Socket): void {
    const onAcceptError = (err: Error): void => {
      this.onerror?.(err);
    };
    socket.on('error', onAcceptError);

    if (!this.onconnection && this.active && !this.active.destroyed) {
      // Single-client mode: never evict the client being served.
      socket.destroy();
      return;
    }

    // From here on the connection transport owns error reporting.
    socket.off('error', onAcceptError);
    const connection = new SocketConnectionTransport(socket, { maxBufferSize: this.maxBufferSize });
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
