/**
 * Host patterns for policy-evaluated MITM egress (`egressPolicy.allowedHosts`
 * in `~/.ironcurtain/config.json`, see docs/designs/mitm-egress-policy.md).
 *
 * A pattern is one of:
 *
 * - `*`: every host name (never an IP literal: the policy engine's domain
 *   matcher refuses to match `*` against an address);
 * - `*.example.com`: `example.com` and every name below it;
 * - `registry.example.com`: exactly that host.
 *
 * The host part must be a name the MITM proxy could admit at all: a
 * canonical multi-label DNS name, not an IP literal in any spelling, not
 * `localhost`, and not a local or metadata-scoped name (`*.local`,
 * `*.internal`, `metadata.google.internal`, ...). This mirrors
 * `validateDomain` in `src/docker/proxy-tools.ts`, which the egress gate
 * applies to every destination before policy sees it, so a pattern can
 * never name something the gate would refuse anyway.
 *
 * Leaf module: depends only on the address policy, so the config schema can
 * use it without loading the docker or trusted-process layers.
 */

import { canonicalizeHostname, classifyHostLiteral, isLocalOrMetadataHostname } from './address-policy.js';

/** Multi-label LDH name, the shape `validateDomain` accepts. */
const DOMAIN_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/u;

/** The pattern that admits every host name. */
export const EGRESS_ANY_HOST_PATTERN = '*';

/** Human-readable statement of what a valid pattern is, for config errors. */
export const EGRESS_HOST_PATTERN_RULE =
  'must be "*", "*.<domain>" or "<domain>", where the domain is a multi-label host name ' +
  '(no IP addresses, no localhost, no local or metadata-scoped names)';

/**
 * The canonical spelling of an egress host pattern (lowercase, ASCII, no
 * trailing dot), or undefined when the value is not an acceptable pattern.
 */
export function canonicalEgressHostPattern(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === EGRESS_ANY_HOST_PATTERN) return EGRESS_ANY_HOST_PATTERN;
  const wildcard = trimmed.startsWith('*.');
  const hostText = wildcard ? trimmed.slice(2) : trimmed;
  if (classifyHostLiteral(hostText).kind !== 'name') return undefined;
  const host = canonicalizeHostname(hostText);
  if (host === undefined || host.length > 253 || !DOMAIN_NAME.test(host)) return undefined;
  if (isLocalOrMetadataHostname(host)) return undefined;
  return wildcard ? `*.${host}` : host;
}

/** True when `value` is an acceptable egress host pattern. */
export function isEgressHostPattern(value: string): boolean {
  return canonicalEgressHostPattern(value) !== undefined;
}
