/**
 * Unit tests for the MITM provider-route credential gate (MITM-2): every
 * credential carrier is stripped, the session sentinel is the only credential
 * that buys the real key, anything else is a local 401, and keyless requests
 * pass only on endpoints declared unauthenticated.
 */
import { describe, expect, it } from 'vitest';
import {
  applyProviderCredential,
  credentialRejectionBody,
  injectRealKey,
  redactCredentialQuery,
  type ForwardHeaders,
  type ProviderCredentialInput,
} from '../../src/docker/provider-credentials.js';
import {
  CREDENTIAL_HEADER_NAMES,
  CREDENTIAL_QUERY_PARAMETERS,
  COOKIE_HEADER_NAMES,
} from '../../src/docker/credential-carriers.js';
import {
  anthropicOAuthProvider,
  anthropicProvider,
  claudePlatformOAuthProvider,
  claudePlatformProvider,
  codexAuthProvider,
  codexChatGptProvider,
  googleProvider,
  isEndpointAllowed,
  isUnauthenticatedEndpoint,
  openaiProvider,
  validateUnauthenticatedEndpoints,
  type ProviderConfig,
} from '../../src/docker/provider-config.js';
import { getGatewayDefinition } from '../../src/config/provider-definitions.js';
import { REDACTED_HEADER_NAMES } from '../../src/docker/trajectory-types.js';

const SENTINEL = 'sk-test-ironcurtain-SENTINEL_value-123';
const REAL_KEY = 'real-key-never-in-the-container';

function headerProvider(overrides: Partial<ProviderConfig> = {}): ProviderCredentialInput {
  return {
    config: { keyInjection: { type: 'header', headerName: 'x-api-key' }, ...overrides },
    fakeKey: SENTINEL,
    realKey: REAL_KEY,
  };
}

function bearerProvider(realKey = REAL_KEY): ProviderCredentialInput {
  return { config: { keyInjection: { type: 'bearer' } }, fakeKey: SENTINEL, realKey };
}

describe('applyProviderCredential', () => {
  it('swaps a sentinel in the configured header and strips every other carrier', () => {
    const headers: ForwardHeaders = {
      'x-api-key': SENTINEL,
      authorization: `Bearer ${SENTINEL}`,
      cookie: 'session=agent',
      'content-type': 'application/json',
    };
    const decision = applyProviderCredential(headers, 'POST', '/v1/messages?beta=true', headerProvider());
    expect(decision).toEqual({ kind: 'sentinel', path: '/v1/messages?beta=true' });
    expect(headers).toEqual({ 'x-api-key': REAL_KEY, 'content-type': 'application/json' });
  });

  it('moves a Bearer sentinel to the configured header, whatever the scheme case', () => {
    for (const authorization of [`Bearer ${SENTINEL}`, `bearer ${SENTINEL}`, `BEARER  ${SENTINEL} `]) {
      const headers: ForwardHeaders = { authorization };
      expect(applyProviderCredential(headers, 'GET', '/v1/models', headerProvider()).kind).toBe('sentinel');
      expect(headers).toEqual({ 'x-api-key': REAL_KEY });
    }
  });

  it('moves a sentinel from any header carrier to Authorization for a bearer provider', () => {
    for (const name of ['x-api-key', 'x-goog-api-key', 'api-key']) {
      const headers: ForwardHeaders = { [name]: SENTINEL };
      expect(applyProviderCredential(headers, 'GET', '/v1/models', bearerProvider()).kind).toBe('sentinel');
      expect(headers).toEqual({ authorization: `Bearer ${REAL_KEY}` });
    }
  });

  it('matches carrier header names case-insensitively', () => {
    const headers: ForwardHeaders = { 'X-Api-Key': SENTINEL, Cookie: 'a=b' };
    expect(applyProviderCredential(headers, 'GET', '/v1/models', headerProvider()).kind).toBe('sentinel');
    expect(headers).toEqual({ 'x-api-key': REAL_KEY });
  });

  it.each<[string, ForwardHeaders, string]>([
    ['a foreign key in the configured header', { 'x-api-key': 'ATTACKER' }, 'x-api-key'],
    ['a foreign bearer', { authorization: 'Bearer ATTACKER' }, 'authorization'],
    ['a non-Bearer authorization', { authorization: 'Basic QVRUQUNLRVI=' }, 'authorization'],
    ['a sentinel and a foreign bearer', { 'x-api-key': SENTINEL, authorization: 'Bearer ATTACKER' }, 'authorization'],
    [
      'a foreign x-goog-api-key beside the sentinel',
      { 'x-api-key': SENTINEL, 'x-goog-api-key': 'A' },
      'x-goog-api-key',
    ],
    ['a foreign anthropic-api-key', { 'anthropic-api-key': 'ATTACKER' }, 'anthropic-api-key'],
    ['duplicate key headers joined by the parser', { 'x-api-key': `${SENTINEL}, ATTACKER` }, 'x-api-key'],
    ['an array-valued carrier', { 'api-key': [SENTINEL, 'ATTACKER'] }, 'api-key'],
    ['a sentinel with a Bearer prefix in a key header', { 'x-api-key': `Bearer ${SENTINEL}` }, 'x-api-key'],
  ])('rejects %s with a 401 naming the carrier but not the value', (_label, headers, carrier) => {
    const decision = applyProviderCredential(headers, 'POST', '/v1/messages', headerProvider());
    expect(decision).toMatchObject({ kind: 'rejected', status: 401 });
    if (decision.kind !== 'rejected') throw new Error('expected a rejection');
    expect(decision.message).toContain(carrier);
    expect(decision.message).not.toContain('ATTACKER');
    expect(decision.message).not.toContain(SENTINEL);
    // Nothing that could authenticate is left behind.
    for (const name of CREDENTIAL_HEADER_NAMES) expect(headers[name]).toBeUndefined();
  });

  it('removes credential query parameters that carry the sentinel and keeps the rest byte-for-byte', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      [
        `/v1beta/models/x:streamGenerateContent?key=${SENTINEL}&alt=sse`,
        '/v1beta/models/x:streamGenerateContent?alt=sse',
      ],
      [`/v1beta/models/x:generateContent?alt=sse&KEY=${SENTINEL}`, '/v1beta/models/x:generateContent?alt=sse'],
      [`/v1/models?access_token=${SENTINEL}`, '/v1/models'],
      [`/v1/models?%6Bey=${encodeURIComponent(SENTINEL)}&q=a%2Bb+c`, '/v1/models?q=a%2Bb+c'],
      ['/v1/models?q=%ZZ&key=', '/v1/models?q=%ZZ'],
    ];
    for (const [path, forwarded] of cases) {
      const headers: ForwardHeaders = path.endsWith('key=') ? { 'x-api-key': SENTINEL } : {};
      expect(applyProviderCredential(headers, 'GET', path, headerProvider()), path).toEqual({
        kind: 'sentinel',
        path: forwarded,
      });
      expect(headers).toEqual({ 'x-api-key': REAL_KEY });
    }
  });

  it.each([
    ['a foreign key parameter', '/v1/models?key=AIza-ATTACKER', 'query:key'],
    ['a percent-encoded foreign key parameter', '/v1/models?%6Bey=ATTACKER', 'query:key'],
    ['a foreign oauth_token parameter', '/v1/models?alt=sse&oauth_token=ATTACKER', 'query:oauth_token'],
    ['a key parameter behind a `;`', '/v1/models?alt=sse;key=ATTACKER', 'query:;key'],
    ['a sentinel key whose value runs into a `;`', `/v1/models?key=${SENTINEL};x=1`, 'query:key'],
    ['an undecodable key value', '/v1/models?key=%ZZ', 'query:key'],
  ])('rejects %s with a 401', (_label, path, carrier) => {
    const decision = applyProviderCredential({ 'x-api-key': SENTINEL }, 'GET', path, headerProvider());
    expect(decision).toMatchObject({ kind: 'rejected', status: 401 });
    if (decision.kind !== 'rejected') throw new Error('expected a rejection');
    expect(decision.message).toContain(carrier);
  });

  it('rejects a query parameter name it cannot decode with a 400', () => {
    expect(
      applyProviderCredential({ 'x-api-key': SENTINEL }, 'GET', '/v1/models?%ZZ=1', headerProvider()),
    ).toMatchObject({
      kind: 'rejected',
      status: 400,
    });
  });

  it('treats empty carriers as no credential', () => {
    const config = { unauthenticatedEndpoints: [{ method: 'GET', path: '/api/hello' }] } as const;
    for (const headers of [{ 'x-api-key': '' }, { authorization: 'Bearer' }, { authorization: '  ' }]) {
      expect(applyProviderCredential({ ...headers }, 'GET', '/api/hello', headerProvider(config)).kind).toBe(
        'anonymous',
      );
    }
    expect(applyProviderCredential({}, 'GET', '/api/hello?key=', headerProvider(config))).toEqual({
      kind: 'anonymous',
      path: '/api/hello',
    });
  });

  it('forwards a keyless request only to an unauthenticated endpoint', () => {
    const config = { unauthenticatedEndpoints: [{ method: 'GET', path: '/api/hello' }] } as const;
    const anonymousHeaders: ForwardHeaders = { cookie: 'a=b', accept: '*/*' };
    expect(applyProviderCredential(anonymousHeaders, 'GET', '/api/hello', headerProvider(config))).toEqual({
      kind: 'anonymous',
      path: '/api/hello',
    });
    expect(anonymousHeaders).toEqual({ accept: '*/*' });

    expect(applyProviderCredential({}, 'POST', '/api/hello', headerProvider(config))).toMatchObject({
      kind: 'rejected',
      status: 401,
    });
    expect(applyProviderCredential({}, 'POST', '/v1/messages', headerProvider(config))).toMatchObject({
      kind: 'rejected',
      status: 401,
    });
  });

  it('still swaps the sentinel on an unauthenticated endpoint', () => {
    const config = { unauthenticatedEndpoints: [{ method: 'GET', path: '/api/hello' }] } as const;
    const headers: ForwardHeaders = { 'x-api-key': SENTINEL };
    expect(applyProviderCredential(headers, 'GET', '/api/hello', headerProvider(config)).kind).toBe('sentinel');
    expect(headers).toEqual({ 'x-api-key': REAL_KEY });
  });

  it('never matches an empty sentinel', () => {
    const decision = applyProviderCredential({ 'x-api-key': 'anything' }, 'GET', '/v1/models', {
      ...headerProvider(),
      fakeKey: '',
    });
    expect(decision).toMatchObject({ kind: 'rejected', status: 401 });
  });

  it('forwards no credential at all for a keyless gateway (empty real key)', () => {
    const headers: ForwardHeaders = { authorization: `Bearer ${SENTINEL}` };
    expect(applyProviderCredential(headers, 'POST', '/api/v1/messages', bearerProvider('')).kind).toBe('sentinel');
    expect(headers).toEqual({});
  });
});

describe('injectRealKey', () => {
  it('replaces the configured carrier whatever its case', () => {
    const headers: ForwardHeaders = { 'X-Api-Key': 'old', accept: '*/*' };
    injectRealKey(headers, { type: 'header', headerName: 'x-api-key' }, 'new');
    expect(headers).toEqual({ accept: '*/*', 'x-api-key': 'new' });

    const bearer: ForwardHeaders = { Authorization: 'Bearer old' };
    injectRealKey(bearer, { type: 'bearer' }, 'new');
    expect(bearer).toEqual({ authorization: 'Bearer new' });
  });

  it('removes the carrier instead of sending an empty credential', () => {
    const headers: ForwardHeaders = { authorization: 'Bearer old' };
    injectRealKey(headers, { type: 'bearer' }, '');
    expect(headers).toEqual({});
  });
});

describe('redactCredentialQuery', () => {
  it('redacts credential parameter values, behind `&` or `;`, and leaves other paths alone', () => {
    expect(redactCredentialQuery('/v1beta/models/x:generateContent?key=AIza-SECRET&alt=sse')).toBe(
      '/v1beta/models/x:generateContent?key=<redacted>&alt=sse',
    );
    expect(redactCredentialQuery('/v1/models?alt=sse;Access_Token=SECRET')).toBe(
      '/v1/models?alt=sse;Access_Token=<redacted>',
    );
    expect(redactCredentialQuery('/v1/models?%6Bey=SECRET')).toBe('/v1/models?%6Bey=<redacted>');
    expect(redactCredentialQuery('/v1/messages?beta=true')).toBe('/v1/messages?beta=true');
    expect(redactCredentialQuery('/v1/messages')).toBe('/v1/messages');
  });
});

describe('credentialRejectionBody', () => {
  it('is readable by both the Anthropic and OpenAI SDKs', () => {
    expect(JSON.parse(credentialRejectionBody({ status: 401, message: 'no credential' }))).toEqual({
      type: 'error',
      error: { type: 'authentication_error', message: 'IronCurtain proxy refused this request: no credential' },
    });
    expect(JSON.parse(credentialRejectionBody({ status: 400, message: 'bad query' }))).toMatchObject({
      error: { type: 'invalid_request_error' },
    });
  });
});

describe('built-in provider credential declarations', () => {
  const builtIns: readonly ProviderConfig[] = [
    anthropicProvider,
    anthropicOAuthProvider,
    claudePlatformProvider,
    claudePlatformOAuthProvider,
    openaiProvider,
    codexChatGptProvider,
    codexAuthProvider,
    googleProvider,
  ];

  it('declare only allowed endpoints as unauthenticated', () => {
    for (const provider of builtIns) expect(() => validateUnauthenticatedEndpoints(provider)).not.toThrow();
  });

  it('never let a completion or account endpoint run without the session credential', () => {
    for (const provider of builtIns) {
      for (const endpoint of provider.completionEndpoints ?? []) {
        const path = endpoint.path.replace('*', 'gemini-2.5-pro');
        expect(isUnauthenticatedEndpoint(provider, endpoint.method, path), `${provider.host}${path}`).toBe(false);
      }
    }
    for (const [provider, method, path] of [
      [anthropicProvider, 'POST', '/v1/messages/count_tokens'],
      [anthropicProvider, 'GET', '/api/claude_code/settings'],
      [anthropicOAuthProvider, 'GET', '/api/oauth/usage'],
      [codexChatGptProvider, 'GET', '/backend-api/codex/models'],
      [codexChatGptProvider, 'GET', '/backend-api/wham/accounts/check'],
      [codexChatGptProvider, 'POST', '/codex-backend/agent-identity'],
      [codexAuthProvider, 'GET', '/api/accounts/v1/user-auth-credential/whoami'],
    ] as const) {
      expect(isUnauthenticatedEndpoint(provider, method, path), `${provider.host}${path}`).toBe(false);
    }
  });

  it('list exactly the keyless calls their clients make', () => {
    expect(anthropicProvider.unauthenticatedEndpoints).toEqual([
      { method: 'GET', path: '/api/hello' },
      { method: 'GET', path: '/mcp-registry/v0/servers' },
      { method: 'POST', path: '/api/event_logging/batch' },
      { method: 'POST', path: '/api/event_logging/v2/batch' },
      { method: 'POST', path: '/api/eval/*' },
    ]);
    expect(anthropicOAuthProvider.unauthenticatedEndpoints).toBe(anthropicProvider.unauthenticatedEndpoints);
    expect(claudePlatformProvider.unauthenticatedEndpoints).toEqual([{ method: 'GET', path: '/v1/oauth/hello' }]);
    expect(claudePlatformOAuthProvider.unauthenticatedEndpoints).toEqual([{ method: 'GET', path: '/v1/oauth/hello' }]);
    expect(codexChatGptProvider.unauthenticatedEndpoints).toEqual([
      { method: 'GET', path: '/agent-identities/jwks' },
      { method: 'GET', path: '/wham/agent-identities/jwks' },
    ]);
    for (const provider of [openaiProvider, codexAuthProvider, googleProvider]) {
      expect(provider.unauthenticatedEndpoints, provider.host).toBeUndefined();
    }
  });

  it('allow Codex workspace routing discovery as a read-only GET', () => {
    expect(isEndpointAllowed(codexChatGptProvider, 'GET', '/backend-api/wham/accounts/check')).toBe(true);
    expect(isEndpointAllowed(codexChatGptProvider, 'POST', '/backend-api/wham/accounts/check')).toBe(false);
    expect(isEndpointAllowed(codexChatGptProvider, 'GET', '/backend-api/wham/accounts/check/x')).toBe(false);
  });

  it('put every provider key header in the carrier list and the capture redaction set', () => {
    const keyHeaders = builtIns.map((provider) =>
      provider.keyInjection.type === 'header' ? provider.keyInjection.headerName : 'authorization',
    );
    for (const gateway of ['openrouter', 'zai']) {
      expect(getGatewayDefinition(gateway).keyInjection.type).toBe('bearer');
    }
    for (const header of [...keyHeaders, 'authorization']) {
      expect(CREDENTIAL_HEADER_NAMES as readonly string[]).toContain(header);
      expect(REDACTED_HEADER_NAMES.has(header), header).toBe(true);
    }
    for (const header of [...CREDENTIAL_HEADER_NAMES, ...COOKIE_HEADER_NAMES, 'set-cookie', 'proxy-authorization']) {
      expect(REDACTED_HEADER_NAMES.has(header), header).toBe(true);
    }
    expect(CREDENTIAL_QUERY_PARAMETERS).toContain('key');
  });
});
