/**
 * OAuth 2.0 authorization code flow with PKCE.
 *
 * Runs the complete browser-based flow: generates PKCE challenge,
 * starts an ephemeral callback server, opens the browser, waits for
 * the authorization code, and exchanges it for tokens.
 *
 * On a headless or remote host (`ironcurtain auth <provider> --no-browser`)
 * the browser runs on another machine, where the redirect to
 * `http://127.0.0.1:<port>/callback` cannot reach this process. The flow then
 * also accepts the redirected URL pasted from that browser's address bar
 * ({@link OAuthFlowOptions.pasteRedirectUrl}); whichever arrives first wins.
 *
 * A callback or pasted URL counts only when it carries this flow's `state`.
 * Anything else (a stale browser tab, another local process probing the
 * port) is refused and the flow keeps waiting, so it cannot cut the
 * authorization short, and an `error=` response is honoured only after its
 * state matched.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { URL } from 'node:url';
import type { OAuthProviderConfig, OAuthClientCredentials, StoredOAuthToken } from './oauth-provider.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OAuthFlowResult {
  readonly token: StoredOAuthToken;
  /** The scopes actually granted by the provider (may differ from requested). */
  readonly grantedScopes: readonly string[];
}

export class OAuthFlowError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OAuthFlowError';
  }
}

/** What {@link OAuthFlowOptions.pasteRedirectUrl} is asked for. */
export interface PasteRedirectRequest {
  /** The authorization URL to open in a browser (on any machine). */
  readonly authUrl: string;
  /** Why the previous paste was refused, when this is a retry. */
  readonly problem?: string;
  /** Aborted when the loopback callback completed the flow first, or the flow ended. */
  readonly signal: AbortSignal;
}

export interface OAuthFlowOptions {
  /** Override how the authorization URL is opened (default: system browser). */
  readonly openUrl?: (url: string) => void;
  /**
   * Headless mode: the browser is not opened. Instead this is asked (again
   * after each refused paste) for the URL the browser was redirected to,
   * which the user copies from its address bar after approving access. It
   * should show `authUrl` and resolve with the pasted text, or undefined when
   * the user cancels. The loopback callback keeps listening meanwhile, in
   * case the browser does run on this machine.
   */
  readonly pasteRedirectUrl?: (request: PasteRedirectRequest) => Promise<string | undefined>;
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

const CODE_VERIFIER_LENGTH = 64;

/** Generates a cryptographically random code verifier (43-128 chars, base64url). */
export function generateCodeVerifier(): string {
  return randomBytes(CODE_VERIFIER_LENGTH).toString('base64url');
}

/** Computes the S256 code challenge from a code verifier. */
export function computeCodeChallenge(verifier: string): string {
  const hash = createHash('sha256').update(verifier).digest();
  return hash.toString('base64url');
}

// ---------------------------------------------------------------------------
// State parameter (CSRF nonce)
// ---------------------------------------------------------------------------

function generateState(): string {
  return randomBytes(32).toString('base64url');
}

// ---------------------------------------------------------------------------
// Browser open
// ---------------------------------------------------------------------------

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
  execFile(cmd, [url], (err) => {
    // Best-effort: if browser fails to open, user can copy the URL from terminal
    if (err) {
      console.error(`Could not open browser automatically. Please visit:\n${url}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Callback server
// ---------------------------------------------------------------------------

type CallbackOutcome = { readonly ok: true; readonly code: string } | { readonly ok: false; readonly error: string };

/**
 * How a redirect back from the provider is handled: `ignored` when it is not
 * a response to this flow's request (its `state` is missing or wrong), so the
 * flow keeps waiting; otherwise the outcome that ends the flow.
 */
type RedirectVerdict =
  | { readonly kind: 'ignored'; readonly reason: string }
  | { readonly kind: 'outcome'; readonly outcome: CallbackOutcome };

/** Constant-time comparison of a received `state` with the expected one. */
function stateMatches(received: string | null, expected: string): boolean {
  if (received === null) return false;
  const a = Buffer.from(received, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Interprets the query of a redirect to the callback. The state is checked
 * first: before it matches, not even an `error=` response may end the flow,
 * or any local process could abort an authorization in progress.
 */
function judgeRedirect(params: URLSearchParams, expectedState: string): RedirectVerdict {
  if (!stateMatches(params.get('state'), expectedState)) {
    return {
      kind: 'ignored',
      reason: 'it does not carry the state of this authorization request (it may come from an earlier attempt)',
    };
  }
  const error = params.get('error');
  if (error) {
    const description = params.get('error_description') ?? error;
    return { kind: 'outcome', outcome: { ok: false, error: `Authorization failed: ${description}` } };
  }
  const code = params.get('code');
  if (!code) return { kind: 'outcome', outcome: { ok: false, error: 'No authorization code in callback' } };
  return { kind: 'outcome', outcome: { ok: true, code } };
}

/**
 * Interprets a redirect URL pasted by the user (headless mode). It must name
 * this flow's redirect URI exactly, apart from its query, and pass
 * {@link judgeRedirect}.
 */
function judgePastedRedirect(pasted: string, redirectUri: string, expectedState: string): RedirectVerdict {
  let url: URL;
  try {
    url = new URL(pasted.trim());
  } catch {
    return { kind: 'ignored', reason: 'it is not a URL' };
  }
  const expected = new URL(redirectUri);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname) {
    return { kind: 'ignored', reason: `it does not start with ${redirectUri}` };
  }
  return judgeRedirect(url.searchParams, expectedState);
}

function startCallbackServer(
  callbackPath: string,
  expectedState: string,
): { server: Server; result: Promise<CallbackOutcome>; getPort: () => number } {
  let resolveResult!: (value: CallbackOutcome) => void;
  const result = new Promise<CallbackOutcome>((resolve) => {
    resolveResult = resolve;
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const requestUrl = new URL(req.url ?? '/', `http://127.0.0.1`);

    if (requestUrl.pathname !== callbackPath) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    const verdict = judgeRedirect(requestUrl.searchParams, expectedState);
    if (verdict.kind === 'ignored') {
      // Not this flow's response: refuse it and keep waiting for the real one.
      respondWithHtml(
        res,
        'Invalid State',
        'This response does not belong to the authorization IronCurtain is waiting for. ' +
          'Complete the sign-in from the link IronCurtain printed or opened.',
        400,
      );
      return;
    }
    const { outcome } = verdict;
    if (outcome.ok) {
      respondWithHtml(res, 'Authorization Successful', 'Authorization successful! You can close this tab.');
    } else {
      respondWithHtml(res, 'Authorization Failed', outcome.error);
    }
    resolveResult(outcome);
  });

  server.listen(0, '127.0.0.1');

  const getPort = (): number => {
    const address = server.address();
    if (typeof address === 'object' && address !== null) {
      return address.port;
    }
    throw new OAuthFlowError('Failed to get callback server port');
  };

  return { server, result, getPort };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function respondWithHtml(res: ServerResponse, title: string, message: string, status = 200): void {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  const html = `<!DOCTYPE html>
<html><head><title>${safeTitle}</title></head>
<body><h1>${safeTitle}</h1><p>${safeMessage}</p></body></html>`;
  res.writeHead(status, { 'Content-Type': 'text/html', Connection: 'close' });
  res.end(html);
}

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

async function exchangeCodeForTokens(
  provider: OAuthProviderConfig,
  clientCredentials: OAuthClientCredentials,
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<{ token: StoredOAuthToken; grantedScopes: readonly string[] }> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientCredentials.clientId,
    client_secret: clientCredentials.clientSecret,
    code_verifier: codeVerifier,
  });

  const EXCHANGE_TIMEOUT_MS = 30_000;
  let response: Response;
  try {
    response = await fetchWithTimeout(
      provider.tokenUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      },
      EXCHANGE_TIMEOUT_MS,
    );
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new OAuthFlowError('Token exchange timed out', { cause: err });
    }
    throw err;
  }

  if (!response.ok) {
    const text = await response.text();
    throw new OAuthFlowError(`Token exchange failed (${response.status}): ${text}`);
  }

  let data: TokenResponse;
  try {
    data = (await safeResponseJson(response)) as TokenResponse;
  } catch (err) {
    throw new OAuthFlowError('Token exchange returned non-JSON response', { cause: err });
  }

  if (!data.access_token) {
    throw new OAuthFlowError('Token response missing access_token');
  }

  if (!data.refresh_token) {
    throw new OAuthFlowError(
      'Token response missing refresh_token. ' +
        'This usually means the provider did not issue a refresh token. ' +
        'For Google, ensure prompt=consent and access_type=offline are set.',
    );
  }

  if (!data.expires_in || data.expires_in <= 0) {
    throw new OAuthFlowError('Token response missing or invalid expires_in');
  }

  const expiresAt = Date.now() + data.expires_in * 1000;
  const grantedScopes = data.scope ? data.scope.split(' ') : [];

  const token: StoredOAuthToken = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt,
    scopes: grantedScopes,
  };

  return { token, grantedScopes };
}

// ---------------------------------------------------------------------------
// Authorization URL
// ---------------------------------------------------------------------------

function buildAuthorizationUrl(
  provider: OAuthProviderConfig,
  clientId: string,
  redirectUri: string,
  state: string,
  codeChallenge: string,
  scopes: readonly string[],
): string {
  const url = new URL(provider.authorizationUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('scope', scopes.join(' '));

  if (provider.usePkce) {
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }

  // Apply provider-specific extra params (e.g. access_type=offline for Google)
  if (provider.extraAuthParams) {
    for (const [key, value] of Object.entries(provider.extraAuthParams)) {
      url.searchParams.set(key, value);
    }
  }

  return url.toString();
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Default wait in headless mode, where the user signs in on another machine
 * and copies the URL back by hand. The provider's authorization code expires
 * after a few minutes anyway.
 */
export const DEFAULT_PASTE_TIMEOUT_MS = 600_000;

/**
 * Runs the OAuth 2.0 authorization code flow with PKCE.
 *
 * 1. Generates PKCE code verifier and challenge
 * 2. Starts an ephemeral HTTP server on 127.0.0.1:0 (OS-assigned port)
 * 3. Opens the authorization URL in the user's default browser, or in
 *    headless mode (`options.pasteRedirectUrl`) hands it to the user
 * 4. Waits for the redirect with the authorization code: the callback, or in
 *    headless mode whichever of the callback and a pasted URL comes first.
 *    A redirect without this flow's `state` is refused and waited past.
 * 5. Exchanges the code for tokens using client_id + client_secret
 * 6. Stops the callback server
 */
export async function runOAuthFlow(
  provider: OAuthProviderConfig,
  clientCredentials: OAuthClientCredentials,
  scopes?: readonly string[],
  timeoutMs?: number,
  options?: OAuthFlowOptions,
): Promise<OAuthFlowResult> {
  const effectiveScopes = scopes ?? provider.defaultScopes;
  const pasteRedirectUrl = options?.pasteRedirectUrl;
  const timeout = timeoutMs ?? (pasteRedirectUrl ? DEFAULT_PASTE_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);

  // Step 1: PKCE
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = computeCodeChallenge(codeVerifier);

  // Step 2: State nonce
  const state = generateState();

  // Step 3: Start callback server
  const { server, result, getPort } = startCallbackServer(provider.callbackPath, state);
  // Ends a pending paste prompt once the flow no longer needs it.
  const pasteAbort = new AbortController();

  try {
    // Wait for the server to be listening before reading the port
    await new Promise<void>((resolve) => {
      if (server.listening) {
        resolve();
      } else {
        server.once('listening', resolve);
      }
    });

    const port = getPort();
    const redirectUri = `http://127.0.0.1:${port}${provider.callbackPath}`;

    // Step 4: Build authorization URL and open browser (or hand it to the user)
    const authUrl = buildAuthorizationUrl(
      provider,
      clientCredentials.clientId,
      redirectUri,
      state,
      codeChallenge,
      effectiveScopes,
    );
    let redirect: Promise<CallbackOutcome> = result;
    if (pasteRedirectUrl) {
      const pasted = readPastedRedirect(pasteRedirectUrl, authUrl, redirectUri, state, pasteAbort.signal);
      // The losing side is abandoned; keep a late rejection from going unhandled.
      pasted.catch(() => {});
      redirect = Promise.race([result, pasted]);
    } else {
      const opener = options?.openUrl ?? openBrowser;
      opener(authUrl);
    }

    // Step 5: Wait for the redirect (with timeout)
    const outcome = await withTimeout(redirect, timeout);

    if (!outcome.ok) {
      throw new OAuthFlowError(outcome.error);
    }

    // Step 6: Exchange code for tokens
    return await exchangeCodeForTokens(provider, clientCredentials, outcome.code, redirectUri, codeVerifier);
  } finally {
    pasteAbort.abort();
    // Step 7: Stop server and force-close any lingering connections
    server.close();
    server.closeAllConnections();
  }
}

/**
 * Asks for the pasted redirect URL until one carries this flow's state (or
 * the user cancels, or the flow ends), and returns its outcome.
 */
async function readPastedRedirect(
  pasteRedirectUrl: (request: PasteRedirectRequest) => Promise<string | undefined>,
  authUrl: string,
  redirectUri: string,
  expectedState: string,
  signal: AbortSignal,
): Promise<CallbackOutcome> {
  let problem: string | undefined;
  for (;;) {
    const pasted = await pasteRedirectUrl({ authUrl, signal, ...(problem !== undefined ? { problem } : {}) });
    if (signal.aborted) {
      // The callback won the race (or the flow ended); this result is unused.
      return { ok: false, error: 'Authorization ended' };
    }
    if (pasted === undefined) return { ok: false, error: 'Authorization cancelled' };
    const verdict = judgePastedRedirect(pasted, redirectUri, expectedState);
    if (verdict.kind === 'outcome') return verdict.outcome;
    problem = `That URL was not accepted: ${verdict.reason}.`;
  }
}

// ---------------------------------------------------------------------------
// Timeout helpers
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new OAuthFlowError(`OAuth flow timed out after ${ms}ms`));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * Wraps fetch() with an AbortSignal-based timeout.
 * Callers are responsible for catching the AbortError and rethrowing as
 * the appropriate domain error (OAuthFlowError, OAuthTokenExpiredError, etc.).
 */
export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return response;
}

/**
 * Safely parses a Response body as JSON.
 * Returns the parsed value, or throws with a descriptive message on failure.
 */
export async function safeResponseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new SyntaxError(`Expected JSON response but got: ${text.slice(0, 200)}`, { cause: err });
  }
}
