/**
 * Builtin-agent budget enforcement through the real AI SDK loop.
 *
 * Unlike test/session.test.ts (which mocks generateText), these tests drive
 * AgentSession with the real generateText and a MockLanguageModelV3, so they
 * exercise the SDK's actual callback order: onStepFinish fires for every step,
 * stop conditions only run after steps that called tools, and the loop ends
 * with a tool-call step when a stop condition fires.
 *
 * The same loop also covers how a turn ends early (WP-55): close() mid-turn
 * aborts it and makes no further model call, and what execute_code hands the
 * model is bounded (console and result under one budget).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3, LanguageModelV3Content } from '@ai-sdk/provider';

const mocks = vi.hoisted((): { model: unknown } => ({ model: undefined }));

vi.mock('../src/config/model-provider.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config/model-provider.js')>()),
  createLanguageModel: vi.fn(async () => mocks.model),
}));

vi.mock('@utcp/code-mode', () => ({
  CodeModeUtcpClient: { AGENT_PROMPT_TEMPLATE: 'mock code mode prompt template' },
}));

import * as logger from '../src/logger.js';
import { createSession, BudgetExhaustedError, SessionClosedError } from '../src/session/index.js';
import { STEP_SAFETY_CAP } from '../src/session/resource-budget-tracker.js';
import type { ResolvedResourceBudgetConfig } from '../src/config/user-config.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import type { ExecuteCodeOptions, Sandbox } from '../src/sandbox/index.js';
import type { DiagnosticEvent, Session } from '../src/session/types.js';
import { TEST_SANDBOX_DIR, REAL_TMP } from './fixtures/test-policy.js';
import { testUserConfig } from './helpers/user-config.js';

// --- Mock model ---

interface StepUsage {
  readonly input: number;
  readonly output: number;
}

interface ScriptedStep {
  /** Tool call to make; omit for a final text answer. */
  readonly toolCall?: boolean;
  readonly text?: string;
  readonly usage: StepUsage;
}

function generateResult(step: ScriptedStep, index: number): Awaited<ReturnType<LanguageModelV3['doGenerate']>> {
  const content: LanguageModelV3Content[] = [];
  if (step.text) content.push({ type: 'text', text: step.text });
  if (step.toolCall) {
    content.push({
      type: 'tool-call',
      toolCallId: `call-${index}`,
      toolName: 'execute_code',
      // Distinct code per step so the loop detector never blocks the tool.
      input: JSON.stringify({ code: `return ${index};` }),
    });
  }
  return {
    content,
    finishReason: step.toolCall ? { unified: 'tool-calls', raw: 'tool_use' } : { unified: 'stop', raw: 'end_turn' },
    usage: {
      inputTokens: { total: step.usage.input, noCache: step.usage.input, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: step.usage.output, text: step.usage.output, reasoning: undefined },
    },
    warnings: [],
    request: {},
    response: { id: `response-${index}`, modelId: 'mock-model', timestamp: new Date(0) },
  };
}

/** A model that plays `steps` in order, then repeats the last one forever. */
function scriptedModel(steps: readonly ScriptedStep[]): MockLanguageModelV3 {
  let calls = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      const step = steps[Math.min(calls, steps.length - 1)];
      calls++;
      return generateResult(step, calls);
    },
  });
}

/** A model that calls execute_code on every step and never answers. */
function toolLoopModel(usage: StepUsage = { input: 1_000, output: 100 }): MockLanguageModelV3 {
  return scriptedModel([{ toolCall: true, usage }]);
}

// --- Session setup ---

function createTestConfig(budget: Partial<ResolvedResourceBudgetConfig>, agentModelId: string): IronCurtainConfig {
  return {
    auditLogPath: './audit.jsonl',
    allowedDirectory: TEST_SANDBOX_DIR,
    mcpServers: { filesystem: { command: 'echo', args: ['test'] } },
    protectedPaths: [],
    generatedDir: `${REAL_TMP}/test-generated`,
    constitutionPath: `${REAL_TMP}/test-constitution.md`,
    agentModelId,
    escalationTimeoutSeconds: 300,
    userConfig: testUserConfig({
      agentModelId,
      anthropicApiKey: 'test-api-key',
      resourceBudget: {
        maxTotalTokens: null,
        maxSteps: 200,
        maxSessionSeconds: null,
        maxEstimatedCostUsd: null,
        warnThresholdPercent: 80,
        ...budget,
      },
    }),
  };
}

type MockExecuteCode = (code: string, options?: ExecuteCodeOptions) => Promise<{ result: unknown; logs: string[] }>;

function createMockSandbox(executeCode?: MockExecuteCode): Sandbox {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    getToolInterfaces: vi.fn().mockReturnValue('mock tool interfaces'),
    getHelpData: vi.fn().mockReturnValue({
      serverDescriptions: { filesystem: 'Read, write, search, and manage files and directories' },
      toolsByServer: { filesystem: [{ callableName: 'filesystem.read_file', params: '{ path }' }] },
    }),
    executeCode: vi.fn(executeCode ?? (async () => ({ result: 'ok', logs: [] }))),
    shutdown: vi.fn().mockResolvedValue(undefined),
  } as unknown as Sandbox;
}

interface SessionUnderTest {
  readonly session: Session;
  readonly diagnostics: DiagnosticEvent[];
}

async function startSession(options: {
  readonly model: MockLanguageModelV3;
  readonly budget?: Partial<ResolvedResourceBudgetConfig>;
  readonly agentModelId?: string;
  readonly sandbox?: Sandbox;
}): Promise<SessionUnderTest> {
  mocks.model = options.model;
  const diagnostics: DiagnosticEvent[] = [];
  const sandbox = options.sandbox ?? createMockSandbox();
  const session = await createSession({
    config: createTestConfig(options.budget ?? {}, options.agentModelId ?? 'anthropic:claude-sonnet-4-6'),
    sandboxFactory: vi.fn().mockResolvedValue(sandbox),
    onDiagnostic: (event) => diagnostics.push(event),
  });
  return { session, diagnostics };
}

/** claude-sonnet-4-6 list price for uncached input and output tokens. */
function sonnetCost(input: number, output: number): number {
  return (input * 3 + output * 15) / 1_000_000;
}

// --- Tests ---

describe('AgentSession budget accounting (real generateText loop)', () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.IRONCURTAIN_HOME;
    home = mkdtempSync(join(tmpdir(), 'ironcurtain-budget-'));
    process.env.IRONCURTAIN_HOME = home;
  });

  afterEach(() => {
    logger.teardown();
    if (originalHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('records both steps of a two-step turn, including the final text step', async () => {
    const model = scriptedModel([
      { toolCall: true, usage: { input: 1_000, output: 100 } },
      { text: 'All done.', usage: { input: 2_000, output: 50 } },
    ]);
    const { session } = await startSession({ model });
    try {
      await expect(session.sendMessage('do the thing')).resolves.toBe('All done.');
      expect(model.doGenerateCalls).toHaveLength(2);

      const status = session.getBudgetStatus();
      // Per-turn fields are reset between turns; the turn lives on in lastTurn and cumulative.
      expect(status.stepCount).toBe(0);
      expect(status.lastTurn).toMatchObject({ stepCount: 2, totalInputTokens: 3_000, totalOutputTokens: 150 });
      expect(status.cumulative).toMatchObject({ stepCount: 2, totalTokens: 3_150 });
      expect(status.cumulative.estimatedCostUsd).toBeCloseTo(sonnetCost(3_000, 150), 12);
      expect(status.lastTurn?.estimatedCostUsd).toBeCloseTo(sonnetCost(3_000, 150), 12);
    } finally {
      await session.close();
    }
  });

  it('records a single-step turn (the final step used to be dropped entirely)', async () => {
    const { session } = await startSession({
      model: scriptedModel([{ text: 'Hi!', usage: { input: 5_000, output: 10 } }]),
    });
    try {
      await session.sendMessage('hello');
      const { cumulative } = session.getBudgetStatus();
      expect(cumulative.stepCount).toBe(1);
      expect(cumulative.totalTokens).toBe(5_010);
      expect(cumulative.estimatedCostUsd).toBeGreaterThan(0);
    } finally {
      await session.close();
    }
  });

  it('honours maxSteps 300 (no hidden 100-step cap) and ends with an explicit stop', async () => {
    const model = toolLoopModel({ input: 10, output: 1 });
    const { session, diagnostics } = await startSession({ model, budget: { maxSteps: 300 } });
    try {
      const error = await session.sendMessage('loop forever').catch((err: unknown) => err);
      expect(error).toBeInstanceOf(BudgetExhaustedError);
      expect((error as BudgetExhaustedError).dimension).toBe('steps');
      expect((error as BudgetExhaustedError).message).toBe(
        'Step budget exhausted: 300 / 300 steps used. Stopped after 300 steps without a final answer.',
      );
      expect(model.doGenerateCalls).toHaveLength(300);
      expect(session.getBudgetStatus().cumulative.stepCount).toBe(300);

      // The turn is kept (its tool calls ran) and carries the explicit message.
      const history = session.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0].assistantResponse).toBe((error as BudgetExhaustedError).message);
      expect(diagnostics).toContainEqual({
        kind: 'budget_exhausted',
        dimension: 'steps',
        message: (error as BudgetExhaustedError).message,
      });
      // The step warning (80% of 300) can fire now that 240 steps are reachable.
      expect(diagnostics.some((event) => event.kind === 'budget_warning' && event.dimension === 'steps')).toBe(true);

      // The session stays usable; the next turn gets a fresh per-turn budget.
      model.doGenerate = async () => generateResult({ text: 'recovered', usage: { input: 10, output: 1 } }, 301);
      await expect(session.sendMessage('try again')).resolves.toBe('recovered');
    } finally {
      await session.close();
    }
  });

  it('returns an explicit message when the safety step cap stops a turn with maxSteps disabled', async () => {
    const model = toolLoopModel({ input: 1, output: 1 });
    const { session, diagnostics } = await startSession({ model, budget: { maxSteps: null } });
    try {
      const response = await session.sendMessage('loop forever');
      expect(response).toBe(
        `Stopped after ${STEP_SAFETY_CAP} steps without a final answer: the per-turn step cap of ${STEP_SAFETY_CAP} ` +
          'was reached (resourceBudget.maxSteps is disabled, so the safety cap applies).',
      );
      expect(model.doGenerateCalls).toHaveLength(STEP_SAFETY_CAP);
      expect(diagnostics).toContainEqual({ kind: 'budget_exhausted', dimension: 'steps', message: response });
      expect(session.getHistory()[0].assistantResponse).toBe(response);
    } finally {
      await session.close();
    }
  }, 60_000);

  it('ends a token-exhausted turn with BudgetExhaustedError (not a silent success)', async () => {
    const model = toolLoopModel({ input: 1_000, output: 100 });
    const { session } = await startSession({ model, budget: { maxTotalTokens: 2_500 } });
    try {
      const error = await session.sendMessage('spend tokens').catch((err: unknown) => err);
      expect(error).toBeInstanceOf(BudgetExhaustedError);
      expect((error as BudgetExhaustedError).dimension).toBe('tokens');
      expect((error as BudgetExhaustedError).message).toMatch(/Stopped after 3 steps without a final answer\.$/);
      expect(model.doGenerateCalls).toHaveLength(3);
      expect(session.getInfo().status).toBe('ready');
    } finally {
      await session.close();
    }
  });

  it('ends a cost-exhausted turn with BudgetExhaustedError', async () => {
    // Each step costs $0.30 + $0.15 = $0.45 at Sonnet 4.6 prices.
    const model = toolLoopModel({ input: 100_000, output: 10_000 });
    const { session } = await startSession({ model, budget: { maxEstimatedCostUsd: 1 } });
    try {
      const error = await session.sendMessage('spend money').catch((err: unknown) => err);
      expect(error).toBeInstanceOf(BudgetExhaustedError);
      expect((error as BudgetExhaustedError).dimension).toBe('cost');
      expect(model.doGenerateCalls).toHaveLength(3);
      expect(session.getBudgetStatus().cumulative.estimatedCostUsd).toBeCloseTo(1.35, 9);
    } finally {
      await session.close();
    }
  });

  it('ends the turn with BudgetExhaustedError when the wall clock runs out during tool execution', async () => {
    const model = toolLoopModel();
    const sandbox = createMockSandbox(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      return { result: 'slow', logs: [] };
    });
    const { session, diagnostics } = await startSession({ model, sandbox, budget: { maxSessionSeconds: 0.3 } });
    try {
      const error = await session.sendMessage('run something slow').catch((err: unknown) => err);
      expect(error).toBeInstanceOf(BudgetExhaustedError);
      expect((error as BudgetExhaustedError).dimension).toBe('wall_clock');
      // The model is not called again after the slow tool.
      expect(model.doGenerateCalls).toHaveLength(1);
      expect(diagnostics.some((event) => event.kind === 'budget_exhausted' && event.dimension === 'wall_clock')).toBe(
        true,
      );
    } finally {
      await session.close();
    }
  });

  it('returns the answer when only the final text step crosses a limit (nothing was cut short)', async () => {
    const { session, diagnostics } = await startSession({
      model: scriptedModel([{ text: 'Complete answer.', usage: { input: 5_000, output: 10 } }]),
      budget: { maxTotalTokens: 1_000 },
    });
    try {
      await expect(session.sendMessage('hello')).resolves.toBe('Complete answer.');
      expect(diagnostics.some((event) => event.kind === 'budget_exhausted')).toBe(false);
      expect(session.getBudgetStatus().cumulative.totalTokens).toBe(5_010);
    } finally {
      await session.close();
    }
  });

  it('prices an unknown Claude model at the highest tier and surfaces the warning once per session', async () => {
    const model = scriptedModel([{ text: 'ok', usage: { input: 1_000_000, output: 0 } }]);
    const { session, diagnostics } = await startSession({ model, agentModelId: 'anthropic:claude-opus-9' });
    try {
      await session.sendMessage('one');
      await session.sendMessage('two');
      const warnings = diagnostics.filter(
        (event) => event.kind === 'budget_warning' && event.message.includes('No list price is known'),
      );
      expect(warnings).toHaveLength(1);
      // 2 x 1M input tokens at $10/M.
      expect(session.getBudgetStatus().cumulative.estimatedCostUsd).toBeCloseTo(20, 9);
    } finally {
      await session.close();
    }
  });

  it('charges a prompt past Sonnet 4.6’s unlisted long-context threshold twice the listed rates, noted once', async () => {
    // 250K prompt tokens: past the 200K tokens above which Sonnet 4.6 bills its 1M-context price.
    const model = scriptedModel([{ text: 'ok', usage: { input: 250_000, output: 1_000 } }]);
    const { session, diagnostics } = await startSession({ model });
    try {
      await session.sendMessage('one');
      await session.sendMessage('two');
      const notices = diagnostics.filter(
        (event) => event.kind === 'budget_warning' && event.message.includes('long-context prices'),
      );
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ dimension: 'cost', percentUsed: 0 });
      expect(session.getBudgetStatus().cumulative.estimatedCostUsd).toBeCloseTo(2 * 2 * sonnetCost(250_000, 1_000), 9);
    } finally {
      await session.close();
    }
  });
});

// --- The auto-compaction summarizer's usage (FU-15) ---

/** The closing request of the summarizer's (text-only) prompt. */
const SUMMARY_TRIGGER = 'Summarize the conversation above';

/** claude-haiku-4-5 (the default summary model) list price for uncached input and output tokens. */
function haikuCost(input: number, output: number): number {
  return (input * 1 + output * 5) / 1_000_000;
}

interface CompactingModel {
  readonly model: MockLanguageModelV3;
  /** Called at the start of every agent model call, with its 1-based index. */
  onAgentCall?: (call: number) => void;
}

/**
 * One model for the agent and the summarizer (createLanguageModel is
 * mocked): summarizer calls answer `summaryText` and report `summaryUsage`;
 * agent calls play `agentSteps` in order, then repeat the last one.
 */
function compactingModel(
  agentSteps: readonly ScriptedStep[],
  summaryUsage: StepUsage,
  summaryText = 'Summary of the earlier turns.',
): CompactingModel {
  let agentCalls = 0;
  let summaryCalls = 0;
  const scripted: CompactingModel = {
    model: new MockLanguageModelV3({
      doGenerate: async (options) => {
        if (JSON.stringify(options.prompt).includes(SUMMARY_TRIGGER)) {
          summaryCalls++;
          return generateResult({ text: summaryText, usage: summaryUsage }, 1_000 + summaryCalls);
        }
        agentCalls++;
        scripted.onAgentCall?.(agentCalls);
        return generateResult(agentSteps[Math.min(agentCalls - 1, agentSteps.length - 1)], agentCalls);
      },
    }),
  };
  return scripted;
}

/**
 * A config whose builtin session compacts before the third turn: every
 * agent step below reads past the 1,000-token threshold, and with one
 * message kept the history has enough to split only from the third turn on.
 */
function compactingConfig(
  budget: Partial<ResolvedResourceBudgetConfig> = {},
  userConfig: Partial<IronCurtainConfig['userConfig']> = {},
): IronCurtainConfig {
  const base = createTestConfig(budget, 'anthropic:claude-sonnet-4-6');
  return {
    ...base,
    userConfig: {
      ...base.userConfig,
      autoCompact: {
        enabled: true,
        thresholdTokens: 1_000,
        keepRecentMessages: 1,
        summaryModelId: 'anthropic:claude-haiku-4-5',
      },
      ...userConfig,
    },
  };
}

describe('AgentSession auto-compaction usage (real generateText loop)', () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.IRONCURTAIN_HOME;
    home = mkdtempSync(join(tmpdir(), 'ironcurtain-compaction-budget-'));
    process.env.IRONCURTAIN_HOME = home;
  });

  afterEach(() => {
    logger.teardown();
    if (originalHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  async function startCompactingSession(
    scripted: CompactingModel,
    config: IronCurtainConfig,
  ): Promise<SessionUnderTest> {
    mocks.model = scripted.model;
    const diagnostics: DiagnosticEvent[] = [];
    const session = await createSession({
      config,
      sandboxFactory: vi.fn().mockResolvedValue(createMockSandbox()),
      onDiagnostic: (event) => diagnostics.push(event),
    });
    return { session, diagnostics };
  }

  it("counts the summarizer's tokens and cost toward the turn and the session totals, but not as a step", async () => {
    const scripted = compactingModel([{ text: 'answer', usage: { input: 5_000, output: 10 } }], {
      input: 10_000,
      output: 1_000,
    });
    const { session, diagnostics } = await startCompactingSession(scripted, compactingConfig());
    // What the turn has consumed when its first agent call starts, right after the compaction.
    const atAgentCall: Array<ReturnType<Session['getBudgetStatus']>> = [];
    scripted.onAgentCall = () => atAgentCall.push(session.getBudgetStatus());
    try {
      await session.sendMessage('one');
      await session.sendMessage('two');
      expect(diagnostics.some((event) => event.kind === 'message_compaction')).toBe(false);
      await session.sendMessage('three');
      expect(diagnostics).toContainEqual(expect.objectContaining({ kind: 'message_compaction' }));

      // In the turn, before its first step: the summarizer's call alone, priced as Haiku 4.5.
      expect(atAgentCall[2]).toMatchObject({ stepCount: 0, totalInputTokens: 10_000, totalOutputTokens: 1_000 });
      expect(atAgentCall[2].estimatedCostUsd).toBeCloseTo(haikuCost(10_000, 1_000), 12);

      const status = session.getBudgetStatus();
      expect(status.lastTurn).toMatchObject({
        stepCount: 1,
        totalInputTokens: 15_000,
        totalOutputTokens: 1_010,
        totalTokens: 16_010,
      });
      expect(status.lastTurn?.estimatedCostUsd).toBeCloseTo(sonnetCost(5_000, 10) + haikuCost(10_000, 1_000), 12);
      expect(status.cumulative).toMatchObject({ stepCount: 3, totalTokens: 3 * 5_010 + 11_000 });
      expect(status.cumulative.estimatedCostUsd).toBeCloseTo(3 * sonnetCost(5_000, 10) + haikuCost(10_000, 1_000), 12);
    } finally {
      await session.close();
    }
  });

  it("ends the turn when the summarizer's tokens use up the turn's token budget", async () => {
    const scripted = compactingModel(
      [
        { text: 'one', usage: { input: 5_000, output: 10 } },
        { text: 'two', usage: { input: 5_000, output: 10 } },
        // Turn 3: the compaction's 11,000 tokens plus this step's 1,010 pass the 12,000 limit.
        { toolCall: true, usage: { input: 1_000, output: 10 } },
        { text: 'three', usage: { input: 1_000, output: 10 } },
      ],
      { input: 10_000, output: 1_000 },
    );
    const { session, diagnostics } = await startCompactingSession(
      scripted,
      compactingConfig({ maxTotalTokens: 12_000 }),
    );
    try {
      await session.sendMessage('one');
      await session.sendMessage('two');
      const error = await session.sendMessage('three').catch((err: unknown) => err);
      expect(error).toBeInstanceOf(BudgetExhaustedError);
      expect((error as BudgetExhaustedError).dimension).toBe('tokens');
      expect((error as BudgetExhaustedError).message).toBe(
        'Token budget exhausted: 12,010 / 12,000 tokens used. Stopped after 1 step without a final answer.',
      );
      // The compaction alone passed the warning threshold (11,000 of 12,000).
      expect(diagnostics).toContainEqual(
        expect.objectContaining({ kind: 'budget_warning', dimension: 'tokens', percentUsed: 92 }),
      );
    } finally {
      await session.close();
    }
  });

  it.each([
    ['token', 'tokens', { maxTotalTokens: 10_000 }, {}],
    [
      'cost',
      'cost',
      // The summary costs $1.10 at this override; each agent step about $0.015.
      { maxEstimatedCostUsd: 1 },
      { modelPricingOverrides: { 'claude-haiku-4-5': { inputPerMillion: 100, outputPerMillion: 100 } } },
    ],
  ])(
    "makes no agent call in a turn whose %s budget the summarizer's call used up",
    async (_label, dimension, budget, userConfig) => {
      const scripted = compactingModel(
        [
          { text: 'one', usage: { input: 5_000, output: 10 } },
          { text: 'two', usage: { input: 5_000, output: 10 } },
          { text: 'four', usage: { input: 1_000, output: 10 } },
        ],
        { input: 10_000, output: 1_000 },
      );
      let agentCalls = 0;
      scripted.onAgentCall = (call) => {
        agentCalls = call;
      };
      const { session, diagnostics } = await startCompactingSession(scripted, compactingConfig(budget, userConfig));
      try {
        await session.sendMessage('one');
        await session.sendMessage('two');
        const error = await session.sendMessage('three').catch((err: unknown) => err);
        expect(error).toBeInstanceOf(BudgetExhaustedError);
        const exhausted = error as BudgetExhaustedError;
        expect(exhausted.dimension).toBe(dimension);
        expect(exhausted.message).toMatch(/ exhausted: .*\. Stopped before the agent's first step\.$/);
        expect(diagnostics).toContainEqual({ kind: 'budget_exhausted', dimension, message: exhausted.message });

        // The summarizer ran, the agent did not: the turn is charged with the
        // summary alone and, with no step finished, rolled back.
        expect(diagnostics).toContainEqual(expect.objectContaining({ kind: 'message_compaction' }));
        expect(agentCalls).toBe(2);
        expect(session.getBudgetStatus().lastTurn).toMatchObject({ stepCount: 0, totalTokens: 11_000 });
        expect(session.getHistory().map((turn) => turn.userMessage)).toEqual(['one', 'two']);

        // The next turn starts with a fresh budget and nothing left to compact.
        await expect(session.sendMessage('four')).resolves.toBe('four');
        expect(agentCalls).toBe(3);
        expect(diagnostics.filter((event) => event.kind === 'message_compaction')).toHaveLength(1);
      } finally {
        await session.close();
      }
    },
  );

  it("counts the usage of a summarizer call that returned no summary, and prices it at the summary model's override", async () => {
    // generateResult adds no text part for an empty text: the summarizer returns nothing.
    const scripted = compactingModel(
      [{ text: 'answer', usage: { input: 5_000, output: 10 } }],
      { input: 10_000, output: 1_000 },
      '',
    );
    const { session, diagnostics } = await startCompactingSession(
      scripted,
      compactingConfig(
        {},
        { modelPricingOverrides: { 'claude-haiku-4-5': { inputPerMillion: 100, outputPerMillion: 100 } } },
      ),
    );
    try {
      await session.sendMessage('one');
      await session.sendMessage('two');
      await session.sendMessage('three');
      expect(diagnostics).toContainEqual(expect.objectContaining({ kind: 'message_compaction_failed' }));
      const { lastTurn } = session.getBudgetStatus();
      expect(lastTurn).toMatchObject({ stepCount: 1, totalTokens: 5_010 + 11_000 });
      // 11,000 tokens at the $100 per million override, plus the agent step at Sonnet 4.6 prices.
      expect(lastTurn?.estimatedCostUsd).toBeCloseTo(1.1 + sonnetCost(5_000, 10), 12);
    } finally {
      await session.close();
    }
  });

  it('prices the summarizer at the model its host profile routes it to', async () => {
    const scripted = compactingModel([{ text: 'answer', usage: { input: 5_000, output: 10 } }], {
      input: 10_000,
      output: 1_000,
    });
    const config = compactingConfig(
      {},
      {
        modelProviders: {
          default: 'native',
          profiles: {
            native: { type: 'native' },
            cheap: {
              type: 'openrouter',
              apiKey: 'dummy-host-key',
              modelMap: [{ match: '*haiku*', model: 'openai/gpt-4o-mini' }],
              usesDefaultMap: false,
              perAgent: { 'claude-code': 'docker-only', goose: 'docker-only', codex: 'docker-only' },
              providerPreference: undefined,
              sessionAffinity: false,
            },
          },
        },
        hostModelProfiles: { summary: 'cheap' },
      },
    );
    const { session } = await startCompactingSession(scripted, config);
    try {
      await session.sendMessage('one');
      await session.sendMessage('two');
      await session.sendMessage('three');
      // gpt-4o-mini: $0.15 / $0.60 per million input / output tokens.
      const summaryCost = (10_000 * 0.15 + 1_000 * 0.6) / 1_000_000;
      expect(session.getBudgetStatus().lastTurn?.estimatedCostUsd).toBeCloseTo(sonnetCost(5_000, 10) + summaryCost, 12);
    } finally {
      await session.close();
    }
  });

  it("surfaces the summary model's fail-closed price once per session", async () => {
    const scripted = compactingModel([{ text: 'answer', usage: { input: 5_000, output: 10 } }], {
      input: 10_000,
      output: 1_000,
    });
    const base = compactingConfig();
    const config: IronCurtainConfig = {
      ...base,
      userConfig: {
        ...base.userConfig,
        autoCompact: { ...base.userConfig.autoCompact, summaryModelId: 'anthropic:claude-haiku-9' },
      },
    };
    const { session, diagnostics } = await startCompactingSession(scripted, config);
    try {
      // Compactions before turns 3 and 5 (one message kept after each).
      for (const message of ['one', 'two', 'three', 'four', 'five']) await session.sendMessage(message);
      expect(diagnostics.filter((event) => event.kind === 'message_compaction')).toHaveLength(2);
      const warnings = diagnostics.filter(
        (event) => event.kind === 'budget_warning' && event.message.includes('"anthropic:claude-haiku-9"'),
      );
      expect(warnings).toHaveLength(1);
      // An unknown Claude model is priced at the highest tier, $10 / $50 per million tokens.
      expect(session.getBudgetStatus().lastTurn?.estimatedCostUsd).toBeCloseTo(
        sonnetCost(5_000, 10) + (10_000 * 10 + 1_000 * 50) / 1_000_000,
        12,
      );
    } finally {
      await session.close();
    }
  });
});

// --- Ending a turn early, and what execute_code shows the model (WP-55) ---

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Resolves when `signal` aborts (like a real script being cancelled). */
function abortedOf(signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal === undefined) return;
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

describe('AgentSession turn abort and execute_code output (real generateText loop)', () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.IRONCURTAIN_HOME;
    home = mkdtempSync(join(tmpdir(), 'ironcurtain-turn-abort-'));
    process.env.IRONCURTAIN_HOME = home;
  });

  afterEach(() => {
    logger.teardown();
    if (originalHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('close() mid-turn cancels the running script, makes no further model call and reports closed', async () => {
    const model = toolLoopModel();
    const running = deferred();
    let scriptSignal: AbortSignal | undefined;
    const sandbox = createMockSandbox(async (_code, options) => {
      scriptSignal = options?.signal;
      running.resolve();
      // Like the real sandbox, the script ends when its signal aborts.
      await abortedOf(options?.signal);
      return { result: null, logs: ['[ERROR] Code execution failed: Script execution cancelled'] };
    });
    const { session } = await startSession({ model, sandbox });

    const turn = session.sendMessage('do something long').catch((err: unknown) => err);
    await running.promise;
    await session.close();
    const error = await turn;

    expect(error).toBeInstanceOf(SessionClosedError);
    expect(scriptSignal?.aborted).toBe(true);
    // The model is not called again after the cancelled step.
    expect(model.doGenerateCalls).toHaveLength(1);
    // Closed stays closed (the turn used to put the session back to 'ready').
    expect(session.getInfo().status).toBe('closed');
    await expect(session.sendMessage('again')).rejects.toBeInstanceOf(SessionClosedError);
  });

  it('close() mid-turn ends the loop even when the tool ignores the signal', async () => {
    const model = toolLoopModel();
    const running = deferred();
    const sandbox = createMockSandbox(async () => {
      running.resolve();
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { result: 'finished anyway', logs: [] };
    });
    const { session } = await startSession({ model, sandbox });

    const turn = session.sendMessage('do something').catch((err: unknown) => err);
    await running.promise;
    await session.close();

    expect(await turn).toBeInstanceOf(SessionClosedError);
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(session.getInfo().status).toBe('closed');
  });

  it('close() during auto-compaction aborts the summarization call and makes no agent model call', async () => {
    // The closing request of the summarizer's (text-only) prompt.
    const SUMMARY_TRIGGER = 'Summarize the conversation above';
    const inSummary = deferred();
    let summarySignal: AbortSignal | undefined;
    let agentCalls = 0;
    // createLanguageModel is mocked, so this one model serves the agent and
    // the summarizer: agent turns answer with a large input-token count (so
    // the next turn compacts), the summary call waits until it is aborted.
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        if (JSON.stringify(options.prompt).includes(SUMMARY_TRIGGER)) {
          summarySignal = options.abortSignal;
          inSummary.resolve();
          await abortedOf(options.abortSignal);
          throw options.abortSignal?.reason instanceof Error
            ? options.abortSignal.reason
            : new DOMException('aborted', 'AbortError');
        }
        agentCalls++;
        return generateResult({ text: `answer ${agentCalls}`, usage: { input: 200_000, output: 10 } }, agentCalls);
      },
    });
    mocks.model = model;
    const base = createTestConfig({}, 'anthropic:claude-sonnet-4-6');
    const config = {
      ...base,
      userConfig: {
        ...base.userConfig,
        autoCompact: {
          enabled: true,
          thresholdTokens: 1_000,
          keepRecentMessages: 1,
          summaryModelId: 'anthropic:claude-haiku-4-5',
        },
      },
    } as IronCurtainConfig;
    const session = await createSession({ config, sandboxFactory: vi.fn().mockResolvedValue(createMockSandbox()) });

    // Two turns of history; the third turn compacts before its model call.
    await session.sendMessage('one');
    await session.sendMessage('two');
    expect(agentCalls).toBe(2);
    const turn = session.sendMessage('three').catch((err: unknown) => err);
    await inSummary.promise;
    await session.close();

    expect(await turn).toBeInstanceOf(SessionClosedError);
    expect(summarySignal?.aborted).toBe(true);
    expect(agentCalls).toBe(2);
    expect(session.getInfo().status).toBe('closed');
  });

  it('close() during a model call aborts the call and rejects the turn with SessionClosedError', async () => {
    const inModel = deferred();
    let calls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        calls++;
        inModel.resolve();
        await abortedOf(options.abortSignal);
        throw options.abortSignal?.reason instanceof Error
          ? options.abortSignal.reason
          : new DOMException('aborted', 'AbortError');
      },
    });
    const { session } = await startSession({ model });

    const turn = session.sendMessage('hello').catch((err: unknown) => err);
    await inModel.promise;
    await session.close();

    expect(await turn).toBeInstanceOf(SessionClosedError);
    expect(calls).toBe(1);
    expect(session.getInfo().status).toBe('closed');
  });

  it("hands execute_code the turn's signal and caps the script by the remaining wall clock", async () => {
    const model = scriptedModel([
      { toolCall: true, usage: { input: 1_000, output: 100 } },
      { text: 'Done.', usage: { input: 1_000, output: 10 } },
    ]);
    const seen: ExecuteCodeOptions[] = [];
    const sandbox = createMockSandbox(async (_code, options) => {
      seen.push(options ?? {});
      return { result: 'ok', logs: [] };
    });
    const { session } = await startSession({ model, sandbox, budget: { maxSessionSeconds: 60 } });
    try {
      await expect(session.sendMessage('go')).resolves.toBe('Done.');
      expect(seen).toHaveLength(1);
      expect(seen[0].signal).toBeInstanceOf(AbortSignal);
      expect(seen[0].signal?.aborted).toBe(false);
      expect(seen[0].timeoutMs).toBeGreaterThan(0);
      expect(seen[0].timeoutMs).toBeLessThanOrEqual(60_000);
    } finally {
      await session.close();
    }
  });

  it('shows the model console output and the result under one size budget', async () => {
    const model = scriptedModel([
      { toolCall: true, usage: { input: 1_000, output: 100 } },
      { text: 'Done.', usage: { input: 1_000, output: 10 } },
    ]);
    // 3,000 lines of 200 bytes (about 600 KB) plus a 300 KB result.
    const logs = Array.from({ length: 3_000 }, (_, i) => `line ${i} `.padEnd(200, 'x'));
    logs.push('[ERROR] Code execution failed: the last line survives');
    const sandbox = createMockSandbox(async () => ({ result: 'r'.repeat(300_000), logs }));
    const { session, diagnostics } = await startSession({ model, sandbox });
    try {
      await session.sendMessage('go');
      const toolMessage = model.doGenerateCalls[1].prompt.find((message) => message.role === 'tool');
      expect(toolMessage).toBeDefined();
      const shown = JSON.stringify(toolMessage);
      // Both parts together stay near the 100 KB default (JSON escaping aside).
      expect(shown.length).toBeLessThan(130_000);
      expect(shown).toContain('console output truncated');
      expect(shown).toContain('the last line survives');
      expect(shown).toContain('[... truncated');
      expect(diagnostics.some((event) => event.kind === 'result_truncation')).toBe(true);
    } finally {
      await session.close();
    }
  });
});
