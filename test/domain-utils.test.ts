/**
 * Tests for domain-utils.ts: IP-literal detection in every spelling, git URL
 * host canonicalization (the way git itself parses the URL), the reason
 * display filter and the approver's view of a git remote, and URL-value
 * resolution for domain checks.
 *
 * Named-remote resolution from repository config is covered in
 * git-remote-resolution.test.ts.
 */

import { describe, it, expect } from 'vitest';
import type { TrustedGitRemoteConfig } from '../src/trusted-process/git-remote-resolution.js';
import {
  describeGitRemoteDestination,
  displayableDomain,
  domainMatchesAllowlist,
  extractGitDomain,
  isIpAddress,
  isPlainGitRemoteName,
  parseGitRemoteUrl,
  resolveUrlForDomainCheck,
} from '../src/trusted-process/domain-utils.js';

const SHIPPED_GIT_ALLOWLIST = ['github.com', '*.github.com', 'gitlab.com', '*.gitlab.com'];
const NO_TRUSTED_CONFIG = (): TrustedGitRemoteConfig => ({ entries: [] });

function trustedRewrite(base: string, name: 'insteadof' | 'pushinsteadof', prefix: string): TrustedGitRemoteConfig {
  return {
    entries: [{ section: 'url', subsection: base, name, key: `url.${base}.${name}`, value: prefix, line: 0 }],
  };
}

describe('isIpAddress', () => {
  it('counts every inet_aton IPv4 spelling as an IP', () => {
    for (const host of ['127.0.0.1', '2130706433', '127.1', '0x7f000001', '0177.0.0.1', '0x7f.1', '10.1']) {
      expect(isIpAddress(host), host).toBe(true);
    }
  });

  it('counts IPv6 (bracketed, mapped, zone-scoped) and malformed literals as IPs', () => {
    for (const host of ['::1', '[::1]', 'fe80::1', '[::ffff:127.0.0.1]', 'fe80::1%eth0', '1.2.3.4.5', '[nope]']) {
      expect(isIpAddress(host), host).toBe(true);
    }
  });

  it('does not count names as IPs', () => {
    for (const host of ['github.com', 'localhost', '1e100.net', 'deadbeef', 'api.example.com']) {
      expect(isIpAddress(host), host).toBe(false);
    }
  });

  it('keeps `*` from matching any spelling of an IP', () => {
    expect(domainMatchesAllowlist('2130706433', ['*'])).toBe(false);
    expect(domainMatchesAllowlist('127.1/owner/repo', ['*'])).toBe(false);
    expect(domainMatchesAllowlist('0x7f.1', ['*'])).toBe(false);
    expect(domainMatchesAllowlist('github.com', ['*'])).toBe(true);
  });
});

describe('parseGitRemoteUrl / extractGitDomain', () => {
  it('canonicalizes IP hosts in ssh, git and scp-like URLs', () => {
    expect(extractGitDomain('ssh://git@2130706433/o/r')).toBe('127.0.0.1/o/r');
    expect(extractGitDomain('git://0x7f000001/o/r')).toBe('127.0.0.1/o/r');
    expect(extractGitDomain('git@127.1:o/r')).toBe('127.0.0.1/o/r');
    expect(extractGitDomain('git@[::1]:o/r')).toBe('[::1]/o/r');
    expect(extractGitDomain('[::1]:o/r')).toBe('[::1]/o/r');
    expect(extractGitDomain('ssh://git@[::ffff:127.0.0.1]:2222/x')).toBe('[::ffff:7f00:1]/x');
  });

  it('keeps encoded IP hosts out of a `*` allowlist', () => {
    for (const url of ['ssh://git@2130706433/o/r', 'git://2130706433/o/r', 'git@127.1:o/r', 'git@[::1]:o/r']) {
      expect(domainMatchesAllowlist(extractGitDomain(url), ['*']), url).toBe(false);
    }
  });

  it('lowercases names, including in non-special schemes', () => {
    expect(extractGitDomain('ssh://git@GitHub.COM/acme/x.git')).toBe('github.com/acme/x');
    expect(extractGitDomain('git@GitHub.com:acme/x.git')).toBe('github.com/acme/x');
  });

  it('percent-decodes ssh and git URLs before splitting out the host, as git does', () => {
    // git connects to evil.example here, so `*.github.com` must not match.
    const domain = extractGitDomain('ssh://git@evil.example%2f.github.com/x');
    expect(domain).toBe('evil.example/.github.com/x');
    expect(domainMatchesAllowlist(domain, SHIPPED_GIT_ALLOWLIST)).toBe(false);
    expect(parseGitRemoteUrl('git://evil.example%2f.github.com/x')?.host).toBe('evil.example');
  });

  it('keeps ordinary https, ssh and scp-like URLs working', () => {
    expect(extractGitDomain('https://github.com/provos/ironcurtain.git')).toBe('github.com/provos/ironcurtain');
    expect(extractGitDomain('https://user:pass@github.com:8443/o/r.git?x=1#y')).toBe('github.com/o/r');
    expect(extractGitDomain('git@github.com:provos/ironcurtain.git')).toBe('github.com/provos/ironcurtain');
    expect(extractGitDomain('ssh://git@github.com:22/o/r')).toBe('github.com/o/r');
    expect(extractGitDomain('https://github.com/')).toBe('github.com');
    expect(extractGitDomain('http://github.com:80@evil.example/x')).toBe('evil.example/x');
  });

  it('refuses what it cannot verify: helpers, local paths, odd schemes and ambiguous authorities', () => {
    for (const url of [
      'https::https://github.com/x', // remote helper syntax
      'SSH://git@github.com/x', // git hands a non-lowercase scheme to git-remote-SSH
      'ftp://github.com/x',
      'file:///srv/repo.git',
      '/srv/repo.git',
      './relative',
      'origin',
      'https://github.com\\@evil.example/x', // backslash: WHATWG and curl disagree
      'https://a@evil.example@github.com/x', // two @: parsers disagree
      'a@b@evil.example:x',
      'ssh://-oProxyCommand=x/y', // option-like host
      'ssh://git@github.com:/x', // empty port
      'ssh://git@github.com:99999/x',
      'https://git hub.com/x',
      'https://bücher.example/x',
      'ssh://git@evil%0a.example/x', // decodes to a control character
      'ssh://git@1.2.3.4.5/x', // malformed IPv4 literal
      'ssh://git@[fe80::1%25eth0]/x', // zone-scoped IPv6
    ]) {
      expect(parseGitRemoteUrl(url), url).toBeUndefined();
    }
  });

  it('returns values it cannot parse unchanged from extractGitDomain', () => {
    expect(extractGitDomain('origin')).toBe('origin');
    expect(extractGitDomain('/srv/repo.git')).toBe('/srv/repo.git');
  });
});

describe('displayableDomain', () => {
  it('shows validated names and canonical IP literals with plain repository paths', () => {
    expect(displayableDomain('github.com/acme/project')).toBe('github.com/acme/project');
    expect(displayableDomain('127.0.0.1/o/r')).toBe('127.0.0.1/o/r');
    expect(displayableDomain('[::1]')).toBe('[::1]');
  });

  it('drops a repository path with unusual characters but keeps a valid host', () => {
    expect(displayableDomain('github.com/a%1b[31m/x')).toBe('github.com');
  });

  it('refuses hosts that are not validated names or canonical literals', () => {
    for (const domain of ['\u001b[31mevil', 'GitHub.com', '2130706433', 'evil example', 'origin:x', '']) {
      expect(displayableDomain(domain), JSON.stringify(domain)).toBeUndefined();
    }
  });
});

describe('isPlainGitRemoteName / describeGitRemoteDestination', () => {
  it('accepts plain remote names only', () => {
    for (const name of ['origin', 'upstream', 'my.fork', 'fork_2', 'a-b']) {
      expect(isPlainGitRemoteName(name), name).toBe(true);
    }
    for (const value of [
      '',
      '-x',
      'git@github.com:o/r',
      'https://github.com/o/r',
      'a/b',
      'evil\u001b[31m',
      'x'.repeat(101),
    ]) {
      expect(isPlainGitRemoteName(value), JSON.stringify(value)).toBe(false);
    }
  });

  it('names a remote and where it connects, or the destination alone for a URL', () => {
    const resolved = { status: 'resolved', domains: ['github.com/acme/project'] } as const;
    expect(describeGitRemoteDestination('origin', resolved)).toBe('origin -> github.com/acme/project');
    expect(describeGitRemoteDestination('https://github.com/acme/project.git', resolved)).toBe(
      'github.com/acme/project',
    );
    expect(
      describeGitRemoteDestination('origin', {
        status: 'resolved',
        domains: ['github.com/acme/project', 'gitlab.com/acme/project'],
      }),
    ).toBe('origin -> github.com/acme/project, gitlab.com/acme/project');
  });

  it('shows only validated text', () => {
    expect(describeGitRemoteDestination('origin', { status: 'resolved', domains: ['\u001b[31mevil/x'] })).toBe(
      'origin -> an unrecognized host',
    );
    expect(
      describeGitRemoteDestination('origin', {
        status: 'unverifiable',
        reason: 'the repository path is outside the sandbox',
        domains: [],
      }),
    ).toBe('origin -> an unverified destination (the repository path is outside the sandbox)');
    expect(
      describeGitRemoteDestination('evil\u001b[31m', {
        status: 'unverifiable',
        reason: 'the remote is not configured in the repository',
        domains: [],
      }),
    ).toBe('an unverified destination (the remote is not configured in the repository)');
  });
});

describe('resolveUrlForDomainCheck (URL values)', () => {
  it('resolves fetch-url values to their WHATWG hostname', () => {
    expect(resolveUrlForDomainCheck('http://2130706433/x', 'fetch-url', {})).toEqual({
      status: 'resolved',
      domains: ['127.0.0.1'],
    });
  });

  it('takes a git URL at face value when there is no repository context', () => {
    const target = resolveUrlForDomainCheck(
      'https://github.com/acme/x.git',
      'git-remote-url',
      {},
      { loadTrustedGitConfig: NO_TRUSTED_CONFIG },
    );
    expect(target).toEqual({ status: 'resolved', domains: ['github.com/acme/x'] });
  });

  it('applies the user’s trusted url.<base>.insteadOf rewrite, as git does', () => {
    const target = resolveUrlForDomainCheck(
      'https://github.com/acme/x.git',
      'git-remote-url',
      {},
      { loadTrustedGitConfig: () => trustedRewrite('https://mirror.example/', 'insteadof', 'https://github.com/') },
    );
    expect(target).toEqual({ status: 'resolved', domains: ['mirror.example/acme/x'] });
  });

  it('also evaluates a trusted pushInsteadOf destination', () => {
    const target = resolveUrlForDomainCheck(
      'https://github.com/acme/x.git',
      'git-remote-url',
      {},
      { loadTrustedGitConfig: () => trustedRewrite('https://push.example/', 'pushinsteadof', 'https://github.com/') },
    );
    expect(target).toEqual({ status: 'resolved', domains: ['github.com/acme/x', 'push.example/acme/x'] });
  });

  it('marks a bare remote name without a repository as unverifiable', () => {
    const target = resolveUrlForDomainCheck(
      'github.com',
      'git-remote-url',
      {},
      { loadTrustedGitConfig: NO_TRUSTED_CONFIG },
    );
    expect(target.status).toBe('unverifiable');
    expect(target.domains).toEqual([]);
  });

  it('marks local paths and file URLs as unverifiable', () => {
    for (const value of ['file:///srv/repo.git', 'https::https://github.com/x']) {
      const target = resolveUrlForDomainCheck(value, 'git-remote-url', {}, { loadTrustedGitConfig: NO_TRUSTED_CONFIG });
      expect(target.status, value).toBe('unverifiable');
    }
  });

  it('fails closed when the user’s git config cannot be read', () => {
    const target = resolveUrlForDomainCheck(
      'https://github.com/acme/x.git',
      'git-remote-url',
      {},
      { loadTrustedGitConfig: () => undefined },
    );
    expect(target).toMatchObject({ status: 'unverifiable', reason: "the user's git configuration could not be read" });
  });
});
