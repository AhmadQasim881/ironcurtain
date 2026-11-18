/**
 * Codex transport: POST + SSE only, no WebSocket (MITM-22).
 *
 * The MITM never bridges WebSockets on provider hosts; it tears every upgrade
 * down so the client falls back to HTTP, the transport the request sanitizers,
 * credential gate, trajectory capture and metrics understand. Codex's built-in
 * ChatGPT provider prefers a WebSocket and spent about 7 s per turn on refused
 * handshakes before falling back, so the adapter binds every route to a
 * provider with WebSockets off. These tests pin the generated configuration
 * and the proxy's side of the contract. The installed-client check lives in
 * codex-websocket-live.integration.test.ts (opt-in).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as tls from 'node:tls';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { parse as parseToml } from 'smol-toml';
import { CODEX_CLIENT_VERSION, CODEX_NATIVE_PROVIDER_ID, createCodexAdapter } from '../../src/docker/adapters/codex.js';
import { loadOrCreateCA, type CertificateAuthority } from '../../src/docker/ca.js';
import { createMitmProxy, type MitmProxy } from '../../src/docker/mitm-proxy.js';
import { codexChatGptProvider, isEndpointAllowed } from '../../src/docker/provider-config.js';
import type { IronCurtainConfig } from '../../src/config/types.js';
import * as logger from '../../src/logger.js';
import type {
  ResolvedOpenRouterProfile,
  ResolvedProviderProfile,
  ResolvedZaiProfile,
} from '../../src/config/user-config.js';
import {
  createFakeUpstream,
  localhostDnsLookup,
  makeHttpsRequest,
  sendConnect,
  type FakeUpstream,
} from '../helpers/mitm-tls-harness.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Provider ids Codex 0.157.1 reserves; a config that redefines one fails to load. */
const CODEX_RESERVED_PROVIDER_IDS = ['openai', 'ollama', 'lmstudio'];

const NO_AGENT_OVERRIDES = { 'claude-code': undefined, codex: undefined, goose: undefined } as const;

const openRouterProfile: ResolvedOpenRouterProfile = {
  type: 'openrouter',
  apiKey: 'sk-or-v1-host-only',
  modelMap: [{ match: '*opus*', model: 'z-ai/glm-5.3' }],
  usesDefaultMap: false,
  perAgent: NO_AGENT_OVERRIDES,
  providerPreference: undefined,
  sessionAffinity: true,
};

const zaiProfile: ResolvedZaiProfile = {
  type: 'zai',
  apiKey: 'host-only-zai-key',
  plan: 'api',
  model: 'glm-5.3',
  modelMap: [],
  usesDefaultMap: false,
  perAgent: NO_AGENT_OVERRIDES,
};

function configFor(profile: ResolvedProviderProfile | undefined): IronCurtainConfig {
  return (profile ? { activeProviderProfile: profile } : {}) as IronCurtainConfig;
}

function generatedToml(config: IronCurtainConfig): string {
  const file = createCodexAdapter()
    .generateMcpConfig('/run/ironcurtain/proxy.sock', config)
    .find((entry) => entry.path === 'codex-config.toml');
  if (!file) throw new Error('the adapter generated no codex-config.toml');
  return file.content;
}

/** The provider table Codex selects through the root `model_provider` key. */
function selectedProvider(toml: Record<string, unknown>): Record<string, unknown> {
  const id = toml.model_provider;
  if (typeof id !== 'string') throw new Error('model_provider is not a root key');
  const providers = toml.model_providers as Record<string, Record<string, unknown>> | undefined;
  const provider = providers?.[id];
  if (!provider) throw new Error(`model_provider "${id}" has no [model_providers.${id}] table`);
  return provider;
}

describe('generated Codex configuration', () => {
  it('binds the native ChatGPT route to a copy of the built-in provider with WebSockets off', () => {
    const toml = parseToml(generatedToml(configFor(undefined))) as Record<string, unknown>;

    expect(toml.model_provider).toBe(CODEX_NATIVE_PROVIDER_ID);
    // The whole table: no base_url (Codex derives the ChatGPT backend from the
    // login mode, as for the built-in provider), no env_key (ChatGPT login, not
    // an API key) and nothing beyond the built-in provider's own settings.
    expect(selectedProvider(toml)).toEqual({
      name: 'OpenAI',
      wire_api: 'responses',
      requires_openai_auth: true,
      http_headers: { version: CODEX_CLIENT_VERSION },
      supports_websockets: false,
    });
    // Model selection stays with Codex and the ChatGPT backend.
    expect(toml.model).toBeUndefined();
    expect(toml.model_catalog_json).toBeUndefined();
    // Codex refuses a config that redefines one of its built-in providers.
    expect(CODEX_RESERVED_PROVIDER_IDS).not.toContain(CODEX_NATIVE_PROVIDER_ID);
  });

  it('generates the same native binding for an explicit native profile', () => {
    expect(generatedToml(configFor({ type: 'native' }))).toBe(generatedToml(configFor(undefined)));
  });

  it.each([
    ['native', undefined, CODEX_NATIVE_PROVIDER_ID],
    ['OpenRouter', openRouterProfile, 'openrouter'],
    ['Z.AI', zaiProfile, 'zai'],
  ] as const)('turns WebSockets off on the %s route', (_label, profile, providerId) => {
    const toml = parseToml(generatedToml(configFor(profile))) as Record<string, unknown>;
    expect(toml.model_provider).toBe(providerId);
    expect(selectedProvider(toml).supports_websockets).toBe(false);
    // Only the selected provider is defined, so no other table can carry a WebSocket setting.
    expect(Object.keys(toml.model_providers as object)).toEqual([providerId]);
    expect(CODEX_RESERVED_PROVIDER_IDS).not.toContain(providerId);
  });

  it('sends the version header of the Codex CLI the image installs', () => {
    const dockerfile = readFileSync(join(HERE, '..', '..', 'docker', 'Dockerfile.codex'), 'utf-8');
    const pinned = /^ARG CODEX_VERSION=(\S+)$/m.exec(dockerfile)?.[1];
    expect(pinned, 'docker/Dockerfile.codex must pin ARG CODEX_VERSION').toBeDefined();
    // Bump CODEX_CLIENT_VERSION in src/docker/adapters/codex.ts together with the image pin.
    expect(CODEX_CLIENT_VERSION).toBe(pinned);
  });
});

describe('chatgpt.com WebSocket handshake at the MITM', () => {
  const fakeKey = 'codex-session-sentinel';
  const realKey = 'codex-real-oauth-token';
  let tempDir: string;
  let ca: CertificateAuthority;
  let socketPath: string;
  let proxy: MitmProxy | undefined;
  let upstream: FakeUpstream | undefined;
  let upstreamUpgrades: string[];

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'codex-websocket-'));
    ca = loadOrCreateCA(join(tempDir, 'ca'));
    socketPath = join(tempDir, 'mitm-proxy.sock');
    upstreamUpgrades = [];
    upstream = await createFakeUpstream();
    upstream.server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
      upstreamUpgrades.push(req.url ?? '');
      socket.destroy();
    });
    proxy = createMitmProxy({
      socketPath,
      ca,
      dnsLookup: localhostDnsLookup,
      allowPrivateDestinationsForTests: true,
      providers: [
        {
          config: {
            ...codexChatGptProvider,
            upstreamTarget: { hostname: '127.0.0.1', port: upstream.port, pathPrefix: '', useTls: false },
          },
          fakeKey,
          realKey,
        },
      ],
    });
    await proxy.start();
  });

  afterEach(async () => {
    await proxy?.stop();
    proxy = undefined;
    if (upstream) {
      const server = upstream.server;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      upstream = undefined;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Writes `raw` over a TLS session to chatgpt.com and returns what arrives
   * before the proxy closes it. Fails unless the TLS session was established,
   * so a failed handshake cannot pass for a torn-down upgrade.
   */
  async function exchangeUntilClosed(raw: string): Promise<string> {
    const { socket, statusCode } = await sendConnect(socketPath, 'chatgpt.com', 443);
    expect(statusCode).toBe(200);
    if (!socket) throw new Error('expected an established CONNECT tunnel');
    let secured = false;
    const received = await new Promise<string>((resolve) => {
      let bytes = '';
      const tlsSocket = tls.connect({ socket, servername: 'chatgpt.com', ca: ca.certPem }, () => {
        secured = true;
        tlsSocket.write(raw);
      });
      tlsSocket.on('data', (chunk: Buffer) => {
        bytes += chunk.toString();
      });
      // A torn-down connection may surface as a reset; only the bytes received matter.
      tlsSocket.on('error', () => undefined);
      tlsSocket.on('close', () => resolve(bytes));
    });
    expect(secured, 'the TLS session through the proxy was never established').toBe(true);
    return received;
  }

  it('tears the handshake down without a response and without contacting chatgpt.com', async () => {
    const logFilePath = join(tempDir, 'session.log');
    logger.setup({ logFilePath });
    let received: string;
    try {
      received = await exchangeUntilClosed(
        [
          'GET /backend-api/codex/responses HTTP/1.1',
          'host: chatgpt.com',
          'upgrade: websocket',
          'connection: Upgrade',
          'sec-websocket-version: 13',
          `sec-websocket-key: ${randomBytes(16).toString('base64')}`,
          `authorization: Bearer ${fakeKey}`,
          'chatgpt-account-id: ironcurtain-account',
          '',
          '',
        ].join('\r\n'),
      );
    } finally {
      logger.teardown();
    }

    // No 101 and no HTTP error: Codex treats a non-101 reply as a fatal turn
    // error, but a closed connection as a transport failure it falls back from.
    expect(received).toBe('');
    // The inner upgrade listener closed it, not a parse error or a dropped tunnel.
    expect(readFileSync(logFilePath, 'utf-8')).toContain('REJECTED websocket chatgpt.com/backend-api/codex/responses');
    expect(upstream?.requests()).toEqual([]);
    expect(upstreamUpgrades).toEqual([]);
  });

  it('refuses a plain GET on the handshake path and still forwards the POST completion', async () => {
    const get = async () => {
      const { socket } = await sendConnect(socketPath, 'chatgpt.com', 443);
      if (!socket) throw new Error('expected an established CONNECT tunnel');
      return makeHttpsRequest(socket, ca, 'chatgpt.com', {
        method: 'GET',
        path: '/backend-api/codex/responses',
        headers: { authorization: `Bearer ${fakeKey}` },
      });
    };
    expect((await get()).statusCode).toBe(403);
    expect(upstream?.requests()).toEqual([]);

    const { socket } = await sendConnect(socketPath, 'chatgpt.com', 443);
    if (!socket) throw new Error('expected an established CONNECT tunnel');
    const post = await makeHttpsRequest(socket, ca, 'chatgpt.com', {
      method: 'POST',
      path: '/backend-api/codex/responses',
      headers: { authorization: `Bearer ${fakeKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.5', input: [], stream: true }),
    });
    expect(post.statusCode).toBe(200);
    expect(upstream?.requests()).toHaveLength(1);
    expect(upstream?.requests()[0]).toMatchObject({ method: 'POST', path: '/backend-api/codex/responses' });
    expect(upstream?.requests()[0].headers.authorization).toBe(`Bearer ${realKey}`);
  });

  it('allows no GET on the completion path in the endpoint allowlist', () => {
    expect(isEndpointAllowed(codexChatGptProvider, 'GET', '/backend-api/codex/responses')).toBe(false);
    expect(isEndpointAllowed(codexChatGptProvider, 'POST', '/backend-api/codex/responses')).toBe(true);
  });
});
