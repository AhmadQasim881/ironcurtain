import type { WorkflowUsageDto } from '$lib/types.js';

/**
 * Token totals with their tracking quality. Docker sessions and workflows
 * count tokens from the LLM exchanges the daemon observed; when an exchange
 * was not measured in full the total is a lower bound (`partial`) and must
 * never read as exact. Mirrors `src/session/usage-display.ts`.
 */

export type TokenTrackingStatus = 'complete' | 'partial' | 'unavailable';

export interface TokenTrackingFields {
  readonly tokenTrackingAvailable?: boolean;
  readonly tokenTrackingStatus?: TokenTrackingStatus;
  readonly observedExchanges?: number;
  readonly incompleteExchanges?: number;
}

export const NO_EXCHANGES_OBSERVED_YET = 'No exchanges observed yet';

function count(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Without an explicit status, only a positive `tokenTrackingAvailable` counts as tracked. */
export function trackingStatusOf(fields: TokenTrackingFields): TokenTrackingStatus {
  return fields.tokenTrackingStatus ?? (fields.tokenTrackingAvailable === true ? 'complete' : 'unavailable');
}

/**
 * `12,345`, `≥12,345` for a lower bound, or the "no exchanges" text when
 * tracking is on but nothing was observed. Undefined when tokens cannot be
 * observed at all (or no total was reported), so callers choose their own
 * "unavailable" wording.
 */
export function formatTrackedTokens(total: number | undefined, fields: TokenTrackingFields): string | undefined {
  const status = trackingStatusOf(fields);
  if (status === 'unavailable' || typeof total !== 'number' || !Number.isFinite(total)) return undefined;
  if (status === 'complete') return total.toLocaleString();
  if (total === 0 && count(fields.observedExchanges) === 0) return NO_EXCHANGES_OBSERVED_YET;
  return `≥${total.toLocaleString()}`;
}

/** `partial: N of M exchanges incomplete`, or the empty string. */
export function partialExchangesNote(fields: TokenTrackingFields): string {
  if (trackingStatusOf(fields) !== 'partial') return '';
  const incomplete = count(fields.incompleteExchanges);
  return incomplete > 0 ? `partial: ${incomplete} of ${count(fields.observedExchanges)} exchanges incomplete` : '';
}

/** Run-wide token figure plus a one-line explanation of what it covers. */
export function formatWorkflowTokens(usage: WorkflowUsageDto): { readonly value: string; readonly detail?: string } {
  if (usage.tokenTrackingStatus === 'unavailable') {
    return {
      value: 'Unavailable',
      detail: 'Token usage was not observed: LLM statistics are off or the provider route is not observable.',
    };
  }
  const nothingYet =
    usage.tokenTrackingStatus === 'partial' &&
    usage.totalTokens === 0 &&
    usage.observedExchanges === 0 &&
    !usage.lowerBound &&
    usage.untrackedSessions === 0;
  if (nothingYet) return { value: NO_EXCHANGES_OBSERVED_YET };

  const value =
    usage.tokenTrackingStatus === 'partial'
      ? `≥${usage.totalTokens.toLocaleString()}`
      : usage.totalTokens.toLocaleString();
  const cache = usage.cacheReadTokens + usage.cacheWriteTokens;
  const parts = [
    `${usage.inputTokens.toLocaleString()} in${cache > 0 ? ` (${cache.toLocaleString()} cache)` : ''}`,
    `${usage.outputTokens.toLocaleString()} out`,
  ];
  const caveats: string[] = [];
  const note = partialExchangesNote(usage);
  if (note) caveats.push(note);
  if (usage.untrackedSessions > 0) {
    caveats.push(`${usage.untrackedSessions} session${usage.untrackedSessions === 1 ? '' : 's'} not observed`);
  }
  // Tokens a bundle's budget gate charged that no exchange record itemizes
  // (statistics off, unmeasured usage): part of the total, not of in/out.
  const gateOnly = usage.gateOnlyTokens ?? 0;
  if (Number.isFinite(gateOnly) && gateOnly > 0) {
    caveats.push(`${gateOnly.toLocaleString()} counted only by the budget gate`);
  }
  if (usage.lowerBound && caveats.length === 0 && usage.tokenTrackingStatus === 'partial') caveats.push('lower bound');
  return { value, detail: [parts.join(' · '), ...caveats].join(' · ') };
}

/** Seconds as a short duration: `45s`, `12m 5s`, `3h 20m`. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${total % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
