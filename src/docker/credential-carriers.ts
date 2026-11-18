/**
 * Where a provider credential can travel in an HTTP request.
 *
 * The single source of truth for the MITM proxy's credential gate
 * (`provider-credentials.ts`) and for the trajectory-capture redaction set
 * (`trajectory-types.ts`). `KeyInjection.headerName` in `provider-config.ts` is
 * typed {@link ProviderKeyHeaderName}, so every provider's key header is one of
 * {@link CREDENTIAL_HEADER_NAMES} by construction: a provider cannot name a key
 * header the gate would leave in place or the capture would record.
 *
 * This module is a leaf (no imports).
 */

/**
 * Request headers that carry an API key or bearer token for a provider:
 * `authorization` (bearer providers and gateways), `x-api-key` (Anthropic),
 * `x-goog-api-key` (Gemini), `api-key` (Azure-style gateways) and
 * `anthropic-api-key`. Lowercase.
 */
export const CREDENTIAL_HEADER_NAMES = [
  'authorization',
  'x-api-key',
  'x-goog-api-key',
  'api-key',
  'anthropic-api-key',
] as const;

export type CredentialHeaderName = (typeof CREDENTIAL_HEADER_NAMES)[number];

/** A header a `{ type: 'header' }` provider injects its key in; the bearer form uses `authorization`. */
export type ProviderKeyHeaderName = Exclude<CredentialHeaderName, 'authorization'>;

/**
 * Cookie headers. A cookie can carry a session credential (a provider issues
 * them, and an agent can bring its own), so provider routes never forward one
 * and the capture never records one. Lowercase.
 */
export const COOKIE_HEADER_NAMES = ['cookie', 'cookie2'] as const;

/**
 * Query parameters an upstream accepts a credential in: Google's `key` and its
 * OAuth `access_token`/`oauth_token`, and the `api_key` spellings some
 * gateways read. Compared lowercase, after percent-decoding.
 */
export const CREDENTIAL_QUERY_PARAMETERS = [
  'key',
  'api_key',
  'api-key',
  'apikey',
  'access_token',
  'oauth_token',
] as const;
