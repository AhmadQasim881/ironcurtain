/**
 * A fake signal-cli REST API for tests that run the real SignalBotDaemon:
 * a loopback HTTP server (health, send, identities, receive) with the
 * WebSocket receive endpoint, plus a container manager that points the bot
 * at it and a matching ResolvedSignalConfig. Sends can be failed or held,
 * envelopes queued for the reconnect drain and connections dropped, to
 * drive the bot's delivery and replay paths. Nothing leaves 127.0.0.1.
 */

import type http from 'node:http';
import https from 'node:https';
import { WebSocketServer, WebSocket } from 'ws';
import type { SignalContainerManager } from '../../src/signal/signal-container.js';
import type { ResolvedSignalConfig } from '../../src/signal/signal-config.js';
import { createSignalBridgeClient } from '../../src/signal/signal-bridge-client.js';
import { createTlsIdentity, type TlsIdentity } from './fake-parent-proxy.js';

/** A fixture-only bridge credential; it never grants access to a real service. */
export const SIGNAL_TEST_BRIDGE_TOKEN = 'a'.repeat(64);
let tlsIdentity: TlsIdentity | undefined;
export function getSignalTestTlsIdentity(): TlsIdentity {
  return (tlsIdentity ??= createTlsIdentity(['localhost']));
}

/** The user the test bot accepts messages from. */
export const SIGNAL_TEST_RECIPIENT = '+15559876543';

/** The identity key the test config trusts for {@link SIGNAL_TEST_RECIPIENT}. */
export const SIGNAL_TEST_IDENTITY_KEY = 'test-identity-key-abc123';

export interface SentMessage {
  message: string;
  recipients: string[];
  text_mode?: string;
}

export class MockSignalApi {
  private server: https.Server;
  private wss: WebSocketServer;
  readonly sentMessages: SentMessage[] = [];
  /** Sends answered with an error (see failSendsMatching). */
  readonly failedSends: SentMessage[] = [];
  // Assigned by start() after the OS picks an ephemeral port (bind to 0).
  port = 0;
  private identities: Array<Record<string, unknown>> = [];
  private identityEndpointDown = false;
  /** GET /v1/identities requests served so far. */
  identityRequests = 0;
  private lastTimestamp = 0;
  private failSend: ((message: SentMessage) => boolean) | null = null;
  private holdSend: ((message: SentMessage) => boolean) | null = null;
  private held: Array<() => void> = [];
  private drainQueue: unknown[] = [];

  constructor() {
    const identity = getSignalTestTlsIdentity();
    this.server = https.createServer({ cert: identity.certPem, key: identity.keyPem }, (req, res) => {
      this.handleRequest(req, res);
    });

    this.wss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, socket, head) => {
      if (req.headers.authorization !== `Bearer ${SIGNAL_TEST_BRIDGE_TOKEN}`) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
    });
  }

  /** Returns the text of all sent messages (convenience accessor). */
  get messageTexts(): string[] {
    return this.sentMessages.map((m) => m.message);
  }

  setIdentities(identities: Array<Record<string, unknown>>): void {
    this.identities = identities;
  }

  setIdentityEndpointDown(down: boolean): void {
    this.identityEndpointDown = down;
  }

  /**
   * A fresh message timestamp: the current time, but strictly increasing, so
   * two messages sent in the same millisecond are not deduplicated.
   */
  nextTimestamp(): number {
    this.lastTimestamp = Math.max(Date.now(), this.lastTimestamp + 1);
    return this.lastTimestamp;
  }

  /** The envelope signal-cli would deliver for a message from `from` (plus `extra` envelope fields). */
  envelope(
    from: string,
    text: string,
    timestamp?: number,
    serverReceivedTimestamp?: number,
    extra: Record<string, unknown> = {},
  ): unknown {
    return {
      envelope: {
        sourceNumber: from,
        ...extra,
        ...(serverReceivedTimestamp !== undefined ? { serverReceivedTimestamp } : {}),
        dataMessage: { message: text, timestamp: timestamp ?? this.nextTimestamp() },
      },
    };
  }

  simulateIncomingMessage(
    from: string,
    text: string,
    timestamp?: number,
    serverReceivedTimestamp?: number,
    extra?: Record<string, unknown>,
  ): void {
    const envelope = JSON.stringify(this.envelope(from, text, timestamp, serverReceivedTimestamp, extra));
    for (const ws of this.wss.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(envelope);
      }
    }
  }

  /** Answers sends matching the predicate with HTTP 500 (null: none). */
  failSendsMatching(predicate: ((message: SentMessage) => boolean) | null): void {
    this.failSend = predicate;
  }

  /** Holds the response to sends matching the predicate until releaseHeldSends(). */
  holdSendsMatching(predicate: ((message: SentMessage) => boolean) | null): void {
    this.holdSend = predicate;
  }

  get heldSendCount(): number {
    return this.held.length;
  }

  releaseHeldSends(): void {
    const held = this.held;
    this.held = [];
    for (const release of held) release();
  }

  /** Envelopes returned once by GET /v1/receive (the reconnect drain). */
  queueForDrain(...envelopes: unknown[]): void {
    this.drainQueue.push(...envelopes);
  }

  /** Closes every WebSocket connection, as a signal-cli restart would. */
  disconnectClients(): void {
    for (const ws of this.wss.clients) ws.close();
  }

  simulateUntrustedIdentity(from: string, text: string): void {
    const envelope = JSON.stringify({
      envelope: {
        sourceNumber: from,
        untrustedIdentity: true,
        dataMessage: { message: text, timestamp: Date.now() },
      },
    });
    for (const ws of this.wss.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(envelope);
      }
    }
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.on('error', reject);
      // Bind an ephemeral port (0) so parallel/retried runs never collide.
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server.address();
        this.port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.holdSend = null;
    this.releaseHeldSends();
    for (const ws of this.wss.clients) {
      ws.close();
    }
    this.wss.close();
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.headers.authorization !== `Bearer ${SIGNAL_TEST_BRIDGE_TOKEN}`) {
      res.writeHead(401);
      res.end();
      return;
    }
    const url = new URL(req.url ?? '', `http://127.0.0.1:${this.port}`);

    // Health check
    if (url.pathname === '/v1/health' && req.method === 'GET') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Send message
    if (url.pathname === '/v2/send' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += String(chunk)));
      req.on('end', () => {
        const parsed = JSON.parse(body) as SentMessage;
        if (this.failSend?.(parsed)) {
          this.failedSends.push(parsed);
          res.writeHead(500);
          res.end('rate limited');
          return;
        }
        const deliver = (): void => {
          this.sentMessages.push(parsed);
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ timestamp: Date.now() }));
        };
        if (this.holdSend?.(parsed)) this.held.push(deliver);
        else deliver();
      });
      return;
    }

    // Identity check
    if (url.pathname.startsWith('/v1/identities/') && req.method === 'GET') {
      this.identityRequests += 1;
      if (this.identityEndpointDown) {
        res.writeHead(500);
        res.end('Internal Server Error');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.identities));
      return;
    }

    // Receive (for drain)
    if (url.pathname.startsWith('/v1/receive/') && req.method === 'GET') {
      const queued = this.drainQueue;
      this.drainQueue = [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(queued));
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  }
}

/**
 * Polls a predicate every 5ms and resolves as soon as it returns true.
 * Falls back to a timeout to avoid hanging forever.
 *
 * The default is 15s — NOT a time budget for expected behavior, but a
 * safety net against a truly wedged bot. Ubuntu/Node CI runners
 * occasionally stall for hundreds of ms on GC or scheduler contention
 * between `simulateIncomingMessage` and the bot's POST response, and
 * the original 5s default flaked on those runs. Individual vitest
 * `it(...)` tests still have their own 30s timeout, so a real
 * correctness bug (bot never sends the awaited message) still fails
 * loudly within the test runner, not within this poll loop.
 */
export async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Waits until mockApi.sentMessages has at least `count` entries. */
export function waitForMessages(mockApi: MockSignalApi, count: number, timeoutMs = 15_000): Promise<void> {
  return waitFor(() => mockApi.sentMessages.length >= count, timeoutMs);
}

/** Waits until mockApi.messageTexts contains a message matching the predicate. */
export function waitForMessage(
  mockApi: MockSignalApi,
  predicate: (text: string) => boolean,
  timeoutMs = 15_000,
): Promise<void> {
  return waitFor(() => mockApi.messageTexts.some(predicate), timeoutMs);
}

/** A container manager whose "container" is the fake API on `port`. */
export function createMockSignalContainerManager(port: number): SignalContainerManager {
  return {
    async ensureRunning() {
      return createSignalBridgeClient(`https://127.0.0.1:${port}`, SIGNAL_TEST_BRIDGE_TOKEN, {
        ca: getSignalTestTlsIdentity().certPem,
      });
    },
    async waitForHealthy() {},
    async teardown() {},
    async exists() {
      return true;
    },
    async isRunning() {
      return true;
    },
  };
}

/** A Signal config for the fake API on `port`, trusting {@link SIGNAL_TEST_IDENTITY_KEY}. */
export function createTestSignalConfig(port: number, overrides?: Partial<ResolvedSignalConfig>): ResolvedSignalConfig {
  return {
    botNumber: '+15551234567',
    recipientNumber: SIGNAL_TEST_RECIPIENT,
    recipientIdentityKey: SIGNAL_TEST_IDENTITY_KEY,
    container: {
      image: 'test:latest',
      port,
      dataDir: '/tmp/test-signal',
      containerName: 'test-signal',
    },
    maxConcurrentSessions: 3,
    ...overrides,
  };
}
