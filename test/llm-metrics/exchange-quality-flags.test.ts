/**
 * The quality flags of one exchange record stay within the bound that
 * persistence accepts. A record over it would be rejected and dropped.
 * Out-of-range upstream statuses are flagged and stored as unknown, and still
 * classify and price the exchange as an error.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ResponseObservationHub } from '../../src/docker/llm-observation/response-observation-hub.js';
import { LlmMetricsExchangeObserver } from '../../src/llm-metrics/exchange-observer.js';
import { DirectGatewayAdapter } from '../../src/llm-metrics/gateways/direct.js';
import { makeNormalizedUsage } from '../../src/llm-metrics/normalization.js';
import { SqliteLlmMetricsRepository } from '../../src/llm-metrics/persistence/sqlite-repository.js';
import { emptyOutcome } from '../../src/llm-metrics/protocols/common.js';
import { MAX_EXCHANGE_QUALITY_FLAGS } from '../../src/llm-metrics/query-contract.js';
import type { LlmExchangeCompleted, LlmProtocolAdapter, NormalizedUsage } from '../../src/llm-metrics/types.js';

const COMPLETE_USAGE = makeNormalizedUsage({
  inputTokensTotal: 10,
  outputTokensTotal: 5,
  canonicalTotalTokens: 15,
  usageCompleteness: 'complete',
});

/** A protocol adapter whose every response raises `flagCount` distinct quality flags and reports `usage`. */
function noisyAdapter(flagCount: number, usage: NormalizedUsage = COMPLETE_USAGE): LlmProtocolAdapter {
  return {
    id: 'anthropic-messages',
    inspectRequest: () => ({
      requestedModel: null,
      streaming: false,
      requestedServiceTier: null,
      reasoningMode: 'unknown',
      reasoningEffort: null,
      thinkingBudgetTokens: null,
      speedMode: null,
      qualityFlags: [],
    }),
    createAccumulator: () => ({
      observeResponseHeaders: () => {},
      observeJsonResponse: () => {},
      observeStreamEvent: () => 'control',
      isProtocolTerminal: () => true,
      snapshot: () => ({
        protocol: 'anthropic-messages',
        // A listed model, so the official-origin list-price estimate succeeds
        // and adds no `list_price_unavailable:*` flag of its own.
        responseModel: 'claude-opus-5-5',
        providerRequestId: null,
        providerResponseId: null,
        actualServiceTier: null,
        usage,
        outcome: emptyOutcome(),
        protocolTerminal: true,
        qualityFlags: Array.from({ length: flagCount }, (_, index) => `invalid_count:field_${index}`),
      }),
    }),
  };
}

async function observeJson(
  protocolAdapter: LlmProtocolAdapter,
  exchangeId: string,
  responseStatus = 200,
): Promise<LlmExchangeCompleted> {
  let resolveCompleted: ((exchange: LlmExchangeCompleted) => void) | undefined;
  const completed = new Promise<LlmExchangeCompleted>((resolve) => {
    resolveCompleted = resolve;
  });
  const observer = new LlmMetricsExchangeObserver({
    exchangeId,
    endpoint: {
      method: 'POST',
      path: '/v1/messages',
      protocol: 'anthropic-messages',
      capabilities: { metricsSupport: 'full' },
    },
    attribution: {
      sessionId: 'session-flags',
      agentConversationId: null,
      turnId: 'turn-flags',
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
    protocolAdapter,
    gatewayAdapter: new DirectGatewayAdapter({ providerId: 'anthropic', officialOrigin: true }),
    requestPath: '/v1/messages',
    onCompleted: (exchange) => resolveCompleted?.(exchange),
  });
  observer.observeUnchangedRequest(Buffer.from('{"model":"claude-opus-5-5"}'));
  observer.observeResponseHeaders(responseStatus, { 'content-type': 'application/json' });
  const hub = new ResponseObservationHub({ frameSse: false, consumers: [observer.responseConsumer(false)] });
  hub.write(Buffer.from('{}'));
  hub.end();
  observer.markUpstreamResponseEnd();
  observer.markClientDeliveryEnd(false);
  return completed;
}

describe('exchange quality flags', () => {
  it('bounds the flags of one exchange so persistence never rejects its write batch', async () => {
    const noisy = await observeJson(noisyAdapter(MAX_EXCHANGE_QUALITY_FLAGS + 16), 'exchange-noisy');
    expect(noisy.qualityFlags).toHaveLength(MAX_EXCHANGE_QUALITY_FLAGS);
    expect(noisy.qualityFlags).toContain('quality_flags_truncated');
    expect(noisy.qualityFlags).toEqual([...noisy.qualityFlags].sort());
    const quiet = await observeJson(noisyAdapter(3), 'exchange-quiet');
    expect(quiet.qualityFlags).toEqual(['invalid_count:field_0', 'invalid_count:field_1', 'invalid_count:field_2']);

    const directory = await mkdtemp(join(tmpdir(), 'ironcurtain-llm-flags-'));
    const repository = await SqliteLlmMetricsRepository.open({
      databasePath: join(directory, 'llm-usage.sqlite3'),
      flushIntervalMs: 60_000,
    });
    try {
      // One write batch: an over-limit record would be rejected, dropping it.
      repository.enqueue(noisy);
      repository.enqueue(quiet);
      await repository.flush();
      expect(repository.health()).toMatchObject({ persisted: 2, dropped: 0 });
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('stores an out-of-range status as unknown but still classifies the exchange as an error', async () => {
    // RFC 9110 section 15: a client treats a status outside 100-599 as a 5xx.
    for (const status of [999, 600, 99]) {
      const invalid = await observeJson(noisyAdapter(0), `exchange-status-${status}`, status);
      expect(invalid.outcome).toMatchObject({ responseStatus: null, termination: 'error' });
      expect(invalid.qualityFlags).toContain('invalid_http_status');
    }

    const valid = await observeJson(noisyAdapter(0), 'exchange-status-200', 200);
    expect(valid.outcome).toMatchObject({ responseStatus: 200, termination: 'unknown' });
    expect(valid.qualityFlags).not.toContain('invalid_http_status');
    const serverError = await observeJson(noisyAdapter(0), 'exchange-status-503', 503);
    expect(serverError.outcome).toMatchObject({ responseStatus: 503, termination: 'error' });
  });

  it('prices an out-of-range status without usage like the server error it is processed as', async () => {
    // On an official origin an error response without usage was not billed:
    // list price 0. A stored-as-unknown status must not read as "no response
    // received", which leaves the cost unknown instead.
    const usageless = makeNormalizedUsage();
    const serverError = await observeJson(noisyAdapter(0, usageless), 'exchange-unbilled-503', 503);
    expect(serverError.usage).toMatchObject({ estimatedCostUsd: 0, costSource: 'list_price' });
    for (const status of [999, 99]) {
      const invalid = await observeJson(noisyAdapter(0, usageless), `exchange-unbilled-${status}`, status);
      expect(invalid.outcome).toMatchObject({ responseStatus: null, termination: 'error' });
      expect(invalid.usage).toMatchObject({ estimatedCostUsd: 0, costSource: 'list_price' });
      expect(invalid.qualityFlags).toContain('invalid_http_status');
      expect(invalid.qualityFlags).not.toContain('list_price_unavailable:incomplete_usage');
    }
  });
});
