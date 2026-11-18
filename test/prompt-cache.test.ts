import { describe, it, expect } from 'vitest';
import { AnthropicCacheStrategy, NoOpCacheStrategy, createCacheStrategy } from '../src/session/prompt-cache.js';
import { tool, type ModelMessage, type ToolSet } from 'ai';
import { z } from 'zod';

const EXPECTED_CACHE_CONTROL = {
  anthropic: { cacheControl: { type: 'ephemeral' } },
};

describe('createCacheStrategy', () => {
  it('returns AnthropicCacheStrategy for anthropic provider', () => {
    expect(createCacheStrategy('anthropic:claude-sonnet-4-6')).toBeInstanceOf(AnthropicCacheStrategy);
  });

  it('returns AnthropicCacheStrategy for bare model ID (defaults to anthropic)', () => {
    expect(createCacheStrategy('claude-sonnet-4-6')).toBeInstanceOf(AnthropicCacheStrategy);
  });

  it('returns NoOpCacheStrategy for openai provider', () => {
    expect(createCacheStrategy('openai:gpt-4o')).toBeInstanceOf(NoOpCacheStrategy);
  });

  it('returns NoOpCacheStrategy for google provider', () => {
    expect(createCacheStrategy('google:gemini-2.0-flash')).toBeInstanceOf(NoOpCacheStrategy);
  });
});

describe('AnthropicCacheStrategy', () => {
  const strategy = new AnthropicCacheStrategy();

  describe('wrapSystemPrompt', () => {
    it('returns a SystemModelMessage with cacheControl', () => {
      const result = strategy.wrapSystemPrompt('You are a helpful assistant.');
      expect(result).toEqual({
        role: 'system',
        content: 'You are a helpful assistant.',
        providerOptions: EXPECTED_CACHE_CONTROL,
      });
    });
  });

  describe('wrapTools', () => {
    it('adds providerOptions to the (only) tool', () => {
      const tools: ToolSet = {
        execute_code: tool({
          description: 'Run code',
          inputSchema: z.object({ code: z.string() }),
        }),
      };

      const wrapped = strategy.wrapTools(tools);

      expect(wrapped.execute_code).toBeDefined();
      expect((wrapped.execute_code as Record<string, unknown>).providerOptions).toEqual(EXPECTED_CACHE_CONTROL);
      // Original is not mutated
      expect((tools.execute_code as Record<string, unknown>).providerOptions).toBeUndefined();
    });

    it('marks only the last tool, so the tool definitions use one breakpoint however many there are', () => {
      const tools: ToolSet = {
        first: tool({ description: 'one', inputSchema: z.object({}) }),
        second: tool({ description: 'two', inputSchema: z.object({}) }),
        third: tool({ description: 'three', inputSchema: z.object({}) }),
      };

      const wrapped = strategy.wrapTools(tools);

      expect(Object.keys(wrapped)).toEqual(['first', 'second', 'third']);
      expect((wrapped.first as Record<string, unknown>).providerOptions).toBeUndefined();
      expect((wrapped.second as Record<string, unknown>).providerOptions).toBeUndefined();
      expect((wrapped.third as Record<string, unknown>).providerOptions).toEqual(EXPECTED_CACHE_CONTROL);
    });
  });

  describe('applyHistoryBreakpoint', () => {
    it('marks the second-to-last message with cacheControl', () => {
      const messages: ModelMessage[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] },
        { role: 'user', content: 'How are you?' },
      ];

      const result = strategy.applyHistoryBreakpoint(messages);

      expect(result).toHaveLength(3);
      // Second-to-last (index 1) gets cacheControl
      expect(result[1].providerOptions).toEqual(EXPECTED_CACHE_CONTROL);
      // Others are unchanged
      expect(result[0].providerOptions).toBeUndefined();
      expect(result[2].providerOptions).toBeUndefined();
    });

    it('does not mutate the original messages array', () => {
      const messages: ModelMessage[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: [{ type: 'text', text: 'Hi!' }] },
        { role: 'user', content: 'Bye' },
      ];
      const originalRef = messages[1];

      strategy.applyHistoryBreakpoint(messages);

      // Original array element is not mutated
      expect(originalRef.providerOptions).toBeUndefined();
      expect(messages).toHaveLength(3);
    });

    it('does not add breakpoint for a single message', () => {
      const messages: ModelMessage[] = [{ role: 'user', content: 'Hello' }];

      const result = strategy.applyHistoryBreakpoint(messages);

      expect(result).toHaveLength(1);
      expect(result[0].providerOptions).toBeUndefined();
    });

    it('returns a copy for empty array', () => {
      const messages: ModelMessage[] = [];

      const result = strategy.applyHistoryBreakpoint(messages);

      expect(result).toHaveLength(0);
      expect(result).not.toBe(messages);
    });

    it('merges with existing providerOptions on the target message', () => {
      const messages: ModelMessage[] = [
        { role: 'user', content: 'Hello' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hi!' }],
          providerOptions: { anthropic: { someOther: true } },
        },
        { role: 'user', content: 'Bye' },
      ];

      const result = strategy.applyHistoryBreakpoint(messages);

      // The anthropic key is overwritten by the cache-control spread
      expect(result[1].providerOptions).toEqual(EXPECTED_CACHE_CONTROL);
    });
  });

  describe('applyStepBreakpoint', () => {
    /** A step's prompt in the middle of a turn: history, the user message, a tool call and its result. */
    function stepPrompt(): ModelMessage[] {
      return [
        { role: 'user', content: 'Earlier task' },
        { role: 'assistant', content: [{ type: 'text', text: 'Earlier answer' }] },
        { role: 'user', content: 'New task' },
        {
          role: 'assistant',
          content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'execute_code', input: { code: 'x' } }],
        },
        {
          role: 'tool',
          content: [
            { type: 'tool-result', toolCallId: 'c1', toolName: 'execute_code', output: { type: 'text', value: 'ok' } },
          ],
        },
      ];
    }

    it('marks the last message of the step (the newest tool result)', () => {
      const messages = stepPrompt();
      const result = strategy.applyStepBreakpoint(messages);

      expect(result).toHaveLength(messages.length);
      expect(result.at(-1)?.providerOptions).toEqual(EXPECTED_CACHE_CONTROL);
      expect(result.slice(0, -1).every((message) => message.providerOptions === undefined)).toBe(true);
      // Neither the array nor its messages are mutated.
      expect(messages.at(-1)?.providerOptions).toBeUndefined();
      expect(result).not.toBe(messages);
    });

    it("keeps a step's prompt at four breakpoints with the system prompt, the tools and the history mark", () => {
      const system = strategy.wrapSystemPrompt('system');
      const tools = strategy.wrapTools({
        execute_code: tool({ description: 'Run code', inputSchema: z.object({ code: z.string() }) }),
      });
      // The history breakpoint is applied once per turn, to the history up to
      // the new user message; each step then adds the moving one.
      const turnStart = strategy.applyHistoryBreakpoint(stepPrompt().slice(0, 3));
      const step = strategy.applyStepBreakpoint([...turnStart, ...stepPrompt().slice(3)]);

      const marked = (value: { providerOptions?: unknown }): number =>
        JSON.stringify(value.providerOptions ?? {}).includes('cacheControl') ? 1 : 0;
      const breakpoints =
        marked(system) +
        Object.values(tools).reduce((sum, def) => sum + marked(def as { providerOptions?: unknown }), 0) +
        step.reduce((sum, message) => sum + marked(message), 0);
      expect(breakpoints).toBe(4);
      expect(step[1].providerOptions).toEqual(EXPECTED_CACHE_CONTROL); // history: before the new user message
      expect(step.at(-1)?.providerOptions).toEqual(EXPECTED_CACHE_CONTROL); // the step's tail
    });

    it('merges with existing providerOptions of the last message', () => {
      const messages: ModelMessage[] = [
        { role: 'user', content: 'Hello', providerOptions: { openai: { user: 'u1' } } },
      ];
      const result = strategy.applyStepBreakpoint(messages);
      expect(result[0].providerOptions).toEqual({ openai: { user: 'u1' }, ...EXPECTED_CACHE_CONTROL });
    });

    it('returns a copy for an empty prompt', () => {
      const messages: ModelMessage[] = [];
      const result = strategy.applyStepBreakpoint(messages);
      expect(result).toEqual([]);
      expect(result).not.toBe(messages);
    });
  });
});

describe('NoOpCacheStrategy', () => {
  const strategy = new NoOpCacheStrategy();

  it('returns system prompt unchanged', () => {
    const prompt = 'You are a helpful assistant.';
    expect(strategy.wrapSystemPrompt(prompt)).toBe(prompt);
  });

  it('returns tools unchanged', () => {
    const tools: ToolSet = {
      execute_code: tool({
        description: 'Run code',
        inputSchema: z.object({ code: z.string() }),
      }),
    };
    expect(strategy.wrapTools(tools)).toBe(tools);
  });

  it('returns a copy of messages without modifications', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'Hi!' }] },
    ];

    for (const result of [strategy.applyHistoryBreakpoint(messages), strategy.applyStepBreakpoint(messages)]) {
      expect(result).toHaveLength(2);
      expect(result).not.toBe(messages); // new array
      expect(result[0]).toBe(messages[0]); // same references (no mutation)
      expect(result[1]).toBe(messages[1]);
    }
  });
});
