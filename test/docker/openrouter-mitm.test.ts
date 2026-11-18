/**
 * Macro functional tests for OpenRouter through the real MITM proxy (G3, §12.2).
 *
 * Every assertion runs end-to-end through TLS CONNECT against the real
 * `MitmProxy`, with a fake `openrouter.ai` upstream (a local HTTP server the
 * proxy is redirected to via `upstreamTarget` + a loopback DNS override). No
 * provider tokens are spent — the upstream either echoes the received body or
 * serves canned SSE from `test/docker/fixtures/`.
 *
 * Covers §12.2 assertions 1–11:
 *  1. key swap to Bearer real key
 *  2. model rewrite
 *  3. session_id stability (same/different requested model, setTokenSessionId flip)
 *  4. cache_control preserved + beta stripped
 *  5. provider pin (configured strict AND D3 default soft pin)
 *  6. usage cost / cached_tokens surfaced on the token-stream bus
 *  7. keep-alive comment tolerance
 *  8. allowlist 403 for a wrong-kind endpoint
 *  9. count_tokens 404 passthrough + a subsequent call unaffected
 * 10. trajectory classification (path-aware providerForHost) + reassembly
 * 11. tool_result extraction fires through /api/v1/messages
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import type * as http from 'node:http';
import * as zlib from 'node:zlib';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { loadOrCreateCA, type CertificateAuthority } from '../../src/docker/ca.js';
import { createMitmProxy, type MitmProxy } from '../../src/docker/mitm-proxy.js';
import type { ProviderConfig, RequestBodyRewriter } from '../../src/docker/provider-config.js';
import { makeOpenRouterProvider, makeOpenRouterRewriter } from '../../src/docker/openrouter.js';
import { makeGatewayRequestRewriter } from '../../src/docker/gateway-runtime.js';
import { getTokenStreamBus, resetTokenStreamBus } from '../../src/docker/token-stream-bus.js';
import { getLlmMetricsEventBus, resetLlmMetricsEventBus } from '../../src/llm-metrics/event-bus.js';
import type { LlmExchangeCompleted } from '../../src/llm-metrics/types.js';
import { usageTokenBounds } from '../../src/llm-metrics/usage-bounds.js';
import type { TokenStreamEvent } from '../../src/docker/token-stream-types.js';
import { providerForHost, createReassembler, AnthropicReassembler } from '../../src/docker/trajectory-reassembler.js';
import type { SessionId } from '../../src/session/types.js';
import {
  localhostDnsLookup,
  sendConnect,
  makeHttpsRequest,
  createFakeUpstream,
  type FakeUpstream,
  type UpstreamResponder,
} from '../helpers/mitm-tls-harness.js';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const readFixture = (name: string): string => readFileSync(join(FIXTURES_DIR, name), 'utf-8');

const OPENROUTER_HOST = 'openrouter.ai';
const FAKE_KEY = 'sk-or-v1-ironcurtain-fakekey';
const REAL_KEY = 'sk-or-v1-realkey';

interface RewriterOverrides {
  modelMap?: readonly { match: string; model: string }[];
  perAgentDefault?: string;
  providerPreference?: { order?: readonly string[]; only?: readonly string[]; allowFallbacks?: boolean };
  sessionAffinity?: boolean;
}

/** Explicit legacy GLM map; configured targets remain supported. */
const GLM_MAP = [
  { match: '*opus*', model: 'z-ai/glm-5.2' },
  { match: '*sonnet*', model: 'z-ai/glm-5.2' },
  { match: '*haiku*', model: 'z-ai/glm-5.2' },
];

function buildRewriter(overrides: RewriterOverrides = {}): RequestBodyRewriter {
  return makeOpenRouterRewriter({
    modelMap: overrides.modelMap ?? GLM_MAP,
    perAgentDefault: overrides.perAgentDefault,
    providerPreference: overrides.providerPreference,
    sessionAffinity: overrides.sessionAffinity ?? true,
  });
}

describe('OpenRouter through the real MITM (G3 / §12.2)', () => {
  let proxy: MitmProxy | undefined;
  let upstream: FakeUpstream | undefined;
  let tempDir: string;
  let ca: CertificateAuthority;
  let socketPath: string;

  beforeEach(() => {
    resetTokenStreamBus();
    tempDir = mkdtempSync(join(tmpdir(), 'openrouter-mitm-test-'));
    ca = loadOrCreateCA(join(tempDir, 'ca'));
    socketPath = join(tempDir, 'mitm-proxy.sock');
  });

  afterEach(async () => {
    if (proxy) {
      await proxy.stop();
      proxy = undefined;
    }
    if (upstream) {
      upstream.server.close();
      upstream = undefined;
    }
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  /**
   * Stands up the MITM proxy with a single OpenRouter provider whose
   * upstreamTarget is redirected to a local fake server. Returns the started
   * proxy; the caller drives requests through TLS CONNECT.
   */
  async function startProxy(options: {
    kind?: Parameters<typeof makeOpenRouterProvider>[0];
    rewriter?: RequestBodyRewriter;
    upstreamResponder?: UpstreamResponder;
    initialTokenSessionId?: SessionId;
    statisticsEnabled?: boolean;
  }): Promise<void> {
    upstream = await createFakeUpstream(options.upstreamResponder);
    const kind = options.kind ?? 'messages';
    const base = makeOpenRouterProvider(kind, options.rewriter ?? buildRewriter());
    const config: ProviderConfig = {
      ...base,
      upstreamTarget: { hostname: '127.0.0.1', port: upstream.port, pathPrefix: '', useTls: false },
    };
    proxy = createMitmProxy({
      socketPath,
      ca,
      providers: [{ config, fakeKey: FAKE_KEY, realKey: REAL_KEY }],
      dnsLookup: localhostDnsLookup,
      allowPrivateDestinationsForTests: true,
      statisticsEnabled: options.statisticsEnabled,
      ...(options.initialTokenSessionId ? { initialTokenSessionId: options.initialTokenSessionId } : {}),
    });
    await proxy.start();
  }

  /** POST a JSON body to OpenRouter through the proxy, returning the response. */
  async function post(
    path: string,
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
    const { socket, statusCode } = await sendConnect(socketPath, OPENROUTER_HOST, 443);
    expect(statusCode).toBe(200);
    expect(socket).not.toBeNull();
    return makeHttpsRequest(socket as import('node:net').Socket, ca, OPENROUTER_HOST, {
      method: 'POST',
      path,
      headers: { authorization: `Bearer ${FAKE_KEY}`, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  /** The single echoed upstream request body (asserts exactly one was captured). */
  function echoedBody(): Record<string, unknown> {
    const reqs = upstream?.requests() ?? [];
    expect(reqs.length).toBeGreaterThan(0);
    return reqs[reqs.length - 1].body;
  }

  // 1. Key swap: agent's Bearer sentinel becomes the real key upstream.
  it('swaps the sentinel bearer key for the real OpenRouter key upstream', async () => {
    await startProxy({});
    await post('/api/v1/messages', { model: 'claude-sonnet-4-6', messages: [] });
    const req = (upstream as FakeUpstream).requests()[0];
    expect(req.headers['authorization']).toBe(`Bearer ${REAL_KEY}`);
    expect(req.headers['x-openrouter-metadata']).toBe('enabled');
  });

  it('routes Goose main and auxiliary requests once and formats each selected model through TLS', async () => {
    const fast = 'google/gemini-2.5-flash';
    const anthropic = 'anthropic/claude-sonnet-4';
    const details = [{ type: 'encrypted', data: 'opaque-signature' }];
    const rewriter = makeGatewayRequestRewriter(
      {
        type: 'openrouter',
        apiKey: '',
        modelMap: [
          { match: 'A', model: fast },
          { match: fast, model: anthropic },
        ],
        usesDefaultMap: false,
        perAgent: { 'claude-code': undefined, codex: undefined, goose: undefined },
        providerPreference: { only: ['approved'], allowFallbacks: false },
      },
      'chat',
      'goose',
    );
    await startProxy({ kind: 'chat', rewriter });
    for (const [requested, selected] of [
      ['A', fast],
      [fast, anthropic],
    ]) {
      const response = await post('/api/v1/chat/completions', {
        model: requested,
        messages: [
          { role: 'system', content: 'system' },
          { role: 'user', content: 'user' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call',
                type: 'function',
                function: { name: 'tool', arguments: '{}' },
                reasoning_details: details,
              },
            ],
          },
          { role: 'tool', content: 'result', tool_call_id: 'call' },
        ],
        tools: [{ type: 'function', function: { name: 'tool', parameters: {} } }],
      });
      expect(response.statusCode).toBe(200);
      const body = echoedBody();
      expect(body.model).toBe(selected);
      expect(body.provider).toEqual({ only: ['approved'], allow_fallbacks: false });
      const messages = body.messages as Record<string, unknown>[];
      if (selected === fast) {
        expect(messages[2].reasoning_details).toEqual(details);
        expect(messages[0].content).toBe('system');
      } else {
        expect(messages[2].reasoning_details).toBeUndefined();
        expect(messages[0].content).toEqual([{ type: 'text', text: 'system', cache_control: { type: 'ephemeral' } }]);
      }
      expect((upstream as FakeUpstream).requests().at(-1)?.headers.authorization).toBe(`Bearer ${REAL_KEY}`);
    }
  });

  it('keeps OpenRouter metadata negotiation enabled when statistics are enabled', async () => {
    await startProxy({ statisticsEnabled: true });
    await post('/api/v1/messages', { model: 'claude-sonnet-4-6', messages: [] });
    expect((upstream as FakeUpstream).requests()[0].headers['x-openrouter-metadata']).toBe('enabled');
  });

  // 2. Model rewrite: requested Anthropic id is remapped to the GLM slug.
  it('rewrites the requested model to the mapped OpenRouter slug', async () => {
    await startProxy({});
    await post('/api/v1/messages', { model: 'claude-sonnet-4-6', messages: [] });
    expect(echoedBody().model).toBe('z-ai/glm-5.2');
  });

  // 3. session_id stability (D4).
  it('keeps session_id stable for same conversation+model, distinct across model and tokenSessionId', async () => {
    const sid = 'conv-1' as SessionId;
    await startProxy({ initialTokenSessionId: sid });

    await post('/api/v1/messages', { model: 'claude-sonnet-4-6', messages: [] });
    await post('/api/v1/messages', { model: 'claude-sonnet-4-6', messages: [] });
    await post('/api/v1/messages', { model: 'claude-haiku-4-5', messages: [] });

    const reqs = (upstream as FakeUpstream).requests();
    const sonnet1 = reqs[0].body.session_id;
    const sonnet2 = reqs[1].body.session_id;
    const haiku = reqs[2].body.session_id;
    expect(sonnet1).toBe('conv-1:claude-sonnet-4-6');
    expect(sonnet2).toBe(sonnet1); // same conversation + same requested model
    expect(haiku).toBe('conv-1:claude-haiku-4-5'); // different requested model => different id
    expect(haiku).not.toBe(sonnet1);

    // A setTokenSessionId flip changes the cacheKey => a different session_id.
    (proxy as MitmProxy).setTokenSessionId('conv-2' as SessionId);
    await post('/api/v1/messages', { model: 'claude-sonnet-4-6', messages: [] });
    expect((upstream as FakeUpstream).requests()[3].body.session_id).toBe('conv-2:claude-sonnet-4-6');
  });

  // 4. cache_control preserved / beta field stripped.
  it('preserves cache_control blocks and strips context_management', async () => {
    await startProxy({});
    await post('/api/v1/messages', {
      model: 'claude-sonnet-4-6',
      context_management: { edits: [] },
      system: [{ type: 'text', text: 'You are the agent.', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'hi' }],
    });
    const body = echoedBody();
    expect(body.context_management).toBeUndefined();
    expect((body.system as Array<Record<string, unknown>>)[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  // 5. provider pin — configured strict AND D3 default soft pin.
  it('injects the configured provider preference (strict) verbatim', async () => {
    await startProxy({
      rewriter: buildRewriter({ providerPreference: { order: ['z-ai'], allowFallbacks: false } }),
    });
    await post('/api/v1/messages', { model: 'claude-sonnet-4-6', messages: [] });
    expect(echoedBody().provider).toEqual({ order: ['z-ai'], allow_fallbacks: false });
  });

  it('injects the D3 default soft z-ai pin when providerPreference is unset', async () => {
    await startProxy({ rewriter: buildRewriter({ providerPreference: undefined }) });
    await post('/api/v1/messages', { model: 'claude-sonnet-4-6', messages: [] });
    expect(echoedBody().provider).toEqual({ order: ['z-ai'] });
  });

  // 6. usage cost / cached_tokens surfaced on the token-stream bus.
  it('surfaces usage.cost and cached_tokens on the token-stream bus (Anthropic skin)', async () => {
    const sid = 'cost-conv' as SessionId;
    const events: TokenStreamEvent[] = [];
    getTokenStreamBus().subscribe(sid, (_s, e) => events.push(e));

    const sse = readFixture('openrouter-messages-stream.sse');
    await startProxy({
      initialTokenSessionId: sid,
      upstreamResponder: () => ({ status: 200, contentType: 'text/event-stream', body: sse }),
    });
    await post('/api/v1/messages', { model: 'claude-sonnet-4-6', messages: [] });

    const messageEnd = events.find(
      (e): e is Extract<TokenStreamEvent, { kind: 'message_end' }> => e.kind === 'message_end',
    );
    expect(messageEnd).toBeDefined();
    expect(messageEnd?.costUsd).toBe(0.0123);
    expect(messageEnd?.cachedTokens).toBe(900);
  });

  // 6a. The same stream through LLM statistics: the cache read that only
  // message_delta reports is kept, and the exchange is never counted as zero.
  it('records the Anthropic-skin cache read from message_delta in LLM metrics', async () => {
    resetLlmMetricsEventBus();
    const exchanges: LlmExchangeCompleted[] = [];
    const unsubscribe = getLlmMetricsEventBus().subscribe((exchange) => exchanges.push(exchange));
    try {
      const sse = readFixture('openrouter-messages-stream.sse');
      await startProxy({
        statisticsEnabled: true,
        upstreamResponder: () => ({ status: 200, contentType: 'text/event-stream', body: sse }),
      });
      await post('/api/v1/messages', { model: 'claude-sonnet-4-6', stream: true, messages: [] });
      await expect.poll(() => exchanges.length).toBe(1);
      const usage = exchanges[0].usage;
      expect(usage).toMatchObject({ inputTokensUncached: 1024, cacheReadInputTokens: 900, outputTokensTotal: 128 });
      // The exact total is unknown here (this test route declares no usage
      // contract), but the known components bound it from below.
      expect(usageTokenBounds(usage).totalTokens).toBe(2052);
    } finally {
      unsubscribe();
    }
  });

  // 6b. usage cost / cached_tokens on the Chat Completions wire (Goose).
  it('surfaces usage.cost and cached_tokens on the token-stream bus (Chat Completions skin)', async () => {
    const sid = 'cost-conv-chat' as SessionId;
    const events: TokenStreamEvent[] = [];
    getTokenStreamBus().subscribe(sid, (_s, e) => events.push(e));

    const sse = readFixture('openrouter-chat-stream.sse');
    await startProxy({
      kind: 'chat',
      initialTokenSessionId: sid,
      upstreamResponder: () => ({ status: 200, contentType: 'text/event-stream', body: sse }),
    });
    await post('/api/v1/chat/completions', { model: 'claude-sonnet-4-6', messages: [] });

    const messageEnd = events.find(
      (e): e is Extract<TokenStreamEvent, { kind: 'message_end' }> =>
        e.kind === 'message_end' && e.costUsd !== undefined,
    );
    expect(messageEnd, 'chat wire must surface a message_end carrying authoritative cost').toBeDefined();
    expect(messageEnd?.costUsd).toBe(0.0123);
    expect(messageEnd?.cachedTokens).toBe(900);
  });

  // 6c. usage cost / cached_tokens on the Responses wire (Codex).
  it('surfaces usage.cost and cached_tokens on the token-stream bus (Responses skin)', async () => {
    const sid = 'cost-conv-responses' as SessionId;
    const events: TokenStreamEvent[] = [];
    getTokenStreamBus().subscribe(sid, (_s, e) => events.push(e));

    const sse = readFixture('openrouter-responses-stream.sse');
    await startProxy({
      kind: 'responses',
      initialTokenSessionId: sid,
      upstreamResponder: () => ({ status: 200, contentType: 'text/event-stream', body: sse }),
    });
    await post('/api/v1/responses', { model: 'claude-sonnet-4-6', input: [] });

    const messageEnd = events.find(
      (e): e is Extract<TokenStreamEvent, { kind: 'message_end' }> => e.kind === 'message_end',
    );
    expect(messageEnd, 'responses wire must surface a message_end carrying authoritative cost').toBeDefined();
    expect(messageEnd?.costUsd).toBe(0.0123);
    expect(messageEnd?.cachedTokens).toBe(900);
  });

  // 6d-6f. Compressed responses: the token stream decodes before parsing, so
  // OpenRouter's authoritative cost is not lost to gzip/br (MITM-9).
  function messageEnds(events: TokenStreamEvent[]): Array<Extract<TokenStreamEvent, { kind: 'message_end' }>> {
    return events.filter((e): e is Extract<TokenStreamEvent, { kind: 'message_end' }> => e.kind === 'message_end');
  }

  it('surfaces usage.cost from a gzip-compressed Anthropic-skin stream', async () => {
    const sid = 'cost-conv-gzip' as SessionId;
    const events: TokenStreamEvent[] = [];
    getTokenStreamBus().subscribe(sid, (_s, e) => events.push(e));

    const sse = readFixture('openrouter-messages-stream.sse');
    await startProxy({
      initialTokenSessionId: sid,
      upstreamResponder: () => ({
        status: 200,
        contentType: 'text/event-stream',
        contentEncoding: 'gzip',
        body: zlib.gzipSync(sse),
      }),
    });
    await post('/api/v1/messages', { model: 'claude-sonnet-4-6', messages: [] });

    await expect.poll(() => messageEnds(events).length).toBe(1);
    expect(messageEnds(events)[0]).toMatchObject({ costUsd: 0.0123, cachedTokens: 900 });
  });

  it('feeds LLM metrics and the token stream from one decode of a gzip stream', async () => {
    resetLlmMetricsEventBus();
    const exchanges: LlmExchangeCompleted[] = [];
    const unsubscribe = getLlmMetricsEventBus().subscribe((exchange) => exchanges.push(exchange));
    const sid = 'cost-conv-gzip-metrics' as SessionId;
    const events: TokenStreamEvent[] = [];
    getTokenStreamBus().subscribe(sid, (_s, e) => events.push(e));
    try {
      const sse = readFixture('openrouter-messages-stream.sse');
      await startProxy({
        statisticsEnabled: true,
        initialTokenSessionId: sid,
        upstreamResponder: () => ({
          status: 200,
          contentType: 'text/event-stream',
          contentEncoding: 'gzip',
          body: zlib.gzipSync(sse),
        }),
      });
      await post('/api/v1/messages', { model: 'claude-sonnet-4-6', stream: true, messages: [] });

      await expect.poll(() => exchanges.length).toBe(1);
      await expect.poll(() => messageEnds(events).length).toBe(1);
      expect(exchanges[0].usage).toMatchObject({ inputTokensUncached: 1024, cacheReadInputTokens: 900 });
      // This test route overrides the upstream (upstreamTarget), which makes
      // the metrics gateway opaque: its cost is never priced as fact.
      expect(exchanges[0].route.gatewayKind).toBe('opaque');
      expect(exchanges[0].usage).toMatchObject({ costUsd: null, estimatedCostUsd: null, costSource: null });
      expect(messageEnds(events)[0]).toMatchObject({ costUsd: 0.0123, cachedTokens: 900 });
    } finally {
      unsubscribe();
    }
  });

  it('surfaces usage.cost from a br-compressed Chat Completions stream', async () => {
    const sid = 'cost-conv-chat-br' as SessionId;
    const events: TokenStreamEvent[] = [];
    getTokenStreamBus().subscribe(sid, (_s, e) => events.push(e));

    const sse = readFixture('openrouter-chat-stream.sse');
    await startProxy({
      kind: 'chat',
      initialTokenSessionId: sid,
      upstreamResponder: () => ({
        status: 200,
        contentType: 'text/event-stream',
        contentEncoding: 'br',
        body: zlib.brotliCompressSync(sse),
      }),
    });
    await post('/api/v1/chat/completions', { model: 'claude-sonnet-4-6', messages: [] });

    await expect.poll(() => messageEnds(events).some((e) => e.costUsd !== undefined)).toBe(true);
    expect(messageEnds(events).find((e) => e.costUsd !== undefined)).toMatchObject({
      costUsd: 0.0123,
      cachedTokens: 900,
    });
  });

  it('surfaces usage.cost from a br-compressed non-streaming JSON response', async () => {
    const sid = 'cost-conv-json-br' as SessionId;
    const events: TokenStreamEvent[] = [];
    getTokenStreamBus().subscribe(sid, (_s, e) => events.push(e));

    const json = JSON.stringify({
      id: 'gen-json',
      type: 'message',
      role: 'assistant',
      model: 'z-ai/glm-5.2',
      content: [{ type: 'text', text: 'Hello from GLM' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 7, cost: 0.0042 },
    });
    await startProxy({
      initialTokenSessionId: sid,
      upstreamResponder: () => ({
        status: 200,
        contentType: 'application/json',
        contentEncoding: 'br',
        body: zlib.brotliCompressSync(json),
      }),
    });
    await post('/api/v1/messages', { model: 'claude-sonnet-4-6', stream: false, messages: [] });

    await expect.poll(() => messageEnds(events).length).toBe(1);
    expect(messageEnds(events)[0]).toMatchObject({
      inputTokens: 10,
      outputTokens: 3,
      costUsd: 0.0042,
      cachedTokens: 7,
    });
    expect(events.find((e) => e.kind === 'text_delta')).toMatchObject({ text: 'Hello from GLM' });
  });

  // 7. keep-alive comment tolerance.
  it('tolerates interleaved keep-alive comment lines without erroring the stream', async () => {
    const sid = 'keepalive-conv' as SessionId;
    const events: TokenStreamEvent[] = [];
    getTokenStreamBus().subscribe(sid, (_s, e) => events.push(e));

    const sse = readFixture('openrouter-messages-stream.sse');
    // The fixture already interleaves ": OPENROUTER PROCESSING" comment lines.
    expect(sse).toContain(': OPENROUTER PROCESSING');
    await startProxy({
      initialTokenSessionId: sid,
      upstreamResponder: () => ({ status: 200, contentType: 'text/event-stream', body: sse }),
    });
    const resp = await post('/api/v1/messages', { model: 'claude-sonnet-4-6', messages: [] });

    expect(resp.statusCode).toBe(200);
    // The client received the full stream (comment lines included, forwarded raw).
    expect(resp.body).toContain(': OPENROUTER PROCESSING');
    // Text deltas were still parsed despite the comment lines.
    const text = events
      .filter((e): e is Extract<TokenStreamEvent, { kind: 'text_delta' }> => e.kind === 'text_delta')
      .map((e) => e.text)
      .join('');
    expect(text).toBe('Hello from GLM');
  });

  // 8. allowlist 403 for a wrong-kind endpoint.
  it('rejects a chat/completions POST on a messages-kind provider (403)', async () => {
    await startProxy({ kind: 'messages' });
    const resp = await post('/api/v1/chat/completions', { model: 'claude-sonnet-4-6', messages: [] });
    expect(resp.statusCode).toBe(403);
    // The blocked request never reached the upstream.
    expect((upstream as FakeUpstream).requests().length).toBe(0);
  });

  // 9. count_tokens passthrough (D5): a 404 passes through, and a subsequent call is unaffected.
  it('passes a count_tokens 404 through unchanged and leaves a following messages call working', async () => {
    const responder: UpstreamResponder = (req) => {
      if (req.path.split('?')[0] === '/api/v1/messages/count_tokens') {
        return { status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not found' }) };
      }
      return { status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, echo: req.body }) };
    };
    await startProxy({ kind: 'messages', upstreamResponder: responder });

    const countResp = await post('/api/v1/messages/count_tokens', { model: 'claude-sonnet-4-6', messages: [] });
    expect(countResp.statusCode).toBe(404);

    const msgResp = await post('/api/v1/messages', { model: 'claude-sonnet-4-6', messages: [] });
    expect(msgResp.statusCode).toBe(200);
    // count_tokens is allowlisted but NOT rewritten: the model passes through unchanged.
    const countReq = (upstream as FakeUpstream).requests()[0];
    expect(countReq.body.model).toBe('claude-sonnet-4-6');
    // The subsequent messages call IS rewritten.
    const msgReq = (upstream as FakeUpstream).requests()[1];
    expect(msgReq.body.model).toBe('z-ai/glm-5.2');
  });

  // 10. trajectory classification (path-aware) + reassembly.
  it('classifies openrouter.ai /api/v1/messages as anthropic and reassembles the canned stream', () => {
    expect(providerForHost('openrouter.ai', '/api/v1/messages')).toBe('anthropic');
    expect(providerForHost('openrouter.ai', '/api/v1/messages')).not.toBe('unknown');
    expect(providerForHost('openrouter.ai', '/api/v1/responses')).toBe('openai');
    expect(providerForHost('openrouter.ai', '/api/v1/chat/completions')).toBe('openai');

    const reassembler = createReassembler('openrouter.ai', '/api/v1/messages');
    expect(reassembler).toBeInstanceOf(AnthropicReassembler);
    expect(createReassembler('openrouter.ai', '/api/v1/responses')).toBeDefined();
    expect(createReassembler('openrouter.ai', '/api/v1/chat/completions')).toBeUndefined();

    const sse = readFixture('openrouter-messages-stream.sse');
    const r = reassembler as AnthropicReassembler;
    expect(() => {
      r.push(Buffer.from(sse, 'utf-8'));
      const result = r.finalize();
      expect(result.bodyUtf8).toContain('Hello from GLM');
    }).not.toThrow();
  });

  // 11. tool_result extraction fires through the OpenRouter /api/v1/messages path.
  it('fires tool_result extraction for a body POSTed to /api/v1/messages', async () => {
    const sid = 'toolresult-conv' as SessionId;
    const events: TokenStreamEvent[] = [];
    getTokenStreamBus().subscribe(sid, (_s, e) => events.push(e));

    await startProxy({ initialTokenSessionId: sid });
    await post('/api/v1/messages', {
      model: 'claude-sonnet-4-6',
      messages: [
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'file listing output' }],
        },
      ],
    });

    const toolResult = events.find(
      (e): e is Extract<TokenStreamEvent, { kind: 'tool_result' }> => e.kind === 'tool_result',
    );
    expect(toolResult).toBeDefined();
    expect(toolResult?.toolUseId).toBe('tu_1');
    expect(toolResult?.content).toContain('file listing output');
  });
});
