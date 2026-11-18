/**
 * In-process tests for the fetch server's destination guard
 * (src/servers/guarded-fetch.ts). Names resolve through an injected stub
 * resolver, so nothing here touches real DNS or the network; every server is
 * a loopback fake.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type * as dns from 'node:dns';
import { createServer, type IncomingHttpHeaders, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  guardedFetch,
  MAX_SAME_ORIGIN_REDIRECTS,
  type GuardedFetchError,
  type GuardedFetchOptions,
} from '../src/servers/guarded-fetch.js';

interface RecordedRequest {
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
}

let server: HttpServer;
let port: number;
let origin: string;
let requests: RecordedRequest[] = [];

/** A second loopback server: a cross-origin redirect target that must never be hit. */
let otherServer: HttpServer;
let otherOrigin: string;
let otherHits = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '/';
    requests.push({ url, headers: req.headers });
    const chain = /^\/chain\/(\d+)$/u.exec(url);
    if (chain) {
      const remaining = Number(chain[1]);
      if (remaining === 0) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('end of chain');
      } else {
        res.writeHead(302, { Location: `/chain/${remaining - 1}` });
        res.end('redirecting');
      }
      return;
    }
    switch (url) {
      case '/ok':
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
      case '/cross-origin':
        res.writeHead(302, { Location: `${otherOrigin}/secret` });
        res.end();
        return;
      case '/to-localhost':
        // Same port, different host: a different origin.
        res.writeHead(301, { Location: `http://localhost:${port}/ok` });
        res.end();
        return;
      case '/to-metadata':
        res.writeHead(307, { Location: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/' });
        res.end();
        return;
      case '/to-https':
        res.writeHead(308, { Location: `https://127.0.0.1:${port}/ok` });
        res.end();
        return;
      case '/bad-location':
        res.writeHead(302, { Location: 'http://[not-an-ip/' });
        res.end();
        return;
      case '/credential-redirect':
        res.writeHead(302, { Location: `http://user:pass@127.0.0.1:${port}/ok` });
        res.end();
        return;
      case '/no-location':
        res.writeHead(302, { 'Content-Type': 'text/plain' });
        res.end('a 302 without a Location');
        return;
      case '/big':
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('x'.repeat(5000));
        return;
      case '/png':
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
        return;
      case '/slow':
        return; // never answers
      default:
        res.writeHead(404);
        res.end('not found');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;

  otherServer = createServer((_req, res) => {
    otherHits += 1;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('{"access_token":"SECRET"}');
  });
  await new Promise<void>((resolve) => otherServer.listen(0, '127.0.0.1', resolve));
  otherOrigin = `http://127.0.0.1:${(otherServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  otherServer.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => otherServer.close(() => resolve()));
});

beforeEach(() => {
  requests = [];
  otherHits = 0;
});

/** Resolver stub with fixed answers that records every name it is asked for. */
function stubResolver(answers: Readonly<Record<string, readonly string[]>>): {
  lookup: typeof dns.lookup;
  asked: string[];
} {
  const asked: string[] = [];
  const lookup = ((
    hostname: string,
    _options: dns.LookupOptions,
    callback: (error: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void,
  ): void => {
    asked.push(hostname);
    const addresses = Object.hasOwn(answers, hostname) ? answers[hostname] : undefined;
    if (addresses === undefined) {
      const error: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
      error.code = 'ENOTFOUND';
      callback(error, []);
      return;
    }
    callback(
      null,
      addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
    );
  }) as typeof dns.lookup;
  return { lookup, asked };
}

function options(overrides: Partial<GuardedFetchOptions> = {}): GuardedFetchOptions {
  return {
    userAgent: 'IronCurtain-test',
    timeoutMs: 10_000,
    maxBodyBytes: 1_000_000,
    allowPrivateLiterals: false,
    // Fail loudly if a test unexpectedly reaches the real resolver.
    lookup: stubResolver({}).lookup,
    ...overrides,
  };
}

async function fetchError(promise: Promise<unknown>): Promise<GuardedFetchError> {
  try {
    await promise;
  } catch (err) {
    return err as GuardedFetchError;
  }
  throw new Error('expected guardedFetch to reject');
}

function text(body: Uint8Array | undefined): string {
  return new TextDecoder().decode(body);
}

describe('guardedFetch destination screening', () => {
  it('refuses a hostname that resolves to loopback, even with the private-network opt-in', async () => {
    for (const allowPrivateLiterals of [false, true]) {
      const resolver = stubResolver({ 'loopback.test': ['127.0.0.1'] });
      const error = await fetchError(
        guardedFetch(`http://loopback.test:${port}/ok`, options({ lookup: resolver.lookup, allowPrivateLiterals })),
      );
      expect(error.code).toBe('DESTINATION_NOT_ALLOWED');
      expect(error.message).toMatch(/non-public address/u);
      expect(resolver.asked).toEqual(['loopback.test']);
    }
    expect(requests).toHaveLength(0);
  });

  it('refuses a rebinding answer set that mixes a public and a private address', async () => {
    const resolver = stubResolver({ 'rebind.test': ['93.184.216.34', '169.254.169.254'] });
    const error = await fetchError(guardedFetch(`http://rebind.test:${port}/ok`, options({ lookup: resolver.lookup })));
    expect(error.code).toBe('DESTINATION_NOT_ALLOWED');
    expect(requests).toHaveLength(0);
  });

  it('screens names at connect time for https too', async () => {
    const resolver = stubResolver({ 'loopback.test': ['::1'] });
    const error = await fetchError(
      guardedFetch(`https://loopback.test:${port}/`, options({ lookup: resolver.lookup })),
    );
    expect(error.code).toBe('DESTINATION_NOT_ALLOWED');
    expect(resolver.asked).toEqual(['loopback.test']);
  });

  it.each([
    ['loopback IPv4', () => `${origin}/ok`],
    ['decimal IPv4', () => `http://2130706433:${port}/ok`],
    ['short hex IPv4', () => `http://0x7f.1:${port}/ok`],
    ['IPv4-mapped IPv6', () => `http://[::ffff:127.0.0.1]:${port}/ok`],
    ['IPv6 loopback', () => `http://[::1]:${port}/ok`],
    ['RFC 1918', () => 'http://10.0.0.1/'],
  ])('refuses a %s literal without the opt-in, before any lookup', async (_label, url) => {
    const resolver = stubResolver({});
    const error = await fetchError(guardedFetch(url(), options({ lookup: resolver.lookup })));
    expect(error.code).toBe('DESTINATION_NOT_ALLOWED');
    expect(resolver.asked).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  it.each([
    ['cloud metadata IPv4', 'http://169.254.169.254/latest/meta-data/'],
    ['metadata as IPv4-mapped IPv6', 'http://[::ffff:a9fe:a9fe]/'],
    ['metadata address inside CGNAT (Alibaba Cloud)', 'http://100.100.100.200/latest/meta-data/'],
    ['metadata address inside ULA (AWS IPv6)', 'http://[fd00:ec2::254]/latest/meta-data/'],
    ['credential endpoint inside ULA (AWS EKS Pod Identity)', 'http://[fd00:ec2::23]/'],
    ['metadata address inside ULA (Google Cloud IPv6)', 'http://[fd20:ce::254]/computeMetadata/v1/'],
    ['metadata address inside ULA (Oracle Cloud IPv6)', 'http://[fd00:c1::a9fe:a9fe]/opc/v2/'],
    ['metadata address inside ULA (Akamai IPv6)', 'http://[fd00:a9fe:a9fe::1]/'],
    ['metadata address inside ULA (Scaleway IPv6)', 'http://[fd00:42::42]/'],
    ['Azure WireServer (a public address)', 'http://168.63.129.16/'],
    ['link-local IPv6', 'http://[fe80::1]/'],
    ['unspecified address', 'http://0.0.0.0/'],
    ['metadata hostname', 'http://metadata.google.internal/computeMetadata/v1/'],
    ['internal hostname', 'http://service.internal/'],
    ['mDNS hostname', 'http://printer.local/'],
  ])('refuses a %s even with the private-network opt-in', async (_label, url) => {
    const resolver = stubResolver({});
    const error = await fetchError(guardedFetch(url, options({ lookup: resolver.lookup, allowPrivateLiterals: true })));
    expect(error.code).toBe('DESTINATION_NOT_ALLOWED');
    expect(resolver.asked).toEqual([]);
  });

  it("refuses Azure's WireServer, a public address, as a literal or a DNS answer in every mode", async () => {
    for (const allowPrivateLiterals of [false, true]) {
      const literal = await fetchError(
        guardedFetch('http://[::ffff:168.63.129.16]/', options({ allowPrivateLiterals, timeoutMs: 2000 })),
      );
      expect(literal.code).toBe('DESTINATION_NOT_ALLOWED');

      for (const answer of ['168.63.129.16', '64:ff9b::a83f:8110']) {
        const resolver = stubResolver({ 'wire.test': [answer] });
        const error = await fetchError(
          guardedFetch(
            `http://wire.test:${port}/`,
            options({ lookup: resolver.lookup, allowPrivateLiterals, timeoutMs: 2000 }),
          ),
        );
        expect(error.code).toBe('DESTINATION_NOT_ALLOWED');
        expect(error.message).toMatch(/metadata address/u);
        expect(resolver.asked).toEqual(['wire.test']);
      }
    }
  });

  it('refuses localhost without the opt-in, before any lookup', async () => {
    const resolver = stubResolver({ localhost: ['127.0.0.1'] });
    const error = await fetchError(guardedFetch(`http://localhost:${port}/ok`, options({ lookup: resolver.lookup })));
    expect(error.code).toBe('DESTINATION_NOT_ALLOWED');
    expect(resolver.asked).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  it('with the opt-in, fetches a private literal named by the URL', async () => {
    const result = await guardedFetch(`${origin}/ok`, options({ allowPrivateLiterals: true }));
    expect(result.kind).toBe('response');
    expect(result.status).toBe(200);
    expect(result.url).toBe(`${origin}/ok`);
    expect(result.kind === 'response' ? text(result.body) : '').toBe('ok');
  });

  it('with the opt-in, pins localhost to loopback without consulting the resolver', async () => {
    const resolver = stubResolver({ localhost: ['93.184.216.34'] });
    const result = await guardedFetch(
      `http://localhost:${port}/ok`,
      options({ lookup: resolver.lookup, allowPrivateLiterals: true }),
    );
    expect(result.status).toBe(200);
    expect(resolver.asked).toEqual([]);
    expect(requests.map((request) => request.headers.host)).toEqual([`localhost:${port}`]);
  });

  it.each([
    ['file:///etc/passwd', 'INVALID_URL'],
    ['ftp://example.com/', 'INVALID_URL'],
    ['not a url', 'INVALID_URL'],
    ['http://user:secret@example.com/', 'INVALID_URL'],
  ])('refuses %s', async (url, code) => {
    const error = await fetchError(guardedFetch(url, options()));
    expect(error.code).toBe(code);
  });
});

describe('guardedFetch redirects', () => {
  it(`follows up to ${MAX_SAME_ORIGIN_REDIRECTS} same-origin redirects, re-sending the agent's headers`, async () => {
    const result = await guardedFetch(
      `${origin}/chain/${MAX_SAME_ORIGIN_REDIRECTS}`,
      options({ allowPrivateLiterals: true, headers: { 'X-Agent': 'yes' } }),
    );
    expect(result.kind).toBe('response');
    expect(result.status).toBe(200);
    expect(result.url).toBe(`${origin}/chain/0`);
    expect(result.redirects).toHaveLength(MAX_SAME_ORIGIN_REDIRECTS);
    expect(result.redirects[0]).toEqual({
      status: 302,
      url: `${origin}/chain/${MAX_SAME_ORIGIN_REDIRECTS}`,
      location: `${origin}/chain/${MAX_SAME_ORIGIN_REDIRECTS - 1}`,
    });
    expect(requests).toHaveLength(MAX_SAME_ORIGIN_REDIRECTS + 1);
    expect(requests.every((request) => request.headers['x-agent'] === 'yes')).toBe(true);
  });

  it(`refuses redirect ${MAX_SAME_ORIGIN_REDIRECTS + 1} and never requests its target`, async () => {
    const error = await fetchError(
      guardedFetch(`${origin}/chain/${MAX_SAME_ORIGIN_REDIRECTS + 1}`, options({ allowPrivateLiterals: true })),
    );
    expect(error.code).toBe('REDIRECT_LIMIT');
    expect(error.redirects).toHaveLength(MAX_SAME_ORIGIN_REDIRECTS);
    expect(error.url).toBe(`${origin}/chain/1`);
    expect(error.location).toBe(`${origin}/chain/0`);
    expect(requests.map((request) => request.url)).not.toContain('/chain/0');
  });

  it('returns a cross-origin redirect to a loopback service without following it', async () => {
    const result = await guardedFetch(
      `${origin}/cross-origin`,
      options({ allowPrivateLiterals: true, headers: { 'Metadata-Flavor': 'Google' } }),
    );
    expect(result).toMatchObject({
      kind: 'cross-origin-redirect',
      status: 302,
      url: `${origin}/cross-origin`,
      location: `${otherOrigin}/secret`,
      redirects: [],
    });
    expect(otherHits).toBe(0);
  });

  it('returns a redirect to the cloud metadata address without following it', async () => {
    const result = await guardedFetch(`${origin}/to-metadata`, options({ allowPrivateLiterals: true }));
    expect(result.kind).toBe('cross-origin-redirect');
    expect(result.status).toBe(307);
    expect(result.kind === 'cross-origin-redirect' ? result.location : '').toBe(
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    );
  });

  it('treats a different host or scheme on the same port as another origin', async () => {
    const toLocalhost = await guardedFetch(`${origin}/to-localhost`, options({ allowPrivateLiterals: true }));
    expect(toLocalhost.kind).toBe('cross-origin-redirect');
    const toHttps = await guardedFetch(`${origin}/to-https`, options({ allowPrivateLiterals: true }));
    expect(toHttps.kind).toBe('cross-origin-redirect');
    expect(requests.map((request) => request.url)).toEqual(['/to-localhost', '/to-https']);
  });

  it('refuses an unparseable Location and a same-origin Location with credentials', async () => {
    const bad = await fetchError(guardedFetch(`${origin}/bad-location`, options({ allowPrivateLiterals: true })));
    expect(bad.code).toBe('INVALID_REDIRECT');
    const credentials = await fetchError(
      guardedFetch(`${origin}/credential-redirect`, options({ allowPrivateLiterals: true })),
    );
    expect(credentials.code).toBe('INVALID_REDIRECT');
    expect(requests.map((request) => request.url)).toEqual(['/bad-location', '/credential-redirect']);
  });

  it('returns a 3xx without a Location as an ordinary response', async () => {
    const result = await guardedFetch(`${origin}/no-location`, options({ allowPrivateLiterals: true }));
    expect(result.kind).toBe('response');
    expect(result.status).toBe(302);
    expect(result.kind === 'response' ? text(result.body) : '').toBe('a 302 without a Location');
  });
});

describe('guardedFetch requests and bodies', () => {
  it('always sends its own User-Agent, whatever spelling the agent used', async () => {
    await guardedFetch(
      `${origin}/ok`,
      options({ allowPrivateLiterals: true, headers: { 'user-agent': 'spoofed', 'USER-AGENT': 'spoofed-too' } }),
    );
    expect(requests[0].headers['user-agent']).toBe('IronCurtain-test');
  });

  it('sends the Host of the requested URL, not an agent-supplied one', async () => {
    await guardedFetch(
      `${origin}/ok`,
      options({ allowPrivateLiterals: true, headers: { Host: 'metadata.google.internal' } }),
    );
    expect(requests[0].headers.host).toBe(`127.0.0.1:${port}`);
  });

  it('reports why a connect failed, for every address it tried', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const closedPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    // localhost is pinned to 127.0.0.1 and ::1, so Node tries both.
    const error = await fetchError(
      guardedFetch(`http://localhost:${closedPort}/`, options({ allowPrivateLiterals: true })),
    );
    expect(error.code).toBe('FETCH_FAILED');
    expect(error.message).toContain(`127.0.0.1:${closedPort}`);
  });

  it('rejects headers undici cannot send', async () => {
    const error = await fetchError(
      guardedFetch(`${origin}/ok`, options({ allowPrivateLiterals: true, headers: { 'bad header': 'x' } })),
    );
    expect(error.code).toBe('INVALID_HEADERS');
    expect(requests).toHaveLength(0);
  });

  it('enforces the body size cap', async () => {
    const error = await fetchError(
      guardedFetch(`${origin}/big`, options({ allowPrivateLiterals: true, maxBodyBytes: 1000 })),
    );
    expect(error.code).toBe('RESPONSE_TOO_LARGE');
  });

  it('discards a body the caller declines', async () => {
    const seen: (string | null)[] = [];
    const result = await guardedFetch(
      `${origin}/png`,
      options({
        allowPrivateLiterals: true,
        readBody: (contentType) => {
          seen.push(contentType);
          return false;
        },
      }),
    );
    expect(result.kind).toBe('response');
    expect(result.kind === 'response' ? result.body : 'unexpected').toBeUndefined();
    expect(seen).toEqual(['image/png']);
  });

  it('times out the whole call', async () => {
    const error = await fetchError(
      guardedFetch(`${origin}/slow`, options({ allowPrivateLiterals: true, timeoutMs: 300 })),
    );
    expect(error.code).toBe('TIMEOUT');
    expect(error.message).toMatch(/abort/iu);
  });
});
