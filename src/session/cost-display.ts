/**
 * Text for a session's estimated cost.
 *
 * A Docker session may have no cost source at all (no host-priced exchange
 * and no agent report): it then says so instead of showing $0.00, and a
 * partly priced session shows its amount as a lower bound. Sessions that price
 * every step themselves carry no source and render plainly.
 */

import type { BudgetCostSource } from './types.js';

/** `$1.23`, `≥ $1.23` for a lower bound, or `unknown` when nothing reported a cost. */
export function formatCostUsd(usd: number, source?: BudgetCostSource): string {
  if (source === 'unknown') return 'unknown';
  const amount = `$${usd.toFixed(2)}`;
  return source === 'partial' ? `≥ ${amount}` : amount;
}

/** For one-line summaries: `~$1.23` (an estimate), `≥ $1.23`, or `cost unknown`. */
export function formatCostSummary(usd: number, source?: BudgetCostSource): string {
  if (source === 'unknown') return 'cost unknown';
  return source === 'partial' ? formatCostUsd(usd, source) : `~${formatCostUsd(usd, source)}`;
}

/**
 * A cost against its limit: `$1.23 / $5.00 (25%)`, `$1.23 (no limit)`, or for
 * an unknown cost `unknown (limit $5.00)` (no made-up percentage).
 */
export function formatCostAgainstLimit(
  usd: number,
  source: BudgetCostSource | undefined,
  limit: number | null,
): string {
  const current = formatCostUsd(usd, source);
  if (limit === null) return `${current} (no limit)`;
  if (source === 'unknown') return `${current} (limit $${limit.toFixed(2)})`;
  const pct = limit > 0 ? Math.round((usd / limit) * 100) : 0;
  return `${current} / $${limit.toFixed(2)} (${pct}%)`;
}
