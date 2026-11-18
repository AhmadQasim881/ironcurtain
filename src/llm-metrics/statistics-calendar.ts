/**
 * Local calendar-day boundaries for statistics time series.
 *
 * Buckets follow true IANA day lengths (23 or 25 hours across daylight-saving
 * changes, and skipped days such as Pacific/Apia in 2011). Boundaries are
 * computed once per query, never per row, and are bounded by the range.
 *
 * Loaded inside the persistence worker through native type stripping: keep it
 * self-contained, erasable TypeScript.
 */

const HOUR_MS = 60 * 60 * 1_000;
/** A skipped calendar day plus a daylight-saving shift still ends within this span. */
const BOUNDARY_SEARCH_SPAN_MS = 50 * HOUR_MS;
const TYPICAL_DAY_LENGTHS_MS = [24 * HOUR_MS, 23 * HOUR_MS, 25 * HOUR_MS] as const;

export function calendarFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-CA-u-ca-iso8601-nu-latn', {
    timeZone,
    calendar: 'iso8601',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

/** The local ISO date (`YYYY-MM-DD`) of an instant; keys sort chronologically. */
export function calendarDateKey(timestampMs: number, formatter: Intl.DateTimeFormat): string {
  let year = Number.NaN;
  let month = Number.NaN;
  let day = Number.NaN;
  for (const part of formatter.formatToParts(timestampMs)) {
    if (part.type === 'year') year = Number(part.value);
    else if (part.type === 'month') month = Number(part.value);
    else if (part.type === 'day') day = Number(part.value);
  }
  if (!Number.isSafeInteger(year) || !Number.isSafeInteger(month) || !Number.isSafeInteger(day)) {
    throw new Error('Unable to calculate statistics calendar bucket');
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** First instant after `cursorMs` whose local date sorts after the date of `cursorMs`. */
function nextDayBoundary(cursorMs: number, formatter: Intl.DateTimeFormat, cursorIsDayStart: boolean): number {
  const key = calendarDateKey(cursorMs, formatter);
  if (cursorIsDayStart) {
    for (const lengthMs of TYPICAL_DAY_LENGTHS_MS) {
      const candidate = cursorMs + lengthMs;
      if (calendarDateKey(candidate, formatter) > key && calendarDateKey(candidate - 1, formatter) <= key) {
        return candidate;
      }
    }
  }
  let lower = cursorMs + 1;
  let upper = cursorMs + BOUNDARY_SEARCH_SPAN_MS;
  if (calendarDateKey(upper, formatter) <= key) throw new Error('Unable to calculate statistics calendar bucket');
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    if (calendarDateKey(middle, formatter) > key) upper = middle;
    else lower = middle + 1;
  }
  return lower;
}

/**
 * Ascending bucket starts covering `[fromMs, toMs]`: `fromMs` itself, then
 * every local midnight up to `toMs`. Bucket `i` is `[starts[i], starts[i + 1])`
 * and the last one ends at `toMs + 1`. Returns null when the range would need
 * more than `maxBuckets` buckets.
 */
export function calendarDayStarts(
  fromMs: number,
  toMs: number,
  timeZone: string,
  maxBuckets: number,
): readonly number[] | null {
  const formatter = calendarFormatter(timeZone);
  const starts = [fromMs];
  let cursor = fromMs;
  let cursorIsDayStart = false;
  for (;;) {
    const next = nextDayBoundary(cursor, formatter, cursorIsDayStart);
    if (next > toMs) return starts;
    if (starts.length >= maxBuckets) return null;
    starts.push(next);
    cursor = next;
    cursorIsDayStart = true;
  }
}
