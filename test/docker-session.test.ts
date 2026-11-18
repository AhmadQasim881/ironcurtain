import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  appendFileSync,
  readFileSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AuditLogTailer } from '../src/docker/audit-log-tailer.js';
import { DockerAgentSession, type DockerAgentSessionDeps } from '../src/docker/docker-agent-session.js';
import type { DockerInfrastructure } from '../src/docker/docker-infrastructure.js';
import type { DockerProxy } from '../src/docker/code-mode-proxy.js';
import type { MitmProxy } from '../src/docker/mitm-proxy.js';
import type { AgentAdapter, AgentResponse, ConversationStateConfig } from '../src/docker/agent-adapter.js';
import type { ContainerRuntime, DockerExecResult } from '../src/docker/types.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import type { AgentConversationId, DiagnosticEvent, EscalationRequest } from '../src/session/types.js';
import { createClaudeCodeAdapter } from '../src/docker/adapters/claude-code.js';
import { getLlmMetricsEventBus } from '../src/llm-metrics/event-bus.js';
import { makeNormalizedUsage } from '../src/llm-metrics/normalization.js';
import type { MetricsInvocationContext } from '../src/llm-metrics/attribution-registry.js';
import type { LlmExchangeCompleted } from '../src/llm-metrics/types.js';
import { getInternalNetworkName } from '../src/docker/platform.js';
import { BudgetExhaustedError } from '../src/types/errors.js';
import * as logger from '../src/logger.js';
import { SESSION_TURN_HISTORY_LIMIT } from '../src/session/bounded-log.js';
import { createDockerManager } from '../src/docker/docker-manager.js';
import { TURN_KILL_SWEEP_SCRIPT } from '../src/docker/turn-timeout.js';
import type {
  HostMountPrivilegeScanReport,
  HostMountPrivilegeScanResult,
  HostMountPrivilegeScanner,
  PrivilegedEntry,
  UnstrippedEntry,
} from '../src/docker/host-mount-privilege-scan.js';
import {
  LOCAL_TURN_PROCESS_TESTS_SUPPORTED,
  isProcessAlive,
  localDockerExec,
  waitUntilProcessGone,
} from './helpers/local-container-exec.js';
import {
  createMockAdapter,
  createMockCA,
  createMockDocker,
  createMockMitmProxy,
  createMockProxy,
  scriptedExec,
} from './helpers/docker-mocks.js';

// --- AuditLogTailer tests ---

describe('AuditLogTailer', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'audit-tailer-test-'));
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('emits diagnostic events for new audit entries', () => {
    const logPath = join(tempDir, 'audit.jsonl');
    writeFileSync(logPath, '');

    const events: DiagnosticEvent[] = [];
    const tailer = new AuditLogTailer(logPath, (event) => events.push(event));

    const entry = {
      serverName: 'filesystem',
      toolName: 'read_file',
      arguments: { path: '/workspace/foo.txt' },
      result: { status: 'allowed' },
    };
    appendFileSync(logPath, JSON.stringify(entry) + '\n');

    // Call readNewEntries directly to avoid fs notification timing issues
    tailer.readNewEntries();

    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event.kind).toBe('tool_call');
    if (event.kind === 'tool_call') {
      expect(event.toolName).toBe('filesystem.read_file');
      expect(event.preview).toContain('allowed');
    }

    tailer.stop();
  });

  it('handles multiple entries in a single write', () => {
    const logPath = join(tempDir, 'audit.jsonl');
    writeFileSync(logPath, '');

    const events: DiagnosticEvent[] = [];
    const tailer = new AuditLogTailer(logPath, (event) => events.push(event));

    const entry1 = {
      serverName: 'filesystem',
      toolName: 'read_file',
      arguments: { path: '/a.txt' },
      result: { status: 'allowed' },
    };
    const entry2 = {
      serverName: 'git',
      toolName: 'git_status',
      arguments: {},
      result: { status: 'denied' },
    };
    appendFileSync(logPath, JSON.stringify(entry1) + '\n' + JSON.stringify(entry2) + '\n');

    tailer.readNewEntries();

    expect(events).toHaveLength(2);
    if (events[0].kind === 'tool_call') {
      expect(events[0].toolName).toBe('filesystem.read_file');
    }
    if (events[1].kind === 'tool_call') {
      expect(events[1].toolName).toBe('git.git_status');
    }

    tailer.stop();
  });

  it('ignores malformed JSON lines', () => {
    const logPath = join(tempDir, 'audit.jsonl');
    writeFileSync(logPath, '');

    const events: DiagnosticEvent[] = [];
    const tailer = new AuditLogTailer(logPath, (event) => events.push(event));

    appendFileSync(logPath, 'not valid json\n');

    tailer.readNewEntries();

    // Malformed line should be silently skipped
    expect(events).toHaveLength(0);

    tailer.stop();
  });

  it('truncates long argument previews', () => {
    const logPath = join(tempDir, 'audit.jsonl');
    writeFileSync(logPath, '');

    const events: DiagnosticEvent[] = [];
    const tailer = new AuditLogTailer(logPath, (event) => events.push(event));

    const longArg = 'x'.repeat(200);
    const entry = {
      serverName: 'fs',
      toolName: 'write',
      arguments: { content: longArg },
      result: { status: 'allowed' },
    };
    appendFileSync(logPath, JSON.stringify(entry) + '\n');

    tailer.readNewEntries();

    expect(events).toHaveLength(1);
    if (events[0].kind === 'tool_call') {
      // Preview is truncated to 80 chars of the JSON args + "..."
      expect(events[0].preview).toContain('...');
    }

    tailer.stop();
  });
});

// --- DockerAgentSession tests ---

/** Options for overriding fields on the mock DockerInfrastructure bundle. */
interface MockInfraOptions {
  readonly sessionId?: string;
  readonly sessionDir: string;
  readonly sandboxDir: string;
  readonly escalationDir: string;
  readonly auditLogPath: string;
  readonly tempDir: string;
  readonly adapter?: AgentAdapter;
  readonly docker?: ContainerRuntime;
  readonly proxy?: DockerProxy;
  readonly mitmProxy?: MitmProxy;
  readonly useTcp?: boolean;
  readonly containerId?: string;
  readonly containerName?: string;
  readonly sidecarContainerId?: string;
  readonly internalNetwork?: string;
  readonly conversationStateDir?: string;
  readonly conversationStateConfig?: ConversationStateConfig;
}

/**
 * Builds a mock DockerInfrastructure bundle suitable for DockerAgentSession
 * tests. Representing a post-`createDockerInfrastructure()` state: the main
 * container is already "created" and "started"; the session only drives it.
 */
function createMockInfra(opts: MockInfraOptions): DockerInfrastructure {
  const sessionId = opts.sessionId ?? 'test-session-id';
  const shortId = sessionId.substring(0, 12);
  const useTcp = opts.useTcp ?? false;
  const mitmProxy: MitmProxy =
    opts.mitmProxy ??
    (useTcp
      ? {
          ...createMockMitmProxy(),
          async start() {
            return { port: 8443 };
          },
        }
      : createMockMitmProxy());
  const proxy = opts.proxy ?? createMockProxy(join(opts.sessionDir, 'proxy.sock'), useTcp ? 9123 : undefined);
  const mitmAddr: DockerInfrastructure['mitmAddr'] = useTcp
    ? { port: 8443 }
    : { socketPath: '/tmp/test-mitm-proxy.sock' };
  return {
    // Single-session invariant: bundleId reuses the sessionId value.
    bundleId: sessionId as import('../src/session/types.js').BundleId,
    bundleDir: opts.sessionDir,
    workspaceDir: opts.sandboxDir,
    escalationDir: opts.escalationDir,
    auditLogPath: opts.auditLogPath,
    proxy,
    mitmProxy,
    docker: opts.docker ?? createMockDocker(),
    adapter: opts.adapter ?? createMockAdapter(),
    ca: createMockCA(opts.tempDir),
    fakeKeys: new Map([['api.test.com', 'sk-test-fake-key']]),
    orientationDir: join(opts.sessionDir, 'orientation'),
    systemPrompt: 'You are a test agent.',
    image: 'ironcurtain-claude-code:latest',
    runtimeKind: 'docker',
    topology: useTcp ? 'tcp-sidecar' : 'uds',
    useTcp,
    socketsDir: join(opts.sessionDir, 'sockets'),
    mitmAddr,
    metricsProxyUrl: 'http://127.0.0.1:18080',
    authKind: 'apikey',
    providerProfileId: 'native',
    conversationStateDir: opts.conversationStateDir,
    conversationStateConfig: opts.conversationStateConfig,
    containerId: opts.containerId ?? 'container-abc123',
    containerName: opts.containerName ?? `ironcurtain-${shortId}`,
    sidecarContainerId: opts.sidecarContainerId,
    internalNetwork: opts.internalNetwork,
    setTokenSessionId: () => {},
    restageSkills: () => {},
    beginCaptureSession: () => {},
    endCaptureSession: async () => {},
  };
}

function metricsExchange(context: MetricsInvocationContext, thinkingTokens: number | null = 2): LlmExchangeCompleted {
  return {
    schemaVersion: 1,
    exchangeId: `exchange-${context.turnId ?? 'session'}`,
    attribution: {
      sessionId: context.sessionId,
      agentConversationId: context.agentConversationId ?? null,
      turnId: context.turnId ?? null,
      bundleId: context.bundleId ?? null,
      workflowRunId: context.workflowRunId ?? null,
      stateId: context.stateId ?? null,
      personaId: context.personaId ?? null,
      agentId: context.agentId ?? null,
      quality: 'exact',
    },
    route: {
      logicalProvider: 'anthropic',
      providerProfileId: 'native',
      protocol: 'anthropic-messages',
      gatewayKind: 'direct',
      clientRouteId: null,
      upstreamRouteId: null,
    },
    identity: {
      requestedModel: { value: 'claude-test', source: 'request' },
      forwardedModel: { value: 'claude-test', source: 'forwarded_request' },
      responseModel: { value: 'claude-test', source: 'protocol_response' },
      servedModel: { value: 'claude-test', source: 'protocol_response_direct' },
      servedProvider: { value: 'anthropic', source: 'configured_route' },
    },
    responseMetadata: {
      providerRequestId: null,
      providerResponseId: 'message-test',
      gatewayGenerationId: null,
      actualServiceTier: null,
    },
    request: {
      requestedModel: 'claude-test',
      streaming: true,
      requestedServiceTier: null,
      reasoningMode: 'enabled',
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
      inputTokensReported: 10,
      inputTokensTotal: 15,
      inputTokensAccuracy: 'derived_exact',
      inputTokensUncached: 10,
      cacheReadInputTokens: 5,
      cacheWriteInputTokens: 0,
      toolUseInputTokens: null,
      outputTokensReported: 7,
      outputTokenSemantics: 'includes_thinking',
      outputTokensTotal: 7,
      outputTokensAccuracy: 'reported_exact',
      thinkingTokens,
      thinkingTokensAccuracy: thinkingTokens === null ? 'unknown' : 'reported_exact',
      nonThinkingOutputTokens: thinkingTokens === null ? null : 7 - thinkingTokens,
      nonThinkingOutputTokensAccuracy: thinkingTokens === null ? 'unknown' : 'derived_exact',
      providerTotalTokens: 22,
      canonicalTotalTokens: 22,
      costUsd: 0.01,
      usageSource: 'test',
      usageCompleteness: 'complete',
      usageSemanticsVersion: 1,
      qualityFlags: [],
    },
    timing: {
      requestReceivedAt: new Date().toISOString(),
      requestBodyCompleteOffsetMs: 1,
      responseHeadersOffsetMs: 2,
      firstUpstreamBodyByteOffsetMs: 2.5,
      firstProtocolEventOffsetMs: 3,
      firstReasoningEventOffsetMs: null,
      lastReasoningEventOffsetMs: null,
      firstOutputEventOffsetMs: 3,
      lastOutputEventOffsetMs: 4,
      protocolTerminalOffsetMs: 4,
      upstreamResponseEndOffsetMs: 5,
      clientDeliveryEndOffsetMs: 5,
      clientAborted: false,
    },
    transportAttempts: [],
    gatewayRouteAttempts: [],
    qualityFlags: [],
  };
}

function createTestDeps(tempDir: string): DockerAgentSessionDeps {
  const sessionDir = join(tempDir, 'session');
  const sandboxDir = join(tempDir, 'sandbox');
  const escalationDir = join(tempDir, 'escalations');
  const auditLogPath = join(tempDir, 'audit.jsonl');

  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(sandboxDir, { recursive: true });
  mkdirSync(escalationDir, { recursive: true });

  const config = {
    mcpServers: {},
    userConfig: {
      anthropicApiKey: 'sk-test',
      resourceBudget: {
        maxTotalTokens: null,
        maxSteps: null,
        maxSessionSeconds: null,
        maxEstimatedCostUsd: null,
      },
      escalationTimeoutSeconds: 120,
      auditRedaction: { enabled: true },
    },
  } as unknown as IronCurtainConfig;

  const infra = createMockInfra({
    tempDir,
    sessionDir,
    sandboxDir,
    escalationDir,
    auditLogPath,
  });

  return {
    config,
    sessionId: 'test-session-id' as import('../src/session/types.js').SessionId,
    agentConversationId: '00000000-1111-2222-3333-444444444444' as AgentConversationId,
    infra,
    ownsInfra: true,
  };
}

/** Returns `deps` with the given resource-budget fields overridden. */
function withBudget(
  deps: DockerAgentSessionDeps,
  budget: Partial<IronCurtainConfig['userConfig']['resourceBudget']>,
): DockerAgentSessionDeps {
  return {
    ...deps,
    config: {
      ...deps.config,
      userConfig: {
        ...deps.config.userConfig,
        resourceBudget: { ...deps.config.userConfig.resourceBudget, ...budget },
      },
    },
  };
}

describe('DockerAgentSession', () => {
  let tempDir: string;
  let session: DockerAgentSession | undefined;
  let deps: DockerAgentSessionDeps;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'docker-session-test-'));
    deps = createTestDeps(tempDir);
  });

  afterEach(async () => {
    // Restore real timers before cleanup so async operations in close() work
    vi.useRealTimers();
    // Ensure session is closed to stop intervals
    try {
      await session?.close();
    } catch {
      // Ignore close errors in cleanup
    }
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('initializes and reaches ready status', async () => {
    session = new DockerAgentSession(deps);
    await session.initialize();

    const info = session.getInfo();
    expect(info.status).toBe('ready');
    expect(info.turnCount).toBe(0);
    expect(info.id).toBe('test-session-id');
  });

  it('sendMessage executes docker exec and returns response', async () => {
    session = new DockerAgentSession(deps);
    await session.initialize();

    const response = await session.sendMessage('Fix the bug');

    expect(response).toBe('Task completed successfully');
    expect(session.getInfo().turnCount).toBe(1);
    expect(session.getInfo().status).toBe('ready');
  });

  it('runs the turn unwrapped with no host deadline when the per-turn timeout is disabled', async () => {
    session = new DockerAgentSession(deps);
    await session.initialize();
    const exec = vi.spyOn(deps.infra.docker, 'exec');

    await session.sendMessage('Work without a timeout');

    expect(exec).toHaveBeenCalledWith(
      deps.infra.containerId,
      ['test-agent', '--prompt', 'You are a test agent.', 'Work without a timeout'],
      0,
      undefined,
      undefined,
      undefined,
    );
  });

  it('enforces a 30s per-turn timeout inside the container, with a later host backstop', async () => {
    deps = withBudget(deps, { maxSessionSeconds: 30 });
    session = new DockerAgentSession(deps);
    await session.initialize();
    const exec = vi.spyOn(deps.infra.docker, 'exec');

    await session.sendMessage('Work with the configured timeout');

    expect(exec).toHaveBeenCalledOnce();
    const [containerId, command, timeoutMs, execUser, workdir, environment] = exec.mock.calls[0];
    expect(containerId).toBe(deps.infra.containerId);
    // coreutils timeout signals the turn's whole process group in the
    // container; the host deadline only backs it up (DINF-8).
    expect(command).toEqual([
      '/usr/bin/timeout',
      '--kill-after=10',
      '30',
      'test-agent',
      '--prompt',
      'You are a test agent.',
      'Work with the configured timeout',
    ]);
    expect(timeoutMs).toBe(30_000 + 10_000 + 15_000);
    expect(execUser).toBeUndefined();
    expect(workdir).toBeUndefined();
    expect(environment).toEqual({ IRONCURTAIN_TURN_ID: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  });

  it('records conversation turns', async () => {
    session = new DockerAgentSession(deps);
    await session.initialize();

    await session.sendMessage('First message');
    await session.sendMessage('Second message');

    const history = session.getHistory();
    expect(history).toHaveLength(2);
    expect(history[0].turnNumber).toBe(1);
    expect(history[0].userMessage).toBe('First message');
    expect(history[0].assistantResponse).toBe('Task completed successfully');
    expect(history[1].turnNumber).toBe(2);
    expect(history[1].userMessage).toBe('Second message');
  });

  it('getBudgetStatus returns tokenTrackingAvailable: false', async () => {
    session = new DockerAgentSession(deps);
    await session.initialize();

    const budget = session.getBudgetStatus();
    expect(budget.tokenTrackingAvailable).toBe(false);
    expect(budget.totalTokens).toBe(0);
    expect(budget.estimatedCostUsd).toBe(0);
    // Nothing has reported a cost: renderers must say "unknown", not $0.00.
    expect(budget.costSource).toBe('unknown');
  });

  describe('cost sources', () => {
    /** A metrics exchange of this turn whose cost is `cost` (null: unknown), as a list-price estimate. */
    function pricedExchange(context: MetricsInvocationContext, id: string, cost: number | null): LlmExchangeCompleted {
      const base = metricsExchange(context);
      return {
        ...base,
        exchangeId: `${base.exchangeId}-${id}`,
        usage: {
          ...base.usage,
          costUsd: null,
          estimatedCostUsd: cost,
          costSource: cost === null ? null : 'list_price',
          pricingVersion: cost === null ? null : '2026-11-11',
        },
      };
    }

    function withExchanges(costs: readonly (number | null)[], agentCostUsd?: number): DockerAgentSessionDeps {
      const adapter = createMockAdapter();
      adapter.extractResponse = (): AgentResponse => ({
        text: 'Done',
        ...(agentCostUsd !== undefined ? { costUsd: agentCostUsd } : {}),
      });
      const beginMetricsInvocation = (context: MetricsInvocationContext) => ({
        proxyUrl: 'http://ironcurtain:opaque@test-proxy.invalid',
        end: async () => {
          costs.forEach((cost, index) => getLlmMetricsEventBus().publish(pricedExchange(context, String(index), cost)));
        },
      });
      return {
        ...deps,
        agentConversationId: 'conversation-test' as import('../src/session/types.js').AgentConversationId,
        infra: { ...deps.infra, adapter, beginMetricsInvocation },
      };
    }

    it('reports the host list-price cost when every observed exchange carried one, over the agent report', async () => {
      session = new DockerAgentSession(withExchanges([0.02, 0.03], 0.42));
      await session.initialize();

      await session.sendMessage('Turn');

      const budget = session.getBudgetStatus();
      expect(budget.costSource).toBe('observed');
      expect(budget.estimatedCostUsd).toBeCloseTo(0.05, 12);
      expect(budget.cumulative.estimatedCostUsd).toBeCloseTo(0.05, 12);
      expect(budget.lastTurn?.estimatedCostUsd).toBeCloseTo(0.05, 12);
    });

    it('prefers a complete agent report over a known-partial host sum', async () => {
      session = new DockerAgentSession(withExchanges([0.02, null], 0.42));
      await session.initialize();

      await session.sendMessage('Turn');

      expect(session.getBudgetStatus()).toMatchObject({ costSource: 'reported', estimatedCostUsd: 0.42 });
    });

    it('reports a partial host sum as a lower bound when the agent reports nothing', async () => {
      session = new DockerAgentSession(withExchanges([0.02, null]));
      await session.initialize();

      await session.sendMessage('Turn');

      expect(session.getBudgetStatus()).toMatchObject({ costSource: 'partial', estimatedCostUsd: 0.02 });
    });

    it('reports unknown, not $0.00, when no exchange and no agent report carried a cost', async () => {
      session = new DockerAgentSession(withExchanges([null]));
      await session.initialize();

      await session.sendMessage('Turn');

      expect(session.getBudgetStatus()).toMatchObject({ costSource: 'unknown', estimatedCostUsd: 0 });
    });

    it.each([Number.NaN, -1, Number.POSITIVE_INFINITY])('ignores an invalid agent cost report (%s)', async (value) => {
      session = new DockerAgentSession(withExchanges([], value));
      await session.initialize();

      await session.sendMessage('Turn');

      expect(session.getBudgetStatus()).toMatchObject({ costSource: 'unknown', estimatedCostUsd: 0 });
    });

    it('refuses the next turn on host list-price cost, whatever cost the display shows', async () => {
      // One exchange is host-priced at $0.60, the other cannot be priced, and
      // the agent claims $0.01 in total. The display prefers the complete
      // agent report over the known-partial host sum; the cap does not.
      session = new DockerAgentSession(withBudget(withExchanges([0.6, null], 0.01), { maxEstimatedCostUsd: 0.5 }));
      await session.initialize();

      await session.sendMessage('first');

      const status = session.getBudgetStatus();
      expect(status).toMatchObject({ costSource: 'reported', estimatedCostUsd: 0.01 });
      expect(status.hostObservedCostUsd).toBeCloseTo(0.6, 12);
      await expect(session.sendMessage('second')).rejects.toMatchObject({
        code: 'BUDGET_EXHAUSTED',
        dimension: 'cost',
        message: expect.stringContaining('$0.60 / $0.50 observed at the proxy'),
      });
    });
  });

  it('accounts exact MITM exchanges and refuses the next turn once observed usage exhausts the token budget', async () => {
    const end = vi.fn(async () => {});
    const events: DiagnosticEvent[] = [];
    const beginMetricsInvocation = vi.fn((context: MetricsInvocationContext) => ({
      proxyUrl: 'http://ironcurtain:opaque@test-proxy.invalid',
      end: async () => {
        getLlmMetricsEventBus().publish(metricsExchange(context));
        await end();
      },
    }));
    deps = {
      ...deps,
      agentConversationId: 'conversation-test' as import('../src/session/types.js').AgentConversationId,
      metricsStateId: 'review',
      metricsPersonaId: 'security-reviewer',
      metricsWorkflowRunId: 'workflow-exact',
      config: {
        ...deps.config,
        userConfig: {
          ...deps.config.userConfig,
          resourceBudget: { ...deps.config.userConfig.resourceBudget, maxTotalTokens: 1 },
        },
      },
      infra: { ...deps.infra, beginMetricsInvocation },
      onDiagnostic: (event) => events.push(event),
    };
    session = new DockerAgentSession(deps);
    await session.initialize();
    const exec = vi.spyOn(deps.infra.docker, 'exec');

    await expect(session.sendMessage('Count this turn')).resolves.toBe('Task completed successfully');

    expect(beginMetricsInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'test-session-id',
        agentConversationId: 'conversation-test',
        bundleId: 'test-session-id',
        stateId: 'review',
        personaId: 'security-reviewer',
        workflowRunId: 'workflow-exact',
        turnId: expect.any(String),
      }),
    );
    expect(end).toHaveBeenCalledOnce();
    expect(session.getHistory()[0]?.usage).toMatchObject({
      promptTokens: 15,
      completionTokens: 7,
      thinkingTokens: 2,
      totalTokens: 22,
      usageCompleteness: 'complete',
      observedExchanges: 1,
    });
    expect(session.getBudgetStatus()).toMatchObject({
      totalInputTokens: 15,
      totalOutputTokens: 7,
      totalTokens: 22,
      tokenTrackingAvailable: true,
      tokenTrackingStatus: 'complete',
      observedExchanges: 1,
    });

    // 22 observed tokens against a limit of 1: the between-turn check
    // refuses the next turn before anything runs in the container.
    const refused = session.sendMessage('One turn too many');
    await expect(refused).rejects.toBeInstanceOf(BudgetExhaustedError);
    await expect(refused).rejects.toMatchObject({
      code: 'BUDGET_EXHAUSTED',
      dimension: 'tokens',
      message: expect.stringContaining('22 / 1 tokens observed at the proxy'),
    });
    expect(exec).toHaveBeenCalledOnce();
    expect(beginMetricsInvocation).toHaveBeenCalledOnce();
    expect(events).toContainEqual(expect.objectContaining({ kind: 'budget_exhausted', dimension: 'tokens' }));
    expect(session.getInfo()).toMatchObject({ status: 'ready', turnCount: 1 });
  });

  it('refuses the next turn once the step budget counts every completed turn', async () => {
    deps = withBudget(deps, { maxSteps: 2 });
    session = new DockerAgentSession(deps);
    await session.initialize();

    await session.sendMessage('one');
    await session.sendMessage('two');
    await expect(session.sendMessage('three')).rejects.toMatchObject({
      code: 'BUDGET_EXHAUSTED',
      dimension: 'steps',
    });
    expect(session.getHistory()).toHaveLength(2);
  });

  it('maps the step budget onto the agent CLI turn cap for every invocation', async () => {
    const adapter = createMockAdapter();
    const buildCommand = vi.spyOn(adapter, 'buildCommand');
    deps = withBudget({ ...deps, infra: { ...deps.infra, adapter } }, { maxSteps: 7 });
    session = new DockerAgentSession(deps);
    await session.initialize();

    await session.sendMessage('capped');

    expect(buildCommand.mock.calls[0][2]).toMatchObject({ maxAgentTurns: 7 });
  });

  describe('agent model of a Claude Code turn (WP-126)', () => {
    // The adapter registry is process-wide: in a daemon, a persona session
    // (whose config carries the persona's agentModelId) may have used the
    // one Claude Code adapter first. A later session must still run its own
    // model, and its override over that.
    const earlierPersonaModel = 'anthropic:claude-haiku-4-5'; // an earlier persona session's model
    const sessionModel = 'anthropic:claude-sonnet-4-6'; // this session's (global) model

    async function modelOfFirstTurn(extra: Partial<DockerAgentSessionDeps>): Promise<string | undefined> {
      const exec = vi.fn(() => Promise.resolve({ exitCode: 0, stdout: '{"result":"ok"}', stderr: '' }));
      const adapter = createClaudeCodeAdapter();
      // The earlier persona session's turn on the same adapter instance.
      adapter.buildCommand('earlier task', 'system', {
        sessionId: 'earlier',
        firstTurn: true,
        agentModelId: earlierPersonaModel,
      });
      session = new DockerAgentSession({
        ...deps,
        agentConversationId: 'aaaaaaaa-1111-4222-8333-444444444444' as AgentConversationId,
        config: { ...deps.config, agentModelId: sessionModel },
        infra: {
          ...deps.infra,
          docker: { ...deps.infra.docker, exec },
          adapter,
        },
        ...extra,
      });
      await session.initialize();
      await session.sendMessage('which model?').catch(() => undefined);
      const command = exec.mock.calls
        .map((call: unknown[]) => call[1] as readonly string[])
        .find((c) => c[0] === 'claude');
      if (command === undefined) throw new Error('no claude turn was executed');
      const at = command.indexOf('--model');
      return at === -1 ? undefined : command[at + 1];
    }

    it("runs the session config's model, not an earlier session's", async () => {
      expect(await modelOfFirstTurn({})).toBe('claude-sonnet-4-6');
    });

    it("runs the session's model override (--model, a workflow model or the persona's) over both", async () => {
      expect(await modelOfFirstTurn({ agentModelOverride: 'anthropic:claude-opus-4-6' })).toBe('claude-opus-4-6');
    });
  });

  it('passes no agent turn cap when the step budget is disabled', async () => {
    const adapter = createMockAdapter();
    const buildCommand = vi.spyOn(adapter, 'buildCommand');
    session = new DockerAgentSession({ ...deps, infra: { ...deps.infra, adapter } });
    await session.initialize();

    await session.sendMessage('uncapped');

    expect(buildCommand.mock.calls[0][2]).not.toHaveProperty('maxAgentTurns');
  });

  it.each([-1, 0, 1e9, Number.POSITIVE_INFINITY, Number.NaN])(
    'an agent-printed total_cost_usd of %s changes no budget decision',
    async (cliCost) => {
      const adapter = createMockAdapter();
      adapter.extractResponse = (): AgentResponse => ({ text: 'Done', costUsd: cliCost });
      deps = withBudget({ ...deps, infra: { ...deps.infra, adapter } }, { maxEstimatedCostUsd: 0.5 });
      session = new DockerAgentSession(deps);
      await session.initialize();

      await session.sendMessage('first');
      // Host-observed cost is still zero, so the agent's own report neither
      // trips the cap (1e9, Infinity) nor hides spending (-1).
      await expect(session.sendMessage('second')).resolves.toBe('Done');

      const status = session.getBudgetStatus();
      expect(status.hostObservedCostUsd).toBe(0);
      // Display hygiene: a negative or non-finite report is never shown.
      expect(Number.isFinite(status.cumulative.estimatedCostUsd)).toBe(true);
      expect(status.cumulative.estimatedCostUsd).toBeGreaterThanOrEqual(0);
    },
  );

  it('enforces the cost cap on host-observed cost even when the agent prints total_cost_usd -1', async () => {
    const adapter = createMockAdapter();
    adapter.extractResponse = (): AgentResponse => ({ text: 'Done', costUsd: -1 });
    const beginMetricsInvocation = (context: MetricsInvocationContext) => ({
      proxyUrl: 'http://ironcurtain:opaque@test-proxy.invalid',
      end: async () => {
        // metricsExchange prices each exchange at $0.01 on the host.
        getLlmMetricsEventBus().publish(metricsExchange(context));
      },
    });
    deps = withBudget(
      {
        ...deps,
        agentConversationId: 'conversation-test' as import('../src/session/types.js').AgentConversationId,
        infra: { ...deps.infra, adapter, beginMetricsInvocation },
      },
      { maxEstimatedCostUsd: 0.01 },
    );
    session = new DockerAgentSession(deps);
    await session.initialize();

    await session.sendMessage('first');

    await expect(session.sendMessage('second')).rejects.toMatchObject({
      code: 'BUDGET_EXHAUSTED',
      dimension: 'cost',
    });
  });

  it('reports partly measured usage as lower bounds and unmeasured exchanges separately', async () => {
    const beginMetricsInvocation = (context: MetricsInvocationContext) => ({
      proxyUrl: 'http://ironcurtain:opaque@test-proxy.invalid',
      end: async () => {
        const measured = metricsExchange(context);
        // The output count never arrived: input is known, the totals are not.
        getLlmMetricsEventBus().publish({
          ...measured,
          usage: {
            ...measured.usage,
            outputTokensReported: null,
            outputTokensTotal: null,
            thinkingTokens: null,
            nonThinkingOutputTokens: null,
            providerTotalTokens: null,
            canonicalTotalTokens: null,
            usageCompleteness: 'partial',
          },
        });
        getLlmMetricsEventBus().publish({
          ...measured,
          exchangeId: `${measured.exchangeId}-unmeasured`,
          usage: makeNormalizedUsage(),
        });
      },
    });
    deps = {
      ...deps,
      agentConversationId: 'conversation-test' as import('../src/session/types.js').AgentConversationId,
      infra: { ...deps.infra, beginMetricsInvocation },
    };
    session = new DockerAgentSession(deps);
    await session.initialize();

    await session.sendMessage('Count what is known');

    expect(session.getHistory()[0]?.usage).toMatchObject({
      promptTokens: 15,
      completionTokens: 0,
      totalTokens: 15,
      usageCompleteness: 'partial',
      observedExchanges: 2,
      unmeasuredExchanges: 1,
    });
    expect(session.getBudgetStatus()).toMatchObject({
      totalTokens: 15,
      cumulative: { totalTokens: 15 },
      tokenTrackingStatus: 'partial',
      incompleteExchanges: 2,
      unmeasuredExchanges: 1,
    });
  });

  it('keeps an unavailable thinking breakdown null instead of inventing zero', async () => {
    const beginMetricsInvocation = (context: MetricsInvocationContext) => ({
      proxyUrl: 'http://ironcurtain:opaque@test-proxy.invalid',
      end: async () => {
        getLlmMetricsEventBus().publish(metricsExchange(context, null));
      },
    });
    deps = {
      ...deps,
      agentConversationId: 'conversation-test' as import('../src/session/types.js').AgentConversationId,
      infra: { ...deps.infra, beginMetricsInvocation },
    };
    session = new DockerAgentSession(deps);
    await session.initialize();

    await session.sendMessage('Count without a reasoning split');

    expect(session.getHistory()[0]?.usage.thinkingTokens).toBeNull();
    expect(session.getBudgetStatus()).toMatchObject({
      totalOutputTokens: 7,
      totalTokens: 22,
      tokenTrackingStatus: 'complete',
    });
  });

  it('getBudgetStatus reflects cost from adapter response', async () => {
    const costAdapter = createMockAdapter();
    costAdapter.extractResponse = (): AgentResponse => ({
      text: 'Done',
      costUsd: 0.42,
    });

    session = new DockerAgentSession({ ...deps, infra: { ...deps.infra, adapter: costAdapter } });
    await session.initialize();

    await session.sendMessage('Do something');

    const budget = session.getBudgetStatus();
    expect(budget.estimatedCostUsd).toBe(0.42);
    expect(budget.cumulative.estimatedCostUsd).toBe(0.42);
    expect(budget.costSource).toBe('reported');
  });

  it('reports the last completed turn, with its share of the cumulative cost', async () => {
    let cumulativeCliCost = 0;
    const costAdapter = createMockAdapter();
    costAdapter.extractResponse = (): AgentResponse => {
      // Claude Code reports a cumulative session cost.
      cumulativeCliCost += 0.25;
      return { text: 'Done', costUsd: cumulativeCliCost };
    };

    session = new DockerAgentSession({ ...deps, infra: { ...deps.infra, adapter: costAdapter } });
    await session.initialize();
    expect(session.getBudgetStatus().lastTurn).toBeNull();

    await session.sendMessage('First');
    await session.sendMessage('Second');

    const budget = session.getBudgetStatus();
    expect(budget.lastTurn).toMatchObject({ stepCount: 1, estimatedCostUsd: 0.25 });
    expect(budget.lastTurn?.elapsedSeconds).toBeGreaterThanOrEqual(0);
    expect(budget.cumulative.estimatedCostUsd).toBe(0.5);
  });

  it('tracks elapsed seconds after first message', async () => {
    session = new DockerAgentSession(deps);
    await session.initialize();

    // Before first message, elapsed is 0
    expect(session.getBudgetStatus().elapsedSeconds).toBe(0);

    await session.sendMessage('Start');

    // After first message, elapsed should be > 0
    expect(session.getBudgetStatus().elapsedSeconds).toBeGreaterThanOrEqual(0);
  });

  it('throws SessionNotReadyError when not initialized', async () => {
    session = new DockerAgentSession(deps);

    await expect(session.sendMessage('Hello')).rejects.toThrow('not ready');
  });

  it('throws SessionClosedError after close', async () => {
    session = new DockerAgentSession(deps);
    await session.initialize();
    await session.close();

    await expect(session.sendMessage('Hello')).rejects.toThrow('closed');
  });

  it('close is idempotent', async () => {
    session = new DockerAgentSession(deps);
    await session.initialize();

    await session.close();
    await session.close(); // Should not throw
  });

  it('joins concurrent close calls until the owned environment teardown finishes', async () => {
    let releaseCapture: () => void = () => {};
    const captureDone = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    const endCaptureSession = vi.fn(() => captureDone);
    session = new DockerAgentSession({ ...deps, infra: { ...deps.infra, endCaptureSession } });
    await session.initialize();
    const first = session.close();
    const second = session.close();
    let secondFinished = false;
    void second.then(() => {
      secondFinished = true;
    });
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(secondFinished).toBe(false);
      expect(endCaptureSession).toHaveBeenCalledTimes(1);
    } finally {
      releaseCapture();
      await Promise.all([first, second]);
    }
    expect(secondFinished).toBe(true);
  });

  it('restores status to ready after sendMessage throws so subsequent turns can proceed', async () => {
    // docker.exec failures (timeout, network glitch, etc.) must not
    // leave the session permanently stuck in 'processing' — that would
    // block all future turns with SessionNotReadyError.
    const failingDocker = createMockDocker();
    failingDocker.exec = async () => {
      throw new Error('docker.exec failed');
    };
    const localDeps = {
      ...deps,
      infra: { ...deps.infra, docker: failingDocker },
    };

    session = new DockerAgentSession(localDeps);
    await session.initialize();

    await expect(session.sendMessage('Hello')).rejects.toThrow('docker.exec failed');
    expect(session.getInfo().status).toBe('ready');

    // A second call should go through the guard and re-attempt, not be
    // blocked on a stale 'processing' state.
    await expect(session.sendMessage('Hello again')).rejects.toThrow('docker.exec failed');
    expect(session.getInfo().status).toBe('ready');
  });

  it('leaves status as closed when sendMessage races with close()', async () => {
    // If close() sets status to 'closed' while sendMessage is mid-flight,
    // the finally block must NOT clobber it back to 'ready'.
    const slowDocker = createMockDocker();
    // Set when sendMessage reaches docker.exec.
    const pendingExec: { resolve?: (value: { exitCode: number; stdout: string; stderr: string }) => void } = {};
    slowDocker.exec = () =>
      new Promise((resolve) => {
        pendingExec.resolve = resolve;
      });

    const localDeps = {
      ...deps,
      infra: { ...deps.infra, docker: slowDocker },
    };

    session = new DockerAgentSession(localDeps);
    await session.initialize();

    const sendPromise = session.sendMessage('Hello');
    // Let the microtasks settle so sendMessage enters the try block.
    await new Promise((resolve) => setImmediate(resolve));
    expect(session.getInfo().status).toBe('processing');

    // Race: close() runs while sendMessage is awaiting docker.exec.
    const closePromise = session.close();
    // Release the exec so sendMessage's finally runs.
    pendingExec.resolve?.({ exitCode: 0, stdout: JSON.stringify({ result: 'ok' }), stderr: '' });

    await Promise.allSettled([sendPromise, closePromise]);
    expect(session.getInfo().status).toBe('closed');
  });

  it('handles non-zero exit codes via adapter.extractResponse', async () => {
    const customDocker = createMockDocker();
    customDocker.exec = async () => ({
      exitCode: 1,
      stdout: 'Something went wrong',
      stderr: 'error details',
    });

    session = new DockerAgentSession({ ...deps, infra: { ...deps.infra, docker: customDocker } });
    await session.initialize();

    const response = await session.sendMessage('Do something');
    expect(response).toBe('Error: exit 1');
  });

  describe('per-turn wall clock (DINF-8)', () => {
    /** A runtime whose turn exec returns `turnResult` after `delayMs`; later execs are the sweep. */
    function timingOutDocker(turnResult: DockerExecResult, delayMs: number, order: string[]) {
      const docker = createMockDocker();
      const exec = vi.fn<ContainerRuntime['exec']>(async (_id, command) => {
        if (command[0] === '/bin/sh' && command[2] === TURN_KILL_SWEEP_SCRIPT) {
          order.push('sweep');
          return { exitCode: 0, stdout: '1\n', stderr: '' };
        }
        order.push('turn');
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return turnResult;
      });
      docker.exec = exec;
      return { docker, exec };
    }

    it('reports a turn the in-container timeout stopped as wall-clock exhaustion, after sweeping and before rotating', async () => {
      const order: string[] = [];
      const events: DiagnosticEvent[] = [];
      const { docker, exec } = timingOutDocker({ exitCode: 124, stdout: '', stderr: '' }, 80, order);
      deps = withBudget(
        { ...deps, infra: { ...deps.infra, docker }, onDiagnostic: (event) => events.push(event) },
        { maxSessionSeconds: 0.05 },
      );
      session = new DockerAgentSession(deps);
      await session.initialize();
      const rotate = vi.spyOn(session, 'rotateAgentConversationId').mockImplementation(() => {
        order.push('rotate');
        return 'rotated-id' as AgentConversationId;
      });

      const turn = session.sendMessageDetailed('Run forever');
      await expect(turn).rejects.toBeInstanceOf(BudgetExhaustedError);
      await expect(turn).rejects.toMatchObject({
        code: 'BUDGET_EXHAUSTED',
        dimension: 'wall_clock',
        message: expect.stringContaining('Time budget exhausted'),
      });

      // The orphan is killed before the conversation id is abandoned.
      expect(order).toEqual(['turn', 'sweep', 'rotate']);
      expect(rotate).toHaveBeenCalledOnce();
      const turnEnvironment = exec.mock.calls[0][5];
      expect(turnEnvironment?.IRONCURTAIN_TURN_ID).toMatch(/^[0-9a-f-]{36}$/);
      expect(exec.mock.calls[1][1]).toEqual([
        '/bin/sh',
        '-c',
        TURN_KILL_SWEEP_SCRIPT,
        'ironcurtain-turn-kill',
        `IRONCURTAIN_TURN_ID=${turnEnvironment?.IRONCURTAIN_TURN_ID}`,
      ]);
      expect(events).toContainEqual(expect.objectContaining({ kind: 'budget_exhausted', dimension: 'wall_clock' }));
      expect(session.getHistory()).toHaveLength(0);
      expect(session.getInfo().status).toBe('ready');
    });

    it('treats a host-backstop hit as a timeout even when the exec client reported nothing else', async () => {
      const order: string[] = [];
      const { docker } = timingOutDocker({ exitCode: 124, stdout: '', stderr: '', timedOut: true }, 0, order);
      deps = withBudget({ ...deps, infra: { ...deps.infra, docker } }, { maxSessionSeconds: 30 });
      session = new DockerAgentSession(deps);
      await session.initialize();

      await expect(session.sendMessage('Wedged')).rejects.toMatchObject({ dimension: 'wall_clock' });
      expect(order).toEqual(['turn', 'sweep']);
    });

    it('never reports a timed-out Claude Code turn as the storage-exhaustion hard failure', async () => {
      const order: string[] = [];
      // What the Docker CLI used to hand back on a timeout: exit 0, no output.
      const { docker } = timingOutDocker({ exitCode: 124, stdout: '', stderr: '', timedOut: true }, 0, order);
      deps = withBudget(
        {
          ...deps,
          agentConversationId: 'aaaaaaaa-1111-4222-8333-444444444444' as AgentConversationId,
          infra: { ...deps.infra, docker, adapter: createClaudeCodeAdapter() },
        },
        { maxSessionSeconds: 30 },
      );
      session = new DockerAgentSession(deps);
      await session.initialize();

      const turn = session.sendMessageDetailed('Long task');
      await expect(turn).rejects.toMatchObject({ dimension: 'wall_clock' });
      await expect(turn).rejects.not.toMatchObject({ message: expect.stringContaining('Docker storage') });
    });

    it('leaves an exit 124 before the deadline to the adapter', async () => {
      const order: string[] = [];
      const { docker } = timingOutDocker({ exitCode: 124, stdout: '', stderr: '' }, 0, order);
      deps = withBudget({ ...deps, infra: { ...deps.infra, docker } }, { maxSessionSeconds: 30 });
      session = new DockerAgentSession(deps);
      await session.initialize();

      await expect(session.sendMessage('Exit 124 by itself')).resolves.toBe('Error: exit 124');
      expect(order).toEqual(['turn']);
    });

    it.skipIf(!LOCAL_TURN_PROCESS_TESTS_SUPPORTED)(
      'kills a turn past its timeout inside the container (processes gone) and reports it timed out',
      async () => {
        const adapter = createMockAdapter();
        const inGroupPidFile = join(tempDir, 'in-group.pid');
        const escapedPidFile = join(tempDir, 'escaped.pid');
        adapter.buildCommand = () => [
          '/bin/sh',
          '-c',
          // A runaway turn: one child in the turn's process group and one that
          // leaves it with setsid, as a detached tool subprocess would.
          'sleep 30 & echo "$!" > "$1"; setsid sleep 30 >/dev/null 2>&1 </dev/null & echo "$!" > "$2"; wait',
          'runaway-turn',
          inGroupPidFile,
          escapedPidFile,
        ];
        deps = withBudget(
          { ...deps, infra: { ...deps.infra, adapter, docker: createDockerManager(localDockerExec) } },
          { maxSessionSeconds: 1 },
        );
        session = new DockerAgentSession(deps);
        await session.initialize();

        const started = Date.now();
        await expect(session.sendMessage('Never finish')).rejects.toMatchObject({
          code: 'BUDGET_EXHAUSTED',
          dimension: 'wall_clock',
        });
        const inGroup = Number(readFileSync(inGroupPidFile, 'utf8').trim());
        const escaped = Number(readFileSync(escapedPidFile, 'utf8').trim());
        try {
          // Stopped at the in-container deadline, long before the host backstop.
          expect(Date.now() - started).toBeLessThan(15_000);
          expect(await waitUntilProcessGone(inGroup)).toBe(true);
          expect(await waitUntilProcessGone(escaped)).toBe(true);
        } finally {
          for (const pid of [inGroup, escaped]) {
            if (isProcessAlive(pid)) process.kill(pid, 'SIGKILL');
          }
        }
      },
    );
  });

  describe('host-mount privilege scan after each turn (DINF-3)', () => {
    const emptyScan: HostMountPrivilegeScanResult = {
      scannedEntries: 0,
      complete: true,
      stripped: [],
      unstripped: [],
      rootOwned: [],
      unreadable: [],
      omitted: 0,
    };

    /** A scanner's report: `result` found in the scan, `fresh` of it not reported by an earlier scan. */
    function report(
      when: string,
      result: Partial<HostMountPrivilegeScanResult> = {},
      fresh: Partial<HostMountPrivilegeScanReport['newFindings']> = {},
    ): HostMountPrivilegeScanReport {
      return { ...emptyScan, ...result, when, newFindings: { unstripped: [], rootOwned: [], ...fresh } };
    }

    function scannerRecording(order: string[]): HostMountPrivilegeScanner & { scan: ReturnType<typeof vi.fn> } {
      return {
        roots: [{ hostPath: tempDir, containerPath: '/workspace' }],
        scan: vi.fn(async (when: string) => {
          order.push(`scan:${when}`);
          return report(when);
        }),
      };
    }

    /** A setuid shell container root left in the workspace: only root can remove it. */
    const rootSetuidShell: UnstrippedEntry = {
      path: '/home/user/project/bin/shell',
      uid: 0,
      mode: 0o4755,
      kind: 'file',
      reason: 'owned by root',
    };
    const rootOwnedDir: PrivilegedEntry = { path: '/home/user/project/build', uid: 0, mode: 0o755, kind: 'directory' };

    function scannerReturning(
      reports: Partial<Record<string, HostMountPrivilegeScanReport[]>>,
    ): HostMountPrivilegeScanner {
      return {
        roots: [{ hostPath: tempDir, containerPath: '/workspace' }],
        scan: vi.fn(async (when: string) => reports[when]?.shift() ?? report(when)),
      };
    }

    it('reports a root-owned setuid file a turn left behind to the transport, once; an empty scan reports nothing', async () => {
      const events: DiagnosticEvent[] = [];
      const scanner = scannerReturning({
        'after agent turn': [
          report('after agent turn', { unstripped: [rootSetuidShell] }, { unstripped: [rootSetuidShell] }),
          // Still there after the next turn: already reported.
          report('after agent turn', { unstripped: [rootSetuidShell] }),
          // Removed: an empty scan.
          report('after agent turn'),
        ],
      });
      session = new DockerAgentSession({
        ...deps,
        ownsInfra: false,
        infra: { ...deps.infra, privilegedFileScanner: scanner },
        onDiagnostic: (event) => events.push(event),
      });
      await session.initialize();

      await session.sendMessage('one');
      await session.sendMessage('two');
      await session.sendMessage('three');

      const notices = events.filter((event) => event.kind === 'host_privileged_files');
      expect(notices).toEqual([
        {
          kind: 'host_privileged_files',
          when: 'after agent turn',
          stripped: 0,
          unstripped: 1,
          rootOwned: 0,
          unlisted: 0,
          paths: ['/home/user/project/bin/shell'],
          incomplete: false,
          hint: expect.stringContaining('remove them as root (for example with sudo rm)') as unknown,
        },
      ]);
      expect(session.getDiagnosticLog()).toContainEqual(notices[0]);
    });

    it('reports everything the teardown scan found left behind when it closes a session it owns', async () => {
      const events: DiagnosticEvent[] = [];
      const scanner = scannerReturning({
        // Both findings were reported after the turn already; the session-end
        // report still names everything that is left.
        'session end': [report('session end', { unstripped: [rootSetuidShell], rootOwned: [rootOwnedDir] })],
      });
      session = new DockerAgentSession({
        ...deps,
        ownsInfra: true,
        infra: { ...deps.infra, privilegedFileScanner: scanner },
        onDiagnostic: (event) => events.push(event),
      });
      await session.initialize();

      await session.close();

      expect(scanner.scan).toHaveBeenCalledWith('session end');
      expect(events.filter((event) => event.kind === 'host_privileged_files')).toEqual([
        expect.objectContaining({
          when: 'session end',
          unstripped: 1,
          rootOwned: 1,
          paths: ['/home/user/project/bin/shell', '/home/user/project/build'],
        }),
      ]);
    });

    it('reports nothing at close when the teardown scan finds nothing', async () => {
      const events: DiagnosticEvent[] = [];
      session = new DockerAgentSession({
        ...deps,
        ownsInfra: true,
        infra: { ...deps.infra, privilegedFileScanner: scannerReturning({}) },
        onDiagnostic: (event) => events.push(event),
      });
      await session.initialize();
      await session.sendMessage('one');

      await session.close();

      expect(events.some((event) => event.kind === 'host_privileged_files')).toBe(false);
    });

    it('keeps the turn and the close intact when the transport fails on a host-mount notice', async () => {
      // The notice is handed over in the turn's finally block and after the
      // teardown: a throwing handler must neither replace the turn's response
      // nor leave the session stuck in 'processing', nor fail close().
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      try {
        const scanner = scannerReturning({
          'after agent turn': [
            report('after agent turn', { unstripped: [rootSetuidShell] }, { unstripped: [rootSetuidShell] }),
          ],
          'session end': [report('session end', { unstripped: [rootSetuidShell] })],
        });
        session = new DockerAgentSession({
          ...deps,
          ownsInfra: true,
          infra: { ...deps.infra, privilegedFileScanner: scanner },
          onDiagnostic: (event) => {
            if (event.kind === 'host_privileged_files') throw new Error('transport gone');
          },
        });
        await session.initialize();

        const response = await session.sendMessage('one');

        expect(response).toEqual(expect.any(String));
        expect(session.getInfo().status).toBe('ready');
        // The diagnostic log has the finding all the same.
        expect(session.getDiagnosticLog()).toContainEqual(
          expect.objectContaining({ kind: 'host_privileged_files', when: 'after agent turn' }),
        );
        await expect(session.close()).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('could not hand host-mount findings to the transport'),
        );
      } finally {
        warn.mockRestore();
      }
    });

    it('sweeps the agent-writable host mounts once the turn has run', async () => {
      const order: string[] = [];
      const docker = createMockDocker();
      const exec = docker.exec.bind(docker);
      docker.exec = vi.fn<ContainerRuntime['exec']>(async (...args) => {
        order.push('turn');
        return exec(...args);
      });
      const scanner = scannerRecording(order);
      session = new DockerAgentSession({ ...deps, infra: { ...deps.infra, docker, privilegedFileScanner: scanner } });
      await session.initialize();

      await session.sendMessage('Do something');
      await session.sendMessage('Do it again');

      expect(order).toEqual(['turn', 'scan:after agent turn', 'turn', 'scan:after agent turn']);
    });

    it('also sweeps after a turn the wall clock stopped, after its processes were killed', async () => {
      const order: string[] = [];
      const docker = createMockDocker();
      docker.exec = vi.fn<ContainerRuntime['exec']>(async (_id, command) => {
        if (command[0] === '/bin/sh' && command[2] === TURN_KILL_SWEEP_SCRIPT) {
          order.push('sweep');
          return { exitCode: 0, stdout: '1\n', stderr: '' };
        }
        order.push('turn');
        return { exitCode: 124, stdout: '', stderr: '', timedOut: true };
      });
      deps = withBudget(
        { ...deps, infra: { ...deps.infra, docker, privilegedFileScanner: scannerRecording(order) } },
        { maxSessionSeconds: 30 },
      );
      session = new DockerAgentSession(deps);
      await session.initialize();

      await expect(session.sendMessage('Wedged')).rejects.toMatchObject({ dimension: 'wall_clock' });
      expect(order).toEqual(['turn', 'sweep', 'scan:after agent turn']);
    });

    it('does not sweep when budget admission refuses the turn before anything ran', async () => {
      const order: string[] = [];
      const scanner = scannerRecording(order);
      deps = withBudget({ ...deps, infra: { ...deps.infra, privilegedFileScanner: scanner } }, { maxSteps: 1 });
      session = new DockerAgentSession(deps);
      await session.initialize();

      await session.sendMessage('First');
      await expect(session.sendMessage('Second')).rejects.toBeInstanceOf(BudgetExhaustedError);
      expect(scanner.scan).toHaveBeenCalledTimes(1);
    });
  });

  it('emits diagnostic events via onDiagnostic callback', async () => {
    const events: DiagnosticEvent[] = [];
    session = new DockerAgentSession({
      ...deps,
      onDiagnostic: (event) => events.push(event),
    });
    await session.initialize();

    // Write an audit entry and flush the tailer
    const entry = {
      serverName: 'fs',
      toolName: 'read',
      arguments: { path: '/test' },
      result: { status: 'allowed' },
    };
    appendFileSync(deps.infra.auditLogPath, JSON.stringify(entry) + '\n');
    session.flushAuditLog();

    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  describe('audit diagnostics cover only this session (WP-83, GAP4-7)', () => {
    function appendToolCall(toolName: string): void {
      const entry = { serverName: 'fs', toolName, arguments: { path: '/test' }, result: { status: 'success' } };
      appendFileSync(deps.infra.auditLogPath, JSON.stringify(entry) + '\n');
    }

    function toolCalls(target: DockerAgentSession): string[] {
      return target.getDiagnosticLog().flatMap((event) => (event.kind === 'tool_call' ? [event.toolName] : []));
    }

    it('a borrow-mode session sees none of the entries earlier states left in the bundle log', async () => {
      // One audit log per workflow bundle: every earlier state's tool calls
      // are already in it when the next state's session starts.
      for (let i = 0; i < 50; i++) appendToolCall(`earlier_${i}`);

      session = new DockerAgentSession({ ...deps, ownsInfra: false });
      await session.initialize();
      appendToolCall('mine');
      session.flushAuditLog();

      expect(toolCalls(session)).toEqual(['fs.mine']);
    });

    it('consecutive borrow-mode sessions on one bundle log each see only their own entries', async () => {
      const first = new DockerAgentSession({ ...deps, ownsInfra: false });
      await first.initialize();
      appendToolCall('first_state');
      first.flushAuditLog();
      await first.close();

      session = new DockerAgentSession({ ...deps, ownsInfra: false });
      await session.initialize();
      appendToolCall('second_state');
      session.flushAuditLog();

      expect(toolCalls(first)).toEqual(['fs.first_state']);
      expect(toolCalls(session)).toEqual(['fs.second_state']);
    });

    it('a resumed session does not replay the tool calls of the session it resumes', async () => {
      // `start --resume` reuses the old session's audit log.
      appendToolCall('before_resume');

      session = new DockerAgentSession(deps);
      await session.initialize();
      appendToolCall('after_resume');
      session.flushAuditLog();

      expect(toolCalls(session)).toEqual(['fs.after_resume']);
    });

    it('a session whose log ends inside an entry still being written reports only its own calls', async () => {
      const earlier = JSON.stringify({
        serverName: 'fs',
        toolName: 'earlier',
        arguments: {},
        result: { status: 'success' },
      });
      appendFileSync(deps.infra.auditLogPath, earlier.slice(0, 12));

      session = new DockerAgentSession({ ...deps, ownsInfra: false });
      await session.initialize();
      appendFileSync(deps.infra.auditLogPath, earlier.slice(12) + '\n');
      appendToolCall('mine');
      session.flushAuditLog();

      expect(toolCalls(session)).toEqual(['fs.mine']);
    });
  });

  it('resolves escalation by writing response file', async () => {
    vi.useFakeTimers();

    session = new DockerAgentSession(deps);
    await session.initialize();

    // Simulate an escalation request appearing in the directory
    const escalationId = 'esc-123';
    const request: EscalationRequest = {
      escalationId,
      toolName: 'write_file',
      serverName: 'filesystem',
      arguments: { path: '/etc/passwd' },
      reason: 'Protected path',
    };
    writeFileSync(join(deps.infra.escalationDir, `request-${escalationId}.json`), JSON.stringify(request));

    // Advance fake timers to trigger the escalation watcher's polling interval (300ms default)
    vi.advanceTimersByTime(350);

    const pending = session.getPendingEscalations().at(0);
    expect(pending).toBeDefined();
    expect(pending?.escalationId).toBe(escalationId);

    // Resolve the escalation
    await session.resolveEscalation(escalationId, 'denied');

    // Response file should exist
    const responsePath = join(deps.infra.escalationDir, `response-${escalationId}.json`);
    expect(existsSync(responsePath)).toBe(true);

    // Pending should be cleared
    expect(session.getPendingEscalations()).toEqual([]);

    vi.useRealTimers();
  });

  it('reports a response that came after the proxy timeout as expired, not approved', async () => {
    vi.useFakeTimers();

    session = new DockerAgentSession(deps);
    await session.initialize();

    const request: EscalationRequest = {
      escalationId: 'esc-late',
      toolName: 'write_file',
      serverName: 'filesystem',
      arguments: { path: '/etc/passwd' },
      reason: 'Protected path',
    };
    const requestPath = join(deps.infra.escalationDir, 'request-esc-late.json');
    writeFileSync(requestPath, JSON.stringify(request));
    vi.advanceTimersByTime(350);
    expect(session.getPendingEscalations().at(0)?.escalationId).toBe('esc-late');

    // The proxy timed out and removed the request before the approval arrived.
    rmSync(requestPath);

    await expect(session.resolveEscalation('esc-late', 'approved')).rejects.toMatchObject({
      code: 'ESCALATION_EXPIRED',
    });
    expect(session.getPendingEscalations()).toEqual([]);

    vi.useRealTimers();
  });

  it('throws when resolving unknown escalation', async () => {
    session = new DockerAgentSession(deps);
    await session.initialize();

    await expect(session.resolveEscalation('nonexistent', 'approved')).rejects.toThrow('No pending escalation');
  });

  it('calls onEscalation callback when escalation detected', async () => {
    vi.useFakeTimers();

    const escalations: EscalationRequest[] = [];
    session = new DockerAgentSession({
      ...deps,
      onEscalation: (req) => escalations.push(req),
    });
    await session.initialize();

    const request: EscalationRequest = {
      escalationId: 'esc-456',
      toolName: 'delete_file',
      serverName: 'filesystem',
      arguments: { path: '/important' },
      reason: 'Protected',
    };
    writeFileSync(join(deps.infra.escalationDir, 'request-esc-456.json'), JSON.stringify(request));

    vi.advanceTimersByTime(350);

    expect(escalations).toHaveLength(1);
    expect(escalations[0].escalationId).toBe('esc-456');

    vi.useRealTimers();
  });

  it('detects escalation expiry when files are removed', async () => {
    vi.useFakeTimers();

    let expired = false;
    session = new DockerAgentSession({
      ...deps,
      onEscalationExpired: () => {
        expired = true;
      },
    });
    await session.initialize();

    // Write then detect escalation
    const request: EscalationRequest = {
      escalationId: 'esc-789',
      toolName: 'fetch',
      serverName: 'fetch',
      arguments: { url: 'http://evil.com' },
      reason: 'Unknown domain',
    };
    writeFileSync(join(deps.infra.escalationDir, 'request-esc-789.json'), JSON.stringify(request));

    vi.advanceTimersByTime(350);
    expect(session.getPendingEscalations()).toHaveLength(1);

    // Simulate proxy-side cleanup (both files removed = expired)
    rmSync(join(deps.infra.escalationDir, 'request-esc-789.json'));

    vi.advanceTimersByTime(350);
    expect(expired).toBe(true);
    expect(session.getPendingEscalations()).toEqual([]);

    vi.useRealTimers();
  });

  it('writes user context for auto-approver', async () => {
    session = new DockerAgentSession(deps);
    await session.initialize();

    await session.sendMessage('Please fix the CSS');

    const contextPath = join(deps.infra.escalationDir, 'user-context.json');
    expect(existsSync(contextPath)).toBe(true);
  });

  // Mount configuration and TCP sidecar/network setup are the factory's
  // responsibility; those assertions live in docker-infrastructure.test.ts.

  it('getDiagnosticLog returns accumulated events', async () => {
    session = new DockerAgentSession(deps);
    await session.initialize();

    const log = session.getDiagnosticLog();
    expect(Array.isArray(log)).toBe(true);
  });

  describe('TCP mode with internal network', () => {
    // Sidecar/network creation and connectivity-check tests live in
    // docker-infrastructure.test.ts. What remains here: verifying that
    // `close()` tears down the sidecar, the main container, and the
    // internal network that were handed to the session via the pre-built
    // infrastructure bundle.

    it('removes sidecar and internal network on close', async () => {
      const baseDeps = createTestDeps(tempDir);
      const removedNetworks: string[] = [];
      const stoppedContainers: string[] = [];
      const removedContainers: string[] = [];

      const docker: ContainerRuntime = {
        ...createMockDocker(),
        async stop(id: string) {
          stoppedContainers.push(id);
        },
        async remove(id: string) {
          removedContainers.push(id);
        },
        async removeNetwork(name: string) {
          removedNetworks.push(name);
        },
      };

      const expectedNetworkName = getInternalNetworkName('test-session'.substring(0, 12));
      const infra: DockerInfrastructure = {
        ...baseDeps.infra,
        docker,
        useTcp: true,
        containerId: 'container-cleanup',
        sidecarContainerId: 'sidecar-cleanup',
        internalNetwork: expectedNetworkName,
        mitmAddr: { port: 8443 },
      };

      session = new DockerAgentSession({ ...baseDeps, infra });
      await session.initialize();
      await session.close();

      // Both app container and sidecar should be stopped and removed
      expect(stoppedContainers).toContain('container-cleanup');
      expect(stoppedContainers).toContain('sidecar-cleanup');
      expect(removedContainers).toContain('container-cleanup');
      expect(removedContainers).toContain('sidecar-cleanup');
      expect(removedNetworks).toContain(expectedNetworkName);
    });
  });

  describe('infrastructure ownership (ownsInfra flag)', () => {
    /** Extra session directories a test made beside `tempDir`, removed after each test. */
    const localTempDirs: string[] = [];
    afterEach(() => {
      for (const dir of localTempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    // Counts calls to the underlying infra teardown primitives. When
    // `ownsInfra=true`, these are invoked as part of close(); when
    // `ownsInfra=false`, close() leaves them untouched for the external
    // owner to invoke later via destroyDockerInfrastructure().
    interface TeardownSpies {
      readonly docker: ContainerRuntime;
      readonly mitmProxy: MitmProxy;
      readonly proxy: DockerProxy;
      readonly counts: {
        containerStops: number;
        containerRemoves: number;
        mitmStops: number;
        proxyStops: number;
      };
    }

    function createTeardownSpies(sessionDir: string): TeardownSpies {
      const counts = {
        containerStops: 0,
        containerRemoves: 0,
        mitmStops: 0,
        proxyStops: 0,
      };

      const docker: ContainerRuntime = {
        ...createMockDocker(),
        async stop() {
          counts.containerStops++;
        },
        async remove() {
          counts.containerRemoves++;
        },
      };

      const mitmProxy: MitmProxy = {
        ...createMockMitmProxy(),
        async stop() {
          counts.mitmStops++;
        },
      };

      const proxy: DockerProxy = {
        ...createMockProxy(join(sessionDir, 'proxy.sock')),
        async stop() {
          counts.proxyStops++;
        },
      };

      return { docker, mitmProxy, proxy, counts };
    }

    it('close() DOES call destroyDockerInfrastructure when ownsInfra=true', async () => {
      const spies = createTeardownSpies(deps.infra.bundleDir);
      session = new DockerAgentSession({
        ...deps,
        ownsInfra: true,
        infra: {
          ...deps.infra,
          docker: spies.docker,
          mitmProxy: spies.mitmProxy,
          proxy: spies.proxy,
        },
      });
      await session.initialize();
      await session.close();

      // Each infra resource should have been released exactly once.
      expect(spies.counts.containerStops).toBe(1);
      expect(spies.counts.containerRemoves).toBe(1);
      expect(spies.counts.mitmStops).toBe(1);
      expect(spies.counts.proxyStops).toBe(1);
    });

    it('close() does NOT call destroyDockerInfrastructure when ownsInfra=false', async () => {
      const spies = createTeardownSpies(deps.infra.bundleDir);
      session = new DockerAgentSession({
        ...deps,
        ownsInfra: false,
        infra: {
          ...deps.infra,
          docker: spies.docker,
          mitmProxy: spies.mitmProxy,
          proxy: spies.proxy,
        },
      });
      await session.initialize();
      await session.close();

      // Borrowed infra stays alive; the external owner is responsible for
      // calling destroyDockerInfrastructure() later.
      expect(spies.counts.containerStops).toBe(0);
      expect(spies.counts.containerRemoves).toBe(0);
      expect(spies.counts.mitmStops).toBe(0);
      expect(spies.counts.proxyStops).toBe(0);
    });

    it('does NOT tear down a Docker-workload lease on close() when ownsInfra=false', async () => {
      // §8.3: the lease lives exactly as long as the bundle. A borrower never
      // owns the bundle, so close() must never drive the lease teardown — the
      // external owner does it via destroyDockerInfrastructure().
      const spies = createTeardownSpies(deps.infra.bundleDir);
      const teardown = vi.fn(async () => ({ alreadyClosed: false, supervisorLost: false }));
      session = new DockerAgentSession({
        ...deps,
        ownsInfra: false,
        infra: {
          ...deps.infra,
          docker: spies.docker,
          mitmProxy: spies.mitmProxy,
          proxy: spies.proxy,
          dockerWorkload: { teardown } as unknown as NonNullable<DockerInfrastructure['dockerWorkload']>,
        },
      });
      await session.initialize();
      await session.close();

      expect(teardown).not.toHaveBeenCalled();
    });

    it('drives the capture lifecycle ONLY when ownsInfra=true', async () => {
      // In standalone (owns-infra) mode the session owns the single Claude
      // session and must call begin/endCaptureSession with `{ sessionId }`.
      // In borrow mode (workflow shared container) the orchestrator owns the
      // capture lifecycle and passes the full `{ sessionId, persona, fsmState }`;
      // the session must NOT also call begin/end, or the dispatcher's
      // first-wins idempotency would silently drop the orchestrator's richer
      // begin and lose persona/fsmState on the manifest.
      for (const ownsInfra of [true, false] as const) {
        const beginCalls: Array<{ sessionId: string; persona?: string; fsmState?: string }> = [];
        let endCalls = 0;
        const localTempDir = mkdtempSync(join(tmpdir(), 'owns-infra-capture-'));
        localTempDirs.push(localTempDir);
        const localDeps = createTestDeps(localTempDir);
        const local = new DockerAgentSession({
          ...localDeps,
          ownsInfra,
          infra: {
            ...localDeps.infra,
            beginCaptureSession: (opts) => beginCalls.push(opts),
            endCaptureSession: async () => {
              endCalls++;
            },
          },
        });
        await local.initialize();
        await local.close();

        if (ownsInfra) {
          expect(beginCalls).toEqual([{ sessionId: 'test-session-id' }]);
          expect(endCalls).toBe(1);
        } else {
          expect(beginCalls).toEqual([]);
          expect(endCalls).toBe(0);
        }
      }
    });

    it('close() stops escalation watcher and audit tailer regardless of ownsInfra value', async () => {
      // Both ownsInfra branches must tear down the escalation watcher and
      // audit tailer, since those lifecycles are session-owned (not
      // infra-owned). Verified behaviorally via two post-close signals:
      //   1. Dropping a fresh escalation request after close does not fire
      //      the onEscalation callback (poll interval stopped).
      //   2. The session rejects sendMessage with a "closed" error.
      vi.useFakeTimers();

      for (const ownsInfra of [true, false] as const) {
        const localTempDir = mkdtempSync(join(tmpdir(), 'owns-infra-watchers-'));
        try {
          const localDeps = createTestDeps(localTempDir);
          const escalations: EscalationRequest[] = [];
          const local = new DockerAgentSession({
            ...localDeps,
            ownsInfra,
            onEscalation: (req) => escalations.push(req),
          });
          await local.initialize();

          // Sanity-check: the watcher was actively polling before close.
          const warmupRequest: EscalationRequest = {
            escalationId: 'owns-infra-warmup',
            toolName: 'write_file',
            serverName: 'filesystem',
            arguments: { path: '/warmup' },
            reason: 'Warmup',
          };
          writeFileSync(
            join(localDeps.infra.escalationDir, 'request-owns-infra-warmup.json'),
            JSON.stringify(warmupRequest),
          );
          vi.advanceTimersByTime(350);
          expect(escalations).toHaveLength(1);

          await local.close();
          const callbacksBeforePostClose = escalations.length;

          // Post-close: a fresh escalation request must NOT fire the
          // onEscalation callback, because the poll interval was stopped.
          const postCloseRequest: EscalationRequest = {
            escalationId: 'owns-infra-post-close',
            toolName: 'write_file',
            serverName: 'filesystem',
            arguments: { path: '/post' },
            reason: 'Post-close',
          };
          writeFileSync(
            join(localDeps.infra.escalationDir, 'request-owns-infra-post-close.json'),
            JSON.stringify(postCloseRequest),
          );
          vi.advanceTimersByTime(1000);
          expect(escalations.length).toBe(callbacksBeforePostClose);

          // Post-close: the session refuses further work regardless of which
          // ownership mode was used.
          await expect(local.sendMessage('hi')).rejects.toThrow('closed');
        } finally {
          rmSync(localTempDir, { recursive: true, force: true });
        }
      }

      vi.useRealTimers();
    });
  });

  describe('runtime hygiene', () => {
    function readLog(path: string): string {
      return existsSync(path) ? readFileSync(path, 'utf-8') : '';
    }

    it('keeps the newest turns in memory while turnCount, turn numbers and the step count keep counting', async () => {
      session = new DockerAgentSession(deps);
      await session.initialize();
      const turns = SESSION_TURN_HISTORY_LIMIT + 3;
      for (let turn = 1; turn <= turns; turn++) await session.sendMessage(`message ${turn}`);

      const history = session.getHistory();
      expect(history).toHaveLength(SESSION_TURN_HISTORY_LIMIT);
      expect(history[0].turnNumber).toBe(4);
      expect(history[0].userMessage).toBe('message 4');
      expect(history.at(-1)?.turnNumber).toBe(turns);
      expect(session.getInfo().turnCount).toBe(turns);
      expect(session.getBudgetStatus().stepCount).toBe(turns);
      expect(session.getBudgetStatus().cumulative.stepCount).toBe(turns);
    });

    it('enforces a step budget above the retained history from the turn count, not the retained turns', async () => {
      // The step budget counts completed turns; were it read from the bounded
      // history, it could never pass the history limit and never stop.
      const limit = SESSION_TURN_HISTORY_LIMIT + 2;
      session = new DockerAgentSession(withBudget(deps, { maxSteps: limit }));
      await session.initialize();
      for (let turn = 1; turn <= limit; turn++) await session.sendMessage(`message ${turn}`);

      await expect(session.sendMessage('one too many')).rejects.toBeInstanceOf(BudgetExhaustedError);
      expect(session.getInfo().turnCount).toBe(limit);
    });

    it('reports start-up notices: MCP servers its proxy could not start and host-model fallbacks', async () => {
      const diagnostics: DiagnosticEvent[] = [];
      const proxy: DockerProxy = {
        ...deps.infra.proxy,
        getUnavailableServers: () => [{ serverName: 'git', reason: 'relay exited before the handshake' }],
      };
      session = new DockerAgentSession({
        ...deps,
        infra: { ...deps.infra, proxy },
        hostModelNotices: [
          { role: 'autoApprove', action: 'disabled', message: 'Auto-approve is off for this session' },
        ],
        onDiagnostic: (event) => diagnostics.push(event),
      });
      await session.initialize();

      const expected: DiagnosticEvent[] = [
        {
          kind: 'host_model_fallback',
          role: 'autoApprove',
          action: 'disabled',
          message: 'Auto-approve is off for this session',
        },
        { kind: 'mcp_server_unavailable', serverName: 'git', reason: 'relay exited before the handshake' },
      ];
      expect(diagnostics).toEqual(expected);
      expect(session.getDiagnosticLog()).toEqual(expected);
    });

    it('reports a stale compiled policy as a start-up notice: display text with its reasons, first', async () => {
      // FU-10 (05-02): the warning buildSessionConfig collected reached only
      // stderr and the session log, so web and Signal users never saw it.
      const diagnostics: DiagnosticEvent[] = [];
      const esc = String.fromCharCode(0x1b);
      session = new DockerAgentSession({
        ...deps,
        hostModelNotices: [
          { role: 'autoApprove', action: 'disabled', message: 'Auto-approve is off for this session' },
        ],
        policyWarnings: [
          `Warning: the compiled policy at /p/${esc}[2Jcompiled-policy.json may be stale:\n` +
            '  - it records no provenance\n' +
            '  Run `ironcurtain compile-policy` to rebuild it.\n',
        ],
        onDiagnostic: (event) => diagnostics.push(event),
      });
      await session.initialize();

      expect(diagnostics.map((event) => event.kind)).toEqual(['policy_stale', 'host_model_fallback']);
      expect(diagnostics[0]).toEqual({
        kind: 'policy_stale',
        message:
          'Warning: the compiled policy at /p/\\u001b[2Jcompiled-policy.json may be stale:\n' +
          '  - it records no provenance\n' +
          '  Run `ironcurtain compile-policy` to rebuild it.',
      });
      expect(session.getDiagnosticLog()).toEqual(diagnostics);
    });

    it('logs its own work to its claim and gives back only that claim on close', async () => {
      const daemonLog = join(tempDir, 'daemon.log');
      const sessionLog = join(tempDir, 'session.log');
      const daemon = logger.setup({ logFilePath: daemonLog, processWide: true });
      const claim = logger.setup({ logFilePath: sessionLog });
      try {
        session = new DockerAgentSession({ ...deps, logClaim: claim });
        await session.initialize();
        await session.sendMessage('Fix the bug');
        logger.info('[daemon] while the session is open');
        await session.close();
        logger.info('[daemon] after the session closed');

        expect(readLog(sessionLog)).toContain('Session attached to container');
        expect(readLog(sessionLog)).toContain('[docker-agent] exec:');
        expect(readLog(sessionLog)).not.toContain('[daemon]');
        expect(readLog(daemonLog)).toContain('[daemon] while the session is open');
        expect(readLog(daemonLog)).toContain('[daemon] after the session closed');
        expect(readLog(daemonLog)).not.toContain('[docker-agent]');
        // close() gave back the session's claim and left the daemon's.
        expect(logger.isActive()).toBe(true);
        logger.release(daemon);
        expect(logger.isActive()).toBe(false);
      } finally {
        logger.teardown();
      }
    });
  });
});

describe('DockerAgentSession transcript probe over the agent-writable state dir', () => {
  // The conversation-state dir is the agent's read-write ~/.claude/ mount.
  // The constructor probes it to pick `--resume <id>` over `--session-id <id>`,
  // so the probe must stay two levels deep and never follow a link that an
  // earlier workflow state or run planted there. (Loops and `projects -> /`,
  // which froze the host under the old recursive walk, are covered with a
  // hard child-process timeout in test/docker/conversation-state.test.ts.)
  const CONVERSATION_ID = '0f8fad5b-d9cb-469f-a165-70867728950e' as AgentConversationId;
  const CLAUDE_RESULT = JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: 'done',
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
  });
  let tempDir: string;
  let stateDir: string;
  let session: DockerAgentSession | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'docker-session-probe-'));
    stateDir = join(tempDir, 'claude-state');
    mkdirSync(stateDir);
    session = undefined;
  });

  afterEach(async () => {
    try {
      await session?.close();
    } catch {
      // Ignore close errors in cleanup
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** Construct a Claude Code session over `stateDir`, run one turn, and return the executed argv. */
  async function firstTurnCommand(): Promise<readonly string[]> {
    const { exec, calls } = scriptedExec([{ exitCode: 0, stdout: CLAUDE_RESULT, stderr: '' }]);
    const deps = createTestDeps(tempDir);
    session = new DockerAgentSession({
      ...deps,
      agentConversationId: CONVERSATION_ID,
      infra: {
        ...deps.infra,
        adapter: createClaudeCodeAdapter(),
        docker: createMockDocker({ exec }),
        conversationStateDir: stateDir,
      },
    });
    await session.initialize();
    await session.sendMessage('continue');
    return calls[0];
  }

  /** Write `<projectsDir>/-workspace/<id>.jsonl` as Claude Code would. */
  function writeTranscript(projectsDir: string): void {
    mkdirSync(join(projectsDir, '-workspace'), { recursive: true });
    writeFileSync(join(projectsDir, '-workspace', `${CONVERSATION_ID}.jsonl`), '{"type":"user"}\n');
  }

  function flagValue(command: readonly string[], flag: '--resume' | '--session-id'): string | undefined {
    const index = command.indexOf(flag);
    return index >= 0 ? command[index + 1] : undefined;
  }

  it('resumes when projects/<hash>/<id>.jsonl exists', async () => {
    writeTranscript(join(stateDir, 'projects'));
    const command = await firstTurnCommand();
    expect(flagValue(command, '--resume')).toBe(CONVERSATION_ID);
    expect(flagValue(command, '--session-id')).toBeUndefined();
  });

  it('starts a fresh conversation when no transcript exists', async () => {
    mkdirSync(join(stateDir, 'projects'));
    const command = await firstTurnCommand();
    expect(flagValue(command, '--session-id')).toBe(CONVERSATION_ID);
    expect(flagValue(command, '--resume')).toBeUndefined();
  });

  it('does not follow a planted symlink to a project directory outside the state dir', async () => {
    writeTranscript(join(tempDir, 'elsewhere'));
    mkdirSync(join(stateDir, 'projects'));
    symlinkSync(join(tempDir, 'elsewhere', '-workspace'), join(stateDir, 'projects', '-workspace'));
    const command = await firstTurnCommand();
    expect(flagValue(command, '--session-id')).toBe(CONVERSATION_ID);
    expect(flagValue(command, '--resume')).toBeUndefined();
  });

  it('does not follow projects/ replaced by a symlink', async () => {
    writeTranscript(join(tempDir, 'elsewhere'));
    symlinkSync(join(tempDir, 'elsewhere'), join(stateDir, 'projects'));
    const command = await firstTurnCommand();
    expect(flagValue(command, '--session-id')).toBe(CONVERSATION_ID);
    expect(flagValue(command, '--resume')).toBeUndefined();
  });
});
