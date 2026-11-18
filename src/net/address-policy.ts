/**
 * Destination-address policy shared by every component that opens a network
 * connection to a destination an agent can influence (MITM upstreams, registry
 * egress, the fetch server, structural URL gates).
 *
 * The policy has two layers, and a caller needs both:
 *
 * - **Names** are screened by resolving them through {@link createGuardedLookup},
 *   which fails the whole lookup when *any* answer violates the policy, so a
 *   DNS rebinding answer set that mixes a public and a private address is
 *   refused instead of raced. {@link isLocalOrMetadataHostname} rejects names
 *   that are local or cloud-metadata scoped before any resolution happens.
 * - **IP literals** are never passed to a resolver by Node's `net`/`tls`/undici
 *   connect paths, so a guarded lookup alone does not see them. Screen every
 *   destination host with {@link screenIpLiteral} first: it recognizes every
 *   textual form the network stack would accept (dotted quad, the inet_aton
 *   short/octal/hex forms such as `127.1` or `0x7f.1`, bracketed IPv6, IPv6 with
 *   a zone id, and spellings the WHATWG URL host parser turns into an IPv4
 *   literal, such as `１２７.０.０.１` or `127.0.0.1%2e`) and classifies the
 *   address it denotes.
 *
 * Classification is byte-based, never prefix matching on text: an IPv6 literal
 * is expanded to 16 bytes, and embedded IPv4 destinations (IPv4-mapped,
 * IPv4-compatible, NAT64 well-known prefix, 6to4, Teredo) are classified by the
 * IPv4 address they reach. Only ordinary global unicast is public.
 *
 * This module is a leaf (Node built-ins only) so `src/docker/`, `src/servers/`
 * and `src/trusted-process/` can all import it without a layering edge.
 */

import type * as dns from 'node:dns';
import * as net from 'node:net';
import { domainToASCII } from 'node:url';

/**
 * - `public-only`: only globally routable unicast destinations.
 * - `trusted-provider-override`: additionally RFC 1918, CGNAT, loopback and
 *   IPv6 ULA, for a host-configured private model gateway. Link-local/metadata,
 *   unspecified, multicast and documentation ranges stay denied.
 */
export type AddressPolicy = 'public-only' | 'trusted-provider-override';

export type AddressPolicyErrorCode = 'ADDRESS_NOT_ALLOWED' | 'INVALID_IP_LITERAL';

/** Raised by {@link screenIpLiteral}; catch on `code`, not `instanceof`. */
export class AddressPolicyError extends Error {
  readonly code: AddressPolicyErrorCode;

  constructor(code: AddressPolicyErrorCode, message: string) {
    super(message);
    this.name = 'AddressPolicyError';
    this.code = code;
  }
}

/** Result of {@link screenIpLiteral} for a host that passed the policy. */
export type ScreenedHost =
  | { readonly kind: 'name'; readonly hostname: string }
  | { readonly kind: 'ip'; readonly address: string; readonly family: 4 | 6 };

// ── IPv4 ────────────────────────────────────────────────────────────────

type Ipv4Range = readonly [network: number, prefixLength: number];

/** IANA special-purpose IPv4 blocks that are never public destinations. */
const NON_PUBLIC_IPV4: readonly Ipv4Range[] = [
  [0x00000000, 8], // 0.0.0.0/8 "this network"
  [0x0a000000, 8], // 10.0.0.0/8 private
  [0x64400000, 10], // 100.64.0.0/10 shared address space (CGNAT)
  [0x7f000000, 8], // 127.0.0.0/8 loopback
  [0xa9fe0000, 16], // 169.254.0.0/16 link-local, cloud metadata
  [0xac100000, 12], // 172.16.0.0/12 private
  [0xc0000000, 24], // 192.0.0.0/24 IETF protocol assignments
  [0xc0000200, 24], // 192.0.2.0/24 TEST-NET-1
  [0xc0586300, 24], // 192.88.99.0/24 6to4 relay anycast (deprecated)
  [0xc0a80000, 16], // 192.168.0.0/16 private
  [0xc6120000, 15], // 198.18.0.0/15 benchmarking
  [0xc6336400, 24], // 198.51.100.0/24 TEST-NET-2
  [0xcb007100, 24], // 203.0.113.0/24 TEST-NET-3
  [0xe0000000, 4], // 224.0.0.0/4 multicast
  [0xf0000000, 4], // 240.0.0.0/4 reserved, broadcast
];

/** Private IPv4 blocks a trusted provider gateway may use. */
const TRUSTED_PROVIDER_IPV4: readonly Ipv4Range[] = [
  [0x0a000000, 8],
  [0x64400000, 10],
  [0x7f000000, 8],
  [0xac100000, 12],
  [0xc0a80000, 16],
];

function inIpv4Range(value: number, [network, prefixLength]: Ipv4Range): boolean {
  const mask = prefixLength === 0 ? 0 : (0xffff_ffff << (32 - prefixLength)) >>> 0;
  return (value & mask) >>> 0 === (network & mask) >>> 0;
}

function isPublicIpv4Value(value: number): boolean {
  return !NON_PUBLIC_IPV4.some((range) => inIpv4Range(value, range));
}

function isTrustedProviderIpv4Value(value: number): boolean {
  return isPublicIpv4Value(value) || TRUSTED_PROVIDER_IPV4.some((range) => inIpv4Range(value, range));
}

/** Strict dotted-quad parse (the only IPv4 form `net.isIP` accepts). */
function parseDottedQuad(input: string): number | undefined {
  if (net.isIP(input) !== 4) return undefined;
  const parts = input.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function formatIpv4(value: number): string {
  return [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join('.');
}

function ipv4FromBytes(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

/**
 * One inet_aton / WHATWG URL "IPv4 number": decimal, `0`-prefixed octal or
 * `0x`-prefixed hex (`0x` alone is zero). Returns undefined when malformed.
 */
function parseIpv4Number(part: string): bigint | undefined {
  if (part === '') return undefined;
  let digits = part;
  let radix = 10;
  if (/^0x/iu.test(digits)) {
    radix = 16;
    digits = digits.slice(2);
  } else if (digits.length > 1 && digits.startsWith('0')) {
    radix = 8;
    digits = digits.slice(1);
  }
  if (digits === '') return 0n;
  const pattern = radix === 16 ? /^[0-9a-f]+$/iu : radix === 8 ? /^[0-7]+$/u : /^[0-9]+$/u;
  if (!pattern.test(digits)) return undefined;
  // Cap the length so an absurd literal cannot cost more than a bounded parse.
  if (digits.length > 40) return undefined;
  const prefix = radix === 16 ? '0x' : radix === 8 ? '0o' : '';
  return BigInt(`${prefix}${digits}`);
}

/**
 * Parse any IPv4 textual form the platform resolver or the WHATWG URL parser
 * would turn into an address: 1 to 4 dot-separated numbers, each decimal,
 * octal or hex, where the last number fills the remaining bytes (`127.1`,
 * `2130706433`, `0x7f.0.0.1`, `017700000001`). One trailing dot is ignored.
 */
function parseInetAtonIpv4(host: string): number | undefined {
  const parts = host.split('.');
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  if (parts.length === 0 || parts.length > 4) return undefined;
  const numbers: bigint[] = [];
  for (const part of parts) {
    const value = parseIpv4Number(part);
    if (value === undefined) return undefined;
    numbers.push(value);
  }
  const last = numbers[numbers.length - 1];
  const leading = numbers.slice(0, -1);
  if (leading.some((value) => value > 255n)) return undefined;
  if (last >= 256n ** BigInt(5 - numbers.length)) return undefined;
  let address = last;
  leading.forEach((value, index) => {
    address += value * 256n ** BigInt(3 - index);
  });
  return Number(address);
}

/** True when the last dot-separated label (ignoring one trailing dot) is numeric, so the host is an IPv4 literal. */
function endsInIpv4Number(host: string): boolean {
  const labels = host.split('.');
  if (labels.length > 1 && labels[labels.length - 1] === '') labels.pop();
  const last = labels[labels.length - 1] ?? '';
  return /^(?:[0-9]+|0x[0-9a-f]*)$/iu.test(last);
}

// ── IPv6 ────────────────────────────────────────────────────────────────

type Ipv6Prefix = readonly [bytes: readonly number[], prefixLength: number];

/** IANA special-purpose blocks inside 2000::/3 that are not ordinary global unicast. */
const NON_PUBLIC_GLOBAL_IPV6: readonly Ipv6Prefix[] = [
  [[0x20, 0x01, 0x00, 0x00], 23], // 2001::/23 IETF protocol assignments (Teredo handled first)
  [[0x20, 0x01, 0x0d, 0xb8], 32], // 2001:db8::/32 documentation
  [[0x26, 0x20, 0x00, 0x4f, 0x80, 0x00], 48], // 2620:4f:8000::/48 direct delegation AS112
  [[0x3f, 0xff], 20], // 3fff::/20 documentation
];

const NAT64_WELL_KNOWN: Ipv6Prefix = [[0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0], 96]; // 64:ff9b::/96
const NAT64_LOCAL_USE: Ipv6Prefix = [[0x00, 0x64, 0xff, 0x9b, 0x00, 0x01], 48]; // 64:ff9b:1::/48

function matchesIpv6Prefix(bytes: Uint8Array, [prefix, prefixLength]: Ipv6Prefix): boolean {
  const whole = Math.floor(prefixLength / 8);
  for (let index = 0; index < whole; index += 1) {
    if (bytes[index] !== (prefix[index] ?? 0)) return false;
  }
  const remainder = prefixLength % 8;
  if (remainder === 0) return true;
  const mask = (0xff << (8 - remainder)) & 0xff;
  return (bytes[whole] & mask) === ((prefix[whole] ?? 0) & mask);
}

/**
 * Expand an IPv6 literal (no brackets, no zone id; an embedded dotted IPv4
 * tail is allowed) to 16 bytes. Returns undefined when malformed.
 */
function parseIpv6(input: string): Uint8Array | undefined {
  if (net.isIP(input) !== 6 || input.includes('%')) return undefined;
  let text = input.toLowerCase();
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseDottedQuad(tail);
    if (v4 === undefined) return undefined;
    text = `${text.slice(0, lastColon)}:${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const left = halves[0] === '' ? [] : halves[0].split(':');
  const right = halves.length === 2 && halves[1] !== '' ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return undefined;
  const words = [...left, ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => '0'), ...right];
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/u.test(word))) return undefined;
  const bytes = new Uint8Array(16);
  words.forEach((word, index) => {
    const value = Number.parseInt(word, 16);
    bytes[index * 2] = value >>> 8;
    bytes[index * 2 + 1] = value & 0xff;
  });
  return bytes;
}

function allZero(bytes: Uint8Array, start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) {
    if (bytes[index] !== 0) return false;
  }
  return true;
}

/**
 * The IPv4 destination an IPv6 address embeds, when it is one of the forms the
 * network stack or a translator turns into an IPv4 connection.
 */
function embeddedIpv4(bytes: Uint8Array): { readonly kind: 'mapped' | 'other'; readonly value: number } | undefined {
  // ::ffff:0:0/96 IPv4-mapped.
  if (allZero(bytes, 0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return { kind: 'mapped', value: ipv4FromBytes(bytes, 12) };
  }
  // ::/96 IPv4-compatible (deprecated); also covers :: and ::1.
  if (allZero(bytes, 0, 12)) return { kind: 'other', value: ipv4FromBytes(bytes, 12) };
  // 64:ff9b::/96 NAT64 well-known prefix (RFC 6052).
  if (matchesIpv6Prefix(bytes, NAT64_WELL_KNOWN)) return { kind: 'other', value: ipv4FromBytes(bytes, 12) };
  // 2002::/16 6to4 carries the endpoint IPv4 right after the prefix.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return { kind: 'other', value: ipv4FromBytes(bytes, 2) };
  return undefined;
}

function isPublicIpv6Bytes(bytes: Uint8Array): boolean {
  const embedded = embeddedIpv4(bytes);
  if (embedded !== undefined) return isPublicIpv4Value(embedded.value);
  // RFC 8215 local-use NAT64 is never public.
  if (matchesIpv6Prefix(bytes, NAT64_LOCAL_USE)) return false;
  // Teredo (2001::/32) carries a server IPv4 and an XOR-obfuscated client IPv4.
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0 && bytes[3] === 0) {
    const client = (ipv4FromBytes(bytes, 12) ^ 0xffff_ffff) >>> 0;
    return isPublicIpv4Value(ipv4FromBytes(bytes, 4)) && isPublicIpv4Value(client);
  }
  // Only ordinary global unicast remains: 2000::/3 minus special-purpose blocks.
  if ((bytes[0] & 0xe0) !== 0x20) return false;
  return !NON_PUBLIC_GLOBAL_IPV6.some((prefix) => matchesIpv6Prefix(bytes, prefix));
}

function isTrustedProviderIpv6Bytes(bytes: Uint8Array): boolean {
  if (isPublicIpv6Bytes(bytes)) return true;
  const embedded = embeddedIpv4(bytes);
  if (embedded?.kind === 'mapped') return isTrustedProviderIpv4Value(embedded.value);
  // ::1 loopback and fc00::/7 unique local addresses.
  if (allZero(bytes, 0, 15) && bytes[15] === 1) return true;
  return (bytes[0] & 0xfe) === 0xfc;
}

// ── Public classifiers ─────────────────────────────────────────────────

/**
 * Conservative routability classifier used for SSRF and rebinding defense.
 * Accepts only addresses `net.isIP` recognizes; anything else (including an
 * IPv6 address with a zone id) is not public.
 */
export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) {
    const value = parseDottedQuad(address);
    return value !== undefined && isPublicIpv4Value(value);
  }
  if (family === 6) {
    const bytes = parseIpv6(address);
    return bytes !== undefined && isPublicIpv6Bytes(bytes);
  }
  return false;
}

/**
 * Private destinations intentionally supported for a trusted provider gateway.
 * Link-local/metadata, unspecified, multicast, and documentation-only ranges
 * remain denied even on this path.
 */
export function isTrustedProviderAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) {
    const value = parseDottedQuad(address);
    return value !== undefined && isTrustedProviderIpv4Value(value);
  }
  if (family === 6) {
    const bytes = parseIpv6(address);
    return bytes !== undefined && isTrustedProviderIpv6Bytes(bytes);
  }
  return false;
}

/** {@link isPublicAddress} or {@link isTrustedProviderAddress}, selected by `allowPrivate`. */
export function isAddressAllowed(address: string, allowPrivate: boolean): boolean {
  return allowPrivate ? isTrustedProviderAddress(address) : isPublicAddress(address);
}

/** 100.100.100.200: Alibaba Cloud instance metadata, inside CGNAT 100.64.0.0/10. */
const ALIBABA_METADATA_IPV4 = 0x646464c8;
/**
 * 168.63.129.16: Azure's WireServer, which serves the VM agent its goal state
 * and extension settings. It is a public address, so the public-only tier
 * admits it.
 */
const AZURE_WIRESERVER_IPV4 = 0xa83f8110;

function builtInIpv6(literal: string): Uint8Array {
  const bytes = parseIpv6(literal);
  if (bytes === undefined) throw new Error(`malformed built-in IPv6 address: ${literal}`);
  return bytes;
}

/**
 * Documented IPv6 instance-metadata and credential endpoints. All sit in ULA
 * fc00::/7, which the trusted-provider tier admits.
 */
const METADATA_IPV6: readonly Uint8Array[] = [
  'fd00:ec2::254', // AWS instance metadata service (IMDS)
  'fd00:ec2::23', // AWS EKS Pod Identity Agent (serves credentials)
  'fd20:ce::254', // Google Cloud metadata server
  'fd00:c1::a9fe:a9fe', // Oracle Cloud instance metadata
  'fd00:a9fe:a9fe::1', // Akamai (Linode) metadata service
  'fd00:42::42', // Scaleway instance metadata
].map(builtInIpv6);

function isMetadataIpv4Value(value: number): boolean {
  return inIpv4Range(value, [0xa9fe0000, 16]) || value === ALIBABA_METADATA_IPV4 || value === AZURE_WIRESERVER_IPV4;
}

/**
 * True for a cloud instance-metadata address: all of link-local
 * 169.254.0.0/16 (the AWS, GCP, Azure, Oracle and ECS endpoints live there),
 * Alibaba Cloud's 100.100.100.200, Azure's WireServer 168.63.129.16 and the
 * documented IPv6 endpoints in {@link METADATA_IPV6} (AWS, Google Cloud,
 * Oracle, Akamai, Scaleway), the IPv4 ones also in IPv4-mapped and other
 * embedded forms. Most of these sit in ranges the trusted-provider tier
 * admits, and the WireServer is public, so a caller that must never reach
 * metadata screens destinations, DNS answers included, with this as well.
 */
export function isMetadataAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) {
    const value = parseDottedQuad(address);
    return value !== undefined && isMetadataIpv4Value(value);
  }
  if (family === 6) {
    const bytes = parseIpv6(address);
    if (bytes === undefined) return false;
    const embedded = embeddedIpv4(bytes);
    if (embedded !== undefined) return isMetadataIpv4Value(embedded.value);
    return METADATA_IPV6.some((candidate) => candidate.every((byte, index) => bytes[index] === byte));
  }
  return false;
}

/** RFC 5952 text (the WHATWG URL serialization): lowercase, first longest run of 2+ zero pieces compressed. */
function formatIpv6(bytes: Uint8Array): string {
  const pieces = Array.from({ length: 8 }, (_, index) => (bytes[index * 2] << 8) | bytes[index * 2 + 1]);
  let bestStart = -1;
  let bestLength = 1;
  for (let start = 0; start < 8;) {
    if (pieces[start] !== 0) {
      start += 1;
      continue;
    }
    let end = start;
    while (end < 8 && pieces[end] === 0) end += 1;
    if (end - start > bestLength) {
      bestStart = start;
      bestLength = end - start;
    }
    start = end;
  }
  const hex = (from: number, to: number): string =>
    pieces
      .slice(from, to)
      .map((piece) => piece.toString(16))
      .join(':');
  if (bestStart < 0) return hex(0, 8);
  return `${hex(0, bestStart)}::${hex(bestStart + bestLength, 8)}`;
}

/** What a host denotes, for policy code that must canonicalize a host before comparing it. */
export type HostLiteralClass =
  /** An IP literal in a form {@link screenIpLiteral} accepts; `address` is canonical and unbracketed. */
  | { readonly kind: 'ip'; readonly address: string; readonly family: 4 | 6 }
  /**
   * Text that the resolver or the URL parser would read as an IP literal but
   * that has no canonical address: a malformed literal (`1.2.3.4.5`, `09`,
   * `[nope]`) or an IPv6 literal with a zone id. Treat it as an IP that
   * matches nothing.
   */
  | { readonly kind: 'ip-like' }
  /** Anything else: a DNS name, not validated beyond "not an IP literal". */
  | { readonly kind: 'name' };

/**
 * Classify a host the way {@link screenIpLiteral} reads it, without applying
 * any address policy and without throwing. Every IPv4 spelling the platform
 * resolver or the WHATWG URL parser accepts (`127.1`, `0x7f.1`, `2130706433`,
 * `017700000001`, `１２７.０.０.１`) gives the dotted quad `127.0.0.1`; IPv6,
 * bracketed or not, gives RFC 5952 text (`::ffff:7f00:1`), the spelling a
 * WHATWG URL `hostname` uses inside its brackets.
 */
export function classifyHostLiteral(host: string): HostLiteralClass {
  const opens = host.startsWith('[');
  if (opens !== host.endsWith(']') || (opens && host.length < 2)) return { kind: 'ip-like' };
  const candidate = opens ? host.slice(1, -1) : host;

  if (opens || candidate.includes(':')) {
    if (candidate.includes('%')) return { kind: 'ip-like' };
    const bytes = parseIpv6(candidate);
    return bytes === undefined ? { kind: 'ip-like' } : { kind: 'ip', address: formatIpv6(bytes), family: 6 };
  }

  const looksNumeric = candidate !== '' && endsInIpv4Number(candidate);
  const value = (looksNumeric ? parseInetAtonIpv4(candidate) : undefined) ?? parseDottedQuad(domainToASCII(candidate));
  if (value === undefined) return looksNumeric ? { kind: 'ip-like' } : { kind: 'name' };
  return { kind: 'ip', address: formatIpv4(value), family: 4 };
}

/**
 * Screen a destination host that may be an IP literal. Returns `{kind:'name'}`
 * for a DNS name (resolve it through {@link createGuardedLookup}); returns the
 * canonical address for an allowed literal; throws {@link AddressPolicyError}
 * with code `ADDRESS_NOT_ALLOWED` for a literal the policy forbids and
 * `INVALID_IP_LITERAL` for a host that looks like a literal but is malformed
 * (it must never fall through to a resolver as a "name").
 *
 * Accepts bracketed IPv6 (`[::1]`), IPv6 with a zone id (always refused), and
 * every inet_aton IPv4 form (`127.1`, `0x7f.1`, `2130706433`). A host whose
 * raw text is a name is also screened in the spelling the WHATWG URL host
 * parser gives it (percent-decoding, tab/newline removal, UTS #46 mapping of
 * full-width digits and ideographic full stops), because a caller that later
 * embeds the host in a URL connects to that literal without any lookup.
 */
export function screenIpLiteral(host: string, options: { readonly allowPrivate?: boolean } = {}): ScreenedHost {
  const allowPrivate = options.allowPrivate === true;
  const opens = host.startsWith('[');
  if (opens !== host.endsWith(']') || (opens && host.length < 2)) {
    throw new AddressPolicyError('INVALID_IP_LITERAL', `malformed bracketed IP literal: ${host}`);
  }
  const candidate = opens ? host.slice(1, -1) : host;

  if (opens || candidate.includes(':')) {
    if (candidate.includes('%')) {
      throw new AddressPolicyError('ADDRESS_NOT_ALLOWED', `scoped IPv6 literal is not allowed: ${host}`);
    }
    const bytes = parseIpv6(candidate);
    if (bytes === undefined) throw new AddressPolicyError('INVALID_IP_LITERAL', `malformed IPv6 literal: ${host}`);
    const allowed = allowPrivate ? isTrustedProviderIpv6Bytes(bytes) : isPublicIpv6Bytes(bytes);
    if (!allowed) throw new AddressPolicyError('ADDRESS_NOT_ALLOWED', `destination address is not allowed: ${host}`);
    return { kind: 'ip', address: candidate.toLowerCase(), family: 6 };
  }

  const looksNumeric = candidate !== '' && endsInIpv4Number(candidate);
  // `domainToASCII` runs the WHATWG URL host parser, IPv4 number forms included.
  const value = (looksNumeric ? parseInetAtonIpv4(candidate) : undefined) ?? parseDottedQuad(domainToASCII(candidate));
  if (value === undefined) {
    if (looksNumeric) throw new AddressPolicyError('INVALID_IP_LITERAL', `malformed IPv4 literal: ${host}`);
    return { kind: 'name', hostname: host };
  }
  const allowed = allowPrivate ? isTrustedProviderIpv4Value(value) : isPublicIpv4Value(value);
  if (!allowed) throw new AddressPolicyError('ADDRESS_NOT_ALLOWED', `destination address is not allowed: ${host}`);
  return { kind: 'ip', address: formatIpv4(value), family: 4 };
}

// ── Hostnames ──────────────────────────────────────────────────────────

/** Exact names that reach a cloud instance-metadata service. */
const METADATA_HOSTNAMES: ReadonlySet<string> = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
  'instance-data',
  'instance-data.ec2.internal',
]);

const LOCAL_HOSTNAMES: ReadonlySet<string> = new Set([
  'localhost',
  'localhost.localdomain',
  'localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'home.arpa',
]);

/** Suffixes reserved for loopback, link-local mDNS, private use or residential networks. */
const LOCAL_SUFFIXES: readonly string[] = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa'];

/**
 * Characters the WHATWG URL host parser would silently fold away instead of
 * rejecting: it truncates at `/`, `?`, `#` and `\`, percent-decodes `%XX`,
 * and strips tabs and newlines. In a hostname they can only be an attempt to
 * make two different strings mean the same host, so they are refused.
 */
const FOLDED_HOST_CHARACTERS = /[\s\p{Cc}/?#\\%]/u;

/** A canonical name: ASCII letters, digits, `-` and `_` labels joined by single dots. */
const CANONICAL_HOSTNAME = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/u;

/**
 * The one canonical spelling of a hostname for allowlist keys and lookups:
 * trimmed, lowercased and mapped to ASCII by the WHATWG URL host parser
 * (UTS #46), then one trailing dot removed, so `ＡＰＩ.example.com`,
 * `api.example.com.` and `api.example.com。` all become `api.example.com`.
 * Returns undefined when the text is not a usable hostname: empty, longer
 * than 253 octets, an empty or over-long label, a character the host parser
 * forbids (`:`, `@`, brackets, `*`, ...), or one it would fold away rather
 * than reject (`/`, `?`, `#`, `\`, `%`, whitespace and control characters;
 * see {@link FOLDED_HOST_CHARACTERS}). Every component that keys a provider,
 * registry or passthrough allowlist by hostname must go through this
 * function so no lookup can be bypassed by a spelling variant.
 *
 * The trailing dot is removed only AFTER the host parser ran. The parser
 * itself drops one trailing dot when it reads the text as an IPv4 literal,
 * so removing one beforehand as well would turn `127.0.0.1..`, which every
 * literal classifier reads as a name (its last label is empty), into the
 * literal `127.0.0.1`: a "name" that the network stack then dials without
 * any lookup or address screen.
 *
 * IP literal text comes back as the parser spells it (an IPv4 literal in any
 * inet_aton form becomes its dotted quad); callers that must tell a literal
 * from a name classify it with {@link classifyHostLiteral} first. IPv6
 * literals are not hostnames and come back undefined.
 */
export function canonicalizeHostname(value: string): string | undefined {
  const candidate = value.trim().toLowerCase();
  if (candidate === '' || FOLDED_HOST_CHARACTERS.test(candidate)) return undefined;
  const ascii = domainToASCII(candidate).replace(/\.$/u, '');
  if (ascii.length > 253 || !CANONICAL_HOSTNAME.test(ascii)) return undefined;
  if (ascii.split('.').some((label) => label.length > 63)) return undefined;
  return ascii;
}

/**
 * The spellings a name is matched in: as written (trimmed, lowercased) and as
 * the WHATWG URL host parser normalizes it (percent-decoding, UTS #46 mapping
 * such as full-width `ＬＯＣＡＬＨＯＳＴ`), each without one trailing dot.
 */
function hostnameSpellings(hostname: string): string[] {
  const trimmed = hostname.trim();
  const spellings = [trimmed.toLowerCase(), domainToASCII(trimmed)].map((name) => name.replace(/\.$/u, ''));
  return spellings.filter((name) => name !== '');
}

/** True for a name that reaches a cloud instance-metadata service, under any policy. */
export function isMetadataHostname(hostname: string): boolean {
  return hostnameSpellings(hostname).some((name) => METADATA_HOSTNAMES.has(name));
}

/**
 * True for a name that is local or metadata scoped: `localhost` and
 * `*.localhost`, mDNS `*.local`, `*.internal` (including `*.docker.internal`
 * and `metadata.google.internal`), `*.localdomain`, `*.home.arpa`, the Debian
 * `ip6-localhost`/`ip6-loopback` aliases and the cloud metadata names.
 * Case-insensitive, also in the WHATWG URL spelling (full-width or
 * percent-encoded forms); one trailing dot is ignored. IP literals are not
 * names: screen them with {@link screenIpLiteral}.
 */
export function isLocalOrMetadataHostname(hostname: string): boolean {
  return hostnameSpellings(hostname).some(
    (name) =>
      METADATA_HOSTNAMES.has(name) ||
      LOCAL_HOSTNAMES.has(name) ||
      LOCAL_SUFFIXES.some((suffix) => name.endsWith(suffix)),
  );
}

// ── Guarded resolver ───────────────────────────────────────────────────

/**
 * Wrap a resolver so it fails the whole lookup when *any* returned address is
 * non-public (or, with `allowPrivate`, outside the trusted-provider set). This
 * is the single implementation of the address policy for name destinations;
 * it is shared by the direct transport (as `RequestOptions.lookup`), by the
 * fixed-parent transport's destination screen, by the MITM proxy's raw
 * passthrough tunnel and by the fetch MCP server, so none of them can drift
 * from the others.
 *
 * A policy refusal is an {@link AddressPolicyError} with code
 * `ADDRESS_NOT_ALLOWED` (it survives as the `cause` of a failed connect, so a
 * caller can tell it apart from a resolver error); resolver errors pass
 * through unchanged.
 */
export function createGuardedLookup(lookup: typeof dns.lookup, allowPrivate: boolean): typeof dns.lookup {
  type LookupResult = string | dns.LookupAddress[];
  type LookupCallback = (error: NodeJS.ErrnoException | null, result: LookupResult, family?: number) => void;
  const invokeLookup = lookup as unknown as (
    hostname: string,
    options: dns.LookupAllOptions,
    callback: LookupCallback,
  ) => void;
  return ((hostname: string, options: dns.LookupOptions, callback: LookupCallback) => {
    const allOptions: dns.LookupAllOptions = { ...options, all: true, verbatim: true };
    invokeLookup(hostname, allOptions, (error, result, family) => {
      if (error) {
        callback(error, []);
        return;
      }
      const addresses = Array.isArray(result) ? result : [{ address: result, family: family === 6 ? 6 : 4 }];
      if (
        addresses.length === 0 ||
        addresses.some((entry) => net.isIP(entry.address) === 0 || !isAddressAllowed(entry.address, allowPrivate))
      ) {
        callback(
          new AddressPolicyError(
            'ADDRESS_NOT_ALLOWED',
            `DNS resolution for ${hostname} included a non-public address or disallowed address`,
          ),
          [],
        );
        return;
      }
      if (options.all) callback(null, addresses);
      else {
        const selected = addresses[0];
        callback(null, selected.address, selected.family);
      }
    });
  }) as typeof dns.lookup;
}
