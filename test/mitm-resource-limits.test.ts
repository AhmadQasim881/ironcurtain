/**
 * Unit tests for the MITM proxy's resource bounds (mitm-resource-limits.ts):
 * limit resolution, the buffered-body budget, the bounded body reader and its
 * drain, upstream deadlines, and the decrypted-connection deadlines.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import * as net from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import {
  armUpstreamDeadlines,
  BufferedBodyBudget,
  createSerialRunner,
  DecryptedConnectionMonitor,
  DEFAULT_MITM_RESOURCE_LIMITS,
  describeByteSize,
  isUpstreamTimeoutError,
  readRequestBody,
  refusalResponseBody,
  resolveMitmResourceLimits,
  type DecryptedConnectionExpiry,
  type RequestBodyRead,
  type RequestBodyReadOptions,
} from '../src/docker/mitm-resource-limits.js';

const servers: (http.Server | net.Server)[] = [];
const clients: net.Socket[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  for (const server of servers.splice(0)) {
    if (server instanceof http.Server) server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function listen(server: http.Server | net.Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('resolveMitmResourceLimits', () => {
  it('returns the defaults with overrides applied', () => {
    expect(resolveMitmResourceLimits()).toEqual(DEFAULT_MITM_RESOURCE_LIMITS);
    expect(resolveMitmResourceLimits({ maxConcurrentRequests: 3 })).toEqual({
      ...DEFAULT_MITM_RESOURCE_LIMITS,
      maxConcurrentRequests: 3,
    });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects %s as a limit', (value) => {
    expect(() => resolveMitmResourceLimits({ maxBufferedBodyBytes: value })).toThrow(
      /maxBufferedBodyBytes must be a positive integer/,
    );
  });
});

describe('BufferedBodyBudget', () => {
  it('shares one ceiling across accounts and returns a released account’s bytes', () => {
    const budget = new BufferedBodyBudget(100);
    const first = budget.openAccount();
    const second = budget.openAccount();
    expect(first.charge(60)).toBe(true);
    expect(second.charge(50)).toBe(false);
    expect(second.charge(40)).toBe(true);
    expect(budget.usedBytes).toBe(100);
    first.release();
    expect(budget.usedBytes).toBe(40);
    expect(second.charge(50)).toBe(true);
    expect(budget.usedBytes).toBe(90);
  });

  it('releases once and refuses charges on a closed account', () => {
    const budget = new BufferedBodyBudget(100);
    const account = budget.openAccount();
    account.charge(30);
    account.release();
    account.release();
    expect(budget.usedBytes).toBe(0);
    expect(account.charge(1)).toBe(false);
    expect(account.chargedBytes).toBe(0);
  });
});

describe('createSerialRunner', () => {
  it('runs tasks one at a time in submission order, and a rejection does not stop later tasks', async () => {
    const run = createSerialRunner();
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;
    const task =
      (name: string, ms: number, fail = false) =>
      async (): Promise<string> => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        events.push(`start ${name}`);
        await sleep(ms);
        events.push(`end ${name}`);
        active -= 1;
        if (fail) throw new Error(`${name} failed`);
        return name;
      };
    const outcomes = await Promise.allSettled([
      run(task('a', 30)),
      run(task('b', 5, true)),
      run(task('c', 10)),
      run(() => {
        throw new Error('d threw synchronously');
      }),
      run(task('e', 1)),
    ]);
    expect(maxActive).toBe(1);
    expect(events).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c', 'start e', 'end e']);
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      'fulfilled',
      'rejected',
      'fulfilled',
      'rejected',
      'fulfilled',
    ]);
    expect(outcomes[0]).toEqual({ status: 'fulfilled', value: 'a' });
  });
});

describe('readRequestBody', () => {
  /** A server that reads each request body with `options` and reports the outcome. */
  async function serverReading(
    options: (budget: BufferedBodyBudget) => Omit<RequestBodyReadOptions, 'account'>,
    budget = new BufferedBodyBudget(1024 * 1024),
  ): Promise<{ port: number; outcomes: Promise<RequestBodyRead>[]; budget: BufferedBodyBudget }> {
    const outcomes: Promise<RequestBodyRead>[] = [];
    const server = http.createServer((req, res) => {
      const account = budget.openAccount();
      const outcome = readRequestBody(req, { ...options(budget), account });
      outcomes.push(outcome);
      void outcome.then(async (read) => {
        if (read.kind === 'too-large' || read.kind === 'over-budget') await read.drained;
        res.writeHead(200, { connection: 'close', 'content-length': '2' });
        res.end('ok');
      });
    });
    return { port: await listen(server), outcomes, budget };
  }

  function rawClient(port: number): Promise<net.Socket> {
    return new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1', () => resolve(socket));
      socket.on('error', () => {});
      clients.push(socket);
    });
  }

  const defaults = {
    maxBytes: 1000,
    idleTimeoutMs: 5_000,
    totalTimeoutMs: 10_000,
    drain: { maxBytes: 64 * 1024, timeoutMs: 5_000 },
  };

  async function settled(outcomes: Promise<RequestBodyRead>[]): Promise<RequestBodyRead> {
    for (let i = 0; i < 200 && outcomes.length === 0; i++) await sleep(5);
    return outcomes[0];
  }

  it('returns a complete body and keeps it charged to the account', async () => {
    const { port, outcomes, budget } = await serverReading(() => defaults);
    const client = await rawClient(port);
    client.write('POST / HTTP/1.1\r\nhost: x\r\ncontent-length: 5\r\n\r\nhello');
    const read = await settled(outcomes);
    expect(read.kind).toBe('complete');
    expect(read.kind === 'complete' && read.body.toString()).toBe('hello');
    expect(budget.usedBytes).toBe(5);
  });

  it('refuses a declared Content-Length over the limit before buffering, then drains the upload', async () => {
    const { port, outcomes, budget } = await serverReading(() => defaults);
    const client = await rawClient(port);
    client.write('POST / HTTP/1.1\r\nhost: x\r\ncontent-length: 3000\r\n\r\n');
    const read = await settled(outcomes);
    expect(read).toMatchObject({ kind: 'too-large', declaredBytes: 3000 });
    expect(budget.usedBytes).toBe(0);
    let drained = false;
    if (read.kind === 'too-large') void read.drained.then(() => (drained = true));
    client.write(Buffer.alloc(1500));
    await sleep(50);
    expect(drained).toBe(false);
    client.write(Buffer.alloc(1500));
    await sleep(50);
    expect(drained).toBe(true);
  });

  it('refuses a chunked body once it passes the limit and returns its bytes to the budget', async () => {
    const { port, outcomes, budget } = await serverReading(() => defaults);
    const client = await rawClient(port);
    client.write('POST / HTTP/1.1\r\nhost: x\r\ntransfer-encoding: chunked\r\n\r\n');
    client.write(`258\r\n${'a'.repeat(600)}\r\n`);
    await sleep(50);
    expect(budget.usedBytes).toBe(600);
    client.write(`258\r\n${'b'.repeat(600)}\r\n0\r\n\r\n`);
    const read = await settled(outcomes);
    expect(read.kind).toBe('too-large');
    expect(budget.usedBytes).toBe(0);
  });

  it('refuses a body the shared budget cannot hold', async () => {
    const budget = new BufferedBodyBudget(100);
    const other = budget.openAccount();
    other.charge(90);
    const { port, outcomes } = await serverReading(() => defaults, budget);
    const client = await rawClient(port);
    client.write(`POST / HTTP/1.1\r\nhost: x\r\ncontent-length: 50\r\n\r\n${'c'.repeat(50)}`);
    const read = await settled(outcomes);
    expect(read.kind).toBe('over-budget');
    expect(budget.usedBytes).toBe(90);
  });

  it('times out a body that stops arriving', async () => {
    const { port, outcomes, budget } = await serverReading(() => ({ ...defaults, idleTimeoutMs: 100 }));
    const client = await rawClient(port);
    client.write('POST / HTTP/1.1\r\nhost: x\r\ncontent-length: 100\r\n\r\nabc');
    const read = await settled(outcomes);
    expect(read.kind).toBe('timeout');
    expect(budget.usedBytes).toBe(0);
  });

  it('times out a body that trickles past the total deadline', async () => {
    const { port, outcomes } = await serverReading(() => ({ ...defaults, idleTimeoutMs: 1_000, totalTimeoutMs: 200 }));
    const client = await rawClient(port);
    client.write('POST / HTTP/1.1\r\nhost: x\r\ncontent-length: 100\r\n\r\n');
    const trickle = setInterval(() => client.write('z'), 30);
    try {
      expect((await settled(outcomes)).kind).toBe('timeout');
    } finally {
      clearInterval(trickle);
    }
  });

  it('reports a client that disconnects mid-body', async () => {
    const { port, outcomes, budget } = await serverReading(() => defaults);
    const client = await rawClient(port);
    client.write('POST / HTTP/1.1\r\nhost: x\r\ncontent-length: 100\r\n\r\nabc');
    await sleep(30);
    client.destroy();
    const read = await settled(outcomes);
    expect(read.kind).toBe('failed');
    expect(budget.usedBytes).toBe(0);
  });
});

describe('refusal responses', () => {
  it('uses the error shape both SDKs surface and names sizes readably', () => {
    expect(
      JSON.parse(refusalResponseBody({ status: 413, errorType: 'request_too_large', message: 'too big' })),
    ).toEqual({
      type: 'error',
      error: { type: 'request_too_large', message: 'IronCurtain proxy refused this request: too big' },
    });
    expect(describeByteSize(32 * 1024 * 1024)).toBe('32 MiB');
    expect(describeByteSize(1536)).toBe('1536 bytes');
  });
});

describe('armUpstreamDeadlines', () => {
  function requestTo(
    port: number,
    limits: { upstreamResponseHeadersTimeoutMs: number; upstreamIdleTimeoutMs: number },
  ) {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/', agent: false });
    armUpstreamDeadlines(req, limits);
    return req;
  }

  it('aborts an upstream that never starts its response', async () => {
    const port = await listen(http.createServer((req) => req.resume()));
    const req = requestTo(port, { upstreamResponseHeadersTimeoutMs: 100, upstreamIdleTimeoutMs: 60_000 });
    const error = await new Promise<Error>((resolve) => req.on('error', resolve).end('{}'));
    expect(isUpstreamTimeoutError(error)).toBe(true);
    expect(error.message).toContain('no response within 100 ms');
  });

  it('aborts an upstream response that stalls, but not one that keeps streaming', async () => {
    const port = await listen(
      http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: ping\n\n');
        if (req.url === '/live') {
          const ticker = setInterval(() => res.write('event: ping\n\n'), 50);
          res.on('close', () => clearInterval(ticker));
          setTimeout(() => res.end(), 400);
        }
      }),
    );
    const limits = { upstreamResponseHeadersTimeoutMs: 60_000, upstreamIdleTimeoutMs: 150 };
    const stalled = requestTo(port, limits);
    const stalledError = new Promise<Error>((resolve) => stalled.on('error', resolve));
    stalled.on('response', (res) => {
      res.on('error', () => {});
      res.resume();
    });
    stalled.end('{}');
    expect(isUpstreamTimeoutError(await stalledError)).toBe(true);

    const live = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/live', agent: false });
    armUpstreamDeadlines(live, limits);
    const completed = await new Promise<boolean>((resolve) => {
      live.on('error', () => resolve(false));
      live.on('response', (res) => {
        res.on('error', () => resolve(false));
        res.on('end', () => resolve(true));
        res.resume();
      });
      live.end('{}');
    });
    expect(completed).toBe(true);
  });
});

describe('DecryptedConnectionMonitor', () => {
  class FakeSocket extends EventEmitter {
    bytesRead = 0;
    bytesWritten = 0;
    destroyed = false;
    destroy(): void {
      this.destroyed = true;
      this.emit('close');
    }
  }

  function setup(limits = { requestHeadersTimeoutMs: 1_000, connectionIdleTimeoutMs: 5_000 }) {
    let now = 0;
    const expired: { socket: FakeSocket; reason: DecryptedConnectionExpiry }[] = [];
    const monitor = new DecryptedConnectionMonitor(
      limits,
      (socket, reason) => {
        expired.push({ socket, reason });
        socket.destroy();
      },
      () => now,
    );
    const socket = new FakeSocket();
    monitor.track(socket as unknown as Socket);
    return {
      monitor,
      socket,
      expired,
      advance(ms: number) {
        now += ms;
        monitor.sweep();
      },
    };
  }

  it('closes a connection that completes no request head in time, even while bytes trickle in', () => {
    const { socket, expired, advance } = setup();
    advance(600);
    socket.bytesRead += 1;
    advance(300);
    expect(expired).toEqual([]);
    socket.bytesRead += 1;
    advance(200);
    expect(expired).toEqual([{ socket, reason: 'request-head' }]);
  });

  it('suspends the head deadline while a request is in flight and restarts it afterwards', () => {
    const { monitor, socket, expired, advance } = setup();
    advance(900);
    monitor.requestStarted(socket as unknown as Socket);
    socket.bytesWritten += 10;
    advance(2_000);
    expect(expired).toEqual([]);
    monitor.requestFinished(socket as unknown as Socket);
    advance(900);
    expect(expired).toEqual([]);
    advance(200);
    expect(expired).toEqual([{ socket, reason: 'request-head' }]);
  });

  it('closes a connection with no traffic either way, request or not', () => {
    const { monitor, socket, expired, advance } = setup();
    monitor.requestStarted(socket as unknown as Socket);
    advance(3_000);
    // Traffic observed by the sweep at t=6000 restarts the idle clock.
    socket.bytesWritten += 1;
    advance(3_000);
    advance(4_900);
    expect(expired).toEqual([]);
    advance(200);
    expect(expired).toEqual([{ socket, reason: 'idle' }]);
  });

  it('forgets a connection once it closes', () => {
    const { monitor, socket, expired, advance } = setup();
    expect(monitor.size).toBe(1);
    socket.destroy();
    expect(monitor.size).toBe(0);
    advance(10_000);
    expect(expired).toEqual([]);
  });

  it('stops applying the HTTP deadlines to an open connection once it is untracked', () => {
    // An upgraded connection (a WebSocket bridged inside a port-80 tunnel)
    // sends no further request head; its bridge bounds it instead.
    const { monitor, socket, expired, advance } = setup();
    advance(500);
    monitor.untrack(socket as unknown as Socket);
    expect(monitor.size).toBe(0);
    advance(10_000);
    expect(expired).toEqual([]);
    expect(socket.destroyed).toBe(false);
  });
});
