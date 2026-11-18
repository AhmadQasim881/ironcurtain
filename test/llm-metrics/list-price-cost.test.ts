/**
 * Host-side list-price cost through the real metrics pipeline (MET-3): the
 * observation hub, the exchange observer, the gateway adapter, persistence and
 * the statistics query. Direct Anthropic rows carry a `list_price` cost; a
 * gateway-reported cost wins where there is one; opaque and unverified routes
 * are never priced as fact.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { ResponseObservationHub } from '../../src/docker/llm-observation/response-observation-hub.js';
import { LlmMetricsExchangeObserver } from '../../src/llm-metrics/exchange-observer.js';
import { DirectGatewayAdapter } from '../../src/llm-metrics/gateways/direct.js';
import { OpaqueGatewayAdapter } from '../../src/llm-metrics/gateways/opaque.js';
import { OpenRouterGatewayAdapter } from '../../src/llm-metrics/gateways/openrouter.js';
import { ObservedUsageAccumulator } from '../../src/llm-metrics/observed-usage-accumulator.js';
import { migrateLlmMetricsDatabase } from '../../src/llm-metrics/persistence/migrations.js';
import { SqliteLlmMetricsRepository } from '../../src/llm-metrics/persistence/sqlite-repository.js';
import { PRICING_VERSION } from '../../src/llm-metrics/pricing.js';
import { AnthropicMessagesAdapter } from '../../src/llm-metrics/protocols/anthropic-messages.js';
import { GoogleGenerateContentAdapter } from '../../src/llm-metrics/protocols/google-generate-content.js';
import { LlmStatisticsQueryService } from '../../src/llm-metrics/query-service.js';
import type { LlmExchangeCompleted, LlmGatewayAdapter } from '../../src/llm-metrics/types.js';

const OFFICIAL_ANTHROPIC = (): DirectGatewayAdapter =>
  new DirectGatewayAdapter({ providerId: 'anthropic', officialOrigin: true });

/** An Anthropic SSE stream; `usage` goes into message_delta. */
function anthropicStream(model: string, usage: Record<string, unknown>): Buffer {
  return Buffer.from(
    `event: message_start\ndata: ${JSON.stringify({
      type: 'message_start',
      message: { id: 'msg_cost', type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 1 } },
    })}\n\n` +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n' +
      `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage })}\n\n` +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  );
}

const OPUS_USAGE = {
  input_tokens: 1_000,
  cache_read_input_tokens: 10_000,
  cache_creation_input_tokens: 3_000,
  cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 2_000 },
  output_tokens: 500,
};
/** Opus 5.5 list price of OPUS_USAGE: $4 in, $0.20 read, $5 5m write, $8 1h write, $20 out per MTok. */
const OPUS_USAGE_COST = (1_000 * 4 + 10_000 * 0.2 + 1_000 * 5 + 2_000 * 8 + 500 * 20) / 1e6;

const GEMINI_STREAM_PATH = '/v1beta/models/gemini-2.5-flash:streamGenerateContent';

/** One Gemini stream chunk; every chunk carries the cumulative usage so far. */
function geminiChunk(text: string, candidatesTokenCount: number, finishReason?: string): string {
  return `data: ${JSON.stringify({
    candidates: [{ content: { role: 'model', parts: [{ text }] }, ...(finishReason ? { finishReason } : {}) }],
    usageMetadata: { promptTokenCount: 1_000, candidatesTokenCount, totalTokenCount: 1_000 + candidatesTokenCount },
    modelVersion: 'gemini-2.5-flash',
  })}\r\n\r\n`;
}

async function observe(
  body: Buffer,
  options: {
    readonly gateway: LlmGatewayAdapter;
    readonly request?: Record<string, unknown>;
    readonly exchangeId?: string;
    readonly status?: number;
    /** The upstream response is cut off after `body` (no clean end). */
    readonly aborted?: boolean;
    /** Observe a Gemini `streamGenerateContent` stream instead of Anthropic Messages. */
    readonly google?: boolean;
  },
): Promise<LlmExchangeCompleted> {
  let resolveCompleted: ((exchange: LlmExchangeCompleted) => void) | undefined;
  const completed = new Promise<LlmExchangeCompleted>((resolve) => {
    resolveCompleted = resolve;
  });
  const requestPath = options.google ? GEMINI_STREAM_PATH : '/v1/messages';
  const observer = new LlmMetricsExchangeObserver({
    exchangeId: options.exchangeId ?? 'exchange-cost',
    endpoint: {
      method: 'POST',
      path: requestPath,
      protocol: options.google ? 'google-generate-content' : 'anthropic-messages',
      capabilities: { metricsSupport: 'full' },
    },
    attribution: {
      sessionId: 'session-cost',
      agentConversationId: null,
      turnId: 'turn-cost',
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
      clientRouteId: 'api.anthropic.com',
      upstreamRouteId: 'api.anthropic.com',
    },
    protocolAdapter: options.google ? new GoogleGenerateContentAdapter() : new AnthropicMessagesAdapter(),
    gatewayAdapter: options.gateway,
    requestPath,
    onCompleted: (exchange) => resolveCompleted?.(exchange),
  });
  observer.observeUnchangedRequest(Buffer.from(JSON.stringify(options.request ?? { model: 'claude-opus-5-5' })));
  observer.markRequestBodyComplete();
  observer.observeResponseHeaders(options.status ?? 200, { 'content-type': 'text/event-stream' });
  const hub = new ResponseObservationHub({ frameSse: true, consumers: [observer.responseConsumer(true)] });
  hub.write(body);
  if (options.aborted) {
    // Let the observation pump deliver what arrived, then cut the stream off.
    await new Promise((resolve) => setImmediate(resolve));
    hub.abort('upstream_response_aborted');
    observer.markUpstreamResponseEnd();
    observer.markClientDeliveryEnd(true);
    return completed;
  }
  hub.end();
  observer.markUpstreamResponseEnd();
  observer.markClientDeliveryEnd(false);
  return completed;
}

describe('list-price cost in the metrics pipeline', () => {
  it('prices a direct Anthropic exchange at list price with the served model and the TTL split', async () => {
    const exchange = await observe(anthropicStream('claude-opus-5-5', OPUS_USAGE), { gateway: OFFICIAL_ANTHROPIC() });

    expect(exchange.usage.costUsd).toBeNull();
    expect(exchange.usage.costSource).toBe('list_price');
    expect(exchange.usage.pricingVersion).toBe(PRICING_VERSION);
    expect(exchange.usage.estimatedCostUsd).toBeCloseTo(OPUS_USAGE_COST, 12);
  });

  it('prices fast mode from the response speed, and from the request when the response omits it', async () => {
    const fromResponse = await observe(anthropicStream('claude-opus-5-5', { ...OPUS_USAGE, speed: 'fast' }), {
      gateway: OFFICIAL_ANTHROPIC(),
    });
    expect(fromResponse.usage.estimatedCostUsd).toBeCloseTo(OPUS_USAGE_COST * 2, 12);

    const fromRequest = await observe(anthropicStream('claude-opus-5-5', OPUS_USAGE), {
      gateway: OFFICIAL_ANTHROPIC(),
      request: { model: 'claude-opus-5-5', speed: 'fast' },
    });
    expect(fromRequest.usage.estimatedCostUsd).toBeCloseTo(OPUS_USAGE_COST * 2, 12);

    // The response's own report is authoritative over the request.
    const servedStandard = await observe(anthropicStream('claude-opus-5-5', { ...OPUS_USAGE, speed: 'standard' }), {
      gateway: OFFICIAL_ANTHROPIC(),
      request: { model: 'claude-opus-5-5', speed: 'fast' },
    });
    expect(servedStandard.usage.estimatedCostUsd).toBeCloseTo(OPUS_USAGE_COST, 12);
  });

  it('keeps a gateway-reported cost and never adds a list-price estimate to it', async () => {
    const exchange = await observe(anthropicStream('z-ai/glm-5.2', { ...OPUS_USAGE, cost: 0.0123 }), {
      gateway: new OpenRouterGatewayAdapter(),
    });
    expect(exchange.usage).toMatchObject({
      costUsd: 0.0123,
      estimatedCostUsd: null,
      costSource: 'gateway_reported',
      pricingVersion: null,
    });
  });

  it('never prices an opaque or unverified route as fact', async () => {
    const opaque = await observe(anthropicStream('claude-opus-5-5', OPUS_USAGE), {
      gateway: new OpaqueGatewayAdapter(),
    });
    expect(opaque.usage).toMatchObject({ costUsd: null, estimatedCostUsd: null, costSource: null });

    const unverified = await observe(anthropicStream('claude-opus-5-5', OPUS_USAGE), {
      gateway: new DirectGatewayAdapter({ providerId: 'anthropic', officialOrigin: false }),
    });
    expect(unverified.usage).toMatchObject({ estimatedCostUsd: null, costSource: null });
    expect(unverified.qualityFlags).toContain('unverified_direct_origin');
  });

  it('flags an official exchange it cannot price, leaving the cost unknown', async () => {
    const exchange = await observe(anthropicStream('claude-unreleased-9', OPUS_USAGE), {
      gateway: OFFICIAL_ANTHROPIC(),
      request: { model: 'claude-unreleased-9' },
    });
    expect(exchange.usage).toMatchObject({ estimatedCostUsd: null, costSource: null });
    expect(exchange.qualityFlags).toContain('list_price_unavailable:unknown_model');
  });

  it('does not price a stream cut off before its terminal event, whose running usage only looks complete', async () => {
    // Every Gemini chunk carries the cumulative usage so far, so a stream cut
    // off mid-answer still has input and output counts; the output billed
    // after the last chunk the host saw is unknown.
    const google = (): DirectGatewayAdapter => new DirectGatewayAdapter({ providerId: 'google', officialOrigin: true });
    const cut = await observe(Buffer.from(geminiChunk('Hel', 3) + geminiChunk('lo', 5)), {
      gateway: google(),
      google: true,
      request: { contents: [] },
      aborted: true,
    });
    expect(cut.usage.usageCompleteness).toBe('complete');
    expect(cut.usage).toMatchObject({ estimatedCostUsd: null, costSource: null });
    expect(cut.qualityFlags).toContain('list_price_unavailable:incomplete_usage');

    // The same stream through its finishReason is priced (gemini-2.5-flash: $0.30 in, $2.50 out).
    const finished = await observe(Buffer.from(geminiChunk('Hel', 3) + geminiChunk('lo', 5, 'STOP')), {
      gateway: google(),
      google: true,
      request: { contents: [] },
    });
    expect(finished.usage.costSource).toBe('list_price');
    expect(finished.usage.estimatedCostUsd).toBeCloseTo((1_000 * 0.3 + 5 * 2.5) / 1e6, 12);
  });

  it('reads the service tier Anthropic reports in usage, and does not price a priority-tier exchange', async () => {
    const exchange = await observe(anthropicStream('claude-opus-5-5', { ...OPUS_USAGE, service_tier: 'priority' }), {
      gateway: OFFICIAL_ANTHROPIC(),
    });
    expect(exchange.responseMetadata.actualServiceTier).toBe('priority');
    expect(exchange.usage).toMatchObject({ estimatedCostUsd: null, costSource: null });
    expect(exchange.qualityFlags).toContain('list_price_unavailable:unpriced_service_tier');

    const standard = await observe(anthropicStream('claude-opus-5-5', { ...OPUS_USAGE, service_tier: 'standard' }), {
      gateway: OFFICIAL_ANTHROPIC(),
    });
    expect(standard.usage.estimatedCostUsd).toBeCloseTo(OPUS_USAGE_COST, 12);
  });

  it('does not price a speed or tier the adapter does not recognize as standard', async () => {
    const unknownServedSpeed = await observe(anthropicStream('claude-opus-5-5', { ...OPUS_USAGE, speed: 'turbo' }), {
      gateway: OFFICIAL_ANTHROPIC(),
    });
    expect(unknownServedSpeed.usage.costSource).toBeNull();
    expect(unknownServedSpeed.qualityFlags).toEqual(
      expect.arrayContaining(['unknown_response_speed_mode', 'list_price_unavailable:unpriced_speed']),
    );

    const unknownRequestedSpeed = await observe(anthropicStream('claude-opus-5-5', OPUS_USAGE), {
      gateway: OFFICIAL_ANTHROPIC(),
      request: { model: 'claude-opus-5-5', speed: 'turbo' },
    });
    expect(unknownRequestedSpeed.usage.costSource).toBeNull();
    expect(unknownRequestedSpeed.qualityFlags).toContain('list_price_unavailable:unpriced_speed');

    const unknownTier = await observe(
      anthropicStream('claude-opus-5-5', { ...OPUS_USAGE, service_tier: 'overnight' }),
      { gateway: OFFICIAL_ANTHROPIC() },
    );
    expect(unknownTier.usage.costSource).toBeNull();
    expect(unknownTier.qualityFlags).toEqual(
      expect.arrayContaining(['unknown_response_service_tier', 'list_price_unavailable:unpriced_service_tier']),
    );
  });

  it("does not price a Claude id answered by another provider's official origin", async () => {
    const exchange = await observe(anthropicStream('claude-sonnet-4-6', OPUS_USAGE), {
      gateway: new DirectGatewayAdapter({ providerId: 'zai', officialOrigin: true }),
      request: { model: 'claude-sonnet-4-6' },
    });
    expect(exchange.usage).toMatchObject({ estimatedCostUsd: null, costSource: null });
    expect(exchange.qualityFlags).toContain('list_price_unavailable:unknown_model');
  });

  it('feeds the session accumulator a complete cost only when every exchange carried one', async () => {
    const accumulator = new ObservedUsageAccumulator('session-cost', true);
    accumulator.observe(
      await observe(anthropicStream('claude-opus-5-5', OPUS_USAGE), {
        gateway: OFFICIAL_ANTHROPIC(),
        exchangeId: 'priced',
      }),
    );
    expect(accumulator.cumulativeSnapshot()).toMatchObject({ observedExchanges: 1, costedExchanges: 1 });
    expect(accumulator.cumulativeSnapshot().costUsd).toBeCloseTo(OPUS_USAGE_COST, 12);

    accumulator.observe(
      await observe(anthropicStream('claude-unreleased-9', OPUS_USAGE), {
        gateway: OFFICIAL_ANTHROPIC(),
        exchangeId: 'unpriced',
      }),
    );
    expect(accumulator.cumulativeSnapshot()).toMatchObject({ observedExchanges: 2, costedExchanges: 1 });
  });

  it('persists direct Anthropic rows with a list_price cost that the statistics cost measure reports', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ironcurtain-list-price-'));
    const repository = await SqliteLlmMetricsRepository.open({
      databasePath: join(directory, 'llm-usage.sqlite3'),
      flushIntervalMs: 60_000,
    });
    try {
      const priced = await observe(anthropicStream('claude-opus-5-5', OPUS_USAGE), {
        gateway: OFFICIAL_ANTHROPIC(),
        exchangeId: 'exchange-direct',
      });
      const reported = await observe(anthropicStream('z-ai/glm-5.2', { ...OPUS_USAGE, cost: 0.25 }), {
        gateway: new OpenRouterGatewayAdapter(),
        exchangeId: 'exchange-gateway',
      });
      repository.enqueue(priced);
      repository.enqueue(reported);
      await repository.flush();

      const range = { fromMs: Date.now() - 3_600_000, toMs: Date.now() + 60_000 };
      const rows = await repository.scan({ ...range, limit: 10 });
      expect(rows.find((row) => row.exchangeId === 'exchange-direct')).toMatchObject({
        costUsd: null,
        costSource: 'list_price',
        pricingVersion: PRICING_VERSION,
      });
      expect(rows.find((row) => row.exchangeId === 'exchange-direct')?.estimatedCostUsd).toBeCloseTo(
        OPUS_USAGE_COST,
        12,
      );
      expect(rows.find((row) => row.exchangeId === 'exchange-gateway')).toMatchObject({
        costUsd: 0.25,
        estimatedCostUsd: null,
        costSource: 'gateway_reported',
        pricingVersion: null,
      });

      const service = new LlmStatisticsQueryService(repository);
      const [cost] = await service.summarize({ ...range, measures: ['costUsd'] });
      expect(cost.value).toBeCloseTo(OPUS_USAGE_COST + 0.25, 12);
      expect((await service.sessionTotals('session-cost')).costUsd).toBeCloseTo(OPUS_USAGE_COST + 0.25, 12);
    } finally {
      await repository.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('metrics schema 2 migration', () => {
  it('adds the cost columns to a schema-1 database and reads old cost_usd as gateway-reported', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ironcurtain-migrate-cost-'));
    const databasePath = join(directory, 'llm-usage.sqlite3');
    try {
      // A schema-1 database with one exchange whose cost a gateway reported.
      const legacy = new DatabaseSync(databasePath);
      expect(migrateLlmMetricsDatabase(legacy, 1)).toBe(1);
      legacy.close();
      const seeded = await SqliteLlmMetricsRepository.open({ databasePath, flushIntervalMs: 60_000 });
      const reported = await observe(anthropicStream('z-ai/glm-5.2', { ...OPUS_USAGE, cost: 0.5 }), {
        gateway: new OpenRouterGatewayAdapter(),
        exchangeId: 'exchange-new',
      });
      seeded.enqueue(reported);
      await seeded.flush();
      await seeded.close();

      const database = new DatabaseSync(databasePath);
      expect(database.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 2 });
      const columns = (database.prepare('PRAGMA table_info(llm_exchanges)').all() as { name: string }[]).map(
        (column) => column.name,
      );
      expect(columns).toEqual(expect.arrayContaining(['estimated_cost_usd', 'cost_source', 'pricing_version']));
      // A row as schema 1 wrote it: gateway cost, no source column value.
      database.exec(
        "UPDATE llm_exchanges SET cost_source = NULL, estimated_cost_usd = NULL WHERE exchange_id = 'exchange-new'",
      );
      database.close();

      const reopened = await SqliteLlmMetricsRepository.open({ databasePath, flushIntervalMs: 60_000 });
      try {
        const [row] = await reopened.scan({ fromMs: 0, toMs: Date.now() + 60_000, limit: 10 });
        expect(row).toMatchObject({ costUsd: 0.5, estimatedCostUsd: null, costSource: 'gateway_reported' });
      } finally {
        await reopened.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a cost source whose cost column is empty', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ironcurtain-cost-source-'));
    const repository = await SqliteLlmMetricsRepository.open({
      databasePath: join(directory, 'llm-usage.sqlite3'),
      flushIntervalMs: 60_000,
    });
    try {
      const exchange = await observe(anthropicStream('claude-opus-5-5', OPUS_USAGE), {
        gateway: OFFICIAL_ANTHROPIC(),
        exchangeId: 'exchange-inconsistent',
      });
      repository.enqueue({ ...exchange, usage: { ...exchange.usage, estimatedCostUsd: null } });
      await repository.flush();
      expect(repository.health()).toMatchObject({ persisted: 0 });
      expect(await repository.scan({ fromMs: 0, toMs: Date.now() + 60_000, limit: 10 })).toEqual([]);
    } finally {
      await repository.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
