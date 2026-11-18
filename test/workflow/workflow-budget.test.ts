/**
 * The run-wide spend ceiling (`settings.workflowBudget`, WFE-14) and the
 * run-wide usage it is checked against (MET-9), driven through the real
 * orchestrator with mock sessions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkflowOrchestrator, type CreateWorkflowInfrastructureInput } from '../../src/workflow/orchestrator.js';
import { isCheckpointResumable } from '../../src/workflow/checkpoint.js';
import { validateDefinition } from '../../src/workflow/validate.js';
import { resolveWorkflowResourceBudget, pastRunWorkflowBudget } from '../../src/workflow/resource-budget.js';
import type { WorkflowDefinition } from '../../src/workflow/types.js';
import type { BudgetStatus, SessionOptions } from '../../src/session/types.js';
import type { DockerInfrastructure } from '../../src/docker/docker-infrastructure.js';
import { createBudgetGate, type BudgetGate } from '../../src/docker/budget-gate.js';
import type { LlmExchangeCompleted } from '../../src/llm-metrics/types.js';
import { getLlmMetricsEventBus } from '../../src/llm-metrics/event-bus.js';
import { findWorkflowBudgetBreach, workflowUsageFromCheckpoint } from '../../src/workflow/workflow-usage.js';
import {
  MockSession,
  approvedResponse,
  createCheckpointStore,
  createDeps,
  makeLlmExchange,
  mockBudgetStatus,
  statusBlock,
  stubPersonasForTest,
  waitForCompletion,
  writeDefinitionFile,
} from './test-helpers.js';

function twoStateDefinition(settings: WorkflowDefinition['settings']): WorkflowDefinition {
  return {
    name: 'budget-ceiling',
    description: 'Two agent states under a run-wide ceiling',
    initial: 'first',
    settings,
    states: {
      first: {
        type: 'agent',
        description: 'First',
        persona: 'global',
        prompt: 'Work first.',
        inputs: [],
        outputs: [],
        transitions: [{ to: 'second' }],
      },
      second: {
        type: 'agent',
        description: 'Second',
        persona: 'global',
        prompt: 'Work second.',
        inputs: [],
        outputs: [],
        transitions: [{ to: 'done' }],
      },
      done: { type: 'terminal', description: 'Done' },
    },
  };
}

describe('settings.workflowBudget', () => {
  let tmpDir: string;
  const orchestrators: WorkflowOrchestrator[] = [];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'workflow-budget-'));
  });

  afterEach(async () => {
    for (const orchestrator of orchestrators.splice(0)) await orchestrator.shutdownAll();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeOrchestrator(createSession: (options: SessionOptions) => Promise<MockSession>): WorkflowOrchestrator {
    const orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, { createSession, checkpointStore: createCheckpointStore(tmpDir) }),
    );
    orchestrators.push(orchestrator);
    return orchestrator;
  }

  /** A builtin session whose AI SDK usage is reported through its budget status. */
  function spendingSession(status: BudgetStatus, response = approvedResponse()): MockSession {
    return new MockSession({ responses: () => response, budgetStatus: () => status });
  }

  it('validates the ceiling strictly and shows it in the budget preview', () => {
    const settings = {
      mode: 'builtin' as const,
      workflowBudget: { maxEstimatedCostUsd: 25, maxWallClockSeconds: 3600 },
    };
    expect(validateDefinition(twoStateDefinition(settings)).settings?.workflowBudget).toEqual(settings.workflowBudget);
    expect(resolveWorkflowResourceBudget(settings, {}).workflowLimits).toEqual(settings.workflowBudget);
    for (const workflowBudget of [
      { maxTotalToken: 10 },
      { maxTotalTokens: 0 },
      { maxTotalTokens: 1.5 },
      { maxEstimatedCostUsd: -1 },
      { maxWallClockSeconds: 'soon' },
    ]) {
      expect(() =>
        validateDefinition(twoStateDefinition({ mode: 'builtin', workflowBudget } as WorkflowDefinition['settings'])),
      ).toThrow();
    }
  });

  it('aborts resumably before the next state once the run reaches its cost ceiling', async () => {
    const definition = twoStateDefinition({ mode: 'builtin', workflowBudget: { maxEstimatedCostUsd: 1 } });
    const definitionPath = writeDefinitionFile(tmpDir, definition);
    const startedStates: string[] = [];
    const createSession = vi.fn(async (options: SessionOptions) => {
      startedStates.push(options.workflow?.stateId ?? '?');
      return spendingSession(mockBudgetStatus({ inputTokens: 1000, outputTokens: 200, estimatedCostUsd: 1.5 }));
    });

    const orchestrator = makeOrchestrator(createSession);
    const id = await orchestrator.start(definitionPath, 'task');
    await waitForCompletion(orchestrator, id);

    // `second` was never started: the ceiling is checked before each state.
    expect(startedStates).toEqual(['first']);
    const status = orchestrator.getStatus(id);
    expect(status?.phase).toBe('aborted');
    const reason = status?.phase === 'aborted' ? status.reason : '';
    expect(reason).toContain('Workflow budget exhausted before "second"');
    expect(reason).toContain('estimated cost $1.50 of $1.00');
    expect(reason).toContain(resolve(tmpDir, id, 'definition.json'));
    expect(readFileSync(resolve(tmpDir, id, 'messages.jsonl'), 'utf-8')).toContain(
      'workflow budget check before \\"second\\"',
    );

    // The checkpoint is kept, points at the refused state and carries the usage.
    const store = createCheckpointStore(tmpDir);
    const checkpoint = store.load(id);
    expect(checkpoint && isCheckpointResumable(checkpoint)).toBe(true);
    expect(checkpoint?.machineState).toBe('second');
    expect(checkpoint?.usage).toMatchObject({ estimatedCostUsd: 1.5, totalTokens: 1200, reportedSessions: 1 });

    // Resuming without raising the limit stops again before `second`: usage
    // continues from the checkpoint instead of starting from zero.
    const resumed = makeOrchestrator(createSession);
    await resumed.resume(id);
    await waitForCompletion(resumed, id);
    expect(resumed.getStatus(id)?.phase).toBe('aborted');
    expect(startedStates).toEqual(['first']);

    // Raising the limit in the run's definition copy lets the run continue.
    const copyPath = resolve(tmpDir, id, 'definition.json');
    const copy = JSON.parse(readFileSync(copyPath, 'utf-8')) as WorkflowDefinition;
    writeFileSync(
      copyPath,
      JSON.stringify({ ...copy, settings: { ...copy.settings, workflowBudget: { maxEstimatedCostUsd: 10 } } }),
    );
    const raised = makeOrchestrator(createSession);
    await raised.resume(id);
    await waitForCompletion(raised, id);
    expect(raised.getStatus(id)?.phase).toBe('completed');
    expect(startedStates).toEqual(['first', 'second']);
    // Builtin workflows aggregate every session's AI SDK usage, across resumes.
    expect(raised.getDetail(id)?.usage).toMatchObject({
      totalTokens: 2400,
      estimatedCostUsd: 3,
      reportedSessions: 2,
      tokenTrackingStatus: 'complete',
    });
    expect(raised.getBudget(id)).toMatchObject({
      workflowLimits: { maxEstimatedCostUsd: 10 },
      workflowUsage: { estimatedCostUsd: 3 },
    });
    // A past-run budget is rebuilt from the checkpoint's usage record.
    expect(pastRunWorkflowBudget(store.load(id), copy.settings)).toMatchObject({
      activeSessionCount: 0,
      workflowUsage: { totalTokens: 2400 },
    });
  });

  // MET-1 / WP-41: a Docker session's `estimatedCostUsd` may be its agent
  // CLI's own total_cost_usd, which the agent controls. The run-wide ceiling is
  // a decision, so it counts host-observed cost only: an agent can neither stop
  // the run by over-reporting nor run past the ceiling by under-reporting.
  it.each([
    { label: 'over-reports', agentReported: 1e9, hostObserved: 0.25, started: ['first', 'second'], phase: 'completed' },
    { label: 'under-reports', agentReported: -1, hostObserved: 1.5, started: ['first'], phase: 'aborted' },
  ])(
    'checks the cost ceiling on host-observed cost when a Docker agent $label its own cost',
    async ({ agentReported, hostObserved, started, phase }) => {
      const definition = twoStateDefinition({
        mode: 'docker',
        dockerAgent: 'claude-code',
        workflowBudget: { maxEstimatedCostUsd: 1 },
      });
      const startedStates: string[] = [];
      const createSession = vi.fn(async (options: SessionOptions) => {
        startedStates.push(options.workflow?.stateId ?? '?');
        return spendingSession(
          mockBudgetStatus({
            tokenTrackingAvailable: true,
            estimatedCostUsd: agentReported,
            hostObservedCostUsd: hostObserved,
          }),
        );
      });

      const orchestrator = makeOrchestrator(createSession);
      const id = await orchestrator.start(writeDefinitionFile(tmpDir, definition), 'task');
      await waitForCompletion(orchestrator, id);

      expect(startedStates).toEqual(started);
      const status = orchestrator.getStatus(id);
      expect(status?.phase).toBe(phase);
      if (status?.phase === 'aborted') {
        expect(status.reason).toContain('estimated cost $1.50 of $1.00');
      }
      expect(orchestrator.getDetail(id)?.usage?.estimatedCostUsd).toBeCloseTo(hostObserved * started.length, 10);
    },
  );

  it('enforces the token ceiling against the run total, and fails closed on untracked sessions', async () => {
    const tracked = twoStateDefinition({ mode: 'builtin', workflowBudget: { maxTotalTokens: 1000 } });
    const trackedSessions = vi.fn(async () =>
      spendingSession(mockBudgetStatus({ inputTokens: 900, outputTokens: 150 })),
    );
    const orchestrator = makeOrchestrator(trackedSessions);
    const id = await orchestrator.start(writeDefinitionFile(tmpDir, tracked), 'task');
    await waitForCompletion(orchestrator, id);
    expect(trackedSessions).toHaveBeenCalledTimes(1);
    const status = orchestrator.getStatus(id);
    expect(status?.phase === 'aborted' ? status.reason : '').toContain('1,050 of 1,000 tokens used');

    // Sessions whose tokens cannot be observed would make the total an
    // undercount, so a token ceiling refuses to run past them.
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = mkdtempSync(join(tmpdir(), 'workflow-budget-untracked-'));
    const untrackedSessions = vi.fn(async () => new MockSession({ responses: () => approvedResponse() }));
    const second = makeOrchestrator(untrackedSessions);
    const untrackedId = await second.start(
      writeDefinitionFile(tmpDir, { ...tracked, name: 'budget-untracked' }),
      'task',
    );
    await waitForCompletion(second, untrackedId);
    expect(untrackedSessions).toHaveBeenCalledTimes(1);
    const untrackedStatus = second.getStatus(untrackedId);
    expect(untrackedStatus?.phase).toBe('aborted');
    expect(untrackedStatus?.phase === 'aborted' ? untrackedStatus.reason : '').toContain('cannot be enforced');
  });

  // FU-16 (07-03): the ceiling also counts what each Docker bundle's MITM
  // budget gate charged, which counts every completion the bundle forwarded
  // whatever metrics lease it carried, with statistics on or off.
  describe('with the budget gates of Docker bundles', () => {
    it.each(['completed', 'failed', 'abort', 'abort-save-failure'] as const)(
      'persists charges settled during %s teardown',
      async (ending) => {
        const terminal = ending === 'failed' ? 'failed' : 'done';
        const aborting = ending.startsWith('abort');
        const failFinalSave = ending === 'abort-save-failure';
        const definition: WorkflowDefinition = {
          name: 'settled-usage',
          description: 'Final usage',
          initial: 'first',
          settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true },
          states: {
            first: {
              type: 'agent',
              description: 'First',
              persona: 'global',
              prompt: 'Example',
              inputs: [],
              outputs: [],
              transitions: [{ to: aborting ? 'gate' : terminal }],
            },
            ...(aborting
              ? {
                  gate: {
                    type: 'human_gate' as const,
                    description: 'Gate',
                    acceptedEvents: ['APPROVE' as const],
                    transitions: [{ to: terminal, event: 'APPROVE' as const }],
                  },
                }
              : {}),
            [terminal]: { type: 'terminal', description: 'Terminal' },
          },
        };
        const cleanup = stubPersonasForTest(tmpDir, definition);
        let settled = false;
        const createWorkflowInfrastructure = vi.fn(
          async (input: CreateWorkflowInfrastructureInput) =>
            ({
              workflowId: input.workflowId,
              bundleId: input.bundleId,
              budgetGate: { snapshot: () => ({ totalTokens: settled ? 70 : 10, costUsd: settled ? 7 : 1 }) },
              setTokenSessionId: () => {},
              beginCaptureSession: () => {},
              endCaptureSession: async () => {},
            }) as unknown as DockerInfrastructure,
        );
        const checkpointStore = createCheckpointStore(tmpDir);
        if (failFinalSave) {
          const save = checkpointStore.save.bind(checkpointStore);
          vi.spyOn(checkpointStore, 'save').mockImplementation((id, checkpoint) => {
            if (checkpoint.finalStatus !== undefined && checkpoint.usageSettlementPending !== true) {
              throw new Error('Fixture final usage save failed');
            }
            save(id, checkpoint);
          });
        }
        const orchestrator = new WorkflowOrchestrator(
          createDeps(tmpDir, {
            checkpointStore,
            createWorkflowInfrastructure,
            destroyWorkflowInfrastructure: async (infra) => {
              settled = true;
              getLlmMetricsEventBus().publish(
                makeLlmExchange({
                  workflowRunId: String(infra.workflowId),
                  bundleId: String(infra.bundleId),
                  usage: {
                    inputTokensReported: 20,
                    inputTokensTotal: 20,
                    inputTokensUncached: 20,
                    outputTokensReported: 0,
                    outputTokensTotal: 0,
                    canonicalTotalTokens: 20,
                    providerTotalTokens: 20,
                  },
                }),
              );
            },
            createSession: async () =>
              new MockSession({
                responses: () => approvedResponse(),
                budgetStatus: () => mockBudgetStatus({ tokenTrackingAvailable: false }),
              }),
          }),
        );
        orchestrators.push(orchestrator);
        try {
          const id = await orchestrator.start(writeDefinitionFile(tmpDir, definition), 'task');
          if (aborting) {
            await vi.waitFor(() => expect(orchestrator.getStatus(id)?.phase).toBe('waiting_human'));
            await orchestrator.abort(id);
          } else await waitForCompletion(orchestrator, id);
          await orchestrator.shutdownAll();
          expect(settled).toBe(true);
          const saved = checkpointStore.load(id);
          if (saved === undefined) throw new Error('Expected terminal checkpoint');
          if (failFinalSave) {
            expect(saved.usageSettlementPending).toBe(true);
            expect(
              findWorkflowBudgetBreach({ maxEstimatedCostUsd: 100 }, workflowUsageFromCheckpoint(saved)),
            ).toMatchObject({ dimension: 'cost' });
          } else {
            expect(saved.usage).toMatchObject({ totalTokens: 70, estimatedCostUsd: 7, observedExchanges: 1 });
            expect(saved.usageSettlementPending).not.toBe(true);
          }
        } finally {
          cleanup();
        }
      },
    );
    /** Final usage of a 250K-token Sonnet 4.5 prompt: $1.53 as a cost cap charges it (2x the listed $0.765). */
    const LONG_PROMPT_USAGE: Partial<LlmExchangeCompleted['usage']> = {
      inputTokensReported: 250_000,
      inputTokensTotal: 250_000,
      inputTokensUncached: 250_000,
      outputTokensReported: 1_000,
      outputTokensTotal: 1_000,
      providerTotalTokens: 251_000,
      canonicalTotalTokens: 251_000,
    };

    /** One completion the bundle's MITM forwarded during an agent turn and its gate charged. */
    function chargeCompletion(gate: BudgetGate, bundleId: string): void {
      const turn = gate.beginTurn();
      try {
        const admission = gate.admit({
          protocol: 'anthropic-messages',
          model: 'claude-sonnet-4-5',
          outputCapTokens: 1_000,
        });
        if (!admission.admitted) throw new Error(`unexpected refusal: ${admission.refusal.message}`);
        admission.ticket.markUpstreamStatus(200);
        // Tied only to the bundle (the request carried no metrics lease).
        admission.ticket.settle(makeLlmExchange({ bundleId, quality: 'bundle_only', usage: LONG_PROMPT_USAGE }));
      } finally {
        turn.end();
      }
    }

    it('stops a shared-container run on what its bundle gate charged, with statistics off', async () => {
      const definition = twoStateDefinition({
        mode: 'docker',
        dockerAgent: 'claude-code',
        sharedContainer: true,
        workflowBudget: { maxEstimatedCostUsd: 1 },
      });
      const stubCleanup = stubPersonasForTest(tmpDir, definition);
      try {
        const gates = new Map<string, BudgetGate>();
        const createWorkflowInfrastructure = vi.fn(async (input: CreateWorkflowInfrastructureInput) => {
          const gate = createBudgetGate({ mode: 'turn', limits: { maxTotalTokens: null, maxEstimatedCostUsd: null } });
          gates.set(input.bundleId, gate);
          return {
            workflowId: input.workflowId,
            bundleId: input.bundleId,
            budgetGate: gate,
            setTokenSessionId: () => {},
            beginCaptureSession: () => {},
            endCaptureSession: async () => {},
          } as unknown as DockerInfrastructure;
        });
        const startedStates: string[] = [];
        const createSession = vi.fn(async (options: SessionOptions) => {
          startedStates.push(options.workflow?.stateId ?? '?');
          const bundle = options.workflow?.infrastructure;
          return new MockSession({
            responses: () => {
              const gate = bundle ? gates.get(bundle.bundleId) : undefined;
              if (bundle && gate) chargeCompletion(gate, bundle.bundleId);
              return approvedResponse();
            },
            // Statistics off: no token tracking and no host-observed cost. The
            // status does not report the gate either, so only the bundle's
            // gate, registered when it was minted, counts this spend.
            budgetStatus: () => mockBudgetStatus({ tokenTrackingAvailable: false, hostObservedCostUsd: 0 }),
          });
        });
        const orchestrator = new WorkflowOrchestrator(
          createDeps(tmpDir, {
            createSession,
            checkpointStore: createCheckpointStore(tmpDir),
            createWorkflowInfrastructure,
            destroyWorkflowInfrastructure: async () => {},
          }),
        );
        orchestrators.push(orchestrator);
        const id = await orchestrator.start(writeDefinitionFile(tmpDir, definition), 'task');
        await waitForCompletion(orchestrator, id);

        expect(createWorkflowInfrastructure).toHaveBeenCalledTimes(1);
        expect(startedStates).toEqual(['first']);
        const status = orchestrator.getStatus(id);
        expect(status?.phase).toBe('aborted');
        expect(status?.phase === 'aborted' ? status.reason : '').toContain('estimated cost $1.53 of $1.00');
        expect(orchestrator.getDetail(id)?.usage).toMatchObject({
          untrackedSessions: 1,
          uncountedSessions: 0,
          totalTokens: 251_000,
          gateOnlyTokens: 251_000,
        });
        // The checkpoint keeps the gate's charges, so a resume continues from them.
        expect(createCheckpointStore(tmpDir).load(id)?.usage).toMatchObject({
          estimatedCostUsd: expect.closeTo(1.53, 9) as number,
          gateOnlyTokens: 251_000,
        });
      } finally {
        stubCleanup();
      }
    });

    it("stops a run on what each per-state container's own gate charged, though its sessions observed no cost", async () => {
      const definition = twoStateDefinition({
        mode: 'docker',
        dockerAgent: 'claude-code',
        workflowBudget: { maxEstimatedCostUsd: 4 },
      });
      const startedStates: string[] = [];
      let sessionCount = 0;
      const createSession = vi.fn(async (options: SessionOptions) => {
        startedStates.push(options.workflow?.stateId ?? '?');
        sessionCount += 1;
        const sessionId = `per-state-${sessionCount}`;
        // The session's own bundle (its id is the session id) charged $5.
        return new MockSession({
          sessionId,
          responses: () => approvedResponse(),
          budgetStatus: () => ({
            ...mockBudgetStatus({ tokenTrackingAvailable: true, hostObservedCostUsd: 0 }),
            budgetGate: { bundleId: sessionId, totalTokens: 120_000, costUsd: 5 },
          }),
        });
      });
      const orchestrator = makeOrchestrator(createSession);
      const id = await orchestrator.start(writeDefinitionFile(tmpDir, definition), 'task');
      await waitForCompletion(orchestrator, id);

      expect(startedStates).toEqual(['first']);
      const status = orchestrator.getStatus(id);
      expect(status?.phase).toBe('aborted');
      expect(status?.phase === 'aborted' ? status.reason : '').toContain('estimated cost $5.00 of $4.00');
      expect(orchestrator.getDetail(id)?.usage).toMatchObject({ estimatedCostUsd: 5, gateOnlyCostUsd: 5 });
    });

    it('counts what a per-state container’s gate charged for exchanges settled when the session closed', async () => {
      const definition = twoStateDefinition({
        mode: 'docker',
        dockerAgent: 'claude-code',
        workflowBudget: { maxEstimatedCostUsd: 4 },
      });
      const startedStates: string[] = [];
      let sessionCount = 0;
      const createSession = vi.fn(async (options: SessionOptions) => {
        startedStates.push(options.workflow?.stateId ?? '?');
        sessionCount += 1;
        const sessionId = `per-state-${sessionCount}`;
        const holder: { session?: MockSession } = {};
        // $1 charged when the state's turn ended. A process the agent left
        // running still had requests in flight: closing the session stops the
        // container's MITM, which settles them, and the gate's total reaches $5.
        holder.session = new MockSession({
          sessionId,
          responses: () => approvedResponse(),
          budgetStatus: () => ({
            ...mockBudgetStatus({ tokenTrackingAvailable: true, hostObservedCostUsd: 0 }),
            budgetGate: { bundleId: sessionId, totalTokens: 1_000, costUsd: holder.session?.closed ? 5 : 1 },
          }),
        });
        return holder.session;
      });
      const orchestrator = makeOrchestrator(createSession);
      const id = await orchestrator.start(writeDefinitionFile(tmpDir, definition), 'task');
      await waitForCompletion(orchestrator, id);

      expect(startedStates).toEqual(['first']);
      const status = orchestrator.getStatus(id);
      expect(status?.phase).toBe('aborted');
      expect(status?.phase === 'aborted' ? status.reason : '').toContain('estimated cost $5.00 of $4.00');
    });

    it('no longer lets a statistics-off run pass a cost-only ceiling when nothing counted its sessions', async () => {
      const definition = twoStateDefinition({ mode: 'builtin', workflowBudget: { maxEstimatedCostUsd: 5 } });
      // tokenTrackingAvailable false and no budget gate: nothing counts the spend.
      const createSession = vi.fn(async () => new MockSession({ responses: () => approvedResponse() }));
      const orchestrator = makeOrchestrator(createSession);
      const id = await orchestrator.start(writeDefinitionFile(tmpDir, definition), 'task');
      await waitForCompletion(orchestrator, id);

      expect(createSession).toHaveBeenCalledTimes(1);
      const status = orchestrator.getStatus(id);
      expect(status?.phase).toBe('aborted');
      expect(status?.phase === 'aborted' ? status.reason : '').toContain('cost ceiling cannot be enforced');
    });
  });

  it('checks the ceiling before a deterministic state, which never runs once it is reached', async () => {
    const marker = resolve(tmpDir, 'deterministic-ran');
    const definition: WorkflowDefinition = {
      name: 'budget-deterministic',
      description: 'An agent state, then a deterministic check',
      initial: 'first',
      settings: { mode: 'builtin', workflowBudget: { maxEstimatedCostUsd: 1 } },
      states: {
        first: {
          type: 'agent',
          description: 'First',
          persona: 'global',
          prompt: 'Work first.',
          inputs: [],
          outputs: [],
          transitions: [{ to: 'check' }],
        },
        check: {
          type: 'deterministic',
          description: 'Writes a marker when it runs',
          // Host commands need the explicit acknowledgement (WP-47).
          host: true,
          run: [[process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`]],
          transitions: [{ to: 'done' }],
        },
        done: { type: 'terminal', description: 'Done' },
      },
    };
    const createSession = vi.fn(async () =>
      spendingSession(mockBudgetStatus({ inputTokens: 10, outputTokens: 5, estimatedCostUsd: 1.25 })),
    );
    const orchestrator = makeOrchestrator(createSession);
    const id = await orchestrator.start(writeDefinitionFile(tmpDir, definition), 'task');
    await waitForCompletion(orchestrator, id);

    const status = orchestrator.getStatus(id);
    expect(status?.phase).toBe('aborted');
    expect(status?.phase === 'aborted' ? status.reason : '').toContain('Workflow budget exhausted before "check"');
    expect(existsSync(marker)).toBe(false);
    const checkpoint = createCheckpointStore(tmpDir).load(id);
    expect(checkpoint?.machineState).toBe('check');
    expect(checkpoint && isCheckpointResumable(checkpoint)).toBe(true);

    // Without a ceiling the same deterministic state runs.
    const copyPath = resolve(tmpDir, id, 'definition.json');
    const copy = JSON.parse(readFileSync(copyPath, 'utf-8')) as WorkflowDefinition;
    writeFileSync(copyPath, JSON.stringify({ ...copy, settings: { mode: 'builtin' } }));
    const resumed = makeOrchestrator(createSession);
    await resumed.resume(id);
    await waitForCompletion(resumed, id);
    expect(resumed.getStatus(id)?.phase).toBe('completed');
    expect(existsSync(marker)).toBe(true);
  });

  it('enforces the wall-clock ceiling on time spent running states', async () => {
    const definition = twoStateDefinition({ mode: 'builtin', workflowBudget: { maxWallClockSeconds: 0.05 } });
    const createSession = vi.fn(
      async () =>
        new MockSession({
          responses: async () => {
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));
            return approvedResponse();
          },
          budgetStatus: () => mockBudgetStatus(),
        }),
    );
    const orchestrator = makeOrchestrator(createSession);
    const id = await orchestrator.start(writeDefinitionFile(tmpDir, definition), 'task');
    await waitForCompletion(orchestrator, id);
    expect(createSession).toHaveBeenCalledTimes(1);
    const status = orchestrator.getStatus(id);
    expect(status?.phase === 'aborted' ? status.reason : '').toContain('running time used');
    expect(orchestrator.getDetail(id)?.usage?.activeSeconds).toBeGreaterThanOrEqual(0.1);
  });

  it('stops a fan-out lane before its next step and ends the run aborted, not failed', async () => {
    const definition: WorkflowDefinition = {
      name: 'budget-fanout',
      description: 'One lane with two agent steps',
      initial: 'workers',
      settings: { mode: 'builtin', workflowBudget: { maxEstimatedCostUsd: 1 } },
      states: {
        workers: {
          type: 'deterministic',
          description: 'Fan out',
          run: [],
          fanOut: { count: 1, join: 'barrier' },
          segment: ['draft', 'finish'],
          transitions: [{ to: 'done' }],
        },
        draft: {
          type: 'agent',
          description: 'Draft',
          persona: 'global',
          prompt: 'Draft.',
          inputs: [],
          outputs: [],
          fanOutMember: true,
          transitions: [{ to: 'finish' }],
        },
        finish: {
          type: 'agent',
          description: 'Finish',
          persona: 'global',
          prompt: 'Finish.',
          inputs: [],
          outputs: [],
          fanOutMember: true,
          transitions: [{ to: 'done', when: { verdict: 'recorded' } }],
        },
        done: { type: 'terminal', description: 'Done' },
      },
    };
    const startedStates: string[] = [];
    const createSession = vi.fn(async (options: SessionOptions) => {
      startedStates.push(options.workflow?.stateId ?? '?');
      return spendingSession(
        mockBudgetStatus({ estimatedCostUsd: 2, inputTokens: 10, outputTokens: 5 }),
        statusBlock('recorded', 'lane step'),
      );
    });
    const orchestrator = makeOrchestrator(createSession);
    const id = await orchestrator.start(writeDefinitionFile(tmpDir, definition), 'task');
    await waitForCompletion(orchestrator, id);

    expect(startedStates).toEqual(['draft']);
    const status = orchestrator.getStatus(id);
    expect(status?.phase).toBe('aborted');
    expect(status?.phase === 'aborted' ? status.reason : '').toContain('Workflow budget exhausted before "finish"');
    const checkpoint = createCheckpointStore(tmpDir).load(id);
    expect(checkpoint?.machineState).toBe('workers');
    expect(checkpoint && isCheckpointResumable(checkpoint)).toBe(true);
  });
});
