/**
 * Public-suffix-aware hostname classification for domain breadth checks.
 *
 * The runtime matcher (`domainMatchesAllowlist` in
 * trusted-process/domain-utils.ts) treats a pattern `*.S` as a plain hostname
 * suffix match: it reaches every host that ends in `.S`. Whether such a
 * wildcard is narrow therefore depends on who controls the hosts under `S`,
 * not on how many labels `S` has. `*.co.uk` and `*.github.io` both have two
 * labels, yet anyone can register a name directly below either of them.
 *
 * This module answers that question with the Public Suffix List (PSL), using
 * both of its sections (through the `tldts` package):
 *  - the ICANN section: registry-operated suffixes such as `com`, `co.uk`;
 *  - the private section: multi-tenant hosting suffixes such as `github.io`,
 *    `pages.dev`, `vercel.app`, `s3.amazonaws.com`, where every subdomain
 *    belongs to a different customer.
 * A small curated list ({@link MULTI_TENANT_PARENT_DOMAINS}) adds cloud
 * provider domains whose subdomains are handed to customers but which the PSL
 * does not list as suffixes themselves. A registrable name directly above a
 * PSL wildcard rule (`gateway.dev` for `*.gateway.dev`) is treated the same
 * way, since each of its children is a separate tenant's suffix.
 *
 * Consumers: the persona broad-policy validator (src/persona/), which decides
 * whether a compiled wildcard needs the broad-policy opt-in, the pipeline
 * policy lint (src/pipeline/policy-lint.ts), which rejects allow rules that
 * grant a broad pattern on every compile path unless the policy opted in, and
 * the dynamic list resolver (src/pipeline/), which validates resolved domain
 * values and decides which values it may widen to `*.value`. A leaf module:
 * it depends on `tldts` and the shared address helpers in
 * src/net/address-policy.ts only.
 */

import { parse } from 'tldts';
import { canonicalizeHostname, classifyHostLiteral, isLocalOrMetadataHostname } from '../net/address-policy.js';

/**
 * Cloud provider domains whose subdomains are assigned to customers (storage
 * buckets, function and container endpoints, VM DNS labels), so a wildcard at
 * or below one of them reaches hosts that other people control and can log.
 * The PSL lists some of these tenant namespaces only further down (for example
 * `s3.amazonaws.com`, `blob.core.windows.net` and `up.railway.app`) or not at
 * all (Azure's `<label>.<region>.cloudapp.azure.com`, the public Codespaces
 * ports at `<codespace>-<port>.app.github.dev`). Not exhaustive: it
 * supplements the PSL for the parents an honest compile is most likely to
 * widen. (A PSL wildcard rule directly below a name, such as `*.gateway.dev`,
 * is detected without an entry here.)
 */
const MULTI_TENANT_PARENT_DOMAINS: readonly string[] = [
  'amazonaws.com',
  'amazonaws.com.cn',
  'on.aws',
  'windows.net',
  'azure.com',
  'run.app',
  'github.dev',
  'railway.app',
];

/** How a hostname relates to the Public Suffix List. */
export type HostClass =
  /** Not a usable hostname: empty, forbidden characters, an empty or over-long label. */
  | { readonly kind: 'invalid' }
  /** An IP literal, or text the resolver or the URL parser would read as one (`127.1`, `2130706433`, `[::1]`). */
  | { readonly kind: 'ip' }
  /**
   * Not a public internet name: localhost, mDNS `.local`, private-use
   * `.internal`/`.localdomain`/`.home.arpa`, cloud metadata names, a single
   * label, or a name whose top-level domain is not in the PSL's ICANN section.
   */
  | { readonly kind: 'local' }
  /** The name is itself a public suffix, so anyone can register a name directly below it. */
  | { readonly kind: 'public-suffix'; readonly section: 'icann' | 'private' }
  /** The name lies inside one registrable domain (eTLD+1). */
  | {
      readonly kind: 'registrable';
      /** The registrable domain under the full PSL (ICANN and private sections). */
      readonly registrableDomain: string;
      /** True when that domain sits under a suffix from the PSL private (multi-tenant hosting) section. */
      readonly privateSuffix: boolean;
      /**
       * The multi-tenant parent the name equals or lies under, if any: a curated
       * cloud parent ({@link MULTI_TENANT_PARENT_DOMAINS}), or the name itself
       * when a PSL wildcard rule makes every name directly below it a public
       * suffix (`*.gateway.dev`, `*.kobe.jp`), so each child belongs to a
       * different registrant.
       */
      readonly multiTenantParent?: string;
    };

const INVALID: HostClass = { kind: 'invalid' };
const IP: HostClass = { kind: 'ip' };
const LOCAL: HostClass = { kind: 'local' };

/** Lookup restricted to the ICANN section: tells whether the TLD is a real, delegated one. */
const ICANN_ONLY = { allowPrivateDomains: false, extractHostname: false } as const;
/** Lookup over the whole list, private (multi-tenant) suffixes included. */
const FULL_LIST = { allowPrivateDomains: true, extractHostname: false } as const;

/**
 * A label no PSL rule names (exception rules such as `!city.kobe.jp` name real
 * labels), used to ask what public suffix an arbitrary child of a name has.
 */
const PROBE_LABEL = 'x-psl-probe-0';

function findMultiTenantParent(host: string): string | undefined {
  return MULTI_TENANT_PARENT_DOMAINS.find((parent) => host === parent || host.endsWith(`.${parent}`));
}

/**
 * True when a PSL wildcard rule (`*.host`) applies directly below `host`: an
 * arbitrary child then has a longer public suffix than `host` itself, i.e.
 * every `<label>.host` is a separate tenant's suffix even though `host` is
 * registrable. A child that cannot be parsed counts as one (fail closed).
 */
function hasWildcardSuffixBelow(host: string, publicSuffix: string | null): boolean {
  return parse(`${PROBE_LABEL}.${host}`, FULL_LIST).publicSuffix !== publicSuffix;
}

/**
 * Classifies a hostname (no scheme, port, path or wildcard). Matching is on the
 * canonical spelling: lowercased, mapped to ASCII the way the URL parser maps
 * it, and without one trailing dot. Anything that cannot be classified is
 * `invalid`, so callers that treat "not registrable" as broad fail closed.
 */
export function classifyHost(value: string): HostClass {
  const raw = value.trim();
  if (raw === '') return INVALID;
  if (classifyHostLiteral(raw).kind !== 'name') return IP;
  const host = canonicalizeHostname(raw);
  if (host === undefined) return INVALID;
  // The URL host parser turns spellings such as full-width digits into an IPv4 literal.
  if (classifyHostLiteral(host).kind !== 'name') return IP;
  if (isLocalOrMetadataHostname(host)) return LOCAL;

  // No ICANN rule matches a single label that is not a TLD, nor any name under
  // an unknown TLD (`corp`, `lan`, `internal`): none of them is a public name.
  if (parse(host, ICANN_ONLY).isIcann !== true) return LOCAL;

  const full = parse(host, FULL_LIST);
  if (full.domain === null || full.publicSuffix === host) {
    return { kind: 'public-suffix', section: full.isPrivate === true ? 'private' : 'icann' };
  }
  const multiTenantParent =
    findMultiTenantParent(host) ?? (hasWildcardSuffixBelow(host, full.publicSuffix) ? host : undefined);
  return {
    kind: 'registrable',
    registrableDomain: full.domain,
    privateSuffix: full.isPrivate === true,
    ...(multiTenantParent !== undefined ? { multiTenantParent } : {}),
  };
}

/**
 * True when `host` lies inside one registrable domain of the full PSL. False
 * for IP literals, local and private-use names, single labels, unknown TLDs
 * and public suffixes themselves (`com`, `co.uk`, `github.io`).
 */
export function isRegistrable(host: string): boolean {
  return classifyHost(host).kind === 'registrable';
}

/**
 * Returns true iff an allowlist pattern grants access to hosts that many
 * unrelated parties control, mirroring the runtime matcher where `*` matches
 * any non-IP host and `*.S` matches every host ending in `.S`.
 *
 * Broad:
 *  - `*`, and `*.` (an empty suffix)
 *  - `*.S` where `S` is a public suffix from either PSL section: `*.com`,
 *    `*.co.uk`, `*.github.io`, `*.pages.dev`, `*.s3.amazonaws.com`
 *  - `*.S` where `S` is at or below a curated multi-tenant cloud parent:
 *    `*.amazonaws.com`, `*.core.windows.net`
 *  - `*.S` where a PSL wildcard rule makes every name directly below `S` a
 *    public suffix of its own: `*.gateway.dev`, `*.kobe.jp`
 *  - `*.S` where `S` is not a registrable public name at all (an IP literal,
 *    `localhost`, `*.internal`, an unknown TLD, unparsable text): these are
 *    never a single registrant's namespace, so they fail closed.
 *
 * Narrow:
 *  - `*.S` where `S` lies inside one registrable domain: `*.github.com`,
 *    `*.example.co.uk`, and `*.alice.github.io` (one tenant's namespace)
 *  - any pattern without a leading `*.`: an exact host such as `github.com`,
 *    or a git `host/owner/repo` pattern, which the matcher compares exactly
 */
export function isBroadDomainPattern(pattern: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.startsWith('*.')) return false;
  const base = classifyHost(pattern.slice(2));
  return base.kind !== 'registrable' || base.multiTenantParent !== undefined;
}

/**
 * True when a hostname may be widened to `*.host` automatically: it lies inside
 * one registrable domain under an ICANN suffix and is not a multi-tenant
 * parent or under a curated one (see `multiTenantParent`). A name under a
 * private (multi-tenant hosting) suffix, such as `raw.githubusercontent.com`
 * or `alice.github.io`, is kept exact, and so is `gateway.dev`, whose children
 * are public suffixes.
 */
export function canAutoWildcard(host: string): boolean {
  const hostClass = classifyHost(host);
  return hostClass.kind === 'registrable' && !hostClass.privateSuffix && hostClass.multiTenantParent === undefined;
}
