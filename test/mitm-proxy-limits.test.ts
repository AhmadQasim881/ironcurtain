/**
 * MITM denial-of-service resistance (WP-44: MITM-7, MITM-10, MITM-14).
 *
 * End-to-end through a real proxy on a Unix socket: leaf certificates are
 * minted for the admitted CONNECT host only (a random SNI is refused and never
 * minted), per-bundle ceilings answer clean HTTP errors instead of resets or
 * unbounded buffering, oversized bodies get a delivered 413, every stall has a
 * deadline, and the capture tee of a streamed request is bounded.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Readable } from 'node:stream';
import * as zlib from 'node:zlib';
import type { AddressInfo, Socket } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import {
  LEAF_SECURE_CONTEXT_CACHE_MAX_ENTRIES,
  leafSecureContextCacheSize,
  loadOrCreateCA,
  type CertificateAuthority,
} from '../src/docker/ca.js';
import { createMitmProxy, type MitmProxy, type MitmProxyOptions, type TunnelDialer } from '../src/docker/mitm-proxy.js';
import type { MitmResourceLimits } from '../src/docker/mitm-resource-limits.js';
import type { OutboundTransport } from '../src/docker/outbound-transport.js';
import { anthropicRequestRewriter, type ProviderConfig } from '../src/docker/provider-config.js';
import { createTrajectoryCaptureWriter, type TrajectoryCaptureWriter } from '../src/docker/trajectory-capture.js';
import type { ExchangeRecord, ManifestEntry } from '../src/docker/trajectory-types.js';
import type { SessionId } from '../src/session/types.js';
import * as logger from '../src/logger.js';
import { createFakeUpstream, localhostDnsLookup, sendConnect, type FakeUpstream } from './helpers/mitm-tls-harness.js';
import { buildClientHelloRecord } from './helpers/tls-client-hello-fixture.js';

const MIB = 1024 * 1024;
const FAKE_KEY = 'sk-limits-fake-key';
const REAL_KEY = 'sk-limits-real-key';

/** A buffered route: the rewriter forces the body through the bounded reader. */
const BUFFERED_HOST = 'api.limits.test';
/** A streamed route with trajectory capture: no rewriter, no sanitizer, no retry. */
const STREAMED_HOST = 'api.stream.test';
/** A passthrough approval on 443: an SNI-pinned raw tunnel. */
const TUNNEL_HOST = 'tunnel.limits.test';
/** A passthrough approval on 80: a tunnel the proxy serves as HTTP. */
const PLAIN_TUNNEL_HOST = 'plain.limits.test';

/** Raw-tunnel dialer that reaches a local fixture: approvals name 443 or 80, never a fixture's port. */
function localTunnelDialer(port: number): TunnelDialer {
  return () => net.connect({ host: '127.0.0.1', port });
}

/** Destination-bound transport that delivers every request (and upgrade) to a local fixture. */
function localUpstreamTransport(port: number): OutboundTransport {
  return {
    kind: 'direct',
    addressGuard: 'local-resolver',
    request(request, onResponse) {
      return http.request(
        { hostname: '127.0.0.1', port, method: request.method, path: request.path, headers: request.headers },
        onResponse,
      );
    },
  };
}

function providers(
  upstreamPort: number,
  overrides: Partial<ProviderConfig> = {},
  streamedUpstreamPort = upstreamPort,
): MitmProxyOptions['providers'] {
  const upstreamTarget = { hostname: '127.0.0.1', port: upstreamPort, pathPrefix: '', useTls: false };
  const buffered: ProviderConfig = {
    host: BUFFERED_HOST,
    displayName: 'Limits (buffered)',
    allowedEndpoints: [{ method: 'POST', path: '/v1/messages' }],
    keyInjection: { type: 'header', headerName: 'x-api-key' },
    fakeKeyPrefix: 'sk-limits-',
    requestRewriter: anthropicRequestRewriter,
    rewriteEndpoints: ['/v1/messages'],
    upstreamTarget,
    ...overrides,
  };
  const streamed: ProviderConfig = {
    host: STREAMED_HOST,
    displayName: 'Limits (streamed)',
    allowedEndpoints: [{ method: 'POST', path: '/v1/complete' }],
    captureEndpoints: [{ method: 'POST', path: '/v1/complete' }],
    keyInjection: { type: 'header', headerName: 'x-api-key' },
    fakeKeyPrefix: 'sk-limits-',
    upstreamTarget: { ...upstreamTarget, port: streamedUpstreamPort },
    ...overrides,
  };
  return [
    { config: buffered, fakeKey: FAKE_KEY, realKey: REAL_KEY },
    { config: streamed, fakeKey: FAKE_KEY, realKey: REAL_KEY },
  ];
}

/** A JSON completion request padded to exactly `bytes` bytes. */
function jsonBody(bytes: number): Buffer {
  const head = '{"model":"m","messages":[{"role":"user","content":"';
  const tail = '"}]}';
  return Buffer.from(head + 'x'.repeat(bytes - head.length - tail.length) + tail);
}

interface RawResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/**
 * Read one complete HTTP/1.1 response (Content-Length framed) from `socket`.
 * Rejects if the connection ends or resets first: the "unclean error" the
 * proxy must never produce.
 */
function readResponse(socket: Socket): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      data = Buffer.concat([data, chunk]);
      const headEnd = data.indexOf('\r\n\r\n');
      if (headEnd < 0) return;
      const lines = data.subarray(0, headEnd).toString('latin1').split('\r\n');
      const headers: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(':');
        if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
      const length = Number(headers['content-length'] ?? '0');
      if (data.length - (headEnd + 4) < length) return;
      cleanup();
      resolve({
        status: Number(lines[0].split(' ')[1]),
        headers,
        body: data.subarray(headEnd + 4, headEnd + 4 + length).toString(),
      });
    };
    const onEnd = (): void => {
      cleanup();
      reject(new Error(`connection ended before a complete response (${data.length} bytes received)`));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('close', onEnd);
      socket.off('error', onError);
    };
    socket.on('data', onData);
    socket.on('end', onEnd);
    socket.on('close', onEnd);
    socket.on('error', onError);
  });
}

function requestHead(host: string, path: string, contentLength: number, extra: Record<string, string> = {}): string {
  const headers = {
    host,
    'content-type': 'application/json',
    'x-api-key': FAKE_KEY,
    'content-length': String(contentLength),
    ...extra,
  };
  const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
  return `POST ${path} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves once `check` holds; rejects after `ms`. */
async function eventually(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${ms} ms`);
    await sleep(10);
  }
}

/** Resolves when `socket` closes; rejects after `ms` (a deadline that never fired). */
function closedWithin(socket: Socket, ms: number): Promise<number> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    if (socket.destroyed) {
      resolve(0);
      return;
    }
    // Consume whatever arrives: a paused socket with unread data never emits 'close'.
    socket.resume();
    const timer = setTimeout(() => reject(new Error(`socket still open after ${ms} ms`)), ms);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve(Date.now() - startedAt);
    });
  });
}

describe('MITM proxy resource limits', () => {
  let tempDir: string;
  let ca: CertificateAuthority;
  let socketPath: string;
  let proxy: MitmProxy | undefined;
  let upstream: FakeUpstream | undefined;
  const servers: (http.Server | net.Server)[] = [];
  const sockets: Socket[] = [];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mitm-limits-'));
    ca = loadOrCreateCA(join(tempDir, 'ca'));
    socketPath = join(tempDir, 'mitm.sock');
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.destroy();
    await proxy?.stop();
    proxy = undefined;
    for (const server of [...servers.splice(0), ...(upstream ? [upstream.server] : [])]) {
      if (server instanceof http.Server) server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    upstream = undefined;
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
  });

  async function startProxy(
    options: {
      limits?: Partial<MitmResourceLimits>;
      provider?: Partial<ProviderConfig>;
    } & Partial<MitmProxyOptions> = {},
  ): Promise<MitmProxy> {
    upstream ??= await createFakeUpstream(() => ({ status: 200, body: '{"ok":true}' }));
    const { limits, provider, ...rest } = options;
    proxy = createMitmProxy({
      socketPath,
      ca,
      dnsLookup: localhostDnsLookup,
      allowPrivateDestinationsForTests: true,
      providers: providers(upstream.port, provider),
      resourceLimits: limits,
      ...rest,
    });
    await proxy.start();
    return proxy;
  }

  /** CONNECT to `host` and complete a TLS handshake that names `host`. */
  async function openTls(host: string, port = 443): Promise<tls.TLSSocket> {
    const { socket, statusCode } = await sendConnect(socketPath, host, port);
    expect(statusCode).toBe(200);
    if (socket === null) throw new Error('CONNECT returned no socket');
    const secure = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const tlsSocket = tls.connect({ socket, servername: host, ca: ca.certPem }, () => resolve(tlsSocket));
      tlsSocket.once('error', reject);
    });
    sockets.push(secure);
    return secure;
  }

  /** CONNECT to an approved `host:80`; the proxy serves the tunnel as HTTP. */
  async function openPlainTunnel(host = PLAIN_TUNNEL_HOST): Promise<Socket> {
    const { socket, statusCode } = await sendConnect(socketPath, host, 80);
    expect(statusCode).toBe(200);
    if (socket === null) throw new Error('CONNECT returned no socket');
    sockets.push(socket);
    return socket;
  }

  /** CONNECT to `connectHost`, then attempt a handshake that names `sni` (or no SNI). */
  async function handshake(connectHost: string, sni: string | undefined): Promise<tls.PeerCertificate | 'rejected'> {
    const { socket, statusCode } = await sendConnect(socketPath, connectHost, 443);
    expect(statusCode).toBe(200);
    if (socket === null) throw new Error('CONNECT returned no socket');
    return new Promise((resolve) => {
      const tlsSocket = tls.connect(
        { socket, servername: sni ?? '', ca: ca.certPem, checkServerIdentity: () => undefined },
        () => {
          const peer = tlsSocket.getPeerCertificate();
          tlsSocket.destroy();
          resolve(peer);
        },
      );
      tlsSocket.once('error', () => {
        tlsSocket.destroy();
        resolve('rejected');
      });
    });
  }

  function fetchThroughProxy(host: string, path: string, init: Parameters<typeof undiciFetch>[1]) {
    const dispatcher = new Agent({
      connect: (_options, callback) => {
        sendConnect(socketPath, host, 443).then(
          ({ socket }) => {
            if (socket === null) {
              callback(new Error('CONNECT refused'), null);
              return;
            }
            const tlsSocket = tls.connect({ socket, servername: host, ca: ca.certPem }, () =>
              callback(null, tlsSocket),
            );
            tlsSocket.once('error', (error) => callback(error, null));
          },
          (error: unknown) => callback(error instanceof Error ? error : new Error(String(error)), null),
        );
      },
    });
    return undiciFetch(`https://${host}${path}`, { ...init, dispatcher }).finally(() => {
      void dispatcher.close();
    });
  }

  // ── MITM-7: leaf minting ────────────────────────────────────────────

  describe('leaf certificates', () => {
    it(
      'refuses 500 CONNECTs carrying random SNI names without minting, never blocking the event loop for 50 ms',
      { retry: 2, timeout: 60_000 },
      async () => {
        await startProxy();
        // The CONNECT host's own leaf (minted on first use).
        const own = await handshake(BUFFERED_HOST, BUFFERED_HOST);
        expect(own).not.toBe('rejected');
        const cacheBefore = leafSecureContextCacheSize();

        const delay = monitorEventLoopDelay({ resolution: 2 });
        delay.enable();
        let rejected = 0;
        for (let batch = 0; batch < 50; batch++) {
          const outcomes = await Promise.all(
            Array.from({ length: 10 }, () => handshake(BUFFERED_HOST, `${randomUUID()}.attacker.example`)),
          );
          rejected += outcomes.filter((outcome) => outcome === 'rejected').length;
        }
        delay.disable();

        expect(rejected).toBe(500);
        // Nothing was minted for any of the 500 names, and the cache is bounded regardless.
        expect(leafSecureContextCacheSize()).toBe(cacheBefore);
        expect(leafSecureContextCacheSize()).toBeLessThanOrEqual(LEAF_SECURE_CONTEXT_CACHE_MAX_ENTRIES);
        // Before WP-44 every unique SNI cost a key generation plus a JS RSA signature (~50 ms).
        expect(delay.max / 1e6).toBeLessThan(50);
      },
    );

    it('serves the CONNECT host leaf to a ClientHello without SNI and accepts a differently cased SNI', async () => {
      await startProxy();
      const withoutSni = await handshake(BUFFERED_HOST, undefined);
      expect(withoutSni).not.toBe('rejected');
      expect(withoutSni !== 'rejected' && withoutSni.subject.CN).toBe(BUFFERED_HOST);
      const upperCase = await handshake(BUFFERED_HOST, BUFFERED_HOST.toUpperCase());
      expect(upperCase !== 'rejected' && upperCase.subject.CN).toBe(BUFFERED_HOST);
    });

    it('refuses an SNI naming a different allowlisted host', async () => {
      await startProxy();
      expect(await handshake(BUFFERED_HOST, STREAMED_HOST)).toBe('rejected');
    });

    it('certifies an IP-literal provider host by address, as the CONNECT parser canonicalizes it', async () => {
      // The provider is admitted by its canonical address however it is
      // spelled (WP-43); the leaf minted for that admitted host before the
      // CONNECT is acknowledged must then name the address, not a DNS name.
      upstream = await createFakeUpstream(() => ({ status: 200, body: '{"ok":true}' }));
      const [buffered] = providers(upstream.port);
      proxy = createMitmProxy({
        socketPath,
        ca,
        dnsLookup: localhostDnsLookup,
        allowPrivateDestinationsForTests: true,
        providers: [{ ...buffered, config: { ...buffered.config, host: '[2001:DB8:0::5]' } }],
      });
      await proxy.start();

      const peer = await handshake('[2001:db8::5]', undefined);
      if (peer === 'rejected') throw new Error('handshake with the IP-literal provider was rejected');
      expect(peer.subjectaltname).toBe('IP Address:2001:DB8:0:0:0:0:0:5');
      expect(tls.checkServerIdentity('2001:db8::5', peer)).toBeUndefined();
    });
  });

  // ── MITM-10: clean 413 ──────────────────────────────────────────────

  describe('oversized request bodies', () => {
    it('delivers a 413 naming the limit to a fetch client sending a 40 MiB body, and never contacts the upstream', async () => {
      await startProxy();
      const response = await fetchThroughProxy(BUFFERED_HOST, '/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': FAKE_KEY },
        body: Buffer.alloc(40 * MIB, 0x20),
      });
      expect(response.status).toBe(413);
      expect(response.headers.get('connection')).toBe('close');
      const error = (await response.json()) as { error: { type: string; message: string } };
      expect(error.error.type).toBe('request_too_large');
      expect(error.error.message).toBe(
        `IronCurtain proxy refused this request: request body exceeds the 32 MiB limit for ${BUFFERED_HOST}`,
      );
      expect(upstream?.requests()).toHaveLength(0);
    });

    it('delivers a 413 for a chunked body that outgrows the limit mid-upload', async () => {
      await startProxy({ provider: { maxRequestBodyBytes: MIB } });
      const chunks = Array.from({ length: 12 }, () => Buffer.alloc(256 * 1024, 0x20));
      const response = await fetchThroughProxy(BUFFERED_HOST, '/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': FAKE_KEY },
        body: Readable.from(chunks),
        duplex: 'half',
      });
      expect(response.status).toBe(413);
      const error = (await response.json()) as { error: { message: string } };
      expect(error.error.message).toContain('exceeds the 1 MiB limit');
      expect(upstream?.requests()).toHaveLength(0);
    });

    it('forwards a body above the old 10 MB limit and below the provider limit', async () => {
      await startProxy();
      const body = jsonBody(12 * MIB);
      const response = await fetchThroughProxy(BUFFERED_HOST, '/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': FAKE_KEY },
        body,
      });
      expect(response.status).toBe(200);
      expect(upstream?.requests().map((request) => request.rawBody.length)).toEqual([body.length]);
    });

    it('rejects a provider limit that is not a positive integer', () => {
      expect(() => createMitmProxy({ socketPath, ca, providers: providers(1, { maxRequestBodyBytes: 0 }) })).toThrow(
        /maxRequestBodyBytes must be a positive integer/,
      );
    });
  });

  // ── MITM-14: per-bundle ceilings ────────────────────────────────────

  describe('per-bundle ceilings', () => {
    it(
      'answers 200 parallel slow bodies with clean errors at the concurrency and buffered-byte ceilings',
      { timeout: 60_000 },
      async () => {
        const maxConcurrentRequests = 64;
        const maxBufferedBodyBytes = 8 * MIB;
        await startProxy({ limits: { maxConcurrentRequests, maxBufferedBodyBytes } });
        const body = jsonBody(256 * 1024);
        const rounds = 8;
        const chunkSize = body.length / rounds;

        // Phase 1: 200 connections each send a request head; the proxy admits
        // or refuses every request before any body has arrived.
        const clients = await Promise.all(
          Array.from({ length: 200 }, async () => {
            const socket = await openTls(BUFFERED_HOST);
            const response = readResponse(socket).then(
              (value) => ({ ok: true as const, value }),
              (error: unknown) => ({ ok: false as const, error }),
            );
            let answered = false;
            void response.then(() => {
              answered = true;
            });
            socket.write(requestHead(BUFFERED_HOST, '/v1/messages', body.length));
            return { socket, response, isAnswered: () => answered };
          }),
        );
        await sleep(100);

        // Phase 2: every body trickles in; a client stops once it is answered.
        for (let round = 0; round < rounds; round++) {
          for (const client of clients) {
            if (!client.isAnswered() && !client.socket.destroyed) {
              client.socket.write(body.subarray(round * chunkSize, (round + 1) * chunkSize));
            }
          }
          await sleep(20);
        }
        const outcomes = await Promise.all(clients.map((client) => client.response));
        for (const client of clients) client.socket.destroy();

        // Every one of the 200 got a complete HTTP response: no resets, no hangs.
        const unclean = outcomes.filter((outcome) => !outcome.ok);
        expect(unclean).toEqual([]);
        const responses = outcomes.flatMap((outcome) => (outcome.ok ? [outcome.value] : []));
        expect(responses.every((response) => response.status === 200 || response.status === 503)).toBe(true);
        const busy = responses.filter((response) => response.status === 503);
        expect(busy.filter((response) => response.body.includes('too many concurrent requests'))).toHaveLength(
          200 - maxConcurrentRequests,
        );
        expect(busy.some((response) => response.body.includes('too many request bodies buffered at once'))).toBe(true);
        for (const response of busy) {
          expect(response.headers.connection).toBe('close');
          expect(response.headers['retry-after']).toBe('1');
        }
        const forwarded = responses.filter((response) => response.status === 200);
        // The 64 admitted bodies need 16 MiB at once; the 8 MiB budget cut
        // some of them off, and the rest were forwarded whole.
        expect(forwarded.length).toBeGreaterThan(0);
        expect(forwarded.length).toBeLessThan(maxConcurrentRequests);
        expect(upstream?.requests().map((request) => request.rawBody.length)).toEqual(forwarded.map(() => body.length));

        // Every slot and every buffered byte was returned: a full load that
        // fits both ceilings now succeeds.
        await sleep(200);
        const small = jsonBody(64 * 1024);
        const after = await Promise.all(
          Array.from({ length: maxConcurrentRequests }, async () => {
            const socket = await openTls(BUFFERED_HOST);
            const response = readResponse(socket);
            socket.write(requestHead(BUFFERED_HOST, '/v1/messages', small.length));
            socket.write(small);
            return response;
          }),
        );
        expect(after.map((response) => response.status)).toEqual(after.map(() => 200));
      },
    );

    it('returns the slots of pipelined requests whose connection drops mid-flight', async () => {
      const silent = await startSilentServer();
      upstream = await createFakeUpstream(() => ({ status: 200, body: '{"ok":true}' }));
      proxy = createMitmProxy({
        socketPath,
        ca,
        dnsLookup: localhostDnsLookup,
        allowPrivateDestinationsForTests: true,
        providers: providers(silent, {}, upstream.port),
        resourceLimits: { maxConcurrentRequests: 4 },
      });
      await proxy.start();
      const post = async (host: string, path: string): Promise<RawResponse> => {
        const socket = await openTls(host);
        const response = readResponse(socket);
        const body = jsonBody(256);
        socket.write(requestHead(host, path, body.length));
        socket.write(body);
        return response;
      };

      // Four pipelined requests on one connection, all in flight (the upstream never answers).
      const pipelined = await openTls(BUFFERED_HOST);
      const body = jsonBody(256);
      for (let i = 0; i < 4; i++) {
        pipelined.write(requestHead(BUFFERED_HOST, '/v1/messages', body.length));
        pipelined.write(body);
      }
      await sleep(150);
      expect((await post(STREAMED_HOST, '/v1/complete')).status).toBe(503);

      // Dropping the connection ends all four exchanges, queued responses included.
      pipelined.destroy();
      await sleep(150);
      const after = await Promise.all(Array.from({ length: 4 }, () => post(STREAMED_HOST, '/v1/complete')));
      expect(after.map((response) => response.status)).toEqual([200, 200, 200, 200]);
    });

    /** POST `decoded` gzip-compressed on a buffered route, which decodes it before rewriting. */
    function postCompressed(socket: tls.TLSSocket, decoded: Buffer): Promise<RawResponse> {
      const body = zlib.gzipSync(decoded);
      const response = readResponse(socket);
      socket.write(requestHead(BUFFERED_HOST, '/v1/messages', body.length, { 'content-encoding': 'gzip' }));
      socket.write(body);
      return response;
    }

    it('charges a compressed body to the buffered-byte budget while it decodes, not after', async () => {
      // The budget (1 MiB) is far below the provider limit (4 MiB); the bomb decodes to 8 MiB.
      await startProxy({ limits: { maxBufferedBodyBytes: MIB }, provider: { maxRequestBodyBytes: 4 * MIB } });
      const refused = await postCompressed(await openTls(BUFFERED_HOST), jsonBody(8 * MIB));
      // Decoding stopped at the budget. Charging only the finished output let the
      // decoder run on to the 4 MiB limit (a 413) first, so concurrent bombs each
      // under the limit could together hold many times the budget.
      expect(refused.status).toBe(503);
      expect(refused.headers.connection).toBe('close');
      expect(refused.body).toContain('too many request bodies buffered at once (limit 1 MiB)');
      expect(upstream?.requests()).toHaveLength(0);

      // The partial decode went back to the budget with its exchange.
      const fits = await postCompressed(await openTls(BUFFERED_HOST), jsonBody(512 * 1024));
      expect(fits.status).toBe(200);
      expect(upstream?.requests().map((request) => request.rawBody.length)).toEqual([512 * 1024]);
    });

    it('decodes concurrent compressed bodies in turn, so every body the budget can hold is forwarded', async () => {
      let forwarded = 0;
      const silent = http.createServer((req) => {
        forwarded += 1;
        req.resume();
      });
      servers.push(silent);
      upstream = await createFakeUpstream();
      proxy = createMitmProxy({
        socketPath,
        ca,
        dnsLookup: localhostDnsLookup,
        allowPrivateDestinationsForTests: true,
        providers: providers(await listen(silent), {}, upstream.port),
        resourceLimits: { maxBufferedBodyBytes: 20 * MIB },
      });
      await proxy.start();

      // Three 8 MiB bodies against a 20 MiB budget: two fit. The upstream never
      // answers, so each forwarded body stays charged. Every body is held back
      // by its last byte, then all three complete at once, so their decodes
      // would overlap; interleaved, they race for the budget and more than one
      // can be refused (createSerialRunner's unit test pins the ordering).
      const connections = await Promise.all([0, 1, 2].map(() => openTls(BUFFERED_HOST)));
      const compressed = zlib.gzipSync(jsonBody(8 * MIB));
      let answered = 0;
      const responses = connections.map((socket) => {
        const response = readResponse(socket).then((value) => {
          answered += 1;
          return value;
        });
        response.catch(() => {});
        socket.write(requestHead(BUFFERED_HOST, '/v1/messages', compressed.length, { 'content-encoding': 'gzip' }));
        socket.write(compressed.subarray(0, compressed.length - 1));
        return response;
      });
      await sleep(100);
      for (const socket of connections) socket.write(compressed.subarray(compressed.length - 1));

      const first = await Promise.race(responses);
      expect(first.status).toBe(503);
      expect(first.body).toContain('too many request bodies buffered at once (limit 20 MiB)');
      await eventually(() => forwarded === 2);
      await sleep(100);
      expect(answered).toBe(1);
      expect(forwarded).toBe(2);
    });

    it('answers a CONNECT over the TLS-connection ceiling with a 503', async () => {
      await startProxy({ limits: { maxConcurrentTlsConnections: 2 } });
      await openTls(BUFFERED_HOST);
      await openTls(BUFFERED_HOST);
      const third = await sendConnect(socketPath, BUFFERED_HOST, 443);
      expect(third.statusCode).toBe(503);
    });

    it('answers a passthrough CONNECT over the tunnel ceiling with a 503', async () => {
      const echo = await startEchoServer();
      // Approvals name host:443 (WP-43); the test dialer stands in for the origin.
      const mitm = await startProxy({
        limits: { maxConcurrentTunnels: 2 },
        tunnelDialForTests: localTunnelDialer(echo),
      });
      mitm.hosts.addHost(TUNNEL_HOST);
      const first = await sendConnect(socketPath, TUNNEL_HOST, 443);
      const second = await sendConnect(socketPath, TUNNEL_HOST, 443);
      expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
      const third = await sendConnect(socketPath, TUNNEL_HOST, 443);
      expect(third.statusCode).toBe(503);
      first.socket?.destroy();
      second.socket?.destroy();
    });

    it('counts approved port-80 tunnels against the same ceiling and returns their slots on close', async () => {
      const echo = await startEchoServer();
      const mitm = await startProxy({
        limits: { maxConcurrentTunnels: 2 },
        tunnelDialForTests: localTunnelDialer(echo),
      });
      mitm.hosts.addHost(TUNNEL_HOST);
      mitm.hosts.addHost(PLAIN_TUNNEL_HOST, 80);
      const plain = await openPlainTunnel();
      const raw = await sendConnect(socketPath, TUNNEL_HOST, 443);
      expect(raw.statusCode).toBe(200);
      expect((await sendConnect(socketPath, PLAIN_TUNNEL_HOST, 80)).statusCode).toBe(503);
      expect((await sendConnect(socketPath, TUNNEL_HOST, 443)).statusCode).toBe(503);

      plain.destroy();
      await sleep(150);
      const again = await openPlainTunnel();
      expect(again.destroyed).toBe(false);
      raw.socket?.destroy();
    });

    it('admits requests inside a port-80 tunnel against the request ceiling', async () => {
      const silent = await startSilentServer();
      const mitm = await startProxy({
        limits: { maxConcurrentRequests: 1 },
        outboundTransport: localUpstreamTransport(silent),
      });
      mitm.hosts.addHost(PLAIN_TUNNEL_HOST, 80);
      const first = await openPlainTunnel();
      first.write(`GET /pending HTTP/1.1\r\nHost: ${PLAIN_TUNNEL_HOST}\r\n\r\n`);
      await sleep(150);

      const second = await openPlainTunnel();
      const response = readResponse(second);
      second.write(`GET /next HTTP/1.1\r\nHost: ${PLAIN_TUNNEL_HOST}\r\n\r\n`);
      const answered = await response;
      expect(answered.status).toBe(503);
      expect(answered.body).toContain('too many concurrent requests (limit 1)');
      expect(answered.headers.connection).toBe('close');
    });
  });

  // ── MITM-14: deadlines ──────────────────────────────────────────────

  describe('deadlines', () => {
    it('closes a decrypted connection that never sends a request head', async () => {
      await startProxy({ limits: { requestHeadersTimeoutMs: 200 } });
      const socket = await openTls(BUFFERED_HOST);
      await expect(closedWithin(socket, 3_000)).resolves.toBeGreaterThanOrEqual(150);
    });

    it('closes a connection dripping its request head byte by byte', async () => {
      await startProxy({ limits: { requestHeadersTimeoutMs: 300 } });
      const socket = await openTls(BUFFERED_HOST);
      // A valid head, one byte every 20 ms: it would take seconds to complete.
      const head = requestHead(BUFFERED_HOST, '/v1/messages', 2);
      expect(head.length * 20).toBeGreaterThan(2_000);
      const closed = closedWithin(socket, 5_000);
      // Each byte would rearm an idle timer; the head deadline still fires.
      let sent = 0;
      const drip = setInterval(() => {
        if (!socket.destroyed && sent < head.length) socket.write(head[sent++]);
      }, 20);
      try {
        await expect(closed).resolves.toBeGreaterThanOrEqual(250);
      } finally {
        clearInterval(drip);
      }
    });

    it('closes a decrypted connection with no traffic in either direction', async () => {
      // An upstream that accepts the request and never answers; only the
      // connection idle deadline is short.
      const port = await startSilentServer();
      upstream = await createFakeUpstream();
      proxy = createMitmProxy({
        socketPath,
        ca,
        dnsLookup: localhostDnsLookup,
        allowPrivateDestinationsForTests: true,
        providers: providers(port),
        resourceLimits: { connectionIdleTimeoutMs: 300 },
      });
      await proxy.start();
      const socket = await openTls(BUFFERED_HOST);
      const body = jsonBody(1024);
      socket.write(requestHead(BUFFERED_HOST, '/v1/messages', body.length));
      socket.write(body);
      await expect(closedWithin(socket, 5_000)).resolves.toBeGreaterThanOrEqual(250);
    });

    it('answers a stalled request body with a 408', async () => {
      await startProxy({ limits: { requestBodyIdleTimeoutMs: 200 } });
      const socket = await openTls(BUFFERED_HOST);
      const response = readResponse(socket);
      socket.write(requestHead(BUFFERED_HOST, '/v1/messages', 4096));
      socket.write('{"model":');
      const answered = await response;
      expect(answered.status).toBe(408);
      expect(answered.headers.connection).toBe('close');
      expect(upstream?.requests()).toHaveLength(0);
    });

    it('answers 504 when the upstream sends no response in time', async () => {
      const port = await startSilentServer();
      upstream = await createFakeUpstream();
      proxy = createMitmProxy({
        socketPath,
        ca,
        dnsLookup: localhostDnsLookup,
        allowPrivateDestinationsForTests: true,
        providers: providers(port),
        resourceLimits: { upstreamResponseHeadersTimeoutMs: 200 },
      });
      await proxy.start();
      const socket = await openTls(BUFFERED_HOST);
      const response = readResponse(socket);
      const body = jsonBody(1024);
      socket.write(requestHead(BUFFERED_HOST, '/v1/messages', body.length));
      socket.write(body);
      const answered = await response;
      expect(answered.status).toBe(504);
      expect(answered.body).toContain('Upstream timeout');
    });

    it('drops the client connection when the upstream stalls mid-response', async () => {
      const stalling = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: ping\ndata: {}\n\n');
        // ...and never another byte.
      });
      servers.push(stalling);
      const port = await listen(stalling);
      upstream = await createFakeUpstream();
      proxy = createMitmProxy({
        socketPath,
        ca,
        dnsLookup: localhostDnsLookup,
        allowPrivateDestinationsForTests: true,
        providers: providers(port),
        resourceLimits: { upstreamIdleTimeoutMs: 300 },
      });
      await proxy.start();
      const socket = await openTls(BUFFERED_HOST);
      const body = jsonBody(1024);
      socket.write(requestHead(BUFFERED_HOST, '/v1/messages', body.length));
      socket.write(body);
      await expect(closedWithin(socket, 5_000)).resolves.toBeGreaterThanOrEqual(250);
    });

    it('closes an idle passthrough tunnel but keeps one with traffic open', async () => {
      const echo = await startEchoServer();
      const mitm = await startProxy({
        limits: { tunnelIdleTimeoutMs: 300 },
        tunnelDialForTests: localTunnelDialer(echo),
      });
      mitm.hosts.addHost(TUNNEL_HOST);
      const idle = await sendConnect(socketPath, TUNNEL_HOST, 443);
      const busy = await sendConnect(socketPath, TUNNEL_HOST, 443);
      if (idle.socket === null || busy.socket === null) throw new Error('CONNECT refused');
      // A 443 approval is relayed once the ClientHello names the approved host
      // (WP-43); the idle deadline runs from then on.
      idle.socket.write(buildClientHelloRecord(TUNNEL_HOST));
      const busySocket = busy.socket;
      busySocket.on('data', () => {});
      busySocket.write(buildClientHelloRecord(TUNNEL_HOST));
      const keepAlive = setInterval(() => busySocket.write('ping'), 100);
      try {
        await expect(closedWithin(idle.socket, 5_000)).resolves.toBeGreaterThanOrEqual(250);
        expect(busySocket.destroyed).toBe(false);
      } finally {
        clearInterval(keepAlive);
        busySocket.destroy();
      }
    });

    it('closes a port-80 tunnel that never sends a request head', async () => {
      const mitm = await startProxy({ limits: { requestHeadersTimeoutMs: 200 } });
      mitm.hosts.addHost(PLAIN_TUNNEL_HOST, 80);
      const socket = await openPlainTunnel();
      await expect(closedWithin(socket, 3_000)).resolves.toBeGreaterThanOrEqual(150);
    });

    it('holds the request-head deadline of a port-80 tunnel while its request is in flight', async () => {
      const slow = http.createServer((_req, res) => {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '2' });
          res.end('ok');
        }, 600);
      });
      servers.push(slow);
      const port = await listen(slow);
      const mitm = await startProxy({
        limits: { requestHeadersTimeoutMs: 200 },
        outboundTransport: localUpstreamTransport(port),
      });
      mitm.hosts.addHost(PLAIN_TUNNEL_HOST, 80);
      const socket = await openPlainTunnel();
      const response = readResponse(socket);
      socket.write(`GET /slow HTTP/1.1\r\nHost: ${PLAIN_TUNNEL_HOST}\r\n\r\n`);
      const answered = await response;
      expect(answered.status).toBe(200);
      expect(answered.body).toBe('ok');
      // With the response sent, the connection waits for its next head again.
      await expect(closedWithin(socket, 3_000)).resolves.toBeGreaterThanOrEqual(150);
    });

    it('keeps a WebSocket bridged inside a port-80 tunnel open past the request-head deadline', async () => {
      const wsPort = await startWebSocketEchoServer();
      const mitm = await startProxy({
        limits: { requestHeadersTimeoutMs: 200 },
        outboundTransport: localUpstreamTransport(wsPort),
      });
      mitm.hosts.addHost(PLAIN_TUNNEL_HOST, 80);
      const socket = await openPlainTunnel();
      const switched = new Promise<string>((resolve) => {
        let data = '';
        const onData = (chunk: Buffer): void => {
          data += chunk.toString('latin1');
          if (!data.includes('\r\n\r\n')) return;
          socket.off('data', onData);
          resolve(data);
        };
        socket.on('data', onData);
      });
      socket.write(
        `GET /ws HTTP/1.1\r\nHost: ${PLAIN_TUNNEL_HOST}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${Buffer.from(randomUUID()).subarray(0, 16).toString('base64')}\r\n` +
          'Sec-WebSocket-Version: 13\r\n\r\n',
      );
      expect(await switched).toContain('101 Switching Protocols');

      await sleep(500);
      expect(socket.destroyed).toBe(false);
      const frame = Buffer.from([0x81, 0x02, 0x68, 0x69]);
      const echoed = new Promise<Buffer>((resolve) => socket.once('data', resolve));
      socket.write(frame);
      expect(await echoed).toEqual(frame);
    });
  });

  // ── MITM-14: capture tee ────────────────────────────────────────────

  describe('trajectory capture tee', () => {
    let writer: TrajectoryCaptureWriter | undefined;

    afterEach(async () => {
      await writer?.close();
      writer = undefined;
    });

    it('drops only the exchange whose streamed request outgrows the tee, and still forwards it', async () => {
      const capturesDir = join(tempDir, 'captures');
      writer = createTrajectoryCaptureWriter({ capturesDir });
      const sessionId = 'sess-tee-limit' as SessionId;
      writer.beginSession({ sessionId });
      const mitm = await startProxy({ capture: writer, provider: { maxRequestBodyBytes: 64 * 1024 } });
      mitm.setCaptureSessionId(sessionId);

      async function post(body: Buffer): Promise<RawResponse> {
        const socket = await openTls(STREAMED_HOST);
        const response = readResponse(socket);
        socket.write(requestHead(STREAMED_HOST, '/v1/complete', body.length));
        socket.write(body);
        return response;
      }
      const oversized = jsonBody(256 * 1024);
      const small = jsonBody(1024);
      expect((await post(oversized)).status).toBe(200);
      expect((await post(small)).status).toBe(200);
      await writer.endSession(sessionId);

      // The streamed route forwards without a size limit; only the tee is bounded.
      expect(upstream?.requests().map((request) => request.rawBody.length)).toEqual([oversized.length, small.length]);
      const records = readFileSync(join(capturesDir, `${sessionId}.jsonl`), 'utf-8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as ExchangeRecord);
      expect(records.map((record) => record.request.bodyBytes)).toEqual([small.length]);
      const manifest = readFileSync(join(capturesDir, 'manifest.jsonl'), 'utf-8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as ManifestEntry);
      const end = manifest.find((entry) => entry.event === 'session-end' && entry.sessionId === sessionId);
      expect(end).toMatchObject({ exchanges: 1, abortedExchanges: 1, poisoned: false });
    });
  });

  // ── Refusal log lines: credential query values (MITM-20) ────────────

  describe('refusal log lines', () => {
    it('name a body-limit or decode-budget refusal without the value of a credential query parameter', async () => {
      const logFilePath = join(tempDir, 'session.log');
      logger.setup({ logFilePath });
      try {
        // A body declared over the 64 KiB limit gets the 413; a small gzip body
        // that decodes past the 32 KiB budget (and under the limit) the 503.
        await startProxy({ limits: { maxBufferedBodyBytes: 32 * 1024 }, provider: { maxRequestBodyBytes: 64 * 1024 } });
        // The sentinel may travel in a credential query parameter.
        const path = `/v1/messages?beta=true&key=${FAKE_KEY}`;

        const oversized = jsonBody(70 * 1024);
        const first = await openTls(BUFFERED_HOST);
        const tooLarge = readResponse(first);
        first.write(requestHead(BUFFERED_HOST, path, oversized.length));
        first.write(oversized);
        expect((await tooLarge).status).toBe(413);

        const compressed = zlib.gzipSync(jsonBody(60 * 1024));
        const second = await openTls(BUFFERED_HOST);
        const overBudget = readResponse(second);
        second.write(requestHead(BUFFERED_HOST, path, compressed.length, { 'content-encoding': 'gzip' }));
        second.write(compressed);
        expect((await overBudget).status).toBe(503);
        expect(upstream?.requests()).toHaveLength(0);
      } finally {
        logger.teardown();
      }
      const log = readFileSync(logFilePath, 'utf-8');
      expect(log).toContain(`413 POST ${BUFFERED_HOST}/v1/messages?beta=true&key=<redacted> - request body`);
      expect(log).toContain(`503 POST ${BUFFERED_HOST}/v1/messages?beta=true&key=<redacted> - decoding the gzip body`);
      expect(log).not.toContain(FAKE_KEY);
    });

    it('name a request refused at the concurrency ceiling without the value of a credential query parameter', async () => {
      const logFilePath = join(tempDir, 'session.log');
      logger.setup({ logFilePath });
      try {
        const silent = await startSilentServer();
        proxy = createMitmProxy({
          socketPath,
          ca,
          dnsLookup: localhostDnsLookup,
          allowPrivateDestinationsForTests: true,
          providers: providers(silent),
          resourceLimits: { maxConcurrentRequests: 1 },
        });
        await proxy.start();
        const body = jsonBody(256);
        // The upstream never answers, so this request holds the only slot.
        const held = await openTls(BUFFERED_HOST);
        held.write(requestHead(BUFFERED_HOST, '/v1/messages', body.length));
        held.write(body);
        await sleep(150);

        // Refused at admission, before the credential gate has looked at it.
        const refusedSocket = await openTls(BUFFERED_HOST);
        const refused = readResponse(refusedSocket);
        refusedSocket.write(requestHead(BUFFERED_HOST, '/v1/messages?api_key=AGENT-QUERY-SECRET', body.length));
        refusedSocket.write(body);
        expect((await refused).status).toBe(503);
      } finally {
        logger.teardown();
      }
      const log = readFileSync(logFilePath, 'utf-8');
      expect(log).toContain(`503 POST ${BUFFERED_HOST}/v1/messages?api_key=<redacted> - 1 requests already in flight`);
      expect(log).not.toContain('AGENT-QUERY-SECRET');
    });
  });

  async function listen(server: http.Server | net.Server): Promise<number> {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  }

  /** A TCP server that echoes every byte (a passthrough tunnel destination). */
  async function startEchoServer(): Promise<number> {
    const server = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.pipe(socket);
    });
    servers.push(server);
    return listen(server);
  }

  /** An HTTP server that accepts every WebSocket upgrade and echoes the bridged bytes. */
  async function startWebSocketEchoServer(): Promise<number> {
    const server = http.createServer((_req, res) => res.end());
    server.on('upgrade', (req: http.IncomingMessage, socket: Socket) => {
      const accept = createHash('sha1')
        .update(`${String(req.headers['sec-websocket-key'])}258EAFA5-E914-47DA-95CA-5AB5DA085CD6`)
        .digest('base64');
      socket.on('error', () => {});
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      socket.pipe(socket);
    });
    servers.push(server);
    return listen(server);
  }

  /** An HTTP server that reads requests and never answers them. */
  async function startSilentServer(): Promise<number> {
    const server = http.createServer((req) => {
      req.resume();
    });
    servers.push(server);
    return listen(server);
  }
});
