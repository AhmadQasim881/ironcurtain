import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import https from 'node:https';
import * as undici from 'undici';

vi.mock('undici', async () => {
  const actual = await vi.importActual<typeof import('undici')>('undici');
  return { ...actual, fetch: vi.fn(actual.fetch) };
});
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { createSignalBridgeClient, type SignalBridgeClient } from '../../src/signal/signal-bridge-client.js';
import { getSignalTestTlsIdentity } from '../helpers/mock-signal-api.js';
import { createTlsIdentity } from '../helpers/fake-parent-proxy.js';

const TOKEN = 'b'.repeat(64);

describe('Signal bridge client', () => {
  let server: https.Server;
  let receiver: WebSocketServer;
  let origin: string;
  let client: SignalBridgeClient;
  let destinationRequests: number;
  let upgradeRequests: number;
  let redirectUpgrade: boolean;
  let holdStarted: (() => void) | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    destinationRequests = 0;
    upgradeRequests = 0;
    redirectUpgrade = false;
    holdStarted = undefined;
    const identity = getSignalTestTlsIdentity();
    server = https.createServer({ cert: identity.certPem, key: identity.keyPem }, (req, res) => {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401).end();
        return;
      }
      if (req.url === '/v1/redirect') {
        res.writeHead(302, { Location: `${origin}/v1/destination` }).end();
        return;
      }
      if (req.url === '/v1/destination') destinationRequests++;
      if (req.url === '/v1/hold') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('[');
        holdStarted?.();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"healthy":true}');
    });
    receiver = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      upgradeRequests++;
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      } else if (redirectUpgrade) {
        socket.end(`HTTP/1.1 302 Found\r\nLocation: ${origin}/v1/destination\r\nConnection: close\r\n\r\n`);
      } else {
        receiver.handleUpgrade(req, socket, head, (ws) => receiver.emit('connection', ws, req));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Missing fixture listener');
    origin = `https://127.0.0.1:${address.port}`;
    client = createSignalBridgeClient(origin, TOKEN, { ca: getSignalTestTlsIdentity().certPem });
  });

  afterEach(async () => {
    client.close();
    for (const socket of receiver.clients) socket.terminate();
    receiver.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.restoreAllMocks();
  });

  it('authenticates HTTP requests and overrides caller authorization', async () => {
    const response = await client.request('/v1/health', { headers: { Authorization: 'Bearer ordinary' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ healthy: true });
    expect(Object.keys(client).sort()).toEqual(['close', 'openReceive', 'request']);
  });

  it('does not admit a different synthetic credential', async () => {
    const other = createSignalBridgeClient(origin, 'c'.repeat(64), { ca: getSignalTestTlsIdentity().certPem });
    try {
      expect((await other.request('/v1/health')).status).toBe(401);
      await expect(once(other.openReceive('+15551234567'), 'open')).rejects.toThrow('401');
      expect(receiver.clients.size).toBe(0);
    } finally {
      other.close();
    }
  });

  it('authenticates the receive upgrade without URL credentials', async () => {
    const socket = client.openReceive('+15551234567');
    await once(socket, 'open');
    expect(receiver.clients.size).toBe(1);
    expect(new URL(socket.url).search).toBe('');
    expect(new URL(socket.url).username).toBe('');
    expect(new URL(socket.url).password).toBe('');
  });

  it('rejects an unrelated TLS issuer for HTTP and WebSocket', async () => {
    const unrelated = createTlsIdentity(['localhost']);
    const other = createSignalBridgeClient(origin, TOKEN, { ca: unrelated.certPem });
    try {
      await expect(other.request('/v1/health')).rejects.toThrow(/^Signal bridge request failed$/u);
      await expect(once(other.openReceive('+15551234567'), 'open')).rejects.toThrow();
      expect(upgradeRequests).toBe(0);
    } finally {
      other.close();
    }
  });

  it('requires the fixed localhost TLS identity', async () => {
    const otherIdentity = createTlsIdentity(['fixture.example.test']);
    server.setSecureContext({ cert: otherIdentity.certPem, key: otherIdentity.keyPem });
    const other = createSignalBridgeClient(origin, TOKEN, { ca: otherIdentity.certPem });
    try {
      await expect(other.request('/v1/health')).rejects.toThrow(/^Signal bridge request failed$/u);
      await expect(once(other.openReceive('+15551234567'), 'open')).rejects.toThrow();
      expect(upgradeRequests).toBe(0);
    } finally {
      other.close();
    }
  });

  it('refuses HTTP redirects even when the caller requests following them', async () => {
    await expect(client.request('/v1/redirect', { redirect: 'follow' })).rejects.toThrow(
      'Signal bridge request failed',
    );
    expect(destinationRequests).toBe(0);
  });

  it('refuses WebSocket redirects', async () => {
    redirectUpgrade = true;
    await expect(once(client.openReceive('+15551234567'), 'open')).rejects.toThrow('302');
    expect(upgradeRequests).toBe(1);
    expect(destinationRequests).toBe(0);
  });

  it('rejects noncanonical origins and nonrelative paths before any request', async () => {
    const fetchSpy = vi.spyOn(undici, 'fetch');
    for (const endpoint of ['https://localhost:18080', 'http://127.0.0.1:18080', `${origin}/v1/health`]) {
      expect(() => createSignalBridgeClient(endpoint, TOKEN, { ca: getSignalTestTlsIdentity().certPem })).toThrow(
        'fixed loopback',
      );
    }
    for (const path of [
      'http://example.test/v1/health',
      '//example.test/v1/health',
      '/v1/../health',
      '/v1/health?x=1',
    ]) {
      await expect(client.request(path)).rejects.toThrow('relative API path');
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects missing and malformed credentials without exposing them', () => {
    for (const credential of ['', 'ordinary', 'A'.repeat(64)]) {
      expect(() => createSignalBridgeClient(origin, credential, { ca: getSignalTestTlsIdentity().certPem })).toThrow(
        /^Invalid Signal bridge credential$/u,
      );
    }
  });

  it('cancels a request while reading its body when the caller aborts', async () => {
    const started = new Promise<void>((resolve) => {
      holdStarted = resolve;
    });
    const caller = new AbortController();
    const request = client.request('/v1/hold', { signal: caller.signal });
    const rejected = expect(request).rejects.toThrow(/^Signal bridge request failed$/u);
    await started;
    caller.abort();
    await rejected;
  });

  it('closes owned upgrades and cancels response bodies on shutdown', async () => {
    const socket = client.openReceive('+15551234567');
    await once(socket, 'open');
    const closed = once(socket, 'close');
    const started = new Promise<void>((resolve) => {
      holdStarted = resolve;
    });
    const request = client.request('/v1/hold');
    const cancelled = expect(request).rejects.toThrow(/^Signal bridge request failed$/u);
    await started;
    client.close();
    await Promise.all([closed, cancelled]);
    await expect(client.request('/v1/health')).rejects.toThrow('closed');
    expect(() => client.openReceive('+15551234567')).toThrow('closed');
    client.close();
  });

  it('cancels an oversized response using a tiny counter fixture', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const releaseLock = vi.fn();
    vi.spyOn(undici, 'fetch').mockResolvedValue({
      body: {
        getReader: () => ({
          read: async () => ({ done: false, value: new Uint8Array(4 * 1024 * 1024 + 1) }),
          cancel,
          releaseLock,
        }),
      },
    } as unknown as Awaited<ReturnType<typeof undici.fetch>>);
    await expect(client.request('/v1/health')).rejects.toThrow(/^Signal bridge request failed$/u);
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
  });
});
