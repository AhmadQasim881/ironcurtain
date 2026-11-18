/**
 * Tests for the Public-Suffix-List hostname classification behind the persona
 * broad-policy validator and the dynamic-list domain checks
 * (src/types/public-suffix.ts).
 */

import { describe, it, expect } from 'vitest';
import { canAutoWildcard, classifyHost, isBroadDomainPattern, isRegistrable } from '../src/types/public-suffix.js';

describe('classifyHost', () => {
  it('recognizes IP literals in every spelling the network stack accepts', () => {
    for (const host of ['169.254.169.254', '127.0.0.1', '127.1', '2130706433', '0x7f.1', '::1', '[::1]', 'fe80::1']) {
      expect(classifyHost(host)).toEqual({ kind: 'ip' });
    }
    // Full-width digits become an IPv4 literal under the URL host parser.
    expect(classifyHost('１２７.０.０.１')).toEqual({ kind: 'ip' });
  });

  it('treats local, private-use, metadata and unknown-TLD names as local', () => {
    for (const host of [
      'localhost',
      'api.localhost',
      'printer.local',
      'db.internal',
      'internal',
      'metadata.google.internal',
      'router.home.arpa',
      'intranet',
      'host.corp',
      'nas.lan',
    ]) {
      expect(classifyHost(host)).toEqual({ kind: 'local' });
    }
  });

  it('reports public suffixes with their PSL section', () => {
    for (const host of ['com', 'co.uk', 'com.au', 'gov']) {
      expect(classifyHost(host)).toEqual({ kind: 'public-suffix', section: 'icann' });
    }
    for (const host of ['github.io', 'pages.dev', 'vercel.app', 'readthedocs.io', 'githubusercontent.com']) {
      expect(classifyHost(host)).toEqual({ kind: 'public-suffix', section: 'private' });
    }
    expect(classifyHost('s3.amazonaws.com')).toEqual({ kind: 'public-suffix', section: 'private' });
  });

  it('returns the registrable domain for names inside one', () => {
    expect(classifyHost('api.github.com')).toEqual({
      kind: 'registrable',
      registrableDomain: 'github.com',
      privateSuffix: false,
    });
    expect(classifyHost('www.example.co.uk')).toMatchObject({ registrableDomain: 'example.co.uk' });
    expect(classifyHost('alice.github.io')).toEqual({
      kind: 'registrable',
      registrableDomain: 'alice.github.io',
      privateSuffix: true,
    });
  });

  it('marks names at or under a curated multi-tenant cloud parent', () => {
    expect(classifyHost('amazonaws.com')).toMatchObject({ kind: 'registrable', multiTenantParent: 'amazonaws.com' });
    expect(classifyHost('core.windows.net')).toMatchObject({ multiTenantParent: 'windows.net' });
    // Tenant servers: public Codespaces ports (*.app.github.dev) and Railway
    // apps (*.up.railway.app, a PSL entry one level below railway.app).
    expect(classifyHost('github.dev')).toMatchObject({ kind: 'registrable', multiTenantParent: 'github.dev' });
    expect(classifyHost('railway.app')).toMatchObject({ kind: 'registrable', multiTenantParent: 'railway.app' });
    expect(classifyHost('github.com')).not.toHaveProperty('multiTenantParent');
  });

  it('marks a registrable name directly above a PSL wildcard rule as its own multi-tenant parent', () => {
    // *.gateway.dev (private section) and *.kobe.jp (ICANN section): every
    // child is a public suffix, so the parent hosts many registrants.
    expect(classifyHost('gateway.dev')).toMatchObject({ kind: 'registrable', multiTenantParent: 'gateway.dev' });
    expect(classifyHost('kobe.jp')).toMatchObject({ kind: 'registrable', multiTenantParent: 'kobe.jp' });
    expect(classifyHost('us-east1.gateway.dev')).toEqual({ kind: 'public-suffix', section: 'private' });
    // A tenant's own name below it, and the exception rule !city.kobe.jp, are single registrants.
    expect(classifyHost('api.us-east1.gateway.dev')).not.toHaveProperty('multiTenantParent');
    expect(classifyHost('city.kobe.jp')).not.toHaveProperty('multiTenantParent');
  });

  it('classifies the canonical spelling: case, one trailing dot, IDN', () => {
    expect(classifyHost('GitHub.COM.')).toMatchObject({ kind: 'registrable', registrableDomain: 'github.com' });
    expect(classifyHost('GITHUB.IO')).toEqual({ kind: 'public-suffix', section: 'private' });
    expect(classifyHost('bücher.de')).toMatchObject({ registrableDomain: 'xn--bcher-kva.de' });
  });

  it('reports unusable text as invalid', () => {
    for (const host of ['', '  ', 'a b.com', 'example.com/path', '*.com', 'a..com']) {
      expect(classifyHost(host)).toEqual({ kind: 'invalid' });
    }
  });
});

describe('isRegistrable', () => {
  it('accepts names inside one registrable domain and refuses everything else', () => {
    for (const host of ['example.com', 'api.github.com', 'example.co.uk', 'alice.github.io', 'sts.amazonaws.com']) {
      expect(isRegistrable(host)).toBe(true);
    }
    for (const host of ['com', 'co.uk', 'github.io', 'localhost', '169.254.169.254', 'intranet', '']) {
      expect(isRegistrable(host)).toBe(false);
    }
  });
});

describe('isBroadDomainPattern', () => {
  it('meets the acceptance cases: *.github.io and *.pages.dev broad, *.github.com and *.example.co.uk narrow', () => {
    expect(isBroadDomainPattern('*.github.io')).toBe(true);
    expect(isBroadDomainPattern('*.pages.dev')).toBe(true);
    expect(isBroadDomainPattern('*.github.com')).toBe(false);
    expect(isBroadDomainPattern('*.example.co.uk')).toBe(false);
  });

  it('keeps the original broad cases', () => {
    for (const pattern of ['*', '*.', '*.com', '*.gov', '*.io']) expect(isBroadDomainPattern(pattern)).toBe(true);
  });

  it('treats a wildcard over a name above a PSL wildcard rule as broad', () => {
    expect(isBroadDomainPattern('*.gateway.dev')).toBe(true);
    expect(isBroadDomainPattern('*.kobe.jp')).toBe(true);
    expect(isBroadDomainPattern('*.api.us-east1.gateway.dev')).toBe(false);
  });

  it('treats exact hosts and git host/owner/repo patterns as narrow', () => {
    for (const pattern of ['github.com', 'github.com/provos/ironcurtain', 'com', '169.254.169.254']) {
      expect(isBroadDomainPattern(pattern)).toBe(false);
    }
  });

  // WP-59: the policy lint's broad-domain check (src/pipeline/policy-lint.ts)
  // rejects allow rules that grant these patterns.
  it.each([
    ['*.co.uk', 'two-label ICANN suffix'],
    ['*.com.au', 'two-label ICANN suffix'],
    ['*.vercel.app', 'private-section suffix'],
    ['*.readthedocs.io', 'private-section suffix'],
    ['*.githubusercontent.com', 'private-section suffix'],
    ['*.s3.amazonaws.com', 'private-section suffix'],
    ['*.kawasaki.jp', 'children are public suffixes (PSL wildcard rule)'],
    ['*.compute.amazonaws.com', 'under a multi-tenant cloud parent'],
    ['*.us-east-1.compute.amazonaws.com', 'under a multi-tenant cloud parent'],
    ['*.host.us-east-1.compute.amazonaws.com', 'still under a multi-tenant cloud parent'],
    ['*.COM', 'case is ignored'],
    ['*.com.', 'a trailing dot is ignored (https://evil.com./ keeps it)'],
    ['*..com', 'empty label'],
    ['*.1.2.3', 'an IPv4 literal spelled as labels'],
    ['*.localhost', 'a local name'],
    ['*.github.com/provos/ironcurtain', 'a wildcard whose suffix is no hostname fails closed'],
  ])('%s is broad (%s)', (pattern) => {
    expect(isBroadDomainPattern(pattern)).toBe(true);
  });

  it.each([
    ['*.abcnews.go.com', 'a subdomain of a registrable domain'],
    ['*.raw.githubusercontent.com', 'one tenant below a private-section suffix'],
    ['*.city.kawasaki.jp', 'a PSL exception: one registrable domain'],
  ])('%s is narrow (%s)', (pattern) => {
    expect(isBroadDomainPattern(pattern)).toBe(false);
  });
});

describe('canAutoWildcard', () => {
  it('widens names under an ICANN suffix only', () => {
    for (const host of ['nytimes.com', 'www.nytimes.com', 'bbc.co.uk', 'developer.mozilla.org']) {
      expect(canAutoWildcard(host)).toBe(true);
    }
    for (const host of [
      'alice.github.io',
      'raw.githubusercontent.com',
      'amazonaws.com',
      'sts.amazonaws.com',
      'gateway.dev',
      'com',
      'localhost',
      '127.0.0.1',
    ]) {
      expect(canAutoWildcard(host)).toBe(false);
    }
  });
});
