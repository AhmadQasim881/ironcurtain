import { afterEach, describe, expect, it, vi } from 'vitest';

import { LlmStatisticsQueryService } from '../src/llm-metrics/query-service.js';
import { STATISTICS_MEASURES, StatisticsLimitError } from '../src/llm-metrics/query-contract.js';
import {
  openSqliteLlmMetricsReader,
  type SqliteLlmMetricsReader,
} from '../src/llm-metrics/persistence/sqlite-repository.js';
import type {
  LlmDimensionCount,
  LlmExchangeScanQuery,
  LlmMetricsReadRepository,
  StoredLlmExchange,
} from '../src/llm-metrics/persistence/repository.js';
import {
  createStatisticsTestDatabase,
  statisticsRow,
  type StatisticsTestDatabase,
  type StatisticsTestRow,
} from './helpers/llm-statistics-db.js';

const BASE_TIME = Date.parse('2026-08-15T12:00:00.000Z');
const ALL_MEASURES = STATISTICS_MEASURES;

function row(index: number, overrides: Partial<StoredLlmExchange> = {}): StatisticsTestRow {
  return statisticsRow({
    exchangeId: `exchange-${index}`,
    completedAtMs: BASE_TIME + index,
    servedModel: 'model-1',
    sessionId: 'session-1',
    providerProfile: 'profile-1',
    ...overrides,
  });
}

/** In-memory repository for the paths that still page raw rows (exchange lists) or read dimension counts. */
function fakeRepository(
  rows: readonly StoredLlmExchange[],
  dimensionValues: readonly LlmDimensionCount[] = [],
): LlmMetricsReadRepository {
  const unexpected = () => Promise.reject(new Error('aggregation is not expected here'));
  return {
    health: vi.fn().mockReturnValue({ state: 'ready', schemaVersion: 1, readerState: 'ready' }),
    snapshotMaxSequence: vi.fn().mockResolvedValue(rows.length),
    scan: vi.fn().mockImplementation((query: LlmExchangeScanQuery) => Promise.resolve(rows.slice(0, query.limit))),
    dimensionValues: vi.fn().mockResolvedValue(dimensionValues),
    aggregate: vi.fn(unexpected),
    distribution: vi.fn(unexpected),
    sessionTotals: vi.fn(unexpected),
  };
}

describe('LLM statistics query output safety', () => {
  const databases: StatisticsTestDatabase[] = [];
  const readers: SqliteLlmMetricsReader[] = [];

  /** A real reader over rows seeded into a fresh database; `scan` is counted. */
  function seeded(rows: readonly StatisticsTestRow[]): { repository: LlmMetricsReadRepository; scans: () => number } {
    const database = createStatisticsTestDatabase();
    databases.push(database);
    database.insert(rows);
    const reader = openSqliteLlmMetricsReader({ databasePath: database.databasePath });
    readers.push(reader);
    let scans = 0;
    return {
      repository: {
        ...reader,
        scan: (query) => {
          scans += 1;
          return reader.scan(query);
        },
      },
      scans: () => scans,
    };
  }

  afterEach(async () => {
    await Promise.all(readers.splice(0).map((reader) => reader.close()));
    for (const database of databases.splice(0)) database.remove();
    vi.restoreAllMocks();
  });

  it('summarizes past the former 10,000-row and scanned-byte limits without paging rows into this thread', async () => {
    const rows = Array.from({ length: 40_001 }, (_, index) =>
      row(index, { qualityFlags: ['router_metadata_present', 'usage_only_observation'] }),
    );
    const { repository, scans } = seeded(rows);
    const service = new LlmStatisticsQueryService(repository);
    await expect(
      service.summarize({ fromMs: BASE_TIME, toMs: BASE_TIME + 50_000, measures: ['requestCount', 'totalTokens'] }),
    ).resolves.toMatchObject([
      { measure: 'requestCount', value: 40_001 },
      { measure: 'totalTokens', value: 40_001 * 15 },
    ]);
    expect(scans()).toBe(0);
  });

  it('rejects a query over the scanned-row limit before aggregating', async () => {
    const { repository } = seeded(Array.from({ length: 1_001 }, (_, index) => row(index)));
    const service = new LlmStatisticsQueryService(repository, { limits: { maxScannedRows: 1_000 } });
    const query = { fromMs: BASE_TIME, toMs: BASE_TIME + 2_000, measures: ALL_MEASURES };

    const rejection = service.summarize(query);
    await expect(rejection).rejects.toBeInstanceOf(StatisticsLimitError);
    await expect(rejection).rejects.toMatchObject({ code: 'STATISTICS_LIMIT', limit: 'scannedRows', maximum: 1_000 });
    await expect(service.summarize({ ...query, toMs: BASE_TIME + 999 })).resolves.toHaveLength(ALL_MEASURES.length);
  });

  it('assigns calendar buckets without per-row work on this thread', async () => {
    const rows = Array.from({ length: 5_000 }, (_, index) => row(index, { completedAtMs: BASE_TIME + index * 1_000 }));
    const service = new LlmStatisticsQueryService(seeded(rows).repository);
    const formatToParts = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
    const result = await service.timeSeries({
      fromMs: BASE_TIME,
      toMs: BASE_TIME + 5_000_000,
      measures: ['requestCount'],
      calendarBucket: { unit: 'day', timeZone: 'America/Los_Angeles' },
    });
    expect(result.reduce((total, bucket) => total + (bucket.summaries[0]?.value ?? 0), 0)).toBe(rows.length);
    // Day boundaries are computed once per query inside the reader worker, never per row here.
    expect(formatToParts).not.toHaveBeenCalled();
  });

  it('ranks top groups over the whole range and retains a ranked null-identity group', async () => {
    const rows = [
      row(0, { completedAtMs: BASE_TIME, servedModel: null }),
      row(1, { completedAtMs: BASE_TIME + 1, servedModel: null }),
      row(2, { completedAtMs: BASE_TIME + 2, servedModel: 'model-a' }),
      row(3, { completedAtMs: BASE_TIME + 3, servedModel: 'model-b' }),
      row(4, { completedAtMs: BASE_TIME + 4, servedModel: 'model-b' }),
      row(5, { completedAtMs: BASE_TIME + 5, servedModel: 'model-b' }),
      row(6, { completedAtMs: BASE_TIME + 60_000, servedModel: null }),
      row(7, { completedAtMs: BASE_TIME + 60_001, servedModel: null }),
      row(8, { completedAtMs: BASE_TIME + 60_002, servedModel: 'model-a' }),
      row(9, { completedAtMs: BASE_TIME + 60_003, servedModel: 'model-a' }),
      row(10, { completedAtMs: BASE_TIME + 60_004, servedModel: 'model-a' }),
      row(11, { completedAtMs: BASE_TIME + 60_005, servedModel: 'model-a' }),
    ];
    const service = new LlmStatisticsQueryService(seeded(rows).repository);

    const summary = await service.summarize({
      fromMs: BASE_TIME,
      toMs: BASE_TIME + 120_000,
      measures: ['requestCount'],
      groupBy: ['servedModel'],
      topGroups: 2,
    });
    expect(summary).toEqual([
      expect.objectContaining({ dimensions: { servedModel: 'model-a' }, value: 5 }),
      expect.objectContaining({ dimensions: { servedModel: null }, value: 4 }),
    ]);

    const series = await service.timeSeries({
      fromMs: BASE_TIME,
      toMs: BASE_TIME + 120_000,
      measures: ['requestCount'],
      groupBy: ['servedModel'],
      topGroups: 1,
      bucketMs: 60_000,
    });
    expect(series).toHaveLength(2);
    expect(series.flatMap((bucket) => bucket.summaries)).toEqual([
      expect.objectContaining({ dimensions: { servedModel: 'model-a' }, value: 1 }),
      expect.objectContaining({ dimensions: { servedModel: 'model-a' }, value: 4 }),
    ]);
  });

  it('breaks top-group ties deterministically by value', async () => {
    const rows = Array.from({ length: 30 }, (_, index) => row(index, { servedModel: `model-${index % 10}` }));
    const service = new LlmStatisticsQueryService(seeded(rows).repository);
    const result = await service.summarize({
      fromMs: BASE_TIME,
      toMs: BASE_TIME + 100,
      measures: ['requestCount'],
      groupBy: ['servedModel'],
      topGroups: 8,
    });
    expect(result.map((summary) => summary.dimensions.servedModel)).toEqual(
      Array.from({ length: 8 }, (_, index) => `model-${index}`),
    );
    expect(result.every((summary) => summary.value === 3)).toBe(true);
  });

  it('retains authoritative daily signals outside the grouped top-provider cutoff', async () => {
    const dayFromMs = Date.parse('2026-08-15T00:00:00.000Z');
    const dayToMs = Date.parse('2026-08-15T23:59:59.999Z');
    const rows = Array.from({ length: 9 }, (_, index) => {
      const rank = index + 1;
      const outsideTopGroups = rank === 9;
      return row(index, {
        completedAtMs: dayFromMs + rank,
        logicalProvider: `provider-${String(rank).padStart(2, '0')}`,
        forwardedModel: `model-${String(rank).padStart(2, '0')}`,
        refusal: outsideTopGroups,
        outcome: outsideTopGroups ? 'error' : 'stop',
      });
    });
    const service = new LlmStatisticsQueryService(seeded(rows).repository);

    const grouped = await service.timeSeries({
      fromMs: dayFromMs,
      toMs: dayToMs,
      measures: ['refusalCount', 'errorCount'],
      groupBy: ['logicalProvider', 'forwardedModel'],
      topGroups: 8,
      calendarBucket: { unit: 'day', timeZone: 'UTC' },
    });
    const groupedSummaries = grouped.flatMap((bucket) => bucket.summaries);
    expect(groupedSummaries).toHaveLength(16);
    expect(groupedSummaries.some((summary) => summary.dimensions.logicalProvider === 'provider-09')).toBe(false);
    expect(groupedSummaries.every((summary) => summary.value === 0)).toBe(true);

    const authoritative = await service.timeSeries({
      fromMs: dayFromMs,
      toMs: dayToMs,
      measures: ['refusalCount', 'errorCount'],
      calendarBucket: { unit: 'day', timeZone: 'UTC' },
    });
    expect(authoritative).toHaveLength(1);
    expect(authoritative[0]?.summaries).toEqual([
      expect.objectContaining({ dimensions: {}, measure: 'refusalCount', value: 1 }),
      expect.objectContaining({ dimensions: {}, measure: 'errorCount', value: 1 }),
    ]);
  });

  it('rejects a list page whose valid bounded rows exceed the byte budget', async () => {
    const longFlag = `flag-${'x'.repeat(251)}`;
    const rows = Array.from({ length: 300 }, (_, index) =>
      row(index, { qualityFlags: Array.from({ length: 64 }, () => longFlag) }),
    );
    const service = new LlmStatisticsQueryService(fakeRepository(rows));

    const rejection = service.listExchanges({ fromMs: BASE_TIME, toMs: BASE_TIME + 1_000, limit: 500 });
    await expect(rejection).rejects.toThrow('Statistics response exceeds the output-byte limit');
    await expect(rejection).rejects.toMatchObject({ code: 'STATISTICS_LIMIT', limit: 'outputBytes' });
  });

  it('rejects grouped summaries with high-cardinality maximum-length identifiers', async () => {
    const longSession = `session-${'s'.repeat(248)}`;
    const longProfile = `profile-${'p'.repeat(248)}`;
    const rows = Array.from({ length: 500 }, (_, index) => {
      const prefix = `model-${index}-`;
      return row(index, {
        servedModel: prefix + 'm'.repeat(256 - prefix.length),
        sessionId: longSession,
        providerProfile: longProfile,
      });
    });
    const service = new LlmStatisticsQueryService(seeded(rows).repository);

    await expect(
      service.summarize({
        fromMs: BASE_TIME,
        toMs: BASE_TIME + 1_000,
        measures: ALL_MEASURES,
        groupBy: ['servedModel', 'sessionId', 'providerProfile'],
      }),
    ).rejects.toThrow('Statistics response exceeds the output-byte limit');
  });

  it('caps buckets multiplied by measures across an entire time series', async () => {
    const rows = Array.from({ length: 600 }, (_, index) => row(index, { completedAtMs: BASE_TIME + index * 60_000 }));
    const service = new LlmStatisticsQueryService(seeded(rows).repository);

    await expect(
      service.timeSeries({
        fromMs: BASE_TIME,
        toMs: BASE_TIME + 600 * 60_000,
        bucketMs: 60_000,
        measures: ALL_MEASURES,
      }),
    ).rejects.toThrow('Statistics response exceeds the output-cardinality limit');
  });

  it('caps the groups of one summary', async () => {
    const rows = Array.from({ length: 501 }, (_, index) => row(index, { sessionId: `session-${index}` }));
    const service = new LlmStatisticsQueryService(seeded(rows).repository);

    await expect(
      service.summarize({
        fromMs: BASE_TIME,
        toMs: BASE_TIME + 1_000,
        measures: ['requestCount'],
        groupBy: ['sessionId'],
      }),
    ).rejects.toMatchObject({ code: 'STATISTICS_LIMIT', limit: 'groups', maximum: 500 });
  });

  it('enforces the byte budget on dimension results', async () => {
    const values = Array.from({ length: 500 }, (_, index) => ({
      value: `dimension-${index}-${'x'.repeat(10_000)}`,
      count: 1,
    }));
    const service = new LlmStatisticsQueryService(fakeRepository([], values));

    await expect(
      service.dimensions({ fromMs: BASE_TIME, toMs: BASE_TIME + 1_000, dimension: 'servedModel', limit: 500 }),
    ).rejects.toThrow('Statistics response exceeds the output-byte limit');
  });

  it('preserves normal list, summary, series, and dimension queries', async () => {
    const rows = [row(0), row(1, { completedAtMs: BASE_TIME + 60_000, servedModel: null })];
    const service = new LlmStatisticsQueryService(seeded(rows).repository);

    await expect(
      service.listExchanges({ fromMs: BASE_TIME, toMs: BASE_TIME + 120_000, limit: 2 }),
    ).resolves.toMatchObject({
      items: [{ exchangeId: rows[1]?.exchangeId }, { exchangeId: rows[0]?.exchangeId }],
      nextCursor: null,
    });
    await expect(
      service.summarize({
        fromMs: BASE_TIME,
        toMs: BASE_TIME + 120_000,
        measures: ['requestCount', 'totalTokens'],
      }),
    ).resolves.toHaveLength(2);
    await expect(
      service.timeSeries({
        fromMs: BASE_TIME,
        toMs: BASE_TIME + 120_000,
        bucketMs: 60_000,
        measures: ['requestCount'],
      }),
    ).resolves.toHaveLength(2);
    await expect(
      service.dimensions({ fromMs: BASE_TIME, toMs: BASE_TIME + 120_000, dimension: 'servedModel' }),
    ).resolves.toEqual([
      { value: null, count: 1 },
      { value: 'model-1', count: 1 },
    ]);
  });

  it('returns sample-session counts and a bounded coverage-aware distribution', async () => {
    const rows = [
      row(0, { sessionId: 'session-1', outputTokens: 20, clientDeliveryEndOffsetMs: 200 }),
      row(1, { sessionId: 'session-1', outputTokens: 40, clientDeliveryEndOffsetMs: 200 }),
      row(2, { sessionId: 'session-2', outputTokens: 30, clientDeliveryEndOffsetMs: 100 }),
      row(3, { sessionId: null, outputTokens: null, clientDeliveryEndOffsetMs: 100 }),
    ];
    const service = new LlmStatisticsQueryService(seeded(rows).repository);

    await expect(
      service.summarize({
        fromMs: BASE_TIME,
        toMs: BASE_TIME + 1_000,
        measures: ['requestCount', 'effectiveOutputTokensPerSecond'],
      }),
    ).resolves.toMatchObject([
      { measure: 'requestCount', sampleCount: 4, sampleSessionCount: 2 },
      { measure: 'effectiveOutputTokensPerSecond', sampleCount: 3, sampleSessionCount: 2, median: 200 },
    ]);

    const distribution = await service.distribution({
      fromMs: BASE_TIME,
      toMs: BASE_TIME + 1_000,
      measure: 'effectiveOutputTokensPerSecond',
      maxBins: 4,
    });
    expect(distribution).toMatchObject({
      measure: 'effectiveOutputTokensPerSecond',
      sampleCount: 3,
      eligibleCount: 4,
      coverage: 0.75,
      minimum: 100,
      maximum: 300,
    });
    expect(distribution.bins.length).toBeLessThanOrEqual(4);
    expect(distribution.bins.reduce((total, bin) => total + bin.count, 0)).toBe(3);
  });

  it('uses true IANA calendar-day boundaries across daylight-saving fallback', async () => {
    const rows = [
      row(0, { completedAtMs: Date.parse('2026-11-01T08:00:00.000Z') }),
      row(1, { completedAtMs: Date.parse('2026-11-02T09:00:00.000Z') }),
    ];
    const service = new LlmStatisticsQueryService(seeded(rows).repository);
    const buckets = await service.timeSeries({
      fromMs: Date.parse('2026-11-01T07:00:00.000Z'),
      toMs: Date.parse('2026-11-03T07:59:59.999Z'),
      measures: ['requestCount'],
      calendarBucket: { unit: 'day', timeZone: 'America/Los_Angeles' },
    });

    expect(buckets.map(({ fromMs, toMs }) => [fromMs, toMs])).toEqual([
      [Date.parse('2026-11-01T07:00:00.000Z'), Date.parse('2026-11-02T08:00:00.000Z')],
      [Date.parse('2026-11-02T08:00:00.000Z'), Date.parse('2026-11-03T08:00:00.000Z')],
    ]);
    expect(buckets[0].toMs - buckets[0].fromMs).toBe(25 * 60 * 60 * 1_000);
  });

  it('uses a 23-hour IANA calendar day across daylight-saving spring-forward', async () => {
    const service = new LlmStatisticsQueryService(
      seeded([row(0, { completedAtMs: Date.parse('2026-03-08T12:00:00.000Z') })]).repository,
    );
    const buckets = await service.timeSeries({
      fromMs: Date.parse('2026-03-08T08:00:00.000Z'),
      toMs: Date.parse('2026-03-09T06:59:59.999Z'),
      measures: ['requestCount'],
      calendarBucket: { unit: 'day', timeZone: 'America/Los_Angeles' },
    });

    expect(buckets).toMatchObject([
      {
        fromMs: Date.parse('2026-03-08T08:00:00.000Z'),
        toMs: Date.parse('2026-03-09T07:00:00.000Z'),
      },
    ]);
    expect(buckets[0].toMs - buckets[0].fromMs).toBe(23 * 60 * 60 * 1_000);
  });

  it('starts a bucket at a mid-day range start and skips a calendar day a time zone never had', async () => {
    // Pacific/Apia skipped 2011-12-30 entirely when it moved across the date line.
    const rows = [
      row(0, { completedAtMs: Date.parse('2011-12-29T12:00:00.000Z') }),
      row(1, { completedAtMs: Date.parse('2011-12-30T12:00:00.000Z') }),
    ];
    const service = new LlmStatisticsQueryService(seeded(rows).repository);
    const buckets = await service.timeSeries({
      fromMs: Date.parse('2011-12-29T11:00:00.000Z'),
      toMs: Date.parse('2011-12-31T10:59:59.999Z'),
      measures: ['requestCount'],
      calendarBucket: { unit: 'day', timeZone: 'Pacific/Apia' },
    });
    expect(buckets.map((bucket) => bucket.summaries[0]?.value)).toEqual([1, 1]);
    expect(buckets[0]?.fromMs).toBe(Date.parse('2011-12-29T11:00:00.000Z'));
    // The local day after 2011-12-29 is 2011-12-31, which starts at 2011-12-30T10:00Z.
    expect(buckets[0]?.toMs).toBe(Date.parse('2011-12-30T10:00:00.000Z'));
    expect(buckets[1]?.fromMs).toBe(Date.parse('2011-12-30T10:00:00.000Z'));
  });
});
