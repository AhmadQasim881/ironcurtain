/** Authenticated access to one fixed, loopback-only Signal bridge. */
import { WebSocket, type ClientOptions } from 'ws';
import type { ConnectionOptions } from 'node:tls';
import { Agent, fetch as bridgeFetch } from 'undici';

export interface SignalBridgeClient {
  request(path: string, init?: RequestInit): Promise<Response>;
  openReceive(botNumber: string): WebSocket;
  close(): void;
}

const REQUEST_TIMEOUT_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export function createSignalBridgeClient(
  baseUrl: string,
  token: string,
  options: { readonly ca: string },
): SignalBridgeClient {
  if (!/^[a-f0-9]{64}$/u.test(token)) throw new Error('Invalid Signal bridge credential');
  if (typeof options.ca !== 'string' || options.ca.length === 0)
    throw new Error('Signal bridge requires a pinned TLS issuer');
  let endpoint: URL;
  try {
    endpoint = new URL(baseUrl);
  } catch {
    throw new Error('Signal bridge requires a fixed loopback HTTPS origin');
  }
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.hostname !== '127.0.0.1' ||
    endpoint.username !== '' ||
    endpoint.password !== '' ||
    endpoint.pathname !== '/' ||
    endpoint.search !== '' ||
    endpoint.hash !== '' ||
    (baseUrl !== endpoint.origin && baseUrl !== `${endpoint.origin}/`)
  ) {
    throw new Error('Signal bridge requires a fixed loopback HTTPS origin');
  }
  const origin = endpoint.origin;
  const authorization = `Bearer ${token}`;
  const lifetime = new AbortController();
  const sockets = new Set<WebSocket>();
  const agent = new Agent({
    connect: { ca: options.ca, servername: 'localhost', rejectUnauthorized: true, timeout: HANDSHAKE_TIMEOUT_MS },
    headersTimeout: REQUEST_TIMEOUT_MS,
    bodyTimeout: REQUEST_TIMEOUT_MS,
    connections: 8,
  });

  function resolvePath(path: string): URL {
    if (
      path.length > 2048 ||
      !path.startsWith('/') ||
      path.startsWith('//') ||
      /[\\?#\s]/u.test(path) ||
      Array.from(path).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    ) {
      throw new Error('Signal bridge requires a relative API path');
    }
    const url = new URL(path, origin);
    if (url.origin !== origin || url.href !== `${origin}${path}`) {
      throw new Error('Signal bridge requires a canonical relative API path');
    }
    return url;
  }

  function assertOpen(): void {
    if (lifetime.signal.aborted) throw new Error('Signal bridge client is closed');
  }

  return {
    async request(path, init = {}): Promise<Response> {
      assertOpen();
      const url = resolvePath(path);
      const headers = new Headers(init.headers);
      headers.set('Authorization', authorization);
      const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const signal = AbortSignal.any([
        lifetime.signal,
        deadline,
        ...(init.signal === undefined || init.signal === null ? [] : [init.signal]),
      ]);
      try {
        if (init.body !== undefined && init.body !== null && typeof init.body !== 'string') {
          throw new Error('Signal bridge requires a JSON string body');
        }
        const request = {
          ...(init.method !== undefined ? { method: init.method } : {}),
          ...(init.body !== undefined ? { body: init.body } : {}),
          headers: Object.fromEntries(headers.entries()),
          redirect: 'error' as const,
          signal,
          dispatcher: agent,
        };
        const response = await bridgeFetch(url, request);
        // Materialize a bounded body before clearing the request's lifetime.
        // Callers can then use json()/text() without retaining an unbounded stream.
        const chunks: Uint8Array[] = [];
        let total = 0;
        const reader = response.body?.getReader();
        if (reader !== undefined) {
          try {
            for (;;) {
              const next = await reader.read();
              if (next.done) break;
              const chunk: unknown = next.value;
              if (!(chunk instanceof Uint8Array)) {
                await reader.cancel();
                throw new Error('Signal bridge returned a non-byte body');
              }
              total += chunk.byteLength;
              if (total > MAX_RESPONSE_BYTES) {
                await reader.cancel();
                throw new Error('Signal bridge response exceeds its limit');
              }
              chunks.push(chunk);
            }
          } finally {
            reader.releaseLock();
          }
        }
        const body = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const responseHeaders = new Headers(Object.fromEntries(response.headers.entries()));
        responseHeaders.delete('content-encoding');
        responseHeaders.delete('content-length');
        return new Response(response.body === null ? null : body, {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
        });
      } catch {
        // Fetch/upgrade errors and upstream bodies must not become a credential
        // diagnostic channel. The public error never includes headers or URLs.
        throw new Error('Signal bridge request failed');
      }
    },

    openReceive(botNumber): WebSocket {
      assertOpen();
      if (!/^\+\d{7,15}$/u.test(botNumber)) throw new Error('Invalid Signal bot number');
      const url = resolvePath(`/v1/receive/${encodeURIComponent(botNumber)}`);
      url.protocol = 'wss:';
      const socketOptions: ClientOptions & ConnectionOptions = {
        headers: { Authorization: authorization },
        followRedirects: false,
        handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
        maxPayload: MAX_RESPONSE_BYTES,
        ca: options.ca,
        servername: 'localhost',
        rejectUnauthorized: true,
      };
      const socket = new WebSocket(url, socketOptions);
      sockets.add(socket);
      // A close during an unfinished upgrade emits an error before callers may
      // have installed their own handlers. It remains observable to them.
      socket.on('error', () => {});
      socket.once('close', () => sockets.delete(socket));
      return socket;
    },

    close(): void {
      if (lifetime.signal.aborted) return;
      lifetime.abort();
      for (const socket of sockets) socket.terminate();
      sockets.clear();
      void agent.destroy().catch(() => {});
    },
  };
}
