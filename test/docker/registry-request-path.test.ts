import { describe, it, expect } from 'vitest';
import { checkRegistryRequestPath } from '../../src/docker/registry-request-path.js';
import type { RegistryType } from '../../src/docker/package-types.js';

describe('checkRegistryRequestPath', () => {
  it.each<[RegistryType, string]>([
    ['npm', '/'],
    ['npm', '/express'],
    ['npm', '/JSONStream'],
    ['npm', '/@types/node'],
    ['npm', '/@types%2fnode'],
    ['npm', '/@types%2Fnode'],
    ['npm', '/%40types%2fnode'],
    ['npm', '/express?write=true'],
    ['npm', '/express/-/express-4.18.2.tgz'],
    ['npm', '/@types/node/-/node-20.0.0.tgz'],
    ['npm', '/@types%2fnode/-/node-20.0.0.tgz'],
    ['npm', '/-/ping?write=true'],
    ['npm', '/-/v1/search?text=a%20b&size=20'],
    ['npm', '/-/package/@scope%2fname/dist-tags'],
    ['pypi', '/simple/numpy/'],
    ['pypi', '/pypi/numpy/json'],
    ['pypi', `/packages/aa/bb/${'c'.repeat(60)}/numpy-1.26.0.tar.gz`],
    ['debian', '/debian/dists/bookworm/InRelease'],
    ['debian', '/debian/pool/main/l/libssl3/libssl3_3.0.11-1~deb12u2_arm64.deb'],
    ['debian', '/debian/pool/main/l/libssl3/libssl3_3.0.11-1%7edeb12u2_arm64.deb'],
    ['debian', '/debian/pool/main/g/gcc-12/g%2b%2b-12_12.2.0-14_amd64.deb'],
    ['debian', '/debian/pool/main/g/gcc-12/g%2B%2B-12_12.2.0-14_amd64.deb'],
    ['debian', '/debian/pool/main/t/tar/tar_1%3a1.35-2_arm64.deb'],
    // A non-delimiter escape is left to the parser, which decodes it once.
    ['debian', '/debian/pool/main/n/netcat/%6Eetcat-traditional_1.10-47_amd64.deb'],
    ['cargo', '/config.json'],
    ['cargo', '/se/rd/serde'],
    ['cargo', '/crates/serde/serde-1.0.193.crate'],
    ['cargo', '/api/v1/crates/serde/1.0.193/download'],
  ])('accepts %s path %s', (registry, path) => {
    expect(checkRegistryRequestPath(registry, path)).toEqual({ ok: true });
  });

  it.each<[RegistryType, string, RegExp]>([
    // Dot segments: the audit's EGR-1 vectors and their spellings.
    ['npm', '/@x/../express/-/express-4.18.2.tgz', /dot segment/],
    ['npm', '/@x/../express', /dot segment/],
    ['npm', '/-/../express/-/express-4.18.2.tgz', /dot segment/],
    ['npm', '/-/../express', /dot segment/],
    ['npm', '/express/x/..', /dot segment/],
    ['npm', '/express/.', /dot segment/],
    ['npm', '/./express', /dot segment/],
    ['debian', '/debian/dists/../pool/main/n/netcat/netcat-traditional_1.10-47_amd64.deb', /dot segment/],
    // Dot-leading segments: servlet containers drop `;` parameters, then
    // resolve `..;` and `.;` as dot segments.
    ['npm', '/-/..;/express', /starts with a dot/],
    ['npm', '/-/.;/express', /starts with a dot/],
    ['npm', '/-/x/..;/..;/express', /starts with a dot/],
    ['npm', '/-/..%3b/express', /starts with a dot/],
    ['npm', '/-/..;jsessionid=x/express/-/express-4.18.2.tgz', /starts with a dot/],
    ['npm', '/-/...', /starts with a dot/],
    ['npm', '/.express', /starts with a dot/],
    ['debian', '/debian/pool/main/n/netcat/..;/netcat-traditional_1.10-47_amd64.deb', /starts with a dot/],
    ['pypi', '/simple/..;/numpy/', /starts with a dot/],
    ['cargo', '/api/v1/crates/..;/serde/1.0.0/download', /starts with a dot/],
    // The npm scope separator cannot smuggle one in: `@x%2f.y` decodes to `@x/.y`.
    ['npm', '/-/@x%2f.y', /decoded request path is not canonical/],
    ['npm', '/-/@x%2f..;', /decoded request path is not canonical/],
    // Encoded dots, backslashes and percent signs (double encoding).
    ['npm', '/@x/%2e%2e/express', /percent-encodes a dot/],
    ['npm', '/@x/%2E%2E/express', /percent-encodes a dot/],
    ['npm', '/@x/.%2e/express', /percent-encodes a dot/],
    ['debian', '/debian/pool/main/n/netcat/netcat-traditional_1.10-47_amd64%2Edeb', /percent-encodes a dot/],
    ['debian', '/debian/pool/main/n/netcat/netcat-traditional_1.10-47_amd64%2edeb', /percent-encodes a dot/],
    ['npm', '/@x%5c..%5cexpress', /percent-encodes a dot, backslash/],
    [
      'debian',
      '/debian/pool/main/c/curl/curl_7.88.1-10%252bdeb12u15_arm64.deb',
      /percent-encodes a dot, backslash, percent/,
    ],
    ['npm', '/express%3fwrite=true', /delimiter/],
    ['npm', '/express%23x', /delimiter/],
    // Encoded slashes outside the one npm scope-separator form.
    ['npm', '/express%2f-%2fexpress-4.18.2.tgz', /percent-encodes a slash/],
    ['npm', '/@x/..%2fexpress', /percent-encodes a slash/],
    ['npm', '/@x%2f..%2fexpress', /percent-encodes a slash/],
    ['npm', '/@%2fexpress', /percent-encodes a slash/],
    ['debian', '/debian/pool/main/c/curl/curl_8.1.0%2fsecret_arm64.deb', /percent-encodes a slash/],
    ['pypi', '/simple/@x%2fnumpy/', /percent-encodes a slash/],
    // The scope-separator form is allowed, but its decoded path is checked too.
    ['npm', '/@x%2f..', /decoded request path is not canonical/],
    // Separators and URL-form differences.
    ['npm', '/@x\\..\\express', /backslash/],
    ['npm', '//express', /empty segment/],
    ['npm', '/express//-/express-4.18.2.tgz', /empty segment/],
    ['npm', '/express^1', /canonical URL form/],
    ['npm', '/express{1}', /canonical URL form/],
    // Malformed encoding and decoded control characters.
    ['npm', '/express%', /malformed/],
    ['npm', '/express%4', /malformed/],
    ['npm', '/express%zz', /malformed/],
    ['debian', '/debian/pool/main/n/netcat/netcat%E0%A4_1.0_amd64.deb', /malformed/],
    ['npm', '/express%00', /decoded request path is not canonical/],
    ['debian', '/debian/pool/main/n/netcat/netcat%0a_1.0_amd64.deb', /decoded request path is not canonical/],
    // Decoded non-ASCII or space: a fullwidth dot (U+FF0E) is `.` after NFKC.
    ['npm', '/-/%EF%BC%8E%EF%BC%8E/express', /decoded request path is not canonical/],
    ['npm', '/expr%C3%A9ss', /decoded request path is not canonical/],
    ['debian', '/debian/pool/main/n/netcat/netcat_1.10%2047_amd64.deb', /decoded request path is not canonical/],
    // Request-target form.
    ['npm', 'express', /origin-form/],
    ['npm', 'https://registry.npmjs.org/express', /origin-form/],
    ['npm', '*', /origin-form/],
    ['npm', '/express#frag', /fragment/],
    ['npm', '/exp ress', /control, space, or non-ASCII/],
    ['npm', '/express\t', /control, space, or non-ASCII/],
    ['npm', '/expréss', /control, space, or non-ASCII/],
    ['npm', '/express?q=é', /control, space, or non-ASCII/],
  ])('refuses %s path %s', (registry, path, reason) => {
    const result = checkRegistryRequestPath(registry, path);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toMatch(reason);
  });

  it('allows the npm scope separator only for npm', () => {
    expect(checkRegistryRequestPath('npm', '/@types%2fnode').ok).toBe(true);
    for (const registry of ['pypi', 'debian', 'cargo'] as const) {
      expect(checkRegistryRequestPath(registry, '/@types%2fnode').ok).toBe(false);
    }
  });

  it('never echoes the request path in its reason', () => {
    const path = '/@x/../secret-token-like-value';
    const result = checkRegistryRequestPath('npm', path);
    expect(result.ok ? '' : result.reason).not.toContain('secret-token-like-value');
  });
});
