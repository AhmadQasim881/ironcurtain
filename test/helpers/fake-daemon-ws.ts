/**
 * A scriptable stand-in for the daemon's web-UI WebSocket JSON-RPC surface,
 * for driving the `ironcurtain workflow run|status|await|gate|show` commands
 * against replies, drops and events that the real daemon cannot be made to
 * produce on demand (a daemon that dies mid-wait, a reply that never comes, a
 * multi-megabyte artifact).
 *
 * It writes a `web-ui.json` discovery file into its own temporary
 * IRONCURTAIN_HOME (`home`), so a command run with that home finds it. The
 * token is not checked.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';

import { wsDataToString } from '../../src/web-ui/ws-utils.js';

export interface FakeDaemonRequest {
  readonly id: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/**
 * What the fake daemon does with a request: answer it with a payload or an
 * RPC error, never answer it, or drop the connection (the daemon "dies").
 */
export type FakeDaemonReply =
  | { readonly payload: unknown }
  | { readonly error: { readonly code: string; readonly message: string } }
  | 'no-reply'
  | 'drop';

export type FakeDaemonHandler = (request: FakeDaemonRequest) => FakeDaemonReply;

export interface FakeDaemon {
  /** IRONCURTAIN_HOME holding this daemon's `web-ui.json`. */
  readonly home: string;
  /** Every request received, in order. */
  readonly requests: readonly FakeDaemonRequest[];
  /** Resolves when the first client connection has closed (for any reason). */
  readonly firstConnectionClosed: Promise<void>;
  /** Resolves once `count` requests have arrived. */
  waitForRequests(count: number): Promise<void>;
  /** Pushes an event frame to every connected client. */
  pushEvent(event: string, payload: unknown): void;
  /** Abruptly drops every client connection, as a crashed daemon would. */
  dropConnections(): void;
  close(): Promise<void>;
}

export async function startFakeDaemon(handler: FakeDaemonHandler): Promise<FakeDaemon> {
  const home = mkdtempSync(join(tmpdir(), 'ic-fake-daemon-'));
  const http: Server = createServer();
  const wss = new WebSocketServer({ server: http, path: '/ws' });
  const sockets = new Set<WebSocket>();
  const requests: FakeDaemonRequest[] = [];
  const requestWaiters: Array<{ count: number; resolve: () => void }> = [];
  let seq = 0;
  let resolveFirstClose: () => void = () => {};
  const firstConnectionClosed = new Promise<void>((resolve) => {
    resolveFirstClose = resolve;
  });

  wss.on('connection', (ws) => {
    sockets.add(ws);
    ws.on('close', () => {
      sockets.delete(ws);
      resolveFirstClose();
    });
    ws.on('error', () => {});
    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      const frame = JSON.parse(wsDataToString(data)) as {
        id: string;
        method: string;
        params?: Record<string, unknown>;
      };
      const request: FakeDaemonRequest = { id: frame.id, method: frame.method, params: frame.params ?? {} };
      requests.push(request);
      for (const waiter of [...requestWaiters]) {
        if (requests.length >= waiter.count) {
          requestWaiters.splice(requestWaiters.indexOf(waiter), 1);
          waiter.resolve();
        }
      }
      const reply = handler(request);
      if (reply === 'no-reply') return;
      if (reply === 'drop') {
        ws.terminate();
        return;
      }
      const response =
        'payload' in reply
          ? { id: request.id, ok: true, payload: reply.payload }
          : { id: request.id, ok: false, error: reply.error };
      ws.send(JSON.stringify(response));
    });
  });

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (address === null || typeof address === 'string') throw new Error('fake daemon has no TCP address');
  writeFileSync(
    join(home, 'web-ui.json'),
    `${JSON.stringify({ port: address.port, host: '127.0.0.1', token: 'fake-daemon-token' })}\n`,
    { mode: 0o600 },
  );

  return {
    home,
    requests,
    firstConnectionClosed,
    waitForRequests(count: number): Promise<void> {
      if (requests.length >= count) return Promise.resolve();
      return new Promise((resolve) => requestWaiters.push({ count, resolve }));
    },
    pushEvent(event: string, payload: unknown): void {
      seq += 1;
      for (const ws of sockets) ws.send(JSON.stringify({ event, payload, seq }));
    },
    dropConnections(): void {
      for (const ws of sockets) ws.terminate();
    },
    async close(): Promise<void> {
      for (const ws of sockets) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** A `workflows.get` payload with the fields the gate commands project. */
export function workflowDetail(
  workflowId: string,
  phase: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { workflowId, phase, currentState: 'produce', round: 1, ...extra };
}
