/**
 * The builtin agent's llm-interactions.jsonl through the real AI SDK loop.
 *
 * Unlike test/session.test.ts (which mocks generateText), these tests drive
 * AgentSession with the real generateText, the real MessageCompactor and the
 * real Anthropic prompt-cache strategy, so the log sees the prompts a session
 * actually sends: a history breakpoint that moves every turn, a history that
 * compaction replaces with a summary, and a turn that fails and is rolled
 * back.
 *
 * Full detail collects the host's credential stores for redaction, so HOME
 * and the related config locations point at a fresh temporary directory.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3 } from '@ai-sdk/provider';

const mocks = vi.hoisted((): { agent: unknown; summary: unknown } => ({ agent: undefined, summary: undefined }));

vi.mock('../src/config/model-provider.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config/model-provider.js')>()),
  createLanguageModel: vi.fn(async (_modelId: string, _config: unknown, role?: string) =>
    role === 'summary' ? mocks.summary : mocks.agent,
  ),
}));

vi.mock('@utcp/code-mode', () => ({
  CodeModeUtcpClient: { AGENT_PROMPT_TEMPLATE: 'mock code mode prompt template' },
}));

import * as logger from '../src/logger.js';
import { createSession } from '../src/session/index.js';
import { BaseTransport } from '../src/session/base-transport.js';
import { getSessionInteractionLogPath, getSessionLlmLogPath } from '../src/config/paths.js';
import type { LlmInteractionLogMode, ResolvedUserConfig } from '../src/config/user-config.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import type { LlmFullLogEntry, LlmLogEntry, LlmMetadataLogEntry } from '../src/observability/llm-logger.js';
import type { Sandbox } from '../src/sandbox/index.js';
import type { Session } from '../src/session/types.js';
import { TEST_SANDBOX_DIR, REAL_TMP } from './fixtures/test-policy.js';
import { testUserConfig } from './helpers/user-config.js';

const PLANTED_KEY = 'sk-ant-api03-' + 'PlantedInAUserMessage0123456789';

/** Answers every call with `answer <n>`, reporting `inputTokens(n)` input tokens; `fail(n)` makes call n throw. */
function agentModel(inputTokens: (call: number) => number, fail: (call: number) => boolean = () => false) {
  let calls = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      calls++;
      if (fail(calls)) throw new Error(`provider failure on call ${calls}`);
      return {
        content: [{ type: 'text' as const, text: `answer ${calls}` }],
        finishReason: { unified: 'stop' as const, raw: 'end_turn' },
        usage: {
          inputTokens: { total: inputTokens(calls), noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 10, text: undefined, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
}

function summaryModel(): LanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: 'SUMMARY-OF-EARLIER-TURNS' }],
      finishReason: { unified: 'stop' as const, raw: 'end_turn' },
      usage: {
        inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: undefined, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}

function createTestConfig(
  mode: LlmInteractionLogMode | undefined,
  userConfigOverrides: Partial<ResolvedUserConfig> = {},
): IronCurtainConfig {
  return {
    auditLogPath: './audit.jsonl',
    allowedDirectory: TEST_SANDBOX_DIR,
    mcpServers: { filesystem: { command: 'echo', args: ['test'] } },
    protectedPaths: [],
    generatedDir: `${REAL_TMP}/test-generated`,
    constitutionPath: `${REAL_TMP}/test-constitution.md`,
    agentModelId: 'anthropic:claude-sonnet-4-6',
    escalationTimeoutSeconds: 300,
    userConfig: testUserConfig({
      anthropicApiKey: 'test-api-key',
      resourceBudget: {
        maxTotalTokens: null,
        maxSteps: 200,
        maxSessionSeconds: null,
        maxEstimatedCostUsd: null,
        warnThresholdPercent: 80,
      },
      autoCompact: {
        enabled: true,
        thresholdTokens: 1_000,
        keepRecentMessages: 2,
        summaryModelId: 'anthropic:claude-haiku-4-5',
      },
      // Without a mode the config carries no log settings, like a config an
      // embedder builds by hand: the session falls back to the default mode.
      observability: mode === undefined ? undefined : { llmInteractionLog: mode },
      ...userConfigOverrides,
    }),
  };
}

function createMockSandbox(): Sandbox {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    getToolInterfaces: vi.fn().mockReturnValue('mock tool interfaces'),
    getHelpData: vi.fn().mockReturnValue({
      serverDescriptions: { filesystem: 'Read, write, search, and manage files and directories' },
      toolsByServer: { filesystem: [{ callableName: 'filesystem.read_file', params: '{ path }' }] },
    }),
    executeCode: vi.fn(async () => ({ result: 'ok', logs: [] })),
    shutdown: vi.fn().mockResolvedValue(undefined),
  } as unknown as Sandbox;
}

async function startSession(
  mode: LlmInteractionLogMode | undefined,
  model: MockLanguageModelV3,
  userConfigOverrides: Partial<ResolvedUserConfig> = {},
): Promise<Session> {
  mocks.agent = model;
  mocks.summary = summaryModel();
  return createSession({
    config: createTestConfig(mode, userConfigOverrides),
    sandboxFactory: vi.fn().mockResolvedValue(createMockSandbox()),
  });
}

/**
 * Every turn takes two steps: the first thinks (a reasoning part with a
 * provider signature) and calls execute_code, the second answers.
 */
function toolTurnModel(): MockLanguageModelV3 {
  let calls = 0;
  const usage = {
    inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 10, text: undefined, reasoning: undefined },
  };
  return new MockLanguageModelV3({
    doGenerate: async () => {
      calls++;
      if (calls % 2 === 1) {
        return {
          content: [
            {
              type: 'reasoning' as const,
              text: `thinking ${calls}`,
              providerMetadata: { anthropic: { signature: `signature-${calls}` } },
            },
            {
              type: 'tool-call' as const,
              toolCallId: `call-${calls}`,
              toolName: 'execute_code',
              input: JSON.stringify({ code: `return ${calls}` }),
            },
          ],
          finishReason: { unified: 'tool-calls' as const, raw: 'tool_use' },
          usage,
          warnings: [],
        };
      }
      return {
        content: [{ type: 'text' as const, text: `answer ${calls}` }],
        finishReason: { unified: 'stop' as const, raw: 'end_turn' },
        usage,
        warnings: [],
      };
    },
  });
}

/** Runs `messages` through a BaseTransport (which writes interactions.jsonl) and returns the raw transcript. */
async function runTranscript(session: Session, messages: readonly string[]): Promise<string> {
  class ScriptedTransport extends BaseTransport {
    protected async runSession(s: Session): Promise<void> {
      for (const message of messages) await this.sendAndLog(s, message);
    }
    close(): void {}
  }
  await new ScriptedTransport().run(session);
  return readFileSync(getSessionInteractionLogPath(session.getInfo().id), 'utf-8');
}

function readEntries<T extends LlmLogEntry>(session: Session): T[] {
  return readFileSync(getSessionLlmLogPath(session.getInfo().id), 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as T);
}

/** The documented rule: offset 0 starts a transcript, later entries extend it. */
function reconstruct(entries: LlmFullLogEntry[]): unknown[][] {
  const prompts: unknown[][] = [];
  let current: unknown[] = [];
  for (const entry of entries) {
    const items = entry.prompt as unknown[];
    current = entry.promptOffset === 0 ? [...items] : [...current, ...items];
    prompts.push(current);
  }
  return prompts;
}

/** The text of the user messages in a logged prompt, in order. */
function userTexts(prompt: unknown[]): string[] {
  return prompt
    .filter((m): m is { role: 'user'; content: { text: string }[] } => (m as { role?: string }).role === 'user')
    .map((m) => m.content.map((part) => part.text).join(''));
}

describe('AgentSession LLM interaction log (real generateText loop)', () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.IRONCURTAIN_HOME;
    home = mkdtempSync(join(tmpdir(), 'ironcurtain-llm-log-'));
    process.env.IRONCURTAIN_HOME = home;
    vi.stubEnv('HOME', home);
    vi.stubEnv('ANTHROPIC_CONFIG_DIR', join(home, 'anthropic'));
    vi.stubEnv('XDG_CONFIG_HOME', join(home, 'xdg'));
    vi.stubEnv('CODEX_HOME', join(home, 'codex'));
  });

  afterEach(() => {
    logger.teardown();
    vi.unstubAllEnvs();
    if (originalHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('keeps logging deltas while the cache breakpoint moves, and starts over after compaction', async () => {
    // Turn 3 reports enough input tokens that turn 4 compacts first.
    const session = await startSession(
      'full',
      agentModel((call) => (call === 3 ? 5_000 : 100)),
    );
    try {
      for (const message of ['turn one', 'turn two', 'turn three', `turn four ${PLANTED_KEY}`]) {
        await session.sendMessage(message);
      }

      const entries = readEntries<LlmFullLogEntry>(session);
      expect(entries).toHaveLength(4);
      // Turns 2 and 3 extend the logged prompt even though the Anthropic
      // breakpoint moved to a different message each turn.
      expect(entries.map((e) => [e.promptOffset, e.reset ?? false])).toEqual([
        [0, false],
        [2, false],
        [4, false],
        [0, true],
      ]);

      const prompts = reconstruct(entries);
      expect(userTexts(prompts[2])).toEqual(['turn one', 'turn two', 'turn three']);
      // After compaction: system, the summary, the kept assistant answer and the new message.
      expect(prompts[3]).toHaveLength(4);
      const [summary, newMessage] = userTexts(prompts[3]);
      expect(summary).toContain('SUMMARY-OF-EARLIER-TURNS');
      expect(newMessage).toBe('turn four sk-a...6789');
      expect(readFileSync(getSessionLlmLogPath(session.getInfo().id), 'utf-8')).not.toContain(PLANTED_KEY);
    } finally {
      await session.close();
    }
  });

  it('logs a failed turn and starts over once the rolled-back history diverges', async () => {
    const session = await startSession(
      'full',
      agentModel(
        () => 100,
        (call) => call === 2,
      ),
    );
    try {
      await session.sendMessage('first');
      await expect(session.sendMessage('this one fails')).rejects.toThrow('provider failure on call 2');
      await session.sendMessage('retry differently');

      const entries = readEntries<LlmFullLogEntry>(session);
      expect(entries).toHaveLength(3);
      expect(entries[1]).toMatchObject({ promptOffset: 2, error: { name: 'Error' } });
      expect(entries[1].error?.message).toBe('provider failure on call 2');
      expect(entries[2]).toMatchObject({ promptOffset: 0, reset: true });
      expect(userTexts(reconstruct(entries)[2])).toEqual(['first', 'retry differently']);
    } finally {
      await session.close();
    }
  });

  it('records metadata only by default', async () => {
    const session = await startSession(
      undefined,
      agentModel(
        () => 100,
        (call) => call === 2,
      ),
    );
    try {
      await session.sendMessage(`secret plans ${PLANTED_KEY}`);
      await expect(session.sendMessage('doomed')).rejects.toThrow();

      const raw = readFileSync(getSessionLlmLogPath(session.getInfo().id), 'utf-8');
      for (const text of ['secret plans', 'doomed', 'answer 1', 'sk-ant', 'mock code mode prompt template']) {
        expect(raw).not.toContain(text);
      }
      const entries = readEntries<LlmMetadataLogEntry>(session);
      expect(entries).toMatchObject([
        { detail: 'metadata', stepName: 'agent', promptMessages: 2, responseChars: 'answer 1'.length },
        { detail: 'metadata', promptMessages: 4, error: { name: 'Error' } },
      ]);
    } finally {
      await session.close();
    }
  });

  it('keeps logging deltas through multi-step tool turns (reasoning, tool call, tool result)', async () => {
    const session = await startSession('full', toolTurnModel());
    try {
      await session.sendMessage('first task');
      await session.sendMessage('second task');

      const entries = readEntries<LlmFullLogEntry>(session);
      // Two steps per turn; every step extends the prompt the previous one logged.
      expect(entries.map((e) => [e.promptOffset, e.reset ?? false])).toEqual([
        [0, false],
        [2, false],
        [4, false],
        [6, false],
      ]);
      const last = reconstruct(entries)[3] as { role: string }[];
      expect(last.map((m) => m.role)).toEqual([
        'system',
        'user',
        'assistant',
        'tool',
        'assistant',
        'user',
        'assistant',
        'tool',
      ]);
      expect(userTexts(last)).toEqual(['first task', 'second task']);
    } finally {
      await session.close();
    }
  });

  describe("interactions.jsonl written for the session's turns", () => {
    // Not an API-key pattern: only the session's exact-value redaction catches it.
    const CONFIGURED_KEY = 'corp-gateway-key-' + '0123456789abcdef';

    it('masks the credentials configured for the session', async () => {
      const session = await startSession(
        'off',
        agentModel(() => 100),
        { anthropicApiKey: CONFIGURED_KEY },
      );
      try {
        const raw = await runTranscript(session, [`deploy with ${CONFIGURED_KEY}`]);
        expect(raw).not.toContain(CONFIGURED_KEY);
        expect(raw).toContain('deploy with ***REDACTED***');
      } finally {
        await session.close();
      }
    });

    it('stays verbatim, key patterns included, when audit redaction is turned off', async () => {
      const session = await startSession(
        'off',
        agentModel(() => 100),
        {
          anthropicApiKey: CONFIGURED_KEY,
          auditRedaction: { enabled: false },
        },
      );
      try {
        const message = `deploy with ${CONFIGURED_KEY} and ${PLANTED_KEY}`;
        expect(await runTranscript(session, [message])).toContain(message);
      } finally {
        await session.close();
      }
    });
  });
});
