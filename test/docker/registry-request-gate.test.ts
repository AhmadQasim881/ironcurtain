import { describe, expect, it } from 'vitest';
import {
  buildReadOnlyUpstreamHeaders,
  checkRegistryRequestMethodAndBody,
  READ_ONLY_REQUEST_HEADERS,
} from '../../src/docker/registry-request-gate.js';
import { CREDENTIAL_HEADERS } from '../../src/docker/package-egress-proxy.js';

describe('checkRegistryRequestMethodAndBody', () => {
  it.each(['GET', 'HEAD'])('admits a bodiless %s', (method) => {
    expect(checkRegistryRequestMethodAndBody(method, {})).toEqual({ ok: true, method });
  });

  it('admits a GET that declares an empty body with Content-Length: 0', () => {
    expect(checkRegistryRequestMethodAndBody('GET', { 'content-length': '0' })).toEqual({ ok: true, method: 'GET' });
  });

  it.each(['PUT', 'POST', 'DELETE', 'PATCH', 'OPTIONS', 'TRACE', 'PROPFIND', 'get', '', undefined])(
    'refuses method %s',
    (method) => {
      const result = checkRegistryRequestMethodAndBody(method, {});
      expect(result.ok).toBe(false);
      expect(result).toMatchObject({ reason: expect.stringContaining('only GET and HEAD') });
    },
  );

  it.each<[string, Record<string, string>]>([
    ['a Content-Length body', { 'content-length': '21' }],
    ['a chunked body', { 'transfer-encoding': 'chunked' }],
    ['any Transfer-Encoding', { 'transfer-encoding': 'identity' }],
  ])('refuses a GET that declares %s', (_label, headers) => {
    const result = checkRegistryRequestMethodAndBody('GET', headers);
    expect(result).toEqual({ ok: false, reason: 'the registry proxy is read-only: request bodies are refused' });
  });

  it('reports the method, not the body, when a write also carries a body', () => {
    const result = checkRegistryRequestMethodAndBody('PUT', { 'content-length': '100' });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('only GET and HEAD') });
  });
});

describe('buildReadOnlyUpstreamHeaders', () => {
  const credentialHeaders: Record<string, string> = {
    ...Object.fromEntries([...CREDENTIAL_HEADERS].map((name) => [name, `secret-${name}`])),
    'npm-otp': '123456',
    'npm-session': 'abc123',
    'npm-command': 'publish',
    'npm-auth-type': 'web',
    'npm-scope': '@acme',
    'npm-in-ci': 'false',
  };

  it('never puts a credential header or any npm-* header on the forwarded list', () => {
    for (const name of READ_ONLY_REQUEST_HEADERS) {
      expect(name, name).toBe(name.toLowerCase());
      expect(CREDENTIAL_HEADERS.has(name), name).toBe(false);
      expect(name.startsWith('npm-'), name).toBe(false);
    }
  });

  it('drops every credential and npm-* header the client sends', () => {
    const headers = buildReadOnlyUpstreamHeaders(credentialHeaders, 'registry.npmjs.org');

    expect(headers).toEqual({ host: 'registry.npmjs.org' });
  });

  it('copies content-negotiation, caching and range headers', () => {
    const forwarded = {
      accept: 'application/vnd.npm.install-v1+json',
      'accept-encoding': 'gzip',
      'user-agent': 'npm/10.8.2 node/v22.11.0',
      'if-none-match': '"abc"',
      'if-modified-since': 'Wed, 21 Oct 2015 07:28:00 GMT',
      range: 'bytes=100-',
      'if-range': '"abc"',
      'cache-control': 'max-age=0',
    };

    const headers = buildReadOnlyUpstreamHeaders({ ...forwarded, ...credentialHeaders }, 'deb.debian.org');

    expect(headers).toEqual({ host: 'deb.debian.org', ...forwarded });
  });

  it('drops unknown and hop-by-hop headers, so an unlisted credential fails closed', () => {
    const headers = buildReadOnlyUpstreamHeaders(
      {
        'x-registry-token': 'secret',
        'x-forwarded-for': '10.0.0.1',
        connection: 'keep-alive',
        'transfer-encoding': 'chunked',
        upgrade: 'websocket',
        host: 'attacker.example',
      },
      'crates.io',
    );

    expect(headers).toEqual({ host: 'crates.io' });
  });
});
