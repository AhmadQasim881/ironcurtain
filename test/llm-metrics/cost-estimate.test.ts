/**
 * Host-side list-price estimates for observed exchanges (MET-3).
 */

import { describe, expect, it } from 'vitest';
import {
  estimateListPriceCostUsd,
  exchangeCostUsd,
  UNRECOGNIZED_PRICING_MODE,
  type ListPriceInput,
} from '../../src/llm-metrics/cost-estimate.js';
import { makeNormalizedUsage, type NormalizedUsageInput } from '../../src/llm-metrics/normalization.js';
import { PRICING_VERSION } from '../../src/llm-metrics/pricing.js';

/** Anthropic-shaped complete usage: input total = uncached + cache read + cache write. */
function anthropicUsage(
  counts: {
    uncached: number;
    cacheRead?: number;
    cacheWrite?: number;
    output: number;
  },
  extra: NormalizedUsageInput = {},
): ReturnType<typeof makeNormalizedUsage> {
  const cacheRead = counts.cacheRead ?? 0;
  const cacheWrite = counts.cacheWrite ?? 0;
  return makeNormalizedUsage({
    inputTokensReported: counts.uncached,
    inputTokensTotal: counts.uncached + cacheRead + cacheWrite,
    inputTokensUncached: counts.uncached,
    cacheReadInputTokens: cacheRead,
    cacheWriteInputTokens: cacheWrite,
    outputTokensTotal: counts.output,
    canonicalTotalTokens: counts.uncached + cacheRead + cacheWrite + counts.output,
    usageCompleteness: 'complete',
    ...extra,
  });
}

function input(overrides: Partial<ListPriceInput> & Pick<ListPriceInput, 'usage'>): ListPriceInput {
  return {
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    speed: null,
    serviceTier: null,
    responseStatus: 200,
    terminal: true,
    ...overrides,
  };
}

function priced(result: ReturnType<typeof estimateListPriceCostUsd>): number {
  if (result.kind !== 'priced') throw new Error(`expected a price, got ${result.reason}`);
  return result.costUsd;
}

describe('estimateListPriceCostUsd', () => {
  it('prices each token kind at the model rate, with the 5m/1h cache-write split', () => {
    // Opus 5.5: $4 in, $20 out, $0.20 cache read, 5m write 1.25x ($5), 1h write 2x ($8).
    const usage = anthropicUsage(
      { uncached: 1_000_000, cacheRead: 2_000_000, cacheWrite: 300_000, output: 100_000 },
      { cacheWrite5mInputTokens: 100_000, cacheWrite1hInputTokens: 200_000 },
    );
    const result = estimateListPriceCostUsd(input({ usage }));
    expect(result).toMatchObject({ kind: 'priced', pricingVersion: PRICING_VERSION, qualityFlags: [] });
    expect(priced(result)).toBeCloseTo(4 + 0.4 + 0.5 + 1.6 + 2, 9);
  });

  it('derives a missing half of the split from the cache-write total', () => {
    const usage = anthropicUsage(
      { uncached: 0, cacheWrite: 1_000_000, output: 0 },
      { cacheWrite1hInputTokens: 250_000, cacheWrite5mInputTokens: null },
    );
    expect(priced(estimateListPriceCostUsd(input({ usage })))).toBeCloseTo(0.75 * 5 + 0.25 * 8, 9);
  });

  it('prices unsplit cache writes as 5-minute writes and says so', () => {
    const usage = anthropicUsage({ uncached: 0, cacheWrite: 1_000_000, output: 0 });
    const result = estimateListPriceCostUsd(input({ usage }));
    expect(priced(result)).toBeCloseTo(5, 9);
    expect(result).toMatchObject({ qualityFlags: ['list_price_assumed_5m_cache_writes'] });
  });

  it('refuses a split that contradicts the cache-write total', () => {
    const usage = anthropicUsage(
      { uncached: 10, cacheWrite: 100, output: 1 },
      { cacheWrite5mInputTokens: 60, cacheWrite1hInputTokens: 60 },
    );
    expect(estimateListPriceCostUsd(input({ usage }))).toEqual({ kind: 'unavailable', reason: 'contradictory_usage' });
  });

  it('applies fast mode (Opus 5.5: $8/$40) from the speed field, cache rates included', () => {
    const usage = anthropicUsage({ uncached: 1_000_000, cacheRead: 1_000_000, output: 1_000_000 });
    expect(priced(estimateListPriceCostUsd(input({ usage, speed: 'fast' })))).toBeCloseTo(8 + 0.4 + 40, 9);
    expect(priced(estimateListPriceCostUsd(input({ usage, speed: 'standard' })))).toBeCloseTo(4 + 0.2 + 20, 9);
    expect(priced(estimateListPriceCostUsd(input({ usage, model: 'claude-opus-4-8', speed: 'fast' })))).toBeCloseTo(
      10 + 1 + 50,
      9,
    );
  });

  it('does not price a fast request on a model without a fast-mode price', () => {
    const usage = anthropicUsage({ uncached: 10, output: 10 });
    expect(estimateListPriceCostUsd(input({ usage, model: 'claude-sonnet-5-5', speed: 'fast' }))).toEqual({
      kind: 'unavailable',
      reason: 'unpriced_speed',
    });
  });

  it('uses the served model, normalizing dated and provider-prefixed ids', () => {
    // 100K prompt tokens: within the 200K window both models bill at their listed rates.
    const usage = anthropicUsage({ uncached: 100_000, output: 0 });
    expect(priced(estimateListPriceCostUsd(input({ usage, model: 'claude-sonnet-4-5-20250929' })))).toBeCloseTo(0.3, 9);
    expect(priced(estimateListPriceCostUsd(input({ usage, model: 'anthropic/claude-haiku-4.5' })))).toBeCloseTo(0.1, 9);
  });

  it('never prices an unlisted model with a fail-closed default', () => {
    const usage = anthropicUsage({ uncached: 10, output: 10 });
    expect(estimateListPriceCostUsd(input({ usage, model: 'claude-future-9' }))).toEqual({
      kind: 'unavailable',
      reason: 'unknown_model',
    });
    expect(estimateListPriceCostUsd(input({ usage, model: 'mystery-model' }))).toEqual({
      kind: 'unavailable',
      reason: 'unknown_model',
    });
    expect(estimateListPriceCostUsd(input({ usage, model: null }))).toEqual({
      kind: 'unavailable',
      reason: 'unknown_model',
    });
  });

  it('leaves partial usage unpriced instead of guessing the missing part', () => {
    const usage = makeNormalizedUsage({
      inputTokensTotal: 100,
      inputTokensUncached: 100,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      usageCompleteness: 'partial',
    });
    expect(estimateListPriceCostUsd(input({ usage }))).toEqual({ kind: 'unavailable', reason: 'incomplete_usage' });
  });

  it('prices an error response without usage at zero (not billed)', () => {
    const usage = makeNormalizedUsage();
    expect(estimateListPriceCostUsd(input({ usage, responseStatus: 429 }))).toMatchObject({
      kind: 'priced',
      costUsd: 0,
    });
    // Without a response there is no evidence the request was not billed.
    expect(estimateListPriceCostUsd(input({ usage, responseStatus: null }))).toMatchObject({ kind: 'unavailable' });
  });

  it('does not price service tiers or server tools that have their own price lists', () => {
    const usage = anthropicUsage({ uncached: 10, output: 10 });
    expect(estimateListPriceCostUsd(input({ usage, serviceTier: 'priority' }))).toEqual({
      kind: 'unavailable',
      reason: 'unpriced_service_tier',
    });
    expect(priced(estimateListPriceCostUsd(input({ usage, serviceTier: 'standard' })))).toBeGreaterThan(0);
    const searched = anthropicUsage(
      { uncached: 10, output: 10 },
      { serverToolRequests: { webSearchRequests: 2, webFetchRequests: null } },
    );
    expect(estimateListPriceCostUsd(input({ usage: searched }))).toEqual({
      kind: 'unavailable',
      reason: 'unpriced_server_tools',
    });
  });

  it('prices each attempt of a multi-model exchange at its own model', () => {
    // A refusal fallback: Fable 5.1 declined, Opus 4.8 answered (5m cache writes only).
    const usage = anthropicUsage(
      { uncached: 3_020, cacheRead: 2_048, cacheWrite: 2_048, output: 430 },
      {
        cacheWrite5mInputTokens: 2_048,
        cacheWrite1hInputTokens: 0,
        iterations: [
          {
            kind: 'message',
            model: 'claude-fable-5-1',
            inputTokensUncached: 1_500,
            cacheReadInputTokens: 2_048,
            cacheWriteInputTokens: 0,
            outputTokens: 120,
          },
          {
            kind: 'fallback_message',
            model: 'claude-opus-4-8',
            inputTokensUncached: 1_520,
            cacheReadInputTokens: 0,
            cacheWriteInputTokens: 2_048,
            outputTokens: 310,
          },
        ],
      },
    );
    const fable = (1_500 * 10 + 2_048 * 0.25 + 120 * 50) / 1e6;
    const opus = (1_520 * 5 + 2_048 * 6.25 + 310 * 25) / 1e6;
    expect(priced(estimateListPriceCostUsd(input({ usage, model: 'claude-opus-4-8' })))).toBeCloseTo(fable + opus, 12);
  });

  it('prices same-model iterations from the totals, and refuses ambiguous multi-model splits', () => {
    const sameModel = anthropicUsage(
      { uncached: 2_000, output: 200 },
      {
        iterations: [
          {
            kind: 'compaction',
            model: null,
            inputTokensUncached: 1_000,
            cacheReadInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: 100,
          },
          {
            kind: 'message',
            model: 'claude-opus-5-5',
            inputTokensUncached: 1_000,
            cacheReadInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: 100,
          },
        ],
      },
    );
    expect(priced(estimateListPriceCostUsd(input({ usage: sameModel })))).toBeCloseTo((2_000 * 4 + 200 * 20) / 1e6, 12);

    const mixedSplit = anthropicUsage(
      { uncached: 0, cacheWrite: 200, output: 0 },
      {
        cacheWrite5mInputTokens: 100,
        cacheWrite1hInputTokens: 100,
        iterations: [
          {
            kind: 'message',
            model: 'claude-opus-5-5',
            inputTokensUncached: 0,
            cacheReadInputTokens: 0,
            cacheWriteInputTokens: 100,
            outputTokens: 0,
          },
          {
            kind: 'advisor_message',
            model: 'claude-fable-5-1',
            inputTokensUncached: 0,
            cacheReadInputTokens: 0,
            cacheWriteInputTokens: 100,
            outputTokens: 0,
          },
        ],
      },
    );
    expect(estimateListPriceCostUsd(input({ usage: mixedSplit }))).toEqual({
      kind: 'unavailable',
      reason: 'unpriced_iterations',
    });
  });

  it('applies a per-request long-prompt tier (Claude Haiku 5.5 over 100K prompt tokens)', () => {
    const short = anthropicUsage({ uncached: 100_000, output: 1_000_000 });
    const long = anthropicUsage({ uncached: 100_001, output: 1_000_000 });
    expect(priced(estimateListPriceCostUsd(input({ usage: short, model: 'claude-haiku-5-5' })))).toBeCloseTo(
      0.01 + 0.5,
      9,
    );
    expect(priced(estimateListPriceCostUsd(input({ usage: long, model: 'claude-haiku-5-5' })))).toBeCloseTo(
      (100_001 * 0.5) / 1e6 + 2.5,
      9,
    );
  });

  it('prices OpenAI usage, whose input total includes cached tokens and which has no cache writes', () => {
    // gpt-5.2: $1.75 in, $14 out, $0.175 cached.
    const usage = makeNormalizedUsage({
      inputTokensTotal: 1_000_000,
      inputTokensUncached: 600_000,
      cacheReadInputTokens: 400_000,
      cacheWriteInputTokens: null,
      outputTokensTotal: 100_000,
      usageCompleteness: 'complete',
    });
    expect(priced(estimateListPriceCostUsd(input({ usage, provider: 'openai', model: 'gpt-5.2-codex' })))).toBeCloseTo(
      0.6 * 1.75 + 0.4 * 0.175 + 0.1 * 14,
      9,
    );
  });

  it('does not price a stream cut off before its terminal event, whose usage is not final', () => {
    // Anthropic's message_start already carries input and `output_tokens: 1`,
    // which looks complete; the output billed before the cut is unknown.
    const usage = anthropicUsage({ uncached: 1_000, output: 1 });
    expect(estimateListPriceCostUsd(input({ usage, terminal: false }))).toEqual({
      kind: 'unavailable',
      reason: 'incomplete_usage',
    });
    expect(priced(estimateListPriceCostUsd(input({ usage, terminal: true })))).toBeGreaterThan(0);
  });

  it("prices only models of the provider whose origin served them, at that provider's list prices", () => {
    const usage = anthropicUsage({ uncached: 1_000, output: 10 });
    // Z.AI's Anthropic-compatible endpoint can answer under a Claude id, but
    // does not bill Anthropic's prices.
    expect(estimateListPriceCostUsd(input({ usage, provider: 'zai', model: 'claude-haiku-4-5' }))).toEqual({
      kind: 'unavailable',
      reason: 'unknown_model',
    });
    expect(estimateListPriceCostUsd(input({ usage, provider: 'openai', model: 'claude-opus-5-5' }))).toEqual({
      kind: 'unavailable',
      reason: 'unknown_model',
    });
    expect(estimateListPriceCostUsd(input({ usage, provider: 'anthropic', model: 'gpt-5.2' }))).toEqual({
      kind: 'unavailable',
      reason: 'unknown_model',
    });
    expect(estimateListPriceCostUsd(input({ usage, provider: 'example', model: 'claude-opus-5-5' }))).toEqual({
      kind: 'unavailable',
      reason: 'unknown_model',
    });
    // A fine-tuned OpenAI model bills at its own prices, not the base model's.
    expect(
      estimateListPriceCostUsd(input({ usage, provider: 'openai', model: 'ft:gpt-4o-mini-2024-07-18:org::abc' })),
    ).toEqual({ kind: 'unavailable', reason: 'unknown_model' });
    expect(priced(estimateListPriceCostUsd(input({ usage, provider: 'zai', model: 'glm-5.2' })))).toBeGreaterThan(0);
    expect(
      priced(estimateListPriceCostUsd(input({ usage, provider: 'google', model: 'gemini-2.5-flash' }))),
    ).toBeGreaterThan(0);
  });

  it('leaves a speed or service tier it does not recognize unpriced', () => {
    const usage = anthropicUsage({ uncached: 10, output: 10 });
    expect(estimateListPriceCostUsd(input({ usage, speed: UNRECOGNIZED_PRICING_MODE }))).toEqual({
      kind: 'unavailable',
      reason: 'unpriced_speed',
    });
    expect(estimateListPriceCostUsd(input({ usage, serviceTier: UNRECOGNIZED_PRICING_MODE }))).toEqual({
      kind: 'unavailable',
      reason: 'unpriced_service_tier',
    });
  });

  it('refuses cache writes whose TTL split the protocol discarded as contradictory', () => {
    // The adapter drops both halves of a split that does not add up and flags
    // it; pricing every write as a 5-minute write would then be a guess.
    const usage = anthropicUsage(
      { uncached: 10, cacheWrite: 100, output: 1 },
      { qualityFlags: ['contradictory_usage:cache_creation_split'] },
    );
    expect(estimateListPriceCostUsd(input({ usage }))).toEqual({ kind: 'unavailable', reason: 'contradictory_usage' });
  });

  it('does not price a prompt past a long-context premium the table does not model', () => {
    const atLimit = anthropicUsage({ uncached: 150_000, cacheRead: 50_000, output: 1_000 });
    const pastLimit = anthropicUsage({ uncached: 150_000, cacheRead: 50_001, output: 1_000 });
    // Sonnet 4.x and Opus 4.6 bill a prompt over 200K tokens (1M-context beta) at a premium.
    for (const model of ['claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-opus-4-6']) {
      expect(priced(estimateListPriceCostUsd(input({ usage: atLimit, model })))).toBeGreaterThan(0);
      expect(estimateListPriceCostUsd(input({ usage: pastLimit, model }))).toEqual({
        kind: 'unavailable',
        reason: 'unpriced_long_context',
      });
    }
    // Opus 4.7 and later bill their whole 1M window at the listed rates.
    const long = anthropicUsage({ uncached: 800_000, output: 1_000 });
    expect(priced(estimateListPriceCostUsd(input({ usage: long, model: 'claude-opus-4-7' })))).toBeCloseTo(
      (800_000 * 5 + 1_000 * 25) / 1e6,
      9,
    );
    // Gemini Pro bills a higher tier above 200K prompt tokens.
    const gemini = makeNormalizedUsage({
      inputTokensTotal: 300_000,
      inputTokensUncached: 300_000,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: null,
      outputTokensTotal: 10,
      usageCompleteness: 'complete',
    });
    expect(estimateListPriceCostUsd(input({ usage: gemini, provider: 'google', model: 'gemini-2.5-pro' }))).toEqual({
      kind: 'unavailable',
      reason: 'unpriced_long_context',
    });
  });

  it('decides a prompt-size tier per attempt, not on the sum of same-model attempts', () => {
    // Two Haiku 5.5 attempts of 60K prompt tokens each: each is under the
    // 100K long-prompt threshold, although their sum is not.
    const attempt = {
      kind: 'message' as const,
      model: 'claude-haiku-5-5',
      inputTokensUncached: 60_000,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 1_000,
    };
    const usage = anthropicUsage(
      { uncached: 120_000, output: 2_000 },
      { iterations: [{ ...attempt, kind: 'compaction', model: null }, attempt] },
    );
    expect(priced(estimateListPriceCostUsd(input({ usage, model: 'claude-haiku-5-5' })))).toBeCloseTo(
      2 * ((60_000 * 0.1 + 1_000 * 0.5) / 1e6),
      12,
    );
  });
});

describe('exchangeCostUsd', () => {
  it('prefers the gateway-reported cost, then the estimate, else unknown', () => {
    expect(exchangeCostUsd({ costUsd: 0.5, estimatedCostUsd: 0.7 })).toBe(0.5);
    expect(exchangeCostUsd({ costUsd: null, estimatedCostUsd: 0.7 })).toBe(0.7);
    expect(exchangeCostUsd({ costUsd: 0, estimatedCostUsd: null })).toBe(0);
    expect(exchangeCostUsd({ costUsd: null })).toBeNull();
    expect(exchangeCostUsd({ costUsd: Number.NaN, estimatedCostUsd: -1 })).toBeNull();
  });
});
