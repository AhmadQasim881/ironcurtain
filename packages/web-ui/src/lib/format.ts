import type { BudgetCostSource } from './types.js';

/**
 * A session or run cost: `$1.23`, `≥ $1.23` when only part of the exchanges
 * reported a cost (a lower bound), or `unknown` when none did. A Docker
 * session without any cost source must not read as a free `$0.00`.
 */
export function formatCostUsd(usd: number, source?: BudgetCostSource): string {
  if (source === 'unknown') return 'unknown';
  const amount = `$${usd.toFixed(2)}`;
  return source === 'partial' ? `≥ ${amount}` : amount;
}

/**
 * Formats an ISO timestamp as a compact relative string. Entries older than a
 * week fall back to a locale date; invalid inputs use a neutral placeholder.
 */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  if (!iso) return '--';
  const timestamp = new Date(iso).getTime();
  if (Number.isNaN(timestamp)) return '--';
  const seconds = Math.floor((now - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}
