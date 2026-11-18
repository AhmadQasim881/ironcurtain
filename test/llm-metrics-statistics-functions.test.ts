import { describe, expect, it, vi } from 'vitest';

import { BottomKSample, quantile, sampleHash } from '../src/llm-metrics/persistence/statistics-functions.js';
import { calendarDayStarts } from '../src/llm-metrics/statistics-calendar.js';
import { createStatisticsLabelResolver } from '../src/llm-metrics/statistics-labels.js';

describe('bounded quartile sample', () => {
  it('keeps the same values whatever order rows arrive in', () => {
    const values = Array.from({ length: 5_000 }, (_, index) => ({
      sequence: index + 1,
      value: (index * 7_919) % 1_000,
    }));
    const forward = new BottomKSample(64);
    const backward = new BottomKSample(64);
    for (const { sequence, value } of values) forward.offer(sampleHash(sequence), sequence, value);
    for (const { sequence, value } of [...values].reverse()) backward.offer(sampleHash(sequence), sequence, value);
    expect(forward.size).toBe(64);
    expect(forward.sortedValues()).toEqual(backward.sortedValues());

    const expected = [...values]
      .sort((left, right) => sampleHash(left.sequence) - sampleHash(right.sequence) || left.sequence - right.sequence)
      .slice(0, 64)
      .map(({ value }) => value)
      .sort((left, right) => left - right);
    expect(forward.sortedValues()).toEqual(expected);
  });

  it('keeps every value while fewer than its capacity arrive', () => {
    const sample = new BottomKSample(16);
    for (const value of [5, 1, 4, 2, 3]) sample.offer(sampleHash(value), value, value);
    expect(sample.sortedValues()).toEqual([1, 2, 3, 4, 5]);
  });

  it('hashes distinct sequence numbers to distinct keys', () => {
    const hashes = new Set(Array.from({ length: 200_000 }, (_, index) => sampleHash(index + 1)));
    expect(hashes.size).toBe(200_000);
  });

  it('interpolates quartiles linearly', () => {
    expect(quantile([], 0.5)).toBeNull();
    expect(quantile([10], 0.25)).toBe(10);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4], 0.25)).toBe(1.75);
  });
});

describe('calendar-day boundaries', () => {
  it('follows 23- and 25-hour days and stops at the range end', () => {
    const starts = calendarDayStarts(
      Date.parse('2026-03-07T08:00:00.000Z'),
      Date.parse('2026-03-09T06:59:59.999Z'),
      'America/Los_Angeles',
      10,
    );
    expect(starts).toEqual([Date.parse('2026-03-07T08:00:00.000Z'), Date.parse('2026-03-08T08:00:00.000Z')]);
    const fall = calendarDayStarts(
      Date.parse('2026-10-31T19:00:00.000Z'),
      Date.parse('2026-11-02T08:00:00.000Z'),
      'America/Los_Angeles',
      10,
    );
    expect(fall).toEqual([
      Date.parse('2026-10-31T19:00:00.000Z'),
      Date.parse('2026-11-01T07:00:00.000Z'),
      Date.parse('2026-11-02T08:00:00.000Z'),
    ]);
  });

  it('computes a whole year in a bounded number of formatter calls and refuses too many buckets', () => {
    const formatToParts = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
    try {
      const fromMs = Date.parse('2025-11-11T00:00:00.000Z');
      // Mid-day local start (UTC+11 in November): 365 whole local days plus a partial one at each end.
      const starts = calendarDayStarts(fromMs, fromMs + 366 * 86_400_000 - 1, 'Australia/Lord_Howe', 400);
      expect(starts).toHaveLength(367);
      expect(formatToParts.mock.calls.length).toBeLessThan(366 * 4 + 64);
      expect(calendarDayStarts(fromMs, fromMs + 30 * 86_400_000, 'UTC', 30)).toBeNull();
    } finally {
      formatToParts.mockRestore();
    }
  });
});

describe('statistics label resolver', () => {
  const protector = {
    protectLabel: (namespace: string, value: string) =>
      `hmac:${namespace === 'persona' ? 'a' : 'b'}${value.length.toString(16).padStart(31, '0')}`,
  };

  it('labels only pseudonyms of configured names, and only for the matching dimension', () => {
    const resolver = createStatisticsLabelResolver(protector, () => ({
      personas: ['coder'],
      providerProfiles: ['native-x'],
      agents: [],
    }));
    const personaPseudonym = protector.protectLabel('persona', 'coder');
    expect(resolver.label('personaId', personaPseudonym)).toBe('coder');
    expect(resolver.label('providerProfile', personaPseudonym)).toBeUndefined();
    expect(resolver.label('providerProfile', protector.protectLabel('profile', 'native-x'))).toBe('native-x');
    expect(resolver.label('personaId', 'coder')).toBeUndefined();
    expect(resolver.label('personaId', null)).toBeUndefined();
    expect(resolver.label('servedModel', personaPseudonym)).toBeUndefined();
  });

  it('re-reads configured names after its cache expires and survives a failing source', () => {
    let now = 0;
    const source = vi
      .fn()
      .mockReturnValueOnce({ personas: [], providerProfiles: [], agents: [] })
      .mockImplementationOnce(() => {
        throw new Error('config unreadable');
      })
      .mockReturnValue({ personas: ['coder'], providerProfiles: [], agents: [] });
    const resolver = createStatisticsLabelResolver(protector, source, { cacheTtlMs: 1_000, now: () => now });
    const pseudonym = protector.protectLabel('persona', 'coder');
    expect(resolver.label('personaId', pseudonym)).toBeUndefined();
    now = 500;
    expect(resolver.label('personaId', pseudonym)).toBeUndefined();
    expect(source).toHaveBeenCalledTimes(1);
    now = 1_500;
    expect(resolver.label('personaId', pseudonym)).toBeUndefined();
    now = 3_000;
    expect(resolver.label('personaId', pseudonym)).toBe('coder');
    expect(source).toHaveBeenCalledTimes(3);
  });
});
