import { describe, it, expect } from 'vitest';
import {
  PRICING_VERSION,
  UNMODELED_LONG_CONTEXT_CAP_MULTIPLIER,
  estimateCapRequestCostUsd,
  estimateRequestCostUsd,
  normalizeModelId,
  pricingForSpeed,
  resolveModelPricing,
  unmodeledLongContextWarning,
  type RequestTokenUsage,
} from '../src/llm-metrics/pricing.js';

const MILLION = 1_000_000;

function usage(overrides: Partial<RequestTokenUsage>): RequestTokenUsage {
  return {
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    outputTokens: 0,
    ...overrides,
  };
}

/** Cost of `tokens` of one kind for `modelId`, in USD. */
function cost(modelId: string, tokens: Partial<RequestTokenUsage>): number {
  return estimateRequestCostUsd(resolveModelPricing(modelId).pricing, usage(tokens));
}

describe('normalizeModelId', () => {
  it.each([
    ['anthropic:claude-opus-5-5', 'claude-opus-5-5'],
    ['claude-opus-5-5', 'claude-opus-5-5'],
    ['Claude-Opus-5-5', 'claude-opus-5-5'],
    ['  anthropic:claude-sonnet-4-6  ', 'claude-sonnet-4-6'],
    // OpenRouter slugs: vendor prefix and dots.
    ['anthropic/claude-opus-4.5', 'claude-opus-4-5'],
    ['anthropic/claude-sonnet-4.5:beta', 'claude-sonnet-4-5'],
    // Bedrock ids: vendor prefix, region profile, date and version suffixes.
    ['anthropic.claude-opus-5-5', 'claude-opus-5-5'],
    ['us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'claude-sonnet-4-5'],
    // Vertex '@date' and dated first-party snapshots.
    ['claude-opus-4-5@20251101', 'claude-opus-4-5'],
    ['claude-haiku-4-5-20251001', 'claude-haiku-4-5'],
    ['claude-opus-4-1-20250805', 'claude-opus-4-1'],
    ['claude-opus-4-20250514', 'claude-opus-4'],
    ['claude-sonnet-4-5[1m]', 'claude-sonnet-4-5'],
    // Non-Claude ids keep their dots (the substring table relies on them).
    ['openai:gpt-5.2', 'gpt-5.2'],
    ['z-ai/glm-5.2', 'z-ai/glm-5.2'],
    ['google:gemini-2.5-pro', 'gemini-2.5-pro'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeModelId(input)).toBe(expected);
  });
});

describe('Claude list prices (USD per million tokens)', () => {
  // [model id, input, output, cache read]
  const table: ReadonlyArray<readonly [string, number, number, number]> = [
    ['claude-fable-5-1', 10, 50, 0.25],
    ['claude-mythos-5-1', 10, 50, 0.25],
    ['claude-fable-5', 10, 50, 1],
    ['claude-mythos-5', 10, 50, 1],
    ['claude-opus-5-5', 4, 20, 0.2],
    ['claude-opus-5', 5, 25, 0.5],
    ['claude-opus-4-8', 5, 25, 0.5],
    ['claude-opus-4-7', 5, 25, 0.5],
    ['claude-opus-4-6', 5, 25, 0.5],
    ['claude-opus-4-5', 5, 25, 0.5],
    ['claude-opus-4-1', 15, 75, 1.5],
    ['claude-opus-4-0', 15, 75, 1.5],
    ['claude-sonnet-5-5', 2, 10, 0.2],
    ['claude-sonnet-5', 2, 10, 0.2],
    ['claude-sonnet-4-6', 3, 15, 0.3],
    ['claude-sonnet-4-5', 3, 15, 0.3],
    ['claude-haiku-5-5', 0.1, 0.5, 0.01],
    ['claude-haiku-4-5', 1, 5, 0.1],
  ];

  describe.each(table)('%s', (modelId, input, output, cacheRead) => {
    it('is listed (no fail-closed warning)', () => {
      const resolved = resolveModelPricing(`anthropic:${modelId}`);
      expect(resolved.source).toBe('list');
      expect(resolved.warning).toBeUndefined();
      expect(resolved.normalizedId).toBe(modelId);
    });

    // 100K tokens keeps every request at or under Haiku 5.5's 100K threshold.
    it('prices input, output and cache reads', () => {
      expect(cost(modelId, { uncachedInputTokens: 100_000 })).toBeCloseTo((100_000 * input) / MILLION, 12);
      expect(cost(modelId, { outputTokens: 100_000 })).toBeCloseTo((100_000 * output) / MILLION, 12);
      expect(cost(modelId, { cacheReadTokens: 100_000 })).toBeCloseTo((100_000 * cacheRead) / MILLION, 12);
    });

    it('prices cache writes at 1.25x input (5-minute TTL) and 2x input (1-hour TTL)', () => {
      expect(cost(modelId, { cacheWrite5mTokens: 100_000 })).toBeCloseTo((100_000 * input * 1.25) / MILLION, 12);
      expect(cost(modelId, { cacheWrite1hTokens: 100_000 })).toBeCloseTo((100_000 * input * 2) / MILLION, 12);
    });
  });

  it.each([
    // 1M input + 1M output, the audit's probe (old estimate in the comment).
    ['claude-opus-5-5', 24], // was $90
    ['claude-opus-5', 30], // was $90
    ['claude-opus-4-8', 30], // was $90
    ['claude-sonnet-5-5', 12], // was $18
    ['claude-fable-5-1', 60], // was $18
    ['claude-mythos-5-1', 60], // was $18
    ['claude-haiku-4-5', 6],
  ])('%s: 1M input + 1M output costs $%d', (modelId, expected) => {
    expect(cost(modelId, { uncachedInputTokens: MILLION, outputTokens: MILLION })).toBeCloseTo(expected, 9);
  });

  it('prices the same model the same way under every id spelling', () => {
    const spellings = [
      'claude-opus-4-5',
      'anthropic:claude-opus-4-5',
      'anthropic/claude-opus-4.5',
      'anthropic.claude-opus-4-5-20251101-v1:0',
      'claude-opus-4-5@20251101',
    ];
    const costs = spellings.map((id) => cost(id, { uncachedInputTokens: MILLION, outputTokens: MILLION }));
    expect(new Set(costs)).toEqual(new Set([30]));
  });
});

describe('Claude Haiku 5.5 long-prompt tier', () => {
  const HAIKU = 'claude-haiku-5-5';

  it('bills a prompt of exactly 100K tokens at the base tier', () => {
    expect(cost(HAIKU, { uncachedInputTokens: 100_000, outputTokens: 10_000 })).toBeCloseTo(
      (100_000 * 0.1 + 10_000 * 0.5) / MILLION,
      12,
    );
  });

  it('bills every token of a prompt over 100K at $0.50 / $2.50, cache reads and writes included', () => {
    const tokens = {
      uncachedInputTokens: 80_000,
      cacheReadTokens: 20_000,
      cacheWrite5mTokens: 1,
      outputTokens: 10_000,
    };
    const expected = 80_000 * 0.5 + 20_000 * 0.05 + 1 * 0.5 * 1.25 + 10_000 * 2.5;
    expect(cost(HAIKU, tokens)).toBeCloseTo(expected / MILLION, 12);
  });

  it('counts cache reads and writes toward the threshold', () => {
    // 60K uncached + 50K cache reads = 110K prompt tokens.
    const expected = 60_000 * 0.5 + 50_000 * 0.05;
    expect(cost(HAIKU, { uncachedInputTokens: 60_000, cacheReadTokens: 50_000 })).toBeCloseTo(expected / MILLION, 12);
  });
});

describe('models missing from the table', () => {
  it.each(['claude-opus-6', 'anthropic:claude-sonnet', 'claude-mythos-preview', 'anthropic/claude-3.5-haiku'])(
    'prices unknown Claude id %s at the highest Claude tier with a warning',
    (modelId) => {
      const resolved = resolveModelPricing(modelId);
      expect(resolved.source).toBe('unknown_claude');
      expect(resolved.pricing.inputPerMillion).toBe(10);
      expect(resolved.pricing.outputPerMillion).toBe(50);
      expect(resolved.pricing.cacheReadPerMillion).toBe(1);
      expect(resolved.warning).toContain(modelId);
      expect(resolved.warning).toContain(`resourceBudget.modelPricing["${resolved.normalizedId}"]`);
    },
  );

  it('escapes control characters of the model id in the warning (ids can come from workflow definitions)', () => {
    // ESC (C0), CSI (C1), DEL and a bidi override.
    const modelId = 'claude-opus-9\u001b]0;pwned\u0007\u009b2J\u007f‮';
    const { warning } = resolveModelPricing(modelId);
    expect(warning).toBeDefined();
    // Nothing outside printable ASCII reaches a terminal...
    expect(warning).toMatch(/^[\x20-\x7e]+$/);
    // ...and the quoted ids are valid JSON that decodes to the original strings.
    const quoted = warning?.match(/^No list price is known for model (".*?(?<!\\)");/)?.[1];
    expect(JSON.parse(quoted ?? 'null')).toBe(modelId);
    const key = warning?.match(/resourceBudget\.modelPricing\[(".*?(?<!\\)")\]/)?.[1];
    expect(JSON.parse(key ?? 'null')).toBe(normalizeModelId(modelId));
  });

  it('prices an unknown non-Claude model at Sonnet-class prices with a warning', () => {
    const resolved = resolveModelPricing('qwen3.5-uncensored:35b');
    expect(resolved.source).toBe('unknown_model');
    expect(
      estimateRequestCostUsd(resolved.pricing, usage({ uncachedInputTokens: MILLION, outputTokens: MILLION })),
    ).toBe(18);
    expect(resolved.warning).toContain('qwen3.5-uncensored:35b');
  });

  it.each([
    ['openai:gpt-4o-mini', 0.15, 0.6],
    ['openai/gpt-4o', 2.5, 10],
    ['openai:gpt-5.2', 1.75, 14],
    ['google:gemini-2.5-pro', 1.25, 10],
    ['z-ai/glm-5.2', 0.6, 2.2],
    ['z-ai/glm-5.2-air', 0.6, 2.2],
  ])('keeps the listed non-Claude price for %s', (modelId, input, output) => {
    const resolved = resolveModelPricing(modelId);
    expect(resolved.source).toBe('list');
    expect(resolved.warning).toBeUndefined();
    expect(resolved.pricing.inputPerMillion).toBe(input);
    expect(resolved.pricing.outputPerMillion).toBe(output);
  });
});

describe('resourceBudget.modelPricing overrides', () => {
  it('matches the model under any spelling of the override key', () => {
    const resolved = resolveModelPricing('anthropic/claude-opus-5.5', {
      'anthropic:claude-opus-5-5': { inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: 0.1 },
    });
    expect(resolved.source).toBe('override');
    expect(
      estimateRequestCostUsd(resolved.pricing, usage({ uncachedInputTokens: MILLION, outputTokens: MILLION })),
    ).toBe(3);
  });

  it('defaults omitted cache rates conservatively (reads at input, writes at 1.25x / 2x)', () => {
    const { pricing } = resolveModelPricing('my-local-model', {
      'my-local-model': { inputPerMillion: 4, outputPerMillion: 8 },
    });
    expect(pricing.cacheReadPerMillion).toBe(4);
    expect(pricing.cacheWrite5mPerMillion).toBe(5);
    expect(pricing.cacheWrite1hPerMillion).toBe(8);
  });

  it('replaces the table entry, including the long-prompt tier', () => {
    const { pricing } = resolveModelPricing('claude-haiku-5-5', {
      'claude-haiku-5-5': { inputPerMillion: 0.1, outputPerMillion: 0.5 },
    });
    expect(pricing.longPrompt).toBeUndefined();
  });

  it('leaves other models on the table', () => {
    const resolved = resolveModelPricing('claude-sonnet-4-6', {
      'claude-opus-5-5': { inputPerMillion: 1, outputPerMillion: 2 },
    });
    expect(resolved.source).toBe('list');
  });
});

describe('estimateRequestCostUsd', () => {
  it('treats negative and non-finite counts as zero', () => {
    const { pricing } = resolveModelPricing('claude-sonnet-4-6');
    expect(
      estimateRequestCostUsd(
        pricing,
        usage({ uncachedInputTokens: -5, cacheReadTokens: Number.NaN, outputTokens: Number.POSITIVE_INFINITY }),
      ),
    ).toBe(0);
  });

  it('has a dated table version', () => {
    expect(PRICING_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('pricingForSpeed', () => {
  it('returns the listed prices for standard requests', () => {
    const { pricing } = resolveModelPricing('claude-opus-5-5');
    expect(pricingForSpeed(pricing, 'standard')).toBe(pricing);
  });

  it.each([
    ['claude-opus-5-5', 8, 40],
    ['claude-opus-5', 10, 50],
    ['claude-opus-4-8', 10, 50],
  ])('prices fast mode on %s at $%d/$%d per MTok, cache rates scaled alike', (modelId, input, output) => {
    const { pricing } = resolveModelPricing(modelId);
    const fast = pricingForSpeed(pricing, 'fast');
    expect(fast).toMatchObject({ inputPerMillion: input, outputPerMillion: output });
    expect(fast?.cacheReadPerMillion).toBeCloseTo(pricing.cacheReadPerMillion * 2, 12);
    expect(fast?.cacheWrite5mPerMillion).toBeCloseTo(input * 1.25, 12);
    expect(fast?.cacheWrite1hPerMillion).toBeCloseTo(input * 2, 12);
  });

  it.each(['claude-opus-4-7', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'gpt-5.2'])(
    'has no fast-mode price for %s',
    (modelId) => {
      expect(pricingForSpeed(resolveModelPricing(modelId).pricing, 'fast')).toBeUndefined();
    },
  );

  it('keeps the standard prices of models that also offer fast mode unchanged', () => {
    expect(cost('claude-opus-5', { uncachedInputTokens: MILLION, outputTokens: MILLION })).toBeCloseTo(30, 9);
    expect(cost('claude-opus-4-8', { uncachedInputTokens: MILLION, outputTokens: MILLION })).toBeCloseTo(30, 9);
    expect(cost('claude-opus-4-7', { uncachedInputTokens: MILLION, outputTokens: MILLION })).toBeCloseTo(30, 9);
  });

  it('keeps the unmodeled long-context threshold on a fast-mode price', () => {
    const pricing = { ...resolveModelPricing('claude-opus-5-5').pricing, unmodeledPremiumAbovePromptTokens: 200_000 };
    expect(pricingForSpeed(pricing, 'fast')?.unmodeledPremiumAbovePromptTokens).toBe(200_000);
  });
});

describe('unmodeled long-context premiums', () => {
  it.each([
    ['claude-sonnet-4-6', 200_000],
    ['claude-sonnet-4-5', 200_000],
    ['claude-opus-4-6', 200_000],
    ['gemini-2.5-pro', 200_000],
    ['gemini-3.1-pro-preview', 200_000],
    ['gemini-1.5-pro', 128_000],
  ])('marks %s as billing a premium the table does not model above %d prompt tokens', (modelId, threshold) => {
    expect(resolveModelPricing(modelId).pricing.unmodeledPremiumAbovePromptTokens).toBe(threshold);
  });

  it.each(['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-5-5', 'gpt-5.2'])(
    'lists %s for its whole context window',
    (modelId) => {
      expect(resolveModelPricing(modelId).pricing.unmodeledPremiumAbovePromptTokens).toBeUndefined();
    },
  );

  it('leaves the list-price estimate at the listed rates (a list-price report refuses such prompts)', () => {
    expect(cost('claude-sonnet-4-6', { uncachedInputTokens: MILLION })).toBeCloseTo(3, 9);
    expect(cost('claude-opus-4-6', { uncachedInputTokens: MILLION })).toBeCloseTo(5, 9);
  });
});

describe('cost-cap prices (estimateCapRequestCostUsd)', () => {
  /** A request's cost as a cost cap charges it, for `modelId`. */
  function capCost(modelId: string, tokens: Partial<RequestTokenUsage>) {
    return estimateCapRequestCostUsd(resolveModelPricing(modelId).pricing, usage(tokens));
  }

  it('charges a 250K-token Sonnet 4.5 prompt at least twice its base-rate price', () => {
    const tokens = { uncachedInputTokens: 250_000, outputTokens: 10_000 };
    const base = (250_000 * 3 + 10_000 * 15) / MILLION;
    expect(cost('claude-sonnet-4-5', tokens)).toBeCloseTo(base, 12);

    const charged = capCost('claude-sonnet-4-5', tokens);
    expect(charged.unmodeledLongContext).toBe(true);
    expect(UNMODELED_LONG_CONTEXT_CAP_MULTIPLIER).toBe(2);
    expect(charged.costUsd).toBeCloseTo(base * 2, 12);
    expect(charged.costUsd).toBeGreaterThanOrEqual(base * 2 - 1e-12);
  });

  it('multiplies every rate, cache reads and writes included, and counts them toward the threshold', () => {
    // 150K cache reads + 60K cache writes + 1K uncached: 211K prompt tokens.
    const tokens = {
      uncachedInputTokens: 1_000,
      cacheReadTokens: 150_000,
      cacheWrite5mTokens: 40_000,
      cacheWrite1hTokens: 20_000,
      outputTokens: 2_000,
    };
    const base = (1_000 * 3 + 150_000 * 0.3 + 40_000 * 3.75 + 20_000 * 6 + 2_000 * 15) / MILLION;
    expect(capCost('claude-sonnet-4-6', tokens)).toEqual({
      costUsd: expect.closeTo(base * 2, 12),
      unmodeledLongContext: true,
    });
  });

  it('leaves a prompt at or under the threshold at the listed rates', () => {
    for (const tokens of [
      { uncachedInputTokens: 200_000, outputTokens: 50_000 },
      { uncachedInputTokens: 100_000, cacheReadTokens: 100_000 },
      { uncachedInputTokens: 1_000 },
    ]) {
      expect(capCost('claude-sonnet-4-5', tokens)).toEqual({
        costUsd: cost('claude-sonnet-4-5', tokens),
        unmodeledLongContext: false,
      });
    }
  });

  it.each([
    ['claude-opus-4-6', 200_001],
    ['gemini-2.5-pro', 200_001],
    ['gemini-3-pro-preview', 200_001],
    ['gemini-3.1-pro-preview', 200_001],
    ['gemini-1.5-pro', 128_001],
  ])('charges %s twice the listed rates from %d prompt tokens', (modelId, promptTokens) => {
    const tokens = { uncachedInputTokens: promptTokens, outputTokens: 1_000 };
    expect(capCost(modelId, tokens).costUsd).toBeCloseTo(cost(modelId, tokens) * 2, 12);
    const atThreshold = { uncachedInputTokens: promptTokens - 1, outputTokens: 1_000 };
    expect(capCost(modelId, atThreshold).costUsd).toBeCloseTo(cost(modelId, atThreshold), 12);
  });

  it.each(['claude-opus-5-5', 'claude-opus-4-7', 'claude-sonnet-5', 'gpt-5.2'])(
    'never multiplies %s, which is listed for its whole context window',
    (modelId) => {
      const tokens = { uncachedInputTokens: 900_000, outputTokens: 1_000 };
      expect(capCost(modelId, tokens)).toEqual({ costUsd: cost(modelId, tokens), unmodeledLongContext: false });
    },
  );

  it("keeps Haiku 5.5's modeled long-prompt tier as listed", () => {
    const tokens = { uncachedInputTokens: 150_000, outputTokens: 1_000 };
    expect(capCost('claude-haiku-5-5', tokens)).toEqual({
      costUsd: expect.closeTo((150_000 * 0.5 + 1_000 * 2.5) / MILLION, 12),
      unmodeledLongContext: false,
    });
  });

  it('applies on top of a fast-mode price, which keeps the threshold', () => {
    const pricing = { ...resolveModelPricing('claude-opus-5-5').pricing, unmodeledPremiumAbovePromptTokens: 200_000 };
    const fast = pricingForSpeed(pricing, 'fast');
    if (fast === undefined) throw new Error('expected a fast-mode price');
    const tokens = usage({ uncachedInputTokens: 300_000 });
    expect(estimateCapRequestCostUsd(fast, tokens).costUsd).toBeCloseTo((300_000 * 8 * 2) / MILLION, 12);
  });

  it('is not applied by an override, which replaces the table entry', () => {
    const { pricing } = resolveModelPricing('claude-sonnet-4-5', {
      'claude-sonnet-4-5': { inputPerMillion: 3, outputPerMillion: 15 },
    });
    expect(estimateCapRequestCostUsd(pricing, usage({ uncachedInputTokens: 300_000 }))).toEqual({
      costUsd: expect.closeTo(0.9, 12),
      unmodeledLongContext: false,
    });
  });

  it('names the model, the threshold and the multiplier in its warning, with control characters escaped', () => {
    const { pricing } = resolveModelPricing('claude-sonnet-4-5');
    const warning = unmodeledLongContextWarning('claude-sonnet-4-5\u001b[2J', pricing);
    expect(warning).toMatch(/^[\x20-\x7e]+$/);
    expect(warning).toContain('"claude-sonnet-4-5\\u001b[2J"');
    expect(warning).toContain('over 200,000 tokens');
    expect(warning).toContain('2x the listed rates');
  });
});
