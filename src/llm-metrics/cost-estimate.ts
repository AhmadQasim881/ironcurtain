/**
 * Host-side list-price cost for one observed LLM exchange.
 *
 * The MITM observes the exact per-exchange token split (uncached input, cache
 * reads, 5-minute and 1-hour cache writes, output) and the served model, which
 * is everything a first-party price list needs. This module turns that into a
 * USD estimate with the shared price table (`pricing.ts`), and refuses to
 * guess: anything it cannot price exactly (an unlisted model, an unpriced fast
 * request or service tier, a long-context premium the table does not model,
 * incomplete or unfinished usage, a billed server tool) is reported as
 * unpriced, so the cost stays unknown instead of becoming a wrong number.
 *
 * The caller decides whether list prices apply at all: only a verified
 * official provider origin bills at them (`GatewayObservation.officialListPricing`).
 * A gateway or an opaque route is never priced as fact.
 */

import {
  estimateRequestCostUsd,
  exceedsUnmodeledLongContext,
  normalizeModelId,
  PRICING_VERSION,
  pricingForSpeed,
  resolveModelPricing,
  type ModelPricing,
  type PricingSpeed,
  type RequestTokenUsage,
} from './pricing.js';
import type { NormalizedUsage, UsageIteration } from './types.js';

/**
 * Stands for a speed or service tier the provider reported but the protocol
 * adapter did not recognize: it has no list price.
 */
export const UNRECOGNIZED_PRICING_MODE = 'unrecognized';

export interface ListPriceInput {
  readonly usage: NormalizedUsage;
  /**
   * The official provider whose origin served the exchange (the verified
   * direct route's `servedProvider`: anthropic, openai, google or zai). Only
   * that provider's own models are priced: a Claude id answered by another
   * provider's Anthropic-compatible endpoint is not billed at Anthropic's prices.
   */
  readonly provider: string;
  /** The model that served the exchange (the response's model), else the model the request named. */
  readonly model: string | null;
  /**
   * The speed the response reports, else the one requested; null means
   * standard. Anything but `standard` or `fast` (such as
   * {@link UNRECOGNIZED_PRICING_MODE}) is unpriced.
   */
  readonly speed: string | null;
  /**
   * The service tier the response reports ({@link UNRECOGNIZED_PRICING_MODE}
   * for one the adapter does not know); tiers with their own price lists are
   * not priced.
   */
  readonly serviceTier: string | null;
  /** HTTP status of the upstream response, or null when none was received. */
  readonly responseStatus: number | null;
  /**
   * The protocol's terminal event was observed (Anthropic `message_stop`, a
   * whole JSON body, `response.completed`), so the usage is the final report.
   * A stream cut off before it carries only early counters (Anthropic reports
   * `output_tokens: 1` in `message_start`) and was billed for output the host
   * never saw.
   */
  readonly terminal: boolean;
}

/** Why an exchange on an official origin has no list-price estimate (a bounded quality-flag suffix). */
export type ListPriceUnavailableReason =
  | 'unknown_model'
  | 'incomplete_usage'
  | 'contradictory_usage'
  | 'unpriced_speed'
  | 'unpriced_service_tier'
  | 'unpriced_server_tools'
  | 'unpriced_long_context'
  | 'unpriced_iterations';

export type ListPriceEstimate =
  | {
      readonly kind: 'priced';
      readonly costUsd: number;
      readonly pricingVersion: string;
      /** Assumptions the estimate made, as quality flags. */
      readonly qualityFlags: readonly string[];
    }
  | { readonly kind: 'unavailable'; readonly reason: ListPriceUnavailableReason };

/** Service tiers billed at the standard list price. */
const STANDARD_SERVICE_TIERS: ReadonlySet<string> = new Set(['auto', 'default', 'standard']);

/** Model-id families other providers serve; an OpenAI origin serves none of them. */
const NON_OPENAI_FAMILIES = ['claude', 'gemini', 'glm'] as const;

function unavailable(reason: ListPriceUnavailableReason): ListPriceEstimate {
  return { kind: 'unavailable', reason };
}

function isCount(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Whether `provider`'s own origin serves the normalized model id, so that its
 * list prices apply. Fine-tuned OpenAI models (`ft:...`) bill at their own
 * prices, not the base model's.
 */
function servesModel(provider: string, normalizedId: string): boolean {
  switch (provider) {
    case 'anthropic':
      return normalizedId.startsWith('claude');
    case 'google':
      return normalizedId.startsWith('gemini');
    case 'zai':
      return normalizedId.startsWith('glm');
    case 'openai':
      return !normalizedId.startsWith('ft:') && !NON_OPENAI_FAMILIES.some((family) => normalizedId.startsWith(family));
    default:
      return false;
  }
}

/**
 * A request's cache writes split by TTL. Reported halves must add up; with
 * neither half reported every write is priced as a 5-minute write (the
 * API's default TTL), and the estimate is flagged. A split the protocol
 * discarded as contradictory leaves the TTLs unknown.
 */
function cacheWriteSplit(
  usage: NormalizedUsage,
  cacheWrite: number,
  flags: Set<string>,
): { readonly fiveMinute: number; readonly oneHour: number } | null {
  const fiveMinute = usage.cacheWrite5mInputTokens;
  const oneHour = usage.cacheWrite1hInputTokens;
  if (isCount(fiveMinute) && isCount(oneHour)) {
    return fiveMinute + oneHour === cacheWrite ? { fiveMinute, oneHour } : null;
  }
  if (isCount(oneHour)) return oneHour <= cacheWrite ? { fiveMinute: cacheWrite - oneHour, oneHour } : null;
  if (isCount(fiveMinute)) return fiveMinute <= cacheWrite ? { fiveMinute, oneHour: cacheWrite - fiveMinute } : null;
  if (usage.qualityFlags.includes('contradictory_usage:cache_creation_split')) return null;
  if (cacheWrite > 0) flags.add('list_price_assumed_5m_cache_writes');
  return { fiveMinute: cacheWrite, oneHour: 0 };
}

/** The listed price of `model` at `speed` on `provider`'s origin, or an unavailable reason. */
function listedPricing(
  model: string,
  speed: PricingSpeed,
  provider: string,
): ModelPricing | ListPriceUnavailableReason {
  const resolved = resolveModelPricing(model);
  // Fail-closed defaults for unlisted models are fine for enforcing a cap,
  // not for reporting spend as a fact.
  if (resolved.source !== 'list' || !servesModel(provider, resolved.normalizedId)) return 'unknown_model';
  return pricingForSpeed(resolved.pricing, speed) ?? 'unpriced_speed';
}

/**
 * One request's cost, unless its prompt is past a long-context premium the
 * table does not model. Unlike a cost cap (`estimateCapRequestCostUsd`),
 * which charges such a prompt a conservative multiple of the listed rates, a
 * cost reported as a list price has none for it.
 */
function requestCostUsd(pricing: ModelPricing, tokens: RequestTokenUsage): number | ListPriceUnavailableReason {
  if (exceedsUnmodeledLongContext(pricing, tokens)) return 'unpriced_long_context';
  return estimateRequestCostUsd(pricing, tokens);
}

/** Rates that depend on one request's prompt size, so a sum over several attempts cannot pick them. */
function hasPromptSizeTier(pricing: ModelPricing): boolean {
  return pricing.longPrompt !== undefined || pricing.unmodeledPremiumAbovePromptTokens !== undefined;
}

/**
 * Per-attempt prices for itemized usage: each attempt bills at its own
 * model's rates (an advisor sub-inference, a refusal fallback), and a
 * prompt-size tier is decided per attempt. The TTL split is reported for the
 * exchange as a whole, so the cache writes are priced only when the split is
 * unambiguous for every attempt.
 */
function attemptsCostUsd(
  usage: NormalizedUsage,
  iterations: readonly UsageIteration[],
  input: { readonly model: string; readonly provider: string; readonly speed: PricingSpeed },
  split: { readonly fiveMinute: number; readonly oneHour: number },
): number | ListPriceUnavailableReason {
  // Attempts beyond the retained ones are unknown.
  if (usage.qualityFlags.includes('usage_iterations_truncated')) return 'unpriced_iterations';
  if (split.fiveMinute > 0 && split.oneHour > 0) return 'unpriced_iterations';
  let total = 0;
  for (const iteration of iterations) {
    const uncached = iteration.inputTokensUncached;
    const cacheRead = iteration.cacheReadInputTokens;
    const cacheWrite = iteration.cacheWriteInputTokens;
    const output = iteration.outputTokens;
    if (!isCount(uncached) || !isCount(cacheRead) || !isCount(cacheWrite) || !isCount(output)) {
      return 'incomplete_usage';
    }
    const pricing = listedPricing(iteration.model ?? input.model, input.speed, input.provider);
    if (typeof pricing === 'string') return pricing;
    const cost = requestCostUsd(pricing, {
      uncachedInputTokens: uncached,
      cacheReadTokens: cacheRead,
      cacheWrite5mTokens: split.oneHour > 0 ? 0 : cacheWrite,
      cacheWrite1hTokens: split.oneHour > 0 ? cacheWrite : 0,
      outputTokens: output,
    });
    if (typeof cost === 'string') return cost;
    total += cost;
  }
  return total;
}

/**
 * The exchange's cost at first-party list prices, or why it has none. The
 * caller has already established that the route is a verified official
 * origin; this checks everything else.
 */
export function estimateListPriceCostUsd(input: ListPriceInput): ListPriceEstimate {
  const { usage } = input;
  // An error response without usage was not billed.
  if (usage.usageCompleteness === 'missing' && input.responseStatus !== null && input.responseStatus >= 400) {
    return { kind: 'priced', costUsd: 0, pricingVersion: PRICING_VERSION, qualityFlags: [] };
  }
  if (input.model === null) return unavailable('unknown_model');
  if (input.speed !== null && input.speed !== 'standard' && input.speed !== 'fast') {
    return unavailable('unpriced_speed');
  }
  if (input.serviceTier !== null && !STANDARD_SERVICE_TIERS.has(input.serviceTier)) {
    return unavailable('unpriced_service_tier');
  }
  // Web searches bill per request on top of tokens; this table has no such price.
  if ((usage.serverToolRequests?.webSearchRequests ?? 0) > 0) return unavailable('unpriced_server_tools');

  const inputTotal = usage.inputTokensTotal;
  const output = usage.outputTokensTotal;
  if (!input.terminal || usage.usageCompleteness !== 'complete' || !isCount(inputTotal) || !isCount(output)) {
    return unavailable('incomplete_usage');
  }
  // Protocols without a cache counter bill none of that kind (OpenAI and
  // Google report no cache writes). For Anthropic a missing counter already
  // leaves the input total unknown.
  const cacheRead = usage.cacheReadInputTokens ?? 0;
  const cacheWrite = usage.cacheWriteInputTokens ?? 0;
  const uncached = inputTotal - cacheRead - cacheWrite;
  if (!isCount(cacheRead) || !isCount(cacheWrite) || uncached < 0) return unavailable('contradictory_usage');

  const flags = new Set<string>();
  const split = cacheWriteSplit(usage, cacheWrite, flags);
  if (split === null) return unavailable('contradictory_usage');
  const speed: PricingSpeed = input.speed === 'fast' ? 'fast' : 'standard';
  const attempt = { model: input.model, provider: input.provider, speed };

  const iterations = usage.iterations ?? [];
  const exchangeModel = normalizeModelId(input.model);
  const multiModel = iterations.some(
    (iteration) => iteration.model !== null && normalizeModelId(iteration.model) !== exchangeModel,
  );
  let costUsd: number | ListPriceUnavailableReason;
  if (multiModel) {
    costUsd = attemptsCostUsd(usage, iterations, attempt, split);
  } else {
    const pricing = listedPricing(input.model, speed, input.provider);
    if (typeof pricing === 'string') return unavailable(pricing);
    costUsd =
      iterations.length > 1 && hasPromptSizeTier(pricing)
        ? attemptsCostUsd(usage, iterations, attempt, split)
        : requestCostUsd(pricing, {
            uncachedInputTokens: uncached,
            cacheReadTokens: cacheRead,
            cacheWrite5mTokens: split.fiveMinute,
            cacheWrite1hTokens: split.oneHour,
            outputTokens: output,
          });
  }
  if (typeof costUsd === 'string') return unavailable(costUsd);
  if (!Number.isFinite(costUsd) || costUsd < 0) return unavailable('contradictory_usage');
  return { kind: 'priced', costUsd, pricingVersion: PRICING_VERSION, qualityFlags: [...flags] };
}

/**
 * An exchange's cost in USD: the gateway's report when there is one, else the
 * host's list-price estimate, else null (unknown, never zero). The same rule
 * applies to a live record and a persisted row.
 */
export function exchangeCostUsd(cost: {
  readonly costUsd: number | null;
  readonly estimatedCostUsd?: number | null;
}): number | null {
  for (const value of [cost.costUsd, cost.estimatedCostUsd]) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}
