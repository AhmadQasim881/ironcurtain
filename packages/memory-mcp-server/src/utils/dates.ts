/**
 * Defensive date rendering. A stored timestamp outside the JavaScript Date range
 * (for example a row written before `as_of` was bounded) must not make a briefing,
 * a recall or a listing throw ("Invalid time value"): it renders as UNKNOWN_DATE.
 */

export const UNKNOWN_DATE = 'unknown date';

function isoString(ms: number): string | null {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** The UTC calendar day (`YYYY-MM-DD`) of an epoch-ms timestamp, or UNKNOWN_DATE. */
export function formatDay(ms: number): string {
  const iso = isoString(ms);
  return iso === null ? UNKNOWN_DATE : iso.slice(0, iso.indexOf('T'));
}

/** The full ISO 8601 form of an epoch-ms timestamp, or UNKNOWN_DATE. */
export function formatTimestamp(ms: number): string {
  return isoString(ms) ?? UNKNOWN_DATE;
}
