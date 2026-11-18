/**
 * Between-turn budget admission from a session's `BudgetStatus`.
 *
 * Shared by `DockerAgentSession` (before every container turn) and the
 * workflow orchestrator (before a state's primary turn and before every
 * recovery, replacement and artifact-retry turn), so both stop at the same
 * point. The check compares cumulative session totals against the configured
 * limits; a completed turn may take usage past a limit, but no further turn is
 * launched once that is visible. It does not bound a turn in flight: container
 * turns are bounded there by their bundle's MITM budget gate, which refuses
 * completion requests once the bundle's token or cost limit is reached
 * (`docker/budget-gate.ts`), and by the in-container wall clock
 * (`docker/turn-timeout.ts`).
 *
 * Only host-derived numbers are consulted:
 *
 *   - tokens: the proxy-observed totals, only while `tokenTrackingAvailable`
 *     (a lower bound when tracking is `partial`, which still trips the limit);
 *   - steps: the session's completed turns (`cumulative.stepCount`);
 *   - cost: `hostObservedCostUsd` when the session reports it, else
 *     `cumulative.estimatedCostUsd`. Container sessions report their agent
 *     CLI's self-reported `total_cost_usd` in `estimatedCostUsd` for display;
 *     a compromised agent controls that stdout (audit finding MET-1), so those
 *     sessions always set `hostObservedCostUsd` and the self-report never
 *     reaches this check. Builtin sessions leave it unset because their
 *     estimate is already computed on the host.
 *
 * Deliberately excludes `maxSessionSeconds`. That limit is defined per turn
 * (`ResourceBudgetTracker` compares it against the current turn's elapsed
 * time, and container turns enforce it with an in-container `timeout`), so
 * summing every turn's active time against it would silently convert a
 * per-turn cap into a ceiling on the session's total duration. Agent states
 * are expected to run for hours across many turns.
 */

import type { BudgetStatus } from './types.js';

/** A cumulative limit that is already used up. */
export interface CumulativeBudgetExhaustion {
  readonly dimension: 'tokens' | 'steps' | 'cost';
  readonly used: number;
  readonly limit: number;
}

/**
 * The session cost a budget decision may use: `hostObservedCostUsd` when the
 * session reports it (Docker sessions always do), else
 * `cumulative.estimatedCostUsd` (builtin sessions, whose estimate is computed
 * on the host). A container agent's self-reported `total_cost_usd` only ever
 * reaches `estimatedCostUsd`, for display, so it decides nothing (MET-1).
 * Shared by this admission check and the run-wide workflow ceiling
 * (`src/workflow/workflow-usage.ts`), so both count the same cost.
 */
export function budgetDecisionCostUsd(status: Pick<BudgetStatus, 'hostObservedCostUsd' | 'cumulative'>): number {
  return status.hostObservedCostUsd ?? status.cumulative.estimatedCostUsd;
}

/**
 * Returns the first exhausted cumulative dimension (tokens, then steps, then
 * cost), or undefined when another turn may start.
 */
export function findCumulativeBudgetExhaustion(status: BudgetStatus): CumulativeBudgetExhaustion | undefined {
  const { cumulative, limits, tokenTrackingAvailable } = status;
  if (tokenTrackingAvailable && limits.maxTotalTokens != null && cumulative.totalTokens >= limits.maxTotalTokens) {
    return { dimension: 'tokens', used: cumulative.totalTokens, limit: limits.maxTotalTokens };
  }
  if (limits.maxSteps != null && cumulative.stepCount >= limits.maxSteps) {
    return { dimension: 'steps', used: cumulative.stepCount, limit: limits.maxSteps };
  }
  const costUsd = budgetDecisionCostUsd(status);
  if (limits.maxEstimatedCostUsd != null && costUsd >= limits.maxEstimatedCostUsd) {
    return { dimension: 'cost', used: costUsd, limit: limits.maxEstimatedCostUsd };
  }
  return undefined;
}

/** Compact reason used in workflow errors, e.g. `token budget exhausted (1200/1000)`. */
export function describeCumulativeBudgetExhaustion(exhaustion: CumulativeBudgetExhaustion): string {
  switch (exhaustion.dimension) {
    case 'tokens':
      return `token budget exhausted (${exhaustion.used}/${exhaustion.limit})`;
    case 'steps':
      return `step budget exhausted (${exhaustion.used}/${exhaustion.limit})`;
    case 'cost':
      return `cost budget exhausted ($${exhaustion.used.toFixed(2)}/$${exhaustion.limit.toFixed(2)})`;
  }
}
