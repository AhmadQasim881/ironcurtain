/**
 * Destination-guarded HTTP GET for the fetch MCP server (`http_fetch`).
 *
 * The policy engine evaluates only the URL the agent asked for, and the fetch
 * server runs unsandboxed on the host. This module is what keeps a fetch from
 * reaching anything else (SSRF into loopback services, the LAN, VPN hosts or a
 * cloud metadata endpoint):
 *
 * - **Every connection is screened.** Requests use undici's own `fetch` with a
 *   per-call `Agent` whose `connect.lookup` is `createGuardedLookup`: a name is
 *   resolved once, the whole answer set must be public, and the socket connects
 *   to an address that passed the check, so a rebinding answer cannot slip in
 *   between check and connect. Node never calls `lookup` for an IP literal, so
 *   literal hosts are screened with `screenIpLiteral` before the request, and
 *   local or metadata names are refused before any lookup.
 * - **Redirects are manual.** A same-origin redirect is followed, at most
 *   {@link MAX_SAME_ORIGIN_REDIRECTS} times, and every hop is re-validated. A
 *   cross-origin redirect is not followed: it is returned to the caller, so the
 *   next hop is a new `http_fetch` call that the policy evaluates and the audit
 *   log records. Agent-supplied headers therefore never leave the origin the
 *   policy evaluated.
 * - **Private destinations** are blocked unless the host opted in
 *   (`fetch.allowPrivateNetworks`), and then only when the requested URL names
 *   them literally: a private IP literal (RFC 1918, CGNAT, loopback, IPv6 ULA)
 *   or `localhost` / `*.localhost`, which connect to the loopback addresses
 *   without a lookup. Link-local and metadata addresses (including the
 *   metadata endpoints inside those private ranges, such as AWS's
 *   `fd00:ec2::254`, Google Cloud's `fd20:ce::254` and Alibaba Cloud's
 *   `100.100.100.200`; see `isMetadataAddress`), metadata names, other local
 *   names and DNS answers in private ranges stay blocked regardless.
 * - **Metadata addresses are refused in every mode**, as a literal or as a DNS
 *   answer, including Azure's WireServer `168.63.129.16`, which is a public
 *   address.
 *
 * undici's `fetch` and `Agent` come from the same npm package on purpose:
 * Node's global `fetch` bundles a different undici, and the two must not be
 * mixed.
 */

import * as dns from 'node:dns';
import { Agent, fetch, Headers, type Response } from 'undici';
import {
  AddressPolicyError,
  createGuardedLookup,
  isLocalOrMetadataHostname,
  isMetadataAddress,
  isMetadataHostname,
  screenIpLiteral,
  type ScreenedHost,
} from '../net/address-policy.js';

/** Same-origin redirects followed per call; the next one is refused. */
export const MAX_SAME_ORIGIN_REDIRECTS = 5;

/** Statuses whose `Location` is a redirect to follow (300 and 304 are not). */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** Upper bound on how much of an agent- or server-supplied URL an error message echoes. */
const MAX_ECHOED_URL_CHARS = 512;

export type GuardedFetchErrorCode =
  | 'INVALID_URL'
  | 'INVALID_HEADERS'
  | 'DESTINATION_NOT_ALLOWED'
  | 'INVALID_REDIRECT'
  | 'REDIRECT_LIMIT'
  | 'RESPONSE_TOO_LARGE'
  | 'TIMEOUT'
  | 'FETCH_FAILED';

/** A same-origin redirect that was followed. */
export interface RedirectHop {
  readonly status: number;
  /** URL that answered with the redirect. */
  readonly url: string;
  /** Absolute URL the redirect pointed to (and that was requested next). */
  readonly location: string;
}

interface GuardedFetchErrorContext {
  readonly url?: string;
  readonly redirects?: readonly RedirectHop[];
  readonly location?: string;
  readonly cause?: unknown;
}

/** Raised by {@link guardedFetch}; catch on `code`, not `instanceof`. */
export class GuardedFetchError extends Error {
  readonly code: GuardedFetchErrorCode;
  /** URL being requested when the call failed (after any followed redirects). */
  readonly url: string | undefined;
  /** Same-origin redirects followed before the failure. */
  readonly redirects: readonly RedirectHop[];
  /** The redirect target that was refused, for `INVALID_REDIRECT` / `REDIRECT_LIMIT`. */
  readonly location: string | undefined;

  constructor(code: GuardedFetchErrorCode, message: string, context: GuardedFetchErrorContext = {}) {
    super(message, context.cause === undefined ? undefined : { cause: context.cause });
    this.name = 'GuardedFetchError';
    this.code = code;
    this.url = context.url;
    this.redirects = context.redirects ?? [];
    this.location = context.location;
  }
}

export interface GuardedFetchOptions {
  /** Agent-supplied request headers. Sent only to the policy-evaluated origin. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Sent on every request, replacing any agent-supplied `User-Agent`. */
  readonly userAgent: string;
  /** Deadline for the whole call: every hop and the body. */
  readonly timeoutMs: number;
  /** A larger body fails the call with `RESPONSE_TOO_LARGE`. */
  readonly maxBodyBytes: number;
  /**
   * Host opt-in (`fetch.allowPrivateNetworks`): admit a private destination
   * that the URL names literally. Must never be derived from tool arguments.
   */
  readonly allowPrivateLiterals: boolean;
  /**
   * Whether to read the final response's body, given its `Content-Type`
   * header. A declined body is discarded unread and the result's `body` is
   * undefined. Defaults to reading every body.
   */
  readonly readBody?: (contentType: string | null) => boolean;
  /** Test seam; production resolves names with `node:dns.lookup`. */
  readonly lookup?: typeof dns.lookup;
}

/** The response to the requested URL, after any followed same-origin redirects. */
export interface GuardedFetchResponse {
  readonly kind: 'response';
  readonly status: number;
  /** URL whose response this is. */
  readonly url: string;
  readonly redirects: readonly RedirectHop[];
  readonly headers: Headers;
  /** The body, or undefined when `readBody` declined it. */
  readonly body: Uint8Array | undefined;
}

/** A redirect to another origin, returned unfollowed (its body is discarded). */
export interface GuardedFetchCrossOriginRedirect {
  readonly kind: 'cross-origin-redirect';
  readonly status: number;
  /** URL that answered with the redirect. */
  readonly url: string;
  /** Absolute redirect target. It was not requested. */
  readonly location: string;
  readonly redirects: readonly RedirectHop[];
  readonly headers: Headers;
}

export type GuardedFetchResult = GuardedFetchResponse | GuardedFetchCrossOriginRedirect;

/**
 * GET `rawUrl` under the destination guard described in the module comment.
 * Throws {@link GuardedFetchError} for every failure, carrying the URL being
 * requested and the redirects followed so far.
 */
export async function guardedFetch(rawUrl: string, options: GuardedFetchOptions): Promise<GuardedFetchResult> {
  const initial = parseRequestUrl(rawUrl);
  const headers = buildRequestHeaders(options.headers, options.userAgent);
  const resolver = options.lookup ?? dns.lookup;
  // Every followed hop is same-origin, so this connect-time policy is the
  // right one for the whole call; each hop is re-screened below regardless.
  const agent = new Agent({ connect: { lookup: screenDestination(initial, options.allowPrivateLiterals, resolver) } });

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);

  const redirects: RedirectHop[] = [];
  let current = initial;
  try {
    for (;;) {
      const response = await fetch(current.href, {
        method: 'GET',
        headers,
        redirect: 'manual',
        dispatcher: agent,
        signal: controller.signal,
      });

      const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get('location') : null;
      if (location === null) {
        let body: Uint8Array | undefined;
        if (options.readBody?.(response.headers.get('content-type')) ?? true) {
          body = await readBodyCapped(response, options.maxBodyBytes);
        } else {
          await discardBody(response);
        }
        return {
          kind: 'response',
          status: response.status,
          url: current.href,
          redirects,
          headers: response.headers,
          body,
        };
      }

      await discardBody(response);
      const target = resolveRedirect(location, current);
      if (target.origin !== current.origin) {
        return {
          kind: 'cross-origin-redirect',
          status: response.status,
          url: current.href,
          location: target.href,
          redirects,
          headers: response.headers,
        };
      }
      if (redirects.length >= MAX_SAME_ORIGIN_REDIRECTS) {
        throw new GuardedFetchError(
          'REDIRECT_LIMIT',
          `Redirect limit exceeded: refusing same-origin redirect ${redirects.length + 1} ` +
            `(at most ${MAX_SAME_ORIGIN_REDIRECTS} are followed)`,
          { location: target.href },
        );
      }
      if (target.username !== '' || target.password !== '') {
        throw new GuardedFetchError('INVALID_REDIRECT', 'Redirect target includes credentials', {
          location: target.href,
        });
      }
      // Re-validate the hop before requesting it. Same origin means same
      // scheme, host and port, so the destination is still the one the policy
      // evaluated and the agent's headers may go with it.
      screenDestination(target, options.allowPrivateLiterals, resolver);
      redirects.push({ status: response.status, url: current.href, location: target.href });
      current = target;
    }
  } catch (err) {
    throw toGuardedFetchError(err, { url: current.href, redirects: [...redirects] }, timedOut, options.timeoutMs);
  } finally {
    clearTimeout(timer);
    await agent.destroy().catch(() => undefined);
  }
}

// ── Destination screening ──────────────────────────────────────────────

/**
 * Refuses a URL the fetch server must not request and returns the
 * connect-time `lookup` for its host. Throws `INVALID_URL` for a non-HTTP(S)
 * scheme or embedded credentials and `DESTINATION_NOT_ALLOWED` for a
 * forbidden literal or name.
 */
function screenDestination(url: URL, allowPrivateLiterals: boolean, resolver: typeof dns.lookup): typeof dns.lookup {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new GuardedFetchError(
      'INVALID_URL',
      `Unsupported URL scheme ${JSON.stringify(url.protocol)}: only http and https URLs can be fetched`,
    );
  }
  if (url.username !== '' || url.password !== '') {
    throw new GuardedFetchError('INVALID_URL', 'URL must not include credentials');
  }

  const host = url.hostname;
  let screened: ScreenedHost;
  try {
    screened = screenIpLiteral(host, { allowPrivate: allowPrivateLiterals });
  } catch (err) {
    throw new GuardedFetchError('DESTINATION_NOT_ALLOWED', `Destination not allowed: ${errorMessage(err)}`, {
      cause: err,
    });
  }

  // The private tier the opt-in admits contains metadata endpoints too
  // (fd00:ec2::254, 100.100.100.200); those stay blocked.
  if (screened.kind === 'ip' && isMetadataAddress(screened.address)) {
    throw new GuardedFetchError('DESTINATION_NOT_ALLOWED', `Destination not allowed: ${host} is a metadata address`);
  }
  if (screened.kind === 'name') {
    if (isMetadataHostname(host)) {
      throw new GuardedFetchError('DESTINATION_NOT_ALLOWED', `Destination not allowed: ${host} is a metadata hostname`);
    }
    if (isLocalOrMetadataHostname(host)) {
      if (allowPrivateLiterals && isLoopbackName(host)) return loopbackLookup;
      throw new GuardedFetchError('DESTINATION_NOT_ALLOWED', `Destination not allowed: ${host} is a local hostname`);
    }
  }
  // Names resolve to public, non-metadata addresses only, whatever the opt-in
  // says. An IP literal never reaches the lookup (Node connects to it
  // directly); it was screened above.
  return createGuardedLookup(refuseMetadataAnswers(resolver), false);
}

/**
 * Wraps a resolver so a lookup fails when any answer is a metadata address.
 * The public-only check alone admits Azure's WireServer (168.63.129.16), which
 * is a public address.
 */
function refuseMetadataAnswers(resolver: typeof dns.lookup): typeof dns.lookup {
  const invoke = resolver as unknown as (
    hostname: string,
    options: dns.LookupOptions,
    callback: LookupCallback,
  ) => void;
  return ((hostname: string, options: dns.LookupOptions, callback: LookupCallback): void => {
    invoke(hostname, options, (error, result, family) => {
      if (error) {
        callback(error, result, family);
        return;
      }
      const answers = Array.isArray(result) ? result.map((entry) => entry.address) : [result];
      if (answers.some((address) => isMetadataAddress(address))) {
        callback(
          new AddressPolicyError('ADDRESS_NOT_ALLOWED', `DNS resolution for ${hostname} included a metadata address`),
          [],
        );
        return;
      }
      callback(null, result, family);
    });
  }) as typeof dns.lookup;
}

/** `localhost` and `*.localhost`, which RFC 6761 reserves for loopback. */
function isLoopbackName(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/\.$/u, '');
  return name === 'localhost' || name.endsWith('.localhost');
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;

const LOOPBACK_ADDRESSES: readonly dns.LookupAddress[] = [
  { address: '127.0.0.1', family: 4 },
  { address: '::1', family: 6 },
];

/**
 * Resolves an opted-in loopback name to the loopback addresses without
 * consulting the system resolver or DNS (RFC 6761 section 6.3).
 */
const loopbackLookup = ((_hostname: string, options: dns.LookupOptions | number, callback: LookupCallback): void => {
  const lookupOptions: dns.LookupOptions = typeof options === 'object' ? options : { family: options };
  const { family } = lookupOptions;
  const wanted = family === 4 || family === 'IPv4' ? 4 : family === 6 || family === 'IPv6' ? 6 : 0;
  const addresses = LOOPBACK_ADDRESSES.filter((entry) => wanted === 0 || entry.family === wanted).map((entry) => ({
    ...entry,
  }));
  process.nextTick(() => {
    if (lookupOptions.all === true) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
}) as typeof dns.lookup;

// ── Request and response helpers ───────────────────────────────────────

function parseRequestUrl(rawUrl: string): URL {
  try {
    return new URL(rawUrl);
  } catch {
    throw new GuardedFetchError('INVALID_URL', `Invalid URL: ${echo(rawUrl)}`);
  }
}

function resolveRedirect(location: string, base: URL): URL {
  try {
    return new URL(location, base);
  } catch {
    throw new GuardedFetchError('INVALID_REDIRECT', `Redirect has an invalid Location: ${echo(location)}`);
  }
}

function buildRequestHeaders(agentHeaders: Readonly<Record<string, string>> | undefined, userAgent: string): Headers {
  let headers: Headers;
  try {
    headers = new Headers(agentHeaders);
  } catch (err) {
    throw new GuardedFetchError('INVALID_HEADERS', `Invalid request headers: ${errorMessage(err)}`);
  }
  // `set` replaces every agent-supplied spelling of the header.
  headers.set('user-agent', userAgent);
  return headers;
}

async function readBodyCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    // undici types stream chunks as `any`; check before trusting them.
    const value: unknown = next.value;
    if (!(value instanceof Uint8Array)) {
      await reader.cancel().catch(() => undefined);
      throw new GuardedFetchError('FETCH_FAILED', 'Response body produced a non-byte chunk');
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new GuardedFetchError('RESPONSE_TOO_LARGE', `Response exceeds ${maxBytes} byte limit`);
    }
    chunks.push(value);
  }
  if (chunks.length === 1) return chunks[0];
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

// ── Errors ─────────────────────────────────────────────────────────────

function toGuardedFetchError(
  err: unknown,
  context: { readonly url: string; readonly redirects: readonly RedirectHop[] },
  timedOut: boolean,
  timeoutMs: number,
): GuardedFetchError {
  if (err instanceof GuardedFetchError) {
    return new GuardedFetchError(err.code, err.message, { ...context, location: err.location, cause: err.cause });
  }
  if (timedOut) {
    return new GuardedFetchError('TIMEOUT', `Request aborted: no complete response within ${timeoutMs} ms`, {
      ...context,
      cause: err,
    });
  }
  const chain = causeChain(err);
  // The connect-time guard's refusal surfaces as the `cause` of undici's
  // "fetch failed"; recognize it by its code discriminant.
  const refusal = chain.find((entry) => hasCode(entry, 'ADDRESS_NOT_ALLOWED'));
  if (refusal !== undefined) {
    return new GuardedFetchError('DESTINATION_NOT_ALLOWED', `Destination not allowed: ${errorMessage(refusal)}`, {
      ...context,
      cause: err,
    });
  }
  const detail = [...new Set(chain.map(errorMessage).filter((message) => message !== ''))];
  return new GuardedFetchError('FETCH_FAILED', detail.join(': ') || 'fetch failed', { ...context, cause: err });
}

/**
 * An error, its `cause`s and the members of any `AggregateError` (a connect
 * that tried several addresses), outermost first and bounded.
 */
function causeChain(err: unknown): unknown[] {
  const chain: unknown[] = [];
  const pending: unknown[] = [err];
  while (pending.length > 0 && chain.length < 8) {
    const current = pending.shift();
    if (current === undefined || current === null || chain.includes(current)) continue;
    chain.push(current);
    if (current instanceof AggregateError) pending.push(...(current.errors as unknown[]));
    if (current instanceof Error) pending.push(current.cause);
  }
  return chain;
}

function hasCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === code;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function echo(value: string): string {
  const shown = value.length > MAX_ECHOED_URL_CHARS ? `${value.slice(0, MAX_ECHOED_URL_CHARS)}...` : value;
  return JSON.stringify(shown);
}
