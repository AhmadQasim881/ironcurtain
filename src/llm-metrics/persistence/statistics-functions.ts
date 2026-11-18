/**
 * Bounded SQL aggregate functions registered on the statistics reader's
 * connection, plus the pure helpers their results feed.
 *
 * SQLite computes sums, counts and means natively. Three statistics need
 * per-group state that SQL cannot express cheaply, so they run as aggregate
 * callbacks inside the reader worker (never on the daemon's main thread):
 *
 * - distinct sessions per measure: one bit mask per distinct session;
 * - median and quartiles: a deterministic bottom-k sample per measure (the
 *   `k` rows with the smallest hash of their ingestion sequence), so the
 *   quartiles are exact up to `k` values and stable across repeated queries;
 * - distribution bin counts for a precomputed bin layout.
 *
 * The first two share one callback, so each row crosses into JavaScript once.
 * SQLite feeds one GROUP BY group at a time, so at most one group's state is
 * live per call. Loaded inside the persistence worker through native type
 * stripping: keep it self-contained, erasable TypeScript.
 */

import type { AggregateOptions, DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite';

export const PARTITION_STATISTICS_FUNCTION = 'ironcurtain_statistics_partition';
export const HISTOGRAM_FUNCTION = 'ironcurtain_statistics_histogram';

/** Sample values one partition call may carry; each is one bit of a 32-bit mask. */
export const MAX_PARTITION_VALUES = 31;
const MAX_HISTOGRAM_BINS = 1_000;

/** Linear-interpolation quantile of an ascending array (the formula the API has always used). */
export function quantile(sorted: readonly number[], position: number): number | null {
  if (sorted.length === 0) return null;
  const index = (sorted.length - 1) * position;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const low = sorted[lower] as number | undefined;
  const high = sorted[upper] as number | undefined;
  if (low === undefined || high === undefined) return null;
  if (lower === upper) return low;
  return low + (high - low) * (index - lower);
}

/** Bijective 32-bit mix (murmur3 fmix32) of the low and folded high bits of a sequence number. */
export function sampleHash(sequence: number): number {
  let hash = (sequence ^ Math.floor(sequence / 0x1_0000_0000)) >>> 0;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/**
 * Keeps the `capacity` values whose (hash, sequence) keys are smallest: a
 * max-heap on that key. The retained set does not depend on row order.
 */
export class BottomKSample {
  private readonly capacity: number;
  private readonly hashes: number[] = [];
  private readonly sequences: number[] = [];
  private readonly values: number[] = [];

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  get size(): number {
    return this.values.length;
  }

  offer(hash: number, sequence: number, value: number): void {
    if (this.values.length < this.capacity) {
      this.hashes.push(hash);
      this.sequences.push(sequence);
      this.values.push(value);
      this.siftUp(this.values.length - 1);
      return;
    }
    if (!this.precedes(hash, sequence, 0)) return;
    this.hashes[0] = hash;
    this.sequences[0] = sequence;
    this.values[0] = value;
    this.siftDown(0);
  }

  sortedValues(): number[] {
    return [...this.values].sort((left, right) => left - right);
  }

  /** True when (hash, sequence) sorts before the key at `index`. */
  private precedes(hash: number, sequence: number, index: number): boolean {
    const otherHash = this.hashes[index] ?? Number.POSITIVE_INFINITY;
    return hash < otherHash || (hash === otherHash && sequence < (this.sequences[index] ?? Number.POSITIVE_INFINITY));
  }

  /** True when the key at `left` sorts before the key at `right`. */
  private less(left: number, right: number): boolean {
    return this.precedes(this.hashes[left] ?? 0, this.sequences[left] ?? 0, right);
  }

  private swap(left: number, right: number): void {
    for (const array of [this.hashes, this.sequences, this.values]) {
      const value = array[left] ?? 0;
      array[left] = array[right] ?? 0;
      array[right] = value;
    }
  }

  private siftUp(start: number): void {
    let index = start;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!this.less(parent, index)) return;
      this.swap(parent, index);
      index = parent;
    }
  }

  private siftDown(start: number): void {
    let index = start;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let largest = index;
      if (left < this.values.length && this.less(largest, left)) largest = left;
      if (right < this.values.length && this.less(largest, right)) largest = right;
      if (largest === index) return;
      this.swap(index, largest);
      index = largest;
    }
  }
}

function finiteNumber(value: SQLOutputValue | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

interface PartitionState {
  /** -1 until the first row fixes the shape of this call. */
  valueCount: number;
  capacity: number;
  quantileMask: number;
  readonly sessions: Map<string, number>;
  readonly samples: (BottomKSample | null)[];
}

export interface PartitionStatistics {
  /** Distinct non-null sessions among rows where value `i` is not null. */
  readonly sessions: readonly number[];
  /** `[lowerQuartile, median, upperQuartile]` of value `i`, or null when not requested or never present. */
  readonly quartiles: readonly ([number, number, number] | null)[];
}

interface HistogramState {
  counts: number[] | null;
}

function boundedPositiveInteger(value: SQLOutputValue | undefined, maximum: number, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`Invalid statistics ${name}`);
  }
  return value;
}

interface StatefulAggregate<State> {
  readonly directOnly: boolean;
  readonly varargs?: boolean;
  readonly start: () => State;
  readonly step: (state: State, ...args: SQLOutputValue[]) => State;
  readonly result: (state: State) => SQLInputValue;
}

/**
 * Node's `aggregate()` accepts any JavaScript value as the accumulator (its
 * documentation allows an Object, or a Function returning a fresh one per
 * group); the @types/node signature narrows it to SQL values. The state never
 * reaches SQLite: `result()` always returns a SQL value.
 */
function registerAggregate<State>(database: DatabaseSync, name: string, aggregate: StatefulAggregate<State>): void {
  database.aggregate(name, aggregate as unknown as AggregateOptions);
}

/** Register the bounded aggregates on a reader connection. Safe to call once per connection. */
export function registerStatisticsFunctions(database: DatabaseSync, maxSampleSize: number): void {
  // (sampleSize, quantileMask, ingestion_sequence, session_id, value0, ..., valueN)
  // -> JSON PartitionStatistics. A value marks its row as sampled for that
  // measure when it is not NULL; bit i of quantileMask asks for its quartiles.
  registerAggregate<PartitionState>(database, PARTITION_STATISTICS_FUNCTION, {
    directOnly: true,
    varargs: true,
    start: (): PartitionState => ({ valueCount: -1, capacity: 0, quantileMask: 0, sessions: new Map(), samples: [] }),
    step: (
      state: PartitionState,
      sampleSize?: SQLOutputValue,
      quantileMask?: SQLOutputValue,
      sequence?: SQLOutputValue,
      sessionId?: SQLOutputValue,
      ...values: SQLOutputValue[]
    ) => {
      if (state.valueCount === -1) {
        if (values.length > MAX_PARTITION_VALUES) throw new Error('Too many statistics partition values');
        state.valueCount = values.length;
        state.capacity = boundedPositiveInteger(sampleSize, maxSampleSize, 'quantile sample size');
        if (typeof quantileMask !== 'number' || !Number.isSafeInteger(quantileMask) || quantileMask < 0) {
          throw new Error('Invalid statistics quantile mask');
        }
        state.quantileMask = quantileMask;
        for (let index = 0; index < values.length; index++) state.samples.push(null);
      }
      if (values.length !== state.valueCount) throw new Error('Inconsistent statistics partition values');
      let present = 0;
      let hash = -1;
      for (let index = 0; index < values.length; index++) {
        const value = values[index];
        if (value === null) continue;
        const bit = 1 << index;
        present |= bit;
        if ((state.quantileMask & bit) === 0) continue;
        const measured = finiteNumber(value);
        if (measured === null) continue;
        if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence)) {
          throw new Error('Invalid statistics sample sequence');
        }
        if (hash === -1) hash = sampleHash(sequence);
        let sample = state.samples[index] ?? null;
        if (sample === null) {
          sample = new BottomKSample(state.capacity);
          state.samples[index] = sample;
        }
        sample.offer(hash, sequence, measured);
      }
      if (present !== 0 && typeof sessionId === 'string') {
        state.sessions.set(sessionId, (state.sessions.get(sessionId) ?? 0) | present);
      }
      return state;
    },
    result: (state: PartitionState): string => {
      const valueCount = Math.max(0, state.valueCount);
      const sessions = Array.from({ length: valueCount }, () => 0);
      for (const present of state.sessions.values()) {
        for (let index = 0; index < valueCount; index++) {
          if ((present & (1 << index)) !== 0) sessions[index] = (sessions[index] ?? 0) + 1;
        }
      }
      const quartiles = state.samples.map((sample) => {
        if (sample === null || sample.size === 0) return null;
        const sorted = sample.sortedValues();
        return [quantile(sorted, 0.25), quantile(sorted, 0.5), quantile(sorted, 0.75)];
      });
      return JSON.stringify({ sessions, quartiles });
    },
  });

  // (lower, width, binCount, value) -> JSON array of counts per bin.
  registerAggregate<HistogramState>(database, HISTOGRAM_FUNCTION, {
    directOnly: true,
    start: (): HistogramState => ({ counts: null }),
    step: (
      state: HistogramState,
      lower?: SQLOutputValue,
      width?: SQLOutputValue,
      binCount?: SQLOutputValue,
      value?: SQLOutputValue,
    ) => {
      const bins = boundedPositiveInteger(binCount, MAX_HISTOGRAM_BINS, 'histogram bin count');
      const origin = finiteNumber(lower);
      const binWidth = finiteNumber(width);
      if (origin === null || binWidth === null || binWidth <= 0) throw new Error('Invalid statistics histogram');
      state.counts ??= Array.from({ length: bins }, () => 0);
      const measured = finiteNumber(value);
      if (measured === null) return state;
      const index = Math.min(bins - 1, Math.max(0, Math.floor((measured - origin) / binWidth)));
      state.counts[index] = (state.counts[index] ?? 0) + 1;
      return state;
    },
    result: (state: HistogramState): string => JSON.stringify(state.counts ?? []),
  });
}

function niceCeiling(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const ceiling = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return ceiling * magnitude;
}

export interface DistributionLayout {
  readonly lower: number;
  readonly width: number;
  readonly binCount: number;
}

/**
 * Freedman-Diaconis bin layout over at most `maxBins` "nice" bins, from the
 * exact sample count, minimum and maximum and the (sampled) interquartile
 * range. Null when every sample has the same value (one bin covers them).
 */
export function distributionLayout(
  sampleCount: number,
  minimum: number,
  maximum: number,
  interquartileRange: number,
  maxBins: number,
): DistributionLayout | null {
  if (minimum === maximum) return null;
  const rawWidth = interquartileRange > 0 ? (2 * interquartileRange) / Math.cbrt(sampleCount) : 0;
  const desiredBins = Math.max(
    1,
    Math.min(maxBins, rawWidth > 0 ? Math.ceil((maximum - minimum) / rawWidth) : Math.ceil(Math.sqrt(sampleCount))),
  );
  let width = niceCeiling((maximum - minimum) / desiredBins);
  let lower = Math.floor(minimum / width) * width;
  let binCount = Math.max(1, Math.ceil((maximum - lower) / width));
  while (binCount > maxBins) {
    width = niceCeiling(width * 1.01);
    lower = Math.floor(minimum / width) * width;
    binCount = Math.max(1, Math.ceil((maximum - lower) / width));
  }
  return { lower, width, binCount };
}

/** The single bin used when every sample has the same value. */
export function singleValueBin(value: number, count: number): { lower: number; upper: number; count: number } {
  const width = niceCeiling(Math.max(Math.abs(value) * 0.1, 1));
  return { lower: value, upper: value + width, count };
}
