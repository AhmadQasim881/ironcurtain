/**
 * Opt-in installed-client check for the Codex transport (MITM-22).
 *
 * Runs the pinned Codex CLI with the configuration the adapter generates for
 * the native ChatGPT route, through a real MITM proxy whose chatgpt.com
 * upstream is a loopback stand-in. With the generated provider binding, the
 * turn must complete over POST + SSE without a single WebSocket handshake.
 * The control run, with Codex's built-in provider, shows that the check sees
 * handshakes when they happen: the proxy refuses each one and Codex falls back
 * only after its retries.
 *
 * Every exchange terminates on loopback: Codex reaches the proxy through
 * HTTPS_PROXY, the proxy refuses every host but chatgpt.com, and chatgpt.com is
 * the stand-in. No credential is involved (the session token is a sentinel).
 * Run it inside a network namespace (loopback only) to rule out any other
 * connection; without root, use `unshare -rn`:
 *
 *   IRONCURTAIN_CODEX_BIN=$(command -v codex) unshare -n sh -c \
 *     'ip link set lo up && npx vitest run test/docker/codex-websocket-live.integration.test.ts'
 *
 * IRONCURTAIN_CODEX_BIN must be the Codex CLI version docker/Dockerfile.codex
 * installs (CODEX_CLIENT_VERSION); the test fails otherwise.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { CODEX_CLIENT_VERSION, CODEX_NATIVE_PROVIDER_ID, createCodexAdapter } from '../../src/docker/adapters/codex.js';
import { loadOrCreateCA, type CertificateAuthority } from '../../src/docker/ca.js';
import { generateFakeKey } from '../../src/docker/fake-keys.js';
import { createMitmProxy, type MitmProxy } from '../../src/docker/mitm-proxy.js';
import { codexChatGptProvider } from '../../src/docker/provider-config.js';
import type { IronCurtainConfig } from '../../src/config/types.js';
import * as logger from '../../src/logger.js';
import { createFakeUpstream, localhostDnsLookup, type FakeUpstream } from '../helpers/mitm-tls-harness.js';

const CODEX_BIN = process.env.IRONCURTAIN_CODEX_BIN;
const HERE = dirname(fileURLToPath(import.meta.url));
const SSE_FIXTURE = readFileSync(join(HERE, 'fixtures', 'codex-responses-stream.sse'), 'utf-8');
/** The final answer the recorded stream carries. */
const FIXTURE_ANSWER = '17 * 23 = 17 * (20 + 3) = 340 + 51 = 391';
const TURN_TIMEOUT_MS = 90_000;

/**
 * Workspace routing discovery, which Codex 0.157.1 runs before a ChatGPT-mode
 * turn: the selected account, its backend origin and a routing hint.
 */
const ACCOUNTS_CHECK = JSON.stringify({
  accounts: [
    {
      id: 'ironcurtain-account',
      structure: 'personal',
      plan_type: 'pro',
      workspace_backend_origin: 'https://chatgpt.com',
      account_routing_override: 'us',
    },
  ],
  default_account_id: 'ironcurtain-account',
});

interface TurnResult {
  readonly exitCode: number | null;
  readonly events: readonly Record<string, unknown>[];
  readonly stderr: string;
  /** WebSocket upgrades the proxy refused during the turn. */
  readonly refusedHandshakes: number;
}

describe.skipIf(!CODEX_BIN)('installed Codex CLI through the MITM (native ChatGPT route)', () => {
  const fakeKey = generateFakeKey(codexChatGptProvider.fakeKeyPrefix);
  const realKey = 'codex-real-oauth-token-never-leaves-the-host';
  let dir: string;
  let ca: CertificateAuthority;
  let upstream: FakeUpstream;
  let proxy: MitmProxy;
  let proxyUrl: string;
  let generatedConfig: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'codex-websocket-live-'));
    ca = loadOrCreateCA(join(dir, 'ca'));
    upstream = await createFakeUpstream((req) => {
      const path = new URL(req.path, 'http://stand-in').pathname;
      if (req.method === 'GET' && path === '/backend-api/codex/models') return { body: '{"models":[]}' };
      if (req.method === 'GET' && path === '/backend-api/wham/accounts/check') return { body: ACCOUNTS_CHECK };
      if (req.method === 'POST' && path === '/backend-api/codex/responses') {
        return { contentType: 'text/event-stream', body: SSE_FIXTURE };
      }
      return { status: 404, body: '{"detail":"not served by the stand-in"}' };
    });
    proxy = createMitmProxy({
      listenPort: 0,
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
    const address = await proxy.start();
    proxyUrl = `http://127.0.0.1:${String(address.port)}`;
    generatedConfig = createCodexAdapter().generateMcpConfig(join(dir, 'no-mcp.sock'), {} as IronCurtainConfig)[0]
      .content;
  });

  afterAll(async () => {
    await proxy.stop();
    await new Promise<void>((resolve) => {
      upstream.server.close(() => resolve());
      upstream.server.closeAllConnections();
    });
    rmSync(dir, { recursive: true, force: true });
  });

  /** Environment of the Codex process: nothing inherited but PATH. */
  function codexEnv(home: string): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH,
      HOME: home,
      CODEX_HOME: join(home, '.codex'),
      HTTPS_PROXY: proxyUrl,
      HTTP_PROXY: proxyUrl,
      CODEX_CA_CERTIFICATE: ca.certPath,
      SSL_CERT_FILE: ca.certPath,
      RUST_LOG: 'error',
    };
  }

  /** One `codex exec` turn with `configToml` as the user config, as the image entrypoint prepares it. */
  async function runTurn(name: string, configToml: string): Promise<TurnResult> {
    const home = join(dir, name);
    const workspace = join(dir, `${name}-workspace`);
    mkdirSync(join(home, '.codex'), { recursive: true });
    mkdirSync(workspace);
    writeFileSync(join(home, '.codex', 'config.toml'), configToml);
    // auth.json as docker/entrypoint-codex.sh writes it from the adapter's environment.
    const env = createCodexAdapter().buildEnv({} as IronCurtainConfig, new Map([['chatgpt.com', fakeKey]]));
    writeFileSync(
      join(home, '.codex', 'auth.json'),
      JSON.stringify({
        auth_mode: 'chatgptAuthTokens',
        tokens: {
          id_token: env.IRONCURTAIN_CODEX_ID_TOKEN,
          access_token: env.IRONCURTAIN_CODEX_ACCESS_TOKEN,
          refresh_token: '',
          account_id: env.IRONCURTAIN_CODEX_ACCOUNT_ID,
        },
        last_refresh: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
    // The production argv with the host paths substituted and the sandbox
    // narrowed: the stand-in answers with text only, so nothing would run anyway.
    const argv = createCodexAdapter()
      .buildCommand('Say hi.', 'You are a test.', { sessionId: name, firstTurn: true, modelOverride: 'openai:gpt-5.5' })
      .map((arg) => (arg === '/workspace' ? workspace : arg === 'danger-full-access' ? 'read-only' : arg));

    const logFilePath = join(dir, `${name}.log`);
    logger.setup({ logFilePath });
    try {
      const child = spawn(CODEX_BIN ?? 'codex', argv.slice(1), {
        cwd: workspace,
        env: codexEnv(home),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), TURN_TIMEOUT_MS);
      const exitCode = await new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
      clearTimeout(timer);
      const events = stdout
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const log = readFileSync(logFilePath, 'utf-8');
      const refusedHandshakes = log
        .split('\n')
        .filter((line) => line.includes('REJECTED websocket chatgpt.com/backend-api/codex/responses')).length;
      return { exitCode, events, stderr, refusedHandshakes };
    } finally {
      logger.teardown();
    }
  }

  function finalAnswer(result: TurnResult): string | undefined {
    const item = result.events
      .map((event) => event.item as { type?: string; text?: string } | undefined)
      .filter((entry) => entry?.type === 'agent_message')
      .at(-1);
    return item?.text;
  }

  it('is the Codex CLI version the image pins', () => {
    const home = join(dir, 'version');
    mkdirSync(join(home, '.codex'), { recursive: true });
    const result = spawnSync(CODEX_BIN ?? 'codex', ['--version'], {
      encoding: 'utf-8',
      env: codexEnv(home),
      timeout: 30_000,
    });
    expect(result.stdout, `IRONCURTAIN_CODEX_BIN must be Codex ${CODEX_CLIENT_VERSION}`).toContain(
      CODEX_CLIENT_VERSION,
    );
  });

  it(
    'completes a turn over POST + SSE without a WebSocket handshake',
    async () => {
      const before = upstream.requests().length;
      const result = await runTurn('generated', generatedConfig);

      expect(result.exitCode, result.stderr).toBe(0);
      expect(finalAnswer(result)).toBe(FIXTURE_ANSWER);
      expect(result.events).toContainEqual(expect.objectContaining({ type: 'turn.completed' }));
      expect(result.refusedHandshakes).toBe(0);
      expect(JSON.stringify(result.events)).not.toContain('Falling back from WebSockets');

      const completions = upstream
        .requests()
        .slice(before)
        .filter((req) => req.path.startsWith('/backend-api/codex/responses'));
      expect(completions.map((req) => req.method)).toEqual(['POST']);
      // The binding keeps the built-in provider's headers; the proxy swapped the sentinel.
      expect(completions[0].headers.version).toBe(CODEX_CLIENT_VERSION);
      expect(completions[0].headers.authorization).toBe(`Bearer ${realKey}`);
      expect(completions[0].headers['chatgpt-account-id']).toBe('ironcurtain-account');
    },
    TURN_TIMEOUT_MS + 10_000,
  );

  it(
    'sees the refused handshakes when Codex uses its built-in provider (control)',
    async () => {
      const builtIn = parseToml(generatedConfig) as Record<string, unknown>;
      expect(builtIn.model_provider).toBe(CODEX_NATIVE_PROVIDER_ID);
      delete builtIn.model_provider;
      delete builtIn.model_providers;
      const result = await runTurn('built-in', stringifyToml(builtIn));

      expect(result.exitCode, result.stderr).toBe(0);
      expect(finalAnswer(result)).toBe(FIXTURE_ANSWER);
      expect(result.refusedHandshakes).toBeGreaterThan(0);
    },
    TURN_TIMEOUT_MS + 10_000,
  );
});
