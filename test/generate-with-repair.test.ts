import { describe, it, expect, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import {
  extractJson,
  schemaToPromptHint,
  generateObjectWithRepair,
  generateWithinOutputCap,
  DEFAULT_MAX_TOKENS,
  OUTPUT_TRUNCATED,
  OutputTruncatedError,
  TRUNCATION_RETRY_MAX_TOKENS,
} from '../src/pipeline/generate-with-repair.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeV3Result(text: string, finish: 'stop' | 'length' = 'stop') {
  return {
    content: [{ type: 'text' as const, text }],
    finishReason:
      finish === 'length'
        ? { unified: 'length' as const, raw: 'max_tokens' }
        : { unified: 'stop' as const, raw: 'stop' },
    usage: {
      inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 50, text: undefined, reasoning: undefined },
    },
    warnings: [],
    request: {},
    response: { id: 'test-id', modelId: 'test-model', timestamp: new Date() },
  };
}

/**
 * Creates a MockLanguageModelV3 that returns entries from `responses` in order.
 * Throws an error if called more times than there are provided responses.
 */
function createMockModel(responses: string[]): MockLanguageModelV3 {
  let callIndex = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      if (callIndex >= responses.length) {
        throw new Error(
          `MockLanguageModelV3 called ${callIndex + 1} times, but only ${responses.length} responses were provided.`,
        );
      }
      const text = responses[callIndex++];
      return makeV3Result(text);
    },
  });
}

// ---------------------------------------------------------------------------
// extractJson
// ---------------------------------------------------------------------------

describe('extractJson', () => {
  it('extracts JSON from a ```json code block', () => {
    const text = 'Here is the result:\n```json\n{"key": "value"}\n```\nDone.';
    expect(extractJson(text)).toBe('{"key": "value"}');
  });

  it('extracts JSON from a plain ``` code block (no language tag)', () => {
    const text = 'Output:\n```\n{"key": "value"}\n```';
    expect(extractJson(text)).toBe('{"key": "value"}');
  });

  it('extracts JSON object from surrounding prose', () => {
    const text = 'The answer is {"value": 42} and that is correct.';
    expect(extractJson(text)).toBe('{"value": 42}');
  });

  it('extracts JSON array from surrounding prose', () => {
    const text = 'Results: [1, 2, 3] are the numbers.';
    expect(extractJson(text)).toBe('[1, 2, 3]');
  });

  it('returns original text when there is no JSON', () => {
    const text = 'plain text without any json here';
    expect(extractJson(text)).toBe(text);
  });

  it('returns original text when opening bracket has no matching closing bracket', () => {
    const text = 'incomplete {json';
    expect(extractJson(text)).toBe(text);
  });

  it('prefers object `{` when it appears before array `[`', () => {
    const text = 'data: {"a": [1,2]} and done';
    // { appears before [
    const result = extractJson(text);
    expect(result.startsWith('{')).toBe(true);
  });

  it('prefers array `[` when it appears before object `{`', () => {
    const text = '[{"a": 1}]';
    // [ appears at index 0, { appears at index 1
    const result = extractJson(text);
    expect(result.startsWith('[')).toBe(true);
  });

  it('picks up until the last closing bracket', () => {
    const text = '{"a": 1} {"b": 2}';
    // Should extract from first { to last }
    expect(extractJson(text)).toBe('{"a": 1} {"b": 2}');
  });

  it('handles array-only text with no object brackets', () => {
    expect(extractJson('[1, 2, 3]')).toBe('[1, 2, 3]');
  });

  it('handles object-only text with no array brackets', () => {
    expect(extractJson('{"x": true}')).toBe('{"x": true}');
  });

  it('handles empty string', () => {
    expect(extractJson('')).toBe('');
  });

  it('trims content inside markdown code block', () => {
    const text = '```json\n  {"key": "val"}  \n```';
    expect(extractJson(text)).toBe('{"key": "val"}');
  });
});

// ---------------------------------------------------------------------------
// schemaToPromptHint
// ---------------------------------------------------------------------------

describe('schemaToPromptHint', () => {
  it('returns a formatted JSON Schema hint for a simple object schema', () => {
    const schema = z.object({ name: z.string(), count: z.number() });
    const hint = schemaToPromptHint(schema);
    expect(hint).toContain('Your response must be a JSON object matching this schema:');
    expect(hint).toContain('"type"');
    expect(hint).toContain('"properties"');
    expect(hint).toContain('name');
    expect(hint).toContain('count');
  });

  it('returns a fallback message when toJSONSchema throws', () => {
    const badSchema = {
      toJSONSchema: () => {
        throw new Error('Cannot convert this schema');
      },
      parse: (v: unknown) => v,
    } as unknown as z.ZodType;

    const hint = schemaToPromptHint(badSchema);
    expect(hint).toBe('\n\nReturn your response as valid JSON.');
  });

  it('includes well-formed JSON in the hint for a nested schema', () => {
    const schema = z.object({
      items: z.array(z.string()),
      meta: z.object({ version: z.number() }),
    });
    const hint = schemaToPromptHint(schema);
    // The JSON Schema should be parseable
    const schemaStart = hint.indexOf('{');
    const jsonPart = hint.slice(schemaStart);
    expect(() => JSON.parse(jsonPart)).not.toThrow();
  });

  it('starts with a newline separator', () => {
    const schema = z.object({ x: z.string() });
    const hint = schemaToPromptHint(schema);
    expect(hint.startsWith('\n\n')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// generateObjectWithRepair
// ---------------------------------------------------------------------------

const simpleSchema = z.object({ value: z.number() });

describe('generateObjectWithRepair', () => {
  it('succeeds on the first attempt and returns repairAttempts = 0', async () => {
    const model = createMockModel(['{"value": 42}']);

    const result = await generateObjectWithRepair({
      model,
      schema: simpleSchema,
      prompt: 'Return a number.',
    });

    expect(result.output).toEqual({ value: 42 });
    expect(result.repairAttempts).toBe(0);
  });

  it('succeeds on the second attempt and returns repairAttempts = 1', async () => {
    // First call returns invalid JSON; second returns valid JSON
    const model = createMockModel(['not valid json at all', '{"value": 7}']);

    const result = await generateObjectWithRepair({
      model,
      schema: simpleSchema,
      prompt: 'Return a number.',
    });

    expect(result.output).toEqual({ value: 7 });
    expect(result.repairAttempts).toBe(1);
  });

  it('succeeds on the final repair attempt', async () => {
    const model = createMockModel(['bad', 'still bad', '{"value": 99}']);

    const result = await generateObjectWithRepair({
      model,
      schema: simpleSchema,
      prompt: 'Return a number.',
      maxRepairAttempts: 2,
    });

    expect(result.output).toEqual({ value: 99 });
    expect(result.repairAttempts).toBe(2);
  });

  it('throws when all repair attempts are exhausted', async () => {
    const model = createMockModel(['not json', 'also not json', 'still not json']);

    await expect(
      generateObjectWithRepair({
        model,
        schema: simpleSchema,
        prompt: 'Return a number.',
        maxRepairAttempts: 2,
      }),
    ).rejects.toThrow();
  });

  it('throws immediately with maxRepairAttempts = 0 on first failure', async () => {
    const model = createMockModel(['not json']);

    await expect(
      generateObjectWithRepair({
        model,
        schema: simpleSchema,
        prompt: 'Return a number.',
        maxRepairAttempts: 0,
      }),
    ).rejects.toThrow();
  });

  it('calls onProgress for each repair attempt but not for the first attempt', async () => {
    const model = createMockModel(['bad', 'bad', '{"value": 5}']);
    const onProgress = vi.fn();

    await generateObjectWithRepair({
      model,
      schema: simpleSchema,
      prompt: 'Return a number.',
      maxRepairAttempts: 2,
      onProgress,
    });

    // onProgress fires for every attempt after the first (attempt > 0),
    // regardless of whether that attempt fails or succeeds.
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenCalledWith('Schema repair 1/2...');
    expect(onProgress).toHaveBeenCalledWith('Schema repair 2/2...');
  });

  it('does not call onProgress when first attempt succeeds', async () => {
    const model = createMockModel(['{"value": 1}']);
    const onProgress = vi.fn();

    await generateObjectWithRepair({
      model,
      schema: simpleSchema,
      prompt: 'Return a number.',
      onProgress,
    });

    expect(onProgress).not.toHaveBeenCalled();
  });

  it('works with a string system prompt', async () => {
    const model = createMockModel(['{"value": 100}']);

    const result = await generateObjectWithRepair({
      model,
      schema: simpleSchema,
      system: 'You are a helpful assistant.',
      prompt: 'Return a number.',
    });

    expect(result.output).toEqual({ value: 100 });
    expect(result.repairAttempts).toBe(0);
  });

  it('accepts JSON in a markdown code block from the LLM', async () => {
    const model = createMockModel(['```json\n{"value": 55}\n```']);

    const result = await generateObjectWithRepair({
      model,
      schema: simpleSchema,
      prompt: 'Return a number.',
    });

    expect(result.output).toEqual({ value: 55 });
    expect(result.repairAttempts).toBe(0);
  });

  it('accepts JSON embedded in prose from the LLM', async () => {
    const model = createMockModel(['The answer is {"value": 33} — enjoy!']);

    const result = await generateObjectWithRepair({
      model,
      schema: simpleSchema,
      prompt: 'Return a number.',
    });

    expect(result.output).toEqual({ value: 33 });
    expect(result.repairAttempts).toBe(0);
  });

  it('passes maxOutputTokens to the underlying model call', async () => {
    let capturedMaxTokens: number | undefined;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        capturedMaxTokens = options.maxOutputTokens;
        return makeV3Result('{"value": 1}');
      },
    });

    const result = await generateObjectWithRepair({
      model,
      schema: simpleSchema,
      prompt: 'Return a number.',
      maxOutputTokens: 512,
    });

    expect(result.output).toEqual({ value: 1 });
    expect(capturedMaxTokens).toBe(512);
  });

  it('throws on schema validation failure even with valid JSON', async () => {
    const model = createMockModel(['{"value": "not-a-number"}']);

    await expect(
      generateObjectWithRepair({
        model,
        schema: simpleSchema,
        prompt: 'Return a number.',
        maxRepairAttempts: 0,
      }),
    ).rejects.toThrow();
  });

  it('exports DEFAULT_MAX_TOKENS as a positive number', () => {
    expect(DEFAULT_MAX_TOKENS).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Truncated output (finish reason "length") -- WP-88 / PIP-20
// ---------------------------------------------------------------------------

/** One recorded model call: its output cap, temperature and the last user message. */
interface RecordedCall {
  readonly maxOutputTokens: number | undefined;
  readonly temperature: number | undefined;
  readonly lastUserText: string;
}

/** A model replaying `replies` in order; each is text and whether it was cut off at the cap. */
function scriptedModel(replies: Array<{ text: string; truncated?: boolean }>) {
  const calls: RecordedCall[] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      const lastUser = [...options.prompt].reverse().find((m) => m.role === 'user');
      calls.push({
        maxOutputTokens: options.maxOutputTokens,
        temperature: options.temperature,
        lastUserText:
          lastUser && Array.isArray(lastUser.content)
            ? lastUser.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
            : '',
      });
      const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
      return makeV3Result(reply.text, reply.truncated ? 'length' : 'stop');
    },
  });
  return { model, calls };
}

/** JSON cut off mid-way, as a model stopped at its output cap returns it. */
const CUT_OFF = '{"value": 4';

describe('generateObjectWithRepair with truncated output', () => {
  it('repeats a truncated request once with the larger cap instead of asking for a schema repair', async () => {
    const { model, calls } = scriptedModel([{ text: CUT_OFF, truncated: true }, { text: '{"value": 42}' }]);
    const progress: string[] = [];

    const result = await generateObjectWithRepair({
      model,
      schema: simpleSchema,
      prompt: 'Return a number.',
      onProgress: (msg) => progress.push(msg),
    });

    expect(result).toEqual({ output: { value: 42 }, repairAttempts: 0 });
    expect(calls.map((c) => c.maxOutputTokens)).toEqual([DEFAULT_MAX_TOKENS, TRUNCATION_RETRY_MAX_TOKENS]);
    // The same request, not a "fix the errors" turn about the cut-off JSON.
    expect(calls[1].lastUserText).toBe(calls[0].lastUserText);
    expect(calls[1].lastUserText).not.toContain('failed schema validation');
    expect(progress).toContain(
      `Output truncated at ${DEFAULT_MAX_TOKENS} tokens; retrying with ${TRUNCATION_RETRY_MAX_TOKENS}...`,
    );
  });

  it('fails with a distinct truncation error when the larger cap is cut off too', async () => {
    const { model, calls } = scriptedModel([{ text: CUT_OFF, truncated: true }]);

    const error = await generateObjectWithRepair({ model, schema: simpleSchema, prompt: 'Return a number.' }).catch(
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(OutputTruncatedError);
    expect((error as OutputTruncatedError).code).toBe(OUTPUT_TRUNCATED);
    expect((error as OutputTruncatedError).maxOutputTokens).toBe(TRUNCATION_RETRY_MAX_TOKENS);
    expect((error as Error).message).toContain(`output truncated at ${TRUNCATION_RETRY_MAX_TOKENS} tokens`);
    // Not the JSON syntax error the cut-off text would cause.
    expect(error).not.toBeInstanceOf(SyntaxError);
    // One request and one retry: no schema-repair turns are spent on cut-off text.
    expect(calls.map((c) => c.maxOutputTokens)).toEqual([DEFAULT_MAX_TOKENS, TRUNCATION_RETRY_MAX_TOKENS]);
  });

  it('starts a schema repair after a truncation retry at the larger cap', async () => {
    const { model, calls } = scriptedModel([
      { text: CUT_OFF, truncated: true },
      { text: '{"value": "not a number"}' },
      { text: '{"value": 7}' },
    ]);

    const result = await generateObjectWithRepair({ model, schema: simpleSchema, prompt: 'Return a number.' });

    expect(result).toEqual({ output: { value: 7 }, repairAttempts: 1 });
    expect(calls.map((c) => c.maxOutputTokens)).toEqual([
      DEFAULT_MAX_TOKENS,
      TRUNCATION_RETRY_MAX_TOKENS,
      TRUNCATION_RETRY_MAX_TOKENS,
    ]);
    expect(calls[2].lastUserText).toContain('failed schema validation');
  });

  it('passes the temperature to the model', async () => {
    const { model, calls } = scriptedModel([{ text: '{"value": 1}' }]);
    await generateObjectWithRepair({ model, schema: simpleSchema, prompt: 'Return a number.', temperature: 0 });
    expect(calls[0].temperature).toBe(0);
  });
});

describe('generateWithinOutputCap', () => {
  it('returns an untruncated response and the cap it was produced under', async () => {
    const request = vi.fn((cap: number) => Promise.resolve({ finishReason: 'stop', cap }));
    await expect(generateWithinOutputCap(request, 256)).resolves.toEqual({
      result: { finishReason: 'stop', cap: 256 },
      maxOutputTokens: 256,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('retries once with the larger cap and reports that cap', async () => {
    const request = vi.fn((cap: number) => Promise.resolve({ finishReason: cap < 1000 ? 'length' : 'stop', cap }));
    await expect(generateWithinOutputCap(request, 256)).resolves.toEqual({
      result: { finishReason: 'stop', cap: TRUNCATION_RETRY_MAX_TOKENS },
      maxOutputTokens: TRUNCATION_RETRY_MAX_TOKENS,
    });
    expect(request.mock.calls.map(([cap]) => cap)).toEqual([256, TRUNCATION_RETRY_MAX_TOKENS]);
  });

  it('does not raise a cap that is already at least the retry cap', async () => {
    const request = vi.fn(() => Promise.resolve({ finishReason: 'length' }));
    await expect(generateWithinOutputCap(request, TRUNCATION_RETRY_MAX_TOKENS)).rejects.toMatchObject({
      code: OUTPUT_TRUNCATED,
      maxOutputTokens: TRUNCATION_RETRY_MAX_TOKENS,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
