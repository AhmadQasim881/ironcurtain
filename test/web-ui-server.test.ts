/**
 * Tests for WebUiServer -- focused on security-relevant behavior:
 * token verification, origin validation, path containment for static
 * files, and WebSocket message handling.
 *
 * Uses a real HTTP server with OS-assigned ports (port 0).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { WebUiServer, viteDevOrigins, type WebUiServerOptions } from '../src/web-ui/web-ui-server.js';
import { SessionManager } from '../src/session/session-manager.js';
import type { ControlRequestHandler } from '../src/daemon/control-socket.js';
import type { LlmStatisticsReader } from '../src/llm-metrics/query-service.js';
import type { Session, SessionInfo } from '../src/session/types.js';
import WebSocket from 'ws';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeMockHandler(): ControlRequestHandler {
  return {
    getStatus: vi.fn().mockReturnValue({
      uptimeSeconds: 100,
      jobs: { total: 0, enabled: 0, running: 0 },
      signalConnected: false,
      nextFireTime: undefined,
    }),
    removeJob: vi.fn().mockResolvedValue(undefined),
    enableJob: vi.fn().mockResolvedValue(undefined),
    disableJob: vi.fn().mockResolvedValue(undefined),
    recompileJob: vi.fn().mockResolvedValue(undefined),
    refreshLists: vi.fn(),
    reloadJob: vi.fn().mockResolvedValue(undefined),
    startJobRun: vi.fn(),
    runJobNow: vi.fn().mockResolvedValue({}),
    listJobs: vi.fn().mockReturnValue([]),
  };
}

let server: WebUiServer | null = null;
const openSockets: WebSocket[] = [];

function createServer(overrides: Partial<WebUiServerOptions> = {}): WebUiServer {
  const opts: WebUiServerOptions = {
    port: 0, // OS assigns a free port
    host: '127.0.0.1',
    handler: makeMockHandler(),
    sessionManager: new SessionManager(),
    mode: { kind: 'builtin' },
    maxConcurrentWebSessions: 3,
    ...overrides,
  };
  server = new WebUiServer(opts);
  return server;
}

/** Extracts the auth token from the URL returned by start(). */
function extractToken(url: string): string {
  return new URL(url).searchParams.get('token')!;
}

/** Extracts the port from the URL returned by start(). */
function extractPort(url: string): number {
  return parseInt(new URL(url).port, 10);
}

/** Create a WebSocket and track it for cleanup. */
function createWs(url: string): WebSocket {
  const ws = new WebSocket(url);
  openSockets.push(ws);
  return ws;
}

/** Wait for a WebSocket to fully close. */
function waitForClose(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => ws.on('close', resolve));
}

/**
 * Attempt a WebSocket handshake with extra request headers. Resolves with
 * 'open' when the upgrade succeeds, or with the HTTP status the server
 * answered instead (403, 421, ...).
 */
function handshake(url: string, headers: Record<string, string>): Promise<'open' | number> {
  const ws = new WebSocket(url, { headers });
  openSockets.push(ws);
  return new Promise((resolve) => {
    ws.on('open', () => resolve('open'));
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? -1));
    ws.on('error', () => resolve(-1));
  });
}

/** Plain HTTP GET with an explicit Host header; resolves with the status code. */
async function httpGetWithHost(port: number, hostHeader: string, path = '/'): Promise<number> {
  const http = await import('node:http');
  return new Promise<number>((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'GET', headers: { Host: hostHeader } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? -1);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Send a raw HTTP request (e.g. one without a Host header); resolves with the status code. */
async function rawHttpStatus(port: number, request: string): Promise<number> {
  const net = await import('node:net');
  return new Promise<number>((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(request));
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      data += chunk;
    });
    socket.on('error', reject);
    socket.on('close', () => {
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(data);
      resolve(match ? Number(match[1]) : -1);
    });
  });
}

afterEach(async () => {
  // Close all tracked sockets first
  const closePromises = openSockets
    .filter((ws) => ws.readyState !== WebSocket.CLOSED)
    .map((ws) => {
      ws.close();
      return waitForClose(ws);
    });
  await Promise.all(closePromises);
  openSockets.length = 0;

  if (server) {
    await server.stop();
    server = null;
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('viteDevOrigins', () => {
  it('follows IRONCURTAIN_WEB_UI_PORT like vite.config.ts and falls back to 5173', () => {
    expect(viteDevOrigins(undefined)).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173']);
    expect(viteDevOrigins('4000')).toEqual(['http://localhost:4000', 'http://127.0.0.1:4000']);
    expect(viteDevOrigins('not-a-port')).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173']);
    expect(viteDevOrigins('70000')).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173']);
    // Same parse as packages/web-ui/scripts/parse-port.ts: the whole value must be a port.
    expect(viteDevOrigins('4000abc')).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173']);
    expect(viteDevOrigins('')).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173']);
  });
});

describe('WebUiServer', () => {
  describe('start and stop', () => {
    it('returns a URL with token on start', async () => {
      const srv = createServer();
      const url = await srv.start();

      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\?token=.+/);
      const token = extractToken(url);
      expect(token.length).toBeGreaterThan(20);
    });

    it('stop is idempotent', async () => {
      const srv = createServer();
      await srv.start();
      await srv.stop();
      await srv.stop(); // second call should not throw
      server = null; // already stopped
    });
  });

  describe('static file serving', () => {
    it('rejects path traversal with encoded ..', async () => {
      const srv = createServer();
      const url = await srv.start();
      const port = extractPort(url);

      const http = await import('node:http');
      const status = await new Promise<number>((resolve) => {
        const req = http.request({ hostname: '127.0.0.1', port, path: '/..%2F..%2Fetc/passwd', method: 'GET' }, (res) =>
          resolve(res.statusCode!),
        );
        req.end();
      });
      expect(status).toBe(403);
    });

    it('sets security headers on responses', async () => {
      const srv = createServer();
      const url = await srv.start();
      const port = extractPort(url);

      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin');
      const csp = res.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("form-action 'none'");
      expect(csp).toContain("base-uri 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("object-src 'none'");
    });
  });

  describe('Host validation (DNS rebinding)', () => {
    it('rejects HTTP requests whose Host is not a loopback authority at the listening port', async () => {
      const srv = createServer();
      const port = extractPort(await srv.start());

      expect(await httpGetWithHost(port, `evil.example:${port}`)).toBe(421);
      expect(await httpGetWithHost(port, '127.0.0.1:1')).toBe(421);
      expect(await httpGetWithHost(port, `evil.example:${port}`, '/ws/auth?token=x')).toBe(421);
    });

    it('accepts localhost and loopback Hosts at the listening port', async () => {
      const srv = createServer();
      const port = extractPort(await srv.start());

      expect(await httpGetWithHost(port, `localhost:${port}`)).not.toBe(421);
      expect(await httpGetWithHost(port, `127.0.0.1:${port}`)).not.toBe(421);
      expect(await httpGetWithHost(port, `LOCALHOST:${port}`)).not.toBe(421);
    });

    it('rejects a WebSocket upgrade with a foreign Host even when the token is valid', async () => {
      const srv = createServer();
      const url = await srv.start();
      const port = extractPort(url);
      const token = extractToken(url);

      expect(await handshake(`ws://127.0.0.1:${port}/ws?token=${token}`, { Host: `evil.example:${port}` })).toBe(421);
    });

    it('rejects a request without a Host header and malformed Hosts', async () => {
      const srv = createServer();
      const port = extractPort(await srv.start());

      expect(await rawHttpStatus(port, 'GET / HTTP/1.0\r\n\r\n')).toBe(421);
      expect(await httpGetWithHost(port, `localhost:${port}@evil.example`)).toBe(421);
      expect(await httpGetWithHost(port, `localhost.:${port}`)).toBe(421);
      expect(await httpGetWithHost(port, `127.0.0.1.evil.example:${port}`)).toBe(421);
      expect(await httpGetWithHost(port, `[::1]:${port}`)).not.toBe(421);
    });

    it('still validates Host in dev mode', async () => {
      const srv = createServer({ devMode: true });
      const url = await srv.start();
      const port = extractPort(url);
      const token = extractToken(url);

      expect(await httpGetWithHost(port, `evil.example:${port}`)).toBe(421);
      expect(await httpGetWithHost(port, 'localhost:5173')).toBe(421);
      expect(
        await handshake(`ws://127.0.0.1:${port}/ws?token=${token}`, {
          Host: `evil.example:${port}`,
          Origin: 'http://localhost:5173',
        }),
      ).toBe(421);
    });
  });

  describe('/ws/auth preflight', () => {
    it('answers 200 with no-store for the right token and 401 otherwise; other methods get 404', async () => {
      const srv = createServer();
      const url = await srv.start();
      const port = extractPort(url);
      const token = extractToken(url);

      const ok = await fetch(`http://127.0.0.1:${port}/ws/auth?token=${token}`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get('cache-control')).toBe('no-store');

      const bad = await fetch(`http://127.0.0.1:${port}/ws/auth?token=nope`);
      expect(bad.status).toBe(401);
      expect(bad.headers.get('cache-control')).toBe('no-store');

      const post = await fetch(`http://127.0.0.1:${port}/ws/auth?token=${token}`, { method: 'POST' });
      expect(post.status).toBe(404);
    });
  });

  describe('WebSocket Origin validation', () => {
    it('rejects a foreign Origin with 403 even when the token is valid', async () => {
      const srv = createServer();
      const url = await srv.start();
      const port = extractPort(url);
      const token = extractToken(url);

      const wsUrl = `ws://127.0.0.1:${port}/ws?token=${token}`;
      expect(await handshake(wsUrl, { Origin: 'http://evil.example' })).toBe(403);
      expect(await handshake(wsUrl, { Origin: `http://evil.example:${port}` })).toBe(403);
      expect(await handshake(wsUrl, { Origin: 'null' })).toBe(403);
      // Same host, wrong port: a different origin.
      expect(await handshake(wsUrl, { Origin: 'http://127.0.0.1:1' })).toBe(403);
    });

    it('accepts a missing Origin (non-browser CLI client)', async () => {
      const srv = createServer();
      const url = await srv.start();
      const port = extractPort(url);
      const token = extractToken(url);

      expect(await handshake(`ws://127.0.0.1:${port}/ws?token=${token}`, {})).toBe('open');
    });

    it('counts only clients whose handshake carried an Origin as browsers (hasBrowserClient)', async () => {
      const srv = createServer();
      const url = await srv.start();
      const port = extractPort(url);
      const token = extractToken(url);
      const wsUrl = `ws://127.0.0.1:${port}/ws?token=${token}`;
      expect(srv.hasBrowserClient()).toBe(false);

      // The CLI clients (observe, workflow await) send no Origin.
      expect(await handshake(wsUrl, {})).toBe('open');
      expect(srv.hasBrowserClient()).toBe(false);

      const browser = new WebSocket(wsUrl, { headers: { Origin: `http://127.0.0.1:${port}` } });
      openSockets.push(browser);
      await new Promise<void>((resolve) => browser.on('open', () => resolve()));
      expect(srv.hasBrowserClient()).toBe(true);

      browser.close();
      await waitForClose(browser);
      const deadline = Date.now() + 5_000;
      while (srv.hasBrowserClient() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      expect(srv.hasBrowserClient()).toBe(false);
    });

    it('accepts the same-origin browser Origin at the actually bound port', async () => {
      const srv = createServer();
      const url = await srv.start();
      const port = extractPort(url);
      const token = extractToken(url);
      const wsUrl = `ws://127.0.0.1:${port}/ws?token=${token}`;

      expect(await handshake(wsUrl, { Origin: `http://127.0.0.1:${port}` })).toBe('open');
      expect(await handshake(wsUrl, { Origin: `http://localhost:${port}` })).toBe('open');
    });

    it('in dev mode accepts the Vite origin and still rejects foreign origins', async () => {
      const srv = createServer({ devMode: true });
      const url = await srv.start();
      const port = extractPort(url);
      const token = extractToken(url);
      const wsUrl = `ws://127.0.0.1:${port}/ws?token=${token}`;

      expect(await handshake(wsUrl, { Origin: 'http://localhost:5173' })).toBe('open');
      expect(await handshake(wsUrl, { Origin: 'http://127.0.0.1:5173' })).toBe('open');
      expect(await handshake(wsUrl, { Origin: 'http://evil.example' })).toBe(403);
      expect(await handshake(wsUrl, { Origin: 'http://localhost:5174' })).toBe(403);
    });

    it('in dev mode honours a configured Vite origin list', async () => {
      const srv = createServer({ devMode: true, devOrigins: ['http://localhost:4000'] });
      const url = await srv.start();
      const port = extractPort(url);
      const token = extractToken(url);
      const wsUrl = `ws://127.0.0.1:${port}/ws?token=${token}`;

      expect(await handshake(wsUrl, { Origin: 'http://localhost:4000' })).toBe('open');
      expect(await handshake(wsUrl, { Origin: 'http://localhost:5173' })).toBe(403);
    });

    it('checks the token before the Origin', async () => {
      const srv = createServer();
      const url = await srv.start();
      const port = extractPort(url);

      expect(await handshake(`ws://127.0.0.1:${port}/ws?token=wrong`, { Origin: 'http://evil.example' })).toBe(401);
    });
  });

  describe('WebSocket authentication', () => {
    it('rejects connections without token', async () => {
      const srv = createServer();
      const url = await srv.start();
      const port = extractPort(url);

      const ws = createWs(`ws://127.0.0.1:${port}/ws`);
      const error = await new Promise<Error>((resolve) => {
        ws.on('error', resolve);
      });
      expect(error).toBeDefined();
    });

    it('rejects connections with wrong token', async () => {
      const srv = createServer();
      const url = await srv.start();
      const port = extractPort(url);

      const ws = createWs(`ws://127.0.0.1:${port}/ws?token=wrong-token`);
      const error = await new Promise<Error>((resolve) => {
        ws.on('error', resolve);
      });
      expect(error).toBeDefined();
    });

    it('accepts connections with correct token', async () => {
      const srv = createServer();
      const url = await srv.start();
      const port = extractPort(url);
      const token = extractToken(url);

      const ws = createWs(`ws://127.0.0.1:${port}/ws?token=${token}`);
      await new Promise<void>((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
      });
    });

    it('rejects connections to non-/ws paths', async () => {
      const srv = createServer();
      const url = await srv.start();
      const port = extractPort(url);
      const token = extractToken(url);

      const ws = createWs(`ws://127.0.0.1:${port}/other?token=${token}`);
      const error = await new Promise<Error>((resolve) => {
        ws.on('error', resolve);
      });
      expect(error).toBeDefined();
    });
  });

  describe('WebSocket JSON-RPC', () => {
    it('handles valid status request', async () => {
      const srv = createServer();
      const url = await srv.start();
      const port = extractPort(url);
      const token = extractToken(url);

      const ws = createWs(`ws://127.0.0.1:${port}/ws?token=${token}`);
      await new Promise<void>((resolve) => ws.on('open', resolve));

      const responsePromise = new Promise<string>((resolve) => {
        ws.on('message', (data: Buffer) => resolve(data.toString()));
      });

      ws.send(JSON.stringify({ id: 'req-1', method: 'status' }));
      const raw = await responsePromise;
      const response = JSON.parse(raw);

      expect(response.id).toBe('req-1');
      expect(response.ok).toBe(true);
      expect(response.payload).toMatchObject({ webUiListening: true });
    });

    it('returns error for invalid JSON', async () => {
      const srv = createServer();
      const url = await srv.start();
      const port = extractPort(url);
      const token = extractToken(url);

      const ws = createWs(`ws://127.0.0.1:${port}/ws?token=${token}`);
      await new Promise<void>((resolve) => ws.on('open', resolve));

      const responsePromise = new Promise<string>((resolve) => {
        ws.on('message', (data: Buffer) => resolve(data.toString()));
      });

      ws.send('not valid json');
      const raw = await responsePromise;
      const response = JSON.parse(raw);

      expect(response.ok).toBe(false);
      expect(response.error.code).toBe('INVALID_PARAMS');
    });

    it('returns error for missing id/method fields', async () => {
      const srv = createServer();
      const url = await srv.start();
      const port = extractPort(url);
      const token = extractToken(url);

      const ws = createWs(`ws://127.0.0.1:${port}/ws?token=${token}`);
      await new Promise<void>((resolve) => ws.on('open', resolve));

      const responsePromise = new Promise<string>((resolve) => {
        ws.on('message', (data: Buffer) => resolve(data.toString()));
      });

      ws.send(JSON.stringify({ foo: 'bar' }));
      const raw = await responsePromise;
      const response = JSON.parse(raw);

      expect(response.ok).toBe(false);
      expect(response.error.code).toBe('INVALID_PARAMS');
    });

    it('returns METHOD_NOT_FOUND for unknown methods', async () => {
      const srv = createServer();
      const url = await srv.start();
      const port = extractPort(url);
      const token = extractToken(url);

      const ws = createWs(`ws://127.0.0.1:${port}/ws?token=${token}`);
      await new Promise<void>((resolve) => ws.on('open', resolve));

      const responsePromise = new Promise<string>((resolve) => {
        ws.on('message', (data: Buffer) => resolve(data.toString()));
      });

      ws.send(JSON.stringify({ id: 'req-2', method: 'nonexistent' }));
      const raw = await responsePromise;
      const response = JSON.parse(raw);

      expect(response.id).toBe('req-2');
      expect(response.ok).toBe(false);
      expect(response.error.code).toBe('METHOD_NOT_FOUND');
    });

    it('bounds concurrent statistics requests per client', async () => {
      let releaseSummaries: (() => void) | undefined;
      const summariesReleased = new Promise<void>((resolve) => {
        releaseSummaries = resolve;
      });
      const statisticsReader = {
        capabilities: vi.fn().mockResolvedValue({ available: true }),
        summarize: vi.fn(async () => {
          await summariesReleased;
          return [];
        }),
        timeSeries: vi.fn().mockResolvedValue([]),
        listExchanges: vi.fn().mockResolvedValue({ items: [], nextCursor: null, snapshotMaxSequence: 0 }),
        dimensions: vi.fn().mockResolvedValue([]),
        sessionTotals: vi.fn().mockResolvedValue({}),
      } as unknown as LlmStatisticsReader;
      const srv = createServer({ statisticsReader });
      const url = await srv.start();
      const ws = createWs(`ws://127.0.0.1:${extractPort(url)}/ws?token=${extractToken(url)}`);
      await new Promise<void>((resolve) => ws.on('open', resolve));

      const responses: Array<{ id: string; ok: boolean; error?: { code: string } }> = [];
      ws.on('message', (data: Buffer) => {
        const response: unknown = JSON.parse(data.toString());
        responses.push(response as (typeof responses)[number]);
      });
      const params = { fromMs: 1, toMs: 2, measures: ['totalTokens'] };
      ws.send(JSON.stringify({ id: 'stats-1', method: 'statistics.summary', params }));
      ws.send(JSON.stringify({ id: 'stats-2', method: 'statistics.summary', params }));
      ws.send(JSON.stringify({ id: 'stats-3', method: 'statistics.summary', params }));

      await vi.waitFor(() => {
        expect(responses.find((response) => response.id === 'stats-3')).toMatchObject({
          ok: false,
          error: { code: 'RATE_LIMITED' },
        });
      });
      expect(statisticsReader.summarize).toHaveBeenCalledTimes(2);
      releaseSummaries?.();
      await vi.waitFor(() => expect(responses.filter((response) => response.ok)).toHaveLength(2));
    });

    it('serves statistics.series through an authenticated WebSocket', async () => {
      const buckets = [{ fromMs: 0, toMs: 60_000, summaries: [] }];
      const statisticsReader = {
        capabilities: vi.fn().mockResolvedValue({ available: true }),
        summarize: vi.fn().mockResolvedValue([]),
        timeSeries: vi.fn().mockResolvedValue(buckets),
        listExchanges: vi.fn().mockResolvedValue({ items: [], nextCursor: null, snapshotMaxSequence: 0 }),
        dimensions: vi.fn().mockResolvedValue([]),
        sessionTotals: vi.fn().mockResolvedValue({}),
      } as unknown as LlmStatisticsReader;
      const srv = createServer({ statisticsReader });
      const url = await srv.start();
      const ws = createWs(`ws://127.0.0.1:${extractPort(url)}/ws?token=${extractToken(url)}`);
      await new Promise<void>((resolve) => ws.on('open', resolve));

      const responsePromise = new Promise<Record<string, unknown>>((resolve) => {
        ws.on('message', (data: Buffer) => resolve(JSON.parse(data.toString()) as Record<string, unknown>));
      });
      const params = { fromMs: 0, toMs: 60_000, measures: ['requestCount'], bucketMs: 60_000 };
      ws.send(JSON.stringify({ id: 'stats-series', method: 'statistics.series', params }));

      await expect(responsePromise).resolves.toMatchObject({ id: 'stats-series', ok: true, payload: buckets });
      expect(statisticsReader.timeSeries).toHaveBeenCalledWith(params);
    });

    it('serves statistics.distribution through an authenticated WebSocket', async () => {
      const histogram = {
        measure: 'effectiveOutputTokensPerSecond',
        bins: [{ lower: 0, upper: 100, count: 2 }],
        sampleCount: 2,
        eligibleCount: 3,
        coverage: 2 / 3,
        minimum: 25,
        maximum: 75,
        formulaVersion: 1,
      } as const;
      const statisticsReader = {
        capabilities: vi.fn().mockResolvedValue({ available: true }),
        summarize: vi.fn().mockResolvedValue([]),
        timeSeries: vi.fn().mockResolvedValue([]),
        distribution: vi.fn().mockResolvedValue(histogram),
        listExchanges: vi.fn().mockResolvedValue({ items: [], nextCursor: null, snapshotMaxSequence: 0 }),
        dimensions: vi.fn().mockResolvedValue([]),
        sessionTotals: vi.fn().mockResolvedValue({}),
      } as unknown as LlmStatisticsReader;
      const srv = createServer({ statisticsReader });
      const url = await srv.start();
      const ws = createWs(`ws://127.0.0.1:${extractPort(url)}/ws?token=${extractToken(url)}`);
      await new Promise<void>((resolve) => ws.on('open', resolve));

      const responsePromise = new Promise<Record<string, unknown>>((resolve) => {
        ws.on('message', (data: Buffer) => resolve(JSON.parse(data.toString()) as Record<string, unknown>));
      });
      const params = {
        fromMs: 0,
        toMs: 60_000,
        measure: 'effectiveOutputTokensPerSecond',
        maxBins: 20,
      };
      ws.send(JSON.stringify({ id: 'stats-distribution', method: 'statistics.distribution', params }));

      await expect(responsePromise).resolves.toMatchObject({ id: 'stats-distribution', ok: true, payload: histogram });
      expect(statisticsReader.distribution).toHaveBeenCalledWith(params);
    });
  });

  // GAP4-10: the orphan reaper and stop() must go through the shared teardown
  // (one close per session, `session.ended` emitted so the daemon's bridge
  // maps are released), not a bare SessionManager.end().
  describe('web-session teardown paths', () => {
    function stubWebSession(id: string): Session {
      return {
        getInfo: () => ({ id: id as SessionInfo['id'], status: 'ready', turnCount: 0, createdAt: '' }),
        getBudgetStatus: vi.fn(),
        getHistory: () => [],
        getDiagnosticLog: () => [],
        sendMessage: vi.fn().mockResolvedValue('ok'),
        resolveEscalation: vi.fn().mockResolvedValue(undefined),
        getPendingEscalations: () => [],
        close: vi.fn().mockResolvedValue(undefined),
      };
    }

    async function connectClient(srv: WebUiServer): Promise<WebSocket> {
      const url = await srv.start();
      const ws = createWs(`ws://127.0.0.1:${extractPort(url)}/ws?token=${extractToken(url)}`);
      await new Promise<void>((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
      });
      return ws;
    }

    it('the orphan reaper ends web sessions through the shared teardown and emits session.ended once', async () => {
      const sessionManager = new SessionManager();
      const session = stubWebSession('orphan-1');
      const label = sessionManager.register(
        session,
        { run: vi.fn().mockResolvedValue(undefined), close: vi.fn() },
        {
          kind: 'web',
        },
      );
      const srv = createServer({ sessionManager, orphanGraceMs: 50 });
      const ended: unknown[] = [];
      srv.getEventBus().subscribe((event, payload) => {
        if (event === 'session.ended') ended.push(payload);
      });

      const ws = await connectClient(srv);
      ws.close();
      await waitForClose(ws);

      await vi.waitFor(() => expect(ended).toHaveLength(1), { timeout: 3000 });
      expect(ended[0]).toEqual({ label, reason: 'orphaned' });
      expect(session.close).toHaveBeenCalledTimes(1);
      expect(sessionManager.size).toBe(0);

      // stop() finds nothing left to end: no second close, no second event.
      await srv.stop();
      expect(session.close).toHaveBeenCalledTimes(1);
      expect(ended).toHaveLength(1);
    });

    it('stop() ends web sessions through the shared teardown and emits session.ended once each', async () => {
      const sessionManager = new SessionManager();
      const session = stubWebSession('shutdown-1');
      const label = sessionManager.register(
        session,
        { run: vi.fn().mockResolvedValue(undefined), close: vi.fn() },
        {
          kind: 'web',
        },
      );
      const srv = createServer({ sessionManager });
      const ended: unknown[] = [];
      srv.getEventBus().subscribe((event, payload) => {
        if (event === 'session.ended') ended.push(payload);
      });
      await srv.start();

      await srv.stop();

      expect(ended).toEqual([{ label, reason: 'daemon_shutdown' }]);
      expect(session.close).toHaveBeenCalledTimes(1);
      expect(sessionManager.size).toBe(0);
    });
  });

  describe('response size cap (WEB-4)', () => {
    it('replaces an oversized reply with RESPONSE_TOO_LARGE and keeps the socket open', async () => {
      // 150 bytes: the `status` payload is larger, a METHOD_NOT_FOUND error frame is smaller.
      const srv = createServer({ maxResponseBytes: 150 });
      const url = await srv.start();
      const ws = createWs(`ws://127.0.0.1:${extractPort(url)}/ws?token=${extractToken(url)}`);
      await new Promise<void>((resolve) => ws.on('open', resolve));

      const responses: Array<{ id: string; ok: boolean; error?: { code: string; message: string } }> = [];
      ws.on('message', (data: Buffer) => {
        responses.push(JSON.parse(data.toString()) as (typeof responses)[number]);
      });

      ws.send(JSON.stringify({ id: 'big', method: 'status' }));
      await vi.waitFor(() => expect(responses.find((r) => r.id === 'big')).toBeDefined());
      const big = responses.find((r) => r.id === 'big');
      expect(big).toMatchObject({ ok: false, error: { code: 'RESPONSE_TOO_LARGE' } });
      expect(big?.error?.message).toContain('exceeds the 150-byte limit');
      // The connection was not closed: a request whose reply fits still succeeds.
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.send(JSON.stringify({ id: 'small', method: 'nonexistent' }));
      await vi.waitFor(() =>
        expect(responses.find((r) => r.id === 'small')).toMatchObject({
          ok: false,
          error: { code: 'METHOD_NOT_FOUND' },
        }),
      );
      expect(ws.readyState).toBe(WebSocket.OPEN);
    });
  });

  describe('event backpressure (WEB-4)', () => {
    it('sends bounded deny-only records for both escalation event shapes', () => {
      const srv = createServer();
      const client = { readyState: WebSocket.OPEN, bufferedAmount: 0, send: vi.fn() };
      const clients = new Set([client]) as unknown as ReadonlySet<import('ws').WebSocket>;
      const common = {
        escalationId: 'example-event',
        serverName: 'filesystem',
        toolName: 'write_file',
        arguments: { content: 'Example prose. '.repeat(1200) },
        reason: 'Review an example.',
        receivedAt: '2026-11-16T00:00:00Z',
      };
      srv.sendToSubscribers(clients, 'escalation.created', {
        ...common,
        sessionLabel: 1,
        sessionSource: { kind: 'web' },
      });
      srv.sendToSubscribers(clients, 'workflow.escalation_raised', {
        workflowId: 'wf-example',
        escalation: { ...common, workflowId: 'wf-example', stateId: 'review' },
      });
      const frames = client.send.mock.calls.map(([text]) => JSON.parse(String(text)) as { payload: unknown });
      expect(frames[0].payload).toMatchObject({ reviewUnavailable: true, arguments: {} });
      expect(frames[1].payload).toMatchObject({
        workflowId: 'wf-example',
        escalation: { reviewUnavailable: true, arguments: {} },
      });
      for (const [text] of client.send.mock.calls) expect(Buffer.byteLength(String(text))).toBeLessThan(2048);
    });

    it('skips event delivery to a client whose send buffer is above the threshold', async () => {
      const srv = createServer();
      await srv.start();
      const stalled = { readyState: WebSocket.OPEN, bufferedAmount: 5 * 1024 * 1024, send: vi.fn() };
      const healthy = { readyState: WebSocket.OPEN, bufferedAmount: 1024, send: vi.fn() };
      const clients = new Set([stalled, healthy]) as unknown as ReadonlySet<import('ws').WebSocket>;

      srv.sendToSubscribers(clients, 'session.ended', { label: 1, reason: 'test' });

      expect(stalled.send).not.toHaveBeenCalled();
      expect(healthy.send).toHaveBeenCalledTimes(1);
      const frame = JSON.parse(healthy.send.mock.calls[0][0] as string) as { event: string; payload: unknown };
      expect(frame.event).toBe('session.ended');
      expect(frame.payload).toEqual({ label: 1, reason: 'test' });
    });

    it('tells a client that missed events to resync once it has drained, exactly once', async () => {
      const srv = createServer();
      await srv.start();
      const client = { readyState: WebSocket.OPEN, bufferedAmount: 5 * 1024 * 1024, send: vi.fn() };
      const clients = new Set([client]) as unknown as ReadonlySet<import('ws').WebSocket>;
      const sentEvents = (): string[] =>
        client.send.mock.calls.map((call) => (JSON.parse(call[0] as string) as { event: string }).event);

      // Skipped while backpressured: e.g. an escalation the UI must not lose.
      srv.sendToSubscribers(clients, 'escalation.created', { escalationId: 'e1' });
      expect(client.send).not.toHaveBeenCalled();

      // Drained: the next event is preceded by one resync frame.
      client.bufferedAmount = 0;
      srv.sendToSubscribers(clients, 'daemon.status', {});
      expect(sentEvents()).toEqual(['daemon.resync', 'daemon.status']);
      const resync = JSON.parse(client.send.mock.calls[0][0] as string) as { payload: unknown };
      expect(resync.payload).toEqual({ reason: 'backpressure' });

      // Nothing was missed since: no further resync.
      srv.sendToSubscribers(clients, 'daemon.status', {});
      expect(sentEvents()).toEqual(['daemon.resync', 'daemon.status', 'daemon.status']);
    });
  });

  describe('event broadcasting', () => {
    it('broadcasts events to connected clients', async () => {
      const srv = createServer();
      const url = await srv.start();
      const port = extractPort(url);
      const token = extractToken(url);

      const ws = createWs(`ws://127.0.0.1:${port}/ws?token=${token}`);
      await new Promise<void>((resolve) => ws.on('open', resolve));

      const eventPromise = new Promise<string>((resolve) => {
        ws.on('message', (data: Buffer) => {
          const msg = JSON.parse(data.toString());
          if (msg.event) resolve(data.toString());
        });
      });

      srv.getEventBus().emit('session.ended', { label: 42, reason: 'test' });

      const raw = await eventPromise;
      const frame = JSON.parse(raw);

      expect(frame.event).toBe('session.ended');
      expect(frame.payload).toEqual({ label: 42, reason: 'test' });
      expect(frame.seq).toBe(1);
    });

    it('increments seq on each broadcast', async () => {
      const srv = createServer();
      const url = await srv.start();
      const port = extractPort(url);
      const token = extractToken(url);

      const ws = createWs(`ws://127.0.0.1:${port}/ws?token=${token}`);
      await new Promise<void>((resolve) => ws.on('open', resolve));

      const events: unknown[] = [];
      const gotTwo = new Promise<void>((resolve) => {
        ws.on('message', (data: Buffer) => {
          const msg = JSON.parse(data.toString());
          if (msg.event) {
            events.push(msg);
            if (events.length === 2) resolve();
          }
        });
      });

      srv.getEventBus().emit('session.ended', { label: 1, reason: 'a' });
      srv.getEventBus().emit('session.ended', { label: 2, reason: 'b' });

      await gotTwo;
      expect((events[0] as { seq: number }).seq).toBe(1);
      expect((events[1] as { seq: number }).seq).toBe(2);
    });
  });
});
