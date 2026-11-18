/**
 * Domain and URL utilities for policy evaluation.
 *
 * - Domain matching (domainMatchesAllowlist, isIpAddress), shared by the
 *   PolicyEngine and the list type registry (list-matcher.ts).
 * - Domain extraction (extractDomain, extractGitDomain, parseGitRemoteUrl),
 *   which canonicalizes hosts so that every spelling of an address compares
 *   equal (`2130706433`, `127.1` and `0x7f.1` are all `127.0.0.1`).
 * - resolveUrlForDomainCheck: the single resolver from a URL-role argument to
 *   every destination domain it reaches. The policy engine's structural domain
 *   gate and compiled `domains` conditions use it, and so does the approval
 *   whitelist (building and matching patterns) and the escalation prompt, so
 *   the views cannot drift. Named git remotes are resolved in-process by
 *   `git-remote-resolution.ts`.
 * - displayableDomain: the only form in which a domain may appear in a
 *   policy reason (shown to the agent and to the human approver).
 *   describeGitRemoteDestination builds on it to show a human approver where
 *   a git remote argument connects (`origin -> github.com/owner/repo`).
 *
 * URL canonicalizers (normalizeUrl, normalizeGitUrl) live in
 * `../types/url-normalize.js` so the ArgumentRole registry can use them
 * without forming a runtime cycle through this module.
 */

import {
  canonicalizeHostname,
  classifyHostLiteral,
  isLocalOrMetadataHostname,
  isMetadataAddress,
} from '../net/address-policy.js';
import { getRoleDefinition, type ArgumentRole } from '../types/argument-roles.js';
import {
  parseLocalGitSource,
  percentDecodeLikeGit,
  resolveGitRemoteUrls,
  type GitRemoteResolutionOptions,
} from './git-remote-resolution.js';

// ---------------------------------------------------------------------------
// Domain matching
// ---------------------------------------------------------------------------

/**
 * Checks whether a hostname is an IP literal, in any spelling the resolver or
 * the URL parser accepts: dotted quad, the inet_aton short/octal/hex/decimal
 * forms (`127.1`, `0177.0.0.1`, `0x7f000001`, `2130706433`), IPv6 bracketed or
 * not, and IPv6 with a zone id. Malformed literals (`1.2.3.4.5`) count as IPs
 * too. Used by the SSRF structural invariant to prevent `*` wildcards from
 * matching IP addresses.
 */
export function isIpAddress(domain: string): boolean {
  return classifyHostLiteral(domain).kind !== 'name';
}

/**
 * True for a destination host that reaches the local machine, a local
 * network or a cloud instance-metadata service by name (`localhost`,
 * `*.localhost`, `*.local`, `*.internal`, `metadata.google.internal`, ...;
 * see `isLocalOrMetadataHostname`), or that is a metadata IP literal in any
 * spelling (`169.254.169.254`, `fd00:ec2::254`, `100.100.100.200`, ...). The
 * policy engine denies such a fetch structurally, whatever the compiled rules
 * say. Other IP literals are left to the allowlist (`*` never matches them,
 * so they escalate), because a human may legitimately approve one.
 */
export function isLocalOrMetadataHost(host: string): boolean {
  const literal = classifyHostLiteral(host);
  if (literal.kind === 'ip') return isMetadataAddress(literal.address);
  return literal.kind === 'name' && isLocalOrMetadataHostname(host);
}

/**
 * Checks whether a domain matches any pattern in an allowlist.
 *
 * Supports hierarchical matching for git-remote-url domains that include
 * repository paths (e.g., `github.com/owner/repo`):
 * - `*` wildcard: matches any domain name (not IPs — SSRF structural invariant).
 * - `*.example.com` prefix wildcard: matches hostname portion only.
 * - Pattern without `/` (e.g., `github.com`): matches hostname portion
 *   (any repo on that host).
 * - Pattern with `/` (e.g., `github.com/owner/repo`): exact match only.
 *
 * For plain hostname domains (e.g., from `fetch-url`), behavior is unchanged.
 */
export function domainMatchesAllowlist(domain: string, allowedDomains: readonly string[]): boolean {
  const slashIdx = domain.indexOf('/');
  const hostname = slashIdx >= 0 ? domain.slice(0, slashIdx) : domain;

  return allowedDomains.some((pattern) => {
    if (pattern === '*') return !isIpAddress(hostname);
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1); // ".github.com"
      return hostname === pattern.slice(2) || hostname.endsWith(suffix);
    }
    // Pattern with path → exact match required
    if (pattern.includes('/')) return domain === pattern;
    // Pattern without path → match hostname portion
    return hostname === pattern;
  });
}

// ---------------------------------------------------------------------------
// Domain extraction
// ---------------------------------------------------------------------------

/** Extracts the hostname from an HTTP(S) URL. Returns value as-is on parse failure. */
export function extractDomain(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return value;
  }
}

/**
 * Extracts the domain from a URL value, dispatching to the correct
 * extractor based on role. Use this instead of calling extractDomain
 * or extractGitDomain directly when the role is available.
 */
export function extractDomainForRole(value: string, role: ArgumentRole): string {
  return role === 'git-remote-url' ? extractGitDomain(value) : extractDomain(value);
}

/**
 * Strips `.git` suffix and trailing slashes from a git repo path component.
 * Returns empty string for root-only paths (e.g., `/` or `/.git`).
 */
function normalizeGitRepoPath(pathname: string): string {
  let s = pathname;
  if (s.startsWith('/')) s = s.slice(1);
  if (s.endsWith('/')) s = s.slice(0, -1);
  if (s.endsWith('.git')) s = s.slice(0, -4);
  if (s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

/** Where a git remote URL connects, reduced to what the domain policy compares. */
export interface GitRemoteDestination {
  /** Canonical host: a lowercase name, a dotted-quad IPv4 address, or a bracketed IPv6 address. */
  readonly host: string;
  /** `host/owner/repo`, or just `host` when the URL has no repository path. */
  readonly domain: string;
}

/** Transports git connects with itself (ssh, git daemon) or through curl (http, https). */
const NETWORK_SCHEMES: ReadonlySet<string> = new Set(['https', 'http', 'ssh', 'git+ssh', 'ssh+git', 'git']);
/** Schemes git percent-decodes in full before it splits out the host (connect.c parse_connect_url). */
const PERCENT_DECODED_SCHEMES: ReadonlySet<string> = new Set(['ssh', 'git+ssh', 'ssh+git', 'git']);
const MAX_GIT_URL_LENGTH = 4096;
/** `[userinfo@]host[:port]`, where host is a bracketed IPv6 literal or a name/IPv4 token starting alphanumeric. */
const AUTHORITY_PATTERN =
  /^(?:([A-Za-z0-9._~!$&'()*+,;=:%-]*)@)?(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9][A-Za-z0-9._-]*)(?::([0-9]{1,5}))?$/u;
/** scp-like `[user@]host:path` with no `/` before the first `:` (git's url_is_local_not_ssh). */
const SCP_PATTERN = /^(?:([^@/:[\]]+)@)?(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9][A-Za-z0-9._-]*):(.*)$/su;

/** Canonical spelling of a host token, or undefined when it is not one this policy can compare. */
function canonicalHost(host: string): string | undefined {
  if (host.length > 253) return undefined;
  const literal = classifyHostLiteral(host);
  if (literal.kind === 'ip') return literal.family === 6 ? `[${literal.address}]` : literal.address;
  if (literal.kind === 'ip-like' || host.startsWith('[')) return undefined;
  return host.toLowerCase();
}

function destination(host: string, rawPath: string): GitRemoteDestination | undefined {
  const canonical = canonicalHost(host);
  if (canonical === undefined) return undefined;
  const repoPath = normalizeGitRepoPath(rawPath);
  return { host: canonical, domain: repoPath ? `${canonical}/${repoPath}` : canonical };
}

/**
 * Parse a git remote URL the way git does when it connects, and return the
 * host it reaches. Returns undefined for anything this policy cannot verify:
 * local paths, `file:` URLs, remote helpers (`<transport>::<address>` or an
 * unknown or non-lowercase scheme, which git hands to `git-remote-<scheme>`),
 * whitespace, control characters, backslashes or non-ASCII anywhere, more than
 * one `@` in the authority, or a host that is not a plain name or IP literal.
 *
 * ssh and git URLs are percent-decoded in full first, as git does, so
 * `ssh://git@evil.example%2f.github.com/x` reaches `evil.example`. The host is
 * canonicalized: names are lowercased and every IP spelling becomes its
 * canonical address (`git@127.1:x` reaches `127.0.0.1`, `git@[::1]:x` reaches
 * `[::1]`).
 */
export function parseGitRemoteUrl(url: string): GitRemoteDestination | undefined {
  const printableAscii = (text: string): boolean => /^[\x21-\x7e]+$/u.test(text) && !text.includes('\\');
  if (url.length > MAX_GIT_URL_LENGTH || !printableAscii(url)) return undefined;
  if (/^[A-Za-z][A-Za-z0-9+.-]*::/u.test(url)) return undefined;

  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//u.exec(url);
  if (scheme) {
    const name = scheme[1];
    if (!NETWORK_SCHEMES.has(name)) return undefined;
    let rest = url.slice(scheme[0].length);
    if (PERCENT_DECODED_SCHEMES.has(name)) {
      rest = percentDecodeLikeGit(rest);
      if (!printableAscii(rest)) return undefined;
    }
    const isHttp = name === 'http' || name === 'https';
    const end = isHttp ? rest.search(/[/?#]/u) : rest.indexOf('/');
    const authority = end < 0 ? rest : rest.slice(0, end);
    const pathAndQuery = end < 0 ? '' : rest.slice(end);
    const path = isHttp ? pathAndQuery.replace(/[?#].*$/su, '') : pathAndQuery;
    const match = AUTHORITY_PATTERN.exec(authority);
    if (!match) return undefined;
    // `at()` types the optional port group as possibly undefined, as it is at runtime.
    const port = match.at(3);
    if (port !== undefined && Number(port) > 65535) return undefined;
    return destination(match[2], path);
  }

  const scp = SCP_PATTERN.exec(url);
  if (!scp) return undefined; // a local path: a `/` before the first `:`, or no `:` at all
  return destination(scp[2], scp[3]);
}

/**
 * Extracts domain information from a git URL (HTTP or SSH format).
 * Returns `hostname/owner/repo` when a meaningful path is present,
 * or just `hostname` otherwise, with the host canonicalized as in
 * {@link parseGitRemoteUrl}. Anything that is not a network git URL (a
 * remote name, a local path) is returned unchanged.
 *
 * Examples:
 * - `https://github.com/provos/ironcurtain.git` → `github.com/provos/ironcurtain`
 * - `git@github.com:provos/ironcurtain.git` → `github.com/provos/ironcurtain`
 * - `ssh://git@2130706433/o/r` → `127.0.0.1/o/r`
 * - `https://github.com/` → `github.com`
 */
export function extractGitDomain(value: string): string {
  return parseGitRemoteUrl(value)?.domain ?? value;
}

// ---------------------------------------------------------------------------
// Destination resolution for domain checks
// ---------------------------------------------------------------------------

export interface DomainCheckContext {
  /** The sandbox root. Named git remotes resolve only from repositories inside it. */
  readonly allowedDirectory?: string;
  /** Replaces the cached snapshot of the user's git config (tests). */
  readonly loadTrustedGitConfig?: GitRemoteResolutionOptions['loadTrustedConfig'];
}

/**
 * Every destination domain a URL-role argument reaches.
 *
 * - `resolved`: `domains` lists them all (at least one); a domain check must
 *   require every one to pass.
 * - `unverifiable`: the destination cannot be established or must not be
 *   trusted (a named remote outside the sandbox, an unreadable or redirected
 *   repository config, a local path, a remote helper, ...). Domain checks
 *   must fail. `domains` lists what could still be computed, so a reason can
 *   name an off-allowlist destination, and `localPaths` the local
 *   repositories (as git would open them, not canonicalized) a git remote
 *   reaches, so the policy engine can refuse a protected one. `localSource`
 *   marks the one benign case: a git remote argument that names a local
 *   repository and nothing else (no configured remote of that name, no
 *   rewrite). It is still not a destination a domain check can accept, so
 *   whitelist and compiled `domains` conditions keep failing, but the
 *   structural domain gate leaves it to the policy engine's read-path
 *   evaluation of that path.
 */
export type DomainCheckTarget =
  | { readonly status: 'resolved'; readonly domains: readonly string[] }
  | {
      readonly status: 'unverifiable';
      readonly reason: string;
      readonly domains: readonly string[];
      readonly localPaths?: readonly string[];
      readonly localSource?: true;
    };

/** Reason reported for a git remote argument that is a local repository path (see `DomainCheckTarget`). */
export const LOCAL_GIT_SOURCE_REASON = 'it names a local repository path, which is evaluated as a filesystem read';

/**
 * The host of an http(s) URL as the fetch server would connect to it, or
 * undefined when the value is not an http(s) URL with a host (another
 * scheme, no host, unparseable). The fetch server refuses those, and the
 * policy must not pass them through a wildcard as if they named a host.
 */
function fetchUrlHost(canonical: string): string | undefined {
  try {
    const url = new URL(canonical);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname === '') return undefined;
    return url.hostname;
  } catch {
    return undefined;
  }
}

/**
 * Resolves a URL-role argument for domain checks:
 *   1. Canonicalize the value the way the transport receives it (roleDef.canonicalize).
 *   2. git-remote-url: resolve remote names and git's URL rewriting to every
 *      URL git could contact, without running git (git-remote-resolution.ts).
 *   3. Extract each destination's domain with a canonical host.
 *
 * An egress-host (the virtual `network` server's destination) that is not
 * a canonical host name is unverifiable. A fetch-url that is not an http(s)
 * URL with a host is unverifiable. A git remote argument that names a local
 * repository and resolves to nothing but itself is unverifiable with
 * `localSource` set (see `DomainCheckTarget`);
 * one that a configured remote or a rewrite turns into a network URL is
 * resolved to that destination, and a mix, or a rewrite onto a local path, is
 * plainly unverifiable.
 *
 * `allArgs` supplies the git repository path (`path`).
 */
export function resolveUrlForDomainCheck(
  value: string,
  role: ArgumentRole,
  allArgs: Record<string, unknown>,
  context: DomainCheckContext = {},
): DomainCheckTarget {
  const canonical = getRoleDefinition(role).canonicalize(value);
  if (role === 'egress-host') {
    // The MITM proxy hands policy the canonical host it parsed, not a URL.
    // Only a canonical name is a destination a domain check can accept: an
    // IP literal, or text the host parser would fold into another name, is
    // unverifiable, so neither a wildcard nor an allowlist entry matches it.
    const host = classifyHostLiteral(canonical).kind === 'name' ? canonicalizeHostname(canonical) : undefined;
    if (host === undefined || host !== canonical) {
      return { status: 'unverifiable', reason: 'it is not a canonical host name', domains: [] };
    }
    return { status: 'resolved', domains: [host] };
  }
  if (role === 'fetch-url') {
    const host = fetchUrlHost(canonical);
    if (host === undefined) {
      return { status: 'unverifiable', reason: 'it is not an http(s) URL with a host', domains: [] };
    }
    return { status: 'resolved', domains: [host] };
  }
  if (role !== 'git-remote-url') {
    return { status: 'resolved', domains: [extractDomainForRole(canonical, role)] };
  }

  const resolution = resolveGitRemoteUrls(canonical, allArgs, {
    allowedDirectory: context.allowedDirectory,
    loadTrustedConfig: context.loadTrustedGitConfig,
  });
  if (!resolution.ok) return { status: 'unverifiable', reason: resolution.reason, domains: [] };

  const unique = new Set<string>();
  const localPaths: string[] = [];
  let unrecognized = false;
  for (const url of resolution.urls) {
    const parsed = parseGitRemoteUrl(url);
    const local = parsed === undefined ? parseLocalGitSource(url) : undefined;
    if (parsed !== undefined) unique.add(parsed.domain);
    else if (local?.kind === 'path') localPaths.push(local.path);
    else unrecognized = true;
  }
  const domains = [...unique];
  // Every unverifiable answer below names the local repositories it reaches,
  // so the engine can refuse a protected one whatever else is wrong.
  const reaches = localPaths.length > 0 ? { localPaths } : {};
  if (unrecognized || (domains.length === 0 && localPaths.length === 0)) {
    return {
      status: 'unverifiable',
      reason: 'it resolves to a URL that is not a network URL this policy can verify',
      domains,
      ...reaches,
    };
  }
  if (resolution.overrides.length > 0) {
    return {
      status: 'unverifiable',
      reason: `the repository config changes where it connects (${resolution.overrides.join(', ')})`,
      domains,
      ...reaches,
    };
  }
  if (localPaths.length > 0) {
    // Only the argument itself, unrewritten and not the name of a configured
    // remote, is a plain local read. Anything else that ends on a local path
    // (a configured remote, a rewrite, a mix of network and local
    // destinations) is unverifiable.
    const isItself = domains.length === 0 && resolution.urls.length === 1 && resolution.urls[0] === canonical;
    if (isItself) {
      return { status: 'unverifiable', reason: LOCAL_GIT_SOURCE_REASON, domains: [], localPaths, localSource: true };
    }
    return { status: 'unverifiable', reason: 'it resolves to a local repository path', domains, localPaths };
  }
  return { status: 'resolved', domains };
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/** A lowercase DNS name: LDH labels (underscores tolerated), optional trailing dot. */
const DISPLAY_HOSTNAME =
  /^(?=[a-z0-9_.-]{1,254}$)[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?)*\.?$/u;
const DISPLAY_REPO_PATH = /^[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/u;

/**
 * The domain as it may appear in a policy reason, or undefined when its host
 * is not a validated name or canonical IP literal. A repository path is kept
 * only when it is made of plain path characters. Reasons reach the agent and
 * the human approver, so nothing else from an agent-chosen URL is echoed.
 */
export function displayableDomain(domain: string): string | undefined {
  const slash = domain.indexOf('/');
  const host = slash < 0 ? domain : domain.slice(0, slash);
  const path = slash < 0 ? '' : domain.slice(slash + 1);
  const literal = classifyHostLiteral(host);
  let shownHost: string | undefined;
  if (literal.kind === 'ip') {
    const canonical = literal.family === 6 ? `[${literal.address}]` : literal.address;
    shownHost = host === canonical ? host : undefined;
  } else if (literal.kind === 'name' && DISPLAY_HOSTNAME.test(host)) {
    shownHost = host;
  }
  if (shownHost === undefined) return undefined;
  if (path === '') return shownHost;
  return path.length <= 200 && DISPLAY_REPO_PATH.test(path) ? `${shownHost}/${path}` : shownHost;
}

/**
 * True for a plain git remote name (`origin`, `upstream`): the only form in
 * which an agent-chosen remote argument is echoed to the agent or a human.
 * URLs and scp-style addresses never qualify (they contain `:` or `/`).
 */
export function isPlainGitRemoteName(value: string): boolean {
  return /^[A-Za-z0-9._][A-Za-z0-9._-]{0,99}$/u.test(value);
}

/**
 * Where a git remote argument connects, for a human approver: the remote
 * name and its destination (`origin -> github.com/owner/repo`) for a plain
 * remote name, the destination alone for a URL, and why it cannot be told
 * when the target is unverifiable. A remote name alone says nothing about
 * where a push or fetch goes. Only validated text appears: the name when it
 * is a plain remote name, each destination through displayableDomain, and
 * the resolver's own fixed reasons.
 */
export function describeGitRemoteDestination(value: string, target: DomainCheckTarget): string {
  const destination =
    target.status === 'resolved'
      ? target.domains.map((domain) => displayableDomain(domain) ?? 'an unrecognized host').join(', ')
      : `an unverified destination (${target.reason})`;
  return isPlainGitRemoteName(value) ? `${value} -> ${destination}` : destination;
}
