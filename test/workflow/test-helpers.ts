/**
 * Shared test infrastructure for workflow orchestrator tests.
 *
 * Provides MockSession, response builders, artifact simulation,
 * and polling helpers used across all workflow test files.
 */

import { onTestFinished, vi } from 'vitest';
import { mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  AgentConversationId,
  AgentTurnResult,
  SessionInfo,
  SessionId,
  BudgetStatus,
  ConversationTurn,
  DiagnosticEvent,
  EscalationRequest,
  MessageOrigin,
  SendMessageOptions,
} from '../../src/session/types.js';
import type { Session } from '../../src/session/types.js';
import { createAgentConversationId } from '../../src/session/types.js';
import {
  GLOBAL_PERSONA,
  type WorkflowId,
  type HumanGateRequest,
  type HumanGateEventType,
} from '../../src/workflow/types.js';
import {
  WorkflowOrchestrator,
  type WorkflowOrchestratorDeps,
  type WorkflowTabHandle,
} from '../../src/workflow/orchestrator.js';
import { FileCheckpointStore } from '../../src/workflow/checkpoint.js';
import { USER_CONFIG_DEFAULTS, type ResolvedUserConfig } from '../../src/config/user-config.js';
import type { LlmExchangeCompleted } from '../../src/llm-metrics/types.js';
import { TIMEOUT_BINARY } from '../../src/docker/turn-timeout.js';
import { testUserConfig } from '../helpers/user-config.js';

/**
 * The argv a `container: true` deterministic command was given, without the
 * in-container wall clock (`/usr/bin/timeout --kill-after=<s> <limit>`) that
 * the orchestrator puts in front of every such command. An argv without the
 * prefix is returned as is.
 */
export function unwrapBoundedCommand(argv: readonly string[]): readonly string[] {
  if (argv.length < 3 || argv[0] !== TIMEOUT_BINARY || !argv[1].startsWith('--kill-after=')) return argv;
  return argv.slice(3);
}

// ---------------------------------------------------------------------------
// MockSession
// ---------------------------------------------------------------------------

export type MockResponse = string | AgentTurnResult;
export type ResponseFn = (msg: string) => MockResponse | Promise<MockResponse>;

export class MockSession implements Session {
  readonly sentMessages: string[] = [];
  /** The `origin` each turn was sent with, in order (undefined = the default, a user turn). */
  readonly sentOrigins: Array<MessageOrigin | undefined> = [];
  readonly rotateCalls: number[] = [];
  readonly rotatedIds: AgentConversationId[] = [];
  closed = false;
  private readonly sessionId: string;
  private readonly responseFn: ResponseFn;
  private readonly budgetStatusFn?: () => BudgetStatus;

  constructor(opts: {
    sessionId?: string;
    responses: ResponseFn | MockResponse[];
    /** Overrides `getBudgetStatus()` (default: nothing measured, token tracking unavailable). */
    budgetStatus?: () => BudgetStatus;
  }) {
    this.sessionId = opts.sessionId ?? `mock-${Math.random().toString(36).slice(2, 8)}`;
    this.budgetStatusFn = opts.budgetStatus;
    if (Array.isArray(opts.responses)) {
      let idx = 0;
      const arr = opts.responses;
      this.responseFn = () => {
        if (idx >= arr.length) throw new Error(`MockSession ${this.sessionId} exhausted at call ${idx + 1}`);
        return arr[idx++];
      };
    } else {
      this.responseFn = opts.responses;
    }
  }

  getInfo(): SessionInfo {
    return {
      id: this.sessionId as SessionId,
      status: this.closed ? 'closed' : 'ready',
      turnCount: this.sentMessages.length,
      createdAt: new Date().toISOString(),
    };
  }

  async sendMessage(msg: string, options?: SendMessageOptions): Promise<string> {
    const { text } = await this.sendMessageDetailed(msg, options);
    return text;
  }

  async sendMessageDetailed(msg: string, options?: SendMessageOptions): Promise<AgentTurnResult> {
    this.sentMessages.push(msg);
    this.sentOrigins.push(options?.origin);
    const result = await this.responseFn(msg);
    if (typeof result === 'string') return { text: result, hardFailure: false };
    return result;
  }

  rotateAgentConversationId(): AgentConversationId {
    this.rotateCalls.push(this.sentMessages.length);
    const id = createAgentConversationId();
    this.rotatedIds.push(id);
    return id;
  }

  getHistory(): readonly ConversationTurn[] {
    return [];
  }
  getDiagnosticLog(): readonly DiagnosticEvent[] {
    return [];
  }
  async resolveEscalation(): Promise<void> {
    /* no-op */
  }
  getPendingEscalations(): readonly EscalationRequest[] {
    return [];
  }
  getBudgetStatus(): BudgetStatus {
    if (this.budgetStatusFn) return this.budgetStatusFn();
    return {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      stepCount: 0,
      elapsedSeconds: 0,
      estimatedCostUsd: 0,
      limits: {} as BudgetStatus['limits'],
      lastTurn: null,
      cumulative: {} as BudgetStatus['cumulative'],
      tokenTrackingAvailable: false,
    };
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

// ---------------------------------------------------------------------------
// LLM metrics exchanges (what the MITM publishes on the metrics bus)
// ---------------------------------------------------------------------------

let exchangeCounter = 0;

/**
 * Builds a completed, content-free LLM exchange as the MITM publishes it on
 * the metrics bus. `usage` overrides the normalized counters; attribution
 * defaults to an exact, run-attributed exchange.
 */
export function makeLlmExchange(
  opts: {
    readonly workflowRunId?: string | null;
    readonly bundleId?: string | null;
    readonly sessionId?: string | null;
    readonly quality?: LlmExchangeCompleted['attribution']['quality'];
    readonly protocol?: LlmExchangeCompleted['route']['protocol'];
    readonly usage?: Partial<LlmExchangeCompleted['usage']>;
    readonly exchangeId?: string;
  } = {},
): LlmExchangeCompleted {
  exchangeCounter += 1;
  const protocol = opts.protocol ?? 'anthropic-messages';
  return {
    schemaVersion: 1,
    exchangeId: opts.exchangeId ?? `exchange-${exchangeCounter}`,
    attribution: {
      sessionId: opts.sessionId ?? null,
      agentConversationId: null,
      turnId: null,
      bundleId: opts.bundleId ?? null,
      workflowRunId: opts.workflowRunId ?? null,
      stateId: null,
      personaId: null,
      agentId: protocol === 'anthropic-messages' ? 'claude-code' : 'codex',
      quality: opts.quality ?? 'exact',
    },
    route: {
      logicalProvider: protocol === 'anthropic-messages' ? 'anthropic' : 'chatgpt-codex',
      providerProfileId: null,
      protocol,
      gatewayKind: 'direct',
      clientRouteId: protocol === 'anthropic-messages' ? 'api.anthropic.com' : 'chatgpt.com',
      upstreamRouteId: protocol === 'anthropic-messages' ? 'api.anthropic.com' : 'chatgpt.com',
    },
    identity: {
      requestedModel: { value: null, source: 'not_exposed' },
      forwardedModel: { value: null, source: 'not_exposed' },
      responseModel: { value: null, source: 'not_exposed' },
      servedModel: { value: null, source: 'not_exposed' },
      servedProvider: { value: null, source: 'not_exposed' },
    },
    responseMetadata: {
      providerRequestId: null,
      providerResponseId: null,
      gatewayGenerationId: null,
      actualServiceTier: null,
    },
    request: {
      requestedModel: null,
      streaming: true,
      requestedServiceTier: null,
      reasoningMode: 'unknown',
      reasoningEffort: null,
      thinkingBudgetTokens: null,
      speedMode: null,
      qualityFlags: [],
    },
    outcome: {
      termination: 'stop',
      providerStopReason: 'end_turn',
      responseStatus: 200,
      refusal: false,
      refusalCategory: null,
      refusalSource: 'not_reported',
    },
    usage: {
      inputTokensReported: 100,
      inputTokensTotal: 100,
      inputTokensAccuracy: 'reported_exact',
      inputTokensUncached: 100,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      toolUseInputTokens: null,
      outputTokensReported: 10,
      outputTokenSemantics: 'includes_thinking',
      outputTokensTotal: 10,
      outputTokensAccuracy: 'reported_exact',
      thinkingTokens: null,
      thinkingTokensAccuracy: 'unknown',
      nonThinkingOutputTokens: null,
      nonThinkingOutputTokensAccuracy: 'unknown',
      providerTotalTokens: 110,
      canonicalTotalTokens: 110,
      costUsd: null,
      usageSource: 'test',
      usageCompleteness: 'complete',
      usageSemanticsVersion: 1,
      qualityFlags: [],
      ...opts.usage,
    },
    timing: {
      requestReceivedAt: new Date().toISOString(),
      requestBodyCompleteOffsetMs: null,
      responseHeadersOffsetMs: null,
      firstUpstreamBodyByteOffsetMs: null,
      firstProtocolEventOffsetMs: null,
      firstReasoningEventOffsetMs: null,
      lastReasoningEventOffsetMs: null,
      firstOutputEventOffsetMs: null,
      lastOutputEventOffsetMs: null,
      protocolTerminalOffsetMs: null,
      upstreamResponseEndOffsetMs: null,
      clientDeliveryEndOffsetMs: null,
      clientAborted: false,
    },
    transportAttempts: [],
    gatewayRouteAttempts: [],
    qualityFlags: [],
  };
}

/** A budget status for a mock session whose token usage is (or is not) observable. */
export function mockBudgetStatus(
  opts: {
    readonly tokenTrackingAvailable?: boolean;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly estimatedCostUsd?: number;
    /** Set like a Docker session: host-observed cost beside the agent's own report in `estimatedCostUsd`. */
    readonly hostObservedCostUsd?: number;
    readonly stepCount?: number;
  } = {},
): BudgetStatus {
  const inputTokens = opts.inputTokens ?? 0;
  const outputTokens = opts.outputTokens ?? 0;
  return {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    stepCount: 0,
    elapsedSeconds: 0,
    estimatedCostUsd: 0,
    limits: {} as BudgetStatus['limits'],
    lastTurn: null,
    cumulative: {
      totalInputTokens: inputTokens,
      totalOutputTokens: outputTokens,
      totalTokens: inputTokens + outputTokens,
      stepCount: opts.stepCount ?? 0,
      activeSeconds: 0,
      estimatedCostUsd: opts.estimatedCostUsd ?? 0,
    },
    ...(opts.hostObservedCostUsd !== undefined ? { hostObservedCostUsd: opts.hostObservedCostUsd } : {}),
    tokenTrackingAvailable: opts.tokenTrackingAvailable ?? true,
  };
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

export function approvedResponse(notes = 'done'): string {
  return [
    'I completed the task.',
    '```',
    'agent_status:',
    '  completed: true',
    '  verdict: approved',
    '  confidence: high',
    '  escalation: null',
    '  test_count: null',
    `  notes: "${notes}"`,
    '```',
  ].join('\n');
}

export function rejectedResponse(notes: string): string {
  return [
    'Found issues.',
    '```',
    'agent_status:',
    '  completed: true',
    '  verdict: rejected',
    '  confidence: high',
    '  escalation: null',
    '  test_count: null',
    `  notes: "${notes}"`,
    '```',
  ].join('\n');
}

export function noStatusResponse(): string {
  return 'I did the work. Here is the result.\nNo structured status block.';
}

/**
 * Builds a status block with a given verdict and notes.
 * Used by spike.test.ts which constructs responses with inline status blocks.
 */
export function statusBlock(verdict: string, notes: string): string {
  return [
    '```',
    'agent_status:',
    '  completed: true',
    `  verdict: ${verdict}`,
    '  confidence: high',
    '  escalation: null',
    '  test_count: null',
    `  notes: "${notes}"`,
    '```',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Artifact simulation
// ---------------------------------------------------------------------------

/**
 * Creates artifact directories with placeholder files inside a workflow dir.
 * The `workflowDir` should be the workflow instance directory
 * (e.g., `{baseDir}/{workflowId}`), not the artifact dir itself.
 */
export function simulateArtifacts(workflowDir: string, names: string[]): void {
  for (const name of names) {
    const dir = resolve(workflowDir, 'workspace', '.workflow', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, `${name}.md`), `content for ${name}`);
  }
}

/**
 * Finds the workflow instance directory inside a base dir.
 * The orchestrator creates `{baseDir}/{workflowId}/` directories;
 * this finds the last non-JSON entry.
 */
export function findWorkflowDir(baseDir: string): string {
  const entries = readdirSync(baseDir);
  const dirs = entries.filter((e) => !e.endsWith('.json'));
  if (dirs.length === 0) {
    throw new Error(`No workflow directory found in ${baseDir}`);
  }
  return resolve(baseDir, dirs[dirs.length - 1]);
}

/**
 * Creates a MockSession that simulates artifact creation on each response.
 * Artifacts are created inside the workflow dir found in `baseDir`.
 */
export function createArtifactAwareSession(
  responses: Array<{ text: string; artifacts?: string[] }>,
  baseDir: string,
  sessionId?: string,
): MockSession {
  let index = 0;
  return new MockSession({
    sessionId,
    responses: () => {
      if (index >= responses.length) {
        throw new Error(`MockSession exhausted at call ${index + 1}`);
      }
      const entry = responses[index++];
      if (entry.artifacts) {
        simulateArtifacts(findWorkflowDir(baseDir), entry.artifacts);
      }
      return entry.text;
    },
  });
}

// ---------------------------------------------------------------------------
// Evolve fan-out node fixtures
// ---------------------------------------------------------------------------

/**
 * The engine's `meta_info.step_name` for a recorded node: `step_<4-digit-batch>`
 * for a legacy workers:1 node, or `step_<4-digit-batch>_lane_<k>` for a fan-out
 * lane node. Single source for the format that the Python bridge's STEP_NAME_RE
 * parses, so every node-fixture builder agrees on the exact spelling.
 */
export function evolveStepName(batchIndex: number, lane?: number): string {
  const batch = `step_${String(batchIndex).padStart(4, '0')}`;
  return lane === undefined ? batch : `${batch}_lane_${lane}`;
}

/**
 * Builds ONE engine-DB node object in the shape the bridge reads:
 * `{ id, name, parent, score, results: { eval_score }, analysis, meta_info: { step_name } }`.
 * The single spelling of that shape; the per-builder `name`/`parent`/`analysis`
 * conventions are passed in so each builder keeps its existing fixture text.
 */
export function evolveNode(opts: {
  id: number;
  name: string;
  parent: number[];
  score: number;
  analysis: string;
  batchIndex: number;
  lane?: number;
}): Record<string, unknown> {
  return {
    id: opts.id,
    name: opts.name,
    parent: opts.parent,
    score: opts.score,
    results: { eval_score: opts.score },
    analysis: opts.analysis,
    meta_info: { step_name: evolveStepName(opts.batchIndex, opts.lane) },
  };
}

/**
 * Writes a `{ next_id, nodes }` engine-DB envelope to `<databaseDataDir>/nodes.json`,
 * creating the directory. `pretty` matches the historical formatting each builder
 * used (the bridge parses the file, so whitespace is behavior-irrelevant).
 */
export function writeNodesFile(databaseDataDir: string, nodes: Record<string, unknown>, pretty: boolean): void {
  mkdirSync(databaseDataDir, { recursive: true });
  const nextId = Object.keys(nodes).length;
  const json = pretty
    ? JSON.stringify({ next_id: nextId, nodes }, null, 2)
    : JSON.stringify({ next_id: nextId, nodes });
  writeFileSync(resolve(databaseDataDir, 'nodes.json'), json);
}

/**
 * Writes a `nodes.json` engine-DB fixture with one recorded fan-out lane node
 * per id in `lanes` (each tagged `step_<batchIndex>_lane_<k>`), into the given
 * `database_data` directory. Shared by the bridge test (runDir/database_data)
 * and the orchestrator fan-out test (workspace/.evolve_runs/main/database_data),
 * which differ only in that base dir.
 */
export function writeEvolveLaneNodes(databaseDataDir: string, lanes: readonly number[], batchIndex = 1): void {
  const nodes = Object.fromEntries(
    lanes.map((lane, index) => [
      String(index),
      evolveNode({
        id: index,
        name: `lane-${lane}`,
        parent: lane === 0 ? [] : [lane - 1],
        score: lane + 1,
        analysis: `analysis lane ${lane}`,
        batchIndex,
        lane,
      }),
    ]),
  );
  writeNodesFile(databaseDataDir, nodes, true);
}

// ---------------------------------------------------------------------------
// Test infrastructure helpers
// ---------------------------------------------------------------------------

export function writeDefinitionFile(tmpDir: string, def: { name: string }): string {
  const defPath = resolve(tmpDir, `${def.name}.json`);
  writeFileSync(defPath, JSON.stringify(def));
  return defPath;
}

export function createMockTab(): WorkflowTabHandle {
  return {
    write: vi.fn(),
    setLabel: vi.fn(),
    close: vi.fn(),
  };
}

/** Checkpoint directories handed out in the running test whose removal is already scheduled. */
const checkpointDirsToRemove = new Set<string>();

/**
 * The checkpoint directory for a test whose workflow runs live in `tmpDir`:
 * the sibling `<tmpDir>-ckpt`. Being outside `tmpDir`, a checkpoint there
 * outlives the removal of `tmpDir`, which resume tests rely on, but the
 * test's own `rmSync(tmpDir)` does not remove it either. So this helper
 * removes it when the running test finishes (after the test's `afterEach`
 * hooks, whether the test passed or failed).
 *
 * Must be called while a test runs (its body, `beforeEach` or `afterEach`):
 * outside one there is no test end to remove the directory at, so it throws
 * rather than leak the directory into `os.tmpdir()`. Not for concurrent
 * tests (`it.concurrent`), where the running test is ambiguous.
 */
export function checkpointDirFor(tmpDir: string): string {
  const dir = `${resolve(tmpDir)}-ckpt`;
  if (!checkpointDirsToRemove.has(dir)) {
    try {
      onTestFinished(() => {
        checkpointDirsToRemove.delete(dir);
        rmSync(dir, { recursive: true, force: true });
      });
    } catch (error) {
      throw new Error(
        `The workflow test checkpoint directory ${dir} must be created while a test runs ` +
          '(in the test, its beforeEach or its afterEach), so that it is removed when the test finishes',
        { cause: error },
      );
    }
    checkpointDirsToRemove.add(dir);
  }
  return dir;
}

/** A checkpoint store in {@link checkpointDirFor}`(tmpDir)`, removed when the running test finishes. */
export function createCheckpointStore(tmpDir: string): FileCheckpointStore {
  return new FileCheckpointStore(checkpointDirFor(tmpDir));
}

/**
 * Minimal `ResolvedUserConfig` for orchestrator tests. Defaults memory ON
 * (matches the runtime default) so existing tests' behavior is preserved.
 * Tests that exercise memory-gate semantics override `memory.enabled` via
 * the `createDeps` overrides argument.
 */
export function makeTestUserConfig(overrides: Partial<ResolvedUserConfig> = {}): ResolvedUserConfig {
  return testUserConfig({
    anthropicApiKey: 'test-anthropic-key',
    autoCompact: {
      enabled: true,
      thresholdTokens: 160_000,
      keepRecentMessages: 10,
      summaryModelId: 'anthropic:claude-haiku-4-5',
    },
    auditRedaction: { enabled: false },
    memory: {
      enabled: true,
      autoSave: true,
      llmBaseUrl: undefined,
      llmApiKey: undefined,
      offlineModels: false,
    },
    preferredMode: 'container',
    packageInstall: {
      enabled: true,
      quarantineDays: 2,
      allowedPackages: [],
      deniedPackages: [],
    },
    dockerResources: { memoryMb: null, cpus: null, pidsLimit: USER_CONFIG_DEFAULTS.dockerResources.pidsLimit },
    snapshot: { enabled: true, maxAgeDays: 7, sweepIntervalHours: 24, maxBytes: null },
    ...overrides,
  });
}

/**
 * Orchestrator deps for runs in `tmpDir`. The default checkpoint store is
 * {@link createCheckpointStore}`(tmpDir)`, so call it while a test runs; its
 * directory is removed when that test finishes.
 */
export function createDeps(
  tmpDir: string,
  overrides: Partial<WorkflowOrchestratorDeps> = {},
): WorkflowOrchestratorDeps {
  return {
    createSession: vi.fn(async () => new MockSession({ responses: [] })),
    createWorkflowTab: vi.fn(() => createMockTab()),
    raiseGate: vi.fn(),
    dismissGate: vi.fn(),
    baseDir: tmpDir,
    checkpointStore: createCheckpointStore(tmpDir),
    userConfig: makeTestUserConfig(),
    // Supplied workspaces are still checked against the validator's fixed
    // roots (home, IronCurtain home, package config); an explicit empty
    // list keeps tests from falling back to loadConfig().
    protectedPaths: [],
    // Default no-op control-plane stubs so shared-container tests that
    // don't assert on these calls can omit them. Tests that do assert
    // (see orchestrator-policy-cycling.test.ts) override with `vi.fn(...)`.
    startWorkflowControlServer: async () => {},
    loadPolicyRpc: async () => {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Persona stub helpers
// ---------------------------------------------------------------------------

/**
 * Extracts all unique persona names from a WorkflowDefinition,
 * excluding "global" (which does not need a directory).
 */
function collectPersonaNames(definition: { states: Record<string, { type: string; persona?: string }> }): string[] {
  const names = new Set<string>();
  for (const state of Object.values(definition.states)) {
    if (state.type === 'agent' && state.persona && state.persona !== GLOBAL_PERSONA) {
      names.add(state.persona);
    }
  }
  return [...names];
}

/**
 * Creates stub persona directories so that `validatePersonas()` passes
 * for test workflow definitions. Uses a sibling directory `{baseDir}-home`
 * as IRONCURTAIN_HOME to avoid polluting the orchestrator's baseDir
 * (which uses the same tmpDir and breaks `findWorkflowDir`).
 *
 * Returns a cleanup function that restores the original env var.
 */
export function stubPersonasForTest(
  baseDir: string,
  ...definitions: Array<{ states: Record<string, { type: string; persona?: string }> }>
): () => void {
  const originalHome = process.env.IRONCURTAIN_HOME;
  const homeDir = `${baseDir}-home`;
  mkdirSync(homeDir, { recursive: true });
  process.env.IRONCURTAIN_HOME = homeDir;

  const allNames = new Set<string>();
  for (const def of definitions) {
    for (const name of collectPersonaNames(def)) {
      allNames.add(name);
    }
  }

  for (const name of allNames) {
    const personaDir = resolve(homeDir, 'personas', name);
    mkdirSync(personaDir, { recursive: true });
    writeFileSync(
      resolve(personaDir, 'persona.json'),
      JSON.stringify({ name, description: 'test stub', createdAt: '2026-01-01T00:00:00.000Z' }),
    );
  }

  return () => {
    if (originalHome === undefined) {
      delete process.env.IRONCURTAIN_HOME;
    } else {
      process.env.IRONCURTAIN_HOME = originalHome;
    }
    rmSync(homeDir, { recursive: true, force: true });
  };
}

// ---------------------------------------------------------------------------
// Gate helpers
// ---------------------------------------------------------------------------

/**
 * Resolves the gate `workflowId` is waiting at the way every real client
 * does: read the active raise's per-raise `gateId` from status, then submit
 * the decision bound to it. Throws when the workflow is not waiting, so a
 * test that races ahead of the gate fails loudly instead of being silently
 * ignored. Declares the `cli` channel (an in-process decider).
 */
export function resolveActiveGate(
  orchestrator: WorkflowOrchestrator,
  workflowId: WorkflowId,
  event: { type: HumanGateEventType; prompt?: string },
): void {
  const status = orchestrator.getStatus(workflowId);
  if (status?.phase !== 'waiting_human') {
    throw new Error(`Workflow ${workflowId} is not waiting at a gate (status: ${JSON.stringify(status)})`);
  }
  orchestrator.resolveGate(workflowId, { gateId: status.gate.gateId, resolvedBy: 'cli', ...event });
}

// ---------------------------------------------------------------------------
// Polling helpers
// ---------------------------------------------------------------------------

export async function waitForGate(
  raiseGateMock: ReturnType<typeof vi.fn>,
  expectedCount: number,
  timeoutMs = 5000,
): Promise<HumanGateRequest[]> {
  const start = Date.now();
  while (raiseGateMock.mock.calls.length < expectedCount) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${expectedCount} gate(s), got ${raiseGateMock.mock.calls.length}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  return raiseGateMock.mock.calls.map((c: unknown[]) => c[0] as HumanGateRequest);
}

export async function waitForCompletion(
  orchestrator: WorkflowOrchestrator,
  workflowId: WorkflowId,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    const status = orchestrator.getStatus(workflowId);
    if (status?.phase === 'completed' || status?.phase === 'failed' || status?.phase === 'aborted') {
      return;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for workflow completion, current status: ${JSON.stringify(status)}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

export async function waitForGateOrCompletion(
  orchestrator: WorkflowOrchestrator,
  workflowId: WorkflowId,
  timeoutMs = 5000,
): Promise<'gate' | 'done'> {
  const start = Date.now();
  for (;;) {
    const status = orchestrator.getStatus(workflowId);
    if (!status) return 'done';
    if (status.phase === 'completed' || status.phase === 'failed' || status.phase === 'aborted') return 'done';
    if (status.phase === 'waiting_human') return 'gate';
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for gate or completion, status: ${JSON.stringify(status)}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}
