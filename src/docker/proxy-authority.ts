/**
 * Strict parsing of the two request targets an HTTP proxy receives from the
 * agent: the CONNECT authority (`host:port`) and the absolute-form URL of a
 * plain-HTTP proxy request (`GET http://host:port/path`).
 *
 * Both parsers produce the single canonical host spelling every allowlist in
 * the MITM proxy is keyed by (see `canonicalizeHostname`), and they classify
 * IP literals explicitly so the caller can screen them: the network stack
 * never hands a literal to a resolver, so the guarded lookup that protects
 * passthrough names from reaching loopback, link-local or RFC 1918 addresses
 * would otherwise be skipped for `CONNECT 127.0.0.1:443`.
 *
 * The parsers are deliberately strict and run before the proxy acknowledges
 * anything. `parseInt`-style parsing accepted `443junk`, `0443`, `-1`,
 * `99999` and `::1:443` (split on the last colon), and Node then threw
 * `ERR_SOCKET_BAD_PORT` synchronously from inside the server's `connect`
 * listener, which took down the whole process (MITM-3).
 */

import { canonicalizeHostname, classifyHostLiteral } from '../net/address-policy.js';

/** A host as the proxy will look it up. */
export interface ProxyHost {
  /**
   * Canonical host: a lowercase ASCII name without trailing dot, or the
   * canonical, unbracketed text of an IP literal (`127.0.0.1`, `::1`).
   */
  readonly host: string;
  /** True when `host` is an IP literal, which no resolver will ever screen. */
  readonly isIpLiteral: boolean;
}

export interface ConnectAuthority extends ProxyHost {
  /** Decimal port, 1-65535. */
  readonly port: number;
}

export type ProxyRequestTarget =
  /** An absolute-form `http://` request target the proxy may forward. */
  | ({ readonly kind: 'proxy'; readonly port: number; readonly path: string } & ProxyHost)
  /** An absolute-form target that cannot be forwarded as written. */
  | { readonly kind: 'invalid'; readonly reason: string }
  /** Not an `http://` absolute-form target (origin-form or another scheme). */
  | { readonly kind: 'not-proxy' };

/**
 * `host:port` with a bracketed IPv6 literal or a colon-free host, and a
 * canonical decimal port (no sign, no leading zero, no suffix). Unbracketed
 * IPv6 (`::1:443`) cannot match because the host part may not contain a colon.
 */
const CONNECT_AUTHORITY_RE = /^(\[[^\]]*\]|[^:[\]]+):([1-9][0-9]{0,4})$/u;

const MAX_PORT = 65_535;

/**
 * Characters that never belong in a host as the agent writes it. The URL
 * host parser behind the literal classifier would truncate at the
 * delimiters or decode the escapes (`1.2.3.4/x` reads as `1.2.3.4`), so
 * they are refused before classification instead of folded.
 */
const NON_HOST_CHARACTERS = /[\s\p{Cc}/?#\\%@]/u;

/**
 * Classify and canonicalize one host string. Returns undefined for text that
 * is neither a valid hostname nor a well-formed IP literal, including text
 * that merely looks like a literal (`1.2.3.4.5`, `[nope]`, a zone id), which
 * must never fall through to a resolver as a "name".
 */
export function resolveProxyHost(text: string): ProxyHost | undefined {
  if (NON_HOST_CHARACTERS.test(text)) return undefined;
  const literal = classifyHostLiteral(text);
  if (literal.kind === 'ip') return { host: literal.address, isIpLiteral: true };
  if (literal.kind === 'ip-like') return undefined;
  const host = canonicalizeHostname(text);
  if (host === undefined) return undefined;
  // Invariant: `isIpLiteral: false` means the canonical host is not a
  // literal. A spelling the classifier reads as a name but whose canonical
  // form is a literal (`127.0.0.1..` once was) is refused outright: the
  // network stack would dial it without consulting the guarded resolver.
  if (classifyHostLiteral(host).kind !== 'name') return undefined;
  return { host, isIpLiteral: false };
}

/**
 * Parse a CONNECT request target. Returns undefined for anything that is not
 * `host:port` with a valid host and a decimal port in 1-65535, so the caller
 * can answer `400 Bad Request` before acknowledging the tunnel.
 */
export function parseConnectAuthority(authority: string): ConnectAuthority | undefined {
  const match = CONNECT_AUTHORITY_RE.exec(authority);
  if (match === null) return undefined;
  const port = Number(match[2]);
  if (port > MAX_PORT) return undefined;
  const hostText = match[1];
  if (hostText.startsWith('[')) {
    // Brackets are only ever an IPv6 literal; `[example.com]` is malformed.
    const literal = classifyHostLiteral(hostText);
    if (literal.kind !== 'ip' || literal.family !== 6) return undefined;
    return { host: literal.address, isIpLiteral: true, port };
  }
  const host = resolveProxyHost(hostText);
  return host === undefined ? undefined : { ...host, port };
}

/**
 * Parse the request target of a plain-HTTP proxy request. The WHATWG URL
 * parser already lowercases and IDNA-maps the host, but keeps a trailing dot
 * and brackets, so the host is canonicalized again through the shared
 * classifier. Userinfo and a zero port are refused rather than ignored.
 */
export function parseProxyRequestTarget(url: string): ProxyRequestTarget {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // An absolute-form target the URL parser refuses (for example a port
    // above 65535) is a bad proxy request, not an origin-form request.
    return /^https?:\/\//iu.test(url)
      ? { kind: 'invalid', reason: 'unparsable absolute-form target' }
      : { kind: 'not-proxy' };
  }
  if (parsed.protocol !== 'http:') return { kind: 'not-proxy' };
  if (parsed.username !== '' || parsed.password !== '') {
    return { kind: 'invalid', reason: 'userinfo in proxy request target' };
  }
  const host = resolveProxyHost(parsed.hostname);
  if (host === undefined) return { kind: 'invalid', reason: 'invalid host in proxy request target' };
  const port = parsed.port === '' ? 80 : Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    return { kind: 'invalid', reason: 'invalid port in proxy request target' };
  }
  return { kind: 'proxy', ...host, port, path: `${parsed.pathname}${parsed.search}` };
}
