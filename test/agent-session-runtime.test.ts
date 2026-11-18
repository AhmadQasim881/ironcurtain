/**
 * Builtin session runtime hygiene under the real AI SDK (`generateText` is
 * not mocked; `MockLanguageModelV3` models stand in for the agent and the
 * compaction summarizer):
 *
 * - each session logs to its own session.log, also with a second session and
 *   a daemon logging in the same process, and closing one session ends
 *   neither the other session's log nor the daemon's;
 * - every step of a turn carries a cache breakpoint on its last message, and
 *   no request carries more than Anthropic's four;
 * - a host-side model without credentials is reported and worked around
 *   (auto-compaction summarizes with the agent's model) instead of failing;
 * - MCP servers the sandbox could not start are reported;
 * - the in-memory turn history is bounded while the turn count keeps
 *   counting.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3Prompt,
  LanguageModelV3Usage,
} from '@ai-sdk/provider';
import * as logger from '../src/logger.js';
import { TEST_SANDBOX_DIR, REAL_TMP } from './fixtures/test-policy.js';

vi.mock('@utcp/code-mode', () => ({
  CodeModeUtcpClient: {
    AGENT_PROMPT_TEMPLATE: 'mock code mode prompt template',
  },
}));

/**
 * Models handed out by the mocked `createLanguageModel`, per host model role,
 * and every request for one. A model of a provider without a configured key
 * cannot be created, as a real one could not be used.
 */
const testModels = vi.hoisted(
  (): { agent: unknown; summary: unknown; requests: Array<{ modelId: string; role: string | undefined }> } => ({
    agent: undefined,
    summary: undefined,
    requests: [],
  }),
);

vi.mock('../src/config/model-provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config/model-provider.js')>();
  return {
    ...actual,
    createLanguageModel: vi.fn(
      async (qualifiedId: string, config: { anthropicApiKey: string; openaiApiKey: string }, role?: string) => {
        testModels.requests.push({ modelId: qualifiedId, role });
        const provider = qualifiedId.split(':')[0];
        if (provider === 'anthropic' && !config.anthropicApiKey) throw new Error('Anthropic API key is missing');
        if (provider === 'openai' && !config.openaiApiKey) throw new Error('OpenAI API key is missing');
        const model = role === 'summary' ? testModels.summary : testModels.agent;
        if (model === undefined) throw new Error(`no test model registered for role ${String(role)}`);
        return model;
      },
    ),
  };
});

import { createSession } from '../src/session/index.js';
import type { Sandbox } from '../src/sandbox/index.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import type { ResolvedUserConfig } from '../src/config/user-config.js';
import { getSessionLogPath } from '../src/config/paths.js';
import { getPackageGeneratedDir } from '../src/config/index.js';
import { isStartupNotice } from '../src/session/startup-notices.js';
import { SESSION_TURN_HISTORY_LIMIT } from '../src/session/bounded-log.js';
import type { DiagnosticEvent, Session } from '../src/session/types.js';

const TEST_HOME = `/tmp/ironcurtain-session-runtime-test-${process.pid}`;

// --- Model scripting ---

function usage(inputTokens: number, outputTokens = 20): LanguageModelV3Usage {
  return {
    inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: outputTokens, text: outputTokens, reasoning: undefined },
  };
}

function toolStep(toolCallId: string, code: string, inputTokens = 100): LanguageModelV3GenerateResult {
  return {
    content: [{ type: 'tool-call', toolCallId, toolName: 'execute_code', input: JSON.stringify({ code }) }],
    finishReason: { unified: 'tool-calls', raw: 'tool_use' },
    usage: usage(inputTokens),
    warnings: [],
  };
}

function textStep(text: string, inputTokens = 100): LanguageModelV3GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'end_turn' },
    usage: usage(inputTokens),
    warnings: [],
  };
}

type ScriptedStep =
  LanguageModelV3GenerateResult | ((options: LanguageModelV3CallOptions) => LanguageModelV3GenerateResult);

function scriptedAgent(script: ScriptedStep[]): MockLanguageModelV3 {
  let next = 0;
  return new MockLanguageModelV3({
    doGenerate: async (options) => {
      const step = script.at(next++);
      if (step === undefined) throw new Error('agent script exhausted');
      return typeof step === 'function' ? step(options) : step;
    },
  });
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: { type: string; text?: string }) => (part.type === 'text' ? (part.text ?? '') : ''))
    .join('');
}

// --- Cache breakpoints ---

function hasCacheControl(providerOptions: unknown): boolean {
  const anthropic = (providerOptions as { anthropic?: { cacheControl?: unknown } } | undefined)?.anthropic;
  return anthropic?.cacheControl !== undefined;
}

/** Messages of a request carrying a cache breakpoint, by index (the message's own or one of its parts'). */
function markedMessages(prompt: LanguageModelV3Prompt): number[] {
  const marked: number[] = [];
  prompt.forEach((message, index) => {
    const parts = Array.isArray(message.content) ? (message.content as Array<{ providerOptions?: unknown }>) : [];
    if (hasCacheControl(message.providerOptions) || parts.some((part) => hasCacheControl(part.providerOptions))) {
      marked.push(index);
    }
  });
  return marked;
}

/** Every cache breakpoint of one request: messages (the system prompt among them) and tool definitions. */
function breakpointCount(options: LanguageModelV3CallOptions): number {
  const tools = (options.tools ?? []) as Array<{ providerOptions?: unknown }>;
  return markedMessages(options.prompt).length + tools.filter((tool) => hasCacheControl(tool.providerOptions)).length;
}

// --- Session setup ---

function createConfig(
  overrides: { userConfig?: Partial<ResolvedUserConfig>; agentModelId?: string } = {},
): IronCurtainConfig {
  const agentModelId = overrides.agentModelId ?? 'anthropic:claude-sonnet-4-6';
  return {
    auditLogPath: './audit.jsonl',
    allowedDirectory: TEST_SANDBOX_DIR,
    mcpServers: { filesystem: { command: 'echo', args: ['test'] } },
    protectedPaths: [],
    generatedDir: `${REAL_TMP}/test-generated`,
    constitutionPath: `${REAL_TMP}/test-constitution.md`,
    agentModelId,
    escalationTimeoutSeconds: 300,
    userConfig: {
      agentModelId,
      policyModelId: 'anthropic:claude-sonnet-4-6',
      anthropicApiKey: 'test-api-key',
      googleApiKey: '',
      openaiApiKey: '',
      escalationTimeoutSeconds: 300,
      resourceBudget: {
        maxTotalTokens: null,
        maxSteps: null,
        maxSessionSeconds: null,
        maxEstimatedCostUsd: null,
        warnThresholdPercent: 80,
      },
      autoCompact: {
        enabled: false,
        thresholdTokens: 1000,
        keepRecentMessages: 10,
        summaryModelId: 'anthropic:claude-haiku-4-5',
      },
      autoApprove: { enabled: false, modelId: 'anthropic:claude-haiku-4-5' },
      auditRedaction: { enabled: true },
      memory: { enabled: false, autoSave: false, llmBaseUrl: undefined, llmApiKey: undefined },
      ...overrides.userConfig,
    },
  } as unknown as IronCurtainConfig;
}

type StubSandbox = Sandbox & { executeCode: ReturnType<typeof vi.fn> };

function createSandbox(
  execute: (code: string) => unknown = (code) => `ran ${code}`,
  extras: Record<string, unknown> = {},
): StubSandbox {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    getToolInterfaces: vi.fn().mockReturnValue('mock tool interfaces'),
    getHelpData: vi.fn().mockReturnValue({
      serverDescriptions: { filesystem: 'Read, write, search, and manage files and directories' },
      toolsByServer: { filesystem: [{ callableName: 'filesystem.read_file', params: '{ path }' }] },
    }),
    executeCode: vi.fn(async (code: string) => ({ result: await execute(code), logs: [] })),
    shutdown: vi.fn().mockResolvedValue(undefined),
    ...extras,
  } as unknown as StubSandbox;
}

interface StartedSession {
  readonly session: Session;
  readonly diagnostics: DiagnosticEvent[];
}

describe('builtin session runtime hygiene', () => {
  let originalHome: string | undefined;
  const open: Session[] = [];

  beforeEach(() => {
    originalHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = TEST_HOME;
    mkdirSync(TEST_HOME, { recursive: true });
    testModels.agent = undefined;
    testModels.summary = undefined;
    testModels.requests.length = 0;
  });

  afterEach(async () => {
    for (const session of open.splice(0)) await session.close().catch(() => {});
    logger.teardown();
    if (originalHome !== undefined) process.env.IRONCURTAIN_HOME = originalHome;
    else delete process.env.IRONCURTAIN_HOME;
    rmSync(TEST_HOME, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function start(config: IronCurtainConfig, sandbox: StubSandbox = createSandbox()): Promise<StartedSession> {
    const diagnostics: DiagnosticEvent[] = [];
    const session = await createSession({
      config,
      sandboxFactory: vi.fn().mockResolvedValue(sandbox),
      onDiagnostic: (event) => diagnostics.push(event),
    });
    open.push(session);
    return { session, diagnostics };
  }

  function sessionLog(session: Session): string {
    const path = getSessionLogPath(session.getInfo().id);
    return existsSync(path) ? readFileSync(path, 'utf-8') : '';
  }

  describe('logging', () => {
    it('two sessions log to their own files and the daemon log continues after one closes', async () => {
      const daemonLogPath = join(TEST_HOME, 'logs', 'daemon.log');
      const daemon = logger.setup({ logFilePath: daemonLogPath, processWide: true });

      // Stateless agent: a step whose prompt ends with the user's message
      // runs code named after it; a step after a tool result answers.
      testModels.agent = new MockLanguageModelV3({
        doGenerate: async (options) => {
          const last = options.prompt.at(-1);
          if (last?.role === 'tool') return textStep('done');
          return toolStep(`call-${Math.random().toString(36).slice(2)}`, `work for ${textOf(last?.content)}`);
        },
      });
      // What the coordinator does during a tool call: log (and console
      // output from a dependency), after other work had a chance to run.
      const sandbox = createSandbox(async (code) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        logger.info(`[policy] decided ${code}`);
        console.log(`[dependency] ran ${code}`);
        return 'ok';
      });

      const a = await start(createConfig(), sandbox);
      const b = await start(createConfig(), sandbox);
      await Promise.all([a.session.sendMessage('A1'), b.session.sendMessage('B1')]);
      logger.info('[daemon] while both are open');

      await a.session.close();
      logger.info('[daemon] after A closed');
      await b.session.sendMessage('B2');
      await b.session.close();
      logger.info('[daemon] after B closed');

      const logA = sessionLog(a.session);
      const logB = sessionLog(b.session);
      const daemonLog = readFileSync(daemonLogPath, 'utf-8');
      expect(logA).toContain(`Session ${a.session.getInfo().id} created`);
      expect(logA).toContain('[policy] decided work for A1');
      expect(logA).toContain('[console.log] [dependency] ran work for A1');
      expect(logA).not.toMatch(/work for B|\[daemon\]/);
      expect(logB).toContain(`Session ${b.session.getInfo().id} created`);
      expect(logB).toContain('[policy] decided work for B1');
      expect(logB).toContain('[policy] decided work for B2');
      expect(logB).not.toMatch(/work for A|\[daemon\]/);
      expect(daemonLog).toContain('[daemon] while both are open');
      expect(daemonLog).toContain('[daemon] after A closed');
      expect(daemonLog).toContain('[daemon] after B closed');
      expect(daemonLog).not.toMatch(/work for [AB]|Session .* created/);
      // Each session gave back only its own claim.
      expect(logger.isActive()).toBe(true);
      logger.release(daemon);
      expect(logger.isActive()).toBe(false);
    });
  });

  describe('prompt caching', () => {
    it('moves a cache breakpoint to the last message of every step, never more than four in all', async () => {
      const agent = scriptedAgent([
        toolStep('call-1', 'step one'),
        toolStep('call-2', 'step two'),
        textStep('first done'),
        toolStep('call-3', 'step three'),
        textStep('second done'),
      ]);
      testModels.agent = agent;
      const { session } = await start(createConfig());

      await expect(session.sendMessage('first task')).resolves.toBe('first done');
      await expect(session.sendMessage('second task')).resolves.toBe('second done');

      expect(agent.doGenerateCalls).toHaveLength(5);
      for (const call of agent.doGenerateCalls) {
        expect(breakpointCount(call)).toBeLessThanOrEqual(4);
        // The step's tail: the user message on a turn's first step, the
        // newest tool result after that.
        expect(markedMessages(call.prompt)).toContain(call.prompt.length - 1);
      }
      // Turn 1, step 3: system prompt, tool definitions and the step's tail
      // (the history has no earlier turn yet).
      const turn1Step3 = agent.doGenerateCalls[2];
      expect(turn1Step3.prompt.at(-1)?.role).toBe('tool');
      expect(markedMessages(turn1Step3.prompt)).toEqual([0, turn1Step3.prompt.length - 1]);
      // Turn 2, step 2: system, tools, the history before the new user
      // message, and the step's tail -- four.
      const turn2Step2 = agent.doGenerateCalls[4];
      const userIndex = turn2Step2.prompt.map((message) => message.role).lastIndexOf('user');
      expect(textOf(turn2Step2.prompt[userIndex].content)).toBe('second task');
      expect(markedMessages(turn2Step2.prompt)).toEqual([0, userIndex - 1, turn2Step2.prompt.length - 1]);
      expect(breakpointCount(turn2Step2)).toBe(4);
    });

    it('adds no breakpoints for a provider that caches on its own', async () => {
      const agent = scriptedAgent([toolStep('call-1', 'step one'), textStep('done')]);
      testModels.agent = agent;
      const { session } = await start(
        createConfig({ agentModelId: 'openai:gpt-4o', userConfig: { openaiApiKey: 'sk-openai-test' } }),
      );

      await session.sendMessage('task');
      for (const call of agent.doGenerateCalls) expect(breakpointCount(call)).toBe(0);
    });
  });

  describe('host-model credentials', () => {
    it('an OpenAI-only user with autoCompact gets a warning and compaction runs on the agent model', async () => {
      // The default summary model is Anthropic's; without an Anthropic key
      // every compaction used to fail, so the history only grew.
      const agent = scriptedAgent([
        toolStep('call-1', 'step one', 5000),
        toolStep('call-2', 'step two', 5000),
        toolStep('call-3', 'step three', 5000),
        textStep('first done', 5000),
        textStep('second done', 300),
      ]);
      testModels.agent = agent;
      testModels.summary = new MockLanguageModelV3({ doGenerate: async () => textStep('Summary of the first task.') });
      const config = createConfig({
        agentModelId: 'openai:gpt-4o',
        userConfig: {
          anthropicApiKey: '',
          openaiApiKey: 'sk-openai-test',
          autoCompact: {
            enabled: true,
            thresholdTokens: 1000,
            keepRecentMessages: 2,
            summaryModelId: 'anthropic:claude-haiku-4-5',
          },
        },
      });
      const { session, diagnostics } = await start(config);

      expect(diagnostics.filter((event) => event.kind === 'host_model_fallback')).toEqual([
        {
          kind: 'host_model_fallback',
          role: 'summary',
          action: 'agent_model',
          message: expect.stringMatching(/summary model "anthropic:claude-haiku-4-5" has no credentials/),
        },
      ]);
      expect(sessionLog(session)).toContain('[host-model] Auto-compaction');

      await expect(session.sendMessage('first task')).resolves.toBe('first done');
      await expect(session.sendMessage('second task')).resolves.toBe('second done');

      expect(testModels.requests.filter((request) => request.role === 'summary')).toEqual([
        { modelId: 'openai:gpt-4o', role: 'summary' },
      ]);
      expect(diagnostics.some((event) => event.kind === 'message_compaction')).toBe(true);
      expect(diagnostics.some((event) => event.kind === 'message_compaction_failed')).toBe(false);
      // The caller's configuration is left as it was.
      expect(config.userConfig.autoCompact.summaryModelId).toBe('anthropic:claude-haiku-4-5');
    });
  });

  describe('start-up notices', () => {
    it('reports the MCP servers the sandbox could not start', async () => {
      testModels.agent = scriptedAgent([]);
      const sandbox = createSandbox(undefined, {
        getUnavailableServers: () => [{ serverName: 'github', reason: 'relay exited before the handshake' }],
      });
      const { diagnostics } = await start(createConfig(), sandbox);

      expect(diagnostics).toContainEqual({
        kind: 'mcp_server_unavailable',
        serverName: 'github',
        reason: 'relay exited before the handshake',
      });
    });

    it('reports a policy without provenance as a start-up notice, not on stderr, under onStale "warn"', async () => {
      // After an upgrade every user, persona and job policy is stale. The
      // warning used to reach only stderr (garbled under the CLI's spinner,
      // never seen by web or Signal users) and the session log.
      const generatedDir = join(TEST_HOME, 'generated');
      mkdirSync(generatedDir, { recursive: true });
      const shipped = JSON.parse(
        readFileSync(join(getPackageGeneratedDir(), 'compiled-policy.json'), 'utf-8'),
      ) as Record<string, unknown>;
      delete shipped.provenance;
      writeFileSync(join(generatedDir, 'compiled-policy.json'), JSON.stringify(shipped));
      const stderr: string[] = [];
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
        stderr.push(String(chunk));
        return true;
      });
      testModels.agent = scriptedAgent([]);

      const config = { ...createConfig(), generatedDir };
      const { session, diagnostics } = await start(config);

      const notices = diagnostics.filter((event) => event.kind === 'policy_stale');
      expect(notices).toHaveLength(1);
      const [notice] = notices;
      expect(notice.message).toContain(join(generatedDir, 'compiled-policy.json'));
      expect(notice.message).toContain('records no provenance');
      expect(notice.message).toContain('ironcurtain compile-policy');
      expect(isStartupNotice(notice)).toBe(true);
      // The transport shows it; nothing is written under a running spinner.
      expect(stderr.join('')).not.toContain('may be stale');
      // The session log and the diagnostic log keep it.
      expect(sessionLog(session)).toContain('records no provenance');
      expect(session.getDiagnosticLog()).toContainEqual(notice);
    });
  });

  describe('turn history', () => {
    it('keeps the newest turns in memory while turnCount and turn numbers keep counting', async () => {
      const turns = SESSION_TURN_HISTORY_LIMIT + 5;
      testModels.agent = new MockLanguageModelV3({ doGenerate: async () => textStep('ok') });
      const { session } = await start(createConfig());

      for (let turn = 1; turn <= turns; turn++) await session.sendMessage(`message ${turn}`);

      const history = session.getHistory();
      expect(history).toHaveLength(SESSION_TURN_HISTORY_LIMIT);
      expect(history[0].turnNumber).toBe(6);
      expect(history[0].userMessage).toBe('message 6');
      expect(history.at(-1)?.turnNumber).toBe(turns);
      expect(session.getInfo().turnCount).toBe(turns);
    });
  });
});
