import { describe, expect, it } from 'vitest';

import { makeNormalizedUsage } from '../../src/llm-metrics/normalization.js';
import { ObservedUsageAccumulator } from '../../src/llm-metrics/observed-usage-accumulator.js';
import { AnthropicMessagesAdapter } from '../../src/llm-metrics/protocols/anthropic-messages.js';
import { GoogleGenerateContentAdapter } from '../../src/llm-metrics/protocols/google-generate-content.js';
import { OpenAiResponsesAdapter } from '../../src/llm-metrics/protocols/openai-responses.js';
import type { LlmExchangeCompleted, NormalizedUsage } from '../../src/llm-metrics/types.js';
import { usageTokenBounds } from '../../src/llm-metrics/usage-bounds.js';

let nextExchange = 0;

/** The accumulator reads attribution and usage only. */
function exchange(usage: NormalizedUsage, turnId = 'turn-1'): LlmExchangeCompleted {
  nextExchange += 1;
  return {
    exchangeId: `exchange-${nextExchange}`,
    attribution: {
      sessionId: 'session-1',
      agentConversationId: null,
      turnId,
      bundleId: null,
      workflowRunId: null,
      stateId: null,
      personaId: null,
      agentId: null,
      quality: 'exact',
    },
    usage,
  } as LlmExchangeCompleted;
}

function anthropicJson(usage: Record<string, unknown>): NormalizedUsage {
  const accumulator = new AnthropicMessagesAdapter().createAccumulator();
  accumulator.observeJsonResponse({ stop_reason: 'end_turn', usage });
  return accumulator.snapshot().usage;
}

describe('session usage lower bounds', () => {
  it('adds the known input of an exchange with a missing cache counter instead of zero', () => {
    const usage = anthropicJson({ input_tokens: 180000, output_tokens: 2000, cache_read_input_tokens: null });
    expect(usage).toMatchObject({ inputTokensReported: 180000, inputTokensTotal: null, usageCompleteness: 'partial' });

    const accumulator = new ObservedUsageAccumulator('session-1', true);
    accumulator.observe(exchange(usage));
    expect(accumulator.cumulativeSnapshot()).toMatchObject({
      inputTokens: 180000,
      outputTokens: 2000,
      totalTokens: 182000,
      incompleteExchanges: 1,
      unmeasuredExchanges: 0,
      lowerBound: true,
      status: 'partial',
    });
  });

  it('counts the input of an exchange whose stream ended before terminal usage', () => {
    const accumulator = new AnthropicMessagesAdapter().createAccumulator();
    accumulator.observeStreamEvent({
      data: {
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 4000,
            cache_read_input_tokens: 60000,
            cache_creation_input_tokens: 0,
            output_tokens: 1,
          },
        },
      },
    });
    const usage = accumulator.snapshot().usage;
    expect(usage).toMatchObject({ inputTokensTotal: 64000, outputTokensTotal: null, canonicalTotalTokens: null });

    const session = new ObservedUsageAccumulator('session-1', true);
    session.observe(exchange(usage));
    expect(session.takeTurnSnapshot('turn-1')).toMatchObject({
      inputTokens: 64000,
      outputTokens: 0,
      totalTokens: 64000,
      lowerBound: true,
      status: 'partial',
    });
  });

  it('keeps unmeasured exchanges distinct from measured zero', () => {
    const session = new ObservedUsageAccumulator('session-1', true);
    session.observe(exchange(makeNormalizedUsage()));
    session.observe(
      exchange(
        anthropicJson({
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        }),
      ),
    );
    expect(session.cumulativeSnapshot()).toMatchObject({
      inputTokens: 0,
      totalTokens: 0,
      observedExchanges: 2,
      incompleteExchanges: 1,
      unmeasuredExchanges: 1,
      lowerBound: true,
      status: 'partial',
    });

    const exact = new ObservedUsageAccumulator('session-1', true);
    exact.observe(
      exchange(
        anthropicJson({
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        }),
      ),
    );
    expect(exact.cumulativeSnapshot()).toMatchObject({ unmeasuredExchanges: 0, lowerBound: false, status: 'complete' });
  });
});

describe('usageTokenBounds', () => {
  it('returns the exact totals when they are known', () => {
    expect(
      usageTokenBounds(
        anthropicJson({
          input_tokens: 10,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 1,
          output_tokens: 4,
        }),
      ),
    ).toEqual({
      inputTokens: 16,
      outputTokens: 4,
      totalTokens: 20,
      inputExact: true,
      outputExact: true,
      totalExact: true,
      measured: true,
    });
  });

  it('never double counts a cached subset that is already part of the reported input', () => {
    const accumulator = new OpenAiResponsesAdapter().createAccumulator();
    accumulator.observeJsonResponse({
      status: 'completed',
      usage: { input_tokens_details: { cached_tokens: 300 }, output_tokens: 20 },
    });
    const bounds = usageTokenBounds(accumulator.snapshot().usage);
    expect(bounds).toMatchObject({ inputTokens: 300, outputTokens: 20, totalTokens: 320, inputExact: false });
  });

  it('uses a provider-reported total when the canonical total is ambiguous', () => {
    const accumulator = new GoogleGenerateContentAdapter().createAccumulator();
    accumulator.observeJsonResponse({
      candidates: [{ finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3, totalTokenCount: 10 },
    });
    expect(usageTokenBounds(accumulator.snapshot().usage)).toMatchObject({
      inputTokens: 4,
      outputTokens: 3,
      totalTokens: 10,
      totalExact: false,
    });
  });

  it('reports an exchange without any counter as unmeasured', () => {
    expect(usageTokenBounds(makeNormalizedUsage())).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      measured: false,
    });
  });
});
