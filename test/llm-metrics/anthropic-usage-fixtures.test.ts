/**
 * Anthropic usage fixtures through the real metrics pipeline: the shared
 * observation hub, the exchange observer, the gateway adapter and the session
 * accumulator. Each fixture is a response shape whose usage the parser once
 * under-reported (cache counters only in message_delta, compaction and
 * fallback attempts itemized in usage.iterations).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ResponseObservationHub } from '../../src/docker/llm-observation/response-observation-hub.js';
import { LlmMetricsExchangeObserver } from '../../src/llm-metrics/exchange-observer.js';
import { DirectGatewayAdapter } from '../../src/llm-metrics/gateways/direct.js';
import { OpaqueGatewayAdapter } from '../../src/llm-metrics/gateways/opaque.js';
import { OpenRouterGatewayAdapter } from '../../src/llm-metrics/gateways/openrouter.js';
import { ObservedUsageAccumulator } from '../../src/llm-metrics/observed-usage-accumulator.js';
import { AnthropicMessagesAdapter } from '../../src/llm-metrics/protocols/anthropic-messages.js';
import type { LlmExchangeCompleted, LlmGatewayAdapter } from '../../src/llm-metrics/types.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'docker', 'fixtures');

function fixture(name: string): Buffer {
  return readFileSync(join(FIXTURES, name));
}

/** Drive one response body through the hub and observer exactly as the MITM does. */
async function observe(
  body: Buffer,
  options: { readonly streaming: boolean; readonly gateway: LlmGatewayAdapter; readonly chunkBytes?: number },
): Promise<LlmExchangeCompleted> {
  let resolveCompleted: ((exchange: LlmExchangeCompleted) => void) | undefined;
  const completed = new Promise<LlmExchangeCompleted>((resolve) => {
    resolveCompleted = resolve;
  });
  const observer = new LlmMetricsExchangeObserver({
    endpoint: {
      method: 'POST',
      path: '/v1/messages',
      protocol: 'anthropic-messages',
      capabilities: { metricsSupport: 'full' },
    },
    attribution: {
      sessionId: 'session-fixture',
      agentConversationId: null,
      turnId: 'turn-fixture',
      bundleId: null,
      workflowRunId: null,
      stateId: null,
      personaId: null,
      agentId: 'claude-code',
      quality: 'exact',
    },
    route: {
      logicalProvider: 'anthropic',
      providerProfileId: null,
      protocol: 'anthropic-messages',
      gatewayKind: 'direct',
      clientRouteId: null,
      upstreamRouteId: null,
    },
    protocolAdapter: new AnthropicMessagesAdapter(),
    gatewayAdapter: options.gateway,
    requestPath: '/v1/messages',
    onCompleted: (exchange) => resolveCompleted?.(exchange),
  });
  observer.observeResponseHeaders(200, {
    'content-type': options.streaming ? 'text/event-stream' : 'application/json',
  });
  const hub = new ResponseObservationHub({
    frameSse: options.streaming,
    consumers: [observer.responseConsumer(options.streaming)],
  });
  // Split into chunks so framing crosses chunk boundaries, and pace the
  // writes like a socket so the hub's bounded input queue never overflows.
  const chunkBytes = options.chunkBytes ?? 97;
  for (let offset = 0; offset < body.length; offset += chunkBytes) {
    hub.write(body.subarray(offset, offset + chunkBytes));
    while (hub.snapshot().queuedCompressedBytes > 256 * 1024) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  hub.end();
  observer.markUpstreamResponseEnd();
  observer.markClientDeliveryEnd(false);
  return completed;
}

function sessionTotals(exchange: LlmExchangeCompleted) {
  const accumulator = new ObservedUsageAccumulator('session-fixture', true);
  accumulator.observe(exchange);
  return accumulator.cumulativeSnapshot();
}

describe('Anthropic usage fixtures through the metrics pipeline', () => {
  it('reads cacheRead=900 from the OpenRouter Messages skin and reports a complete non-zero total', async () => {
    const exchange = await observe(fixture('openrouter-messages-stream.sse'), {
      streaming: true,
      gateway: new OpenRouterGatewayAdapter(),
    });
    expect(exchange.usage).toMatchObject({
      inputTokensUncached: 1024,
      cacheReadInputTokens: 900,
      // The skin never reports cache creation; OpenRouter's contract makes it zero.
      cacheWriteInputTokens: 0,
      inputTokensTotal: 1924,
      outputTokensTotal: 128,
      canonicalTotalTokens: 2052,
      costUsd: 0.0123,
      usageCompleteness: 'complete',
    });
    expect(exchange.qualityFlags).toContain('absent_usage_assumed_zero:cache_creation_input_tokens');
    expect(sessionTotals(exchange)).toMatchObject({
      inputTokens: 1924,
      outputTokens: 128,
      totalTokens: 2052,
      cacheReadTokens: 900,
      lowerBound: false,
      status: 'complete',
    });
  });

  it('keeps OpenRouter cache counters unknown when the stream ends before its final usage report', async () => {
    const full = fixture('openrouter-messages-stream.sse').toString('utf8');
    const cut = Buffer.from(full.slice(0, full.indexOf('event: message_delta')));
    const exchange = await observe(cut, { streaming: true, gateway: new OpenRouterGatewayAdapter() });
    // The skin reports cache_read_input_tokens (900 here) in message_delta
    // only, so its absence before then is not a reported zero.
    expect(exchange.usage).toMatchObject({
      inputTokensUncached: 1024,
      cacheReadInputTokens: null,
      cacheWriteInputTokens: null,
      inputTokensTotal: null,
      usageCompleteness: 'partial',
    });
    expect(exchange.qualityFlags.some((flag) => flag.startsWith('absent_usage_assumed_zero'))).toBe(false);
    expect(sessionTotals(exchange)).toMatchObject({
      inputTokens: 1024,
      totalTokens: 1024,
      lowerBound: true,
      status: 'partial',
    });
  });

  it('counts the same skin as a lower bound when the route declares no usage contract', async () => {
    const exchange = await observe(fixture('openrouter-messages-stream.sse'), {
      streaming: true,
      gateway: new OpaqueGatewayAdapter(),
    });
    expect(exchange.usage).toMatchObject({
      cacheReadInputTokens: 900,
      cacheWriteInputTokens: null,
      canonicalTotalTokens: null,
      usageCompleteness: 'partial',
    });
    // Formerly 0 input and 0 total: the known components now bound the totals.
    expect(sessionTotals(exchange)).toMatchObject({
      inputTokens: 1924,
      totalTokens: 2052,
      lowerBound: true,
      status: 'partial',
    });
  });

  it('sums the compaction iteration of a streamed response', async () => {
    const exchange = await observe(fixture('anthropic-compaction-stream.sse'), {
      streaming: true,
      gateway: new DirectGatewayAdapter({ providerId: 'anthropic', officialOrigin: true }),
    });
    expect(exchange.usage).toMatchObject({
      inputTokensReported: 23000,
      inputTokensUncached: 203000,
      cacheReadInputTokens: 4000,
      cacheWriteInputTokens: 1200,
      cacheWrite5mInputTokens: 1200,
      cacheWrite1hInputTokens: 0,
      inputTokensTotal: 208200,
      outputTokensReported: 1000,
      outputTokensTotal: 4500,
      // The 300 thinking tokens describe the final attempt only.
      thinkingTokens: null,
      canonicalTotalTokens: 212700,
      usageSource: 'anthropic_usage_iterations',
      usageCompleteness: 'complete',
    });
    expect(exchange.usage.iterations).toEqual([
      {
        kind: 'compaction',
        model: null,
        inputTokensUncached: 180000,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 3500,
      },
      {
        kind: 'message',
        model: null,
        inputTokensUncached: 23000,
        cacheReadInputTokens: 4000,
        cacheWriteInputTokens: 1200,
        outputTokens: 1000,
      },
    ]);
    expect(exchange.qualityFlags).toEqual(
      expect.arrayContaining(['usage_iterations_summed', 'usage_iteration:compaction']),
    );
    expect(sessionTotals(exchange)).toMatchObject({ inputTokens: 208200, totalTokens: 212700, status: 'complete' });
  });

  it('sums every attempt of a refusal fallback, each under its own model, without adding top-level usage', async () => {
    const exchange = await observe(fixture('anthropic-fallback-message.json'), {
      streaming: false,
      gateway: new DirectGatewayAdapter({ providerId: 'anthropic', officialOrigin: true }),
    });
    expect(exchange.usage).toMatchObject({
      inputTokensUncached: 3020,
      cacheReadInputTokens: 2048,
      cacheWriteInputTokens: 2048,
      cacheWrite5mInputTokens: 2048,
      cacheWrite1hInputTokens: 0,
      inputTokensTotal: 7116,
      outputTokensTotal: 430,
      canonicalTotalTokens: 7546,
      serverToolRequests: { webSearchRequests: 0, webFetchRequests: null },
      usageCompleteness: 'complete',
    });
    // The fallback attempt omits its cache counters; it is the top-level
    // attempt (same input and output), so it takes the top-level ones.
    expect(exchange.usage.iterations).toEqual([
      expect.objectContaining({ kind: 'message', model: 'claude-fable-5-1', cacheReadInputTokens: 2048 }),
      expect.objectContaining({ kind: 'fallback_message', model: 'claude-opus-4-8', cacheWriteInputTokens: 2048 }),
    ]);
    expect(exchange.identity.responseModel.value).toBe('claude-opus-4-8');
    expect(exchange.qualityFlags).toContain('fallback_served');
    expect(exchange.outcome).toMatchObject({ termination: 'stop', refusal: false });
  });

  it('keeps the terminal usage of a stream longer than the full-fidelity event cap', async () => {
    const delta = `event: content_block_delta\ndata: ${JSON.stringify({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'token' },
    })}\n\n`;
    const body = Buffer.from(
      [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_long","model":"claude-opus-5-5","usage":{"input_tokens":12,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1}}}\n\n',
        delta.repeat(120_000),
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":128000}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join(''),
    );
    const exchange = await observe(body, {
      streaming: true,
      gateway: new DirectGatewayAdapter({ providerId: 'anthropic', officialOrigin: true }),
      chunkBytes: 16 * 1024,
    });
    expect(exchange.usage).toMatchObject({
      inputTokensTotal: 12,
      outputTokensTotal: 128000,
      canonicalTotalTokens: 128012,
      usageCompleteness: 'complete',
    });
    expect(exchange.outcome.providerStopReason).toBe('max_tokens');
    expect(exchange.timing.protocolTerminalOffsetMs).not.toBeNull();
    expect(exchange.qualityFlags).toContain('usage_only_observation');
  });
});
