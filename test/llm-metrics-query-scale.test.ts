/**
 * Statistics at scale: aggregation runs in SQLite on the reader worker, the
 * dashboard stays fast with tens of thousands of exchanges, over-limit
 * requests fail with STATISTICS_LIMIT, and pseudonymized identities render
 * with their configured names.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { getLlmMetricsEventBus } from '../src/llm-metrics/event-bus.js';
import { createPersistenceIdentityProtector } from '../src/llm-metrics/identity-protector.js';
import { makeNormalizedUsage } from '../src/llm-metrics/normalization.js';
import {
  openSqliteLlmMetricsReader,
  type SqliteLlmMetricsReader,
} from '../src/llm-metrics/persistence/sqlite-repository.js';
import type { LlmMetricsReadRepository } from '../src/llm-metrics/persistence/repository.js';
import { LlmStatisticsQueryService, type MetricSummary } from '../src/llm-metrics/query-service.js';
import { STATISTICS_MEASURES, type StatisticsMeasure } from '../src/llm-metrics/query-contract.js';
import { acquireLlmMetricsRuntime, type LlmMetricsRuntimeLease } from '../src/llm-metrics/runtime.js';
import { createStatisticsLabelResolver } from '../src/llm-metrics/statistics-labels.js';
import type { LlmExchangeCompleted } from '../src/llm-metrics/types.js';
import { dispatch } from '../src/web-ui/json-rpc-dispatch.js';
import type { WorkflowDispatchContext } from '../src/web-ui/dispatch/workflow-dispatch.js';
import {
  createStatisticsTestDatabase,
  statisticsRow,
  type StatisticsTestDatabase,
  type StatisticsTestRow,
} from './helpers/llm-statistics-db.js';
import {
  calendarBucketKey,
  fixedBucketKey,
  referencePartitions,
  referenceQuantile,
  referenceRowMeasure,
  type ReferenceSummary,
} from './helpers/llm-statistics-reference.js';

const DAY_MS = 24 * 60 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;

/** Deterministic generator so failures reproduce. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function pick<Value>(random: () => number, values: readonly Value[]): Value {
  return values[Math.floor(random() * values.length)];
}

/**
 * Stores a generated cost the ways the writer does: most priced rows have a
 * gateway-reported cost, every fifth a host list-price estimate instead, and
 * every eleventh both (the reported cost is the exchange's cost).
 */
function costColumns(index: number, cost: number | null): Partial<StatisticsTestRow> {
  if (cost === null) return { costUsd: null };
  if (index % 5 === 0) return { costUsd: null, estimatedCostUsd: cost };
  if (index % 11 === 0) return { costUsd: cost, estimatedCostUsd: cost * 3 };
  return { costUsd: cost };
}

/** Rows with every kind of gap the formulas treat specially. */
function variedRows(count: number, fromMs: number, spanMs: number, seed: number): StatisticsTestRow[] {
  const random = generator(seed);
  return Array.from({ length: count }, (_, index) => {
    const kind = random();
    const output = Math.floor(random() * 4_000);
    const thinking = random() < 0.2 ? null : Math.floor(output * random());
    const input = Math.floor(random() * 60_000);
    const cacheRead = Math.floor(input * random() * 0.5);
    const unmeasured = kind < 0.04;
    const partialInput = kind >= 0.04 && kind < 0.12;
    const partialOutput = kind >= 0.12 && kind < 0.16;
    return statisticsRow({
      exchangeId: `varied-${seed}-${index}`,
      completedAtMs: fromMs + Math.floor(random() * spanMs),
      sessionId: random() < 0.05 ? null : `session-${Math.floor(random() * 40)}`,
      logicalProvider: pick(random, ['anthropic', 'openai', 'openrouter']),
      forwardedModel: pick(random, ['model-a', 'model-b', 'model-c', null]),
      servedModel: pick(random, ['served-a', 'served-b', null]),
      personaId: pick(random, ['global', 'coder', null]),
      streaming: pick(random, [true, false, null]),
      refusal: pick(random, [true, false, false, false, null]),
      outcome: pick(random, ['stop', 'stop', 'stop', 'error', 'aborted', 'unknown', 'length']),
      clientAborted: random() < 0.05,
      inputTokensReported: unmeasured ? null : input - cacheRead,
      inputTokens: unmeasured || partialInput ? null : input,
      uncachedInputTokens: unmeasured ? null : input - cacheRead,
      cacheReadInputTokens: unmeasured ? null : cacheRead,
      cacheWriteInputTokens: unmeasured || partialInput ? null : 0,
      toolUseInputTokens: unmeasured || random() < 0.5 ? null : Math.floor(random() * 50),
      outputTokensReported: unmeasured ? null : output,
      outputTokens: unmeasured || partialOutput ? null : output,
      thinkingTokens: unmeasured ? null : thinking,
      nonThinkingOutputTokens: unmeasured || thinking === null ? null : output - thinking,
      providerTotalTokens: unmeasured || random() < 0.3 ? null : input + output,
      totalTokens: unmeasured || partialInput || partialOutput ? null : input + output,
      ...costColumns(index, unmeasured || random() < 0.2 ? null : Math.round(random() * 1e6) / 1e8),
      firstReasoningOffsetMs: random() < 0.3 ? null : 50 + random() * 500,
      firstOutputOffsetMs: random() < 0.2 ? null : 100 + random() * 900,
      upstreamResponseEndOffsetMs: random() < 0.1 ? null : 500 + random() * 5_000,
      clientDeliveryEndOffsetMs: random() < 0.05 ? null : random() < 0.02 ? 0 : 600 + random() * 6_000,
    });
  });
}

function relativeClose(actual: number | null, expected: number | null): void {
  if (expected === null || actual === null) {
    expect(actual).toBe(expected);
    return;
  }
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(expected)));
}

function expectSameSummary(actual: MetricSummary, expected: ReferenceSummary): void {
  expect(actual.dimensions).toEqual(expected.dimensions);
  expect(actual.measure).toBe(expected.measure);
  expect({
    sampleCount: actual.sampleCount,
    lowerBoundCount: actual.lowerBoundCount,
    sampleSessionCount: actual.sampleSessionCount,
    eligibleCount: actual.eligibleCount,
  }).toEqual({
    sampleCount: expected.sampleCount,
    lowerBoundCount: expected.lowerBoundCount,
    sampleSessionCount: expected.sampleSessionCount,
    eligibleCount: expected.eligibleCount,
  });
  relativeClose(actual.value, expected.value);
  relativeClose(actual.coverage, expected.coverage);
  relativeClose(actual.median, expected.median);
  relativeClose(actual.lowerQuartile, expected.lowerQuartile);
  relativeClose(actual.upperQuartile, expected.upperQuartile);
}

function byPartitionKey(summaries: readonly MetricSummary[], bucket: string | null = null): Map<string, MetricSummary> {
  return new Map(summaries.map((summary) => [JSON.stringify([bucket, summary.dimensions, summary.measure]), summary]));
}

describe('statistics aggregation in SQLite', () => {
  const databases: StatisticsTestDatabase[] = [];
  const readers: SqliteLlmMetricsReader[] = [];

  function open(rows: readonly StatisticsTestRow[]): SqliteLlmMetricsReader {
    const database = createStatisticsTestDatabase();
    databases.push(database);
    database.insert(rows);
    const reader = openSqliteLlmMetricsReader({ databasePath: database.databasePath });
    readers.push(reader);
    return reader;
  }

  afterEach(async () => {
    await Promise.all(readers.splice(0).map((reader) => reader.close()));
    for (const database of databases.splice(0)) database.remove();
  });

  it('computes the same summaries, series and session totals as the row-by-row formulas', async () => {
    const fromMs = Date.parse('2026-03-01T00:00:00.000Z');
    const spanMs = 20 * DAY_MS;
    const rows = variedRows(1_500, fromMs, spanMs, 7);
    const service = new LlmStatisticsQueryService(open(rows));
    const measures = STATISTICS_MEASURES;
    const range = { fromMs, toMs: fromMs + spanMs };

    const overall = await service.summarize({ ...range, measures });
    const [expectedOverall] = referencePartitions(rows, measures);
    expect(overall).toHaveLength(measures.length);
    overall.forEach((summary, index) => expectSameSummary(summary, expectedOverall.summaries[index]));

    const groupBy = ['logicalProvider', 'forwardedModel', 'streaming'] as const;
    const grouped = await service.summarize({ ...range, measures, groupBy: [...groupBy] });
    const expectedGrouped = referencePartitions(rows, measures, groupBy).flatMap((partition) => partition.summaries);
    expect(grouped).toHaveLength(expectedGrouped.length);
    const groupedByKey = byPartitionKey(grouped);
    for (const expected of expectedGrouped) {
      const actual = groupedByKey.get(JSON.stringify([null, expected.dimensions, expected.measure]));
      expect(actual).toBeDefined();
      if (actual !== undefined) expectSameSummary(actual, expected);
    }

    const fixedSeries = await service.timeSeries({ ...range, measures, groupBy: ['personaId'], bucketMs: DAY_MS });
    const expectedFixedSeries = referencePartitions(rows, measures, ['personaId'], fixedBucketKey(fromMs, DAY_MS));
    expect(fixedSeries.flatMap((bucket) => bucket.summaries)).toHaveLength(
      expectedFixedSeries.reduce((total, partition) => total + partition.summaries.length, 0),
    );
    const fixedSeriesByKey = new Map(
      fixedSeries.flatMap((bucket) => [...byPartitionKey(bucket.summaries, String(bucket.fromMs)).entries()]),
    );
    for (const partition of expectedFixedSeries) {
      for (const expected of partition.summaries) {
        const actual = fixedSeriesByKey.get(
          JSON.stringify([partition.bucketKey, expected.dimensions, expected.measure]),
        );
        expect(actual).toBeDefined();
        if (actual !== undefined) expectSameSummary(actual, expected);
      }
    }

    const timeZone = 'America/Los_Angeles';
    const daily = await service.timeSeries({
      ...range,
      measures: ['requestCount', 'outputTokens', 'effectiveOutputTokensPerSecond'],
      calendarBucket: { unit: 'day', timeZone },
    });
    const expectedDaily = referencePartitions(
      rows,
      ['requestCount', 'outputTokens', 'effectiveOutputTokensPerSecond'],
      [],
      calendarBucketKey(timeZone),
    ).sort((left, right) => String(left.bucketKey).localeCompare(String(right.bucketKey)));
    expect(daily).toHaveLength(expectedDaily.length);
    daily.forEach((bucket, index) => {
      const expected = expectedDaily[index];
      bucket.summaries.forEach((summary, measureIndex) => expectSameSummary(summary, expected.summaries[measureIndex]));
    });

    const sessionRows = rows.filter((row) => row.sessionId === 'session-3');
    const totals = await service.sessionTotals('session-3');
    const reference = referencePartitions(sessionRows, ['inputTokens', 'outputTokens', 'totalTokens', 'costUsd'])[0];
    expect(totals.exchanges).toBe(sessionRows.length);
    relativeClose(totals.inputTokens, reference.summaries[0].value);
    relativeClose(totals.outputTokens, reference.summaries[1].value);
    relativeClose(totals.totalTokens, reference.summaries[2].value);
    relativeClose(totals.costUsd, reference.summaries[3].value);
    expect(totals.tokenTotalsLowerBound).toBe(
      sessionRows.some((row) => row.inputTokens === null || row.outputTokens === null || row.totalTokens === null),
    );
  });

  it('bins a distribution from exact counts over every sample', async () => {
    const fromMs = Date.parse('2026-05-01T00:00:00.000Z');
    const rows = variedRows(1_200, fromMs, DAY_MS, 11);
    const service = new LlmStatisticsQueryService(open(rows));
    for (const measure of ['effectiveOutputTokensPerSecond', 'inputTokens', 'ttftMs'] as const) {
      const distribution = await service.distribution({ fromMs, toMs: fromMs + DAY_MS, measure, maxBins: 24 });
      const values = rows.flatMap((row) => {
        const value = referenceRowMeasure(row, measure);
        return value === null ? [] : [value];
      });
      expect(distribution).toMatchObject({
        sampleCount: values.length,
        eligibleCount: rows.length,
        minimum: Math.min(...values),
        maximum: Math.max(...values),
      });
      expect(distribution.bins.length).toBeLessThanOrEqual(24);
      expect(distribution.bins.reduce((total, bin) => total + bin.count, 0)).toBe(values.length);
      for (const bin of distribution.bins) {
        expect(bin.count).toBe(
          values.filter((value) =>
            bin === distribution.bins.at(-1) ? value >= bin.lower : value >= bin.lower && value < bin.upper,
          ).length,
        );
      }
    }
  });

  it('sums implausibly large reported counts without failing the query or retiring the reader', async () => {
    // Each counter is a safe integer, which the writer accepts from any
    // upstream. Their sums pass 2^53 (no exact JavaScript integer) and 2^63
    // (SQLite's integer SUM overflow); the costs overflow a double.
    const fromMs = Date.parse('2026-06-01T00:00:00.000Z');
    const huge = Number.MAX_SAFE_INTEGER;
    const rows = Array.from({ length: 1_100 }, (_, index) =>
      statisticsRow({
        completedAtMs: fromMs + index,
        sessionId: 'session-huge',
        outputTokensReported: huge,
        outputTokens: huge,
        thinkingTokens: huge,
        nonThinkingOutputTokens: 0,
        providerTotalTokens: huge,
        totalTokens: huge,
        costUsd: Number.MAX_VALUE,
      }),
    );
    const reader = open(rows);
    const service = new LlmStatisticsQueryService(reader);
    const range = { fromMs, toMs: fromMs + DAY_MS };
    const measures: StatisticsMeasure[] = ['outputTokens', 'thinkingTokens', 'totalTokens', 'costUsd'];

    const overall = await service.summarize({ ...range, measures });
    for (const summary of overall.slice(0, 3)) {
      relativeClose(summary.value, rows.length * huge);
      expect(summary).toMatchObject({ sampleCount: rows.length, median: huge });
    }
    // A total no JSON number can carry is reported as unknown, not as a failure.
    expect(overall[3]).toMatchObject({ measure: 'costUsd', value: null, sampleCount: rows.length });

    const daily = await service.timeSeries({ ...range, measures, calendarBucket: { unit: 'day', timeZone: 'UTC' } });
    relativeClose(daily[0]?.summaries[0]?.value ?? null, rows.length * huge);

    const totals = await service.sessionTotals('session-huge');
    expect(totals.exchanges).toBe(rows.length);
    relativeClose(totals.outputTokens, rows.length * huge);
    relativeClose(totals.thinkingTokens, rows.length * huge);
    relativeClose(totals.totalTokens, rows.length * huge);
    expect(totals.costUsd).toBeNull();
    expect(reader.health()).toMatchObject({ readerState: 'ready', readerLastError: null });
  });

  it("sums each exchange's gateway-reported cost, else its list-price estimate", async () => {
    const fromMs = Date.parse('2026-07-01T00:00:00.000Z');
    const row = (offsetMs: number, cost: Partial<StatisticsTestRow>): StatisticsTestRow =>
      statisticsRow({ completedAtMs: fromMs + offsetMs, sessionId: 'session-cost', ...cost });
    const rows = [
      row(1, { costUsd: 0.25 }),
      row(2, { costUsd: null, estimatedCostUsd: 0.5 }),
      // Both known: the gateway-reported cost is the exchange's cost.
      row(3, { costUsd: 1, estimatedCostUsd: 4 }),
      // Neither known: the exchange is unpriced, not free.
      row(4, { costUsd: null }),
      // A cost no writer stores (infinite) is skipped as exchangeCostUsd skips it.
      row(5, { costUsd: Number.POSITIVE_INFINITY, estimatedCostUsd: 2, costSource: 'list_price' }),
    ];
    const service = new LlmStatisticsQueryService(open(rows));
    const range = { fromMs, toMs: fromMs + DAY_MS };

    const [cost] = await service.summarize({ ...range, measures: ['costUsd'] });
    expect(cost).toMatchObject({ measure: 'costUsd', sampleCount: 4, eligibleCount: 5 });
    relativeClose(cost.value, 3.75);
    relativeClose(cost.median, 0.75);
    const series = await service.timeSeries({ ...range, measures: ['costUsd'], bucketMs: DAY_MS });
    expect(series).toHaveLength(1);
    relativeClose(series[0].summaries[0].value, 3.75);
    relativeClose((await service.sessionTotals('session-cost')).costUsd, 3.75);
  });

  it('reports too many groups in one time-series bucket as the group limit', async () => {
    const fromMs = Date.parse('2026-05-01T00:00:00.000Z');
    const rows = Array.from({ length: 7 }, (_, index) =>
      statisticsRow({ completedAtMs: fromMs + index, sessionId: `session-${index}` }),
    );
    const service = new LlmStatisticsQueryService(open(rows), { limits: { maxGroups: 3 } });
    // Seven summaries in all: far below the output limit, but one bucket holds seven groups.
    await expect(
      service.timeSeries({
        fromMs,
        toMs: fromMs + 2 * DAY_MS - 1,
        measures: ['requestCount'],
        groupBy: ['sessionId'],
        bucketMs: DAY_MS,
      }),
    ).rejects.toMatchObject({ code: 'STATISTICS_LIMIT', limit: 'groups', maximum: 3 });
  });

  it('takes quartiles from a deterministic bounded sample once a group outgrows it', async () => {
    const fromMs = Date.parse('2026-05-01T00:00:00.000Z');
    const rows = Array.from({ length: 2_000 }, (_, index) =>
      statisticsRow({ completedAtMs: fromMs + index, outputTokens: index + 1, clientDeliveryEndOffsetMs: 1_000 }),
    );
    const reader = open(rows);
    const sampled = new LlmStatisticsQueryService(reader, { limits: { quantileSampleSize: 64 } });
    const exact = new LlmStatisticsQueryService(reader);
    const query = {
      fromMs,
      toMs: fromMs + 10_000,
      measures: ['outputTokens', 'effectiveOutputTokensPerSecond'] as StatisticsMeasure[],
    };

    const [first, second, third] = await Promise.all([
      sampled.summarize(query),
      sampled.summarize(query),
      exact.summarize(query),
    ]);
    expect(first).toEqual(second);
    const sorted = rows.map((row) => row.outputTokens ?? 0);
    expect(third[0]).toMatchObject({
      value: (2_000 * 2_001) / 2,
      sampleCount: 2_000,
      median: referenceQuantile(sorted, 0.5),
      lowerQuartile: referenceQuantile(sorted, 0.25),
      upperQuartile: referenceQuantile(sorted, 0.75),
    });
    // Sums and counts stay exact; only the quartiles are estimated, from 64 of the 2,000 values.
    expect(first[0]).toMatchObject({ value: (2_000 * 2_001) / 2, sampleCount: 2_000, eligibleCount: 2_000 });
    const median = first[0]?.median ?? 0;
    expect(median).not.toBe(third[0]?.median);
    expect(Math.abs(median - 1_000.5)).toBeLessThan(250);
    expect(first[0]?.lowerQuartile ?? 0).toBeLessThan(median);
    expect(first[0]?.upperQuartile ?? 0).toBeGreaterThan(median);
  });
});

// ---------------------------------------------------------------------------
// 50,000 exchanges: dashboard speed, bounded heap, limits
// ---------------------------------------------------------------------------

const SCALE_ROWS = 50_000;
const SCALE_DAYS = 90;
const DASHBOARD_BUDGET_MS = 200;

describe('statistics dashboard at 50,000 exchanges', () => {
  let database: StatisticsTestDatabase;
  let reader: SqliteLlmMetricsReader;
  let scans = 0;
  let readRepository: LlmMetricsReadRepository;
  const nowMs = Date.now();

  beforeAll(() => {
    database = createStatisticsTestDatabase('ironcurtain-statistics-scale-');
    const random = generator(42);
    const rows: StatisticsTestRow[] = [];
    for (let index = 0; index < SCALE_ROWS; index++) {
      const output = Math.floor(random() * 3_000);
      const thinking = Math.floor(output * random());
      const input = Math.floor(random() * 50_000);
      rows.push(
        statisticsRow({
          exchangeId: `scale-${String(index).padStart(6, '0')}`,
          // Ingestion order follows completion order, as live writers produce it.
          completedAtMs:
            nowMs - SCALE_DAYS * DAY_MS + Math.floor(((index + random()) * SCALE_DAYS * DAY_MS) / SCALE_ROWS),
          sessionId: `session-${index % 300}`,
          workflowRunId: index % 3 === 0 ? `workflow-${index % 40}` : null,
          personaId: pick(random, [
            'hmac:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            'hmac:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            null,
          ]),
          agentConversationId: 'hmac:cccccccccccccccccccccccccccccccc',
          providerProfile: 'hmac:dddddddddddddddddddddddddddddddd',
          logicalProvider: pick(random, ['anthropic', 'openai', 'openrouter', 'google']),
          forwardedModel: `model-${Math.floor(random() * 6)}`,
          servedProvider: pick(random, ['Anthropic', 'OpenAI', 'Google AI Studio']),
          servedModel: `served-${Math.floor(random() * 6)}`,
          refusal: random() < 0.01,
          outcome: random() < 0.03 ? 'error' : 'stop',
          inputTokensReported: input,
          inputTokens: random() < 0.05 ? null : input,
          uncachedInputTokens: Math.floor(input * 0.3),
          cacheReadInputTokens: Math.floor(input * 0.7),
          outputTokensReported: output,
          outputTokens: output,
          thinkingTokens: thinking,
          nonThinkingOutputTokens: output - thinking,
          providerTotalTokens: input + output,
          totalTokens: input + output,
          costUsd: random() * 0.1,
          clientDeliveryEndOffsetMs: random() < 0.02 ? null : 4_000 + random() * 2_000,
          qualityFlags: ['router_metadata_present', 'usage_only_observation'],
        }),
      );
    }
    database.insert(rows);
    reader = openSqliteLlmMetricsReader({ databasePath: database.databasePath });
    readRepository = {
      ...reader,
      scan: (query) => {
        scans += 1;
        return reader.scan(query);
      },
    };
  });

  afterAll(async () => {
    await reader.close();
    database.remove();
  });

  /** The five queries the Statistics page issues for one range, as `Statistics.svelte` builds them. */
  function dashboardQueries(service: LlmStatisticsQueryService, days: number): Record<string, () => Promise<unknown>> {
    const range = { fromMs: nowMs - days * DAY_MS, toMs: nowMs };
    const week = { fromMs: nowMs - 7 * DAY_MS, toMs: nowMs };
    const groupBy = ['logicalProvider', 'forwardedModel'] as const;
    const calendarBucket = { unit: 'day' as const, timeZone: 'America/Los_Angeles' };
    return {
      overall: () =>
        service.summarize({
          ...range,
          measures: [
            'requestCount',
            'refusalCount',
            'errorCount',
            'inputTokens',
            'outputTokens',
            'thinkingTokens',
            'nonThinkingOutputTokens',
            'totalTokens',
            'effectiveOutputTokensPerSecond',
          ],
        }),
      trend: () =>
        service.timeSeries({
          ...range,
          measures: ['effectiveOutputTokensPerSecond', 'refusalCount', 'errorCount'],
          groupBy: [...groupBy],
          topGroups: 8,
          calendarBucket,
        }),
      signals: () => service.timeSeries({ ...range, measures: ['refusalCount', 'errorCount'], calendarBucket }),
      rail: () =>
        service.summarize({
          ...range,
          measures: ['requestCount', 'outputTokens', 'effectiveOutputTokensPerSecond'],
          groupBy: [...groupBy],
          topGroups: 8,
        }),
      weekly: () =>
        service.summarize({
          ...week,
          measures: ['inputTokens', 'outputTokens', 'thinkingTokens', 'nonThinkingOutputTokens', 'totalTokens'],
        }),
    };
  }

  it('answers the 30- and 90-day dashboard queries within 200 ms each without moving rows to the main thread', async () => {
    const service = new LlmStatisticsQueryService(readRepository);
    // Warm the reader worker and its page cache, as an open Statistics page does.
    await dashboardQueries(service, SCALE_DAYS).overall();
    const heapBefore = process.memoryUsage().heapUsed;
    const timings: Record<string, number> = {};
    for (const days of [30, SCALE_DAYS]) {
      for (const [name, run] of Object.entries(dashboardQueries(service, days))) {
        let fastest = Number.POSITIVE_INFINITY;
        for (let attempt = 0; attempt < 3; attempt++) {
          const startedAt = performance.now();
          await run();
          fastest = Math.min(fastest, performance.now() - startedAt);
        }
        timings[`${days}d ${name}`] = Math.round(fastest);
      }
    }
    const heapGrowth = process.memoryUsage().heapUsed - heapBefore;

    for (const [query, elapsedMs] of Object.entries(timings)) {
      expect({ query, elapsedMs }).toSatisfy(() => elapsedMs < DASHBOARD_BUDGET_MS);
    }
    // Rows never cross into this thread: no scans, and the heap grows by results only.
    expect(scans).toBe(0);
    expect(heapGrowth).toBeLessThan(32 * 1024 * 1024);

    const overall = (await dashboardQueries(service, SCALE_DAYS).overall()) as readonly MetricSummary[];
    expect(overall.find((summary) => summary.measure === 'requestCount')?.value).toBe(SCALE_ROWS);
  }, 120_000);

  it('keeps the main thread responsive while a 90-day aggregation runs', async () => {
    const service = new LlmStatisticsQueryService(readRepository);
    let heartbeats = 0;
    const heartbeat = setInterval(() => heartbeats++, 1);
    try {
      await service.summarize({
        fromMs: nowMs - SCALE_DAYS * DAY_MS,
        toMs: nowMs,
        measures: STATISTICS_MEASURES,
        groupBy: ['servedProvider', 'servedModel'],
      });
    } finally {
      clearInterval(heartbeat);
    }
    expect(heartbeats).toBeGreaterThan(0);
  });

  function statisticsContext(service: LlmStatisticsQueryService): WorkflowDispatchContext {
    return { statisticsReader: service } as unknown as WorkflowDispatchContext;
  }

  it('reports over-limit requests as STATISTICS_LIMIT and keeps the reader healthy', async () => {
    const service = new LlmStatisticsQueryService(readRepository, {
      limits: { maxScannedRows: 10_000, maxGroups: 50 },
    });
    const context = statisticsContext(service);
    const ninetyDays = { fromMs: nowMs - SCALE_DAYS * DAY_MS, toMs: nowMs };

    await expect(
      dispatch(context, 'statistics.summary', { ...ninetyDays, measures: ['requestCount'] }),
    ).rejects.toMatchObject({ code: 'STATISTICS_LIMIT', data: { limit: 'scannedRows', maximum: 10_000 } });
    await expect(
      dispatch(context, 'statistics.distribution', { ...ninetyDays, measure: 'effectiveOutputTokensPerSecond' }),
    ).rejects.toMatchObject({ code: 'STATISTICS_LIMIT', data: { limit: 'scannedRows' } });
    await expect(
      dispatch(context, 'statistics.summary', {
        fromMs: nowMs - 367 * DAY_MS,
        toMs: nowMs,
        measures: ['requestCount'],
      }),
    ).rejects.toMatchObject({ code: 'STATISTICS_LIMIT', data: { limit: 'rangeDays', maximum: 366 } });
    await expect(
      dispatch(context, 'statistics.series', {
        fromMs: nowMs - 2 * DAY_MS,
        toMs: nowMs,
        measures: ['requestCount'],
        bucketMs: 60_000,
      }),
    ).rejects.toMatchObject({ code: 'STATISTICS_LIMIT', data: { limit: 'timeSeriesBuckets', maximum: 1_000 } });
    await expect(
      dispatch(context, 'statistics.summary', {
        fromMs: nowMs - 3 * DAY_MS,
        toMs: nowMs,
        measures: ['requestCount'],
        groupBy: ['sessionId'],
      }),
    ).rejects.toMatchObject({ code: 'STATISTICS_LIMIT', data: { limit: 'groups', maximum: 50 } });
    await expect(
      dispatch(context, 'statistics.series', {
        fromMs: nowMs - 3 * DAY_MS,
        toMs: nowMs,
        measures: [...STATISTICS_MEASURES],
        groupBy: ['logicalProvider', 'forwardedModel'],
        bucketMs: HOUR_MS,
      }),
    ).rejects.toMatchObject({ code: 'STATISTICS_LIMIT', data: { limit: 'outputItems', maximum: 10_000 } });

    // A query within the limits still succeeds on the same reader, and the
    // advertised limits are the ones enforced.
    await expect(
      dispatch(context, 'statistics.summary', { fromMs: nowMs - 3 * DAY_MS, toMs: nowMs, measures: ['requestCount'] }),
    ).resolves.toMatchObject([{ measure: 'requestCount', value: expect.any(Number) }]);
    await expect(dispatch(context, 'statistics.capabilities', {})).resolves.toMatchObject({
      available: true,
      maxScannedRows: 10_000,
      maxGroups: 50,
      health: { readerState: 'ready' },
    });
  });
});

// ---------------------------------------------------------------------------
// Readable labels
// ---------------------------------------------------------------------------

function exchange(
  exchangeId: string,
  attribution: { readonly personaId: string | null; readonly agentId: string; readonly profile: string },
): LlmExchangeCompleted {
  return {
    schemaVersion: 1,
    exchangeId,
    attribution: {
      sessionId: 'session-labels',
      agentConversationId: null,
      turnId: null,
      bundleId: null,
      workflowRunId: 'workflow-run-1',
      stateId: null,
      personaId: attribution.personaId,
      agentId: attribution.agentId,
      quality: 'exact',
    },
    route: {
      logicalProvider: 'anthropic',
      providerProfileId: attribution.profile,
      protocol: 'anthropic-messages',
      gatewayKind: 'direct',
      clientRouteId: 'api.anthropic.com',
      upstreamRouteId: 'api.anthropic.com',
    },
    identity: {
      requestedModel: { value: 'claude-sonnet-4-6', source: 'request' },
      forwardedModel: { value: 'claude-sonnet-4-6', source: 'forwarded_request' },
      responseModel: { value: 'claude-sonnet-4-6', source: 'protocol_response' },
      servedModel: { value: 'claude-sonnet-4-6', source: 'protocol_response_direct' },
      servedProvider: { value: null, source: 'not_exposed' },
    },
    responseMetadata: {
      providerRequestId: null,
      providerResponseId: null,
      gatewayGenerationId: null,
      actualServiceTier: null,
    },
    request: {
      requestedModel: 'claude-sonnet-4-6',
      streaming: true,
      requestedServiceTier: null,
      reasoningMode: 'disabled',
      reasoningEffort: null,
      thinkingBudgetTokens: null,
      speedMode: null,
      qualityFlags: [],
    },
    outcome: {
      termination: 'stop',
      providerStopReason: 'end_turn',
      responseStatus: 200,
      refusal: false,
      refusalCategory: null,
      refusalSource: 'not_reported',
    },
    usage: makeNormalizedUsage(),
    timing: {
      requestReceivedAt: new Date(Date.parse('2026-08-15T12:00:00.000Z')).toISOString(),
      requestBodyCompleteOffsetMs: 1,
      responseHeadersOffsetMs: 2,
      firstUpstreamBodyByteOffsetMs: 3,
      firstProtocolEventOffsetMs: 4,
      firstReasoningEventOffsetMs: null,
      lastReasoningEventOffsetMs: null,
      firstOutputEventOffsetMs: 5,
      lastOutputEventOffsetMs: 6,
      protocolTerminalOffsetMs: 7,
      upstreamResponseEndOffsetMs: 8,
      clientDeliveryEndOffsetMs: 9,
      clientAborted: false,
    },
    transportAttempts: [],
    gatewayRouteAttempts: [],
    qualityFlags: [],
  };
}

describe('statistics display labels', () => {
  const leases: LlmMetricsRuntimeLease[] = [];
  const databases: StatisticsTestDatabase[] = [];

  afterEach(async () => {
    await Promise.all(leases.splice(0).map((lease) => lease.release()));
    for (const database of databases.splice(0)) database.remove();
    vi.restoreAllMocks();
  });

  it('stores built-in agent ids raw and renders persona and profile pseudonyms by configured name', async () => {
    const database = createStatisticsTestDatabase('ironcurtain-statistics-labels-');
    databases.push(database);
    const lease = await acquireLlmMetricsRuntime({
      databasePath: database.databasePath,
      labelCandidates: () => ({
        personas: ['global', 'security-reviewer'],
        providerProfiles: ['native', 'work-openrouter'],
        agents: ['claude-code'],
      }),
    });
    leases.push(lease);
    const bus = getLlmMetricsEventBus();
    bus.publish(
      exchange('labels-1', { personaId: 'security-reviewer', agentId: 'claude-code', profile: 'work-openrouter' }),
    );
    bus.publish(
      exchange('labels-2', { personaId: 'security-reviewer', agentId: 'claude-code', profile: 'work-openrouter' }),
    );
    bus.publish(exchange('labels-3', { personaId: 'deleted-persona', agentId: 'custom-agent', profile: 'native' }));
    bus.publish(exchange('labels-4', { personaId: null, agentId: 'claude-code', profile: 'native' }));
    await lease.repository.flush();

    const range = { fromMs: Date.parse('2026-08-15T00:00:00.000Z'), toMs: Date.parse('2026-08-16T00:00:00.000Z') };
    const stored = await lease.repository.scan({ ...range, limit: 10 });
    expect(stored).toHaveLength(4);
    expect(stored.filter((row) => row.agent === 'claude-code')).toHaveLength(3);
    expect(stored.find((row) => row.exchangeId === 'labels-3')?.agent).toMatch(/^hmac:[a-f0-9]{32}$/);
    expect(stored.every((row) => row.personaId === null || /^hmac:/.test(row.personaId))).toBe(true);
    expect(JSON.stringify(stored)).not.toContain('security-reviewer');
    expect(JSON.stringify(stored)).not.toContain('work-openrouter');

    const personas = await lease.reader.summarize({ ...range, measures: ['requestCount'], groupBy: ['personaId'] });
    expect(personas.find((summary) => summary.value === 2)).toMatchObject({
      dimensions: { personaId: expect.stringMatching(/^hmac:/) },
      labels: { personaId: 'security-reviewer' },
    });
    // Unconfigured pseudonyms and missing values stay unlabelled.
    expect(personas.filter((summary) => summary.labels === undefined)).toHaveLength(2);

    const profiles = await lease.reader.dimensions({ ...range, dimension: 'providerProfile' });
    expect(profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'work-openrouter', count: 2 }),
        expect.objectContaining({ label: 'native', count: 2 }),
      ]),
    );
    const series = await lease.reader.timeSeries({
      ...range,
      measures: ['requestCount'],
      groupBy: ['personaId', 'providerProfile'],
      calendarBucket: { unit: 'day', timeZone: 'UTC' },
    });
    expect(series[0]?.summaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ labels: { personaId: 'security-reviewer', providerProfile: 'work-openrouter' } }),
      ]),
    );
  });

  it('labels agent ids that older rows stored as pseudonyms', async () => {
    const database = createStatisticsTestDatabase('ironcurtain-statistics-legacy-agent-');
    databases.push(database);
    const protector = createPersistenceIdentityProtector(database.directory);
    const fromMs = Date.parse('2026-08-15T00:00:00.000Z');
    database.insert([
      statisticsRow({ completedAtMs: fromMs + 1, agent: protector.protectLabel('agent', 'goose') }),
      statisticsRow({ completedAtMs: fromMs + 2, agent: 'goose' }),
    ]);
    const reader = openSqliteLlmMetricsReader({ databasePath: database.databasePath });
    try {
      const service = new LlmStatisticsQueryService(reader, {
        labels: createStatisticsLabelResolver(protector, () => ({
          personas: [],
          providerProfiles: [],
          agents: ['goose'],
        })),
      });
      const agents = await service.dimensions({ fromMs, toMs: fromMs + 10, dimension: 'agent' });
      expect(agents).toEqual(
        expect.arrayContaining([
          { value: 'goose', count: 1 },
          { value: expect.stringMatching(/^hmac:/), label: 'goose', count: 1 },
        ]),
      );
    } finally {
      await reader.close();
    }
  });
});
