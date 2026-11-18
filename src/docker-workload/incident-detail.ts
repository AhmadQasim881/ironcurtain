/**
 * Bounded, single-line diagnostic text for Docker-workload incident records.
 *
 * Lease incidents, lifecycle audit incidents, and watchdog supervisor status
 * all carry free text that usually comes from an `Error.message`. Those
 * messages are unbounded: a Node `execFile` failure embeds the complete argv
 * (for an inventory that is one runtime ID per argument) before the daemon's
 * stderr. Stored verbatim they overflow the record schemas, and the resulting
 * schema error replaces the failure it was meant to record.
 *
 * Every incident writer passes its text through {@link boundIncidentDetail}.
 * It removes control and invisible format characters and, when the text is
 * still too long, keeps a short head (which command failed) and a longer tail
 * (where execFile puts the daemon's stderr), joined by an explicit omission
 * marker. The result always fits the smallest incident schema bound.
 */

/**
 * Longest kept detail, in code points. Each code point is at most two UTF-16
 * code units, so a bounded detail fits the lease's 4096-unit incident field
 * and the 8192-unit audit and supervisor fields.
 */
export const MAX_INCIDENT_DETAIL_CODE_POINTS = 2048;

/** Detail recorded when an error carried no usable text. */
export const EMPTY_INCIDENT_DETAIL = '(no detail)';

/** Control, format, separator, and lone-surrogate code points. */
const UNSAFE_CODE_POINTS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]+/gu;
const REPEATED_SPACES = / {2,}/gu;
/** Smallest bound that still leaves room for a head, the marker, and a tail. */
const MIN_BOUND = 64;

/**
 * Make `text` safe and bounded for an incident record: control characters
 * become single spaces, and an over-long text keeps its head and tail around an
 * explicit `[... N characters omitted ...]` marker. Never returns an empty string.
 */
export function boundIncidentDetail(text: string, maxCodePoints: number = MAX_INCIDENT_DETAIL_CODE_POINTS): string {
  if (!Number.isSafeInteger(maxCodePoints) || maxCodePoints < MIN_BOUND) {
    throw new RangeError(`incident detail bound must be an integer of at least ${MIN_BOUND}`);
  }
  const cleaned = text.replace(UNSAFE_CODE_POINTS, ' ').replace(REPEATED_SPACES, ' ').trim();
  if (cleaned.length === 0) return EMPTY_INCIDENT_DETAIL;
  const codePoints = Array.from(cleaned);
  if (codePoints.length <= maxCodePoints) return cleaned;

  // The marker states the omitted count; size it for the worst case first.
  const markerFor = (omitted: number): string => ` [... ${omitted} characters omitted ...] `;
  const budget = maxCodePoints - markerFor(codePoints.length).length;
  // A quarter for the head (the command that failed), the rest for the tail
  // (execFile appends the daemon's stderr after the argv).
  const headLength = Math.floor(budget / 4);
  const tailLength = budget - headLength;
  const omitted = codePoints.length - headLength - tailLength;
  return (
    codePoints.slice(0, headLength).join('').trimEnd() +
    markerFor(omitted) +
    codePoints
      .slice(codePoints.length - tailLength)
      .join('')
      .trimStart()
  );
}

/** {@link boundIncidentDetail} applied to an arbitrary thrown value. */
export function incidentDetailFromError(error: unknown, maxCodePoints?: number): string {
  return boundIncidentDetail(error instanceof Error ? error.message : String(error), maxCodePoints);
}

/**
 * Rethrow-ready error for a catch block whose incident recording also failed.
 *
 * The original failure always comes first: it stays the `cause`, the first
 * aggregated error, and the start of the message, so recording problems can
 * never mask what actually went wrong. Returns `original` unchanged when
 * nothing else failed.
 */
export function preserveOriginalFailure(original: unknown, recordingFailures: readonly unknown[]): unknown {
  if (recordingFailures.length === 0) return original;
  const originalMessage = original instanceof Error ? original.message : String(original);
  const recordingMessages = recordingFailures.map((failure) => incidentDetailFromError(failure, 256)).join('; ');
  return new AggregateError(
    [original, ...recordingFailures],
    `${originalMessage} (recording this failure also failed: ${recordingMessages})`,
    { cause: original },
  );
}
