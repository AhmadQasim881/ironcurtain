/**
 * Canonical request-path gate for the standard registry proxy.
 *
 * `handleRegistryRequest` decides what a request is (package metadata, one
 * package artifact, or a pass-through) by parsing the request path, then
 * validates the package that path names. The upstream registry resolves the
 * same path with its own URL normalization, so any path the two sides can
 * read differently is a policy bypass. The audit found three:
 *
 * - registry.npmjs.org removes `..` segments. `/@x/../express/-/express-4.18.2.tgz`
 *   parsed as a package named `../express` while upstream served the
 *   denylisted `express`.
 * - `/-/../express/-/express-4.18.2.tgz` took the raw `/-/` pass-through,
 *   with no denylist, age gate or audit, and upstream again served `express`.
 * - Debian mirrors percent-decode file names, so `%6Eetcat-traditional_...deb`
 *   and `..._amd64%2Edeb` escaped the denylist.
 *
 * {@link checkRegistryRequestPath} runs before any dispatch, for every
 * registry type and for both entry points: requests decrypted from a CONNECT
 * tunnel, and apt's plain-HTTP proxy requests after the MITM proxy rewrites
 * them to origin form. It admits only a path that has a single reading. A
 * parser that sees such a path and an upstream that normalizes it agree on
 * which resource it names. Everything else gets a 403 before parsing.
 *
 * The parsers then decode the path once and validate the decoded names
 * (npm in `parseNpmUrl`, Debian in `extractDebianPackageFromFilename`). For
 * npm, the proxy also rebuilds the upstream path from the validated identity
 * instead of forwarding the client's path.
 */

import type { RegistryType } from './package-types.js';

export type RegistryRequestPathCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** Fixed text, safe to put in a response body or log: never echoes the path. */
      readonly reason: string;
    };

/** Throwaway base for WHATWG parsing; only the resulting pathname is read. */
const CANONICAL_BASE = 'https://registry.invalid';

/**
 * Percent-encoded characters that change how a path is split or decoded:
 * `.` (hides a dot segment), `\` (a separator for WHATWG and many servers),
 * `%` (a second decoding pass), and `?` / `#` (a query or fragment delimiter
 * once decoded). The slash (`%2f`) is handled separately because npm needs it
 * for one exact form.
 */
const ENCODED_DELIMITER = /%(?:2e|5c|25|3f|23)/i;
const ENCODED_SLASH = /%2f/i;

/**
 * Accepts a registry request target only when its path has one unambiguous
 * reading. Rules, all fail-closed:
 *
 * 1. The target is origin-form (`/...`), printable ASCII only (no control
 *    character, space or raw non-ASCII byte), and has no `#` fragment.
 * 2. The path (the part before `?`) contains no backslash, no empty segment
 *    (`//`), no `.` or `..` segment, and only well-formed percent-encoding.
 *    No segment starts with a dot either. Servlet containers strip `;`
 *    path parameters before they resolve dot segments, so `..;` and `.;` are
 *    `..` and `.` to them. No registry package name or repository path
 *    segment starts with a dot.
 * 3. The path never percent-encodes `.`, `\`, `%`, `?` or `#`. It encodes `/`
 *    only for the npm scope separator, as one segment of the form
 *    `@scope%2fname`. That is how npm clients request a scoped packument.
 * 4. The path is already in WHATWG canonical form: `new URL(path).pathname`
 *    returns it unchanged. This catches dot segments in any spelling,
 *    backslashes, a leading `//` authority, and characters that should have
 *    been encoded.
 * 5. Decoded once, the path is still printable ASCII (no control character,
 *    space or non-ASCII character an upstream might Unicode-normalize, such as
 *    a fullwidth dot), and has no backslash, empty segment, or segment that
 *    starts with a dot. Every registry's package names and repository paths
 *    are ASCII.
 *
 * The query string is not interpreted here. It is checked only by rule 1.
 */
export function checkRegistryRequestPath(registry: RegistryType, target: string): RegistryRequestPathCheck {
  if (!target.startsWith('/')) return refuse('request target is not an origin-form path');
  if (!isPrintableAscii(target)) return refuse('request target contains a control, space, or non-ASCII character');
  if (target.includes('#')) return refuse('request target contains a fragment');

  const queryStart = target.indexOf('?');
  const path = queryStart < 0 ? target : target.slice(0, queryStart);
  if (path.includes('\\')) return refuse('request path contains a backslash');
  if (path.includes('//')) return refuse('request path contains an empty segment');
  if (hasMalformedPercentEncoding(path)) return refuse('request path has malformed percent-encoding');
  if (ENCODED_DELIMITER.test(path)) {
    return refuse('request path percent-encodes a dot, backslash, percent, or delimiter');
  }

  const segments = path.slice(1).split('/');
  if (segments.some(isDotSegment)) return refuse('request path contains a dot segment');
  if (segments.some((segment) => ENCODED_SLASH.test(segment) && !isEncodedNpmScopeSegment(registry, segment))) {
    return refuse('request path percent-encodes a slash');
  }
  if (segments.some(isDotLeadingSegment)) return refuse('request path has a segment that starts with a dot');

  if (canonicalPathname(path) !== path) return refuse('request path is not in canonical URL form');

  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // Well-formed escapes that are not valid UTF-8, e.g. %E0%A4.
    return refuse('request path has malformed percent-encoding');
  }
  if (
    !isPrintableAscii(decoded) ||
    decoded.includes('\\') ||
    decoded.includes('//') ||
    decoded.slice(1).split('/').some(isDotLeadingSegment)
  ) {
    return refuse('decoded request path is not canonical');
  }
  return { ok: true };
}

/**
 * True for exactly one npm scope-separator segment: it decodes to
 * `@scope/name`, with one slash and something on both sides. Grammar checks on
 * `scope` and `name` are left to `parseNpmUrl`.
 */
function isEncodedNpmScopeSegment(registry: RegistryType, segment: string): boolean {
  if (registry !== 'npm') return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return false;
  }
  const parts = decoded.split('/');
  return parts.length === 2 && parts[0].length > 1 && parts[0].startsWith('@') && parts[1].length > 0;
}

function canonicalPathname(path: string): string | undefined {
  try {
    return new URL(path, CANONICAL_BASE).pathname;
  } catch {
    return undefined;
  }
}

function isDotSegment(segment: string): boolean {
  return segment === '.' || segment === '..';
}

/** `.`, `..`, and spellings such as `..;` or `.;x` that a servlet container reads as one of them. */
function isDotLeadingSegment(segment: string): boolean {
  return segment.startsWith('.');
}

function isPrintableAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) return false;
  }
  return true;
}

function hasMalformedPercentEncoding(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '%') continue;
    if (!/^[0-9a-f]{2}$/iu.test(value.slice(index + 1, index + 3))) return true;
    index += 2;
  }
  return false;
}

function refuse(reason: string): RegistryRequestPathCheck {
  return { ok: false, reason };
}
