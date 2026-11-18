/**
 * Credential gate for the MITM proxy's provider routes.
 *
 * A provider route forwards a request with the user's real credential, so the
 * credential a request carries decides whose account receives the data. Before
 * anything is forwarded, {@link applyProviderCredential}:
 *
 * - removes every credential carrier: the headers in `CREDENTIAL_HEADER_NAMES`
 *   (and the provider's own key header), cookies, and the query parameters in
 *   `CREDENTIAL_QUERY_PARAMETERS` (see `./credential-carriers.ts`);
 * - accepts the session sentinel in any of them (the configured header, a
 *   `Bearer` authorization, a credential query parameter) and injects the real
 *   key in the provider's configured location only, or nothing at all for a
 *   keyless gateway whose real key is empty;
 * - answers any other credential value with a local 401. A request can never
 *   reach the provider authenticated as an account the agent chose, such as an
 *   attacker's key whose owner could read stored requests back;
 * - forwards a request that presents no credential, with none, only to an
 *   endpoint the provider lists in `unauthenticatedEndpoints` (connectivity
 *   checks, public catalogs, key sets); anywhere else it is a local 401.
 *
 * Cookies are removed but never evaluated. No supported agent authenticates with
 * one, the proxy never relays a provider's `Set-Cookie` back (see
 * `sanitizeResponseHeaders`), and a removed cookie cannot reach the provider.
 *
 * Comparing the sentinel in constant time adds little (the agent already holds
 * it); it is done anyway because it costs nothing.
 */

import { timingSafeEqual } from 'node:crypto';
import { COOKIE_HEADER_NAMES, CREDENTIAL_HEADER_NAMES, CREDENTIAL_QUERY_PARAMETERS } from './credential-carriers.js';
import { isUnauthenticatedEndpoint, type KeyInjection, type ProviderConfig } from './provider-config.js';

/** Header object the proxy forwards; edited in place. */
export type ForwardHeaders = Record<string, string | string[] | undefined>;

export interface ProviderCredentialInput {
  readonly config: Pick<ProviderConfig, 'keyInjection' | 'unauthenticatedEndpoints'>;
  /** The session sentinel given to the container. */
  readonly fakeKey: string;
  /** The real credential; empty for a keyless gateway profile. */
  readonly realKey: string;
}

/** What the proxy does with a provider-route request, decided by {@link applyProviderCredential}. */
export type ProviderCredentialDecision =
  /** The sentinel was presented: every carrier is gone and the real key sits in the configured location. */
  | { readonly kind: 'sentinel'; readonly path: string }
  /** No credential was presented, on an unauthenticated endpoint: forwarded without one. */
  | { readonly kind: 'anonymous'; readonly path: string }
  /** Answered locally with `status`; nothing is forwarded. `message` names carriers only, never values. */
  | { readonly kind: 'rejected'; readonly status: 400 | 401; readonly message: string };

const HEADER_CARRIERS: ReadonlySet<string> = new Set(CREDENTIAL_HEADER_NAMES);
const COOKIE_CARRIERS: ReadonlySet<string> = new Set(COOKIE_HEADER_NAMES);
const QUERY_CARRIERS: ReadonlySet<string> = new Set(CREDENTIAL_QUERY_PARAMETERS);

/** `Bearer <token>`: the scheme in any case, then exactly one token. */
const BEARER_CREDENTIAL = /^bearer[ \t]+([^\s,]+)$/iu;

const REDACTED = '<redacted>';

/** Credentials seen on one request. */
interface PresentedCredentials {
  sentinel: boolean;
  /** Carriers (`x-api-key`, `query:key`, ...) that held something other than the sentinel. */
  readonly foreign: Set<string>;
}

/**
 * Strip every credential carrier from `headers` (in place) and from `path`, and
 * decide how the request may proceed. On `sentinel`, the real key has already
 * been injected; forward `decision.path`, never the original path.
 */
export function applyProviderCredential(
  headers: ForwardHeaders,
  method: string | undefined,
  path: string,
  provider: ProviderCredentialInput,
): ProviderCredentialDecision {
  const presented: PresentedCredentials = { sentinel: false, foreign: new Set() };
  const consider = (carrier: string, value: string): void => {
    if (value === '') return;
    if (isSentinel(value, provider.fakeKey)) presented.sentinel = true;
    else presented.foreign.add(carrier);
  };

  const keyHeader = configuredKeyHeader(provider.config.keyInjection);
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase();
    if (COOKIE_CARRIERS.has(lower)) {
      Reflect.deleteProperty(headers, name);
      continue;
    }
    if (!HEADER_CARRIERS.has(lower) && lower !== keyHeader) continue;
    const value = headers[name];
    Reflect.deleteProperty(headers, name);
    for (const entry of value === undefined ? [] : typeof value === 'string' ? [value] : value) {
      consider(lower, presentedToken(lower, entry));
    }
  }

  const forwardPath = stripCredentialQuery(path, consider);
  if (forwardPath === undefined) {
    return { kind: 'rejected', status: 400, message: 'a query parameter name is not valid percent-encoding' };
  }
  if (presented.foreign.size > 0) {
    return {
      kind: 'rejected',
      status: 401,
      message:
        `the request carries a credential that is not this session's (${[...presented.foreign].join(', ')}); ` +
        'provider routes accept only the session credential',
    };
  }
  if (presented.sentinel) {
    injectRealKey(headers, provider.config.keyInjection, provider.realKey);
    return { kind: 'sentinel', path: forwardPath };
  }
  if (isUnauthenticatedEndpoint(provider.config, method, path)) return { kind: 'anonymous', path: forwardPath };
  return {
    kind: 'rejected',
    status: 401,
    message: 'the request carries no session credential, and this endpoint requires one',
  };
}

/**
 * Put the real key in the provider's configured location, replacing whatever is
 * there. An empty real key (a keyless gateway profile) removes the carrier
 * instead of forwarding an empty credential. Used by
 * {@link applyProviderCredential} and again after an OAuth token refresh.
 */
export function injectRealKey(headers: ForwardHeaders, keyInjection: KeyInjection, realKey: string): void {
  const name = configuredKeyHeader(keyInjection);
  for (const existing of Object.keys(headers)) {
    if (existing.toLowerCase() === name) Reflect.deleteProperty(headers, existing);
  }
  if (realKey === '') return;
  headers[name] = keyInjection.type === 'header' ? realKey : `Bearer ${realKey}`;
}

/**
 * `path` with the value of every credential query parameter replaced by
 * `<redacted>`, for logs and capture records. Parameters behind a `;` are
 * covered too.
 */
export function redactCredentialQuery(path: string): string {
  const start = path.indexOf('?');
  if (start === -1) return path;
  let changed = false;
  const parts: string[] = [];
  // Splitting on a capturing group keeps the separators in place.
  for (const part of path.slice(start + 1).split(/([&;])/u)) {
    const equals = part.indexOf('=');
    if (equals === -1 || !QUERY_CARRIERS.has(queryName(part.slice(0, equals)) ?? '')) {
      parts.push(part);
      continue;
    }
    changed = true;
    parts.push(`${part.slice(0, equals)}=${REDACTED}`);
  }
  return changed ? `${path.slice(0, start)}?${parts.join('')}` : path;
}

/**
 * JSON error body for a request {@link applyProviderCredential} rejected. The
 * shape satisfies both the Anthropic SDK (`type: "error"`, `error.type`,
 * `error.message`) and the OpenAI SDK (`error.message`, `error.type`).
 */
export function credentialRejectionBody(decision: { readonly status: 400 | 401; readonly message: string }): string {
  return JSON.stringify({
    type: 'error',
    error: {
      type: decision.status === 401 ? 'authentication_error' : 'invalid_request_error',
      message: `IronCurtain proxy refused this request: ${decision.message}`,
    },
  });
}

function configuredKeyHeader(keyInjection: KeyInjection): string {
  return keyInjection.type === 'header' ? keyInjection.headerName.toLowerCase() : 'authorization';
}

/** The credential a header value presents: the token of a `Bearer` authorization, else the trimmed value. */
function presentedToken(headerName: string, value: string): string {
  const trimmed = value.trim();
  if (headerName !== 'authorization') return trimmed;
  const bearer = BEARER_CREDENTIAL.exec(trimmed);
  if (bearer) return bearer[1];
  return /^bearer$/iu.test(trimmed) ? '' : trimmed;
}

function isSentinel(value: string, fakeKey: string): boolean {
  if (fakeKey === '') return false;
  const presentedBytes = Buffer.from(value, 'utf8');
  const sentinelBytes = Buffer.from(fakeKey, 'utf8');
  return presentedBytes.length === sentinelBytes.length && timingSafeEqual(presentedBytes, sentinelBytes);
}

/** A query parameter name as an upstream reads it (form-decoded, trimmed, lowercase), or undefined when undecodable. */
function queryName(raw: string): string | undefined {
  const decoded = decodeQueryComponent(raw);
  return decoded === undefined ? undefined : decoded.trim().toLowerCase();
}

function decodeQueryComponent(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw.replace(/\+/gu, ' '));
  } catch {
    return undefined;
  }
}

/** Stands in for a credential value the proxy cannot read; NUL never appears in a sentinel. */
const UNREADABLE_CREDENTIAL = '\u0000';

/**
 * `path` without its credential query parameters, each reported to `consider`;
 * other parameters stay byte-for-byte. A credential parameter hidden behind a
 * `;` (a separator to some servers) cannot be removed cleanly, so it is
 * reported as a value that is not the sentinel. Returns undefined when a
 * parameter name cannot be decoded, since the proxy then cannot tell whether it
 * carries a credential.
 */
function stripCredentialQuery(path: string, consider: (carrier: string, value: string) => void): string | undefined {
  const start = path.indexOf('?');
  if (start === -1) return path;
  const kept: string[] = [];
  let removed = false;
  for (const pair of path.slice(start + 1).split('&')) {
    const equals = pair.indexOf('=');
    const name = queryName(equals === -1 ? pair : pair.slice(0, equals));
    if (name === undefined) return undefined;
    if (QUERY_CARRIERS.has(name)) {
      consider(
        `query:${name}`,
        decodeQueryComponent(equals === -1 ? '' : pair.slice(equals + 1)) ?? UNREADABLE_CREDENTIAL,
      );
      removed = true;
      continue;
    }
    const hidden = pair
      .split(';')
      .slice(1)
      .map((part) => queryName(part.split('=', 1)[0] ?? ''))
      .find((part) => part !== undefined && QUERY_CARRIERS.has(part));
    if (hidden !== undefined) consider(`query:;${hidden}`, UNREADABLE_CREDENTIAL);
    kept.push(pair);
  }
  if (!removed) return path;
  const base = path.slice(0, start);
  return kept.length > 0 ? `${base}?${kept.join('&')}` : base;
}
