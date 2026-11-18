/**
 * Host-side list prices for LLM cost estimates.
 *
 * The one price table for host-side cost estimates. The builtin agent's
 * ResourceBudgetTracker prices each AI SDK step with it, and the MITM metrics
 * pipeline prices each exchange observed on a verified official provider
 * origin with it (`cost-estimate.ts`, persisted as `cost_source =
 * 'list_price'` with this `PRICING_VERSION`). The module is a leaf (no
 * imports) so any layer may use it.
 *
 * Estimates use the provider's first-party list prices, including fast mode
 * (`speed: "fast"`) where a model has one. They do not model batch or
 * priority pricing, data-residency multipliers, the long-context premium of
 * older models' 1M-context betas (or Gemini's long-context tier), or the
 * separate price lists of partner clouds (Bedrock, Vertex). They exist to
 * enforce cost caps and to display spend, not to reproduce an invoice.
 *
 * Rows whose long-context prices are not modeled carry
 * `unmodeledPremiumAbovePromptTokens`. A larger prompt has no list price: a
 * cost reported as one refuses it (`cost-estimate.ts`), while a cost cap (the
 * MITM budget gate, the builtin ResourceBudgetTracker) charges its every rate
 * at `UNMODELED_LONG_CONTEXT_CAP_MULTIPLIER` (2x) the listed one, which bounds
 * those tiers (`estimateCapRequestCostUsd`), so a cap is never overrun by a
 * price the table lacks.
 *
 * Model ids are matched after normalization (see `normalizeModelId`):
 * provider prefixes ('anthropic:', 'anthropic/', 'anthropic.'), dated
 * snapshot and version suffixes are removed and OpenRouter dot slugs become
 * dashed ids, so 'anthropic/claude-opus-4.5' and 'claude-opus-4-5-20251101'
 * both price as 'claude-opus-4-5'. Claude ids match exactly; an unknown
 * Claude id fails closed at the highest current Claude tier. Other providers
 * keep a first-match-wins substring table and a Sonnet-class fallback.
 * Either fallback carries a warning that callers surface once.
 */

/**
 * Version of this table, for recording alongside any persisted estimate.
 * Bump it whenever a price changes.
 *
 * Anthropic rows: first-party list prices as published on 2026-10-06.
 * OpenAI, Google and Z.AI rows: last checked 2026-02-19 (approximate).
 */
export const PRICING_VERSION = '2026-11-11';

/** USD per million tokens for one pricing tier. */
export interface TokenRates {
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
  readonly cacheReadPerMillion: number;
  /** Prompt-cache writes with the default 5-minute TTL (Anthropic: 1.25x input). */
  readonly cacheWrite5mPerMillion: number;
  /** Prompt-cache writes with the 1-hour TTL (Anthropic: 2x input). */
  readonly cacheWrite1hPerMillion: number;
}

export interface ModelPricing extends TokenRates {
  /**
   * Per-request tier. When one request's prompt (uncached input plus cache
   * reads and writes) exceeds `thresholdPromptTokens`, every token of that
   * request is billed at `rates`. Decided per request, never from turn totals.
   */
  readonly longPrompt?: { readonly thresholdPromptTokens: number; readonly rates: TokenRates };
  /**
   * Fast mode (`speed: "fast"`, Claude API only): every rate of a fast
   * request, cache reads and writes included, is this multiple of the
   * standard rate (prompt-caching multipliers stack on the fast price).
   * Absent for a model without fast mode, so a fast request on it has no list
   * price.
   */
  readonly fastModeMultiplier?: number;
  /**
   * Prompts (uncached input plus cache reads and writes) larger than this many
   * tokens bill at long-context prices this table does not model: the 1M-token
   * context beta of older Claude models, or another provider's long-context
   * tier. Cost caps charge such a request every rate at
   * {@link UNMODELED_LONG_CONTEXT_CAP_MULTIPLIER} times the listed one
   * ({@link estimateCapRequestCostUsd}); a cost reported as a list price
   * refuses it (`cost-estimate.ts`). Absent: the rates, with `longPrompt` if
   * any, cover the model's whole context window.
   */
  readonly unmodeledPremiumAbovePromptTokens?: number;
}

/** Request speed for pricing: Anthropic's `speed` request field. */
export type PricingSpeed = 'standard' | 'fast';

/**
 * A user-supplied price (config.json `resourceBudget.modelPricing`). Omitted
 * cache rates default conservatively: reads at the full input rate, writes at
 * 1.25x (5-minute) and 2x (1-hour) input. An override replaces the table
 * entry, including any long-prompt tier.
 */
export interface ModelPricingOverride {
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
  readonly cacheReadPerMillion?: number;
  readonly cacheWrite5mPerMillion?: number;
  readonly cacheWrite1hPerMillion?: number;
}

export type ModelPricingOverrides = Readonly<Record<string, ModelPricingOverride>>;

/**
 * Where a resolved price came from: the table, a config override, or one of
 * the fail-closed defaults for a model the table does not list.
 */
export type ModelPricingSource = 'list' | 'override' | 'unknown_claude' | 'unknown_model';

export interface ResolvedModelPricing {
  /** The id as given by the caller. */
  readonly modelId: string;
  /** The id the table was searched with. */
  readonly normalizedId: string;
  readonly pricing: ModelPricing;
  readonly source: ModelPricingSource;
  /** Set when the price is a fail-closed default; callers surface it once. */
  readonly warning?: string;
}

/** Token counts of one request, split by how each kind is billed. */
export interface RequestTokenUsage {
  /** Prompt tokens neither read from nor written to the prompt cache. */
  readonly uncachedInputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWrite5mTokens: number;
  readonly cacheWrite1hTokens: number;
  readonly outputTokens: number;
}

const CACHE_WRITE_5M_MULTIPLIER = 1.25;
const CACHE_WRITE_1H_MULTIPLIER = 2;

/** Anthropic rates: cache writes cost 1.25x (5-minute TTL) or 2x (1-hour TTL) the input rate. */
function anthropicRates(inputPerMillion: number, outputPerMillion: number, cacheReadPerMillion: number): TokenRates {
  return {
    inputPerMillion,
    outputPerMillion,
    cacheReadPerMillion,
    cacheWrite5mPerMillion: inputPerMillion * CACHE_WRITE_5M_MULTIPLIER,
    cacheWrite1hPerMillion: inputPerMillion * CACHE_WRITE_1H_MULTIPLIER,
  };
}

/** Rates for providers without a cache-write premium: writes bill as input. */
function plainRates(inputPerMillion: number, outputPerMillion: number, cacheReadPerMillion: number): TokenRates {
  return {
    inputPerMillion,
    outputPerMillion,
    cacheReadPerMillion,
    cacheWrite5mPerMillion: inputPerMillion,
    cacheWrite1hPerMillion: inputPerMillion,
  };
}

/** Fast mode on Claude Opus 5.5, Opus 5 and Opus 4.8 costs 2x standard ($8/$40 and $10/$50 per MTok). */
const FAST_MODE_2X = 2;

/**
 * Older Claude models reach past 200K prompt tokens only through the 1M-token
 * context beta, which bills such a request at long-context premium rates.
 * Opus 4.7 and later bill their whole 1M window at the listed rates.
 */
const LEGACY_LONG_CONTEXT_PROMPT_TOKENS = 200_000;

const FABLE_5_1 = anthropicRates(10, 50, 0.25);
const FABLE_5 = anthropicRates(10, 50, 1);
const OPUS_5_5: ModelPricing = { ...anthropicRates(4, 20, 0.2), fastModeMultiplier: FAST_MODE_2X };
const OPUS_CURRENT = anthropicRates(5, 25, 0.5);
/** Opus 5 and Opus 4.8 price like OPUS_CURRENT and also offer fast mode. */
const OPUS_CURRENT_FAST: ModelPricing = { ...OPUS_CURRENT, fastModeMultiplier: FAST_MODE_2X };
const OPUS_4_6: ModelPricing = {
  ...OPUS_CURRENT,
  unmodeledPremiumAbovePromptTokens: LEGACY_LONG_CONTEXT_PROMPT_TOKENS,
};
const OPUS_LEGACY = anthropicRates(15, 75, 1.5);
const SONNET_5 = anthropicRates(2, 10, 0.2);
const SONNET_4: ModelPricing = {
  ...anthropicRates(3, 15, 0.3),
  unmodeledPremiumAbovePromptTokens: LEGACY_LONG_CONTEXT_PROMPT_TOKENS,
};
const HAIKU_5_5: ModelPricing = {
  ...anthropicRates(0.1, 0.5, 0.01),
  // Prompts over 100K tokens bill at $0.50 / $2.50 per MTok.
  longPrompt: { thresholdPromptTokens: 100_000, rates: anthropicRates(0.5, 2.5, 0.05) },
};
const HAIKU_4_5 = anthropicRates(1, 5, 0.1);

/** Claude list prices keyed by normalized model id (exact match). */
const CLAUDE_PRICING: ReadonlyMap<string, ModelPricing> = new Map<string, ModelPricing>([
  ['claude-fable-5-1', FABLE_5_1],
  ['claude-mythos-5-1', FABLE_5_1],
  ['claude-fable-5', FABLE_5],
  ['claude-mythos-5', FABLE_5],
  ['claude-opus-5-5', OPUS_5_5],
  ['claude-opus-5', OPUS_CURRENT_FAST],
  ['claude-opus-4-8', OPUS_CURRENT_FAST],
  ['claude-opus-4-7', OPUS_CURRENT],
  ['claude-opus-4-6', OPUS_4_6],
  ['claude-opus-4-5', OPUS_CURRENT],
  // Legacy Opus 4 / 4.1 kept at their own (higher) prices.
  ['claude-opus-4-1', OPUS_LEGACY],
  ['claude-opus-4-0', OPUS_LEGACY],
  ['claude-opus-4', OPUS_LEGACY],
  ['claude-sonnet-5-5', SONNET_5],
  ['claude-sonnet-5', SONNET_5],
  ['claude-sonnet-4-6', SONNET_4],
  ['claude-sonnet-4-5', SONNET_4],
  ['claude-sonnet-4-0', SONNET_4],
  ['claude-sonnet-4', SONNET_4],
  ['claude-haiku-5-5', HAIKU_5_5],
  ['claude-haiku-4-5', HAIKU_4_5],
]);

/**
 * Fail-closed price for a Claude id the table does not list (most likely a
 * newer model): the highest current tier, Fable/Mythos, with the highest
 * current cache-read rate.
 */
const UNKNOWN_CLAUDE_PRICING: ModelPricing = anthropicRates(10, 50, 1);

/**
 * Other providers, matched by substring on the normalized id (first match
 * wins, so more specific entries come first).
 */
const OTHER_PROVIDER_PRICING: ReadonlyArray<{ readonly match: string; readonly pricing: ModelPricing }> = [
  // --- OpenAI ---
  { match: 'gpt-5.2-pro', pricing: plainRates(21, 168, 21) },
  { match: 'gpt-5.2', pricing: plainRates(1.75, 14, 0.175) },
  { match: 'gpt-5-mini', pricing: plainRates(0.25, 2, 0.025) },
  { match: 'gpt-4.1-nano', pricing: plainRates(0.2, 0.8, 0.05) },
  { match: 'gpt-4.1-mini', pricing: plainRates(0.8, 3.2, 0.2) },
  { match: 'gpt-4.1', pricing: plainRates(3, 12, 0.75) },
  { match: 'o4-mini', pricing: plainRates(4, 16, 1) },
  { match: 'gpt-4o-mini', pricing: plainRates(0.15, 0.6, 0.075) },
  { match: 'gpt-4o', pricing: plainRates(2.5, 10, 1.25) },

  // --- Google Gemini ---
  // The Pro models bill a higher tier above 200K prompt tokens (1.5 Pro:
  // 128K); only the lower tier is listed here.
  { match: 'gemini-3.1-pro', pricing: { ...plainRates(2, 12, 0.2), unmodeledPremiumAbovePromptTokens: 200_000 } },
  { match: 'gemini-3-flash', pricing: plainRates(0.5, 3, 0.05) },
  { match: 'gemini-3-pro', pricing: { ...plainRates(2, 12, 0.2), unmodeledPremiumAbovePromptTokens: 200_000 } },
  {
    match: 'gemini-2.5-pro',
    pricing: { ...plainRates(1.25, 10, 0.125), unmodeledPremiumAbovePromptTokens: 200_000 },
  },
  { match: 'gemini-2.5-flash-lite', pricing: plainRates(0.1, 0.4, 0.01) },
  { match: 'gemini-2.5-flash', pricing: plainRates(0.3, 2.5, 0.03) },
  { match: 'gemini-2.0-flash-lite', pricing: plainRates(0.075, 0.3, 0.0075) },
  { match: 'gemini-2.0-flash', pricing: plainRates(0.1, 0.4, 0.01) },
  {
    match: 'gemini-1.5-pro',
    pricing: { ...plainRates(1.25, 5, 0.125), unmodeledPremiumAbovePromptTokens: 128_000 },
  },

  // --- OpenRouter / Z.AI (GLM) ---
  // The specific slug precedes the broad 'z-ai/' guard: 'z-ai/glm-5.2'
  // contains both substrings and the table is first-match-wins.
  { match: 'glm-5.2', pricing: plainRates(0.6, 2.2, 0.11) },
  // Any other z-ai/ slug gets GLM-5.2-family pricing rather than the generic fallback.
  { match: 'z-ai/', pricing: plainRates(0.6, 2.2, 0.11) },
];

/** Sonnet-class default for an unknown non-Claude model. */
const UNKNOWN_MODEL_PRICING: ModelPricing = anthropicRates(3, 15, 0.3);

/** IronCurtain's qualified provider prefixes (`provider:model`). */
const QUALIFIED_PROVIDER_PREFIX = /^(?:anthropic|openai|google):/;

/**
 * Canonical form of a model id for price lookup: trimmed, lower-cased and
 * without an IronCurtain provider prefix. A Claude id additionally loses any
 * vendor or gateway prefix ('anthropic/', 'anthropic.', 'us.anthropic.'), a
 * Vertex '@date', a ':variant' or Bedrock ':0' suffix, a '[1m]' context tag,
 * a Bedrock '-v1' suffix and a dated '-20251101' or '-latest' snapshot
 * suffix, and dots become dashes ('claude-opus-4.5' -> 'claude-opus-4-5').
 * Other ids keep their dots, which the substring table relies on
 * ('gpt-5.2', 'z-ai/glm-5.2').
 */
export function normalizeModelId(modelId: string): string {
  const id = modelId.trim().toLowerCase().replace(QUALIFIED_PROVIDER_PREFIX, '');
  const claudeAt = id.indexOf('claude');
  if (claudeAt === -1) return id;
  return id
    .slice(claudeAt)
    .replace(/[@:[].*$/, '')
    .replace(/\./g, '-')
    .replace(/-v\d+$/, '')
    .replace(/-(?:\d{8}|latest)$/, '');
}

function isClaudeId(normalizedId: string): boolean {
  return normalizedId.startsWith('claude');
}

function pricingFromOverride(override: ModelPricingOverride): ModelPricing {
  return {
    inputPerMillion: override.inputPerMillion,
    outputPerMillion: override.outputPerMillion,
    cacheReadPerMillion: override.cacheReadPerMillion ?? override.inputPerMillion,
    cacheWrite5mPerMillion: override.cacheWrite5mPerMillion ?? override.inputPerMillion * CACHE_WRITE_5M_MULTIPLIER,
    cacheWrite1hPerMillion: override.cacheWrite1hPerMillion ?? override.inputPerMillion * CACHE_WRITE_1H_MULTIPLIER,
  };
}

function findOverride(
  normalizedId: string,
  overrides: ModelPricingOverrides | undefined,
): ModelPricingOverride | undefined {
  if (!overrides) return undefined;
  for (const [key, override] of Object.entries(overrides)) {
    if (normalizeModelId(key) === normalizedId) return override;
  }
  return undefined;
}

function formatRate(perMillion: number): string {
  return `$${perMillion.toFixed(2)}`;
}

/**
 * A JSON string literal for `id` made only of printable ASCII: JSON.stringify
 * escapes quotes, backslashes and C0 controls, and every other character
 * outside printable ASCII (DEL, C1 controls such as the 8-bit CSI, bidi
 * overrides) becomes a \uXXXX escape. The result is still valid JSON.
 */
function quoteId(id: string): string {
  return JSON.stringify(id).replace(
    /[^\x20-\x7e]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/**
 * The warning shown (CLI, Signal, web UI, logs) when a model has no listed
 * price. A model id can come from a workflow definition, so ids are quoted
 * with quoteId(): control characters are escaped rather than reaching a
 * terminal, and the suggested config key can be pasted into config.json.
 */
function unknownModelWarning(modelId: string, normalizedId: string, pricing: ModelPricing, assumed: string): string {
  return (
    `No list price is known for model ${quoteId(modelId)}; cost estimates assume ${assumed} ` +
    `(${formatRate(pricing.inputPerMillion)} input / ${formatRate(pricing.outputPerMillion)} output per million tokens). ` +
    `Set resourceBudget.modelPricing[${quoteId(normalizedId)}] in config.json to use its actual price.`
  );
}

/**
 * Resolves the price for a model id: a matching override first, then the
 * table, then a fail-closed default with a warning.
 */
export function resolveModelPricing(modelId: string, overrides?: ModelPricingOverrides): ResolvedModelPricing {
  const normalizedId = normalizeModelId(modelId);

  const override = findOverride(normalizedId, overrides);
  if (override) {
    return { modelId, normalizedId, pricing: pricingFromOverride(override), source: 'override' };
  }

  if (isClaudeId(normalizedId)) {
    const listed = CLAUDE_PRICING.get(normalizedId);
    if (listed) return { modelId, normalizedId, pricing: listed, source: 'list' };
    return {
      modelId,
      normalizedId,
      pricing: UNKNOWN_CLAUDE_PRICING,
      source: 'unknown_claude',
      warning: unknownModelWarning(modelId, normalizedId, UNKNOWN_CLAUDE_PRICING, 'the highest Claude tier'),
    };
  }

  for (const entry of OTHER_PROVIDER_PRICING) {
    if (normalizedId.includes(entry.match)) {
      return { modelId, normalizedId, pricing: entry.pricing, source: 'list' };
    }
  }

  return {
    modelId,
    normalizedId,
    pricing: UNKNOWN_MODEL_PRICING,
    source: 'unknown_model',
    warning: unknownModelWarning(modelId, normalizedId, UNKNOWN_MODEL_PRICING, 'Sonnet-class prices'),
  };
}

/** Non-negative finite count; anything else (undefined, NaN, negative) is 0. */
function count(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * The prompt of one request as the per-request tiers count it: uncached
 * input plus cache reads and writes.
 */
function promptTokensOf(usage: RequestTokenUsage): number {
  return (
    count(usage.uncachedInputTokens) +
    count(usage.cacheReadTokens) +
    count(usage.cacheWrite5mTokens) +
    count(usage.cacheWrite1hTokens)
  );
}

/**
 * Estimated list-price cost of one request in USD. The long-prompt tier, if
 * the model has one, is chosen from this request's prompt size alone.
 */
export function estimateRequestCostUsd(pricing: ModelPricing, usage: RequestTokenUsage): number {
  const uncached = count(usage.uncachedInputTokens);
  const cacheRead = count(usage.cacheReadTokens);
  const cacheWrite5m = count(usage.cacheWrite5mTokens);
  const cacheWrite1h = count(usage.cacheWrite1hTokens);
  const output = count(usage.outputTokens);

  const tier = pricing.longPrompt;
  const rates: TokenRates = tier && promptTokensOf(usage) > tier.thresholdPromptTokens ? tier.rates : pricing;

  return (
    (uncached * rates.inputPerMillion +
      cacheRead * rates.cacheReadPerMillion +
      cacheWrite5m * rates.cacheWrite5mPerMillion +
      cacheWrite1h * rates.cacheWrite1hPerMillion +
      output * rates.outputPerMillion) /
    1_000_000
  );
}

/**
 * True when one request's prompt is past its row's
 * `unmodeledPremiumAbovePromptTokens`, so it bills at long-context prices this
 * table does not model. Decided per request, never from turn totals.
 */
export function exceedsUnmodeledLongContext(pricing: ModelPricing, usage: RequestTokenUsage): boolean {
  const threshold = pricing.unmodeledPremiumAbovePromptTokens;
  return threshold !== undefined && promptTokensOf(usage) > threshold;
}

/**
 * The factor a cost cap applies to every rate (input, output, cache reads and
 * writes) of a request past its row's `unmodeledPremiumAbovePromptTokens`. It
 * bounds the long-context prices the table does not model: the 1M-token
 * context beta of older Claude models and the upper tier of Gemini 2.5, 3 and
 * 3.1 Pro bill input at 2x and output at 1.5x the listed rates, and Gemini
 * 1.5 Pro above 128K tokens bills both at 2x.
 */
export const UNMODELED_LONG_CONTEXT_CAP_MULTIPLIER = 2;

/** One request's cost as a cost cap charges it ({@link estimateCapRequestCostUsd}). */
export interface CapRequestCost {
  readonly costUsd: number;
  /**
   * The prompt was past the row's `unmodeledPremiumAbovePromptTokens`, so
   * every rate was charged at {@link UNMODELED_LONG_CONTEXT_CAP_MULTIPLIER}
   * times the listed one. Callers surface {@link unmodeledLongContextWarning}
   * once per model.
   */
  readonly unmodeledLongContext: boolean;
}

/**
 * One request's cost for enforcing a cost cap (the MITM budget gate, the
 * builtin ResourceBudgetTracker): the list price
 * ({@link estimateRequestCostUsd}), except that a prompt past the row's
 * `unmodeledPremiumAbovePromptTokens` bills at long-context prices the table
 * does not model, so its every rate is charged at
 * {@link UNMODELED_LONG_CONTEXT_CAP_MULTIPLIER} times the listed one instead
 * of letting the cap be overrun. A cost reported as a list price never uses
 * this: `cost-estimate.ts` refuses such prompts.
 */
export function estimateCapRequestCostUsd(pricing: ModelPricing, usage: RequestTokenUsage): CapRequestCost {
  const listed = estimateRequestCostUsd(pricing, usage);
  if (!exceedsUnmodeledLongContext(pricing, usage)) return { costUsd: listed, unmodeledLongContext: false };
  return { costUsd: listed * UNMODELED_LONG_CONTEXT_CAP_MULTIPLIER, unmodeledLongContext: true };
}

/**
 * The notice a cost cap surfaces, once per model, the first time it charges a
 * request at {@link UNMODELED_LONG_CONTEXT_CAP_MULTIPLIER} times the listed
 * rates. The model id can come from an agent's request, so it is quoted with
 * quoteId() (no control characters reach a terminal).
 */
export function unmodeledLongContextWarning(modelId: string, pricing: ModelPricing): string {
  const threshold = Math.round(count(pricing.unmodeledPremiumAbovePromptTokens ?? 0)).toLocaleString('en-US');
  return (
    `Model ${quoteId(modelId)} bills prompts over ${threshold} tokens at long-context prices the price table ` +
    `does not list; cost limits charge such requests at ${UNMODELED_LONG_CONTEXT_CAP_MULTIPLIER}x the listed rates.`
  );
}

function scaleRates(rates: TokenRates, factor: number): TokenRates {
  return {
    inputPerMillion: rates.inputPerMillion * factor,
    outputPerMillion: rates.outputPerMillion * factor,
    cacheReadPerMillion: rates.cacheReadPerMillion * factor,
    cacheWrite5mPerMillion: rates.cacheWrite5mPerMillion * factor,
    cacheWrite1hPerMillion: rates.cacheWrite1hPerMillion * factor,
  };
}

/**
 * The prices of a request at `speed`: the listed (standard) prices, or for
 * fast mode every rate scaled by the model's `fastModeMultiplier`. Returns
 * undefined for a fast request on a model without a fast-mode price, so the
 * caller reports the cost as unknown rather than pricing it as standard.
 */
export function pricingForSpeed(pricing: ModelPricing, speed: PricingSpeed): ModelPricing | undefined {
  if (speed === 'standard') return pricing;
  const factor = pricing.fastModeMultiplier;
  if (factor === undefined) return undefined;
  return {
    ...scaleRates(pricing, factor),
    ...(pricing.longPrompt
      ? {
          longPrompt: {
            thresholdPromptTokens: pricing.longPrompt.thresholdPromptTokens,
            rates: scaleRates(pricing.longPrompt.rates, factor),
          },
        }
      : {}),
    ...(pricing.unmodeledPremiumAbovePromptTokens !== undefined
      ? { unmodeledPremiumAbovePromptTokens: pricing.unmodeledPremiumAbovePromptTokens }
      : {}),
  };
}
