import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { URL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  generateCodeVerifier,
  computeCodeChallenge,
  runOAuthFlow,
  OAuthFlowError,
  type PasteRedirectRequest,
} from '../../src/auth/oauth-flow.js';
import type { OAuthProviderConfig, OAuthClientCredentials } from '../../src/auth/oauth-provider.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeProvider(tokenPort: number): OAuthProviderConfig {
  return {
    id: 'google',
    displayName: 'Test Provider',
    authorizationUrl: 'https://example.com/auth',
    tokenUrl: `http://127.0.0.1:${tokenPort}/token`,
    defaultScopes: ['scope1', 'scope2'],
    callbackPath: '/callback',
    usePkce: true,
    serverNames: ['test-server'],
    tokenEnvVar: 'TEST_TOKEN',
    refreshTokenEnvVar: 'TEST_REFRESH',
    clientIdEnvVar: 'TEST_CLIENT_ID',
    clientSecretEnvVar: 'TEST_CLIENT_SECRET',
    credentialsFilename: 'test-credentials.json',
  };
}

const testCredentials: OAuthClientCredentials = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
};

/**
 * Captures the authorization URL that would be opened in the browser.
 * Returns both the openUrl callback and a promise that resolves to the captured URL.
 */
function captureAuthUrl(): { openUrl: (url: string) => void; urlPromise: Promise<string> } {
  let resolve: (url: string) => void;
  const urlPromise = new Promise<string>((r) => {
    resolve = r;
  });
  return {
    openUrl: (url: string) => resolve(url),
    urlPromise,
  };
}

/**
 * Starts a mock OAuth token endpoint that validates the exchange request
 * and returns fake tokens.
 */
function startMockTokenServer(responseOverride?: { status: number; body: string }): {
  server: ReturnType<typeof createServer>;
  port: () => number;
  close: () => void;
  lastRequest: () => Record<string, string> | undefined;
} {
  let lastBody: Record<string, string> | undefined;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      if (req.url === '/token' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk as Buffer);
        }
        const body = Buffer.concat(chunks).toString();
        lastBody = Object.fromEntries(new URLSearchParams(body));

        if (responseOverride) {
          res.writeHead(responseOverride.status, { 'Content-Type': 'application/json' });
          res.end(responseOverride.body);
          return;
        }

        if (lastBody.grant_type !== 'authorization_code' || !lastBody.code || !lastBody.code_verifier) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_request' }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: 'mock-access-token',
            refresh_token: 'mock-refresh-token',
            expires_in: 3600,
            scope: 'scope1 scope2',
            token_type: 'Bearer',
          }),
        );
      } else {
        res.writeHead(404);
        res.end();
      }
    })();
  });

  server.listen(0, '127.0.0.1');

  return {
    server,
    port: () => {
      const addr = server.address();
      return typeof addr === 'object' && addr !== null ? addr.port : 0;
    },
    close: () => server.close(),
    lastRequest: () => lastBody,
  };
}

async function waitForServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (server.listening) return;
  return new Promise((resolve) => server.once('listening', resolve));
}

/**
 * Simulates the browser callback by extracting the redirect_uri and state
 * from the authorization URL, then making a fetch to the callback server.
 */
async function simulateCallback(authUrl: string, params: Record<string, string>): Promise<Response> {
  const parsed = new URL(authUrl);
  const redirectUri = parsed.searchParams.get('redirect_uri')!;
  const callbackUrl = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    callbackUrl.searchParams.set(key, value);
  }
  return fetch(callbackUrl.toString());
}

// ---------------------------------------------------------------------------
// PKCE tests
// ---------------------------------------------------------------------------

describe('generateCodeVerifier', () => {
  it('produces a base64url string of at least 43 characters', () => {
    const verifier = generateCodeVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('produces unique values on each call', () => {
    const a = generateCodeVerifier();
    const b = generateCodeVerifier();
    expect(a).not.toBe(b);
  });
});

describe('computeCodeChallenge', () => {
  it('produces the correct S256 hash for a known test vector', () => {
    // RFC 7636 Appendix B test vector
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = computeCodeChallenge(verifier);

    const expected = createHash('sha256').update(verifier).digest('base64url');
    expect(challenge).toBe(expected);
  });

  it('produces base64url output without padding', () => {
    const challenge = computeCodeChallenge('test-verifier');
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).not.toContain('=');
  });
});

// ---------------------------------------------------------------------------
// Full flow integration tests
// ---------------------------------------------------------------------------

describe('runOAuthFlow', () => {
  let mockTokenServer: ReturnType<typeof startMockTokenServer>;

  beforeEach(async () => {
    mockTokenServer = startMockTokenServer();
    await waitForServer(mockTokenServer.server);
  });

  afterEach(() => {
    mockTokenServer.close();
  });

  it('completes the full flow and returns tokens', async () => {
    const provider = makeProvider(mockTokenServer.port());
    const { openUrl, urlPromise } = captureAuthUrl();

    const flowPromise = runOAuthFlow(provider, testCredentials, undefined, 10_000, { openUrl });

    const authUrl = await urlPromise;
    const parsed = new URL(authUrl);

    // Verify authorization URL parameters
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('client_id')).toBe('test-client-id');
    expect(parsed.searchParams.get('code_challenge')).toBeTruthy();
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('scope')).toBe('scope1 scope2');

    const state = parsed.searchParams.get('state')!;
    expect(state).toBeTruthy();

    // Simulate the browser callback
    const callbackResponse = await simulateCallback(authUrl, { code: 'test-auth-code', state });
    expect(callbackResponse.ok).toBe(true);

    const result = await flowPromise;

    expect(result.token.accessToken).toBe('mock-access-token');
    expect(result.token.refreshToken).toBe('mock-refresh-token');
    expect(result.token.expiresAt).toBeGreaterThan(Date.now());
    expect(result.grantedScopes).toEqual(['scope1', 'scope2']);

    // Verify the token exchange request
    const lastReq = mockTokenServer.lastRequest();
    expect(lastReq).toBeDefined();
    expect(lastReq!.code).toBe('test-auth-code');
    expect(lastReq!.code_verifier).toBeTruthy();
    expect(lastReq!.client_id).toBe('test-client-id');
    expect(lastReq!.client_secret).toBe('test-client-secret');
    expect(lastReq!.grant_type).toBe('authorization_code');
  });

  it('throws OAuthFlowError on timeout', async () => {
    const provider = makeProvider(mockTokenServer.port());

    // Never simulate the callback -- should time out
    await expect(runOAuthFlow(provider, testCredentials, undefined, 100, { openUrl: () => {} })).rejects.toThrow(
      OAuthFlowError,
    );

    await expect(runOAuthFlow(provider, testCredentials, undefined, 100, { openUrl: () => {} })).rejects.toThrow(
      /timed out/,
    );
  });

  it('throws OAuthFlowError when provider returns error in callback', async () => {
    const provider = makeProvider(mockTokenServer.port());
    const { openUrl, urlPromise } = captureAuthUrl();

    const flowPromise = runOAuthFlow(provider, testCredentials, undefined, 10_000, { openUrl });
    // Attach catch immediately to prevent unhandled rejection
    flowPromise.catch(() => {});

    const authUrl = await urlPromise;
    const state = new URL(authUrl).searchParams.get('state')!;

    // Simulate error callback (user denied access); the provider echoes the state.
    await simulateCallback(authUrl, {
      error: 'access_denied',
      error_description: 'User denied access',
      state,
    });

    await expect(flowPromise).rejects.toThrow(OAuthFlowError);
    await expect(flowPromise).rejects.toThrow(/User denied access/);
  });

  // Regression: a callback with a missing or wrong state used to end the flow,
  // and an `error=` callback was honoured before the state was checked, so any
  // local process could abort an authorization in progress.
  it('refuses a callback with a wrong or missing state and keeps waiting for the real one', async () => {
    const provider = makeProvider(mockTokenServer.port());
    const { openUrl, urlPromise } = captureAuthUrl();

    const flowPromise = runOAuthFlow(provider, testCredentials, undefined, 10_000, { openUrl });
    flowPromise.catch(() => {});

    const authUrl = await urlPromise;
    const state = new URL(authUrl).searchParams.get('state')!;

    const wrongState = await simulateCallback(authUrl, { code: 'test-code', state: 'wrong-state' });
    expect(wrongState.status).toBe(400);
    const errorWithoutState = await simulateCallback(authUrl, { error: 'access_denied' });
    expect(errorWithoutState.status).toBe(400);
    const errorWithWrongState = await simulateCallback(authUrl, { error: 'access_denied', state: 'wrong-state' });
    expect(errorWithWrongState.status).toBe(400);

    // The genuine response still completes the flow.
    const genuine = await simulateCallback(authUrl, { code: 'test-auth-code', state });
    expect(genuine.status).toBe(200);
    const result = await flowPromise;
    expect(result.token.accessToken).toBe('mock-access-token');
    expect(mockTokenServer.lastRequest()?.code).toBe('test-auth-code');
  });

  it('times out instead of failing early when only callbacks with the wrong state arrive', async () => {
    const provider = makeProvider(mockTokenServer.port());
    const { openUrl, urlPromise } = captureAuthUrl();

    const flowPromise = runOAuthFlow(provider, testCredentials, undefined, 500, { openUrl });
    flowPromise.catch(() => {});

    const authUrl = await urlPromise;
    await simulateCallback(authUrl, { code: 'test-code', state: 'wrong-state' });

    await expect(flowPromise).rejects.toThrow(/timed out/);
  });

  it('uses custom scopes when provided', async () => {
    const provider = makeProvider(mockTokenServer.port());
    const customScopes = ['custom-scope-1', 'custom-scope-2'];
    const { openUrl, urlPromise } = captureAuthUrl();

    const flowPromise = runOAuthFlow(provider, testCredentials, customScopes, 10_000, { openUrl });

    const authUrl = await urlPromise;
    const parsed = new URL(authUrl);
    expect(parsed.searchParams.get('scope')).toBe('custom-scope-1 custom-scope-2');

    // Complete the flow
    const state = parsed.searchParams.get('state')!;
    await simulateCallback(authUrl, { code: 'test-code', state });

    const result = await flowPromise;
    expect(result.token.accessToken).toBe('mock-access-token');
  });

  it('throws OAuthFlowError when token exchange fails', async () => {
    // Create a token server that returns errors
    const badTokenServer = startMockTokenServer({ status: 401, body: '{"error":"invalid_client"}' });
    await waitForServer(badTokenServer.server);

    const provider = makeProvider(badTokenServer.port());
    const { openUrl, urlPromise } = captureAuthUrl();

    const flowPromise = runOAuthFlow(provider, testCredentials, undefined, 10_000, { openUrl });
    flowPromise.catch(() => {});

    const authUrl = await urlPromise;
    const parsed = new URL(authUrl);
    const state = parsed.searchParams.get('state')!;

    await simulateCallback(authUrl, { code: 'test-code', state });

    await expect(flowPromise).rejects.toThrow(OAuthFlowError);
    await expect(flowPromise).rejects.toThrow(/Token exchange failed/);

    badTokenServer.close();
  });
});

describe('runOAuthFlow headless (--no-browser) paste mode', () => {
  let mockTokenServer: ReturnType<typeof startMockTokenServer>;

  beforeEach(async () => {
    mockTokenServer = startMockTokenServer();
    await waitForServer(mockTokenServer.server);
  });

  afterEach(() => {
    mockTokenServer.close();
  });

  /** The URL the browser would be redirected to, with `params` in its query. */
  function redirectedUrl(authUrl: string, params: Record<string, string>): string {
    const url = new URL(new URL(authUrl).searchParams.get('redirect_uri')!);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  }

  it('completes with a pasted redirect URL and never opens a browser', async () => {
    const provider = makeProvider(mockTokenServer.port());
    const openUrl = vi.fn();
    const requests: PasteRedirectRequest[] = [];
    const flow = runOAuthFlow(provider, testCredentials, undefined, 10_000, {
      openUrl,
      pasteRedirectUrl: (request) => {
        requests.push(request);
        const state = new URL(request.authUrl).searchParams.get('state')!;
        return Promise.resolve(`  ${redirectedUrl(request.authUrl, { code: 'pasted-code', state })}\n`);
      },
    });

    const result = await flow;

    expect(result.token.accessToken).toBe('mock-access-token');
    expect(openUrl).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(requests[0].problem).toBeUndefined();
    const exchange = mockTokenServer.lastRequest();
    expect(exchange?.code).toBe('pasted-code');
    // The exchange names the same loopback redirect URI the authorization request used.
    expect(exchange?.redirect_uri).toBe(new URL(requests[0].authUrl).searchParams.get('redirect_uri'));
  });

  it('asks again, saying why, when a pasted URL has the wrong state or is not the redirect', async () => {
    const provider = makeProvider(mockTokenServer.port());
    const answers = [
      (authUrl: string) => redirectedUrl(authUrl, { code: 'stale-code', state: 'from-an-earlier-attempt' }),
      () => 'https://example.com/callback?code=x',
      () => 'not a url at all',
      (authUrl: string) =>
        redirectedUrl(authUrl, { code: 'good-code', state: new URL(authUrl).searchParams.get('state')! }),
    ];
    const problems: (string | undefined)[] = [];
    const result = await runOAuthFlow(provider, testCredentials, undefined, 10_000, {
      pasteRedirectUrl: (request) => {
        problems.push(request.problem);
        const next = answers.shift();
        return Promise.resolve(next?.(request.authUrl));
      },
    });

    expect(result.token.accessToken).toBe('mock-access-token');
    expect(mockTokenServer.lastRequest()?.code).toBe('good-code');
    expect(problems[0]).toBeUndefined();
    expect(problems[1]).toMatch(/does not carry the state/);
    expect(problems[2]).toMatch(/does not start with http:\/\/127\.0\.0\.1:/);
    expect(problems[3]).toMatch(/is not a URL/);
  });

  it('honours a pasted error response only when it carries the state', async () => {
    const provider = makeProvider(mockTokenServer.port());
    const flow = runOAuthFlow(provider, testCredentials, undefined, 10_000, {
      pasteRedirectUrl: (request) => {
        const state = new URL(request.authUrl).searchParams.get('state')!;
        return Promise.resolve(redirectedUrl(request.authUrl, { error: 'access_denied', state }));
      },
    });

    await expect(flow).rejects.toThrow(/Authorization failed: access_denied/);
  });

  it('fails when the user cancels the paste prompt', async () => {
    const provider = makeProvider(mockTokenServer.port());
    const flow = runOAuthFlow(provider, testCredentials, undefined, 10_000, {
      pasteRedirectUrl: () => Promise.resolve(undefined),
    });

    await expect(flow).rejects.toThrow(/Authorization cancelled/);
  });

  it('still accepts the loopback callback, and then ends the pending paste prompt', async () => {
    const provider = makeProvider(mockTokenServer.port());
    let signal: AbortSignal | undefined;
    let authUrl = '';
    const results: string[] = [];
    const prompted = new Promise<void>((resolvePrompted) => {
      void runOAuthFlow(provider, testCredentials, undefined, 10_000, {
        pasteRedirectUrl: (request) => {
          signal = request.signal;
          authUrl = request.authUrl;
          resolvePrompted();
          // Like a prompt: settles only when its signal aborts.
          return new Promise((resolveAnswer) =>
            request.signal.addEventListener('abort', () => resolveAnswer(undefined)),
          );
        },
      }).then(
        (result) => results.push(result.token.accessToken),
        (err: unknown) => results.push(String(err)),
      );
    });
    await prompted;

    const state = new URL(authUrl).searchParams.get('state')!;
    const callback = await simulateCallback(authUrl, { code: 'browser-code', state });
    expect(callback.status).toBe(200);
    await vi.waitFor(() => expect(results).toEqual(['mock-access-token']));
    expect(signal?.aborted).toBe(true);
    expect(mockTokenServer.lastRequest()?.code).toBe('browser-code');
  });
});
