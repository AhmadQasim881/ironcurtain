import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeNormalizedUsage } from '../src/llm-metrics/normalization.js';
import { LlmStatisticsQueryService } from '../src/llm-metrics/query-service.js';
import { LLM_METRICS_SCHEMA_VERSION, migrateLlmMetricsDatabase } from '../src/llm-metrics/persistence/migrations.js';
import { LlmMetricsRepositoryUnavailableError } from '../src/llm-metrics/persistence/repository.js';
import { defaultWorkerFactory, SqliteLlmMetricsRepository } from '../src/llm-metrics/persistence/sqlite-repository.js';
import type { LlmExchangeCompleted } from '../src/llm-metrics/types.js';

const BASE_TIME = Date.parse('2026-08-15T12:00:00.000Z');

function exchange(
  exchangeId: string,
  overrides: {
    readonly startedAtMs?: number;
    readonly sessionId?: string;
    readonly logicalProvider?: string;
    readonly servedModel?: string | null;
    readonly refusal?: boolean | null;
    readonly outcome?: LlmExchangeCompleted['outcome']['termination'];
    readonly inputTokens?: number | null;
    readonly outputTokens?: number | null;
    readonly thinkingTokens?: number | null;
    readonly nonThinkingOutputTokens?: number | null;
    readonly completeness?: LlmExchangeCompleted['usage']['usageCompleteness'];
    readonly clientDeliveryEndOffsetMs?: number | null;
    readonly clientAborted?: boolean;
  } = {},
): LlmExchangeCompleted {
  const inputTokens = overrides.inputTokens === undefined ? 100 : overrides.inputTokens;
  const outputTokens = overrides.outputTokens === undefined ? 40 : overrides.outputTokens;
  return {
    schemaVersion: 1,
    exchangeId,
    attribution: {
      sessionId: overrides.sessionId ?? 'session-1',
      agentConversationId: 'conversation-1',
      turnId: 'turn-1',
      bundleId: 'bundle-1',
      workflowRunId: 'workflow-1',
      stateId: 'state-1',
      personaId: 'persona-1',
      agentId: 'agent-1',
      quality: 'exact',
    },
    route: {
      logicalProvider: overrides.logicalProvider ?? 'openrouter',
      providerProfileId: 'profile-1',
      protocol: 'openai-responses',
      gatewayKind: 'openrouter',
      clientRouteId: 'route-client-1',
      upstreamRouteId: 'route-upstream-1',
    },
    identity: {
      requestedModel: { value: 'requested-model', source: 'request' },
      forwardedModel: { value: 'forwarded-model', source: 'forwarded_request' },
      responseModel: { value: 'response-model', source: 'protocol_response' },
      servedModel: {
        value: overrides.servedModel === undefined ? 'served-model' : overrides.servedModel,
        source: overrides.servedModel === null ? 'not_exposed' : 'router_metadata',
      },
      servedProvider: { value: 'served-provider', source: 'router_metadata' },
    },
    responseMetadata: {
      providerRequestId: 'request-1',
      providerResponseId: 'response-1',
      gatewayGenerationId: 'generation-1',
      actualServiceTier: 'priority',
    },
    request: {
      requestedModel: 'requested-model',
      streaming: true,
      requestedServiceTier: 'priority',
      reasoningMode: 'effort',
      reasoningEffort: 'high',
      thinkingBudgetTokens: null,
      speedMode: 'fast',
      qualityFlags: [],
    },
    outcome: {
      termination: overrides.outcome ?? (overrides.refusal === true ? 'refusal' : 'stop'),
      providerStopReason: overrides.refusal === true ? 'refusal' : 'completed',
      responseStatus: 200,
      refusal: overrides.refusal === undefined ? false : overrides.refusal,
      refusalCategory: overrides.refusal === true ? 'policy' : null,
      refusalSource: overrides.refusal === true ? 'content_item' : 'not_reported',
    },
    usage: {
      inputTokensReported: inputTokens,
      inputTokensTotal: inputTokens,
      inputTokensAccuracy: inputTokens === null ? 'unknown' : 'reported_exact',
      inputTokensUncached: inputTokens === null ? null : inputTokens - 20,
      cacheReadInputTokens: inputTokens === null ? null : 20,
      cacheWriteInputTokens: 0,
      toolUseInputTokens: 0,
      outputTokensReported: outputTokens,
      outputTokenSemantics: 'includes_thinking',
      outputTokensTotal: outputTokens,
      outputTokensAccuracy: outputTokens === null ? 'unknown' : 'reported_exact',
      thinkingTokens: overrides.thinkingTokens === undefined ? 10 : overrides.thinkingTokens,
      thinkingTokensAccuracy: overrides.thinkingTokens === null ? 'unknown' : 'reported_exact',
      nonThinkingOutputTokens: overrides.nonThinkingOutputTokens === undefined ? 30 : overrides.nonThinkingOutputTokens,
      nonThinkingOutputTokensAccuracy: overrides.nonThinkingOutputTokens === null ? 'unknown' : 'derived_exact',
      providerTotalTokens: inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens,
      canonicalTotalTokens: inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens,
      costUsd: inputTokens === null ? null : 0.001,
      usageSource: 'terminal-event',
      usageCompleteness: overrides.completeness ?? 'complete',
      usageSemanticsVersion: 1,
      qualityFlags: [],
    },
    timing: {
      requestReceivedAt: new Date(overrides.startedAtMs ?? BASE_TIME).toISOString(),
      requestBodyCompleteOffsetMs: 2,
      responseHeadersOffsetMs: 10,
      firstUpstreamBodyByteOffsetMs: 11,
      firstProtocolEventOffsetMs: 20,
      firstReasoningEventOffsetMs: 25,
      lastReasoningEventOffsetMs: 40,
      firstOutputEventOffsetMs: 50,
      lastOutputEventOffsetMs: 150,
      protocolTerminalOffsetMs: 160,
      upstreamResponseEndOffsetMs: 170,
      clientDeliveryEndOffsetMs:
        overrides.clientDeliveryEndOffsetMs === undefined ? 180 : overrides.clientDeliveryEndOffsetMs,
      clientAborted: overrides.clientAborted ?? false,
    },
    transportAttempts: [
      { ordinal: 0, startedOffsetMs: 1, endedOffsetMs: 170, responseStatus: 200, outcome: 'response' },
    ],
    gatewayRouteAttempts: [
      {
        ordinal: 0,
        provider: 'served-provider',
        model: overrides.servedModel === undefined ? 'served-model' : overrides.servedModel,
        status: 200,
        selected: true,
        source: 'router_metadata',
      },
    ],
    qualityFlags: ['router_metadata_present'],
  };
}

describe('SQLite LLM metrics repository', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  async function repository(
    options: Partial<Parameters<typeof SqliteLlmMetricsRepository.open>[0]> = {},
  ): Promise<{ repository: SqliteLlmMetricsRepository; databasePath: string }> {
    const directory = await mkdtemp(join(tmpdir(), 'ironcurtain-llm-metrics-'));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, 'statistics', 'llm-usage.sqlite3');
    return {
      repository: await SqliteLlmMetricsRepository.open({ databasePath, flushIntervalMs: 60_000, ...options }),
      databasePath,
    };
  }

  async function waitForMaintenanceLease(databasePath: string): Promise<void> {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      for (let attempt = 0; attempt < 1_000; attempt++) {
        const row = database
          .prepare(
            "SELECT expires_at_ms AS expiresAtMs FROM llm_maintenance_leases WHERE lease_name = 'llm-exchanges-delete'",
          )
          .get();
        if (typeof row?.expiresAtMs === 'number' && row.expiresAtMs > Date.now()) return;
        await delay(1);
      }
    } finally {
      database.close();
    }
    throw new Error('Timed out waiting for LLM metrics maintenance lease');
  }

  it('migrates, writes through WAL, and inserts exchanges idempotently', async () => {
    const opened = await repository({ processRunId: 'process-run-1' });
    expect(opened.repository.health().state).toBe('ready');

    expect(opened.repository.enqueue(exchange('exchange-1'))).toBe(true);
    expect(opened.repository.enqueue(exchange('exchange-1'))).toBe(true);
    await opened.repository.flush();

    expect(opened.repository.health()).toMatchObject({ persisted: 1, duplicates: 1, dropped: 0 });
    const rows = await opened.repository.scan({ fromMs: BASE_TIME, toMs: BASE_TIME + 1_000, limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      exchangeId: 'exchange-1',
      inputTokens: 100,
      toolUseInputTokens: 0,
      thinkingTokens: 10,
      nonThinkingOutputTokens: 30,
      outputTokens: 40,
      totalTokens: 140,
      logicalProvider: 'openrouter',
      servedModel: 'served-model',
      servedModelSource: 'router_metadata',
      servedProviderSource: 'router_metadata',
      providerRequestId: 'request-1',
      providerResponseId: 'response-1',
      gatewayGenerationId: 'generation-1',
      actualServiceTier: 'priority',
      inputMeasurementProvenance: 'reported_exact',
      outputMeasurementProvenance: 'reported_exact',
      thinkingMeasurementProvenance: 'reported_exact',
      nonThinkingMeasurementProvenance: 'derived_exact',
      firstUpstreamBodyByteOffsetMs: 11,
    });

    await opened.repository.close();
    const database = new DatabaseSync(opened.databasePath, { readOnly: true });
    expect(database.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 2 });
    expect(database.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' });
    expect(database.prepare('SELECT COUNT(*) AS count FROM llm_transport_attempts').get()).toMatchObject({ count: 1 });
    expect(database.prepare('SELECT started_offset_ms, ended_offset_ms FROM llm_transport_attempts').get()).toEqual({
      started_offset_ms: 1,
      ended_offset_ms: 170,
    });
    expect(database.prepare('SELECT COUNT(*) AS count FROM llm_gateway_route_attempts').get()).toMatchObject({
      count: 1,
    });
    expect(database.prepare('SELECT * FROM llm_process_runs').get()).toMatchObject({
      observed_count: 2,
      finalized_count: 2,
      enqueued_count: 2,
      clean_ended_at_ms: expect.any(Number),
    });
    database.close();
    expect(statSync(opened.databasePath).mode & 0o777).toBe(0o600);
  });

  it('filters and groups by service tier and measurement provenance', async () => {
    const opened = await repository();
    opened.repository.enqueue(exchange('exchange-query-facts'));
    await opened.repository.flush();
    const range = { fromMs: BASE_TIME, toMs: BASE_TIME + 1_000 };

    await expect(
      opened.repository.scan({
        ...range,
        limit: 10,
        filters: {
          actualServiceTier: ['priority'],
          stateId: ['state-1'],
          personaId: ['persona-1'],
          inputMeasurementProvenance: ['reported_exact'],
          outputMeasurementProvenance: ['reported_exact'],
          thinkingMeasurementProvenance: ['reported_exact'],
          nonThinkingMeasurementProvenance: ['derived_exact'],
        },
      }),
    ).resolves.toMatchObject([{ exchangeId: 'exchange-query-facts' }]);
    await expect(
      opened.repository.scan({ ...range, limit: 10, filters: { actualServiceTier: ['standard'] } }),
    ).resolves.toEqual([]);

    const expectedDimensions = [
      ['actualServiceTier', 'priority'],
      ['stateId', 'state-1'],
      ['personaId', 'persona-1'],
      ['inputMeasurementProvenance', 'reported_exact'],
      ['outputMeasurementProvenance', 'reported_exact'],
      ['thinkingMeasurementProvenance', 'reported_exact'],
      ['nonThinkingMeasurementProvenance', 'derived_exact'],
    ] as const;
    for (const [dimension, value] of expectedDimensions) {
      await expect(opened.repository.dimensionValues(dimension, { ...range, limit: 10 })).resolves.toEqual([
        { value, count: 1 },
      ]);
    }
    await expect(opened.repository.dimensionValues('streaming', { ...range, limit: 10 })).resolves.toEqual([
      { value: true, count: 1 },
    ]);
    await expect(opened.repository.dimensionValues('refusal', { ...range, limit: 10 })).resolves.toEqual([
      { value: false, count: 1 },
    ]);
    await expect(
      opened.repository.scan({ ...range, limit: 10, filters: { streaming: [true], refusal: [false] } }),
    ).resolves.toMatchObject([{ exchangeId: 'exchange-query-facts' }]);

    const service = new LlmStatisticsQueryService(opened.repository);
    await expect(
      service.summarize({
        ...range,
        measures: ['requestCount'],
        groupBy: ['actualServiceTier', 'inputMeasurementProvenance', 'outputMeasurementProvenance'],
      }),
    ).resolves.toMatchObject([
      {
        dimensions: {
          actualServiceTier: 'priority',
          inputMeasurementProvenance: 'reported_exact',
          outputMeasurementProvenance: 'reported_exact',
        },
        value: 1,
      },
    ]);
    await expect(
      service.summarize({
        ...range,
        measures: ['requestCount'],
        groupBy: ['thinkingMeasurementProvenance', 'nonThinkingMeasurementProvenance'],
      }),
    ).resolves.toMatchObject([
      {
        dimensions: {
          thinkingMeasurementProvenance: 'reported_exact',
          nonThinkingMeasurementProvenance: 'derived_exact',
        },
        value: 1,
      },
    ]);
    await opened.repository.close();
  });

  it('rejects hostile SQLite query inputs without changing query structure or storage', async () => {
    let readerWorkers = 0;
    const opened = await repository({
      readWorkerFactory: (url, options) => {
        readerWorkers++;
        return defaultWorkerFactory(url, options);
      },
    });
    opened.repository.enqueue(exchange('exchange-safe-query'));
    const providerRecord = exchange('exchange-parameterized-provider');
    opened.repository.enqueue({
      ...providerRecord,
      identity: {
        ...providerRecord.identity,
        servedProvider: { value: 'Google (SELECT FROM) & Co', source: 'router_metadata' },
      },
    });
    await opened.repository.flush();
    const range = { fromMs: BASE_TIME, toMs: BASE_TIME + 1_000, limit: 10 };

    await expect(
      opened.repository.scan({
        ...range,
        filters: { servedProvider: ['Google (SELECT FROM) & Co'] },
      }),
    ).resolves.toMatchObject([{ exchangeId: 'exchange-parameterized-provider' }]);

    await expect(
      opened.repository.scan({
        ...range,
        filters: { servedModel: ["served-model' OR 1=1 --"] },
      }),
    ).rejects.toThrow(/Invalid servedModel filter/);
    await expect(
      opened.repository.scan({
        ...range,
        filters: { ['served_model) OR 1=1; DROP TABLE llm_exchanges; --']: ['served-model'] } as never,
      }),
    ).rejects.toThrow(/Invalid statistics filter/);
    await expect(
      opened.repository.dimensionValues('served_model) FROM llm_exchanges; --' as never, range),
    ).rejects.toThrow(/Invalid statistics dimension/);

    await expect(opened.repository.scan(range)).resolves.toHaveLength(2);
    expect(readerWorkers).toBe(1);
    expect(opened.repository.health()).toMatchObject({ readerState: 'ready', readerLastError: null });
    await opened.repository.close();

    const database = new DatabaseSync(opened.databasePath, { readOnly: true });
    expect(database.prepare('SELECT COUNT(*) AS count FROM llm_exchanges').get()).toMatchObject({ count: 2 });
    database.close();
  });

  it('rejects response and attempt HTTP statuses outside 100 through 599', async () => {
    const invalidRecords: LlmExchangeCompleted[] = [];
    const response = exchange('invalid-response-status');
    invalidRecords.push({ ...response, outcome: { ...response.outcome, responseStatus: 99 } });
    const transport = exchange('invalid-transport-status');
    invalidRecords.push({
      ...transport,
      transportAttempts: [{ ...transport.transportAttempts[0], responseStatus: 600 }],
    });
    const gateway = exchange('invalid-gateway-status');
    invalidRecords.push({
      ...gateway,
      gatewayRouteAttempts: [{ ...gateway.gatewayRouteAttempts[0], status: 700 }],
    });

    for (const record of invalidRecords) {
      const opened = await repository();
      opened.repository.enqueue(record);
      await opened.repository.flush();
      expect(opened.repository.health()).toMatchObject({
        state: 'degraded',
        persisted: 0,
        dropped: 1,
        lastError: expect.stringMatching(/Invalid .*status/i),
      });
      await opened.repository.close();
    }
  });

  it('drops only the invalid record of a full batch and counts it by reason', async () => {
    const opened = await repository();
    for (let index = 0; index < 63; index++) {
      opened.repository.enqueue(exchange(`exchange-valid-${index}`, { startedAtMs: BASE_TIME + index }));
    }
    const invalid = exchange('exchange-status-999', { startedAtMs: BASE_TIME + 63 });
    opened.repository.enqueue({ ...invalid, outcome: { ...invalid.outcome, responseStatus: 999 } });
    await opened.repository.flush();

    expect(opened.repository.health()).toMatchObject({
      state: 'degraded',
      persisted: 63,
      dropped: 1,
      queuedRecords: 0,
      invalidByReason: { 'Invalid responseStatus': 1 },
      lastError: expect.stringMatching(/Dropped 1 invalid statistics record\(s\): Invalid responseStatus/),
    });
    const rows = await opened.repository.scan({ fromMs: BASE_TIME, toMs: BASE_TIME + 1_000, limit: 100 });
    expect(rows).toHaveLength(63);
    expect(rows.some((row) => row.exchangeId === 'exchange-status-999')).toBe(false);

    opened.repository.enqueue(exchange('exchange-after-invalid', { startedAtMs: BASE_TIME + 64 }));
    await opened.repository.flush();
    expect(opened.repository.health()).toMatchObject({ state: 'ready', persisted: 64, lastError: null });
    await opened.repository.close();
  });

  it('rolls back only the record whose rows violate a constraint', async () => {
    const opened = await repository();
    const conflicting = exchange('exchange-duplicate-ordinals', { startedAtMs: BASE_TIME + 1 });
    const attempt = conflicting.transportAttempts.at(0);
    if (attempt === undefined) throw new Error('fixture has a transport attempt');
    opened.repository.enqueue(exchange('exchange-before'));
    opened.repository.enqueue({ ...conflicting, transportAttempts: [attempt, attempt] });
    opened.repository.enqueue(exchange('exchange-after', { startedAtMs: BASE_TIME + 2 }));
    await opened.repository.flush();

    const health = opened.repository.health();
    expect(health).toMatchObject({ state: 'degraded', persisted: 2, dropped: 1 });
    expect(Object.entries(health.invalidByReason)).toEqual([
      [expect.stringMatching(/UNIQUE constraint failed: llm_transport_attempts/), 1],
    ]);
    await opened.repository.close();

    const database = new DatabaseSync(opened.databasePath, { readOnly: true });
    expect(
      database
        .prepare('SELECT exchange_id AS exchangeId FROM llm_exchanges ORDER BY exchange_id')
        .all()
        .map((row) => row.exchangeId),
    ).toEqual(['exchange-after', 'exchange-before']);
    expect(database.prepare('SELECT COUNT(*) AS count FROM llm_transport_attempts').get()).toMatchObject({ count: 2 });
    database.close();
  });

  it('requeues a batch that stays busy beyond the worker retries and writes it once the lock clears', async () => {
    const opened = await repository({ busyRetryDelayMs: 60_000, logSink: () => {} });
    const lock = new DatabaseSync(opened.databasePath);
    lock.exec('BEGIN IMMEDIATE');
    try {
      opened.repository.enqueue(exchange('exchange-during-lock'));
      await opened.repository.flush();
      expect(opened.repository.health()).toMatchObject({
        state: 'degraded',
        persisted: 0,
        dropped: 0,
        queuedRecords: 1,
        lastError: expect.stringMatching(/locked/),
      });
    } finally {
      lock.exec('COMMIT');
      lock.close();
    }

    await opened.repository.flush();
    expect(opened.repository.health()).toMatchObject({ state: 'ready', persisted: 1, dropped: 0, queuedRecords: 0 });
    await opened.repository.close();
  });

  it('drops a busy record after its bounded write attempts without growing the queue', async () => {
    let inserts = 0;
    const opened = await repository({
      busyRetryDelayMs: 1,
      maxQueuedRecords: 2,
      logSink: () => {},
      workerFactory: () => {
        const worker = new Worker(
          `const { parentPort } = require('node:worker_threads');
           parentPort.postMessage({ kind: 'ready', schemaVersion: 1 });
           parentPort.on('message', (request) => {
             if (request.kind === 'insert') {
               parentPort.postMessage({ kind: 'error', id: request.id, message: 'database is locked', code: 'busy' });
             } else {
               parentPort.postMessage({ kind: 'result', id: request.id, value: null });
             }
           });`,
          { eval: true },
        );
        const post = worker.postMessage.bind(worker);
        worker.postMessage = (message: { readonly kind?: string }) => {
          if (message.kind === 'insert') inserts++;
          post(message);
        };
        return worker;
      },
    });
    expect(opened.repository.enqueue(exchange('exchange-always-busy'))).toBe(true);
    expect(opened.repository.enqueue(exchange('exchange-also-busy', { startedAtMs: BASE_TIME + 1 }))).toBe(true);
    await opened.repository.flush();
    expect(opened.repository.health()).toMatchObject({
      state: 'degraded',
      dropped: 0,
      queuedRecords: 2,
      lastError: expect.stringMatching(/locked/),
    });
    // The requeued batch still counts toward the queue bound.
    expect(opened.repository.enqueue(exchange('exchange-over-bound', { startedAtMs: BASE_TIME + 2 }))).toBe(false);

    await vi.waitFor(() => expect(opened.repository.health()).toMatchObject({ dropped: 3, queuedRecords: 0 }), {
      timeout: 10_000,
      interval: 10,
    });
    // One record over the bound, and the batch of two dropped after five attempts.
    expect(inserts).toBe(5);
    expect(opened.repository.health()).toMatchObject({ persisted: 0, enqueued: 2 });
    await opened.repository.close();
  });

  it('records the compatibility range of the schema it creates', async () => {
    const opened = await repository();
    await opened.repository.close();
    const database = new DatabaseSync(opened.databasePath, { readOnly: true });
    expect(database.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: LLM_METRICS_SCHEMA_VERSION });
    // Every migration so far is additive (schema 2 only adds nullable cost columns).
    expect(database.prepare('SELECT key, value FROM llm_metrics_meta ORDER BY key').all()).toEqual([
      { key: 'min_reader_schema', value: 1 },
      { key: 'min_writer_schema', value: 1 },
    ]);
    database.close();
  });

  it('records the compatibility range when it upgrades a database migrated before ranges existed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ironcurtain-llm-metrics-legacy-'));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, 'llm-usage.sqlite3');
    // A schema-1 database as a binary without the range contract left it: no llm_metrics_meta.
    const legacy = new DatabaseSync(databasePath);
    expect(migrateLlmMetricsDatabase(legacy, 1)).toBe(1);
    legacy.exec('DROP TABLE llm_metrics_meta');
    legacy.close();

    const upgraded = await SqliteLlmMetricsRepository.open({ databasePath, flushIntervalMs: 60_000 });
    expect(upgraded.health()).toMatchObject({ state: 'ready', schemaVersion: LLM_METRICS_SCHEMA_VERSION });
    await upgraded.close();

    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: LLM_METRICS_SCHEMA_VERSION });
    expect(database.prepare('SELECT key, value FROM llm_metrics_meta ORDER BY key').all()).toEqual([
      { key: 'min_reader_schema', value: 1 },
      { key: 'min_writer_schema', value: 1 },
    ]);
    database.close();
  });

  /** The schema a newer binary would migrate to; this binary supports LLM_METRICS_SCHEMA_VERSION. */
  const NEXT_SCHEMA_VERSION = LLM_METRICS_SCHEMA_VERSION + 1;

  function migrateToNextSchema(
    databasePath: string,
    compatibility: { readonly minWriterSchema: number; readonly minReaderSchema: number },
  ): void {
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE llm_exchanges ADD COLUMN future_annotation TEXT;
        CREATE TABLE IF NOT EXISTS llm_metrics_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL) STRICT;
        INSERT INTO llm_metrics_meta (key, value)
          VALUES ('min_writer_schema', ${compatibility.minWriterSchema}),
                 ('min_reader_schema', ${compatibility.minReaderSchema})
          ON CONFLICT (key) DO UPDATE SET value = excluded.value;
        PRAGMA user_version = ${NEXT_SCHEMA_VERSION};
        COMMIT;
      `);
    } finally {
      database.close();
    }
  }

  it('accepts an additive newer schema whose range admits this writer and reader', async () => {
    const seeded = await repository();
    seeded.repository.enqueue(exchange('exchange-before-upgrade'));
    await seeded.repository.close();
    migrateToNextSchema(seeded.databasePath, {
      minWriterSchema: LLM_METRICS_SCHEMA_VERSION,
      minReaderSchema: LLM_METRICS_SCHEMA_VERSION,
    });

    const older = await SqliteLlmMetricsRepository.open({ databasePath: seeded.databasePath, flushIntervalMs: 60_000 });
    expect(older.health()).toMatchObject({ state: 'ready', schemaVersion: NEXT_SCHEMA_VERSION });
    older.enqueue(exchange('exchange-by-older-writer', { startedAtMs: BASE_TIME + 1 }));
    await older.flush();
    expect(older.health()).toMatchObject({ state: 'ready', persisted: 1, dropped: 0 });
    const rows = await older.scan({ fromMs: BASE_TIME, toMs: BASE_TIME + 1_000, limit: 10 });
    expect(rows.map((row) => row.exchangeId).sort()).toEqual(['exchange-before-upgrade', 'exchange-by-older-writer']);
    await older.close();

    const database = new DatabaseSync(seeded.databasePath, { readOnly: true });
    expect(database.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: NEXT_SCHEMA_VERSION });
    expect(
      database
        .prepare(
          "SELECT future_annotation AS annotation FROM llm_exchanges WHERE exchange_id = 'exchange-by-older-writer'",
        )
        .get(),
    ).toEqual({ annotation: null });
    database.close();
  });

  it('keeps writing when another process applies an additive migration mid-run', async () => {
    const opened = await repository();
    opened.repository.enqueue(exchange('exchange-before-upgrade'));
    await opened.repository.flush();
    migrateToNextSchema(opened.databasePath, {
      minWriterSchema: LLM_METRICS_SCHEMA_VERSION,
      minReaderSchema: LLM_METRICS_SCHEMA_VERSION,
    });

    opened.repository.enqueue(exchange('exchange-after-upgrade', { startedAtMs: BASE_TIME + 1 }));
    await opened.repository.flush();
    expect(opened.repository.health()).toMatchObject({ state: 'ready', persisted: 2, dropped: 0 });
    await opened.repository.close();
  });

  it('refuses a newer schema whose range excludes this writer, per role, without rewriting it', async () => {
    const seeded = await repository();
    seeded.repository.enqueue(exchange('exchange-before-breaking-upgrade'));
    await seeded.repository.close();
    migrateToNextSchema(seeded.databasePath, {
      minWriterSchema: NEXT_SCHEMA_VERSION,
      minReaderSchema: LLM_METRICS_SCHEMA_VERSION,
    });

    let writers = 0;
    const older = await SqliteLlmMetricsRepository.open({
      databasePath: seeded.databasePath,
      restartDelayMs: 1,
      logSink: () => {},
      workerFactory: (url, options) => {
        writers++;
        return defaultWorkerFactory(url, options);
      },
    });
    expect(older.health()).toMatchObject({
      state: 'disabled',
      schemaVersion: null,
      lastError: expect.stringContaining(
        `schema ${NEXT_SCHEMA_VERSION} requires writer schema ${NEXT_SCHEMA_VERSION} or newer`,
      ),
    });
    expect(older.enqueue(exchange('exchange-refused'))).toBe(false);
    // The reader range still admits this binary.
    await expect(older.scan({ fromMs: BASE_TIME, toMs: BASE_TIME + 1_000, limit: 10 })).resolves.toMatchObject([
      { exchangeId: 'exchange-before-breaking-upgrade' },
    ]);
    await delay(50);
    expect(writers).toBe(1);
    await older.close();

    const database = new DatabaseSync(seeded.databasePath, { readOnly: true });
    expect(database.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: NEXT_SCHEMA_VERSION });
    expect(database.prepare("SELECT value FROM llm_metrics_meta WHERE key = 'min_writer_schema'").get()).toEqual({
      value: NEXT_SCHEMA_VERSION,
    });
    database.close();
  });

  it('latches off when another process applies a breaking migration mid-run', async () => {
    const opened = await repository({ logSink: () => {} });
    opened.repository.enqueue(exchange('exchange-before-breaking-upgrade'));
    await opened.repository.flush();
    migrateToNextSchema(opened.databasePath, {
      minWriterSchema: NEXT_SCHEMA_VERSION,
      minReaderSchema: NEXT_SCHEMA_VERSION,
    });

    opened.repository.enqueue(exchange('exchange-after-breaking-upgrade', { startedAtMs: BASE_TIME + 1 }));
    await opened.repository.flush();
    expect(opened.repository.health()).toMatchObject({
      state: 'disabled',
      persisted: 1,
      dropped: 1,
      queuedRecords: 0,
      lastError: expect.stringContaining(`requires writer schema ${NEXT_SCHEMA_VERSION}`),
    });
    await expect(opened.repository.scan({ fromMs: BASE_TIME, toMs: BASE_TIME + 1_000, limit: 10 })).rejects.toThrow(
      `requires reader schema ${NEXT_SCHEMA_VERSION}`,
    );
    await opened.repository.close();
  });

  it('persists bounded OpenRouter provider labels and the full adapter attempt cap', async () => {
    const opened = await repository();
    const provider = 'Google AI Studio';
    const gatewayRouteAttempts = Array.from({ length: 64 }, (_, index) => ({
      ordinal: index + 1,
      provider,
      model: `google/gemini-${index + 1}`,
      status: 200,
      selected: index === 63,
      source: 'router_metadata' as const,
    }));
    const base = exchange('exchange-openrouter-provider');
    const record: LlmExchangeCompleted = {
      ...base,
      identity: { ...base.identity, servedProvider: { value: provider, source: 'router_metadata' } },
      gatewayRouteAttempts,
    };

    expect(opened.repository.enqueue(record)).toBe(true);
    await opened.repository.flush();
    expect(opened.repository.health()).toMatchObject({ persisted: 1, dropped: 0, state: 'ready' });
    const rows = await opened.repository.scan({ fromMs: BASE_TIME, toMs: BASE_TIME + 1_000, limit: 10 });
    expect(rows[0]).toMatchObject({ servedProvider: provider, servedModel: 'served-model' });

    await opened.repository.close();
    const database = new DatabaseSync(opened.databasePath, { readOnly: true });
    expect(database.prepare('SELECT COUNT(*) AS count FROM llm_gateway_route_attempts').get()).toMatchObject({
      count: 64,
    });
    database.close();
  });

  it.each([
    { caseName: 'content-shaped', provider: 'provider\nsecret' },
    { caseName: 'overlong', provider: 'p'.repeat(129) },
  ])('rejects $caseName provider labels at the durable boundary', async ({ provider }) => {
    const opened = await repository();
    const base = exchange('exchange-invalid-provider');
    const record: LlmExchangeCompleted = {
      ...base,
      identity: {
        ...base.identity,
        servedProvider: { value: provider, source: 'router_metadata' },
      },
    };

    expect(opened.repository.enqueue(record)).toBe(true);
    await opened.repository.flush();
    expect(opened.repository.health()).toMatchObject({
      persisted: 0,
      dropped: 1,
      state: 'degraded',
      lastError: expect.stringMatching(/Invalid servedProvider/),
    });
    await opened.repository.close();
  });

  it('keeps fractional monotonic timings while using an integer completion index', async () => {
    const opened = await repository();
    opened.repository.enqueue(exchange('exchange-fractional-timing', { clientDeliveryEndOffsetMs: 180.75 }));
    await opened.repository.flush();

    const rows = await opened.repository.scan({ fromMs: BASE_TIME, toMs: BASE_TIME + 1_000, limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      completedAtMs: BASE_TIME + 181,
      clientDeliveryEndOffsetMs: 180.75,
    });
    await opened.repository.close();
  });

  it('keeps pagination snapshots stable while newer rows are inserted', async () => {
    const opened = await repository();
    opened.repository.enqueue(exchange('exchange-1'));
    await opened.repository.flush();
    const snapshotMaxSequence = await opened.repository.snapshotMaxSequence();

    opened.repository.enqueue(exchange('exchange-2', { startedAtMs: BASE_TIME + 100 }));
    await opened.repository.flush();
    const snapshotRows = await opened.repository.scan({
      fromMs: BASE_TIME,
      toMs: BASE_TIME + 1_000,
      limit: 10,
      snapshotMaxSequence,
    });
    expect(snapshotRows.map((row) => row.exchangeId)).toEqual(['exchange-1']);
    await opened.repository.close();
  });

  it('deletes in bounded chunks and cascades child attempts', async () => {
    const opened = await repository();
    for (let index = 0; index < 5; index++) {
      opened.repository.enqueue(exchange(`exchange-old-${index}`, { startedAtMs: BASE_TIME + index }));
    }
    opened.repository.enqueue(exchange('exchange-new', { startedAtMs: BASE_TIME + 2_000 }));
    await opened.repository.flush();

    const cutoffMs = BASE_TIME + 1_000;
    const first = await opened.repository.deleteBefore(cutoffMs, {
      chunkSize: 2,
      maxRows: 3,
      maxDurationMs: 5_000,
      leaseDurationMs: 5_000,
    });
    expect(first).toMatchObject({
      status: 'partial',
      cutoffMs,
      deletedCount: 3,
      chunksProcessed: 2,
      snapshotMaxSequence: expect.any(Number),
    });
    if (first.snapshotMaxSequence === null) throw new Error('Expected a retention snapshot');
    opened.repository.enqueue(exchange('exchange-late-old'));
    await opened.repository.flush();

    const second = await opened.repository.deleteBefore(cutoffMs, {
      snapshotMaxSequence: first.snapshotMaxSequence,
      chunkSize: 2,
      maxRows: 10,
      maxDurationMs: 5_000,
      leaseDurationMs: 5_000,
    });
    expect(second).toMatchObject({ status: 'complete', cutoffMs, deletedCount: 2, chunksProcessed: 1 });

    const rows = await opened.repository.scan({ fromMs: BASE_TIME, toMs: BASE_TIME + 3_000, limit: 10 });
    expect(rows.map((row) => row.exchangeId).sort()).toEqual(['exchange-late-old', 'exchange-new']);
    const database = new DatabaseSync(opened.databasePath, { readOnly: true });
    expect(database.prepare('SELECT COUNT(*) AS count FROM llm_transport_attempts').get()).toMatchObject({ count: 2 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM llm_gateway_route_attempts').get()).toMatchObject({
      count: 2,
    });
    database.close();
    await opened.repository.close();
  });

  it('prunes bounded orphaned retention metadata', async () => {
    const opened = await repository();
    const database = new DatabaseSync(opened.databasePath);
    const insertRun = database.prepare(
      `INSERT INTO llm_process_runs (
         process_run_id, started_at_ms, last_checkpoint_at_ms,
         observed_count, finalized_count, enqueued_count, clean_ended_at_ms
       ) VALUES (?, 1, 2, 0, 0, 0, 3)`,
    );
    insertRun.run('orphaned-run');
    database
      .prepare(
        `INSERT INTO llm_maintenance_leases (lease_name, owner_id, expires_at_ms)
         VALUES ('expired-lease', 'old-owner', 1)`,
      )
      .run();
    database.close();

    await expect(opened.repository.deleteBefore(BASE_TIME)).resolves.toMatchObject({ status: 'complete' });

    const verification = new DatabaseSync(opened.databasePath, { readOnly: true });
    expect(
      verification
        .prepare("SELECT COUNT(*) AS count FROM llm_process_runs WHERE process_run_id = 'orphaned-run'")
        .get(),
    ).toMatchObject({ count: 0 });
    expect(
      verification
        .prepare("SELECT COUNT(*) AS count FROM llm_maintenance_leases WHERE lease_name = 'expired-lease'")
        .get(),
    ).toMatchObject({ count: 0 });
    verification.close();
    await opened.repository.close();
  });

  it('indexes exchanges by process run for bounded metadata pruning', async () => {
    const opened = await repository();
    await opened.repository.close();

    const database = new DatabaseSync(opened.databasePath, { readOnly: true });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM pragma_index_list('llm_exchanges') WHERE name = ?")
        .get('llm_exchanges_process_run_idx'),
    ).toMatchObject({ count: 1 });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'llm_metrics_gaps'").get(),
    ).toMatchObject({ count: 0 });
    database.close();
  });

  it('uses a stable deletion snapshot and a cross-process lease while writers continue', async () => {
    const opened = await repository({ processRunId: 'retention-owner-a' });
    const secondRepository = await SqliteLlmMetricsRepository.open({
      databasePath: opened.databasePath,
      processRunId: 'retention-owner-b',
      flushIntervalMs: 60_000,
    });
    try {
      for (let index = 0; index < 128; index++) {
        opened.repository.enqueue(exchange(`exchange-seeded-${index}`, { startedAtMs: BASE_TIME + index }));
      }
      await opened.repository.flush();

      const cutoffMs = BASE_TIME + 1_000;
      const deletion = opened.repository.deleteBefore(cutoffMs, {
        chunkSize: 1,
        maxRows: 128,
        maxDurationMs: 30_000,
        leaseDurationMs: 30_000,
      });
      await waitForMaintenanceLease(opened.databasePath);

      await expect(
        secondRepository.deleteBefore(cutoffMs, {
          chunkSize: 1,
          maxRows: 128,
          maxDurationMs: 5_000,
          leaseDurationMs: 5_000,
        }),
      ).resolves.toMatchObject({ status: 'busy', deletedCount: 0, chunksProcessed: 0 });
      expect(secondRepository.health().state).toBe('ready');

      expect(secondRepository.enqueue(exchange('exchange-late-old'))).toBe(true);
      expect(secondRepository.enqueue(exchange('exchange-newer', { startedAtMs: BASE_TIME + 2_000 }))).toBe(true);
      await secondRepository.flush();

      await expect(deletion).resolves.toMatchObject({
        status: 'complete',
        cutoffMs,
        deletedCount: 128,
        chunksProcessed: 128,
      });
      const survivors = await secondRepository.scan({ fromMs: BASE_TIME, toMs: BASE_TIME + 3_000, limit: 10 });
      expect(survivors.map((row) => row.exchangeId).sort()).toEqual(['exchange-late-old', 'exchange-newer']);

      const database = new DatabaseSync(opened.databasePath, { readOnly: true });
      expect(database.prepare('SELECT COUNT(*) AS count FROM llm_transport_attempts').get()).toMatchObject({
        count: 2,
      });
      expect(database.prepare('SELECT COUNT(*) AS count FROM llm_gateway_route_attempts').get()).toMatchObject({
        count: 2,
      });
      database.close();
    } finally {
      await Promise.all([opened.repository.close(), secondRepository.close()]);
    }
  });

  it('strictly bounds retention management inputs', async () => {
    const opened = await repository();
    await expect(opened.repository.deleteBefore(-1)).rejects.toThrow(/Invalid delete cutoff/);
    await expect(opened.repository.deleteBefore(BASE_TIME, { chunkSize: 1_001 })).rejects.toThrow(
      /Invalid delete chunkSize/,
    );
    await expect(opened.repository.deleteBefore(BASE_TIME, { snapshotMaxSequence: -1 })).rejects.toThrow(
      /Invalid delete snapshotMaxSequence/,
    );
    await expect(opened.repository.deleteBefore(BASE_TIME, { maxRows: 100_001 })).rejects.toThrow(
      /Invalid delete maxRows/,
    );
    await expect(opened.repository.deleteBefore(BASE_TIME, { maxDurationMs: 30_001 })).rejects.toThrow(
      /Invalid delete maxDurationMs/,
    );
    await expect(
      opened.repository.deleteBefore(BASE_TIME, { maxDurationMs: 1_000, leaseDurationMs: 999 }),
    ).rejects.toThrow(/must cover maxDurationMs/);
    expect(opened.repository.health().state).toBe('ready');
    await opened.repository.close();
  });

  it('isolates a stalled reader from writer flushes and restarts reads lazily', async () => {
    let readerWorkers = 0;
    const opened = await repository({
      readTimeoutMs: 50,
      readWorkerFactory: (url, options) => {
        readerWorkers++;
        if (readerWorkers === 1) {
          return new Worker(
            `const { parentPort } = require('node:worker_threads');
             parentPort.postMessage({ kind: 'ready', schemaVersion: 1 });
             parentPort.on('message', () => {});`,
            { eval: true },
          );
        }
        return defaultWorkerFactory(url, options);
      },
    });

    expect(readerWorkers).toBe(0);
    const stalledRead = opened.repository.scan({ fromMs: BASE_TIME, toMs: BASE_TIME + 1_000, limit: 10 });
    await delay(10);
    expect(opened.repository.enqueue(exchange('exchange-during-stalled-read'))).toBe(true);
    await expect(opened.repository.flush()).resolves.toBeUndefined();
    expect(opened.repository.health()).toMatchObject({ state: 'ready', persisted: 1, dropped: 0 });
    await expect(stalledRead).rejects.toBeInstanceOf(LlmMetricsRepositoryUnavailableError);
    await expect(stalledRead).rejects.toThrow(/reader request timed out/);

    await expect(
      opened.repository.scan({ fromMs: BASE_TIME, toMs: BASE_TIME + 1_000, limit: 10 }),
    ).resolves.toMatchObject([{ exchangeId: 'exchange-during-stalled-read' }]);
    expect(readerWorkers).toBe(2);
    await opened.repository.close();
  });

  it('times each read from when the worker serves it, not while it waits behind earlier reads', async () => {
    // Each read takes 40 ms; twelve together take about 480 ms, more than
    // twice the 200 ms per-read deadline. Only time being served counts.
    let readerWorkers = 0;
    const opened = await repository({
      readTimeoutMs: 200,
      readWorkerFactory: () => {
        readerWorkers++;
        return new Worker(
          `const { parentPort } = require('node:worker_threads');
           let chain = Promise.resolve();
           parentPort.postMessage({ kind: 'ready', schemaVersion: 1 });
           parentPort.on('message', (request) => {
             chain = chain.then(() => new Promise((resolve) => setTimeout(() => {
               parentPort.postMessage({ kind: 'result', id: request.id, value: [] });
               resolve();
             }, 40)));
           });`,
          { eval: true },
        );
      },
    });
    const query = { fromMs: BASE_TIME, toMs: BASE_TIME + 1_000, limit: 10 };

    const reads = await Promise.allSettled(Array.from({ length: 12 }, () => opened.repository.scan(query)));

    expect(reads.map((read) => read.status)).toEqual(Array.from({ length: 12 }, () => 'fulfilled'));
    expect(readerWorkers).toBe(1);
    expect(opened.repository.health()).toMatchObject({ readerState: 'ready', readerLastError: null });
    await opened.repository.close();
  });

  it('retires a reader after an operational failure without disabling writes', async () => {
    let readerWorkers = 0;
    const opened = await repository({
      readWorkerFactory: (url, options) => {
        readerWorkers++;
        if (readerWorkers === 1) {
          return new Worker(
            `const { parentPort } = require('node:worker_threads');
             parentPort.postMessage({ kind: 'ready', schemaVersion: 1 });
             parentPort.on('message', (request) => parentPort.postMessage({
               kind: 'error', id: request.id, message: 'simulated SQLite I/O failure', category: 'unavailable'
             }));`,
            { eval: true },
          );
        }
        return defaultWorkerFactory(url, options);
      },
    });
    const query = { fromMs: BASE_TIME, toMs: BASE_TIME + 1_000, limit: 10 };

    await expect(opened.repository.scan(query)).rejects.toBeInstanceOf(LlmMetricsRepositoryUnavailableError);
    await expect(new LlmStatisticsQueryService(opened.repository).capabilities()).resolves.toMatchObject({
      available: false,
      health: { readerState: 'unavailable', readerLastError: expect.stringMatching(/I\/O failure/) },
    });
    expect(opened.repository.enqueue(exchange('exchange-after-reader-failure'))).toBe(true);
    await expect(opened.repository.flush()).resolves.toBeUndefined();
    await expect(opened.repository.scan(query)).resolves.toMatchObject([
      { exchangeId: 'exchange-after-reader-failure' },
    ]);
    expect(readerWorkers).toBe(2);
    expect(opened.repository.health()).toMatchObject({ state: 'ready', persisted: 1, dropped: 0 });
    await expect(new LlmStatisticsQueryService(opened.repository).capabilities()).resolves.toMatchObject({
      available: true,
      health: { readerState: 'ready', readerLastError: null },
    });
    await opened.repository.close();
  });

  it('bounds reader admissions while its worker is stalled', async () => {
    const opened = await repository({
      readTimeoutMs: 50,
      readWorkerFactory: () =>
        new Worker(
          `const { parentPort } = require('node:worker_threads');
           parentPort.postMessage({ kind: 'ready', schemaVersion: 1 });
           parentPort.on('message', () => {});`,
          { eval: true },
        ),
    });
    const query = { fromMs: BASE_TIME, toMs: BASE_TIME + 1_000, limit: 10 };
    const admitted = Array.from({ length: 64 }, () => opened.repository.scan(query));
    const settlements = Promise.allSettled(admitted);

    await expect(opened.repository.scan(query)).rejects.toThrow(/reader request limit reached/);
    expect((await settlements).every((result) => result.status === 'rejected')).toBe(true);
    expect(opened.repository.health()).toMatchObject({ state: 'ready', dropped: 0 });
    await opened.repository.close();
  });

  it('keeps timed-out retention single-flight until its late lease cleanup settles', async () => {
    const opened = await repository({
      workerFactory: () =>
        new Worker(
          `const { parentPort } = require('node:worker_threads');
           let firstDelete = true;
           let leaseHeld = false;
           let chain = Promise.resolve();
           parentPort.postMessage({ kind: 'ready', schemaVersion: 1 });
           parentPort.on('message', (request) => {
             chain = chain.then(async () => {
               let value = null;
               if (request.kind === 'beginDeleteBefore') {
                 if (firstDelete) {
                   firstDelete = false;
                   await new Promise((resolve) => setTimeout(resolve, 75));
                 }
                 if (leaseHeld) value = { acquired: false, snapshotMaxSequence: null };
                 else {
                   leaseHeld = true;
                   value = { acquired: true, snapshotMaxSequence: null };
                 }
               } else if (request.kind === 'releaseMaintenanceLease') {
                 leaseHeld = false;
               } else if (request.kind === 'insert') {
                 value = { inserted: request.exchanges.length, duplicates: 0, rejected: {} };
               }
               parentPort.postMessage({ kind: 'result', id: request.id, value });
             });
           });`,
          { eval: true },
        ),
    });

    const deletion = opened.repository.deleteBefore(BASE_TIME, {
      maxDurationMs: 20,
      leaseDurationMs: 100,
    });
    const enqueueStartedAt = performance.now();
    expect(opened.repository.enqueue(exchange('exchange-during-retention'))).toBe(true);
    expect(performance.now() - enqueueStartedAt).toBeLessThan(100);
    await expect(deletion).rejects.toThrow(/lease acquisition timed out/);
    expect(opened.repository.health()).toMatchObject({
      state: 'degraded',
      dropped: 0,
      queuedRecords: 1,
      lastError: expect.stringMatching(/lease acquisition timed out/),
    });

    await expect(
      opened.repository.deleteBefore(BASE_TIME, { maxDurationMs: 20, leaseDurationMs: 100 }),
    ).resolves.toMatchObject({ status: 'busy' });
    await delay(100);
    await expect(
      opened.repository.deleteBefore(BASE_TIME, { maxDurationMs: 20, leaseDurationMs: 100 }),
    ).resolves.toMatchObject({ status: 'complete' });
    await expect(opened.repository.flush()).resolves.toBeUndefined();
    expect(opened.repository.health()).toMatchObject({ state: 'ready', persisted: 1, dropped: 0, queuedRecords: 0 });
    await opened.repository.close();
  });

  it('preserves degraded health when retention lease release fails', async () => {
    const opened = await repository({
      workerFactory: () =>
        new Worker(
          `const { parentPort } = require('node:worker_threads');
           parentPort.postMessage({ kind: 'ready', schemaVersion: 1 });
           parentPort.on('message', (request) => {
             if (request.kind === 'beginDeleteBefore') {
               parentPort.postMessage({
                 kind: 'result', id: request.id, value: { acquired: true, snapshotMaxSequence: null }
               });
             } else if (request.kind === 'releaseMaintenanceLease') {
               parentPort.postMessage({ kind: 'error', id: request.id, message: 'simulated lease release failure' });
             } else {
               parentPort.postMessage({ kind: 'result', id: request.id, value: null });
             }
           });`,
          { eval: true },
        ),
    });

    await expect(opened.repository.deleteBefore(BASE_TIME)).resolves.toMatchObject({ status: 'complete' });
    expect(opened.repository.health()).toMatchObject({
      state: 'degraded',
      lastError: expect.stringMatching(/lease release failure/),
    });
    await opened.repository.close();
  });

  // Previously pinned a terminal 'disabled' latch for any writer failure; a
  // wedged writer is now replaced while the reader keeps serving.
  it('keeps the independent reader usable while a wedged writer restarts', async () => {
    const seeded = await repository();
    seeded.repository.enqueue(exchange('exchange-before-writer-failure'));
    await seeded.repository.flush();
    await seeded.repository.close();

    const repositoryWithFailedWriter = await SqliteLlmMetricsRepository.open({
      databasePath: seeded.databasePath,
      flushIntervalMs: 60_000,
      writeTimeoutMs: 30,
      closeTimeoutMs: 30,
      restartDelayMs: 60_000,
      logSink: () => {},
      workerFactory: () =>
        new Worker(
          `const { parentPort } = require('node:worker_threads');
           parentPort.postMessage({ kind: 'ready', schemaVersion: 1 });
           parentPort.on('message', () => {});`,
          { eval: true },
        ),
    });
    const query = { fromMs: BASE_TIME, toMs: BASE_TIME + 1_000, limit: 10 };

    await expect(repositoryWithFailedWriter.scan(query)).resolves.toMatchObject([
      { exchangeId: 'exchange-before-writer-failure' },
    ]);
    repositoryWithFailedWriter.enqueue(exchange('exchange-waiting-for-a-writer'));
    await repositoryWithFailedWriter.flush();
    expect(repositoryWithFailedWriter.health()).toMatchObject({
      state: 'restarting',
      readerState: 'ready',
      dropped: 0,
      queuedRecords: 1,
      lastError: expect.stringMatching(/insert request timed out/),
    });
    expect(repositoryWithFailedWriter.enqueue(exchange('exchange-during-restart'))).toBe(true);
    await expect(repositoryWithFailedWriter.scan(query)).resolves.toMatchObject([
      { exchangeId: 'exchange-before-writer-failure' },
    ]);
    await expect(new LlmStatisticsQueryService(repositoryWithFailedWriter).capabilities()).resolves.toMatchObject({
      available: true,
      health: { state: 'restarting', readerState: 'ready' },
    });
    await repositoryWithFailedWriter.close();
    expect(repositoryWithFailedWriter.health()).toMatchObject({ state: 'closed', dropped: 2, queuedRecords: 0 });
  });

  it('restarts a killed writer and persists records queued meanwhile', async () => {
    const writers: Worker[] = [];
    const logs: string[] = [];
    const opened = await repository({
      processRunId: 'process-run-restarted',
      restartDelayMs: 10,
      logSink: (level, message) => logs.push(`${level} ${message}`),
      workerFactory: (url, options) => {
        const worker = defaultWorkerFactory(url, options);
        writers.push(worker);
        return worker;
      },
    });
    opened.repository.enqueue(exchange('exchange-before-crash'));
    await opened.repository.flush();
    expect(opened.repository.health()).toMatchObject({ state: 'ready', persisted: 1 });

    await writers[0]?.terminate();
    expect(opened.repository.health()).toMatchObject({
      state: 'restarting',
      lastError: expect.stringMatching(/exited with code/),
    });
    expect(opened.repository.enqueue(exchange('exchange-during-restart', { startedAtMs: BASE_TIME + 1 }))).toBe(true);
    expect(opened.repository.health().queuedRecords).toBe(1);

    await vi.waitFor(
      () => expect(opened.repository.health()).toMatchObject({ state: 'ready', persisted: 2, queuedRecords: 0 }),
      { timeout: 10_000, interval: 20 },
    );
    opened.repository.enqueue(exchange('exchange-after-restart', { startedAtMs: BASE_TIME + 2 }));
    await opened.repository.flush();
    expect(opened.repository.health()).toMatchObject({
      state: 'ready',
      persisted: 3,
      dropped: 0,
      writerRestarts: 1,
      lastError: null,
    });
    expect(writers).toHaveLength(2);
    const rows = await opened.repository.scan({ fromMs: BASE_TIME, toMs: BASE_TIME + 1_000, limit: 10 });
    expect(rows.map((row) => row.exchangeId).sort()).toEqual([
      'exchange-after-restart',
      'exchange-before-crash',
      'exchange-during-restart',
    ]);
    expect(logs).toEqual([
      expect.stringMatching(/^warn \[llm-metrics\] Statistics writer unavailable \(LLM metrics worker exited/),
      expect.stringMatching(/^info \[llm-metrics\] Statistics writer running again after 1 restart/),
    ]);
    await opened.repository.close();

    // The restarted worker re-ran startup under the same process run, so the
    // start marker is not duplicated and the counters stay process-lifetime.
    const database = new DatabaseSync(opened.databasePath, { readOnly: true });
    expect(database.prepare('SELECT * FROM llm_process_runs').all()).toEqual([
      expect.objectContaining({
        process_run_id: 'process-run-restarted',
        observed_count: 3,
        enqueued_count: 3,
        clean_ended_at_ms: expect.any(Number),
      }),
    ]);
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM llm_exchanges WHERE process_run_id = 'process-run-restarted'")
        .get(),
    ).toMatchObject({ count: 3 });
    database.close();
  });

  describe('a record enqueued while a running drain awaits its checkpoint', () => {
    /**
     * A writer that answers at once, except for the first checkpoint: that one
     * is answered late, so the drain that sent it has already passed its last
     * queue check while the test enqueues behind it.
     */
    async function repositoryWithSlowFirstCheckpoint(): Promise<SqliteLlmMetricsRepository> {
      const opened = await repository({
        workerFactory: () =>
          new Worker(
            `const { parentPort } = require('node:worker_threads');
             let holdCheckpoint = true;
             parentPort.postMessage({ kind: 'ready', schemaVersion: 1 });
             parentPort.on('message', (request) => {
               const value =
                 request.kind === 'insert' ? { inserted: request.exchanges.length, duplicates: 0, rejected: {} } : null;
               const answer = () => parentPort.postMessage({ kind: 'result', id: request.id, value });
               if (request.kind === 'checkpoint' && holdCheckpoint) {
                 holdCheckpoint = false;
                 setTimeout(answer, 300);
               } else {
                 answer();
               }
             });`,
            { eval: true },
          ),
      });
      const metrics = opened.repository;
      metrics.enqueue(exchange('exchange-first-drain'));
      void metrics.flush();
      // The drain wrote its only batch and now waits for its checkpoint answer.
      await vi.waitFor(() => expect(metrics.health()).toMatchObject({ persisted: 1, queuedRecords: 0 }), {
        timeout: 5_000,
        interval: 5,
      });
      expect(metrics.enqueue(exchange('exchange-behind-the-drain', { startedAtMs: BASE_TIME + 1 }))).toBe(true);
      return metrics;
    }

    it('is written by a flush called meanwhile', async () => {
      const metrics = await repositoryWithSlowFirstCheckpoint();
      await metrics.flush();
      expect(metrics.health()).toMatchObject({ state: 'ready', persisted: 2, queuedRecords: 0, dropped: 0 });
      await metrics.close();
    });

    it('is written, not dropped, by close', async () => {
      const metrics = await repositoryWithSlowFirstCheckpoint();
      await metrics.close();
      expect(metrics.health()).toMatchObject({ state: 'closed', persisted: 2, queuedRecords: 0, dropped: 0 });
    });
  });

  it('requeues the unacknowledged batch of a writer that dies mid-insert', async () => {
    let writers = 0;
    const opened = await repository({
      restartDelayMs: 10,
      logSink: () => {},
      workerFactory: (url, options) => {
        writers++;
        if (writers === 1) {
          return new Worker(
            `const { parentPort } = require('node:worker_threads');
             parentPort.postMessage({ kind: 'ready', schemaVersion: 1 });
             parentPort.on('message', (request) => {
               if (request.kind === 'insert') process.exit(3);
               parentPort.postMessage({ kind: 'result', id: request.id, value: null });
             });`,
            { eval: true },
          );
        }
        return defaultWorkerFactory(url, options);
      },
    });
    opened.repository.enqueue(exchange('exchange-1'));
    opened.repository.enqueue(exchange('exchange-2', { startedAtMs: BASE_TIME + 1 }));
    await opened.repository.flush();
    expect(opened.repository.health()).toMatchObject({ state: 'restarting', dropped: 0, queuedRecords: 2 });

    await vi.waitFor(
      () => expect(opened.repository.health()).toMatchObject({ state: 'ready', persisted: 2, queuedRecords: 0 }),
      { timeout: 10_000, interval: 20 },
    );
    expect(opened.repository.health()).toMatchObject({ dropped: 0, writerRestarts: 1 });
    await opened.repository.close();
  });

  it('bounds each writer request and drops a record only after its bounded write attempts', async () => {
    let writers = 0;
    const opened = await repository({
      writeTimeoutMs: 30,
      closeTimeoutMs: 30,
      restartDelayMs: 1,
      maxRestartDelayMs: 1,
      logSink: () => {},
      workerFactory: () => {
        writers++;
        return new Worker(
          `const { parentPort } = require('node:worker_threads');
           parentPort.postMessage({ kind: 'ready', schemaVersion: 1 });
           parentPort.on('message', () => {});`,
          { eval: true },
        );
      },
    });
    opened.repository.enqueue(exchange('exchange-unresponsive-flush'));

    const startedAt = performance.now();
    await opened.repository.flush();
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(opened.repository.health()).toMatchObject({
      state: 'restarting',
      dropped: 0,
      queuedRecords: 1,
      lastError: expect.stringMatching(/insert request timed out/),
    });

    // Every replacement worker is wedged too: the record is retried a bounded
    // number of times, then dropped, and the queue drains.
    await vi.waitFor(() => expect(opened.repository.health()).toMatchObject({ dropped: 1, queuedRecords: 0 }), {
      timeout: 10_000,
      interval: 20,
    });
    expect(opened.repository.health().persisted).toBe(0);
    expect(opened.repository.health().writerRestarts).toBeGreaterThanOrEqual(4);
    expect(writers).toBeGreaterThanOrEqual(5);
    await opened.repository.close();
  });

  it('gives each writer request its own deadline, so a drain longer than one deadline completes', async () => {
    let writers = 0;
    const opened = await repository({
      batchSize: 1,
      writeTimeoutMs: 1_500,
      logSink: () => {},
      workerFactory: () => {
        writers++;
        return new Worker(
          `const { parentPort } = require('node:worker_threads');
           parentPort.postMessage({ kind: 'ready', schemaVersion: 1 });
           parentPort.on('message', (request) => {
             const value =
               request.kind === 'insert' ? { inserted: request.exchanges.length, duplicates: 0, rejected: {} } : null;
             setTimeout(() => parentPort.postMessage({ kind: 'result', id: request.id, value }), 250);
           });`,
          { eval: true },
        );
      },
    });
    for (let index = 0; index < 8; index++) {
      opened.repository.enqueue(exchange(`exchange-slow-batch-${index}`, { startedAtMs: BASE_TIME + index }));
    }

    const startedAt = performance.now();
    await opened.repository.flush();
    // Eight answers at 250 ms each outlast a single request deadline, which
    // a whole-drain deadline would have cut short.
    expect(performance.now() - startedAt).toBeGreaterThan(1_500);
    expect(opened.repository.health()).toMatchObject({
      state: 'ready',
      persisted: 8,
      dropped: 0,
      queuedRecords: 0,
      writerRestarts: 0,
    });
    expect(writers).toBe(1);
    await opened.repository.close();
  });

  it('backs off writer restarts exponentially from 1 s to a 5 min ceiling', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let spawns = 0;
      const opened = await repository({
        logSink: () => {},
        workerFactory: () => {
          spawns++;
          throw new Error('Worker threads are exhausted');
        },
      });
      expect(spawns).toBe(1);
      expect(opened.repository.health()).toMatchObject({ state: 'restarting', writerRestarts: 0 });

      const delaysMs = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000];
      for (const [index, delayMs] of delaysMs.entries()) {
        vi.advanceTimersByTime(delayMs - 1);
        expect(spawns).toBe(index + 1);
        vi.advanceTimersByTime(1);
        expect(spawns).toBe(index + 2);
      }
      expect(opened.repository.health()).toMatchObject({ state: 'restarting', writerRestarts: delaysMs.length });

      // The queue keeps accepting while the writer is away; close drops what it holds and stops restarting.
      expect(opened.repository.enqueue(exchange('exchange-while-backing-off'))).toBe(true);
      await opened.repository.close();
      expect(opened.repository.health()).toMatchObject({ state: 'closed', dropped: 1, queuedRecords: 0 });
      vi.advanceTimersByTime(10 * 60 * 1_000);
      expect(spawns).toBe(delaysMs.length + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('restarts after a transient startup failure and logs the open-time failure', async () => {
    let writers = 0;
    const logs: string[] = [];
    const opened = await repository({
      restartDelayMs: 10,
      logSink: (level, message) => logs.push(`${level} ${message}`),
      workerFactory: (url, options) => {
        writers++;
        if (writers === 1) {
          return new Worker(
            `const { parentPort } = require('node:worker_threads');
             parentPort.postMessage({ kind: 'error', message: 'disk I/O error' });`,
            { eval: true },
          );
        }
        return defaultWorkerFactory(url, options);
      },
    });
    expect(opened.repository.health()).toMatchObject({
      state: 'restarting',
      lastError: expect.stringMatching(/disk I\/O error/),
    });
    expect(logs).toEqual([expect.stringMatching(/^warn .*Statistics writer unavailable \(disk I\/O error\)/)]);
    expect(opened.repository.enqueue(exchange('exchange-before-first-start'))).toBe(true);

    await vi.waitFor(
      () => expect(opened.repository.health()).toMatchObject({ state: 'ready', persisted: 1, writerRestarts: 1 }),
      { timeout: 10_000, interval: 20 },
    );
    expect(writers).toBe(2);
    await opened.repository.close();
  });

  it('latches persistence off for a corrupt database without restarting or rewriting it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ironcurtain-llm-metrics-corrupt-'));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, 'llm-usage.sqlite3');
    const garbage = Buffer.alloc(8192, 0x5a);
    writeFileSync(databasePath, garbage, { mode: 0o600 });
    let writers = 0;
    const logs: string[] = [];

    const repositoryOnCorruptFile = await SqliteLlmMetricsRepository.open({
      databasePath,
      restartDelayMs: 1,
      logSink: (level, message) => logs.push(`${level} ${message}`),
      workerFactory: (url, options) => {
        writers++;
        return defaultWorkerFactory(url, options);
      },
    });
    expect(repositoryOnCorruptFile.health()).toMatchObject({
      state: 'disabled',
      lastError: expect.stringMatching(/not a database/),
    });
    expect(repositoryOnCorruptFile.enqueue(exchange('exchange-1'))).toBe(false);
    await delay(50);
    expect(writers).toBe(1);
    expect(logs).toEqual([expect.stringMatching(/^error .*Statistics persistence disabled: file is not a database/)]);
    await repositoryOnCorruptFile.close();
    expect(readFileSync(databasePath).equals(garbage)).toBe(true);
  });

  it('latches persistence off for a permission failure reported at startup', async () => {
    let writers = 0;
    const opened = await repository({
      restartDelayMs: 1,
      logSink: () => {},
      workerFactory: () => {
        writers++;
        return new Worker(
          `const { parentPort } = require('node:worker_threads');
           parentPort.postMessage({
             kind: 'error', message: "EACCES: permission denied, chmod 'statistics'", code: 'permission'
           });`,
          { eval: true },
        );
      },
    });
    expect(opened.repository.health()).toMatchObject({
      state: 'disabled',
      lastError: expect.stringMatching(/permission denied/),
    });
    await delay(50);
    expect(writers).toBe(1);
    await opened.repository.close();
  });

  it('bounds its queue and fails open when persistence cannot accept another record', async () => {
    const opened = await repository({ maxQueuedRecords: 1 });
    expect(opened.repository.enqueue(exchange('exchange-1'))).toBe(true);
    expect(opened.repository.enqueue(exchange('exchange-2'))).toBe(false);
    expect(opened.repository.health()).toMatchObject({ observed: 2, enqueued: 1, dropped: 1 });
    await opened.repository.close();
  });

  it('uses one bounded deadline for queue drain and close', async () => {
    const opened = await repository({
      writeTimeoutMs: 60_000,
      closeTimeoutMs: 30,
      workerFactory: () =>
        new Worker(
          `const { parentPort } = require('node:worker_threads');
           parentPort.postMessage({ kind: 'ready', schemaVersion: 1 });
           parentPort.on('message', () => {});`,
          { eval: true },
        ),
    });
    opened.repository.enqueue(exchange('exchange-unresponsive-close'));

    const startedAt = performance.now();
    await opened.repository.close();
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(opened.repository.health()).toMatchObject({
      state: 'closed',
      dropped: 1,
      queuedRecords: 0,
      lastError: expect.stringMatching(/close timed out/),
    });
  });

  it('disables safely for a future schema without rewriting it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ironcurtain-llm-metrics-future-'));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, 'future.sqlite3');
    const database = new DatabaseSync(databasePath);
    database.exec('PRAGMA user_version = 99');
    database.close();

    const repository = await SqliteLlmMetricsRepository.open({ databasePath });
    expect(repository.health()).toMatchObject({ state: 'disabled', schemaVersion: null });
    expect(repository.enqueue(exchange('exchange-1'))).toBe(false);
    await expect(repository.scan({ fromMs: 0, toMs: 1, limit: 1 })).rejects.toThrow(/schema 99|unavailable/i);
    await repository.close();

    const verification = new DatabaseSync(databasePath, { readOnly: true });
    expect(verification.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 99 });
    verification.close();
  });

  it('persists only the explicit content-free allowlist', async () => {
    const opened = await repository();
    const canary = 'PROMPT-CONTENT-MUST-NEVER-BE-DURABLE-7c8fcf91';
    const record = { ...exchange('exchange-privacy'), accidentalPayload: canary } as LlmExchangeCompleted;
    opened.repository.enqueue(record);
    await opened.repository.close();

    expect(readFileSync(opened.databasePath).includes(Buffer.from(canary))).toBe(false);
  });
});

describe('LLM statistics query service', () => {
  it('provides stable pagination and coverage-aware summaries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ironcurtain-llm-query-'));
    const databasePath = join(directory, 'llm-usage.sqlite3');
    const repository = await SqliteLlmMetricsRepository.open({ databasePath, flushIntervalMs: 60_000 });
    try {
      repository.enqueue(exchange('exchange-1'));
      repository.enqueue(
        exchange('exchange-2', {
          startedAtMs: BASE_TIME + 1_000,
          refusal: true,
          thinkingTokens: null,
          nonThinkingOutputTokens: null,
          completeness: 'partial',
        }),
      );
      await repository.flush();
      const service = new LlmStatisticsQueryService(repository);

      const first = await service.listExchanges({ fromMs: BASE_TIME, toMs: BASE_TIME + 2_000, limit: 1 });
      expect(first.items.map((row) => row.exchangeId)).toEqual(['exchange-2']);
      expect(first.nextCursor).not.toBeNull();
      const second = await service.listExchanges({
        fromMs: BASE_TIME,
        toMs: BASE_TIME + 2_000,
        limit: 1,
        cursor: first.nextCursor ?? undefined,
      });
      expect(second.items.map((row) => row.exchangeId)).toEqual(['exchange-1']);

      const summaries = await service.summarize({
        fromMs: BASE_TIME,
        toMs: BASE_TIME + 2_000,
        measures: ['requestCount', 'refusalRate', 'inputTokens', 'thinkingTokens'],
      });
      expect(summaries.find((summary) => summary.measure === 'requestCount')).toMatchObject({ value: 2 });
      expect(summaries.find((summary) => summary.measure === 'refusalRate')).toMatchObject({
        value: 0.5,
        coverage: 1,
      });
      expect(summaries.find((summary) => summary.measure === 'inputTokens')).toMatchObject({
        value: 200,
        sampleCount: 2,
        coverage: 1,
      });
      expect(summaries.find((summary) => summary.measure === 'thinkingTokens')).toMatchObject({
        value: 10,
        sampleCount: 1,
        coverage: 0.5,
      });

      expect(
        await service.dimensions({
          fromMs: BASE_TIME,
          toMs: BASE_TIME + 2_000,
          dimension: 'servedModel',
        }),
      ).toEqual([{ value: 'served-model', count: 2 }]);
      expect(await service.dimensions({ fromMs: BASE_TIME, toMs: BASE_TIME + 2_000, dimension: 'streaming' })).toEqual([
        { value: true, count: 2 },
      ]);
      expect(await service.dimensions({ fromMs: BASE_TIME, toMs: BASE_TIME + 2_000, dimension: 'refusal' })).toEqual([
        { value: false, count: 1 },
        { value: true, count: 1 },
      ]);
      expect(await service.sessionTotals('session-1')).toMatchObject({
        exchanges: 2,
        inputTokens: 200,
        thinkingTokens: 10,
        completeUsageExchanges: 1,
        partialUsageExchanges: 1,
      });
      expect(await service.capabilities()).toMatchObject({
        available: true,
        dtoVersion: 3,
        formulaVersion: 4,
        maxScannedRows: 1_000_000,
        maxGroups: 500,
        maxOutputItems: 10_000,
        maxTimeSeriesBuckets: 1_000,
        maxRangeDays: 366,
        quantileSampleSize: 2_048,
        allowedCalendarBucketUnits: ['day'],
      });
    } finally {
      await repository.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('adds the known parts of partly measured rows to the token sums as lower bounds', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ironcurtain-llm-lower-bounds-'));
    const repository = await SqliteLlmMetricsRepository.open({
      databasePath: join(directory, 'llm-usage.sqlite3'),
      flushIntervalMs: 60_000,
    });
    try {
      repository.enqueue(exchange('complete'));
      // A cache counter the gateway omitted: the input total is unknown, but
      // 80 uncached plus 20 cache-read input tokens and 40 output are known.
      const partial = exchange('partial', { startedAtMs: BASE_TIME + 1, completeness: 'partial' });
      repository.enqueue({
        ...partial,
        usage: {
          ...partial.usage,
          inputTokensTotal: null,
          cacheWriteInputTokens: null,
          providerTotalTokens: null,
          canonicalTotalTokens: null,
        },
      });
      repository.enqueue({ ...exchange('unmeasured', { startedAtMs: BASE_TIME + 2 }), usage: makeNormalizedUsage() });
      await repository.flush();
      const service = new LlmStatisticsQueryService(repository);
      const summaries = await service.summarize({
        fromMs: BASE_TIME,
        toMs: BASE_TIME + 1_000,
        measures: ['inputTokens', 'outputTokens', 'totalTokens'],
      });
      expect(summaries.find((summary) => summary.measure === 'inputTokens')).toMatchObject({
        value: 200,
        sampleCount: 1,
        lowerBoundCount: 1,
        eligibleCount: 3,
        median: 100,
      });
      expect(summaries.find((summary) => summary.measure === 'outputTokens')).toMatchObject({
        value: 80,
        sampleCount: 2,
        lowerBoundCount: 0,
      });
      expect(summaries.find((summary) => summary.measure === 'totalTokens')).toMatchObject({
        value: 280,
        sampleCount: 1,
        lowerBoundCount: 1,
      });
      expect(await service.sessionTotals('session-1')).toMatchObject({
        exchanges: 3,
        inputTokens: 200,
        outputTokens: 80,
        totalTokens: 280,
        tokenTotalsLowerBound: true,
      });
    } finally {
      await repository.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('excludes aborted, missing, and nonpositive client delivery from effective output throughput', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ironcurtain-llm-effective-tps-'));
    const repository = await SqliteLlmMetricsRepository.open({
      databasePath: join(directory, 'llm-usage.sqlite3'),
      flushIntervalMs: 60_000,
    });
    try {
      repository.enqueue(exchange('delivered', { clientDeliveryEndOffsetMs: 200 }));
      repository.enqueue(exchange('aborted', { startedAtMs: BASE_TIME + 1, clientAborted: true }));
      repository.enqueue(exchange('missing', { startedAtMs: BASE_TIME + 2, clientDeliveryEndOffsetMs: null }));
      repository.enqueue(exchange('zero', { startedAtMs: BASE_TIME + 3, clientDeliveryEndOffsetMs: 0 }));
      await repository.flush();
      const summaries = await new LlmStatisticsQueryService(repository).summarize({
        fromMs: BASE_TIME,
        toMs: BASE_TIME + 1_000,
        measures: ['effectiveOutputTokensPerSecond'],
      });
      expect(summaries[0]).toMatchObject({
        value: 200,
        sampleCount: 1,
        eligibleCount: 4,
        coverage: 0.25,
      });
    } finally {
      await repository.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
