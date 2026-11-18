/**
 * Persona-level agent model and resource-budget overrides (WP-126).
 *
 * A persona's `agentModelId` and `resourceBudget` (persona.json) apply to its
 * sessions from every entry point, below everything a caller sets explicitly:
 *
 *   model:  --model > workflow state model > workflow settings model
 *           > persona agentModelId > global agentModelId
 *   limits: caller's explicit limits (workflow settings.resourceBudget, cron
 *           job budgetOverrides) > persona resourceBudget > caller's baseline
 *           (a workflow run's inherited limits, the cron defaults) > global
 *
 * Covers the persona.json validation (fail closed), the pure precedence
 * helpers, `buildSessionConfig` (the one place every entry point resolves
 * them), the workflow session factory composed with it, the workflow and
 * cron budget splits, the persona service and CLI, and the Claude Code
 * adapter's container environment for interactive PTY sessions.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as loggerModule from '../src/logger.js';
import { REAL_TMP, TEST_SANDBOX_DIR } from './fixtures/test-policy.js';
import { writePersonaPolicy } from './fixtures/scoped-policy.js';
import { buildSessionConfig } from '../src/session/index.js';
import { createSessionId, type SessionOptions } from '../src/session/types.js';
import {
  layerResourceBudget,
  resolveSessionAgentModel,
  withAgentModelId,
} from '../src/session/model-budget-precedence.js';
import {
  isPersonaOverridesError,
  parsePersonaAgentModelId,
  parsePersonaResourceBudget,
  PERSONA_OVERRIDES_INVALID,
  readPersonaOverrides,
} from '../src/persona/persona-overrides.js';
import { createPersonaName, type PersonaDefinition } from '../src/persona/types.js';
import { setPersonaOverrides } from '../src/persona/persona-service.js';
import { verifyPolicyMutationLog, type PolicyMutationRecord } from '../src/persona/policy-mutation-audit.js';
import { main as personaMain } from '../src/persona/persona-command.js';
import { scanPersonas } from '../src/mux/persona-scanner.js';
import { createClaudeCodeAdapter } from '../src/docker/adapters/claude-code.js';
import { resolveWorkflowResourceBudget, workflowSessionBudgetOptions } from '../src/workflow/resource-budget.js';
import { CRON_BUDGET_DEFAULTS } from '../src/cron/types.js';
import { getSessionDir } from '../src/config/paths.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import type { ResolvedResourceBudgetConfig } from '../src/config/user-config.js';

const TEST_HOME = `${REAL_TMP}/ironcurtain-persona-overrides-test-${process.pid}`;

const GLOBAL_MODEL = 'anthropic:claude-sonnet-4-6';
const PERSONA_MODEL = 'anthropic:claude-haiku-4-5';
const SETTINGS_MODEL = 'anthropic:claude-opus-4-6';
const STATE_MODEL = 'openai:gpt-5';
const CLI_MODEL = 'google:gemini-2.5-pro';

const GLOBAL_BUDGET: ResolvedResourceBudgetConfig = {
  maxTotalTokens: 1_000_000,
  maxSteps: 200,
  maxSessionSeconds: 1800,
  maxEstimatedCostUsd: 5,
  warnThresholdPercent: 80,
};

function createTestConfig(): IronCurtainConfig {
  return {
    auditLogPath: './audit.jsonl',
    allowedDirectory: TEST_SANDBOX_DIR,
    mcpServers: { filesystem: { command: 'echo', args: ['test'] } },
    protectedPaths: [],
    generatedDir: resolve(TEST_HOME, 'generated'),
    constitutionPath: `${REAL_TMP}/test-constitution.md`,
    agentModelId: GLOBAL_MODEL,
    escalationTimeoutSeconds: 300,
    userConfig: {
      agentModelId: GLOBAL_MODEL,
      policyModelId: GLOBAL_MODEL,
      anthropicApiKey: 'test-api-key',
      googleApiKey: '',
      openaiApiKey: '',
      escalationTimeoutSeconds: 300,
      resourceBudget: { ...GLOBAL_BUDGET },
      autoCompact: {
        enabled: false,
        thresholdTokens: 80_000,
        keepRecentMessages: 10,
        summaryModelId: 'anthropic:claude-haiku-4-5',
      },
      autoApprove: { enabled: false, modelId: 'anthropic:claude-haiku-4-5' },
      auditRedaction: { enabled: true },
      memory: { enabled: false, autoSave: false, llmBaseUrl: undefined, llmApiKey: undefined },
    },
  } as unknown as IronCurtainConfig;
}

/**
 * Writes a persona with a fresh compiled policy and the given extra
 * persona.json fields. The rule escalates rather than allows: an
 * unconstrained allow rule is broad access, which `resolvePersona` refuses
 * for a persona without the broad-policy opt-in.
 */
function createPersonaOnDisk(name: string, extra: Record<string, unknown> = {}): void {
  const personaDir = resolve(TEST_HOME, 'personas', name);
  mkdirSync(resolve(personaDir, 'workspace'), { recursive: true });
  writeFileSync(
    resolve(personaDir, 'persona.json'),
    JSON.stringify({ name, description: `Test persona ${name}`, createdAt: '2026-11-11T00:00:00.000Z', ...extra }),
  );
  writePersonaPolicy(personaDir, {
    rules: [
      {
        name: 'escalate-fs',
        description: 'test',
        principle: 'test',
        if: { server: ['filesystem'] },
        then: 'escalate',
        reason: 'test',
      },
    ],
  });
}

function readPersonaJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(TEST_HOME, 'personas', name, 'persona.json'), 'utf-8')) as Record<
    string,
    unknown
  >;
}

function definition(extra: Record<string, unknown>): PersonaDefinition {
  return {
    name: createPersonaName('p'),
    description: 'd',
    createdAt: '2026-11-11T00:00:00.000Z',
    ...extra,
  };
}

/** Runs buildSessionConfig for a fresh session id with the given options. */
function build(opts: Parameters<typeof buildSessionConfig>[3], config = createTestConfig()) {
  const sessionId = createSessionId();
  return { sessionId, result: buildSessionConfig(config, sessionId, sessionId, opts) };
}

beforeEach(() => {
  process.env['IRONCURTAIN_HOME'] = TEST_HOME;
  mkdirSync(resolve(TEST_HOME, 'generated'), { recursive: true });
  // Provenance warnings for the fixture policies are not under test.
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  loggerModule.teardown();
  vi.restoreAllMocks();
  delete process.env['IRONCURTAIN_HOME'];
  rmSync(TEST_HOME, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// persona.json validation
// ---------------------------------------------------------------------------

describe('persona override validation', () => {
  it('reads no overrides from a persona without them', () => {
    expect(readPersonaOverrides('p', definition({}))).toEqual({});
  });

  it('accepts provider-qualified, bare and gateway model IDs', () => {
    for (const id of ['anthropic:claude-haiku-4-5', 'claude-haiku-4-5', 'glm-5.1:cloud', 'openai:gpt-5']) {
      expect(parsePersonaAgentModelId(id)).toEqual({ ok: true, value: id });
    }
  });

  it.each([
    ['an empty string', ''],
    ['a number', 42],
    ['null', null],
    ['an empty name before the colon', ':tag'],
    ['an empty model after a provider', 'anthropic:'],
    ['an agent name', 'claude-code'],
    ['a space', 'claude haiku'],
    ['a terminal escape', 'claude\u001b[31m'],
    ['an over-long value', `m${'x'.repeat(200)}`],
  ])('refuses %s as agentModelId', (_label, value) => {
    expect(parsePersonaAgentModelId(value).ok).toBe(false);
    let thrown: unknown;
    try {
      readPersonaOverrides('cheap', definition({ agentModelId: value }));
    } catch (err) {
      thrown = err;
    }
    expect(isPersonaOverridesError(thrown)).toBe(true);
    expect((thrown as { code: string }).code).toBe(PERSONA_OVERRIDES_INVALID);
    expect((thrown as Error).message).toMatch(/^Persona "cheap" has an invalid agentModelId/);
  });

  it('accepts limits, null to disable one, and drops undefined fields', () => {
    expect(
      parsePersonaResourceBudget({
        maxEstimatedCostUsd: 1.5,
        maxSteps: 50,
        maxTotalTokens: null,
        maxSessionSeconds: undefined,
      }),
    ).toEqual({ ok: true, value: { maxEstimatedCostUsd: 1.5, maxSteps: 50, maxTotalTokens: null } });
    expect(readPersonaOverrides('p', definition({ resourceBudget: { warnThresholdPercent: 50 } }))).toEqual({
      resourceBudget: { warnThresholdPercent: 50 },
    });
  });

  it.each([
    ['an unknown field', { maxCost: 1 }],
    ['a negative limit', { maxEstimatedCostUsd: -1 }],
    ['a zero limit', { maxSteps: 0 }],
    ['fractional tokens', { maxTotalTokens: 1.5 }],
    ['a string limit', { maxEstimatedCostUsd: '1' }],
    ['a null warn threshold', { warnThresholdPercent: null }],
    ['a 100% warn threshold', { warnThresholdPercent: 100 }],
    ['a non-object', 5],
    ['an array', [1]],
  ])('refuses %s in resourceBudget', (_label, value) => {
    expect(parsePersonaResourceBudget(value).ok).toBe(false);
    expect(() => readPersonaOverrides('cheap', definition({ resourceBudget: value }))).toThrow(
      /^Persona "cheap" has an invalid resourceBudget/,
    );
  });

  it('escapes control characters of an unknown field name in the message', () => {
    const check = parsePersonaResourceBudget({ 'max\u001b[2JCost': 1 });
    expect(check.ok).toBe(false);
    expect(check.ok ? '' : check.problem).not.toContain('\u001b');
  });
});

// ---------------------------------------------------------------------------
// Pure precedence helpers
// ---------------------------------------------------------------------------

describe('precedence helpers', () => {
  it('picks the override, else the persona model, else the global one', () => {
    expect(resolveSessionAgentModel({ override: CLI_MODEL, persona: PERSONA_MODEL, global: GLOBAL_MODEL })).toEqual({
      modelId: CLI_MODEL,
      source: 'override',
    });
    expect(resolveSessionAgentModel({ persona: PERSONA_MODEL, global: GLOBAL_MODEL })).toEqual({
      modelId: PERSONA_MODEL,
      source: 'persona',
    });
    expect(resolveSessionAgentModel({ global: GLOBAL_MODEL })).toEqual({ modelId: GLOBAL_MODEL, source: 'global' });
  });

  it('layers limits field by field; undefined keeps the lower value, null disables', () => {
    const merged = layerResourceBudget(GLOBAL_BUDGET, { maxSteps: 10, maxEstimatedCostUsd: 3 }, undefined, {
      maxSteps: 20,
      maxTotalTokens: null,
      maxSessionSeconds: undefined,
    });
    expect(merged).toEqual({ ...GLOBAL_BUDGET, maxSteps: 20, maxEstimatedCostUsd: 3, maxTotalTokens: null });
  });

  it('sets the agent model in both config fields without touching the original', () => {
    const config = createTestConfig();
    const patched = withAgentModelId(config, PERSONA_MODEL);
    expect(patched.agentModelId).toBe(PERSONA_MODEL);
    expect(patched.userConfig.agentModelId).toBe(PERSONA_MODEL);
    expect(config.agentModelId).toBe(GLOBAL_MODEL);
    expect(config.userConfig.agentModelId).toBe(GLOBAL_MODEL);
  });
});

// ---------------------------------------------------------------------------
// buildSessionConfig: the one place every entry point resolves both
// ---------------------------------------------------------------------------

describe('buildSessionConfig persona model', () => {
  it('applies the persona model when no higher-precedence source sets one', () => {
    createPersonaOnDisk('cheap', { agentModelId: PERSONA_MODEL });
    const config = createTestConfig();

    const { result } = build({ persona: 'cheap' }, config);

    expect(result.config.agentModelId).toBe(PERSONA_MODEL);
    expect(result.config.userConfig.agentModelId).toBe(PERSONA_MODEL);
    // Session classes pass it to every agent turn as well.
    expect(result.agentModelOverride).toBe(PERSONA_MODEL);
    // The caller's config is untouched.
    expect(config.agentModelId).toBe(GLOBAL_MODEL);
  });

  it('lets an explicit override (--model, a workflow state or settings model) win over the persona model', () => {
    createPersonaOnDisk('cheap', { agentModelId: PERSONA_MODEL });

    const { result } = build({ persona: 'cheap', agentModelOverride: STATE_MODEL });

    expect(result.config.agentModelId).toBe(STATE_MODEL);
    expect(result.config.userConfig.agentModelId).toBe(STATE_MODEL);
    expect(result.agentModelOverride).toBe(STATE_MODEL);
  });

  it('keeps the global model for a persona without agentModelId', () => {
    createPersonaOnDisk('plain');

    const { result } = build({ persona: 'plain' });

    expect(result.config.agentModelId).toBe(GLOBAL_MODEL);
    expect(result.config.userConfig.agentModelId).toBe(GLOBAL_MODEL);
    expect(result.agentModelOverride).toBeUndefined();
  });

  it('applies an explicit override without a persona', () => {
    const { result } = build({ agentModelOverride: CLI_MODEL });
    expect(result.config.agentModelId).toBe(CLI_MODEL);
    expect(result.agentModelOverride).toBe(CLI_MODEL);
  });

  it("falls back to the persona's model, the one the session runs, for a host-model role without credentials", () => {
    // Auto-compaction's summary model has no key, and neither does the global
    // agent model; the persona's model has one, so the session summarizes
    // with it rather than turning auto-compaction off.
    createPersonaOnDisk('router', { agentModelId: STATE_MODEL });
    const config = createTestConfig();
    const userConfig = {
      ...config.userConfig,
      anthropicApiKey: '',
      openaiApiKey: 'sk-openai',
      autoCompact: { ...config.userConfig.autoCompact, enabled: true },
    };

    const { result } = build({ persona: 'router' }, { ...config, userConfig });

    expect(result.config.userConfig.autoCompact).toMatchObject({ enabled: true, summaryModelId: STATE_MODEL });
    expect(result.hostModelNotices.map((notice) => notice.action)).toEqual(['agent_model']);
  });

  it('refuses a persona with a malformed model before creating anything for the session', () => {
    createPersonaOnDisk('broken', { agentModelId: 'claude-code' });
    const sessionId = createSessionId();

    let thrown: unknown;
    try {
      buildSessionConfig(createTestConfig(), sessionId, sessionId, { persona: 'broken' });
    } catch (err) {
      thrown = err;
    }

    expect(isPersonaOverridesError(thrown)).toBe(true);
    expect(existsSync(getSessionDir(sessionId))).toBe(false);
  });
});

describe('buildSessionConfig persona resource limits', () => {
  it('lays the persona limits over the global ones', () => {
    createPersonaOnDisk('cheap', { resourceBudget: { maxEstimatedCostUsd: 1, maxSteps: null } });

    const { result } = build({ persona: 'cheap' });

    expect(result.config.userConfig.resourceBudget).toEqual({
      ...GLOBAL_BUDGET,
      maxEstimatedCostUsd: 1,
      maxSteps: null,
    });
  });

  it("puts the caller's explicit limits above the persona's and the baseline below", () => {
    createPersonaOnDisk('cheap', { resourceBudget: { maxEstimatedCostUsd: 1, maxSteps: 30 } });

    const { result } = build({
      persona: 'cheap',
      resourceBudgetBaseline: { maxEstimatedCostUsd: 9, maxSteps: 90, maxTotalTokens: 90_000 },
      resourceBudgetOverrides: { maxSteps: 7 },
    });

    expect(result.config.userConfig.resourceBudget).toEqual({
      ...GLOBAL_BUDGET,
      maxTotalTokens: 90_000, // baseline: the persona does not set it
      maxEstimatedCostUsd: 1, // persona over baseline
      maxSteps: 7, // explicit over persona
    });
  });

  it('composes a persona cron job: job budgetOverrides > persona > cron defaults', () => {
    createPersonaOnDisk('nightly', { resourceBudget: { maxEstimatedCostUsd: 0.5, maxSessionSeconds: 600 } });

    const { result } = build({
      persona: 'nightly',
      resourceBudgetBaseline: CRON_BUDGET_DEFAULTS,
      resourceBudgetOverrides: { maxSessionSeconds: 120 },
    });

    expect(result.config.userConfig.resourceBudget).toEqual({
      ...GLOBAL_BUDGET,
      ...CRON_BUDGET_DEFAULTS,
      maxEstimatedCostUsd: 0.5,
      maxSessionSeconds: 120,
    });
  });

  it("composes a workflow state: the workflow's own limits > persona > the run's inherited limits", () => {
    createPersonaOnDisk('reviewer', { resourceBudget: { maxEstimatedCostUsd: 2, maxSteps: 15 } });
    const runBudget = resolveWorkflowResourceBudget(
      { resourceBudget: { maxSteps: 40 } },
      { maxEstimatedCostUsd: 12, maxTotalTokens: 300_000 },
    );

    const { result } = build({ persona: 'reviewer', ...workflowSessionBudgetOptions(runBudget) });

    expect(result.config.userConfig.resourceBudget).toEqual({
      ...runBudget.limits,
      maxSteps: 40, // the workflow sets it: the persona cannot change it
      maxEstimatedCostUsd: 2, // inherited by the run: the persona's value applies
    });
  });

  it('refuses a persona with malformed limits', () => {
    createPersonaOnDisk('broken', { resourceBudget: { maxEstimatedCostUsd: 'cheap' } });
    expect(() => build({ persona: 'broken' })).toThrow(/invalid resourceBudget/);
  });
});

// ---------------------------------------------------------------------------
// Workflow budget split
// ---------------------------------------------------------------------------

describe('workflowSessionBudgetOptions', () => {
  it('keeps workflow limits explicit and moves inherited ones to the baseline', () => {
    const budget = resolveWorkflowResourceBudget(
      { resourceBudget: { maxSteps: 40, maxTotalTokens: null }, maxSessionSeconds: 600 },
      { maxEstimatedCostUsd: 12 },
    );

    const options = workflowSessionBudgetOptions(budget);

    expect(options.resourceBudgetOverrides).toEqual({ maxSteps: 40, maxTotalTokens: null, maxSessionSeconds: 600 });
    expect(options.resourceBudgetBaseline).toEqual({ maxEstimatedCostUsd: 12, warnThresholdPercent: 80 });
  });

  it('treats a limit without a recorded source as explicit (what the run enforced so far)', () => {
    const options = workflowSessionBudgetOptions({
      limits: GLOBAL_BUDGET,
      sources: { maxSteps: 'global' } as never,
      recorded: true,
    });
    expect(options.resourceBudgetBaseline).toEqual({ maxSteps: 200 });
    expect(options.resourceBudgetOverrides).toEqual({
      maxTotalTokens: 1_000_000,
      maxSessionSeconds: 1800,
      maxEstimatedCostUsd: 5,
      warnThresholdPercent: 80,
    });
  });
});

// ---------------------------------------------------------------------------
// Workflow session factory composed with buildSessionConfig
// ---------------------------------------------------------------------------

describe('workflow model precedence through the real session factory', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('../src/config/index.js');
    vi.doUnmock('../src/session/index.js');
  });

  /**
   * Builds one workflow state's session through `createWorkflowSessionFactory`
   * and the real `buildSessionConfig`, and returns the resolved agent model.
   */
  async function stateSessionModel(args: {
    cliModel?: string;
    stateModel?: string;
    settingsModel?: string;
  }): Promise<{ configModel: string; turnModel: string | undefined }> {
    const resolved: { configModel?: string; turnModel?: string } = {};
    vi.doMock('../src/config/index.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../src/config/index.js')>()),
      loadConfig: () => createTestConfig(),
    }));
    vi.doMock('../src/session/index.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/session/index.js')>();
      return {
        ...actual,
        // The real session factory's config step, without starting an agent.
        createSession: (opts: SessionOptions) => {
          const sessionId = createSessionId();
          const dir = actual.buildSessionConfig(opts.config ?? createTestConfig(), sessionId, sessionId, opts);
          resolved.configModel = dir.config.agentModelId;
          resolved.turnModel = dir.agentModelOverride;
          return Promise.resolve({ close: () => Promise.resolve() });
        },
      };
    });
    const { createWorkflowSessionFactory } = await import('../src/workflow/cli-support.js');

    // The orchestrator passes `state.model ?? settings.model` (orchestrator.ts).
    const perState = args.stateModel ?? args.settingsModel;
    await createWorkflowSessionFactory(args.cliModel)({
      persona: 'cheap',
      ...(perState !== undefined ? { agentModelOverride: perState } : {}),
    });
    // The reset module registry gave the session factory its own logger
    // instance; release the console it took over.
    (await import('../src/logger.js')).teardown();
    if (resolved.configModel === undefined) throw new Error('createSession was not reached');
    return { configModel: resolved.configModel, turnModel: resolved.turnModel };
  }

  beforeEach(() => {
    createPersonaOnDisk('cheap', { agentModelId: PERSONA_MODEL });
  });

  it('runs the persona model when neither --model nor the workflow sets one', async () => {
    expect(await stateSessionModel({})).toEqual({ configModel: PERSONA_MODEL, turnModel: PERSONA_MODEL });
  });

  it('runs the workflow settings model over the persona model', async () => {
    expect(await stateSessionModel({ settingsModel: SETTINGS_MODEL })).toEqual({
      configModel: SETTINGS_MODEL,
      turnModel: SETTINGS_MODEL,
    });
  });

  it('runs the workflow state model over the settings and persona models', async () => {
    expect(await stateSessionModel({ stateModel: STATE_MODEL, settingsModel: SETTINGS_MODEL })).toEqual({
      configModel: STATE_MODEL,
      turnModel: STATE_MODEL,
    });
  });

  it('runs --model over every other source', async () => {
    expect(
      await stateSessionModel({ cliModel: CLI_MODEL, stateModel: STATE_MODEL, settingsModel: SETTINGS_MODEL }),
    ).toEqual({ configModel: CLI_MODEL, turnModel: CLI_MODEL });
  });
});

// ---------------------------------------------------------------------------
// Persona service and CLI
// ---------------------------------------------------------------------------

describe('setPersonaOverrides', () => {
  it('stores a model and limits, and removes them again', () => {
    createPersonaOnDisk('cheap');
    const name = createPersonaName('cheap');

    setPersonaOverrides(name, { agentModelId: PERSONA_MODEL, resourceBudget: { maxEstimatedCostUsd: 1 } }, 'test');
    expect(readPersonaJson('cheap')).toMatchObject({
      agentModelId: PERSONA_MODEL,
      resourceBudget: { maxEstimatedCostUsd: 1 },
    });

    setPersonaOverrides(name, { resourceBudget: {} }, 'test');
    expect(readPersonaJson('cheap')).not.toHaveProperty('resourceBudget');
    expect(readPersonaJson('cheap')).toHaveProperty('agentModelId', PERSONA_MODEL);

    setPersonaOverrides(name, { agentModelId: null }, 'test');
    expect(readPersonaJson('cheap')).not.toHaveProperty('agentModelId');
    expect(readPersonaJson('cheap')).toMatchObject({ name: 'cheap', description: 'Test persona cheap' });
  });

  it('refuses an invalid value without writing anything', () => {
    createPersonaOnDisk('cheap', { agentModelId: PERSONA_MODEL });
    const before = readPersonaJson('cheap');

    expect(() => setPersonaOverrides(createPersonaName('cheap'), { agentModelId: 'goose' }, 'test')).toThrow(
      /Invalid agent model/,
    );
    expect(() => setPersonaOverrides(createPersonaName('cheap'), { resourceBudget: { maxSteps: -5 } }, 'test')).toThrow(
      /Invalid resource limits/,
    );
    expect(readPersonaJson('cheap')).toEqual(before);
  });

  it('refuses to rewrite a malformed value the update keeps', () => {
    createPersonaOnDisk('cheap', { resourceBudget: { maxCost: 1 } });
    expect(() => setPersonaOverrides(createPersonaName('cheap'), { agentModelId: PERSONA_MODEL }, 'test')).toThrow(
      /invalid resourceBudget/,
    );
    expect(readPersonaJson('cheap')).not.toHaveProperty('agentModelId');
  });

  it('records flat audit entries that `audit verify` accepts', () => {
    createPersonaOnDisk('cheap');
    const name = createPersonaName('cheap');

    setPersonaOverrides(
      name,
      { agentModelId: PERSONA_MODEL, resourceBudget: { maxSteps: 30, maxEstimatedCostUsd: 1, maxTotalTokens: null } },
      'test',
    );
    setPersonaOverrides(name, { agentModelId: null, resourceBudget: null }, 'test');

    const records = readFileSync(resolve(TEST_HOME, 'audit', 'policy-mutation.jsonl'), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as PolicyMutationRecord);
    expect(records.map((record) => [record.method, record.persona, record.details])).toEqual([
      [
        'setPersonaOverrides',
        'cheap',
        {
          agentModelId: PERSONA_MODEL,
          resourceBudget: '{"maxEstimatedCostUsd":1,"maxSteps":30,"maxTotalTokens":null}',
        },
      ],
      ['setPersonaOverrides', 'cheap', { agentModelId: null, resourceBudget: null }],
    ]);
    // The hash chain verifies: the method is a known one and the details are flat.
    expect(verifyPolicyMutationLog()).toMatchObject({ ok: true, records: 2 });
  });
});

describe('`persona set` and `persona show`', () => {
  let lines: string[];

  beforeEach(() => {
    lines = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit(${String(code)})`);
    });
  });

  it('sets a model and limits from flags and shows them', async () => {
    createPersonaOnDisk('triage');

    await personaMain(['set', 'triage', '--model', PERSONA_MODEL, '--max-cost', '1.5', '--max-tokens', 'none']);

    expect(readPersonaJson('triage')).toMatchObject({
      agentModelId: PERSONA_MODEL,
      resourceBudget: { maxEstimatedCostUsd: 1.5, maxTotalTokens: null },
    });

    lines.length = 0;
    await personaMain(['show', 'triage']);
    expect(lines).toContain(`Agent model: ${PERSONA_MODEL}`);
    expect(lines).toContain('Resource limits: maxTotalTokens=none, maxEstimatedCostUsd=1.5 (others inherited)');
  });

  it('changes one limit, removes another with "inherit", and clears the model', async () => {
    createPersonaOnDisk('triage', {
      agentModelId: PERSONA_MODEL,
      resourceBudget: { maxEstimatedCostUsd: 1, maxSteps: 50 },
    });

    await personaMain(['set', 'triage', '--max-steps', 'inherit', '--max-cost', '2', '--clear-model']);

    const stored = readPersonaJson('triage');
    expect(stored).not.toHaveProperty('agentModelId');
    expect(stored.resourceBudget).toEqual({ maxEstimatedCostUsd: 2 });
  });

  it('refuses a bad flag value and an agent name as the model', async () => {
    createPersonaOnDisk('triage');

    await expect(personaMain(['set', 'triage', '--max-steps', '2.5'])).rejects.toThrow('process.exit(1)');
    await expect(personaMain(['set', 'triage', '--model', 'claude-code'])).rejects.toThrow('process.exit(1)');
    await expect(personaMain(['set', 'triage'])).rejects.toThrow('process.exit(1)');
    expect(readPersonaJson('triage')).not.toHaveProperty('agentModelId');
    expect(readPersonaJson('triage')).not.toHaveProperty('resourceBudget');
  });

  it('shows the global default when the persona sets nothing, and flags malformed overrides', async () => {
    createPersonaOnDisk('plain');
    createPersonaOnDisk('broken', { agentModelId: 'codex' });

    await personaMain(['show', 'plain']);
    expect(lines).toContain('Agent model: global default');
    expect(lines).toContain('Resource limits: inherited');

    lines.length = 0;
    await personaMain(['show', 'broken']);
    expect(lines.some((line) => line.includes('Persona "broken" has an invalid agentModelId'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Mux persona picker
// ---------------------------------------------------------------------------

describe('persona snapshots for the pickers', () => {
  it('carry the persona model and flag malformed overrides', () => {
    createPersonaOnDisk('cheap', { agentModelId: PERSONA_MODEL });
    createPersonaOnDisk('plain');
    createPersonaOnDisk('broken', { resourceBudget: { maxSteps: 'many' } });

    const byName = new Map(scanPersonas().map((snapshot) => [snapshot.name as string, snapshot]));

    expect(byName.get('cheap')?.agentModelId).toBe(PERSONA_MODEL);
    expect(byName.get('cheap')?.invalidOverrides).toBeUndefined();
    expect(byName.get('plain')?.agentModelId).toBeUndefined();
    expect(byName.get('broken')?.invalidOverrides).toMatch(/invalid resourceBudget/);
  });
});

// ---------------------------------------------------------------------------
// Claude Code container environment (interactive PTY sessions)
// ---------------------------------------------------------------------------

describe('Claude Code adapter environment', () => {
  // The adapter registry is process-wide (one adapter per agent, in a daemon
  // possibly first used by a persona session) and the adapter captures no
  // configuration: the model always comes from the session.
  const fakeKeys = new Map([['api.anthropic.com', 'sk-ant-fake']]);

  it("carries the session config's model (the persona's, as buildSessionConfig resolved it)", () => {
    const adapter = createClaudeCodeAdapter();
    adapter.buildEnv(createTestConfig(), fakeKeys); // an earlier global-model session

    const env = adapter.buildEnv(withAgentModelId(createTestConfig(), PERSONA_MODEL), fakeKeys);

    expect(env.IRONCURTAIN_MODEL).toBe('claude-haiku-4-5');
  });

  it("runs a batch turn on the session's model, not an earlier session's", () => {
    const adapter = createClaudeCodeAdapter();
    // In a daemon, a persona session may have used the adapter first.
    adapter.buildCommand('task', 'system', { sessionId: 'p', firstTurn: true, agentModelId: PERSONA_MODEL });
    const modelOf = (options: { modelOverride?: string; agentModelId?: string }): string | undefined => {
      const cmd = adapter.buildCommand('task', 'system', { sessionId: 's', firstTurn: true, ...options });
      const at = cmd.indexOf('--model');
      return at === -1 ? undefined : cmd[at + 1];
    };

    expect(modelOf({ agentModelId: GLOBAL_MODEL })).toBe('claude-sonnet-4-6');
    expect(modelOf({ modelOverride: CLI_MODEL, agentModelId: GLOBAL_MODEL })).toBe('gemini-2.5-pro');
    // A session that names no model runs the CLI's default, never the persona's.
    expect(modelOf({})).toBeUndefined();
  });

  it("never carries an earlier session's model into a session whose config names none", () => {
    const adapter = createClaudeCodeAdapter();
    adapter.buildEnv(withAgentModelId(createTestConfig(), PERSONA_MODEL), fakeKeys);

    const env = adapter.buildEnv({ userConfig: { anthropicApiKey: 'sk-test' } } as IronCurtainConfig, fakeKeys);

    expect(env.IRONCURTAIN_MODEL).toBeUndefined();
  });
});
