import { describe, expect, it } from 'vitest';
import * as net from 'node:net';
import { parseConnectAuthority, parseProxyRequestTarget, resolveProxyHost } from '../../src/docker/proxy-authority.js';

describe('parseConnectAuthority', () => {
  it.each([
    ['example.com:443', { host: 'example.com', port: 443, isIpLiteral: false }],
    ['example.com:1', { host: 'example.com', port: 1, isIpLiteral: false }],
    ['example.com:65535', { host: 'example.com', port: 65_535, isIpLiteral: false }],
    // One canonical spelling for every allowlist lookup.
    ['API.Example.COM:443', { host: 'api.example.com', port: 443, isIpLiteral: false }],
    ['api.example.com.:443', { host: 'api.example.com', port: 443, isIpLiteral: false }],
    ['ＡＰＩ.example.com:443', { host: 'api.example.com', port: 443, isIpLiteral: false }],
    ['bücher.example:443', { host: 'xn--bcher-kva.example', port: 443, isIpLiteral: false }],
    // IP literals are classified (and canonicalized) so the caller can screen them.
    ['93.184.216.34:443', { host: '93.184.216.34', port: 443, isIpLiteral: true }],
    ['127.1:443', { host: '127.0.0.1', port: 443, isIpLiteral: true }],
    ['2130706433:443', { host: '127.0.0.1', port: 443, isIpLiteral: true }],
    ['[::1]:443', { host: '::1', port: 443, isIpLiteral: true }],
    ['[2001:DB8::1]:8443', { host: '2001:db8::1', port: 8443, isIpLiteral: true }],
    ['[::ffff:127.0.0.1]:443', { host: '::ffff:7f00:1', port: 443, isIpLiteral: true }],
  ])('parses %s', (authority, expected) => {
    expect(parseConnectAuthority(authority)).toEqual(expected);
  });

  it.each([
    // Ports: decimal 1-65535 only, no sign, no leading zero, no suffix.
    'example.com:99999',
    'example.com:65536',
    'example.com:0',
    'example.com:-1',
    'example.com:+443',
    'example.com:abc',
    'example.com:443junk',
    'example.com:0443',
    'example.com:1e3',
    'example.com:4 43',
    'example.com:',
    'example.com',
    // IPv6 only in brackets; brackets only for IPv6.
    '::1:443',
    '::1',
    '[::1]',
    '[::1:443',
    '::1]:443',
    '[example.com]:443',
    '[127.0.0.1]:443',
    '[fe80::1%eth0]:443',
    // Hosts that are not hostnames.
    ':443',
    'example.com:443:443',
    'user@example.com:443',
    'example.com/path:443',
    'example.com?x:443',
    'example.com#x:443',
    'a\\b.example.com:443',
    // Spellings the URL host parser would fold into another host.
    'api%2eexample.com:443',
    '1.2.3.4/x:443',
    '127.0.0.1%2f:443',
    '*.example.com:443',
    'exa mple.com:443',
    'example..com:443',
    '1.2.3.4.5:443',
    `${'a'.repeat(64)}.example.com:443`,
    // Names whose canonical form would be an address (empty last label).
    '127.0.0.1..:443',
    '127.1..:443',
    '0x7f.1..:443',
    '2130706433..:443',
    '',
  ])('refuses %s', (authority) => {
    expect(parseConnectAuthority(authority)).toBeUndefined();
  });
});

describe('parseProxyRequestTarget', () => {
  it('parses an absolute-form http:// target into canonical host, port and origin-form path', () => {
    expect(parseProxyRequestTarget('http://Example.COM./a/b?c=d')).toEqual({
      kind: 'proxy',
      host: 'example.com',
      isIpLiteral: false,
      port: 80,
      path: '/a/b?c=d',
    });
    expect(parseProxyRequestTarget('http://example.com:8080/')).toMatchObject({ port: 8080, path: '/' });
    expect(parseProxyRequestTarget('http://[::1]/x')).toMatchObject({ kind: 'proxy', host: '::1', isIpLiteral: true });
    expect(parseProxyRequestTarget('http://127.1/x')).toMatchObject({ host: '127.0.0.1', isIpLiteral: true });
  });

  it('marks malformed absolute-form targets invalid instead of treating them as origin-form', () => {
    expect(parseProxyRequestTarget('http://example.com:99999/')).toMatchObject({ kind: 'invalid' });
    expect(parseProxyRequestTarget('http://example.com:0/')).toMatchObject({ kind: 'invalid' });
    expect(parseProxyRequestTarget('http://user:pw@example.com/')).toMatchObject({
      kind: 'invalid',
      reason: 'userinfo in proxy request target',
    });
    expect(parseProxyRequestTarget('http://1.2.3.4.5/')).toMatchObject({ kind: 'invalid' });
    expect(parseProxyRequestTarget('http://127.0.0.1../')).toMatchObject({ kind: 'invalid' });
  });

  it('reports origin-form and non-http targets as not a proxy request', () => {
    expect(parseProxyRequestTarget('/relative')).toEqual({ kind: 'not-proxy' });
    expect(parseProxyRequestTarget('')).toEqual({ kind: 'not-proxy' });
    expect(parseProxyRequestTarget('https://example.com/')).toEqual({ kind: 'not-proxy' });
    expect(parseProxyRequestTarget('ftp://example.com/')).toEqual({ kind: 'not-proxy' });
  });
});

describe('resolveProxyHost', () => {
  it('never lets a malformed literal fall through as a name', () => {
    expect(resolveProxyHost('09.1.1.1')).toBeUndefined();
    expect(resolveProxyHost('[nope]')).toBeUndefined();
    expect(resolveProxyHost('0x7f.1')).toEqual({ host: '127.0.0.1', isIpLiteral: true });
    expect(resolveProxyHost('example.com')).toEqual({ host: 'example.com', isIpLiteral: false });
  });

  it('never reports an IP literal as a name, whatever its spelling', () => {
    // The raw CONNECT tunnel dials a "name" with the guarded resolver, which
    // the network stack skips for a literal: `isIpLiteral: false` must mean
    // the host is not one. Combine many address spellings with the dot,
    // full-stop and ignorable-character suffixes the URL host parser folds.
    const addresses = ['127.0.0.1', '127.1', '0x7f.1', '2130706433', '0177.0.0.1', '169.254.169.254', '10.1'];
    const suffixes = [
      '',
      '.',
      '..',
      '...',
      '\u3002',
      '\u3002.',
      '.\u3002',
      '\uff0e.',
      '\u00ad.',
      '.\u00ad.',
      '\u200b..',
    ];
    const seen: string[] = [];
    for (const address of addresses) {
      for (const suffix of suffixes) {
        const text = `${address}${suffix}`;
        const resolved = resolveProxyHost(text);
        if (resolved !== undefined && !resolved.isIpLiteral && net.isIP(resolved.host) !== 0) seen.push(text);
      }
    }
    expect(seen).toEqual([]);
  });
});
