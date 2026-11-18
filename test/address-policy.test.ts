import type * as dns from 'node:dns';
import { describe, expect, it } from 'vitest';

import * as outboundTransport from '../src/docker/outbound-transport.js';
import {
  canonicalizeHostname,
  classifyHostLiteral,
  createGuardedLookup,
  isAddressAllowed,
  isLocalOrMetadataHostname,
  isMetadataAddress,
  isMetadataHostname,
  isPublicAddress,
  isTrustedProviderAddress,
  screenIpLiteral,
} from '../src/net/address-policy.js';

/** Resolver stub returning fixed answers, so no test touches real DNS. */
function stubLookup(answers: Readonly<Partial<Record<string, readonly string[]>>>): typeof dns.lookup {
  return ((
    hostname: string,
    _options: dns.LookupOptions,
    callback: (error: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void,
  ): void => {
    const addresses = answers[hostname];
    if (addresses === undefined) {
      const error: NodeJS.ErrnoException = new Error(`ENOTFOUND ${hostname}`);
      error.code = 'ENOTFOUND';
      callback(error, []);
      return;
    }
    callback(
      null,
      addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
    );
  }) as typeof dns.lookup;
}

function lookupAll(lookup: typeof dns.lookup, hostname: string): Promise<dns.LookupAddress[]> {
  return new Promise((resolve, reject) => {
    lookup(hostname, { all: true }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses);
    });
  });
}

function lookupOne(lookup: typeof dns.lookup, hostname: string): Promise<{ address: string; family: number }> {
  return new Promise((resolve, reject) => {
    lookup(hostname, {}, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address, family });
    });
  });
}

describe('address classification', () => {
  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
    '::ffff:8.8.8.8',
    '::ffff:808:808',
    '64:ff9b::808:808',
    '2002:808:808::1',
    // Teredo with a public server and a public (obfuscated) client.
    '2001:0000:0808:0808:0000:0000:fefe:fefe',
  ])('accepts public address %s', (address) => {
    expect(isPublicAddress(address)).toBe(true);
    expect(isTrustedProviderAddress(address)).toBe(true);
  });

  // The acceptance set for this policy, plus every spelling that reaches a
  // loopback, link-local, private or metadata destination.
  it.each([
    ['127.1', 'inet_aton short form (not a dotted quad)'],
    ['::ffff:7f00:1', 'IPv4-mapped loopback in hex'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['169.254.169.254', 'cloud metadata'],
    ['fe80::1', 'IPv6 link-local'],
    ['10.0.0.1', '10/8'],
    ['10.255.255.255', '10/8 upper bound'],
    ['100.64.0.1', '100.64/10'],
    ['100.127.255.255', '100.64/10 upper bound'],
    ['0:0:0:0:0:0:0:1', 'uncompressed IPv6 loopback'],
    ['0000:0000::1', 'zero-padded IPv6 loopback'],
    ['::1%lo', 'IPv6 loopback with a zone id'],
    ['fe80::1%eth0', 'link-local with a zone id'],
    ['::127.0.0.1', 'IPv4-compatible loopback'],
    ['::ffff:0:7f00:1', 'IPv4-translated loopback'],
    ['64:ff9b::7f00:1', 'NAT64 to loopback'],
    ['64:ff9b::a9fe:a9fe', 'NAT64 to metadata'],
    ['64:ff9b:1::a00:1', 'local-use NAT64'],
    ['2002:7f00:1::', '6to4 embedding loopback'],
    ['2002:a9fe:a9fe::', '6to4 embedding metadata'],
    ['2001:0000:0808:0808:0000:0000:f5ff:fffe', 'Teredo with a private client'],
    ['fd00:ec2::254', 'AWS IPv6 metadata (ULA)'],
    ['fc00::1', 'ULA'],
    ['fec0::1', 'deprecated site-local'],
    ['ff02::1', 'multicast'],
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['2001:db8::1', 'documentation'],
    ['3fff::1', 'documentation (RFC 9637)'],
    ['100::1', 'discard-only'],
    ['0.0.0.0', 'this network'],
    ['172.16.0.1', '172.16/12'],
    ['172.31.255.255', '172.16/12 upper bound'],
    ['192.168.1.1', '192.168/16'],
    ['192.0.0.192', 'IETF protocol assignments (OCI metadata)'],
    ['192.88.99.1', '6to4 relay anycast'],
    ['198.18.0.1', 'benchmarking'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
    ['not-an-ip', 'a name'],
    ['', 'empty'],
  ])('rejects %s (%s)', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it('allows private gateway ranges only under the trusted provider override', () => {
    for (const address of ['10.0.0.1', '127.0.0.1', '100.64.0.1', '172.16.0.1', '192.168.0.1', '::1', 'fd00::1']) {
      expect(isPublicAddress(address)).toBe(false);
      expect(isTrustedProviderAddress(address)).toBe(true);
      expect(isAddressAllowed(address, true)).toBe(true);
      expect(isAddressAllowed(address, false)).toBe(false);
    }
    expect(isTrustedProviderAddress('::ffff:10.0.0.1')).toBe(true);
  });

  it('keeps metadata, link-local, unspecified, multicast and documentation ranges denied under the override', () => {
    for (const address of [
      '169.254.169.254',
      '::ffff:169.254.169.254',
      'fe80::1',
      '::1%lo',
      '0.0.0.0',
      '::',
      '224.0.0.1',
      'ff02::1',
      '2001:db8::1',
      '192.0.2.1',
    ]) {
      expect(isTrustedProviderAddress(address)).toBe(false);
    }
  });

  it('recognizes cloud metadata addresses, including those inside ranges the override admits', () => {
    for (const address of [
      '169.254.169.254',
      '169.254.170.2',
      '100.100.100.200',
      '::ffff:100.100.100.200',
      '::ffff:a9fe:a9fe',
      '64:ff9b::a9fe:a9fe',
      'fd00:ec2::254',
      'FD00:0EC2:0000:0000:0000:0000:0000:0254',
    ]) {
      expect(isMetadataAddress(address)).toBe(true);
    }
    // The override admits these two, which is why callers must check separately.
    expect(isTrustedProviderAddress('100.100.100.200')).toBe(true);
    expect(isTrustedProviderAddress('fd00:ec2::254')).toBe(true);
    for (const address of ['100.100.100.201', 'fd00:ec2::253', '10.0.0.1', '8.8.8.8', '::1', 'not-an-ip', '']) {
      expect(isMetadataAddress(address)).toBe(false);
    }
  });

  it('recognizes the other documented IPv6 metadata endpoints the override would admit', () => {
    for (const address of [
      'fd00:ec2::23', // AWS EKS Pod Identity Agent
      'fd20:ce::254', // Google Cloud
      'FD20:00CE:0:0:0:0:0:254',
      'fd00:c1::a9fe:a9fe', // Oracle Cloud
      'fd00:a9fe:a9fe::1', // Akamai (Linode)
      'fd00:42::42', // Scaleway
    ]) {
      expect(isTrustedProviderAddress(address)).toBe(true);
      expect(isMetadataAddress(address)).toBe(true);
    }
    for (const address of ['fd20:ce::253', 'fd00:42::43', 'fd00:a9fe:a9fe::2', 'fd00:c1::1']) {
      expect(isMetadataAddress(address)).toBe(false);
    }
  });

  it("recognizes Azure's WireServer, a public address, in every embedded form", () => {
    for (const address of ['168.63.129.16', '::ffff:168.63.129.16', '::ffff:a83f:8110', '64:ff9b::a83f:8110']) {
      expect(isPublicAddress(address)).toBe(true);
      expect(isMetadataAddress(address)).toBe(true);
    }
    expect(isMetadataAddress('168.63.129.17')).toBe(false);
  });
});

describe('screenIpLiteral', () => {
  it.each(['example.com', 'example.com.', 'xn--bcher-kva.example', '1.2.3.example', 'host-10'])(
    'treats %s as a name for the guarded resolver',
    (host) => {
      expect(screenIpLiteral(host)).toEqual({ kind: 'name', hostname: host });
    },
  );

  it.each([
    '127.1',
    '127.0.0.1',
    '127.0.0.1.',
    '0x7f.1',
    '0x7f000001',
    '2130706433',
    '017700000001',
    '0177.0.0.1',
    '[::1]',
    '[0:0:0:0:0:0:0:1]',
    '[::ffff:7f00:1]',
    '::ffff:7f00:1',
    '169.254.169.254',
    '0xa9.0xfe.0xa9.0xfe',
    '[fe80::1]',
    '[fe80::1%25eth0]',
    '10.1.2.3',
    '10.1',
    '100.64.0.1',
    '[64:ff9b::7f00:1]',
    '0',
    '0x',
  ])('refuses the non-public literal %s', (host) => {
    expect(() => screenIpLiteral(host)).toThrow(expect.objectContaining({ code: 'ADDRESS_NOT_ALLOWED' }));
  });

  it.each([
    '1.2.3.4.5',
    '256.1.1.1',
    '1.2.3.256',
    '4294967296',
    'example.123',
    '1..2',
    '08.1.1.1',
    '[::1',
    '::1]',
    '[]',
    '[not-ipv6]',
    '[1.2.3.4]',
    '1::2::3',
  ])('refuses the malformed literal %s instead of resolving it as a name', (host) => {
    expect(() => screenIpLiteral(host)).toThrow(expect.objectContaining({ code: 'INVALID_IP_LITERAL' }));
  });

  // Raw text that is not an IP literal, but that the WHATWG URL host parser
  // (fetch, undici, `new URL`) turns into one, so a URL built from it would
  // connect to loopback or metadata without any lookup.
  it.each([
    ['１２７.０.０.１', 'full-width digits and dots'],
    ['127。0。0。1', 'ideographic full stops'],
    ['127.0.0.1%2e', 'percent-encoded trailing dot'],
    ['%31%32%37.0.0.1', 'percent-encoded digits'],
    ['127.0.0.\n1', 'embedded newline'],
    ['127.0.0.1\t', 'trailing tab'],
    ['１６９.２５４.１６９.２５４', 'full-width metadata address'],
    ['０ｘ７ｆ.１', 'full-width hex short form'],
  ])('refuses %j (%s), which a URL resolves to a non-public literal', (host) => {
    expect(new URL(`http://${host}/`).hostname).toMatch(/^(?:127\.0\.0\.1|169\.254\.169\.254)$/u);
    expect(() => screenIpLiteral(host)).toThrow(expect.objectContaining({ code: 'ADDRESS_NOT_ALLOWED' }));
  });

  it('classifies URL-normalized spellings by the address they reach under either policy', () => {
    expect(screenIpLiteral('１２７.０.０.１', { allowPrivate: true })).toEqual({
      kind: 'ip',
      address: '127.0.0.1',
      family: 4,
    });
    expect(() => screenIpLiteral('１６９.２５４.１６９.２５４', { allowPrivate: true })).toThrow(
      expect.objectContaining({ code: 'ADDRESS_NOT_ALLOWED' }),
    );
    expect(screenIpLiteral('８.８.８.８')).toEqual({ kind: 'ip', address: '8.8.8.8', family: 4 });
    // Full-width text that is a name stays a name for the guarded resolver.
    expect(screenIpLiteral('ｅｘａｍｐｌｅ.com')).toEqual({ kind: 'name', hostname: 'ｅｘａｍｐｌｅ.com' });
  });

  it('returns the canonical address of an allowed literal', () => {
    expect(screenIpLiteral('8.8.8.8')).toEqual({ kind: 'ip', address: '8.8.8.8', family: 4 });
    expect(screenIpLiteral('134744072')).toEqual({ kind: 'ip', address: '8.8.8.8', family: 4 });
    expect(screenIpLiteral('0x8.0x8.0x8.0x8')).toEqual({ kind: 'ip', address: '8.8.8.8', family: 4 });
    expect(screenIpLiteral('[2606:4700:4700::1111]')).toEqual({
      kind: 'ip',
      address: '2606:4700:4700::1111',
      family: 6,
    });
  });

  it('allows private literals only with allowPrivate, and never link-local or metadata', () => {
    expect(screenIpLiteral('10.0.0.1', { allowPrivate: true })).toEqual({ kind: 'ip', address: '10.0.0.1', family: 4 });
    expect(screenIpLiteral('127.1', { allowPrivate: true })).toEqual({ kind: 'ip', address: '127.0.0.1', family: 4 });
    expect(screenIpLiteral('[::1]', { allowPrivate: true })).toEqual({ kind: 'ip', address: '::1', family: 6 });
    for (const host of ['169.254.169.254', '[fe80::1]', '[::1%25lo]', '0.0.0.0']) {
      expect(() => screenIpLiteral(host, { allowPrivate: true })).toThrow(
        expect.objectContaining({ code: 'ADDRESS_NOT_ALLOWED' }),
      );
    }
  });
});

describe('classifyHostLiteral', () => {
  it.each([
    ['127.0.0.1', '127.0.0.1'],
    ['2130706433', '127.0.0.1'],
    ['127.1', '127.0.0.1'],
    ['0x7f000001', '127.0.0.1'],
    ['0177.0.0.1', '127.0.0.1'],
    ['0x7f.1', '127.0.0.1'],
    ['127.0.0.1.', '127.0.0.1'],
    ['１２７.０.０.１', '127.0.0.1'],
    ['169.254.169.254', '169.254.169.254'],
    ['0x', '0.0.0.0'],
  ])('canonicalizes IPv4 spelling %s without applying a policy', (host, address) => {
    expect(classifyHostLiteral(host)).toEqual({ kind: 'ip', address, family: 4 });
  });

  it.each([
    ['::1', '::1'],
    ['[::1]', '::1'],
    ['[0:0:0:0:0:0:0:1]', '::1'],
    ['[::ffff:127.0.0.1]', '::ffff:7f00:1'],
    ['[2001:DB8:0:0:1:0:0:1]', '2001:db8::1:0:0:1'],
    ['[1:0:0:2:0:0:0:3]', '1:0:0:2::3'],
    ['[::]', '::'],
    ['[1:2:3:4:5:6:7:8]', '1:2:3:4:5:6:7:8'],
  ])('canonicalizes IPv6 %s to WHATWG text', (host, address) => {
    expect(classifyHostLiteral(host)).toEqual({ kind: 'ip', address, family: 6 });
    expect(new URL(`http://[${address}]/`).hostname).toBe(`[${address}]`);
  });

  it.each(['1.2.3.4.5', '09', '256.1.1.1.1', '[nope]', '[::1', 'fe80::1%eth0', '[fe80::1%25eth0]', 'github.com:22'])(
    'reports %s as IP-like without a canonical address',
    (host) => {
      expect(classifyHostLiteral(host)).toEqual({ kind: 'ip-like' });
    },
  );

  it.each(['github.com', 'localhost', '1.2.3.example', 'deadbeef', 'host-10', ''])('reports %s as a name', (host) => {
    expect(classifyHostLiteral(host)).toEqual({ kind: 'name' });
  });
});

describe('canonicalizeHostname', () => {
  it.each([
    ['api.example.com', 'api.example.com'],
    ['API.Example.COM', 'api.example.com'],
    ['api.example.com.', 'api.example.com'],
    ['ＡＰＩ.example.com', 'api.example.com'],
    ['bücher.example', 'xn--bcher-kva.example'],
    ['xn--bcher-kva.example', 'xn--bcher-kva.example'],
    ['_dmarc.example.com', '_dmarc.example.com'],
    ['  api.example.com  ', 'api.example.com'],
    // The trailing dot is judged after IDNA mapping, so a mapped full stop counts.
    ['api.example.com\u3002', 'api.example.com'],
    ['127.1', '127.0.0.1'],
    ['127.0.0.1.', '127.0.0.1'],
  ])('canonicalizes %s to %s', (input, expected) => {
    expect(canonicalizeHostname(input)).toBe(expected);
  });

  it.each(['127.0.0.1..', '127.1..', '0x7f.1..', '2130706433..', '169.254.169.254..', '127.0.0.1.\u00ad.'])(
    'never turns the name %j into an IP literal',
    (input) => {
      // Every literal classifier reads these as names (the last label is
      // empty). Removing one trailing dot BEFORE the URL host parser, which
      // drops another one itself when it reads IPv4, used to yield the
      // literal `127.0.0.1`: a "name" the raw CONNECT tunnel then dialed
      // without any lookup or address screen.
      expect(classifyHostLiteral(input).kind).toBe('name');
      expect(canonicalizeHostname(input)).toBeUndefined();
    },
  );

  it.each([
    '',
    '.',
    'api.example.com..',
    'a..b',
    // Delimiters the URL host parser would truncate at, escapes it would
    // decode and whitespace it would strip: refused, never folded.
    'example.com/path',
    'example.com?x',
    'example.com#x',
    'a\\b.example.com',
    'api%2eexample.com',
    'exa\tmple.com',
    'exa mple.com',
    // Characters no hostname contains.
    'example.com:443',
    'user@example.com',
    '[::1]',
    '::1',
    '*.example.com',
    'a|b.com',
    `${'a'.repeat(64)}.example.com`,
    `${'a.'.repeat(127)}com`,
  ])('refuses %j', (input) => {
    expect(canonicalizeHostname(input)).toBeUndefined();
  });
});

describe('local and metadata hostnames', () => {
  it.each([
    'localhost',
    'LOCALHOST.',
    'foo.localhost',
    'printer.local',
    'metadata.google.internal',
    'host.docker.internal',
    'anything.internal',
    'metadata',
    'metadata.goog',
    'instance-data',
    'instance-data.ec2.internal',
    'router.home.arpa',
    'localhost.localdomain',
    'ip6-localhost',
    'ip6-loopback',
    // Spellings a URL normalizes to a local or metadata name.
    'ＬＯＣＡＬＨＯＳＴ',
    'local%68ost',
    'ｍｅｔａｄａｔａ.google.internal',
    'host.docker%2einternal',
  ])('flags %s', (hostname) => {
    expect(isLocalOrMetadataHostname(hostname)).toBe(true);
  });

  it.each(['example.com', 'localhost.example.com', 'internal.example.com', 'local', 'metadata.example.com', ''])(
    'does not flag %s',
    (hostname) => {
      expect(isLocalOrMetadataHostname(hostname)).toBe(false);
    },
  );

  it('separates metadata names, which no policy may reach', () => {
    expect(isMetadataHostname('METADATA.GOOGLE.INTERNAL.')).toBe(true);
    expect(isMetadataHostname('ｍｅｔａｄａｔａ.ｇｏｏｇ')).toBe(true);
    expect(isMetadataHostname('metadata%2egoogle.internal')).toBe(true);
    expect(isMetadataHostname('instance-data')).toBe(true);
    expect(isMetadataHostname('gateway.corp.internal')).toBe(false);
    expect(isMetadataHostname('localhost')).toBe(false);
  });
});

describe('createGuardedLookup', () => {
  const lookup = stubLookup({
    'public.example': ['93.184.216.34', '2606:4700:4700::1111'],
    'mixed.example': ['93.184.216.34', '10.0.0.1'],
    'rebind.example': ['93.184.216.34', '::ffff:169.254.169.254'],
    'private.example': ['10.0.0.1'],
    'metadata.example': ['169.254.169.254'],
    'empty.example': [],
    'garbage.example': ['not-an-address'],
  });

  it('returns every answer when all are public', async () => {
    const guarded = createGuardedLookup(lookup, false);
    await expect(lookupAll(guarded, 'public.example')).resolves.toHaveLength(2);
    await expect(lookupOne(guarded, 'public.example')).resolves.toEqual({ address: '93.184.216.34', family: 4 });
  });

  it.each(['mixed.example', 'rebind.example', 'private.example', 'empty.example', 'garbage.example'])(
    'fails the whole lookup for %s',
    async (hostname) => {
      const guarded = createGuardedLookup(lookup, false);
      await expect(lookupAll(guarded, hostname)).rejects.toThrow(/non-public address/u);
    },
  );

  it('marks a policy refusal with the ADDRESS_NOT_ALLOWED code and passes resolver errors through', async () => {
    const guarded = createGuardedLookup(lookup, false);
    await expect(lookupAll(guarded, 'private.example')).rejects.toMatchObject({
      name: 'AddressPolicyError',
      code: 'ADDRESS_NOT_ALLOWED',
    });
    await expect(lookupAll(guarded, 'missing.example')).rejects.toMatchObject({ code: 'ENOTFOUND' });
  });

  it('admits private answers only for the trusted override and still refuses metadata', async () => {
    const trusted = createGuardedLookup(lookup, true);
    await expect(lookupAll(trusted, 'private.example')).resolves.toHaveLength(1);
    await expect(lookupAll(trusted, 'metadata.example')).rejects.toThrow(/non-public address/u);
  });

  it('passes resolver errors through', async () => {
    await expect(lookupAll(createGuardedLookup(lookup, false), 'unknown.example')).rejects.toMatchObject({
      code: 'ENOTFOUND',
    });
  });
});

describe('outbound-transport compatibility', () => {
  it('re-exports the shared classifier and resolver unchanged', () => {
    expect(outboundTransport.isPublicAddress).toBe(isPublicAddress);
    expect(outboundTransport.createGuardedLookup).toBe(createGuardedLookup);
  });

  it('refuses metadata names even under the trusted provider override', () => {
    const transport = outboundTransport.createDirectOutboundTransport({ lookup: stubLookup({}) });
    for (const hostname of ['metadata', 'instance-data', 'metadata.goog']) {
      expect(() =>
        transport.request({
          destination: { protocol: 'https:', hostname, port: 443 },
          addressPolicy: 'trusted-provider-override',
          method: 'GET',
          path: '/',
        }),
      ).toThrow(/metadata-scoped/u);
    }
  });

  it('refuses residential and localdomain names under public-only', () => {
    const transport = outboundTransport.createDirectOutboundTransport({ lookup: stubLookup({}) });
    for (const hostname of ['router.home.arpa', 'box.localdomain', 'ip6-localhost']) {
      expect(() =>
        transport.request({ destination: { protocol: 'https:', hostname, port: 443 }, method: 'GET', path: '/' }),
      ).toThrow(/local or metadata-scoped/u);
    }
  });
});
