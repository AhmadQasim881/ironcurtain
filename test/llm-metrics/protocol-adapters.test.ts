import { describe, expect, it } from 'vitest';
import { AnthropicMessagesAdapter } from '../../src/llm-metrics/protocols/anthropic-messages.js';
import { GoogleGenerateContentAdapter } from '../../src/llm-metrics/protocols/google-generate-content.js';
import { OpenAiChatCompletionsAdapter } from '../../src/llm-metrics/protocols/openai-chat-completions.js';
import { OpenAiResponsesAdapter } from '../../src/llm-metrics/protocols/openai-responses.js';

const CONTENT_CANARY = 'CONTENT_CANARY_must_never_escape';
const ERROR_CANARY = 'ERROR_CANARY_must_never_escape';

function expectContentFree(value: unknown): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain(CONTENT_CANARY);
  expect(serialized).not.toContain(ERROR_CANARY);
}

describe('Anthropic Messages metrics adapter', () => {
  it('merges initial input/cache usage with terminal inclusive output and estimated thinking', () => {
    const adapter = new AnthropicMessagesAdapter();
    expect(
      adapter.inspectRequest({
        model: 'claude-opus-5',
        stream: true,
        service_tier: 'priority',
        thinking: { type: 'adaptive', budget_tokens: 4096 },
        output_config: { effort: 'high' },
        messages: [{ role: 'user', content: CONTENT_CANARY }],
      }),
    ).toMatchObject({
      requestedModel: 'claude-opus-5',
      streaming: true,
      requestedServiceTier: 'priority',
      reasoningMode: 'adaptive',
      reasoningEffort: 'high',
      thinkingBudgetTokens: 4096,
    });

    const accumulator = adapter.createAccumulator();
    accumulator.observeStreamEvent({
      data: {
        type: 'message_start',
        message: {
          id: 'msg_123',
          model: 'claude-opus-5-20260801',
          service_tier: 'priority',
          content: [{ type: 'text', text: CONTENT_CANARY }],
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 10,
            output_tokens: 1,
          },
        },
      },
    });
    accumulator.observeStreamEvent({
      data: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 50, output_tokens_details: { thinking_tokens: 30 } },
      },
    });
    accumulator.observeStreamEvent({ data: { type: 'message_stop' } });

    const result = accumulator.snapshot();
    expect(result).toMatchObject({
      responseModel: 'claude-opus-5-20260801',
      providerRequestId: null,
      providerResponseId: 'msg_123',
      actualServiceTier: 'priority',
      protocolTerminal: true,
      outcome: { termination: 'stop', providerStopReason: 'end_turn', refusal: false },
      usage: {
        inputTokensReported: 100,
        inputTokensTotal: 130,
        inputTokensAccuracy: 'derived_exact',
        inputTokensUncached: 100,
        cacheReadInputTokens: 20,
        cacheWriteInputTokens: 10,
        outputTokensTotal: 50,
        outputTokensAccuracy: 'reported_exact',
        thinkingTokens: 30,
        thinkingTokensAccuracy: 'provider_estimate',
        nonThinkingOutputTokens: 20,
        nonThinkingOutputTokensAccuracy: 'derived_from_estimate',
        providerTotalTokens: null,
        canonicalTotalTokens: 180,
        usageCompleteness: 'complete',
      },
    });
    expectContentFree(result);
  });

  it('separates allowlisted request headers, body response IDs, and generated event phases', () => {
    const accumulator = new AnthropicMessagesAdapter().createAccumulator();
    accumulator.observeResponseHeaders({ 'x-request-id': 'wrong_header', 'request-id': 'request_123' });
    expect(accumulator.observeStreamEvent({ data: { type: 'message_start', message: { id: 'msg_123' } } })).toBe(
      'control',
    );
    expect(
      accumulator.observeStreamEvent({
        data: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: CONTENT_CANARY } },
      }),
    ).toBe('reasoning');
    expect(
      accumulator.observeStreamEvent({
        data: { type: 'content_block_delta', delta: { type: 'text_delta', text: CONTENT_CANARY } },
      }),
    ).toBe('output');
    expect(accumulator.snapshot()).toMatchObject({ providerRequestId: 'request_123', providerResponseId: 'msg_123' });
  });

  it('accepts Anthropic standard_only requests and treats pause_turn as a provider pause, not tool use', () => {
    const adapter = new AnthropicMessagesAdapter();
    expect(adapter.inspectRequest({ model: 'claude-opus-5', service_tier: 'standard_only' })).toMatchObject({
      requestedServiceTier: 'standard_only',
      qualityFlags: [],
    });

    const accumulator = adapter.createAccumulator();
    accumulator.observeJsonResponse({ stop_reason: 'pause_turn' });
    expect(accumulator.snapshot().outcome).toMatchObject({
      providerStopReason: 'pause_turn',
      termination: 'stop',
      refusal: false,
    });
  });

  it('keeps unknown additive stop reasons out of the refusal denominator', () => {
    const accumulator = new AnthropicMessagesAdapter().createAccumulator();
    accumulator.observeJsonResponse({ stop_reason: 'future_stop_reason' });
    expect(accumulator.snapshot().outcome).toMatchObject({ providerStopReason: 'other', refusal: null });
  });

  it('preserves zero, reports missing cache components as partial, and never invents totals', () => {
    const accumulator = new AnthropicMessagesAdapter().createAccumulator();
    accumulator.observeJsonResponse({
      id: 'msg_zero',
      model: 'claude-haiku-4-5',
      content: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    expect(accumulator.snapshot().usage).toMatchObject({
      inputTokensReported: 0,
      inputTokensTotal: null,
      cacheReadInputTokens: null,
      outputTokensTotal: 0,
      canonicalTotalTokens: null,
      usageCompleteness: 'partial',
    });
  });

  it('records structured refusal facts but drops explanation text and unknown categories', () => {
    const accumulator = new AnthropicMessagesAdapter().createAccumulator();
    accumulator.observeJsonResponse({
      id: 'msg_refusal',
      model: 'claude-opus-5',
      content: [{ type: 'refusal', refusal: CONTENT_CANARY }],
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: ERROR_CANARY, explanation: ERROR_CANARY },
      usage: {
        input_tokens: 3,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 2,
      },
    });
    const result = accumulator.snapshot();
    expect(result.outcome).toMatchObject({
      termination: 'refusal',
      providerStopReason: 'refusal',
      refusal: true,
      refusalCategory: null,
    });
    expect(result.qualityFlags).toContain('unknown_refusal_category');
    expectContentFree(result);
  });

  it('does not finalize twice when duplicate terminal events arrive', () => {
    const accumulator = new AnthropicMessagesAdapter().createAccumulator();
    accumulator.observeStreamEvent({ data: { type: 'message_stop' } });
    accumulator.observeStreamEvent({ data: { type: 'message_stop' } });
    expect(accumulator.snapshot().qualityFlags).toContain('duplicate_protocol_terminal');
  });
});

describe('Anthropic Messages cumulative and itemized usage', () => {
  function stream(...usages: readonly [Record<string, unknown>, Record<string, unknown>]) {
    const accumulator = new AnthropicMessagesAdapter().createAccumulator();
    accumulator.observeStreamEvent({
      data: { type: 'message_start', message: { id: 'msg_1', model: 'claude-opus-5-5', usage: usages[0] } },
    });
    accumulator.observeStreamEvent({
      data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: usages[1] },
    });
    accumulator.observeStreamEvent({ data: { type: 'message_stop' } });
    return accumulator.snapshot();
  }

  it('treats message_delta input and cache counters as cumulative finals, without conflict flags', () => {
    const result = stream(
      { input_tokens: 100, output_tokens: 1 },
      {
        input_tokens: 5100,
        cache_read_input_tokens: 20000,
        cache_creation_input_tokens: 3000,
        output_tokens: 900,
      },
    );
    expect(result.usage).toMatchObject({
      inputTokensReported: 5100,
      inputTokensUncached: 5100,
      cacheReadInputTokens: 20000,
      cacheWriteInputTokens: 3000,
      inputTokensTotal: 28100,
      outputTokensTotal: 900,
      canonicalTotalTokens: 29000,
      usageCompleteness: 'complete',
    });
    expect(result.qualityFlags.filter((flag) => flag.startsWith('conflicting_usage'))).toEqual([]);
  });

  it('reads cache counters that only message_delta reports (OpenRouter Anthropic skin)', () => {
    const result = stream(
      { input_tokens: 1024, output_tokens: 0 },
      { input_tokens: 1024, output_tokens: 128, cache_read_input_tokens: 900 },
    );
    // No cache_creation counter at all: without a gateway contract it stays unknown.
    expect(result.usage).toMatchObject({
      cacheReadInputTokens: 900,
      cacheWriteInputTokens: null,
      inputTokensTotal: null,
      usageCompleteness: 'partial',
    });
  });

  it('counts an absent cache counter as zero, with a flag, only under a gateway contract', () => {
    const accumulator = new AnthropicMessagesAdapter().createAccumulator({ absentCacheCountsAreZero: true });
    accumulator.observeStreamEvent({
      data: { type: 'message_start', message: { usage: { input_tokens: 1024, output_tokens: 0 } } },
    });
    accumulator.observeStreamEvent({
      data: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { input_tokens: 1024, output_tokens: 128, cache_read_input_tokens: 900 },
      },
    });
    const result = accumulator.snapshot();
    expect(result.usage).toMatchObject({
      cacheReadInputTokens: 900,
      cacheWriteInputTokens: 0,
      inputTokensTotal: 1924,
      canonicalTotalTokens: 2052,
      usageCompleteness: 'complete',
    });
    expect(result.usage.qualityFlags).toContain('absent_usage_assumed_zero:cache_creation_input_tokens');
    expect(result.usage.qualityFlags).not.toContain('absent_usage_assumed_zero:cache_read_input_tokens');

    const invalid = new AnthropicMessagesAdapter().createAccumulator({ absentCacheCountsAreZero: true });
    invalid.observeJsonResponse({
      usage: { input_tokens: 5, cache_read_input_tokens: -1, cache_creation_input_tokens: 0, output_tokens: 1 },
    });
    // An invalid counter is never assumed to be zero.
    expect(invalid.snapshot().usage).toMatchObject({ cacheReadInputTokens: null, inputTokensTotal: null });

    // A real OpenRouter usage object sends the missing counter as null.
    const nulled = new AnthropicMessagesAdapter().createAccumulator({ absentCacheCountsAreZero: true });
    nulled.observeJsonResponse({
      usage: {
        input_tokens: 34,
        output_tokens: 13,
        output_tokens_details: { thinking_tokens: 10 },
        cache_creation_input_tokens: null,
        cache_read_input_tokens: 192,
        cache_creation: null,
        cost: 0.00015472,
      },
    });
    expect(nulled.snapshot().usage).toMatchObject({
      cacheWriteInputTokens: 0,
      inputTokensTotal: 226,
      canonicalTotalTokens: 239,
      thinkingTokens: 10,
      usageCompleteness: 'complete',
    });
    expect(nulled.snapshot().usage.cacheWrite5mInputTokens).toBeUndefined();
  });

  it('keeps the larger value when a later cumulative counter regresses, and flags it', () => {
    const result = stream(
      { input_tokens: 1024, cache_read_input_tokens: 10, cache_creation_input_tokens: 0, output_tokens: 1 },
      { input_tokens: 0, cache_read_input_tokens: 10, cache_creation_input_tokens: 0, output_tokens: 50 },
    );
    expect(result.usage).toMatchObject({ inputTokensUncached: 1024, inputTokensTotal: 1034 });
    expect(result.qualityFlags).toContain('regressing_cumulative_usage:input');
  });

  it('assumes an absent cache counter is zero only after the final usage report', () => {
    // OpenRouter reports cache_read_input_tokens in message_delta alone, so a
    // stream cut before it has not reported its cache counters yet.
    const accumulator = new AnthropicMessagesAdapter().createAccumulator({ absentCacheCountsAreZero: true });
    accumulator.observeStreamEvent({
      data: { type: 'message_start', message: { usage: { input_tokens: 1024, output_tokens: 0 } } },
    });
    const cut = accumulator.snapshot();
    expect(cut.usage).toMatchObject({
      inputTokensUncached: 1024,
      cacheReadInputTokens: null,
      cacheWriteInputTokens: null,
      inputTokensTotal: null,
      inputTokensAccuracy: 'unknown',
      usageCompleteness: 'partial',
    });
    expect(cut.qualityFlags.filter((flag) => flag.startsWith('absent_usage_assumed_zero'))).toEqual([]);
  });

  it('reads only the final top-level report once iterations itemize the exchange', () => {
    // message_start counts the context before compaction; the final
    // top-level usage covers only the executor iteration after it.
    const result = stream(
      { input_tokens: 180000, cache_read_input_tokens: 150000, cache_creation_input_tokens: 2000, output_tokens: 1 },
      {
        input_tokens: 23000,
        cache_read_input_tokens: 4000,
        cache_creation_input_tokens: 1200,
        output_tokens: 1000,
        iterations: [
          {
            type: 'compaction',
            input_tokens: 180000,
            output_tokens: 3500,
            cache_read_input_tokens: 150000,
            cache_creation_input_tokens: 2000,
          },
          // The executor iteration omits its cache counters. It is the
          // top-level attempt, so it takes the final top-level ones.
          { type: 'message', input_tokens: 23000, output_tokens: 1000 },
        ],
      },
    );
    expect(result.usage).toMatchObject({
      inputTokensReported: 23000,
      inputTokensUncached: 203000,
      cacheReadInputTokens: 154000,
      cacheWriteInputTokens: 3200,
      inputTokensTotal: 360200,
      outputTokensReported: 1000,
      outputTokensTotal: 4500,
      canonicalTotalTokens: 364700,
      usageCompleteness: 'complete',
    });
    expect(result.usage.iterations?.[1]).toMatchObject({ cacheReadInputTokens: 4000, cacheWriteInputTokens: 1200 });
    expect(result.qualityFlags.filter((flag) => flag.startsWith('regressing_cumulative_usage'))).toEqual([]);
  });

  it('never lets the final attempt borrow a counter from the declined attempt', () => {
    const result = stream(
      { input_tokens: 1500, cache_read_input_tokens: 2048, cache_creation_input_tokens: 512, output_tokens: 1 },
      {
        // The final top-level report omits cache_creation_input_tokens.
        input_tokens: 1520,
        cache_read_input_tokens: 0,
        output_tokens: 310,
        iterations: [
          {
            type: 'message',
            model: 'claude-fable-5-1',
            input_tokens: 1500,
            output_tokens: 120,
            cache_read_input_tokens: 2048,
            cache_creation_input_tokens: 512,
          },
          { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 1520, output_tokens: 310 },
        ],
      },
    );
    // The fallback attempt's cache write is unknown; the declined attempt's
    // 512 (reported in message_start) is not counted a second time.
    expect(result.usage).toMatchObject({
      inputTokensUncached: 3020,
      cacheReadInputTokens: 2048,
      cacheWriteInputTokens: null,
      inputTokensTotal: null,
      outputTokensTotal: 430,
      usageCompleteness: 'partial',
    });
    expect(result.usage.iterations?.[1]).toMatchObject({ cacheReadInputTokens: 0, cacheWriteInputTokens: null });
  });

  it('lets the final attempt of a streamed refusal fallback supersede the declined attempt it replaced', () => {
    // message_start describes the declined attempt; message_delta's top-level
    // usage describes only the fallback attempt that produced the message.
    const result = stream(
      { input_tokens: 1500, cache_read_input_tokens: 2048, cache_creation_input_tokens: 0, output_tokens: 1 },
      {
        input_tokens: 1520,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 2048,
        output_tokens: 310,
        iterations: [
          {
            type: 'message',
            model: 'claude-fable-5-1',
            input_tokens: 1500,
            output_tokens: 120,
            cache_read_input_tokens: 2048,
            cache_creation_input_tokens: 0,
          },
          { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 1520, output_tokens: 310 },
        ],
      },
    );
    expect(result.usage).toMatchObject({
      inputTokensReported: 1520,
      inputTokensUncached: 3020,
      cacheReadInputTokens: 2048,
      cacheWriteInputTokens: 2048,
      inputTokensTotal: 7116,
      outputTokensTotal: 430,
      usageCompleteness: 'complete',
    });
    expect(result.usage.iterations?.[1]).toMatchObject({ cacheReadInputTokens: 0, cacheWriteInputTokens: 2048 });
    expect(result.qualityFlags).toContain('fallback_served');
    expect(result.qualityFlags.filter((flag) => flag.startsWith('regressing_cumulative_usage'))).toEqual([]);
  });

  it('sums compaction and executor iterations instead of reading the top-level attempt alone', () => {
    const result = stream(
      { input_tokens: 23000, cache_read_input_tokens: 4000, cache_creation_input_tokens: 0, output_tokens: 1 },
      {
        input_tokens: 23000,
        cache_read_input_tokens: 4000,
        cache_creation_input_tokens: 0,
        output_tokens: 1000,
        output_tokens_details: { thinking_tokens: 200 },
        iterations: [
          { type: 'compaction', input_tokens: 180000, output_tokens: 3500, cache_read_input_tokens: 0 },
          {
            type: 'message',
            input_tokens: 23000,
            output_tokens: 1000,
            cache_read_input_tokens: 4000,
            cache_creation_input_tokens: 0,
          },
        ],
      },
    );
    // The compaction iteration omits cache_creation_input_tokens: unknown, so
    // the input total is not claimed; the known parts remain.
    expect(result.usage).toMatchObject({
      inputTokensReported: 23000,
      inputTokensUncached: 203000,
      cacheReadInputTokens: 4000,
      cacheWriteInputTokens: null,
      inputTokensTotal: null,
      outputTokensReported: 1000,
      outputTokensTotal: 4500,
      thinkingTokens: null,
      usageSource: 'anthropic_usage_iterations',
      usageCompleteness: 'partial',
    });
    expect(result.usage.qualityFlags).toEqual(
      expect.arrayContaining([
        'usage_iterations_summed',
        'usage_iteration:compaction',
        'thinking_breakdown_unavailable:usage_iterations',
      ]),
    );
    expect(result.usage.iterations?.map((iteration) => iteration.kind)).toEqual(['compaction', 'message']);
  });

  it('attributes advisor sub-inferences to their own model and never adds top-level usage on top', () => {
    const accumulator = new AnthropicMessagesAdapter().createAccumulator();
    accumulator.observeJsonResponse({
      model: 'claude-sonnet-5-5',
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 900,
        output_tokens: 80,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        iterations: [
          {
            type: 'message',
            input_tokens: 400,
            output_tokens: 30,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          {
            type: 'advisor_message',
            model: 'claude-opus-5-5',
            input_tokens: 2000,
            output_tokens: 150,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          {
            type: 'message',
            input_tokens: 500,
            output_tokens: 50,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        ],
      },
    });
    const result = accumulator.snapshot();
    expect(result.usage).toMatchObject({
      inputTokensTotal: 2900,
      outputTokensTotal: 230,
      canonicalTotalTokens: 3130,
      usageCompleteness: 'complete',
    });
    expect(result.usage.iterations).toEqual([
      expect.objectContaining({ kind: 'message', model: null }),
      expect.objectContaining({ kind: 'advisor_message', model: 'claude-opus-5-5', inputTokensUncached: 2000 }),
      expect.objectContaining({ kind: 'message', model: null }),
    ]);
    expect(result.usage.qualityFlags).toContain('usage_iteration:advisor_message');
  });

  it('captures the cache-write TTL split and server-tool request counts', () => {
    const accumulator = new AnthropicMessagesAdapter().createAccumulator();
    accumulator.observeJsonResponse({
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 3000,
        cache_creation: { ephemeral_5m_input_tokens: 2000, ephemeral_1h_input_tokens: 1000 },
        output_tokens: 5,
        server_tool_use: { web_search_requests: 2, web_fetch_requests: 1, [CONTENT_CANARY]: 7 },
      },
    });
    const result = accumulator.snapshot();
    expect(result.usage).toMatchObject({
      cacheWriteInputTokens: 3000,
      cacheWrite5mInputTokens: 2000,
      cacheWrite1hInputTokens: 1000,
      serverToolRequests: { webSearchRequests: 2, webFetchRequests: 1 },
    });
    expectContentFree(result);

    const contradictory = new AnthropicMessagesAdapter().createAccumulator();
    contradictory.observeJsonResponse({
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 3000,
        cache_creation: { ephemeral_5m_input_tokens: 2000, ephemeral_1h_input_tokens: 2000 },
        output_tokens: 5,
      },
    });
    expect(contradictory.snapshot().usage).toMatchObject({
      cacheWrite5mInputTokens: null,
      cacheWrite1hInputTokens: null,
      qualityFlags: expect.arrayContaining(['contradictory_usage:cache_creation_split']),
    });
  });

  it('reads the speed the response was served at (usage.speed), for fast-mode pricing', () => {
    const fast = new AnthropicMessagesAdapter().createAccumulator();
    fast.observeStreamEvent({
      eventType: 'message_delta',
      data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3, speed: 'fast' } },
    });
    expect(fast.snapshot().actualSpeedMode).toBe('fast');

    const unknown = new AnthropicMessagesAdapter().createAccumulator();
    unknown.observeJsonResponse({ usage: { input_tokens: 1, output_tokens: 1, speed: 'ludicrous' } });
    expect(unknown.snapshot()).toMatchObject({
      actualSpeedMode: null,
      qualityFlags: expect.arrayContaining(['unknown_response_speed_mode']),
    });
  });

  it('reads the service tier from usage, where the Messages API reports it, and flags an unknown one', () => {
    const streamed = new AnthropicMessagesAdapter().createAccumulator();
    streamed.observeStreamEvent({
      eventType: 'message_start',
      data: {
        type: 'message_start',
        message: { id: 'msg_tier', model: 'claude-opus-5-5', usage: { input_tokens: 1, service_tier: 'priority' } },
      },
    });
    expect(streamed.snapshot().actualServiceTier).toBe('priority');

    const json = new AnthropicMessagesAdapter().createAccumulator();
    json.observeJsonResponse({ usage: { input_tokens: 1, output_tokens: 1, service_tier: 'standard' } });
    expect(json.snapshot().actualServiceTier).toBe('standard');

    const unknown = new AnthropicMessagesAdapter().createAccumulator();
    unknown.observeJsonResponse({ usage: { input_tokens: 1, output_tokens: 1, service_tier: 'overnight' } });
    expect(unknown.snapshot()).toMatchObject({
      actualServiceTier: null,
      qualityFlags: expect.arrayContaining(['unknown_response_service_tier']),
    });
  });

  it('flags a response service tier the OpenAI adapters do not recognize', () => {
    const responses = new OpenAiResponsesAdapter().createAccumulator();
    responses.observeJsonResponse({ id: 'resp_1', model: 'gpt-5.2', service_tier: 'overnight', status: 'completed' });
    expect(responses.snapshot()).toMatchObject({
      actualServiceTier: null,
      qualityFlags: expect.arrayContaining(['unknown_response_service_tier']),
    });

    const chat = new OpenAiChatCompletionsAdapter().createAccumulator();
    chat.observeJsonResponse({ id: 'chat_1', model: 'gpt-5.2', service_tier: 'overnight', choices: [] });
    expect(chat.snapshot()).toMatchObject({
      actualServiceTier: null,
      qualityFlags: expect.arrayContaining(['unknown_response_service_tier']),
    });

    const known = new OpenAiResponsesAdapter().createAccumulator();
    known.observeJsonResponse({ id: 'resp_2', model: 'gpt-5.2', service_tier: 'flex', status: 'completed' });
    expect(known.snapshot().actualServiceTier).toBe('flex');
    expect(known.snapshot().qualityFlags).not.toContain('unknown_response_service_tier');
  });

  it('leaves totals unknown when iterations cannot be read, keeping the top-level parts', () => {
    const accumulator = new AnthropicMessagesAdapter().createAccumulator();
    accumulator.observeJsonResponse({
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 0,
        output_tokens: 10,
        iterations: { type: 'message' },
      },
    });
    const result = accumulator.snapshot();
    expect(result.usage).toMatchObject({
      inputTokensUncached: 100,
      cacheReadInputTokens: 50,
      inputTokensTotal: null,
      outputTokensReported: 10,
      outputTokensTotal: null,
      canonicalTotalTokens: null,
      usageCompleteness: 'partial',
    });
    expect(result.qualityFlags).toContain('invalid_usage_iterations');
  });

  it('keeps iteration models bounded and identifier-shaped', () => {
    const accumulator = new AnthropicMessagesAdapter().createAccumulator();
    accumulator.observeJsonResponse({
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        iterations: [
          {
            type: 'future_kind',
            model: `${CONTENT_CANARY} with spaces`,
            input_tokens: 1,
            output_tokens: 1,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        ],
      },
    });
    const result = accumulator.snapshot();
    expect(result.usage.iterations).toEqual([expect.objectContaining({ kind: 'other', model: null })]);
    expect(result.qualityFlags).toEqual(
      expect.arrayContaining(['unknown_usage_iteration_type', 'invalid_identifier:model']),
    );
    expectContentFree(result);
  });
});

describe('OpenAI Responses metrics adapter', () => {
  it('captures the top-level reasoning_effort request dimension', () => {
    expect(
      new OpenAiResponsesAdapter().inspectRequest({
        model: 'gpt-5.5',
        stream: true,
        reasoning_effort: 'xhigh',
        input: CONTENT_CANARY,
      }),
    ).toMatchObject({ reasoningMode: 'effort', reasoningEffort: 'xhigh' });
  });

  it('uses terminal cumulative usage without summing prior events', () => {
    const accumulator = new OpenAiResponsesAdapter().createAccumulator();
    accumulator.observeStreamEvent({
      data: {
        type: 'response.created',
        response: {
          id: 'resp_1',
          model: 'gpt-5.5',
          status: 'in_progress',
          usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
        },
      },
    });
    accumulator.observeStreamEvent({
      data: {
        type: 'response.completed',
        response: {
          id: 'resp_1',
          model: 'gpt-5.5',
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: CONTENT_CANARY }] }],
          usage: {
            input_tokens: 120,
            input_tokens_details: { cached_tokens: 100 },
            output_tokens: 40,
            output_tokens_details: { reasoning_tokens: 25 },
            total_tokens: 160,
          },
        },
      },
    });
    accumulator.observeStreamEvent({ data: '[DONE]' });
    const result = accumulator.snapshot();
    expect(result.usage).toMatchObject({
      inputTokensTotal: 120,
      inputTokensAccuracy: 'reported_exact',
      inputTokensUncached: 20,
      cacheReadInputTokens: 100,
      outputTokensTotal: 40,
      outputTokensAccuracy: 'reported_exact',
      thinkingTokens: 25,
      nonThinkingOutputTokens: 15,
      providerTotalTokens: 160,
      canonicalTotalTokens: 160,
    });
    expect(result.usage.inputTokensTotal).not.toBe(130);
    expect(result.outcome).toMatchObject({ termination: 'stop', providerStopReason: 'completed' });
    expect(result.qualityFlags).not.toContain('invalid_stream_event');
    expectContentFree(result);
  });

  it('classifies only generated deltas and retains the allowlisted request header separately', () => {
    const accumulator = new OpenAiResponsesAdapter().createAccumulator();
    accumulator.observeResponseHeaders({ 'request-id': 'wrong_header', 'x-request-id': 'request_456' });
    expect(accumulator.observeStreamEvent({ data: { type: 'response.created', response: { id: 'resp_456' } } })).toBe(
      'control',
    );
    expect(accumulator.observeStreamEvent({ data: { type: 'response.reasoning_summary_text.delta' } })).toBe(
      'reasoning',
    );
    expect(accumulator.observeStreamEvent({ data: { type: 'response.output_text.delta' } })).toBe('output');
    expect(accumulator.snapshot()).toMatchObject({ providerRequestId: 'request_456', providerResponseId: 'resp_456' });
  });

  it('does not infer non-refusal from unknown or failed response statuses', () => {
    const unknown = new OpenAiResponsesAdapter().createAccumulator();
    unknown.observeJsonResponse({ status: 'future_status' });
    expect(unknown.snapshot().outcome).toMatchObject({ providerStopReason: 'other', refusal: null });
    const failed = new OpenAiResponsesAdapter().createAccumulator();
    failed.observeJsonResponse({ status: 'failed' });
    expect(failed.snapshot().outcome).toMatchObject({ termination: 'error', refusal: null });
  });

  it('detects explicit refusal items and ignores refusal/error text', () => {
    const accumulator = new OpenAiResponsesAdapter().createAccumulator();
    accumulator.observeJsonResponse({
      id: 'resp_refusal',
      model: 'gpt-5.5',
      status: 'failed',
      error: { message: ERROR_CANARY },
      output: [{ type: 'message', content: [{ type: 'refusal', refusal: CONTENT_CANARY }] }],
      usage: null,
    });
    const result = accumulator.snapshot();
    expect(result.outcome).toMatchObject({ termination: 'refusal', refusal: true, refusalSource: 'content_item' });
    expectContentFree(result);
  });

  it('flags duplicate terminal envelopes and contradictory provider totals', () => {
    const accumulator = new OpenAiResponsesAdapter().createAccumulator();
    const event = {
      type: 'response.completed',
      response: {
        id: 'resp_dup',
        model: 'gpt-5.5',
        status: 'completed',
        usage: { input_tokens: 2, output_tokens: 3, total_tokens: 99 },
      },
    };
    accumulator.observeStreamEvent({ data: event });
    accumulator.observeStreamEvent({ data: event });
    const result = accumulator.snapshot();
    expect(result.qualityFlags).toContain('duplicate_protocol_terminal');
    expect(result.qualityFlags).toContain('duplicate_terminal_usage');
    expect(result.qualityFlags).toContain('contradictory_usage:provider_total');
  });
});

describe('OpenAI Chat Completions metrics adapter', () => {
  it('accepts the choices-empty usage chunk after finish_reason and treats DONE as one terminal', () => {
    const accumulator = new OpenAiChatCompletionsAdapter().createAccumulator();
    accumulator.observeStreamEvent({
      data: {
        id: 'chatcmpl_1',
        model: 'gpt-5.5',
        choices: [{ index: 0, delta: { content: CONTENT_CANARY }, finish_reason: 'stop' }],
      },
    });
    accumulator.observeStreamEvent({
      data: {
        id: 'chatcmpl_1',
        model: 'gpt-5.5',
        choices: [],
        usage: {
          prompt_tokens: 50,
          prompt_tokens_details: { cached_tokens: 30 },
          completion_tokens: 20,
          completion_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 70,
        },
      },
    });
    accumulator.observeStreamEvent({ data: '[DONE]' });
    const result = accumulator.snapshot();
    expect(result.protocolTerminal).toBe(true);
    expect(result.outcome).toMatchObject({ termination: 'stop', refusal: false });
    expect(result.usage).toMatchObject({
      inputTokensTotal: 50,
      inputTokensUncached: 20,
      outputTokensTotal: 20,
      thinkingTokens: 0,
      nonThinkingOutputTokens: 20,
      usageCompleteness: 'complete',
    });
    expectContentFree(result);
  });

  it('classifies content filtering and rejects malformed numeric usage', () => {
    const accumulator = new OpenAiChatCompletionsAdapter().createAccumulator();
    accumulator.observeJsonResponse({
      id: 'chatcmpl_filter',
      model: 'gpt-5.5',
      choices: [{ finish_reason: 'content_filter', message: { content: null } }],
      usage: { prompt_tokens: -1, completion_tokens: 2.5, total_tokens: Number.POSITIVE_INFINITY },
    });
    const result = accumulator.snapshot();
    expect(result.outcome).toMatchObject({ termination: 'content_filter', refusal: true });
    expect(result.usage.usageCompleteness).toBe('invalid');
    expect(result.qualityFlags).toContain('invalid_count:prompt_tokens');
  });

  it('does not treat the normal refusal:null response field as a refusal', () => {
    const accumulator = new OpenAiChatCompletionsAdapter().createAccumulator();
    accumulator.observeJsonResponse({
      id: 'chatcmpl_normal',
      model: 'gpt-5.5',
      choices: [{ finish_reason: 'stop', message: { content: CONTENT_CANARY, refusal: null } }],
      usage: {
        prompt_tokens: 1,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens: 1,
        completion_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 2,
      },
    });
    expect(accumulator.snapshot().outcome).toMatchObject({ termination: 'stop', refusal: false });
  });

  it('flags repeated DONE without creating a second observation', () => {
    const accumulator = new OpenAiChatCompletionsAdapter().createAccumulator();
    accumulator.observeStreamEvent({ data: '[DONE]' });
    accumulator.observeStreamEvent({ data: '[DONE]' });
    expect(accumulator.snapshot().qualityFlags).toContain('duplicate_protocol_terminal');
  });

  it('classifies generated chat deltas and leaves unknown finishes nullable', () => {
    const accumulator = new OpenAiChatCompletionsAdapter().createAccumulator();
    accumulator.observeResponseHeaders({ 'x-request-id': 'request_chat' });
    expect(
      accumulator.observeStreamEvent({ data: { id: 'chat_1', choices: [{ delta: { reasoning_content: 'hidden' } }] } }),
    ).toBe('reasoning');
    expect(
      accumulator.observeStreamEvent({ data: { id: 'chat_1', choices: [{ delta: { content: CONTENT_CANARY } }] } }),
    ).toBe('output');
    accumulator.observeStreamEvent({ data: { choices: [{ finish_reason: 'future_reason', delta: {} }] } });
    expect(accumulator.snapshot()).toMatchObject({
      providerRequestId: 'request_chat',
      providerResponseId: 'chat_1',
      outcome: { providerStopReason: 'other', refusal: null },
    });
  });
});

describe('Google GenerateContent metrics adapter', () => {
  it('extracts the requested model from the capped URL segment and normalizes thought-inclusive output', () => {
    const adapter = new GoogleGenerateContentAdapter();
    const request = adapter.inspectRequest(
      {
        contents: [{ parts: [{ text: CONTENT_CANARY }] }],
        generationConfig: {
          thinkingConfig: { includeThoughts: true, thinkingBudget: 2048, thinkingLevel: 'HIGH' },
        },
      },
      { path: '/v1beta/models/gemini-3.1-pro:streamGenerateContent' },
    );
    expect(request).toMatchObject({
      requestedModel: 'gemini-3.1-pro',
      streaming: true,
      reasoningMode: 'enabled',
      reasoningEffort: 'HIGH',
      thinkingBudgetTokens: 2048,
    });
    expectContentFree(request);

    const accumulator = adapter.createAccumulator();
    accumulator.observeStreamEvent({
      data: {
        modelVersion: 'gemini-3.1-pro-001',
        responseId: 'google_resp_1',
        candidates: [{ content: { parts: [{ text: CONTENT_CANARY }] } }],
        usageMetadata: {
          promptTokenCount: 8,
          cachedContentTokenCount: 2,
          candidatesTokenCount: 1,
          thoughtsTokenCount: 1,
          totalTokenCount: 10,
        },
      },
    });
    accumulator.observeStreamEvent({
      data: {
        modelVersion: 'gemini-3.1-pro-001',
        responseId: 'google_resp_1',
        candidates: [{ finishReason: 'STOP', content: { parts: [{ text: CONTENT_CANARY }] } }],
        usageMetadata: {
          promptTokenCount: 10,
          cachedContentTokenCount: 3,
          candidatesTokenCount: 4,
          thoughtsTokenCount: 6,
          toolUsePromptTokenCount: 2,
          totalTokenCount: 22,
        },
      },
    });
    const result = accumulator.snapshot();
    expect(result).toMatchObject({
      responseModel: 'gemini-3.1-pro-001',
      providerRequestId: null,
      providerResponseId: 'google_resp_1',
      protocolTerminal: true,
      outcome: { termination: 'stop', refusal: false },
      usage: {
        inputTokensReported: 10,
        inputTokensTotal: 12,
        inputTokensAccuracy: 'derived_exact',
        inputTokensUncached: 9,
        toolUseInputTokens: 2,
        outputTokensReported: 4,
        outputTokenSemantics: 'excludes_thinking',
        outputTokensTotal: 10,
        outputTokensAccuracy: 'derived_exact',
        thinkingTokens: 6,
        nonThinkingOutputTokens: 4,
        providerTotalTokens: 22,
        canonicalTotalTokens: 22,
      },
    });
    expectContentFree(result);
  });

  it('classifies thought/content chunks and leaves future finishes nullable', () => {
    const accumulator = new GoogleGenerateContentAdapter().createAccumulator();
    accumulator.observeResponseHeaders({ 'x-goog-request-id': 'request_google' });
    expect(
      accumulator.observeStreamEvent({
        data: { responseId: 'response_google', candidates: [{ content: { parts: [] } }] },
      }),
    ).toBe('control');
    expect(
      accumulator.observeStreamEvent({
        data: { candidates: [{ content: { parts: [{ thought: true, text: 'hidden' }] } }] },
      }),
    ).toBe('reasoning');
    expect(
      accumulator.observeStreamEvent({ data: { candidates: [{ content: { parts: [{ text: CONTENT_CANARY }] } }] } }),
    ).toBe('output');
    accumulator.observeStreamEvent({ data: { candidates: [{ finishReason: 'FUTURE_REASON' }] } });
    expect(accumulator.snapshot()).toMatchObject({
      providerRequestId: 'request_google',
      providerResponseId: 'response_google',
      outcome: { providerStopReason: 'other', refusal: null },
    });
  });

  it('keeps inclusive output unknown when thought count is absent and flags cumulative regression', () => {
    const accumulator = new GoogleGenerateContentAdapter().createAccumulator();
    accumulator.observeStreamEvent({
      data: { usageMetadata: { promptTokenCount: 10, toolUsePromptTokenCount: 0, candidatesTokenCount: 5 } },
    });
    accumulator.observeStreamEvent({
      data: {
        candidates: [{ finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 9, toolUsePromptTokenCount: 0, candidatesTokenCount: 4 },
      },
    });
    const result = accumulator.snapshot();
    expect(result.usage).toMatchObject({
      inputTokensTotal: 9,
      outputTokensReported: 4,
      outputTokensTotal: null,
      canonicalTotalTokens: null,
      usageCompleteness: 'partial',
    });
    expect(result.qualityFlags).toContain('regressing_cumulative_usage:prompt');
    expect(result.qualityFlags).toContain('regressing_cumulative_usage:candidates');
  });

  it('derives omitted zero-valued Google additive counters from an exact provider total', () => {
    const accumulator = new GoogleGenerateContentAdapter().createAccumulator();
    accumulator.observeJsonResponse({
      candidates: [{ finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3, totalTokenCount: 7 },
    });

    expect(accumulator.snapshot().usage).toMatchObject({
      inputTokensReported: 4,
      inputTokensTotal: 4,
      inputTokensUncached: null,
      cacheReadInputTokens: null,
      toolUseInputTokens: 0,
      outputTokensReported: 3,
      outputTokensTotal: 3,
      thinkingTokens: 0,
      thinkingTokensAccuracy: 'derived_exact',
      nonThinkingOutputTokens: 3,
      nonThinkingOutputTokensAccuracy: 'reported_exact',
      providerTotalTokens: 7,
      canonicalTotalTokens: 7,
      usageCompleteness: 'complete',
    });
  });

  it('derives one missing Google component but preserves ambiguous missing components as partial', () => {
    const soleMissing = new GoogleGenerateContentAdapter().createAccumulator();
    soleMissing.observeJsonResponse({
      candidates: [{ finishReason: 'STOP' }],
      usageMetadata: {
        promptTokenCount: 4,
        candidatesTokenCount: 3,
        toolUsePromptTokenCount: 1,
        totalTokenCount: 10,
      },
    });
    expect(soleMissing.snapshot().usage).toMatchObject({
      inputTokensTotal: 5,
      outputTokensTotal: 5,
      thinkingTokens: 2,
      thinkingTokensAccuracy: 'derived_exact',
      canonicalTotalTokens: 10,
      usageCompleteness: 'complete',
    });

    const ambiguous = new GoogleGenerateContentAdapter().createAccumulator();
    ambiguous.observeJsonResponse({
      candidates: [{ finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3, totalTokenCount: 10 },
    });
    expect(ambiguous.snapshot().usage).toMatchObject({
      toolUseInputTokens: null,
      thinkingTokens: null,
      inputTokensTotal: null,
      outputTokensTotal: null,
      canonicalTotalTokens: null,
      providerTotalTokens: 10,
      usageCompleteness: 'partial',
    });
  });

  it('gives a terminal Google cumulative snapshot precedence over earlier and later non-terminal usage', () => {
    const accumulator = new GoogleGenerateContentAdapter().createAccumulator();
    accumulator.observeStreamEvent({
      data: {
        usageMetadata: {
          promptTokenCount: 4,
          candidatesTokenCount: 2,
          thoughtsTokenCount: 2,
          toolUsePromptTokenCount: 0,
          totalTokenCount: 8,
        },
      },
    });
    accumulator.observeStreamEvent({
      data: {
        candidates: [{ finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3, totalTokenCount: 7 },
      },
    });
    accumulator.observeStreamEvent({
      data: {
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 100,
          thoughtsTokenCount: 100,
          toolUsePromptTokenCount: 100,
          totalTokenCount: 400,
        },
      },
    });

    const result = accumulator.snapshot();
    expect(result.usage).toMatchObject({
      inputTokensTotal: 4,
      outputTokensTotal: 3,
      thinkingTokens: 0,
      toolUseInputTokens: 0,
      providerTotalTokens: 7,
      canonicalTotalTokens: 7,
    });
    expect(result.qualityFlags).toContain('regressing_cumulative_usage:thoughts');
  });

  it('classifies prompt blocking without retaining block messages', () => {
    const accumulator = new GoogleGenerateContentAdapter().createAccumulator();
    accumulator.observeJsonResponse({
      promptFeedback: { blockReason: 'SAFETY', blockReasonMessage: ERROR_CANARY },
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 0, thoughtsTokenCount: 0 },
    });
    const result = accumulator.snapshot();
    expect(result.outcome).toMatchObject({
      termination: 'content_filter',
      refusal: true,
      refusalSource: 'prompt_feedback',
    });
    expectContentFree(result);
    expect(result.qualityFlags).not.toContain('duplicate_protocol_terminal');
  });
});
