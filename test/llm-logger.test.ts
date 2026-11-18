import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { wrapLanguageModel, generateText, Output } from 'ai';
import {
  APICallError,
  type LanguageModelV3,
  type LanguageModelV3Content,
  type LanguageModelV3Message,
  type LanguageModelV3Prompt,
} from '@ai-sdk/provider';
import { z } from 'zod';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createLlmLoggingMiddleware,
  type LlmFullLogEntry,
  type LlmLogContext,
  type LlmLoggingOptions,
  type LlmLogEntry,
  type LlmMetadataLogEntry,
} from '../src/observability/llm-logger.js';
import { prepareRedactionSecrets } from '../src/trusted-process/audit-redactor.js';

let testDir: string;
let logPath: string;

const USAGE = {
  inputTokens: { total: 100, noCache: undefined, cacheRead: 7, cacheWrite: undefined },
  outputTokens: { total: 50, text: undefined, reasoning: undefined },
};

/** A mock model answering every call with `text` (plus any extra content parts). */
function createMockModel(text: string, extra: LanguageModelV3Content[] = []): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text }, ...extra],
      finishReason: { unified: 'stop' as const, raw: 'stop' },
      usage: USAGE,
      warnings: [],
      request: {},
      response: { id: 'test-id', modelId: 'test-model', timestamp: new Date() },
    }),
  });
}

/** A mock model whose every call fails with `error`. */
function createFailingModel(error: unknown): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => {
      throw error;
    },
  });
}

function wrap(model: LanguageModelV3, options?: LlmLoggingOptions, context: LlmLogContext = { stepName: 'test' }) {
  return wrapLanguageModel({ model, middleware: createLlmLoggingMiddleware(logPath, context, options) });
}

/** Calls the wrapped model directly, so each test controls the exact prompt the middleware sees. */
async function call(model: LanguageModelV3, prompt: LanguageModelV3Prompt) {
  return model.doGenerate({ prompt });
}

function user(text: string, providerOptions?: LanguageModelV3Message['providerOptions']): LanguageModelV3Message {
  return { role: 'user', content: [{ type: 'text', text }], ...(providerOptions ? { providerOptions } : {}) };
}

function assistant(text: string): LanguageModelV3Message {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

const SYSTEM: LanguageModelV3Message = { role: 'system', content: 'You are a test agent.' };
const CACHE_MARKER = { anthropic: { cacheControl: { type: 'ephemeral' } } };

function readLogEntries<T extends LlmLogEntry = LlmLogEntry>(): T[] {
  const content = readFileSync(logPath, 'utf-8').trim();
  if (content === '') return [];
  return content.split('\n').map((line) => JSON.parse(line) as T);
}

function fileMode(path: string): number {
  return statSync(path).mode & 0o777;
}

/** Rebuilds the prompt of every entry following the documented reconstruction rule. */
function reconstructPrompts(entries: LlmFullLogEntry[]): unknown[][] {
  const prompts: unknown[][] = [];
  let current: unknown[] = [];
  for (const entry of entries) {
    const items = entry.prompt as unknown[];
    current = entry.promptOffset === 0 ? [...items] : [...current, ...items];
    expect(current).toHaveLength(entry.promptOffset + items.length);
    prompts.push(current);
  }
  return prompts;
}

describe('LLM Logger Middleware', () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'llm-logger-test-'));
    logPath = join(testDir, 'test-interactions.jsonl');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('log file', () => {
    it('creates the log file on initialization', () => {
      createLlmLoggingMiddleware(logPath, { stepName: 'test-step' });
      expect(existsSync(logPath)).toBe(true);
    });

    it('creates the file 0600 and a missing directory 0700, whatever the umask', () => {
      const nested = join(testDir, 'sessions', 'abc');
      logPath = join(nested, 'llm-interactions.jsonl');
      const previous = process.umask(0o000);
      try {
        createLlmLoggingMiddleware(logPath, { stepName: 'test-step' });
      } finally {
        process.umask(previous);
      }
      expect(fileMode(logPath)).toBe(0o600);
      expect(fileMode(nested)).toBe(0o700);
      expect(fileMode(join(testDir, 'sessions'))).toBe(0o700);
    });

    it('tightens an existing world-readable log to 0600 and keeps an existing directory mode', () => {
      writeFileSync(logPath, '{"old":true}\n');
      chmodSync(logPath, 0o644);
      chmodSync(testDir, 0o755);
      createLlmLoggingMiddleware(logPath, { stepName: 'test-step' }, { appendOnly: true });
      expect(fileMode(logPath)).toBe(0o600);
      // The parent may be shared (a package's generated dir): never chmod it.
      expect(fileMode(testDir)).toBe(0o755);
    });

    it('truncates the log file on creation to avoid mixing with previous runs', async () => {
      const context: LlmLogContext = { stepName: 'old-step' };
      const schema = z.object({ value: z.number() });
      const model = createMockModel(JSON.stringify({ value: 1 }));

      await generateText({ model: wrap(model, {}, context), output: Output.object({ schema }), prompt: 'Old run' });
      expect(readLogEntries()).toHaveLength(1);

      context.stepName = 'new-step';
      await generateText({ model: wrap(model, {}, context), output: Output.object({ schema }), prompt: 'New run' });

      const entries = readLogEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].stepName).toBe('new-step');
    });

    it('appendOnly keeps what an earlier run wrote (a resumed session extends its log)', async () => {
      const model = createMockModel('first');
      await call(wrap(model, { appendOnly: true }), [user('run one')]);
      await call(wrap(model, { appendOnly: true }), [user('run two')]);
      expect(readLogEntries()).toHaveLength(2);
    });

    it('never fails the model call (or masks its error) when the log cannot be written', async () => {
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        const model = wrap(createMockModel('still answered'));
        const failing = wrap(createFailingModel(new Error('the real failure')));
        // Replace the log's directory with a file: every append now fails.
        rmSync(testDir, { recursive: true, force: true });
        writeFileSync(testDir, 'not a directory');

        const result = await call(model, [user('hello')]);
        expect(result.content).toEqual([{ type: 'text', text: 'still answered' }]);
        await call(model, [user('again')]);
        await expect(call(failing, [user('hello')])).rejects.toThrow('the real failure');

        // Reported once per log (the session logger is not active here, so on stderr).
        const reports = stderr.mock.calls.filter(([text]) => String(text).includes('[llm-log] Cannot write'));
        expect(reports).toHaveLength(2);
      } finally {
        stderr.mockRestore();
        rmSync(testDir, { force: true });
      }
    });
  });

  describe("metadata detail (the default, observability.llmInteractionLog: 'metadata')", () => {
    it('records sizes, timings and token counts but no prompt or response text', async () => {
      const promptSecret = 'PROMPT-CANARY-7f3a tool result: DB_PASSWORD=hunter2-canary';
      const responseSecret = 'RESPONSE-CANARY-91bd';
      const model = wrap(
        createMockModel(responseSecret, [
          { type: 'tool-call', toolCallId: 'c1', toolName: 'execute_code', input: '{"code":"CODE-CANARY"}' },
        ]),
        undefined,
        { stepName: 'agent' },
      );

      await call(model, [SYSTEM, user(promptSecret), assistant('earlier ANSWER-CANARY'), user('next')]);

      const raw = readFileSync(logPath, 'utf-8');
      for (const canary of [
        'PROMPT-CANARY',
        'hunter2',
        'RESPONSE-CANARY',
        'ANSWER-CANARY',
        'CODE-CANARY',
        'test agent',
      ]) {
        expect(raw).not.toContain(canary);
      }
      const [entry] = readLogEntries<LlmMetadataLogEntry>();
      expect(entry).toMatchObject({
        detail: 'metadata',
        stepName: 'agent',
        modelId: 'mock-model-id',
        promptMessages: 4,
        finishReason: 'stop',
        responseChars: responseSecret.length,
        toolCalls: 1,
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 7 },
      });
      expect(entry.durationMs).toBeGreaterThanOrEqual(0);
      expect(entry.timestamp).toBeTruthy();
      expect(entry).not.toHaveProperty('prompt');
      expect(entry).not.toHaveProperty('responseText');
    });

    it('records a failed call by error name and status, without its message, and rethrows it', async () => {
      const error = new APICallError({
        message: 'overloaded while reading MESSAGE-CANARY',
        url: 'https://api.example.test/v1/messages',
        requestBodyValues: { prompt: 'BODY-CANARY' },
        statusCode: 529,
        isRetryable: true,
      });
      const model = wrap(createFailingModel(error));

      await expect(call(model, [user('PROMPT-CANARY')])).rejects.toBe(error);

      const raw = readFileSync(logPath, 'utf-8');
      expect(raw).not.toMatch(/CANARY/);
      const [entry] = readLogEntries<LlmMetadataLogEntry>();
      expect(entry).toMatchObject({
        detail: 'metadata',
        promptMessages: 1,
        error: { name: 'AI_APICallError', statusCode: 529 },
      });
      expect(entry.error).not.toHaveProperty('message');
      expect(entry).not.toHaveProperty('usage');
      expect(entry.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('fails a generateText call with the provider error after logging it', async () => {
      const error = new Error('model unavailable');
      await expect(generateText({ model: wrap(createFailingModel(error)), prompt: 'hi', maxRetries: 0 })).rejects.toBe(
        error,
      );
      const entries = readLogEntries<LlmMetadataLogEntry>();
      expect(entries).toHaveLength(1);
      expect(entries[0].error).toEqual({ name: 'Error' });
    });
  });

  describe('full detail', () => {
    it('logs a single generateText call with prompt and response', async () => {
      const context: LlmLogContext = { stepName: 'annotate-filesystem' };
      const model = createMockModel(JSON.stringify({ greeting: 'hello' }));

      await generateText({
        model: wrap(model, { detail: 'full' }, context),
        output: Output.object({ schema: z.object({ greeting: z.string() }) }),
        prompt: 'Say hello',
      });

      const entries = readLogEntries<LlmFullLogEntry>();
      expect(entries).toHaveLength(1);
      const entry = entries[0];
      expect(entry.detail).toBe('full');
      expect(entry.stepName).toBe('annotate-filesystem');
      expect(entry.modelId).toBe('mock-model-id');
      expect(entry.responseText).toBe(JSON.stringify({ greeting: 'hello' }));
      expect(entry.usage?.inputTokens).toBe(100);
      expect(entry.usage?.outputTokens).toBe(50);
      expect(entry.durationMs).toBeGreaterThanOrEqual(0);
      expect(entry.timestamp).toBeTruthy();
      expect(JSON.stringify(entry.prompt)).toContain('Say hello');
      expect(entry.promptOffset).toBe(0);
      expect(entry).not.toHaveProperty('reset');
    });

    it('logs multiple calls with different step names', async () => {
      const context: LlmLogContext = { stepName: 'step-1' };
      const model = wrap(createMockModel(JSON.stringify({ result: 'ok' })), { detail: 'full' }, context);
      const schema = z.object({ result: z.string() });

      await generateText({ model, output: Output.object({ schema }), prompt: 'First call' });
      context.stepName = 'step-2';
      await generateText({ model, output: Output.object({ schema }), prompt: 'Second call' });

      const entries = readLogEntries();
      expect(entries).toHaveLength(2);
      expect(entries[0].stepName).toBe('step-1');
      expect(entries[1].stepName).toBe('step-2');
    });

    it('records a failed call with its message, then rethrows the original error', async () => {
      const error = new Error('provider exploded');
      const model = wrap(createFailingModel(error), { detail: 'full', deltaLogging: true });

      await expect(call(model, [SYSTEM, user('question')])).rejects.toBe(error);

      const [entry] = readLogEntries<LlmFullLogEntry>();
      expect(entry.error).toEqual({ name: 'Error', message: 'provider exploded' });
      expect(entry.promptOffset).toBe(0);
      expect(JSON.stringify(entry.prompt)).toContain('question');
      expect(entry).not.toHaveProperty('responseText');
    });

    describe('redaction', () => {
      const ANTHROPIC_KEY = 'sk-ant-api03-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6';
      const CUSTOM_TOKEN = 'corp-deploy-token-' + '0123456789abcdef';
      const redaction = { secrets: prepareRedactionSecrets([CUSTOM_TOKEN]) };

      it('masks a planted API key and a known credential in the prompt and the response', async () => {
        const model = wrap(createMockModel(`I found ${ANTHROPIC_KEY} and ${CUSTOM_TOKEN}`), {
          detail: 'full',
          redaction,
        });

        await call(model, [
          SYSTEM,
          user(`.env says ANTHROPIC_API_KEY=${ANTHROPIC_KEY}`),
          {
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'c1',
                toolName: 'execute_code',
                output: { type: 'json', value: { result: `DEPLOY_TOKEN=${CUSTOM_TOKEN}` } },
              },
            ],
          },
        ]);

        const raw = readFileSync(logPath, 'utf-8');
        expect(raw).not.toContain(ANTHROPIC_KEY);
        expect(raw).not.toContain(CUSTOM_TOKEN);
        expect(raw).toContain('***REDACTED***');
        const [entry] = readLogEntries<LlmFullLogEntry>();
        expect(JSON.stringify(entry.prompt)).toContain('ANTHROPIC_API_KEY=sk-a...');
        expect(entry.responseText).toContain('sk-a...');
        expect(entry.responseText).toContain('***REDACTED***');
      });

      it('masks credentials in the message of a failed call', async () => {
        const model = wrap(createFailingModel(new Error(`401 for key ${ANTHROPIC_KEY}`)), {
          detail: 'full',
          redaction,
        });
        await expect(call(model, [user('hi')])).rejects.toThrow();
        const [entry] = readLogEntries<LlmFullLogEntry>();
        expect(entry.error?.message).toBe('401 for key sk-a...O5p6');
      });

      it('writes text verbatim without redaction settings', async () => {
        const model = wrap(createMockModel('ok'), { detail: 'full' });
        await call(model, [user(`key ${ANTHROPIC_KEY}`)]);
        expect(readFileSync(logPath, 'utf-8')).toContain(ANTHROPIC_KEY);
      });
    });
  });

  describe('delta logging', () => {
    const options: LlmLoggingOptions = { detail: 'full', deltaLogging: true };

    it('logs only new messages for a growing history', async () => {
      const model = wrap(createMockModel('ok'), options, { stepName: 'agent' });

      await call(model, [SYSTEM, user('Hello')]);
      await call(model, [SYSTEM, user('Hello'), assistant('Hi there'), user('What is 2+2?')]);

      const entries = readLogEntries<LlmFullLogEntry>();
      expect(entries).toHaveLength(2);
      expect(entries[0].promptOffset).toBe(0);
      expect(entries[1].promptOffset).toBe(2);
      const second = JSON.stringify(entries[1].prompt);
      expect(second).not.toContain('Hello');
      expect(second).toContain('What is 2+2?');
      expect(entries[1]).not.toHaveProperty('reset');
    });

    it('logs the whole prompt with reset:true after compaction shrinks it', async () => {
      const model = wrap(createMockModel('ok'), options, { stepName: 'agent' });
      const history: LanguageModelV3Message[] = [SYSTEM];
      for (let turn = 0; turn < 5; turn++) {
        history.push(user(`question ${turn}`), assistant(`answer ${turn}`));
      }
      history.push(user('question 5'));
      await call(model, history);

      // MessageCompactor replaces the older history with a summary and keeps
      // the recent messages; the new user message follows.
      const compacted = [
        SYSTEM,
        user('[Conversation summary]\n\nSUMMARY-OF-0-TO-3'),
        user('question 4'),
        assistant('answer 4'),
        user('question 5'),
        assistant('answer 5'),
        user('question 6'),
      ];
      await call(model, compacted);
      await call(model, [...compacted, assistant('answer 6'), user('question 7')]);

      const entries = readLogEntries<LlmFullLogEntry>();
      expect(entries).toHaveLength(3);
      expect(entries[1]).toMatchObject({ promptOffset: 0, reset: true });
      expect(entries[1].prompt).toHaveLength(compacted.length);
      expect(JSON.stringify(entries[1].prompt)).toContain('SUMMARY-OF-0-TO-3');
      // Delta logging resumes from the compacted prompt.
      expect(entries[2].promptOffset).toBe(compacted.length);
      expect(entries[2]).not.toHaveProperty('reset');

      const rebuilt = reconstructPrompts(entries);
      expect(rebuilt[1]).toEqual(compacted);
      expect(rebuilt[2]).toEqual([...compacted, assistant('answer 6'), user('question 7')]);
    });

    it('resets when a logged message changes although the prompt did not shrink (rolled-back turn)', async () => {
      const model = wrap(createMockModel('ok'), options);
      await call(model, [SYSTEM, user('first try')]);
      // The turn failed and was rolled back; the user sent something else.
      await call(model, [SYSTEM, user('second try'), assistant('x'), user('more')]);

      const entries = readLogEntries<LlmFullLogEntry>();
      expect(entries[1]).toMatchObject({ promptOffset: 0, reset: true });
      expect(reconstructPrompts(entries)[1]).toEqual([SYSTEM, user('second try'), assistant('x'), user('more')]);
    });

    it('does not reset when only providerOptions move (Anthropic cache breakpoint)', async () => {
      const model = wrap(createMockModel('ok'), options);
      // applyHistoryBreakpoint marks the second-to-last message each turn.
      await call(model, [SYSTEM, user('a', CACHE_MARKER), user('b')]);
      await call(model, [
        SYSTEM,
        user('a'),
        user('b'),
        { ...assistant('c'), providerOptions: CACHE_MARKER },
        user('d'),
      ]);

      const entries = readLogEntries<LlmFullLogEntry>();
      expect(entries[1].promptOffset).toBe(3);
      expect(entries[1]).not.toHaveProperty('reset');
      expect(entries[1].prompt).toHaveLength(2);
    });

    it('resumes deltas after a failed call without logging its messages twice', async () => {
      let fail = true;
      const model = wrap(
        new MockLanguageModelV3({
          doGenerate: async () => {
            if (fail) throw new Error('transient');
            return {
              content: [{ type: 'text' as const, text: 'ok' }],
              finishReason: { unified: 'stop' as const, raw: 'stop' },
              usage: USAGE,
              warnings: [],
            };
          },
        }),
        options,
      );
      const prompt = [SYSTEM, user('hi')];
      await expect(call(model, prompt)).rejects.toThrow('transient');
      fail = false;
      await call(model, prompt);

      const entries = readLogEntries<LlmFullLogEntry>();
      expect(entries).toHaveLength(2);
      expect(entries[0].error?.message).toBe('transient');
      expect(entries[1]).toMatchObject({ promptOffset: 2, prompt: [] });
      expect(reconstructPrompts(entries)[1]).toEqual(prompt);
    });

    it('starts a resumed session with the whole prompt (promptOffset 0)', async () => {
      await call(wrap(createMockModel('ok'), { ...options, appendOnly: true }), [SYSTEM, user('before resume')]);
      await call(wrap(createMockModel('ok'), { ...options, appendOnly: true }), [SYSTEM, user('after resume')]);

      const entries = readLogEntries<LlmFullLogEntry>();
      expect(entries).toHaveLength(2);
      expect(entries[1].promptOffset).toBe(0);
      expect(reconstructPrompts(entries)[1]).toEqual([SYSTEM, user('after resume')]);
    });
  });
});
