import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createActor, type AnyActorRef } from 'xstate';
import { MessageLog } from '../../src/workflow/message-log.js';
import { writeRunDefinition } from '../../src/workflow/run-definition.js';
import {
  buildWorkflowMachine,
  createInitialContext,
  type AgentInvokeInput,
  type AgentInvokeResult,
  type DeterministicInvokeInput,
  type DeterministicInvokeResult,
} from '../../src/workflow/machine-builder.js';
import type { WorkflowDefinition, WorkflowId, WorkflowStateDefinition } from '../../src/workflow/types.js';
import {
  WorkflowOrchestrator,
  type CreateWorkflowInfrastructureInput,
  type LoadPolicyRpcInput,
} from '../../src/workflow/orchestrator.js';
import { AgentInvocationError, WorkflowQuotaExhaustedError } from '../../src/workflow/errors.js';
import { WorkflowUsageMeter } from '../../src/workflow/workflow-usage.js';
import { resolveWorkflowResourceBudget } from '../../src/workflow/resource-budget.js';
import { createAgentConversationId, type AgentTurnResult, type SessionOptions } from '../../src/session/types.js';
import type { DockerInfrastructure } from '../../src/docker/docker-infrastructure.js';
import {
  MockSession,
  resolveActiveGate,
  createCheckpointStore,
  createDeps,
  createMockTab,
  noStatusResponse,
  statusBlock,
  stubPersonasForTest,
  waitForCompletion,
  waitForGate,
  writeDefinitionFile,
  writeEvolveLaneNodes,
  makeLlmExchange,
} from './test-helpers.js';
import {
  agentStateOf,
  deterministicStateOf,
  makeAgentResult,
  makeVerdictResult,
  settle,
} from './machine-test-helpers.js';
import { writePersonaPolicy } from '../fixtures/scoped-policy.js';

// ---------------------------------------------------------------------------
// Focused unit tests for the fan-out join path in WorkflowOrchestrator:
// runFanOutSegment / waitForRoundChild / joinFanOutBatch. These are the
// runnable proof of MUST-FIX #1 (child onError -> errored) and #2 (the
// evaluator_blocked reason surfaced from previousAgentOutput).
//
// We drive the REAL parent machine (built via buildWorkflowMachine and wired
// with the orchestrator's own provideActors), so the parent's
// orchestrator -> workers -> orchestrator loop, the child round machine, the
// barrier (waitForRoundChild), and the verdict fold (joinFanOutBatch) all run
// for real. Only the two LEAF executors (executeAgentState /
// executeDeterministicState) are stubbed via bracket access — the same focused
// seam orchestrator-deterministic.test.ts uses — so each test controls per-
// stateId verdicts and rejections without spinning up sessions or Docker.
// ---------------------------------------------------------------------------

const WF_ID = 'wf-fanout-test' as WorkflowId;

/** Parent orchestrator -> workers; child segment sample -> researcher -> evaluate -> analysis_record. */
const fanOutDefinition: WorkflowDefinition = {
  name: 'fanout-join-test',
  description: 'Fan-out workflow for join-path unit tests',
  initial: 'orchestrator',
  settings: { mode: 'builtin', workers: 1, maxRounds: 10 },
  states: {
    orchestrator: {
      type: 'agent',
      description: 'Chooses the next batch',
      persona: 'global',
      prompt: 'You are a planner.',
      inputs: [],
      outputs: [],
      transitions: [{ to: 'workers', when: { verdict: 'design' } }, { to: 'done' }],
    },
    workers: {
      type: 'deterministic',
      description: 'Runs the child round',
      run: [],
      fanOut: { count: 'workers', join: 'barrier' },
      segment: ['sample', 'researcher', 'evaluate', 'analysis_record'],
      transitions: [
        { to: 'orchestrator', when: { verdict: 'recorded' } },
        { to: 'human_escalation', when: { verdict: 'escalate' } },
        { to: 'failed', when: { verdict: 'result_file_error' } },
        // Unconditional fallback: deterministic verdict routing is not
        // validated against the transition table, so validateDefinition
        // (which the resume test goes through) requires one — the shipped
        // evolve manifest ends its `workers` state the same way.
        { to: 'failed' },
      ],
    },
    sample: {
      type: 'deterministic',
      description: 'Samples parents',
      run: [['sample']],
      fanOutMember: true,
      transitions: [{ to: 'researcher', when: { verdict: 'sampled' } }, { to: 'failed' }],
    },
    researcher: {
      type: 'agent',
      description: 'Writes a candidate',
      persona: 'global',
      prompt: 'You are a coder.',
      inputs: [],
      outputs: [],
      fanOutMember: true,
      transitions: [{ to: 'evaluate' }],
    },
    evaluate: {
      type: 'deterministic',
      description: 'Evaluates candidate',
      run: [['evaluate']],
      fanOutMember: true,
      transitions: [
        { to: 'analysis_record', when: { verdict: 'evaluated' } },
        { to: 'human_escalation', when: { verdict: 'evaluator_blocked' } },
        { to: 'failed' },
      ],
    },
    analysis_record: {
      type: 'deterministic',
      description: 'Records candidate',
      run: [['record']],
      fanOutMember: true,
      transitions: [{ to: 'orchestrator', when: { verdict: 'recorded' } }, { to: 'failed' }],
    },
    human_escalation: {
      type: 'human_gate',
      description: 'Human review',
      acceptedEvents: ['APPROVE', 'ABORT'],
      transitions: [
        { to: 'orchestrator', event: 'APPROVE' },
        { to: 'failed', event: 'ABORT' },
      ],
    },
    done: { type: 'terminal', description: 'Done' },
    failed: { type: 'terminal', description: 'Failed' },
  },
};

type AgentStub = (input: AgentInvokeInput) => Promise<AgentInvokeResult>;
type DeterministicStub = (input: DeterministicInvokeInput) => Promise<DeterministicInvokeResult>;
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void };

// The real method signatures provideActors closes over: it calls
// `this.executeAgentState(workflowId, input, definition)` and
// `this.executeDeterministicState(workflowId, input)`. The override must match
// that arity so `input` lands in the right parameter position.
type ExecuteAgent = (id: WorkflowId, input: AgentInvokeInput, def: WorkflowDefinition) => Promise<AgentInvokeResult>;
type ExecuteDeterministic = (id: WorkflowId, input: DeterministicInvokeInput) => Promise<DeterministicInvokeResult>;

/**
 * Registers a synthetic instance with the real round machines, overrides the
 * two leaf executors with the supplied stubs, builds the parent actor via the
 * orchestrator's own provideActors, and tracks every parent state value the
 * actor enters. Returns the actor plus the ordered visit list.
 */
function driveParent(
  orchestrator: WorkflowOrchestrator,
  tmpDir: string,
  agentStub: AgentStub,
  deterministicStub: DeterministicStub,
  definition: WorkflowDefinition = fanOutDefinition,
): { actor: AnyActorRef; visited: string[] } {
  const { machine, roundMachinesByState, gateStateNames, terminalStateNames } = buildWorkflowMachine(
    definition,
    'task',
  );

  const instance = {
    id: WF_ID,
    resourceBudget: resolveWorkflowResourceBudget(definition.settings, {}),
    definition,
    definitionPath: join(tmpDir, 'workflow.yaml'),
    workflowSkillsDir: undefined,
    workflowScriptsDir: undefined,
    containerSnapshots: undefined,
    roundMachinesByState,
    gateStateNames,
    terminalStateNames,
    activeSessions: new Set(),
    artifactDir: join(tmpDir, '.workflow'),
    workspacePath: tmpDir,
    tab: createMockTab(),
    transitionHistory: [],
    currentState: 'orchestrator',
    messageLog: new MessageLog(join(tmpDir, 'messages.jsonl')),
    bundlesByScope: new Map(),
    policyDirByPersona: new Map(),
    currentPersonaByBundle: new Map(),
    liveAgentTurnsByBundle: new Map(),
    mintedServersByBundle: new Map(),
    bundleMintsInFlight: 0,
    sessionSlots: new Map(),
    commitChannelsByBundle: new Map(),
    stopController: new AbortController(),
    fanOutChildren: new Set(),
    locks: {},
    usage: new WorkflowUsageMeter(WF_ID),
  } as Record<string, unknown> & { actor?: AnyActorRef; currentState: string };
  const internal = orchestrator as unknown as {
    workflows: Map<WorkflowId, unknown>;
    executeAgentState: ExecuteAgent;
    executeDeterministicState: ExecuteDeterministic;
    provideActors: (
      machine: unknown,
      id: WorkflowId,
      def: WorkflowDefinition,
      rounds: ReadonlyMap<string, unknown>,
    ) => unknown;
    subscribeToActor: (instance: unknown) => void;
  };
  internal.workflows.set(WF_ID, instance);
  // Override the leaf executors so the child round machine resolves verdicts
  // from the stubs. provideActors closes over `this.executeAgentState` /
  // `this.executeDeterministicState`, so replacing the methods here redirects
  // every lane's invoke to the stub. `input` is the SECOND argument in both.
  internal.executeAgentState = (_id, input) => agentStub(input);
  internal.executeDeterministicState = (_id, input) => deterministicStub(input);

  const provided = internal.provideActors(machine, WF_ID, definition, roundMachinesByState);
  const actor = createActor(provided as Parameters<typeof createActor>[0]);
  instance.actor = actor as AnyActorRef;
  internal.subscribeToActor(instance);
  const visited: string[] = [];
  actor.subscribe((snap) => {
    const value = String((snap as { value: unknown }).value);
    visited.push(value);
  });
  actor.start();
  return { actor: actor as AnyActorRef, visited };
}

/** Maps the child segment's stateIds to deterministic verdicts for the happy path. */
const recordedDeterministicStub: DeterministicStub = async (input) => {
  const verdicts: Record<string, string> = {
    sample: 'sampled',
    evaluate: 'evaluated',
    analysis_record: 'recorded',
  };
  return { passed: true, testCount: 10, verdict: verdicts[input.stateId] };
};

interface BarrierStubOptions {
  /** Lanes echoed back in the `sample_batch_prepared` payload. */
  readonly lanes: readonly number[];
  /** Observe each barrier call in order (e.g. push to a `barrierOrder` array). */
  readonly onBarrierCall?: (input: DeterministicInvokeInput) => void;
  /**
   * Owns the per-lane `analysis_record` verdict. When provided, the stub returns
   * its result (the crash-resume tests use this to append a DB node + report a
   * `node_id`); when omitted, `analysis_record` falls through to the happy-path
   * `recordedDeterministicStub`.
   */
  readonly onAnalysisRecord?: (input: DeterministicInvokeInput) => DeterministicInvokeResult;
}

/**
 * Builds the barrier-side {@link DeterministicStub} shared by the fan-out tests:
 * it answers the three barrier subcommands (`sample_batch`,
 * `analysis_record_promote_cognition`, `sample_stop_signals`) and delegates every
 * non-barrier child-segment call to {@link recordedDeterministicStub}. The only
 * per-test variation is the active `lanes` set and the optional
 * `analysis_record` override, so those are the parameters.
 */
function makeBarrierDeterministicStub(options: BarrierStubOptions): DeterministicStub {
  return async (input) => {
    if (input.stateId === 'sample_batch') {
      options.onBarrierCall?.(input);
      return {
        passed: true,
        verdict: 'sample_batch_prepared',
        payload: { lanes: options.lanes.map((lane) => ({ lane, step_name: `step_0001_lane_${lane}` })) },
      };
    }
    if (input.stateId === 'analysis_record_promote_cognition') {
      options.onBarrierCall?.(input);
      return { passed: true, verdict: 'cognition_promoted', payload: { promoted_count: options.lanes.length } };
    }
    if (input.stateId === 'sample_stop_signals') {
      options.onBarrierCall?.(input);
      return { passed: true, verdict: 'stop_signals_computed', payload: { stop_reason: null } };
    }
    if (input.stateId === 'analysis_record' && options.onAnalysisRecord) {
      return options.onAnalysisRecord(input);
    }
    return recordedDeterministicStub(input);
  };
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function evolveBarrierDefinition(workers: number, containerized = false): WorkflowDefinition {
  const sampleCommand = [
    '/opt/workflow-venv/bin/python',
    '/workflow-scripts/evolve_result.py',
    'sample',
    '--run-dir',
    '/workspace/.evolve_runs/main',
    '--query-from-spec',
    '--context-file',
    '/workspace/.evolve_runs/main/current/context.json',
    '--result-file',
    '/workspace/.evolve_runs/main/current/sample.json',
  ];
  const attachCommand = [
    '/opt/workflow-venv/bin/python',
    '/workflow-scripts/evolve_result.py',
    'attach_analysis',
    '--run-dir',
    '/workspace/.evolve_runs/main',
    '--step-from-current',
    '--analysis-file',
    '/workspace/.evolve_runs/main/current/analysis.md',
    '--result-file',
    '/workspace/.evolve_runs/main/current/analysis_record.json',
  ];
  return {
    ...fanOutDefinition,
    settings: {
      ...fanOutDefinition.settings,
      workers,
      ...(containerized ? { mode: 'docker' as const, dockerAgent: 'claude-code', sharedContainer: true } : {}),
    },
    states: {
      ...fanOutDefinition.states,
      sample: {
        ...deterministicStateOf(fanOutDefinition, 'sample'),
        run: [sampleCommand],
        ...(containerized ? { container: true } : {}),
      },
      evaluate: { ...fanOutDefinition.states.evaluate, ...(containerized ? { container: true } : {}) },
      analysis_record: {
        ...deterministicStateOf(fanOutDefinition, 'analysis_record'),
        run: [attachCommand],
        ...(containerized ? { container: true } : {}),
      },
    },
  };
}

function writeEvolveNodes(workspace: string, lanes: readonly number[], batchIndex = 1): void {
  writeEvolveLaneNodes(join(workspace, '.evolve_runs', 'main', 'database_data'), lanes, batchIndex);
}

function appendEvolveNode(workspace: string, lane: number, batchIndex = 1): void {
  const nodesPath = join(workspace, '.evolve_runs', 'main', 'database_data', 'nodes.json');
  const parsed = JSON.parse(readFileSync(nodesPath, 'utf-8')) as {
    next_id: number;
    nodes: Record<string, { id: number; meta_info?: { step_name?: string } }>;
  };
  const stepName = `step_${String(batchIndex).padStart(4, '0')}_lane_${lane}`;
  if (Object.values(parsed.nodes).some((node) => node.meta_info?.step_name === stepName)) {
    throw new Error(`duplicate record for ${stepName}`);
  }
  const id = parsed.next_id;
  parsed.nodes[String(id)] = {
    id,
    meta_info: { step_name: stepName },
  };
  parsed.next_id = id + 1;
  writeFileSync(nodesPath, JSON.stringify(parsed, null, 2));
}

function makeStubInfrastructure(input: CreateWorkflowInfrastructureInput): DockerInfrastructure {
  return {
    __stub: true,
    workflowId: input.workflowId,
    bundleId: input.bundleId,
    setTokenSessionId: () => {},
    beginCaptureSession: () => {},
    endCaptureSession: async () => {},
  } as unknown as DockerInfrastructure;
}

describe('WorkflowOrchestrator fan-out join path', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fanout-join-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('(a)+(d) a recorded child re-enters orchestrator exactly once per round', async () => {
    const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));

    // orchestrator returns `design` on its first turn (fan out), then anything
    // else (-> `done`) on the second so the run terminates after one batch.
    let orchestratorTurn = 0;
    const agentStub: AgentStub = async (input) => {
      if (input.stateId === 'orchestrator') {
        orchestratorTurn += 1;
        return makeVerdictResult(orchestratorTurn === 1 ? 'design' : 'finished');
      }
      return makeAgentResult(); // researcher
    };

    const { actor, visited } = driveParent(orchestrator, tmpDir, agentStub, recordedDeterministicStub);
    await settle();

    expect(actor.getSnapshot().status).toBe('done');
    expect(actor.getSnapshot().value).toBe('done');

    // The parent enters `orchestrator` exactly twice across one round: the
    // initial fan-out decision, and the re-entry after the batch recorded. The
    // parent stays at `workers` for the whole batch (single-active-state spine),
    // so `workers` appears once, never the child segment stateIds.
    expect(visited.filter((v) => v === 'orchestrator')).toHaveLength(2);
    expect(visited.filter((v) => v === 'workers')).toHaveLength(1);
    expect(visited).not.toContain('sample');
    expect(visited).not.toContain('researcher');
  });

  it('runs three recorded lanes as three child rounds and joins once at the parent', async () => {
    const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
    const parallelDefinition: WorkflowDefinition = {
      ...fanOutDefinition,
      settings: { ...fanOutDefinition.settings, workers: 3 },
    };

    let orchestratorTurn = 0;
    let reenteredOrchestratorTokens: number | undefined;
    const researcherLaneIds: number[] = [];
    const deterministicCalls: Array<{ stateId: string; laneId: number | undefined }> = [];
    const agentStub: AgentStub = async (input) => {
      if (input.stateId === 'orchestrator') {
        orchestratorTurn += 1;
        if (orchestratorTurn === 2) {
          reenteredOrchestratorTokens = input.context.totalTokens;
        }
        return makeVerdictResult(orchestratorTurn === 1 ? 'design' : 'finished');
      }
      researcherLaneIds.push(input.context.lane?.id ?? -1);
      const internal = orchestrator as unknown as {
        workflows: Map<WorkflowId, { usage: WorkflowUsageMeter }>;
      };
      const instance = internal.workflows.get(WF_ID);
      if (!instance) throw new Error('fan-out test instance missing');
      // Each lane's agent spends 11 tokens (one run-attributed exchange); the
      // join must read the run-wide meter, not sum the lanes' context copies.
      instance.usage.observeExchange(
        makeLlmExchange({
          workflowRunId: WF_ID,
          usage: { inputTokensTotal: 10, outputTokensTotal: 1, canonicalTotalTokens: 11 },
        }),
      );
      return makeAgentResult({
        outputHash: `researcher-${input.context.lane?.id ?? 'none'}`,
        totalTokens: instance.usage.snapshot().totalTokens,
      });
    };
    const deterministicStub: DeterministicStub = async (input) => {
      deterministicCalls.push({ stateId: input.stateId, laneId: input.context.lane?.id });
      return recordedDeterministicStub(input);
    };

    const { actor, visited } = driveParent(orchestrator, tmpDir, agentStub, deterministicStub, parallelDefinition);
    await settle();

    expect(actor.getSnapshot().status).toBe('done');
    expect(actor.getSnapshot().value).toBe('done');
    expect(visited.filter((v) => v === 'orchestrator')).toHaveLength(2);
    expect(visited.filter((v) => v === 'workers')).toHaveLength(1);
    expect(reenteredOrchestratorTokens).toBe(33);
    expect(researcherLaneIds.sort()).toEqual([0, 1, 2]);
    expect(
      deterministicCalls
        .filter((call) => call.stateId === 'sample')
        .map((call) => call.laneId)
        .sort(),
    ).toEqual([0, 1, 2]);
    expect(
      deterministicCalls
        .filter((call) => call.stateId === 'evaluate')
        .map((call) => call.laneId)
        .sort(),
    ).toEqual([0, 1, 2]);
    expect(
      deterministicCalls
        .filter((call) => call.stateId === 'analysis_record')
        .map((call) => call.laneId)
        .sort(),
    ).toEqual([0, 1, 2]);

    const log = readFileSync(join(tmpDir, 'messages.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; workers?: number; children?: unknown[] });
    expect(log.find((entry) => entry.type === 'fanout_join')).toMatchObject({
      workers: 3,
      children: [
        { index: 0, status: 'recorded' },
        { index: 1, status: 'recorded' },
        { index: 2, status: 'recorded' },
      ],
    });
  });

  it('promotes cognition and computes the canonical stop_signals exactly once at the barrier for a workers:3 batch', async () => {
    const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
    // A sample state whose run carries a real evolve_result.py command, so the
    // orchestrator drives the barrier-side sample_batch, promote_cognition, and
    // compute_stop_signals through executeDeterministicState (the bare commands
    // in fanOutDefinition are not recognized as evolve commands, so none fire).
    const evolveDefinition = evolveBarrierDefinition(3);

    let orchestratorTurn = 0;
    const agentStub: AgentStub = async (input) => {
      if (input.stateId === 'orchestrator') {
        orchestratorTurn += 1;
        return makeVerdictResult(orchestratorTurn === 1 ? 'design' : 'finished');
      }
      return makeAgentResult();
    };

    const barrierCalls: DeterministicInvokeInput[] = [];
    const deterministicStub = makeBarrierDeterministicStub({
      lanes: [0, 1, 2],
      onBarrierCall: (input) => barrierCalls.push(input),
    });
    const callsFor = (stateId: string): DeterministicInvokeInput[] => barrierCalls.filter((c) => c.stateId === stateId);

    const { actor } = driveParent(orchestrator, tmpDir, agentStub, deterministicStub, evolveDefinition);
    await settle();

    expect(actor.getSnapshot().status).toBe('done');
    expect(actor.getSnapshot().value).toBe('done');
    // Cognition promotion is barrier-owned: exactly ONE promote_cognition call
    // over all recorded lanes, before the single stop_signals recompute.
    const promotionCalls = callsFor('analysis_record_promote_cognition');
    expect(promotionCalls).toHaveLength(1);
    expect(promotionCalls[0].commands[0]).toEqual(
      expect.arrayContaining([
        'promote_cognition',
        '--run-dir',
        '/workspace/.evolve_runs/main',
        '--lane',
        '0',
        '--lane',
        '1',
        '--lane',
        '2',
      ]),
    );
    expect(promotionCalls[0].resultFile).toBe('.evolve_runs/main/current/cognition_promotion.json');
    // The barrier owns the canonical stop_signals: exactly ONE compute per batch,
    // not one per lane.
    const stopSignalsCalls = callsFor('sample_stop_signals');
    expect(stopSignalsCalls).toHaveLength(1);
    expect(stopSignalsCalls[0].commands[0]).toEqual(
      expect.arrayContaining(['compute_stop_signals', '--run-dir', '/workspace/.evolve_runs/main']),
    );
    // And the canonical file is the bare current/stop_signals.json the
    // orchestrator routes on (no lane_ segment), written once.
    expect(stopSignalsCalls[0].resultFile).not.toContain('lane_');
    // The single barrier-side sample_batch fired once (not one sample per lane).
    expect(callsFor('sample_batch')).toHaveLength(1);
    expect(barrierCalls.map((c) => c.stateId)).toEqual([
      'sample_batch',
      'analysis_record_promote_cognition',
      'sample_stop_signals',
    ]);
  });

  it('reconstructs a partially recorded batch and respawns only missing lanes', async () => {
    const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
    const evolveDefinition = evolveBarrierDefinition(3);
    writeEvolveNodes(tmpDir, [0], 1);

    let orchestratorTurn = 0;
    const researcherLaneIds: number[] = [];
    const deterministicCalls: Array<{ stateId: string; laneId: number | undefined }> = [];
    const barrierCalls: DeterministicInvokeInput[] = [];
    const agentStub: AgentStub = async (input) => {
      if (input.stateId === 'orchestrator') {
        orchestratorTurn += 1;
        return makeVerdictResult(orchestratorTurn === 1 ? 'design' : 'finished');
      }
      researcherLaneIds.push(input.context.lane?.id ?? -1);
      return makeAgentResult({ outputHash: `researcher-lane-${input.context.lane?.id ?? 'none'}` });
    };
    const barrierStub = makeBarrierDeterministicStub({
      lanes: [1, 2],
      onBarrierCall: (input) => barrierCalls.push(input),
      onAnalysisRecord: (input) => {
        const lane = input.context.lane?.id;
        if (lane === undefined) throw new Error('analysis_record missing lane context');
        appendEvolveNode(tmpDir, lane, 1);
        return {
          passed: true,
          verdict: 'recorded',
          payload: { step_name: `step_0001_lane_${lane}`, node_id: lane + 10 },
        };
      },
    });
    const deterministicStub: DeterministicStub = async (input) => {
      deterministicCalls.push({ stateId: input.stateId, laneId: input.context.lane?.id });
      return barrierStub(input);
    };
    const callsFor = (stateId: string): DeterministicInvokeInput[] => barrierCalls.filter((c) => c.stateId === stateId);

    const { actor } = driveParent(orchestrator, tmpDir, agentStub, deterministicStub, evolveDefinition);
    await settle();

    expect(actor.getSnapshot().status).toBe('done');
    expect(actor.getSnapshot().value).toBe('done');
    expect(researcherLaneIds.sort()).toEqual([1, 2]);
    expect(
      deterministicCalls
        .filter((call) => ['sample', 'evaluate', 'analysis_record'].includes(call.stateId))
        .map((call) => `${call.stateId}:${call.laneId}`)
        .sort(),
    ).toEqual(['analysis_record:1', 'analysis_record:2', 'evaluate:1', 'evaluate:2', 'sample:1', 'sample:2']);
    const sampleBatchCalls = callsFor('sample_batch');
    expect(sampleBatchCalls).toHaveLength(1);
    expect(sampleBatchCalls[0].commands[0]).toEqual(
      expect.arrayContaining(['--workers', '3', '--lane', '1', '--lane', '2', '--batch-index', '1']),
    );
    const promotionCalls = callsFor('analysis_record_promote_cognition');
    expect(promotionCalls).toHaveLength(1);
    expect(promotionCalls[0].commands[0]).toEqual(
      expect.arrayContaining(['--lane', '0', '--lane', '1', '--lane', '2']),
    );

    const nodes = JSON.parse(
      readFileSync(join(tmpDir, '.evolve_runs', 'main', 'database_data', 'nodes.json'), 'utf-8'),
    ) as { nodes: Record<string, { meta_info?: { step_name?: string } }> };
    const stepNames = Object.values(nodes.nodes).map((node) => node.meta_info?.step_name);
    expect(stepNames.sort()).toEqual(['step_0001_lane_0', 'step_0001_lane_1', 'step_0001_lane_2']);
    expect(stepNames).not.toContain('step_0002_lane_1');
  });

  it('treats a fully-recorded highest batch as complete and starts a fresh batch (no index reuse, no synthesis)', async () => {
    // Edge: every lane of batch 1 already recorded. Indistinguishable from
    // nodes.json alone whether the crash hit AFTER the join completed (batch
    // done) or before it. The reconstruction heuristic resolves this the safe
    // way — a fully-present highest batch is COMPLETE, so resume advances to a
    // FRESH batch 2 and re-runs every lane (idempotency lives in lane-tagged
    // step names, not in skipping the re-run). The partial-recorded tests above
    // cover the in-flight REUSE branch; this covers the advance branch.
    const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
    const evolveDefinition = evolveBarrierDefinition(3);
    writeEvolveNodes(tmpDir, [0, 1, 2], 1);

    let orchestratorTurn = 0;
    const researcherLaneIds: number[] = [];
    const deterministicCalls: Array<{ stateId: string; laneId: number | undefined }> = [];
    const barrierCalls: DeterministicInvokeInput[] = [];
    const agentStub: AgentStub = async (input) => {
      if (input.stateId === 'orchestrator') {
        orchestratorTurn += 1;
        return makeVerdictResult(orchestratorTurn === 1 ? 'design' : 'finished');
      }
      researcherLaneIds.push(input.context.lane?.id ?? -1);
      return makeAgentResult({ outputHash: `researcher-lane-${input.context.lane?.id ?? 'none'}` });
    };
    const barrierStub = makeBarrierDeterministicStub({
      lanes: [0, 1, 2],
      onBarrierCall: (input) => barrierCalls.push(input),
      onAnalysisRecord: (input) => {
        const lane = input.context.lane?.id;
        if (lane === undefined) throw new Error('analysis_record missing lane context');
        // Fresh batch 2 records new lane-tagged nodes; no collision with batch 1.
        appendEvolveNode(tmpDir, lane, 2);
        return {
          passed: true,
          verdict: 'recorded',
          payload: { step_name: `step_0002_lane_${lane}`, node_id: lane + 20 },
        };
      },
    });
    const deterministicStub: DeterministicStub = async (input) => {
      deterministicCalls.push({ stateId: input.stateId, laneId: input.context.lane?.id });
      return barrierStub(input);
    };
    const callsFor = (stateId: string): DeterministicInvokeInput[] => barrierCalls.filter((c) => c.stateId === stateId);

    const { actor } = driveParent(orchestrator, tmpDir, agentStub, deterministicStub, evolveDefinition);
    await settle();

    expect(actor.getSnapshot().status).toBe('done');
    expect(actor.getSnapshot().value).toBe('done');
    // Every lane re-ran fresh (nothing synthesized): all three researchers and
    // all three segment deterministic calls fired.
    expect(researcherLaneIds.sort()).toEqual([0, 1, 2]);
    expect(
      deterministicCalls
        .filter((call) => ['sample', 'evaluate', 'analysis_record'].includes(call.stateId))
        .map((call) => `${call.stateId}:${call.laneId}`)
        .sort(),
    ).toEqual([
      'analysis_record:0',
      'analysis_record:1',
      'analysis_record:2',
      'evaluate:0',
      'evaluate:1',
      'evaluate:2',
      'sample:0',
      'sample:1',
      'sample:2',
    ]);
    // A fresh batch: sample_batch draws ALL lanes and pins NO --batch-index
    // (recordedByLane was empty, so TS lets the bridge derive batch 2 itself).
    const sampleBatchCalls = callsFor('sample_batch');
    expect(sampleBatchCalls).toHaveLength(1);
    expect(sampleBatchCalls[0].commands[0]).toEqual(
      expect.arrayContaining(['--workers', '3', '--lane', '0', '--lane', '1', '--lane', '2']),
    );
    expect(sampleBatchCalls[0].commands[0]).not.toContain('--batch-index');
    // The new batch promotes its three lanes; nodes.json now holds both batches.
    expect(callsFor('analysis_record_promote_cognition')).toHaveLength(1);
    const nodes = JSON.parse(
      readFileSync(join(tmpDir, '.evolve_runs', 'main', 'database_data', 'nodes.json'), 'utf-8'),
    ) as { nodes: Record<string, { meta_info?: { step_name?: string } }> };
    expect(
      Object.values(nodes.nodes)
        .map((node) => node.meta_info?.step_name)
        .sort(),
    ).toEqual([
      'step_0001_lane_0',
      'step_0001_lane_1',
      'step_0001_lane_2',
      'step_0002_lane_0',
      'step_0002_lane_1',
      'step_0002_lane_2',
    ]);
  });

  it('resume replays workers and reconstructs a partially recorded batch from the DB', async () => {
    const originalHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = join(tmpDir, 'ironcurtain-home');
    try {
      const checkpointStore = createCheckpointStore(tmpDir);
      const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) => makeStubInfrastructure(input));
      const destroyInfra = vi.fn(async () => {});
      const orchestrator = new WorkflowOrchestrator(
        createDeps(tmpDir, {
          checkpointStore,
          createWorkflowInfrastructure: createInfra,
          destroyWorkflowInfrastructure: destroyInfra,
        }),
      );
      const evolveDefinition = evolveBarrierDefinition(3, true);
      const definitionPath = join(tmpDir, 'workflow.json');
      writeFileSync(definitionPath, JSON.stringify(evolveDefinition, null, 2));
      mkdirSync(join(tmpDir, WF_ID), { recursive: true });
      writeRunDefinition(join(tmpDir, WF_ID), evolveDefinition);
      // A dedicated workspace: resume re-validates a non-default checkpoint
      // workspace, and one that contained IRONCURTAIN_HOME would be rejected.
      const workspaceDir = join(tmpDir, 'workspace');
      mkdirSync(workspaceDir);
      writeEvolveNodes(workspaceDir, [0], 1);
      checkpointStore.save(WF_ID, {
        machineState: 'workers',
        context: {
          ...createInitialContext(evolveDefinition),
          taskDescription: 'resume fan-out batch',
        },
        timestamp: new Date().toISOString(),
        transitionHistory: [],
        definitionPath,
        workspacePath: workspaceDir,
      });

      const researcherLaneIds: number[] = [];
      const deterministicCalls: Array<{ stateId: string; laneId: number | undefined }> = [];
      const barrierCalls: DeterministicInvokeInput[] = [];
      const internal = orchestrator as unknown as {
        executeAgentState: ExecuteAgent;
        executeDeterministicState: ExecuteDeterministic;
      };
      internal.executeAgentState = async (_id, input) => {
        if (input.stateId === 'orchestrator') return makeVerdictResult('finished');
        researcherLaneIds.push(input.context.lane?.id ?? -1);
        return makeAgentResult({ outputHash: `resume-researcher-lane-${input.context.lane?.id ?? 'none'}` });
      };
      const barrierStub = makeBarrierDeterministicStub({
        lanes: [1, 2],
        onBarrierCall: (input) => barrierCalls.push(input),
        onAnalysisRecord: (input) => {
          const lane = input.context.lane?.id;
          if (lane === undefined) throw new Error('analysis_record missing lane context');
          appendEvolveNode(workspaceDir, lane, 1);
          return {
            passed: true,
            verdict: 'recorded',
            payload: { step_name: `step_0001_lane_${lane}`, node_id: lane + 10 },
          };
        },
      });
      internal.executeDeterministicState = async (_id, input) => {
        deterministicCalls.push({ stateId: input.stateId, laneId: input.context.lane?.id });
        return barrierStub(input);
      };

      await orchestrator.resume(WF_ID);
      await waitForCompletion(orchestrator, WF_ID);

      expect(researcherLaneIds.sort()).toEqual([1, 2]);
      expect(
        deterministicCalls
          .filter((call) => ['sample', 'evaluate', 'analysis_record'].includes(call.stateId))
          .map((call) => `${call.stateId}:${call.laneId}`)
          .sort(),
      ).toEqual(['analysis_record:1', 'analysis_record:2', 'evaluate:1', 'evaluate:2', 'sample:1', 'sample:2']);
      const sampleBatchCalls = barrierCalls.filter((c) => c.stateId === 'sample_batch');
      expect(sampleBatchCalls).toHaveLength(1);
      expect(sampleBatchCalls[0].commands[0]).toEqual(
        expect.arrayContaining(['--workers', '3', '--lane', '1', '--lane', '2', '--batch-index', '1']),
      );
      const nodes = JSON.parse(
        readFileSync(join(workspaceDir, '.evolve_runs', 'main', 'database_data', 'nodes.json'), 'utf-8'),
      ) as { nodes: Record<string, { meta_info?: { step_name?: string } }> };
      expect(
        Object.values(nodes.nodes)
          .map((node) => node.meta_info?.step_name)
          .sort(),
      ).toEqual(['step_0001_lane_0', 'step_0001_lane_1', 'step_0001_lane_2']);
    } finally {
      if (originalHome === undefined) delete process.env.IRONCURTAIN_HOME;
      else process.env.IRONCURTAIN_HOME = originalHome;
    }
  });

  it('(b) a blocked child routes the parent to human_escalation with the reason surfaced', async () => {
    const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));

    const agentStub: AgentStub = async (input) =>
      input.stateId === 'orchestrator' ? makeVerdictResult('design') : makeAgentResult();
    const deterministicStub: DeterministicStub = async (input) => {
      if (input.stateId === 'sample') return { passed: true, verdict: 'sampled' };
      if (input.stateId === 'evaluate') {
        return { passed: false, verdict: 'evaluator_blocked', errors: 'evaluator needs credentials' };
      }
      return { passed: true, verdict: 'recorded' };
    };

    const { actor } = driveParent(orchestrator, tmpDir, agentStub, deterministicStub);
    await settle();

    // Parent waits at the human gate; the gate is a non-final state.
    expect(actor.getSnapshot().value).toBe('human_escalation');
    expect(actor.getSnapshot().status).toBe('active');
    // The joined context carries the aggregated lane reason for the single gate.
    expect(actor.getSnapshot().context.previousAgentOutput).toContain('lane 0 blocked: evaluator needs credentials');
    expect(actor.getSnapshot().context.lastDeterministicResult).toMatchObject({
      verdict: 'escalate',
      payload: { issues: [{ index: 0, status: 'blocked', reason: 'evaluator needs credentials' }] },
    });
  });

  it('workers:1 escalation -> APPROVE routes to legacy evaluate-resume, NOT a fresh design batch', async () => {
    // workers:1 is the SHIPPED default and still routes through runFanOutSegment.
    // A blocked single lane yields verdict `escalate`, but at workers:1 the
    // scratch is the BARE current/ (the lane carries no `lane` marker), so the
    // correct recovery on APPROVE is the legacy evaluate-resume of the one
    // written-but-unscored candidate — NOT discard + fresh design batch. The fix
    // tags previousAgentOutput with the scratch shape; this test asserts the
    // orchestrator routes on that tag to `evaluate`. The orchestrator stub models
    // the LLM's prompt rule: bare-scratch tag -> evaluate, lane-scoped -> design.
    const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
    const resumeDefinition: WorkflowDefinition = {
      ...fanOutDefinition,
      states: {
        ...fanOutDefinition.states,
        orchestrator: {
          ...agentStateOf(fanOutDefinition, 'orchestrator'),
          transitions: [
            { to: 'workers', when: { verdict: 'design' } },
            { to: 'evaluate', when: { verdict: 'evaluate' } },
            { to: 'done' },
          ],
        },
      },
    };

    let orchestratorTurn = 0;
    const orchestratorMessages: Array<string | null | undefined> = [];
    const agentStub: AgentStub = async (input) => {
      if (input.stateId === 'orchestrator') {
        orchestratorTurn += 1;
        if (orchestratorTurn === 1) return makeVerdictResult('design');
        // Turn 2 = the post-APPROVE recovery decision; turn 3+ = after the resumed
        // round records, so terminate the run.
        if (orchestratorTurn >= 3) return makeVerdictResult('finished');
        // Re-entry after APPROVE: route exactly as the prompt instructs, off the
        // scratch-shape tag the fix writes onto previousAgentOutput.
        const message = input.context.previousAgentOutput;
        orchestratorMessages.push(message);
        if (typeof message === 'string' && message.includes('Scratch is the bare current/')) {
          return makeVerdictResult('evaluate');
        }
        if (typeof message === 'string' && message.includes('Scratch is lane-scoped')) {
          return makeVerdictResult('design');
        }
        // No scratch-shape tag (the pre-fix message): the orchestrator cannot tell
        // the scratch is bare, so it falls through to a fresh design batch — the
        // wrong recovery this test guards against.
        return makeVerdictResult('design');
      }
      return makeAgentResult();
    };

    let evaluateResumeRuns = 0;
    const deterministicStub: DeterministicStub = async (input) => {
      if (input.stateId === 'sample') return { passed: true, verdict: 'sampled' };
      if (input.stateId === 'evaluate') {
        // First entry (in-batch) blocks; the resume entry (standalone, no lane)
        // succeeds, proving the candidate was re-evaluated rather than discarded.
        if (input.context.lane === undefined && evaluateResumeRuns === 0) {
          evaluateResumeRuns += 1;
          return { passed: false, verdict: 'evaluator_blocked', errors: 'evaluator needs credentials' };
        }
        evaluateResumeRuns += 1;
        return { passed: true, verdict: 'evaluated' };
      }
      return { passed: true, verdict: 'recorded' };
    };

    const { actor, visited } = driveParent(orchestrator, tmpDir, agentStub, deterministicStub, resumeDefinition);
    await settle();

    expect(actor.getSnapshot().value).toBe('human_escalation');
    expect(actor.getSnapshot().status).toBe('active');
    // The escalation message carries the bare-scratch tag (the disambiguator).
    expect(actor.getSnapshot().context.previousAgentOutput).toContain('Scratch is the bare current/');
    expect(actor.getSnapshot().context.previousAgentOutput).not.toContain('Scratch is lane-scoped');

    resolveActiveGate(orchestrator, WF_ID, { type: 'APPROVE' });
    await settle();

    // The orchestrator routed to the legacy evaluate-resume (re-running the one
    // blocked candidate standalone), NOT back into `workers` for a fresh batch.
    expect(visited).toContain('evaluate');
    expect(orchestratorMessages.some((m) => typeof m === 'string' && m.includes('Scratch is the bare current/'))).toBe(
      true,
    );
    // `workers` ran exactly once (the initial batch); the resume did NOT re-enter it.
    expect(visited.filter((state) => state === 'workers')).toHaveLength(1);
    // The standalone evaluate re-ran and passed, so the round records and the run
    // completes through orchestrator -> done.
    expect(actor.getSnapshot().value).toBe('done');
    expect(actor.getSnapshot().status).toBe('done');
  });

  it('drains peer lanes on the first blocked child and opens one aggregated gate', async () => {
    const raiseGate = vi.fn();
    const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir, { raiseGate }));
    const parallelDefinition: WorkflowDefinition = {
      ...fanOutDefinition,
      settings: { ...fanOutDefinition.settings, workers: 3 },
    };

    const pendingResearchers = new Map<number, Deferred<AgentInvokeResult>>();
    const deterministicCalls: Array<{ stateId: string; laneId: number | undefined }> = [];
    const agentStub: AgentStub = async (input) => {
      if (input.stateId === 'orchestrator') {
        return makeVerdictResult('design');
      }
      const lane = input.context.lane?.id ?? -1;
      if (lane === 0) {
        return makeAgentResult({ outputHash: 'researcher-lane-0' });
      }
      const hold = deferred<AgentInvokeResult>();
      pendingResearchers.set(lane, hold);
      return hold.promise;
    };
    const deterministicStub: DeterministicStub = async (input) => {
      deterministicCalls.push({ stateId: input.stateId, laneId: input.context.lane?.id });
      if (input.stateId === 'sample') return { passed: true, verdict: 'sampled' };
      if (input.stateId === 'evaluate' && input.context.lane?.id === 0) {
        return { passed: false, verdict: 'evaluator_blocked', errors: 'lane 0 evaluator blocked' };
      }
      if (input.stateId === 'evaluate') {
        throw new Error(`lane ${input.context.lane?.id} should have been drained before evaluate`);
      }
      return recordedDeterministicStub(input);
    };

    const { actor } = driveParent(orchestrator, tmpDir, agentStub, deterministicStub, parallelDefinition);
    await settle();

    expect(actor.getSnapshot().value).toBe('human_escalation');
    expect(actor.getSnapshot().status).toBe('active');
    expect(raiseGate).toHaveBeenCalledTimes(1);
    expect(raiseGate.mock.calls[0][0]).toMatchObject({
      stateName: 'human_escalation',
      summary: expect.stringContaining('lane 0 blocked: lane 0 evaluator blocked'),
    });
    expect(actor.getSnapshot().context.previousAgentOutput).toContain('lane 0 blocked: lane 0 evaluator blocked');
    expect(actor.getSnapshot().context.lastDeterministicResult).toMatchObject({
      verdict: 'escalate',
      payload: { issues: [{ index: 0, status: 'blocked', reason: 'lane 0 evaluator blocked' }] },
    });

    expect(pendingResearchers.has(1)).toBe(true);
    expect(pendingResearchers.has(2)).toBe(true);
    expect(
      deterministicCalls
        .filter((call) => call.stateId === 'evaluate')
        .map((call) => call.laneId)
        .sort(),
    ).toEqual([0]);
    expect(deterministicCalls.some((call) => call.stateId === 'analysis_record')).toBe(false);

    const log = readFileSync(join(tmpDir, 'messages.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; verdict?: string; children?: Array<{ status: string }> });
    expect(log.find((entry) => entry.type === 'fanout_join')).toMatchObject({
      verdict: 'escalate',
      children: [{ status: 'blocked' }, { status: 'drained' }, { status: 'drained' }],
    });

    for (const hold of pendingResearchers.values()) {
      hold.resolve(makeAgentResult());
    }
  });

  it('APPROVE after a drained escalation lets the orchestrator start a fresh batch', async () => {
    const raiseGate = vi.fn();
    const dismissGate = vi.fn();
    const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir, { raiseGate, dismissGate }));
    const parallelDefinition: WorkflowDefinition = {
      ...fanOutDefinition,
      settings: { ...fanOutDefinition.settings, workers: 3 },
    };

    const firstBatchHeldResearchers = new Map<number, Deferred<AgentInvokeResult>>();
    const deterministicCalls: Array<{ stateId: string; laneId: number | undefined; turn: number }> = [];
    let orchestratorTurn = 0;
    const agentStub: AgentStub = async (input) => {
      if (input.stateId === 'orchestrator') {
        orchestratorTurn += 1;
        return makeVerdictResult(orchestratorTurn <= 2 ? 'design' : 'finished');
      }
      const lane = input.context.lane?.id ?? -1;
      if (orchestratorTurn === 1 && lane !== 0) {
        const hold = deferred<AgentInvokeResult>();
        firstBatchHeldResearchers.set(lane, hold);
        return hold.promise;
      }
      return makeAgentResult({ outputHash: `researcher-turn-${orchestratorTurn}-lane-${lane}` });
    };
    const deterministicStub: DeterministicStub = async (input) => {
      deterministicCalls.push({ stateId: input.stateId, laneId: input.context.lane?.id, turn: orchestratorTurn });
      if (input.stateId === 'sample') return { passed: true, verdict: 'sampled' };
      if (input.stateId === 'evaluate' && orchestratorTurn === 1 && input.context.lane?.id === 0) {
        return { passed: false, verdict: 'evaluator_blocked', errors: 'lane 0 evaluator blocked' };
      }
      if (input.stateId === 'evaluate') return { passed: true, verdict: 'evaluated' };
      if (input.stateId === 'analysis_record') return { passed: true, verdict: 'recorded' };
      return recordedDeterministicStub(input);
    };

    const { actor, visited } = driveParent(orchestrator, tmpDir, agentStub, deterministicStub, parallelDefinition);
    await settle();

    expect(actor.getSnapshot().value).toBe('human_escalation');
    expect(raiseGate).toHaveBeenCalledTimes(1);
    expect(
      deterministicCalls.filter((call) => call.turn === 1 && call.stateId === 'evaluate').map((call) => call.laneId),
    ).toEqual([0]);

    for (const hold of firstBatchHeldResearchers.values()) {
      hold.resolve(makeAgentResult());
    }
    resolveActiveGate(orchestrator, WF_ID, { type: 'APPROVE' });
    await settle();

    expect(dismissGate).toHaveBeenCalledTimes(1);
    expect(actor.getSnapshot().status).toBe('done');
    expect(actor.getSnapshot().value).toBe('done');
    expect(visited.filter((state) => state === 'human_escalation')).toHaveLength(1);
    expect(visited.filter((state) => state === 'workers')).toHaveLength(2);
    expect(visited).not.toContain('evaluate');
    expect(
      deterministicCalls
        .filter((call) => call.turn === 2 && call.stateId === 'sample')
        .map((call) => call.laneId)
        .sort(),
    ).toEqual([0, 1, 2]);
    expect(
      deterministicCalls
        .filter((call) => call.turn === 2 && call.stateId === 'analysis_record')
        .map((call) => call.laneId)
        .sort(),
    ).toEqual([0, 1, 2]);
  });

  it('(c) a thrown agent service drives the lane to errored and the parent to failed', async () => {
    const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));

    const agentStub: AgentStub = async (input) => {
      if (input.stateId === 'orchestrator') return makeVerdictResult('design');
      throw new Error('researcher crashed'); // the lane's agent rejects
    };

    const { actor } = driveParent(orchestrator, tmpDir, agentStub, recordedDeterministicStub);
    await settle();

    // Without the child onError -> errored fix, the crashed lane would land in
    // `recorded`, the batch verdict would be `recorded`, and the parent would
    // re-enter `orchestrator` (then `done`) instead of `failed`. This is the
    // runnable discrimination test for MUST-FIX #1.
    expect(actor.getSnapshot().value).toBe('failed');
    expect(actor.getSnapshot().status).toBe('done');
    expect(actor.getSnapshot().context.lastError).toContain('lane 0 errored: researcher crashed');
  });

  it('(c2) a thrown deterministic service also drives the parent to failed', async () => {
    const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));

    const agentStub: AgentStub = async (input) =>
      input.stateId === 'orchestrator' ? makeVerdictResult('design') : makeAgentResult();
    const deterministicStub: DeterministicStub = async (input) => {
      if (input.stateId === 'sample') return { passed: true, verdict: 'sampled' };
      throw new Error('evaluate harness crashed'); // the lane's evaluate rejects
    };

    const { actor } = driveParent(orchestrator, tmpDir, agentStub, deterministicStub);
    await settle();

    expect(actor.getSnapshot().value).toBe('failed');
    expect(actor.getSnapshot().status).toBe('done');
    expect(actor.getSnapshot().context.lastError).toContain('lane 0 errored: evaluate harness crashed');
  });
});

// ---------------------------------------------------------------------------
// Fan-out engine guards: persona homogeneity under a shared container, the
// single pre-lane policy cycle, and a lane's upstream failure at the barrier.
// ---------------------------------------------------------------------------

/** Shared-container (docker + sharedContainer) variant of the fixture with N lanes. */
function sharedContainerDefinition(workers: number): WorkflowDefinition {
  return {
    ...fanOutDefinition,
    settings: {
      ...fanOutDefinition.settings,
      mode: 'docker',
      dockerAgent: 'claude-code',
      sharedContainer: true,
      workers,
    },
  };
}

/**
 * Adds a second agent member (`analyzer`) between `researcher` and `evaluate`
 * so the segment has two agent states whose personas / scopes can differ.
 */
function withAnalyzer(
  definition: WorkflowDefinition,
  personas: { readonly researcher: string; readonly analyzer: string },
  scopes: { readonly researcher?: string; readonly analyzer?: string } = {},
): WorkflowDefinition {
  const researcher = definition.states.researcher;
  const workers = definition.states.workers;
  if (researcher.type !== 'agent' || workers.type !== 'deterministic') throw new Error('fixture shape changed');
  const analyzer: WorkflowStateDefinition = {
    type: 'agent',
    description: 'Analyzes the candidate',
    persona: personas.analyzer,
    prompt: 'You are an analyzer.',
    inputs: [],
    outputs: [],
    fanOutMember: true,
    transitions: [{ to: 'evaluate' }],
    ...(scopes.analyzer !== undefined ? { containerScope: scopes.analyzer } : {}),
  };
  return {
    ...definition,
    states: {
      ...definition.states,
      workers: { ...workers, segment: ['sample', 'researcher', 'analyzer', 'evaluate', 'analysis_record'] },
      researcher: {
        ...researcher,
        persona: personas.researcher,
        transitions: [{ to: 'analyzer' }],
        ...(scopes.researcher !== undefined ? { containerScope: scopes.researcher } : {}),
      },
      analyzer,
    },
  };
}

function readErrorLog(tmpDir: string): Array<{ error: string; context?: string }> {
  return readFileSync(join(tmpDir, 'messages.jsonl'), 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { type: string; error?: string; context?: string })
    .filter((entry) => entry.type === 'error')
    .map((entry) => ({ error: entry.error ?? '', ...(entry.context !== undefined ? { context: entry.context } : {}) }));
}

function readErrorEntries(tmpDir: string): string[] {
  return readErrorLog(tmpDir).map((entry) => entry.error);
}

async function waitForActorDone(actor: AnyActorRef, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while ((actor.getSnapshot() as { status: string }).status !== 'done') {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`actor still ${String((actor.getSnapshot() as { value: unknown }).value)} after ${timeoutMs}ms`);
    }
    await settle(10);
  }
}

describe('WorkflowOrchestrator fan-out engine guards', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fanout-guards-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('refuses a multi-lane shared-container segment whose agent members use different personas before any lane starts', async () => {
    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) => makeStubInfrastructure(input));
    const orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        createWorkflowInfrastructure: createInfra,
        destroyWorkflowInfrastructure: vi.fn(async () => {}),
      }),
    );
    const definition = withAnalyzer(sharedContainerDefinition(2), { researcher: 'reader', analyzer: 'writer' });

    const agentCalls: string[] = [];
    const agentStub: AgentStub = async (input) => {
      agentCalls.push(input.stateId);
      return makeVerdictResult(input.stateId === 'orchestrator' ? 'design' : 'approved');
    };

    const { actor, visited } = driveParent(orchestrator, tmpDir, agentStub, recordedDeterministicStub, definition);
    await waitForActorDone(actor);

    // The batch is refused as a result_file_error verdict (-> failed); no lane
    // ran, no bundle was minted, and the gate was never reached.
    expect(actor.getSnapshot().value).toBe('failed');
    expect(visited).not.toContain('human_escalation');
    expect(agentCalls).toEqual(['orchestrator']);
    expect(createInfra).not.toHaveBeenCalled();

    const errors = readErrorEntries(tmpDir);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('different personas');
    expect(errors[0]).toContain('researcher: reader, analyzer: writer');
    expect(errors[0]).toContain('2 concurrent lanes');
  });

  it('refuses a shared-container segment spanning multiple container scopes', async () => {
    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) => makeStubInfrastructure(input));
    const orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        createWorkflowInfrastructure: createInfra,
        destroyWorkflowInfrastructure: vi.fn(async () => {}),
      }),
    );
    const definition = withAnalyzer(
      sharedContainerDefinition(2),
      { researcher: 'global', analyzer: 'global' },
      { researcher: 'alpha', analyzer: 'beta' },
    );

    const agentCalls: string[] = [];
    const agentStub: AgentStub = async (input) => {
      agentCalls.push(input.stateId);
      return makeVerdictResult(input.stateId === 'orchestrator' ? 'design' : 'approved');
    };

    const { actor } = driveParent(orchestrator, tmpDir, agentStub, recordedDeterministicStub, definition);
    await waitForActorDone(actor);

    expect(actor.getSnapshot().value).toBe('failed');
    expect(agentCalls).toEqual(['orchestrator']);
    expect(createInfra).not.toHaveBeenCalled();
    expect(readErrorEntries(tmpDir)[0]).toContain('multiple container scopes (alpha, beta)');
  });

  it("installs the segment's single persona once before any lane starts, so the lanes skip the swap", async () => {
    const originalHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = join(tmpDir, 'ironcurtain-home');
    try {
      const events: string[] = [];
      const loadPolicy = vi.fn(async (input: LoadPolicyRpcInput) => {
        events.push(`loadPolicy:${input.persona}`);
      });
      const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) => makeStubInfrastructure(input));
      const orchestrator = new WorkflowOrchestrator(
        createDeps(tmpDir, {
          createWorkflowInfrastructure: createInfra,
          destroyWorkflowInfrastructure: vi.fn(async () => {}),
          loadPolicyRpc: loadPolicy,
        }),
      );
      const definition = withAnalyzer(sharedContainerDefinition(2), { researcher: 'global', analyzer: 'global' });

      let orchestratorTurn = 0;
      const agentStub: AgentStub = async (input) => {
        if (input.stateId === 'orchestrator') {
          orchestratorTurn += 1;
          return makeVerdictResult(orchestratorTurn === 1 ? 'design' : 'finished');
        }
        events.push(`agent:${input.stateId}:lane${input.context.lane?.id ?? '-'}`);
        return makeAgentResult();
      };

      const { actor } = driveParent(orchestrator, tmpDir, agentStub, recordedDeterministicStub, definition);
      await waitForActorDone(actor);

      expect(actor.getSnapshot().value).toBe('done');
      // Exactly one bundle and exactly one policy load, and the load happened
      // before any lane's agent ran — so each lane's own cyclePolicy call hits
      // the currentPersonaByBundle short-circuit instead of racing an RPC.
      expect(createInfra).toHaveBeenCalledTimes(1);
      // The bundle's coordinator is told how many lanes share it, so each
      // lane's agent connection keeps its own circuit-breaker window.
      expect(createInfra.mock.calls[0][0].maxLanes).toBe(2);
      expect(loadPolicy).toHaveBeenCalledTimes(1);
      expect(loadPolicy.mock.calls[0][0].persona).toBe('global');
      expect(events[0]).toBe('loadPolicy:global');
      expect(events.filter((event) => event.startsWith('agent:'))).toHaveLength(4);

      const bundleId = createInfra.mock.calls[0][0].bundleId;
      const internal = orchestrator as unknown as {
        workflows: Map<WorkflowId, { currentPersonaByBundle: Map<string, string> }>;
      };
      expect(internal.workflows.get(WF_ID)?.currentPersonaByBundle.get(bundleId)).toBe('global');
    } finally {
      if (originalHome === undefined) delete process.env.IRONCURTAIN_HOME;
      else process.env.IRONCURTAIN_HOME = originalHome;
    }
  });

  it("re-raises a lane's quota exhaustion at the barrier so the run halts on a terminal instead of the batch verdict's gate", async () => {
    const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
    // Route every failed-batch verdict to the gate so the two outcomes are
    // distinguishable: verdict routing would park the run at
    // human_escalation; the upstream-failure path must end on a terminal.
    const definition: WorkflowDefinition = {
      ...fanOutDefinition,
      settings: { ...fanOutDefinition.settings, workers: 2 },
      states: {
        ...fanOutDefinition.states,
        workers: {
          ...deterministicStateOf(fanOutDefinition, 'workers'),
          transitions: [
            { to: 'orchestrator', when: { verdict: 'recorded' } },
            { to: 'human_escalation', when: { verdict: 'escalate' } },
            { to: 'human_escalation', when: { verdict: 'result_file_error' } },
            { to: 'human_escalation' },
          ],
        },
      },
    };

    const internal = orchestrator as unknown as {
      workflows: Map<WorkflowId, { quotaExhausted?: { rawMessage: string } }>;
    };
    let orchestratorTurn = 0;
    const agentStub: AgentStub = async (input) => {
      if (input.stateId === 'orchestrator') {
        orchestratorTurn += 1;
        return makeVerdictResult('design');
      }
      // Mirror executeAgentState's sendAgentTurn: stamp the instance, then
      // reject with the wrapped quota error.
      const instance = internal.workflows.get(WF_ID);
      if (!instance) throw new Error('fan-out test instance missing');
      instance.quotaExhausted = { rawMessage: 'Usage limit reached' };
      throw new AgentInvocationError({
        stateId: input.stateId,
        agentConversationId: createAgentConversationId(),
        cause: new WorkflowQuotaExhaustedError({ stateId: input.stateId, rawMessage: 'Usage limit reached' }),
      });
    };

    const { actor, visited } = driveParent(orchestrator, tmpDir, agentStub, recordedDeterministicStub, definition);
    await waitForActorDone(actor);

    // `failed` is the abort-preserving terminal here (the fixture has no
    // `aborted`); the gate the verdict table points at is never entered.
    expect(actor.getSnapshot().value).toBe('failed');
    expect(visited).not.toContain('human_escalation');
    expect(actor.getSnapshot().context.lastError).toContain('quota exhausted');
    expect(orchestratorTurn).toBe(1);
    // handleWorkflowComplete reads the stamp and reports the run as aborted
    // (resumable), exactly as a serial agent-state quota failure does.
    expect(orchestrator.getStatus(WF_ID)?.phase).toBe('aborted');
  });
});

// ---------------------------------------------------------------------------
// Every reason a fan-out batch fails reaches the message log, the tab and
// stderr, not only a preflight refusal. The parent routes on the verdict and
// keeps only the result's context (updateContextFromFanOutResult), so the
// reason in `errors` would otherwise be lost to `workflow inspect` (FU-17).
// ---------------------------------------------------------------------------

describe('WorkflowOrchestrator fan-out failure reporting', () => {
  let tmpDir: string;
  let stderr: MockInstance<typeof process.stderr.write>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fanout-failure-log-'));
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderr.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function stderrLines(): string[] {
    return stderr.mock.calls.map((call) => String(call[0]));
  }

  /** The orchestrator fans out once, then finishes. */
  function designOnce(): AgentStub {
    let orchestratorTurn = 0;
    return async (input) => {
      if (input.stateId !== 'orchestrator') return makeAgentResult();
      orchestratorTurn += 1;
      return makeVerdictResult(orchestratorTurn === 1 ? 'design' : 'finished');
    };
  }

  function tabLines(orchestrator: WorkflowOrchestrator): string[] {
    const internal = orchestrator as unknown as {
      workflows: Map<WorkflowId, { tab: { write: ReturnType<typeof vi.fn> } }>;
    };
    return (internal.workflows.get(WF_ID)?.tab.write.mock.calls ?? []).map((call) => String(call[0]));
  }

  /** Fails one barrier subcommand of an otherwise recording evolve batch. */
  function failingBarrier(failingStateId: string, errors: string): DeterministicStub {
    const barrier = makeBarrierDeterministicStub({ lanes: [0, 1, 2] });
    return async (input) =>
      input.stateId === failingStateId ? { passed: false, verdict: 'needs_repair', errors } : barrier(input);
  }

  it('logs the reason a lane promise rejected', async () => {
    const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
    type Waiter = { readonly promise: Promise<unknown> };
    const internal = orchestrator as unknown as {
      waitForRoundChild: (actor: AnyActorRef, index: number, onDrain: (trigger: unknown) => void) => Waiter;
    };
    const waitForRoundChild = internal.waitForRoundChild.bind(orchestrator);
    internal.waitForRoundChild = (actor, index, onDrain) => {
      const waiter = waitForRoundChild(actor, index, onDrain);
      return { ...waiter, promise: waiter.promise.then(() => Promise.reject(new Error('boom'))) };
    };

    const { actor } = driveParent(orchestrator, tmpDir, designOnce(), recordedDeterministicStub);
    await waitForActorDone(actor);

    expect(actor.getSnapshot().value).toBe('failed');
    expect(readErrorLog(tmpDir)).toEqual([{ error: 'boom', context: 'fan-out "workers" join' }]);
    expect(tabLines(orchestrator)).toContain('[error] Fan-out "workers" failed (join): boom');
    expect(stderrLines()).toContain('[workflow] fan-out "workers" failed (join): boom\n');
  });

  it('logs a batch that cannot be reconstructed from a corrupt evolve DB', async () => {
    const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
    const dbDir = join(tmpDir, '.evolve_runs', 'main', 'database_data');
    mkdirSync(dbDir, { recursive: true });
    writeFileSync(join(dbDir, 'nodes.json'), '{ not json');

    const { actor } = driveParent(
      orchestrator,
      tmpDir,
      designOnce(),
      makeBarrierDeterministicStub({ lanes: [0, 1, 2] }),
      evolveBarrierDefinition(3),
    );
    await waitForActorDone(actor);

    expect(actor.getSnapshot().value).toBe('failed');
    const errors = readErrorLog(tmpDir);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toContain('could not parse evolve nodes DB');
    expect(errors[0].context).toBe('fan-out "workers" batch reconstruction');
  });

  it.each([
    ['sample_batch', 'lane preparation'],
    ['analysis_record_promote_cognition', 'cognition promotion'],
    ['sample_stop_signals', 'stop signals'],
  ])('logs a failed barrier step %s as a %s failure', async (failingStateId, stage) => {
    const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
    const reason = `${failingStateId} exploded`;

    const { actor } = driveParent(
      orchestrator,
      tmpDir,
      designOnce(),
      failingBarrier(failingStateId, reason),
      evolveBarrierDefinition(3),
    );
    await waitForActorDone(actor);

    expect(actor.getSnapshot().value).toBe('failed');
    expect(readErrorLog(tmpDir)).toEqual([{ error: reason, context: `fan-out "workers" ${stage}` }]);
    expect(tabLines(orchestrator)).toContain(`[error] Fan-out "workers" failed (${stage}): ${reason}`);
  });

  it('bounds a long reason and escapes control characters on stderr', async () => {
    const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
    const reason = `\u001b]0;pwned\u0007${'x'.repeat(20_000)}`;

    const { actor } = driveParent(
      orchestrator,
      tmpDir,
      designOnce(),
      failingBarrier('sample_batch', reason),
      evolveBarrierDefinition(3),
    );
    await waitForActorDone(actor);

    const [entry] = readErrorLog(tmpDir);
    expect(Buffer.byteLength(entry.error, 'utf-8')).toBeLessThanOrEqual(4096);
    expect(entry.error).toContain('[... truncated]');
    const line = stderrLines().find((text) => text.includes('fan-out "workers"'));
    expect(line).toBeDefined();
    expect(line).not.toContain('\u001b');
    expect(line).toContain('\\u001b');
  });

  it('reports nothing for a batch whose run is stopping', async () => {
    const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
    const internal = orchestrator as unknown as {
      workflows: Map<WorkflowId, { stopController: AbortController }>;
    };
    // The barrier step fails because the run is stopping (a killed host
    // command reports a failure, it does not throw).
    const barrier = makeBarrierDeterministicStub({ lanes: [0, 1, 2] });
    const stopping: DeterministicStub = async (input) => {
      if (input.stateId !== 'analysis_record_promote_cognition') return barrier(input);
      internal.workflows.get(WF_ID)?.stopController.abort();
      return { passed: false, errors: 'command "python" was killed: the workflow is stopping' };
    };

    driveParent(orchestrator, tmpDir, designOnce(), stopping, evolveBarrierDefinition(3));
    await settle(50);

    expect(readErrorLog(tmpDir)).toEqual([]);
    expect(stderrLines().filter((line) => line.includes('fan-out "workers"'))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Drained lanes vs. the shared coordinator. A drain stops a lane's actor at
// its next state boundary, but the agent turn already in flight keeps running
// in the shared container (a borrow-mode session close does not stop it) and
// keeps calling tools through the bundle's one coordinator after the batch has
// returned. These run the REAL start() / executeAgentState path; only the
// deterministic leaf executor is stubbed.
// ---------------------------------------------------------------------------

describe('WorkflowOrchestrator fan-out: drained lane turns on the shared coordinator', () => {
  let tmpDir: string;
  let cleanupPersonas: (() => void) | undefined;
  let activeOrchestrator: WorkflowOrchestrator | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fanout-drained-'));
  });

  afterEach(async () => {
    await activeOrchestrator?.shutdownAll();
    activeOrchestrator = undefined;
    cleanupPersonas?.();
    cleanupPersonas = undefined;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * `orchestrator` (persona `orchestratorPersona`) -> `workers` (2 shared-container
   * lanes whose only agent member, `researcher`, uses `researcherPersona`) ->
   * `human_escalation` when a lane's evaluator blocks.
   */
  function twoLaneDefinition(orchestratorPersona: string, researcherPersona: string): WorkflowDefinition {
    const { orchestrator, researcher, sample, evaluate, analysis_record } = fanOutDefinition.states;
    if (
      orchestrator.type !== 'agent' ||
      researcher.type !== 'agent' ||
      sample.type !== 'deterministic' ||
      evaluate.type !== 'deterministic' ||
      analysis_record.type !== 'deterministic'
    ) {
      throw new Error('fixture shape changed');
    }
    return {
      ...fanOutDefinition,
      // Distinct personas on the one shared scope: an explicit single trust domain.
      settings: {
        mode: 'docker',
        dockerAgent: 'claude-code',
        sharedContainer: true,
        allowMixedPersonas: true,
        workers: 2,
        maxRounds: 10,
      },
      states: {
        ...fanOutDefinition.states,
        orchestrator: { ...orchestrator, persona: orchestratorPersona },
        researcher: { ...researcher, persona: researcherPersona },
        // Verdict-routed deterministic members must run in the container.
        sample: { ...sample, container: true },
        evaluate: { ...evaluate, container: true },
        analysis_record: { ...analysis_record, container: true },
      },
    };
  }

  /** Persona dirs (persona.json + a compiled policy) for every non-global persona the definition uses. */
  function stubPersonas(definition: WorkflowDefinition): void {
    cleanupPersonas = stubPersonasForTest(tmpDir, definition);
    const home = process.env.IRONCURTAIN_HOME;
    if (!home) throw new Error('stubPersonasForTest did not set IRONCURTAIN_HOME');
    for (const state of Object.values(definition.states)) {
      if (state.type !== 'agent' || state.persona === 'global') continue;
      writePersonaPolicy(join(home, 'personas', state.persona));
    }
  }

  /** Lane 0's evaluator blocks (drains lane 1 and escalates); everything else passes. */
  const escalatingDeterministicStub: DeterministicStub = async (input) => {
    if (input.stateId === 'sample') return { passed: true, verdict: 'sampled' };
    if (input.stateId === 'evaluate' && input.context.lane?.id === 0) {
      return { passed: false, verdict: 'evaluator_blocked', errors: 'lane 0 evaluator blocked' };
    }
    if (input.stateId === 'evaluate') return { passed: true, verdict: 'evaluated' };
    return { passed: true, verdict: 'recorded' };
  };

  interface DrainHarness {
    readonly orchestrator: WorkflowOrchestrator;
    readonly raiseGate: ReturnType<typeof vi.fn>;
    readonly loadPolicy: ReturnType<typeof vi.fn>;
    readonly events: string[];
    /** Resolves lane 1's held researcher turn with the given result. */
    readonly releaseLane1: (result: AgentTurnResult) => void;
    readonly lane1Session: () => MockSession | undefined;
    readonly orchestratorSessions: () => number;
  }

  function createDrainHarness(): DrainHarness {
    const events: string[] = [];
    const lane1Turn = deferred<AgentTurnResult>();
    let lane1: MockSession | undefined;
    let orchestratorSessions = 0;

    const createSession = vi.fn(async (opts: SessionOptions) => {
      const stateId = opts.workflow?.stateId;
      if (stateId === 'orchestrator') {
        orchestratorSessions += 1;
        const verdict = orchestratorSessions === 1 ? 'design' : 'finished';
        events.push(`orchestrator:session:${orchestratorSessions}`);
        return new MockSession({ responses: [statusBlock(verdict, 'orchestrated')] });
      }
      if (stateId === 'researcher' && opts.workflow?.stateSlug?.startsWith('researcher_lane_1.')) {
        lane1 = new MockSession({
          responses: async () => {
            if (lane1 && lane1.sentMessages.length > 1) return noStatusResponse();
            events.push('lane1:turn-start');
            const result = await lane1Turn.promise;
            events.push('lane1:turn-end');
            return result;
          },
        });
        return lane1;
      }
      return new MockSession({ responses: [statusBlock('done', 'researched')] });
    });
    const loadPolicy = vi.fn(async (input: LoadPolicyRpcInput) => {
      events.push(`loadPolicy:${input.persona}`);
    });
    const raiseGate = vi.fn();
    const orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        createSession,
        raiseGate,
        loadPolicyRpc: loadPolicy,
        createWorkflowInfrastructure: vi.fn(async (input: CreateWorkflowInfrastructureInput) =>
          makeStubInfrastructure(input),
        ),
        destroyWorkflowInfrastructure: vi.fn(async () => {}),
      }),
    );
    (orchestrator as unknown as { executeDeterministicState: ExecuteDeterministic }).executeDeterministicState = (
      _id,
      input,
    ) => escalatingDeterministicStub(input);
    activeOrchestrator = orchestrator;
    return {
      orchestrator,
      raiseGate,
      loadPolicy,
      events,
      releaseLane1: (result) => lane1Turn.resolve(result),
      lane1Session: () => lane1,
      orchestratorSessions: () => orchestratorSessions,
    };
  }

  it("does not swap the coordinator to the next state's persona while a drained lane's turn is still running", async () => {
    const definition = twoLaneDefinition('writer', 'reader');
    stubPersonas(definition);
    const harness = createDrainHarness();

    const workflowId = await harness.orchestrator.start(writeDefinitionFile(tmpDir, definition), 'task');
    await waitForGate(harness.raiseGate, 1);
    // Lane 0 escalated and drained lane 1, whose researcher turn (persona
    // `reader`) is still running on the shared coordinator.
    expect(harness.events).toContain('lane1:turn-start');
    expect(harness.events).not.toContain('lane1:turn-end');
    expect(harness.loadPolicy.mock.calls.map((call) => (call[0] as LoadPolicyRpcInput).persona)).toEqual([
      'writer',
      'reader',
    ]);

    resolveActiveGate(harness.orchestrator, workflowId, { type: 'APPROVE' });
    await settle(100);

    // The orchestrator (persona `writer`) must not load its policy onto the
    // coordinator the drained `reader` turn is still calling tools through.
    expect(harness.loadPolicy).toHaveBeenCalledTimes(2);
    expect(harness.orchestratorSessions()).toBe(1);

    harness.releaseLane1({ text: noStatusResponse(), hardFailure: false });
    await waitForCompletion(harness.orchestrator, workflowId);

    expect(harness.orchestrator.getStatus(workflowId)?.phase).toBe('completed');
    const turnEnd = harness.events.indexOf('lane1:turn-end');
    const writerReload = harness.events.lastIndexOf('loadPolicy:writer');
    expect(turnEnd).toBeGreaterThan(-1);
    expect(writerReload).toBeGreaterThan(turnEnd);
    // The drained lane sent no further turn (no status-recovery reprompt)
    // after its in-flight turn ended.
    expect(harness.lane1Session()?.sentMessages).toHaveLength(1);
  });

  it("releases a failed invocation's live-turn registration, so a later swap to another persona does not wait on it", async () => {
    // `plan` (reader) fails before its session exists and routes to the gate;
    // `review` (writer) then swaps the coordinator. A registration leaked on
    // the error path would make that swap wait forever.
    const definition: WorkflowDefinition = {
      name: 'failed-then-swap',
      description: 'A failed reader state, a gate, then a writer state on one shared coordinator',
      initial: 'plan',
      settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true, allowMixedPersonas: true },
      states: {
        plan: {
          type: 'agent',
          description: 'Plans',
          persona: 'reader',
          prompt: 'Plan.',
          inputs: [],
          outputs: [],
          transitions: [{ to: 'gate', when: { verdict: 'escalate' } }, { to: 'review' }],
        },
        gate: {
          type: 'human_gate',
          description: 'Review the failure',
          acceptedEvents: ['APPROVE', 'ABORT'],
          transitions: [
            { to: 'review', event: 'APPROVE' },
            { to: 'aborted', event: 'ABORT' },
          ],
        },
        review: {
          type: 'agent',
          description: 'Reviews',
          persona: 'writer',
          prompt: 'Review.',
          inputs: [],
          outputs: [],
          transitions: [{ to: 'done' }],
        },
        done: { type: 'terminal', description: 'Done' },
        aborted: { type: 'terminal', description: 'Aborted' },
      },
    };
    stubPersonas(definition);
    const loadPolicy = vi.fn(async () => {});
    const raiseGate = vi.fn();
    const orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        createSession: vi.fn(async (opts: SessionOptions) => {
          if (opts.workflow?.stateId === 'plan') throw new Error('session start failed');
          return new MockSession({ responses: [statusBlock('done', 'reviewed')] });
        }),
        raiseGate,
        loadPolicyRpc: loadPolicy,
        createWorkflowInfrastructure: vi.fn(async (input: CreateWorkflowInfrastructureInput) =>
          makeStubInfrastructure(input),
        ),
        destroyWorkflowInfrastructure: vi.fn(async () => {}),
      }),
    );
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(writeDefinitionFile(tmpDir, definition), 'task');
    await waitForGate(raiseGate, 1);
    const internal = orchestrator as unknown as {
      workflows: Map<WorkflowId, { liveAgentTurnsByBundle: Map<string, Set<unknown>> }>;
    };
    expect(internal.workflows.get(workflowId)?.liveAgentTurnsByBundle.size).toBe(0);

    resolveActiveGate(orchestrator, workflowId, { type: 'APPROVE' });
    await waitForCompletion(orchestrator, workflowId);

    expect(orchestrator.getStatus(workflowId)?.phase).toBe('completed');
    expect(loadPolicy.mock.calls.map((call) => (call as unknown as [LoadPolicyRpcInput])[0].persona)).toEqual([
      'reader',
      'writer',
    ]);
  });

  it("does not let a drained lane's late quota report mark a run that then completes as aborted", async () => {
    const definition = twoLaneDefinition('global', 'global');
    stubPersonas(definition);
    const harness = createDrainHarness();

    const workflowId = await harness.orchestrator.start(writeDefinitionFile(tmpDir, definition), 'task');
    await waitForGate(harness.raiseGate, 1);

    // The drained lane's in-flight turn reports quota exhaustion while the
    // run waits at the gate. Its lane already settled as `drained`, so the
    // report reaches no onError edge: it must not leave a stamp behind.
    harness.releaseLane1({
      text: 'Usage limit reached',
      hardFailure: false,
      quotaExhausted: { rawMessage: 'Usage limit reached' },
    });
    await settle(50);

    resolveActiveGate(harness.orchestrator, workflowId, { type: 'APPROVE' });
    await waitForCompletion(harness.orchestrator, workflowId);

    expect(harness.orchestrator.getStatus(workflowId)?.phase).toBe('completed');
  });
});
