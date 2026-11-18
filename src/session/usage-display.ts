/**
 * Text for an observed token total that says how complete it is.
 *
 * Docker sessions count tokens from the LLM exchanges the MITM observed
 * (`ObservedUsageAccumulator`). When an exchange could not be measured in
 * full, the total is a lower bound and `tokenTrackingStatus` is `partial`;
 * before any exchange was observed it is `partial` with nothing counted.
 * Rendering either as a plain number would present an undercount as exact,
 * so every place that shows a session's token total goes through here.
 * Leaf module: no imports, usable by any transport.
 */

/** The tracking fields of `BudgetStatus` (and the DTOs that copy them). */
export interface TokenTrackingView {
  readonly tokenTrackingAvailable: boolean;
  readonly tokenTrackingStatus?: 'complete' | 'partial' | 'unavailable';
  readonly observedExchanges?: number;
  readonly incompleteExchanges?: number;
}

export const NO_EXCHANGES_OBSERVED_YET = 'no exchanges observed yet';

function exchangeCount(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** `complete`, `partial` or `unavailable`; builtin sessions report no status and are complete. */
export function tokenTrackingStatusOf(view: TokenTrackingView): 'complete' | 'partial' | 'unavailable' {
  return view.tokenTrackingStatus ?? (view.tokenTrackingAvailable ? 'complete' : 'unavailable');
}

/**
 * The token figure: `12,345` when complete, `≥12,345` when it is a lower
 * bound, `no exchanges observed yet` when tracking is on but nothing was
 * observed, and `undefined` when tokens cannot be observed at all (callers
 * keep their own wording for that, such as "N/A").
 */
export function formatTrackedTokens(total: number, view: TokenTrackingView): string | undefined {
  const status = tokenTrackingStatusOf(view);
  if (status === 'unavailable') return undefined;
  const figure = total.toLocaleString();
  if (status === 'complete') return figure;
  if (total === 0 && exchangeCount(view.observedExchanges) === 0) return NO_EXCHANGES_OBSERVED_YET;
  return `≥${figure}`;
}

/**
 * ` (partial: N of M exchanges incomplete)` for a lower-bound total with
 * incomplete exchanges, otherwise the empty string.
 */
export function partialTokensNote(view: TokenTrackingView): string {
  if (tokenTrackingStatusOf(view) !== 'partial') return '';
  const incomplete = exchangeCount(view.incompleteExchanges);
  if (incomplete === 0) return '';
  return ` (partial: ${incomplete} of ${exchangeCount(view.observedExchanges)} exchanges incomplete)`;
}
