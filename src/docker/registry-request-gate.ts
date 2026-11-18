/**
 * Method, body and header rules for the standard registry proxy.
 *
 * The standard registry proxy (`registry-proxy.ts`) serves the public npm,
 * PyPI, Debian and crates.io registries read-only. The audit found that it
 * forwarded every request it did not recognise with the client's method, all
 * of its headers (`Authorization` and `Cookie` included) and its body. A
 * compromised agent could publish a crate, move an npm dist-tag or rewrite a
 * packument with its own or the user's token, and nothing reached
 * `package-audit.jsonl`.
 *
 * Two rules here apply to every registry request, on both the HTTPS (CONNECT)
 * and the plain-HTTP apt entry points:
 *
 * - {@link checkRegistryRequestMethodAndBody} runs before anything else. The
 *   method must be GET or HEAD, and the request must not declare a body. An
 *   npm publish, a dist-tag write, a crate publish or yank, a login form and
 *   npm's audit POSTs all get a 403 before any route is considered.
 * - {@link buildReadOnlyUpstreamHeaders} is the only way a client header
 *   reaches upstream. It copies the headers named in
 *   {@link READ_ONLY_REQUEST_HEADERS}: content negotiation, caching and range
 *   headers. No credential header is on that list: not `authorization` or
 *   `cookie`, not any header the strict package listener treats as a
 *   credential (`package-egress-proxy.ts`), and no `npm-*` header. Any other
 *   header is dropped too, so a credential header nobody has listed yet fails
 *   closed.
 */

import type * as http from 'node:http';

/** The only methods the registry proxy forwards. */
export type ReadOnlyRegistryMethod = 'GET' | 'HEAD';

export type RegistryRequestGateResult =
  | { readonly ok: true; readonly method: ReadOnlyRegistryMethod }
  | {
      readonly ok: false;
      /** Fixed text, safe to put in a response body or log: never echoes the request. */
      readonly reason: string;
    };

/**
 * Admits only a GET or HEAD request that declares no body. A body is declared
 * by any `Transfer-Encoding` header, or by a `Content-Length` other than `0`.
 *
 * A refused request's body is never read into memory or forwarded. Node's HTTP
 * server discards it after the 403 is sent, so the client sees a clean 403
 * instead of a connection reset (npm retries a reset).
 */
export function checkRegistryRequestMethodAndBody(
  method: string | undefined,
  headers: http.IncomingHttpHeaders,
): RegistryRequestGateResult {
  if (method !== 'GET' && method !== 'HEAD') {
    return { ok: false, reason: 'the registry proxy is read-only: only GET and HEAD are allowed' };
  }
  if (declaresRequestBody(headers)) {
    return { ok: false, reason: 'the registry proxy is read-only: request bodies are refused' };
  }
  return { ok: true, method };
}

function declaresRequestBody(headers: http.IncomingHttpHeaders): boolean {
  if (headers['transfer-encoding'] !== undefined) return true;
  const length = headers['content-length'];
  return length !== undefined && length !== '0';
}

/**
 * Client request headers the proxy forwards upstream, lowercase. A read needs
 * nothing else. crates.io refuses API requests without a `user-agent`, and apt
 * resumes and revalidates downloads with `range`, `if-range` and
 * `if-modified-since`.
 */
export const READ_ONLY_REQUEST_HEADERS: readonly string[] = [
  'accept',
  'accept-encoding',
  'accept-language',
  'cache-control',
  'if-match',
  'if-modified-since',
  'if-none-match',
  'if-range',
  'if-unmodified-since',
  'pragma',
  'range',
  'user-agent',
];

/**
 * The headers of an upstream request made on the client's behalf: `host`,
 * plus each header in {@link READ_ONLY_REQUEST_HEADERS} that the client sent.
 * Every other client header is dropped, credentials included.
 */
export function buildReadOnlyUpstreamHeaders(
  clientHeaders: http.IncomingHttpHeaders,
  host: string,
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = { host };
  for (const name of READ_ONLY_REQUEST_HEADERS) {
    const value = clientHeaders[name];
    if (typeof value === 'string') headers[name] = value;
  }
  return headers;
}
