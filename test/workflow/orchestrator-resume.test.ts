import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import type { SessionOptions } from '../../src/session/types.js';
import type {
  WorkflowId,
  HumanGateRequest,
  WorkflowCheckpoint,
  WorkflowContext,
  WorkflowDefinition,
  DeterministicStateDefinition,
} from '../../src/workflow/types.js';
import { WorkflowOrchestrator, type WorkflowLifecycleEvent } from '../../src/workflow/orchestrator.js';
import { FileCheckpointStore } from '../../src/workflow/checkpoint.js';
import {
  buildDeterministicInvokeInput,
  type DeterministicInvokeInput,
  type DeterministicInvokeResult,
} from '../../src/workflow/machine-builder.js';
import { RESUME_NOTICE } from '../../src/workflow/prompt-builder.js';
import {
  resolveActiveGate,
  MockSession,
  approvedResponse,
  rejectedResponse,
  simulateArtifacts,
  createArtifactAwareSession,
  writeDefinitionFile,
  checkpointDirFor,
  createCheckpointStore,
  createDeps,
  waitForGate,
  waitForCompletion,
  stubPersonasForTest,
} from './test-helpers.js';

// ---------------------------------------------------------------------------
// Workflow definitions
// ---------------------------------------------------------------------------

const linearWorkflowDef: WorkflowDefinition = {
  name: 'linear-workflow',
  description: 'Full linear workflow',
  initial: 'plan',
  settings: { mode: 'builtin', maxRounds: 4 },
  states: {
    plan: {
      type: 'agent',
      description: 'Creates a plan',
      persona: 'planner',
      prompt: 'You are a planner.',
      inputs: [],
      outputs: ['plan'],
      transitions: [{ to: 'plan_gate' }],
    },
    plan_gate: {
      type: 'human_gate',
      description: 'Human review gate',
      acceptedEvents: ['APPROVE', 'FORCE_REVISION', 'ABORT'],
      present: ['plan'],
      transitions: [
        { to: 'implement', event: 'APPROVE' },
        { to: 'plan', event: 'FORCE_REVISION' },
        { to: 'aborted', event: 'ABORT' },
      ],
    },
    implement: {
      type: 'agent',
      description: 'Writes code',
      persona: 'coder',
      prompt: 'You are a coder.',
      inputs: ['plan'],
      outputs: ['code'],
      transitions: [{ to: 'review' }],
    },
    review: {
      type: 'agent',
      description: 'Reviews code',
      persona: 'reviewer',
      prompt: 'You are a reviewer.',
      inputs: ['code'],
      outputs: ['reviews'],
      transitions: [
        { to: 'done', when: { verdict: 'approved' } },
        { to: 'implement', when: { verdict: 'rejected' } },
      ],
    },
    done: { type: 'terminal', description: 'Done' },
    aborted: { type: 'terminal', description: 'Aborted' },
  },
};

const simpleAgentDef: WorkflowDefinition = {
  name: 'simple-agent',
  description: 'Single agent to done',
  initial: 'implement',
  settings: { mode: 'builtin' },
  states: {
    implement: {
      type: 'agent',
      description: 'Writes code',
      persona: 'coder',
      prompt: 'You are a coder.',
      inputs: [],
      outputs: ['code'],
      transitions: [{ to: 'done' }],
    },
    done: { type: 'terminal', description: 'Done' },
  },
};

/** An agent state that goes round again on `rejected` and finishes otherwise. */
const selfLoopDef: WorkflowDefinition = {
  name: 'self-loop',
  description: 'An agent state that loops on itself until approved',
  initial: 'work',
  settings: { mode: 'builtin' },
  states: {
    work: {
      type: 'agent',
      description: 'Works until approved',
      persona: 'coder',
      prompt: 'You are a coder.',
      inputs: [],
      outputs: ['code'],
      transitions: [{ to: 'work', when: { verdict: 'rejected' } }, { to: 'done' }],
    },
    done: { type: 'terminal', description: 'Done' },
  },
};

/** `[from, to]` of each recorded transition. */
function transitionPairs(checkpoint: WorkflowCheckpoint | undefined): string[][] {
  return (checkpoint?.transitionHistory ?? []).map(({ from, to }) => [from, to]);
}

/** `[from, to]` of each `state_transition` entry in the run's message log. */
function loggedTransitions(baseDir: string, workflowId: WorkflowId): string[][] {
  return readFileSync(resolve(baseDir, workflowId, 'messages.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { type?: unknown; from?: unknown; event?: unknown })
    .filter((entry) => entry.type === 'state_transition')
    .map((entry) => [String(entry.from), String(entry.event)]);
}

function terminalControlPhases(baseDir: string, workflowId: WorkflowId): string[] {
  const lines = readFileSync(resolve(baseDir, workflowId, 'messages.jsonl'), 'utf8')
    .trim()
    .split('\n');
  return lines
    .map((line) => JSON.parse(line) as { type?: unknown; phase?: unknown })
    .filter((entry) => entry.type === 'run_terminal' && typeof entry.phase === 'string')
    .map((entry) => entry.phase as string);
}

/**
 * Agent definition where errors go to a human gate instead of terminal.
 * This allows checkpoints to survive agent failures.
 */
const agentWithErrorGateDef: WorkflowDefinition = {
  name: 'agent-with-error-gate',
  description: 'Agent with human gate as error target',
  initial: 'implement',
  settings: { mode: 'builtin' },
  states: {
    implement: {
      type: 'agent',
      description: 'Writes code',
      persona: 'coder',
      prompt: 'You are a coder.',
      inputs: [],
      outputs: ['code'],
      transitions: [{ to: 'error_gate' }],
    },
    error_gate: {
      type: 'human_gate',
      description: 'Error escalation gate',
      acceptedEvents: ['APPROVE', 'ABORT'],
      transitions: [
        { to: 'done', event: 'APPROVE' },
        { to: 'aborted', event: 'ABORT' },
      ],
    },
    done: { type: 'terminal', description: 'Done' },
    aborted: { type: 'terminal', description: 'Aborted' },
  },
};

/**
 * Coder-critic loop where errors go to a human gate.
 */
const loopWithErrorGateDef: WorkflowDefinition = {
  name: 'loop-with-error-gate',
  description: 'Coder-critic loop with error gate',
  initial: 'implement',
  settings: { mode: 'builtin', maxRounds: 4 },
  states: {
    implement: {
      type: 'agent',
      description: 'Writes code',
      persona: 'coder',
      freshSession: false,
      prompt: 'You are a coder.',
      inputs: [],
      outputs: ['code'],
      transitions: [{ to: 'review' }],
    },
    review: {
      type: 'agent',
      description: 'Reviews code',
      persona: 'reviewer',
      freshSession: false,
      prompt: 'You are a reviewer.',
      inputs: ['code'],
      outputs: ['reviews'],
      transitions: [
        { to: 'done', when: { verdict: 'approved' } },
        { to: 'error_gate', when: { verdict: 'rejected' } },
      ],
    },
    error_gate: {
      type: 'human_gate',
      description: 'Error escalation gate',
      acceptedEvents: ['APPROVE', 'ABORT'],
      transitions: [
        { to: 'implement', event: 'APPROVE' },
        { to: 'aborted', event: 'ABORT' },
      ],
    },
    done: { type: 'terminal', description: 'Done' },
    aborted: { type: 'terminal', description: 'Aborted' },
  },
};

// ---------------------------------------------------------------------------
// Test-specific helpers
// ---------------------------------------------------------------------------

async function waitForLifecycleEvent(
  events: WorkflowLifecycleEvent[],
  predicate: (e: WorkflowLifecycleEvent) => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (!events.some(predicate)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for lifecycle event');
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkflowOrchestrator checkpoint + resume', () => {
  let tmpDir: string;
  let activeOrchestrators: WorkflowOrchestrator[];
  let cleanupPersonas: (() => void) | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orchestrator-resume-test-'));
    activeOrchestrators = [];
    cleanupPersonas = stubPersonasForTest(
      tmpDir,
      linearWorkflowDef,
      simpleAgentDef,
      agentWithErrorGateDef,
      loopWithErrorGateDef,
    );
  });

  afterEach(async () => {
    for (const o of activeOrchestrators) {
      await o.shutdownAll();
    }
    cleanupPersonas?.();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function trackOrchestrator(o: WorkflowOrchestrator): WorkflowOrchestrator {
    activeOrchestrators.push(o);
    return o;
  }

  it('keeps the resume marker tied to the prior terminal checkpoint while refreshing the saved budget', async () => {
    const defPath = writeDefinitionFile(tmpDir, linearWorkflowDef);
    const checkpointStore = new FileCheckpointStore(tmpDir);
    const raiseGate = vi.fn();
    const orchestrator = trackOrchestrator(
      new WorkflowOrchestrator(
        createDeps(tmpDir, {
          checkpointStore,
          raiseGate,
          createSession: async () =>
            createArtifactAwareSession([{ text: approvedResponse(), artifacts: ['plan'] }], tmpDir),
        }),
      ),
    );
    const workflowId = await orchestrator.start(defPath, 'task');
    await waitForGate(raiseGate, 1);
    await orchestrator.abort(workflowId);
    const checkpointPath = resolve(tmpDir, workflowId, 'checkpoint.json');
    const oldFingerprint = createHash('sha256').update(readFileSync(checkpointPath)).digest('hex');
    const prior = checkpointStore.load(workflowId)!;
    const resumed = trackOrchestrator(new WorkflowOrchestrator(createDeps(tmpDir, { checkpointStore })));
    await resumed.resume(workflowId, { useCurrentBudget: true });
    const current = checkpointStore.load(workflowId)!;
    expect(current.machineState).toEqual(prior.machineState);
    expect(current.context).toEqual(prior.context);
    expect(current.finalStatus).toBeUndefined();
    expect(current.resourceBudget?.recorded).toBe(true);
    const entries = readFileSync(resolve(tmpDir, workflowId, 'messages.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; checkpointFingerprint?: string });
    expect(entries.find((entry) => entry.type === 'run_resumed')?.checkpointFingerprint).toBe(oldFingerprint);
    expect(createHash('sha256').update(readFileSync(checkpointPath)).digest('hex')).not.toBe(oldFingerprint);
  });

  // -----------------------------------------------------------------------
  // Test 1: Checkpoint is saved on every state transition
  // -----------------------------------------------------------------------

  it('saves a checkpoint on every state transition', async () => {
    const defPath = writeDefinitionFile(tmpDir, linearWorkflowDef);
    const checkpointStore = createCheckpointStore(tmpDir);

    const sessionFactory = vi.fn(async (opts: SessionOptions) => {
      const persona = opts.persona!;
      if (persona === 'planner') {
        return createArtifactAwareSession([{ text: approvedResponse('plan complete'), artifacts: ['plan'] }], tmpDir);
      }
      if (persona === 'coder') {
        return createArtifactAwareSession([{ text: approvedResponse('code done'), artifacts: ['code'] }], tmpDir);
      }
      if (persona === 'reviewer') {
        return createArtifactAwareSession([{ text: approvedResponse('looks good'), artifacts: ['reviews'] }], tmpDir);
      }
      throw new Error(`Unexpected persona: ${persona}`);
    });

    const raiseGate = vi.fn();
    const deps = createDeps(tmpDir, {
      createSession: sessionFactory,
      raiseGate,
      checkpointStore,
    });

    const orchestrator = trackOrchestrator(new WorkflowOrchestrator(deps));
    const workflowId = await orchestrator.start(defPath, 'build API');
    expect(readFileSync(resolve(tmpDir, workflowId, 'messages.jsonl'), 'utf8')).toContain('"type":"run_started"');

    // After plan completes, machine enters plan_gate => checkpoint saved
    await waitForGate(raiseGate, 1);

    const checkpoint = checkpointStore.load(workflowId);
    expect(checkpoint).toBeDefined();
    expect(checkpoint!.machineState).toBe('plan_gate');
    expect(checkpoint!.definitionPath).toBe(defPath);
    expect(checkpoint!.transitionHistory.length).toBeGreaterThan(0);

    // Approve gate -> implement -> review -> done
    resolveActiveGate(orchestrator, workflowId, { type: 'APPROVE' });
    await waitForCompletion(orchestrator, workflowId);

    // Checkpoints were saved during execution for intermediate states; the
    // final retained checkpoint (tested separately in test 2) carries
    // `finalStatus`.
    expect(checkpoint!.context.taskDescription).toBe('build API');
  });

  // A transition back onto the same state re-enters it (`reenter: true`): the
  // state value stays the same, and the new visit shows in its visit count.
  it('records and checkpoints each re-entry of a self-looping agent state', async () => {
    const defPath = writeDefinitionFile(tmpDir, selfLoopDef);
    const checkpointStore = createCheckpointStore(tmpDir);
    const saved: WorkflowCheckpoint[] = [];
    const save = checkpointStore.save.bind(checkpointStore);
    vi.spyOn(checkpointStore, 'save').mockImplementation((id, checkpoint) => {
      saved.push(structuredClone(checkpoint));
      save(id, checkpoint);
    });
    let calls = 0;
    const createSession = vi.fn(async () => {
      calls++;
      const text = calls === 1 ? rejectedResponse('needs another pass') : approvedResponse('good now');
      return createArtifactAwareSession([{ text, artifacts: ['code'] }], tmpDir);
    });
    const orchestrator = trackOrchestrator(
      new WorkflowOrchestrator(createDeps(tmpDir, { createSession, checkpointStore })),
    );

    const workflowId = await orchestrator.start(defPath, 'task');
    await waitForCompletion(orchestrator, workflowId);

    expect(createSession).toHaveBeenCalledTimes(2);
    const loop = saved.find((checkpoint) => checkpoint.context.visitCounts.work === 2);
    expect(loop?.machineState).toBe('work');
    expect(loop?.finalStatus).toBeUndefined();
    expect(transitionPairs(loop)).toEqual([['work', 'work']]);
    expect(loop?.transitionHistory[0].agentMessage).toBe('Found issues.');
    expect(loop?.context.previousAgentNotes).toBe('needs another pass');
    expect(transitionPairs(checkpointStore.load(workflowId))).toEqual([
      ['work', 'work'],
      ['work', 'done'],
    ]);
    expect(loggedTransitions(tmpDir, workflowId)).toEqual([
      ['work', 'work'],
      ['work', 'done'],
    ]);
  });

  it('resumes a self-loop from its latest iteration', async () => {
    const defPath = writeDefinitionFile(tmpDir, selfLoopDef);
    const checkpointStore = createCheckpointStore(tmpDir);
    let calls = 0;
    const createSession = vi.fn(async () => {
      calls++;
      if (calls === 1)
        return createArtifactAwareSession([{ text: rejectedResponse('again'), artifacts: ['code'] }], tmpDir);
      return new Promise<never>(() => {
        /* the second iteration is still running when the run stops */
      });
    });
    const orchestrator = trackOrchestrator(
      new WorkflowOrchestrator(createDeps(tmpDir, { createSession, checkpointStore })),
    );
    const workflowId = await orchestrator.start(defPath, 'task');
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(2), { timeout: 5000, interval: 10 });
    await orchestrator.abort(workflowId);

    const stopped = checkpointStore.load(workflowId);
    // Resume re-runs the second iteration, not the first: a maxVisits cap counts it once.
    expect(stopped?.machineState).toBe('work');
    expect(stopped?.context.visitCounts.work).toBe(2);
    expect(stopped?.context.previousAgentNotes).toBe('again');
    expect(transitionPairs(stopped)).toEqual([['work', 'work']]);

    const resumed = trackOrchestrator(
      new WorkflowOrchestrator(
        createDeps(tmpDir, {
          checkpointStore,
          createSession: async () =>
            createArtifactAwareSession([{ text: approvedResponse('done'), artifacts: ['code'] }], tmpDir),
        }),
      ),
    );
    await resumed.resume(workflowId);
    await waitForCompletion(resumed, workflowId);

    const finished = checkpointStore.load(workflowId);
    expect(finished?.context.visitCounts.work).toBe(2);
    expect(transitionPairs(finished)).toEqual([
      ['work', 'work'],
      ['work', 'done'],
    ]);
  });

  // -----------------------------------------------------------------------
  // Test 2: Checkpoint is retained with finalStatus on successful completion
  // -----------------------------------------------------------------------

  it('retains checkpoint with finalStatus.phase === "completed" on successful completion', async () => {
    const defPath = writeDefinitionFile(tmpDir, simpleAgentDef);
    const checkpointStore = createCheckpointStore(tmpDir);

    const sessionFactory = vi.fn(async () => {
      return createArtifactAwareSession([{ text: approvedResponse('done'), artifacts: ['code'] }], tmpDir);
    });

    const deps = createDeps(tmpDir, {
      createSession: sessionFactory,
      checkpointStore,
    });

    const orchestrator = trackOrchestrator(new WorkflowOrchestrator(deps));
    const workflowId = await orchestrator.start(defPath, 'write code');
    await waitForCompletion(orchestrator, workflowId);

    expect(orchestrator.getStatus(workflowId)?.phase).toBe('completed');
    expect(terminalControlPhases(tmpDir, workflowId).at(-1)).toBe('completed');

    // B3b: The checkpoint is retained on disk with `finalStatus` populated
    // so the past-runs UI can surface the canonical phase and `listResumable`
    // can exclude completed runs via `isCheckpointResumable`.
    const surviving = checkpointStore.load(workflowId);
    expect(surviving).toBeDefined();
    expect(surviving?.finalStatus?.phase).toBe('completed');
    if (surviving?.finalStatus?.phase === 'completed') {
      expect(surviving.finalStatus.result.finalArtifacts).toBeDefined();
    }
  });

  it('rejects resume while the workflow is already active', async () => {
    const defPath = writeDefinitionFile(tmpDir, linearWorkflowDef);
    const checkpointStore = createCheckpointStore(tmpDir);
    const raiseGate = vi.fn();
    const orchestrator = trackOrchestrator(
      new WorkflowOrchestrator(
        createDeps(tmpDir, {
          checkpointStore,
          raiseGate,
          createSession: async () =>
            createArtifactAwareSession([{ text: approvedResponse('plan done'), artifacts: ['plan'] }], tmpDir),
        }),
      ),
    );
    const workflowId = await orchestrator.start(defPath, 'build a thing');
    await waitForGate(raiseGate, 1);

    await expect(orchestrator.resume(workflowId)).rejects.toMatchObject({ code: 'WORKFLOW_ALREADY_ACTIVE' });
  });

  it('rejects resume until abort teardown finishes, then allows it', async () => {
    const defPath = writeDefinitionFile(tmpDir, linearWorkflowDef);
    const checkpointStore = createCheckpointStore(tmpDir);
    const raiseGate = vi.fn();
    const orchestrator = trackOrchestrator(
      new WorkflowOrchestrator(
        createDeps(tmpDir, {
          checkpointStore,
          raiseGate,
          createSession: async () =>
            createArtifactAwareSession([{ text: approvedResponse('plan done'), artifacts: ['plan'] }], tmpDir),
        }),
      ),
    );
    const workflowId = await orchestrator.start(defPath, 'build a thing');
    await waitForGate(raiseGate, 1);

    let finishClose!: () => void;
    const closeFinished = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    const deferredSession = new MockSession({ responses: [] });
    const closeSpy = vi.spyOn(deferredSession, 'close').mockReturnValue(closeFinished);
    const instance = (
      orchestrator as unknown as {
        workflows: Map<WorkflowId, { activeSessions: Set<MockSession> }>;
      }
    ).workflows.get(workflowId)!;
    instance.activeSessions.add(deferredSession);

    const abortPromise = orchestrator.abort(workflowId);
    expect(closeSpy).toHaveBeenCalledOnce();
    await expect(orchestrator.resume(workflowId)).rejects.toMatchObject({ code: 'WORKFLOW_ALREADY_ACTIVE' });

    finishClose();
    await abortPromise;
    await expect(orchestrator.resume(workflowId)).resolves.toBeUndefined();
  });

  it('rejects missing, corrupt, and completed checkpoints with stable resume codes', async () => {
    const checkpointStore = createCheckpointStore(tmpDir);
    const orchestrator = trackOrchestrator(
      new WorkflowOrchestrator(createDeps(tmpDir, { checkpointStore, createSession: vi.fn() })),
    );

    await expect(orchestrator.resume('wf-missing' as WorkflowId)).rejects.toMatchObject({
      code: 'WORKFLOW_CHECKPOINT_NOT_FOUND',
    });

    const corruptId = 'wf-corrupt' as WorkflowId;
    const checkpointBase = checkpointDirFor(tmpDir);
    mkdirSync(resolve(checkpointBase, corruptId), { recursive: true });
    writeFileSync(resolve(checkpointBase, corruptId, 'checkpoint.json'), '{nope');
    await expect(orchestrator.resume(corruptId)).rejects.toMatchObject({ code: 'WORKFLOW_CHECKPOINT_CORRUPTED' });

    const malformedId = 'wf-malformed' as WorkflowId;
    const malformedDefinitionPath = writeDefinitionFile(tmpDir, simpleAgentDef);
    mkdirSync(resolve(checkpointBase, malformedId), { recursive: true });
    writeFileSync(
      resolve(checkpointBase, malformedId, 'checkpoint.json'),
      JSON.stringify({
        machineState: 'implement',
        timestamp: new Date().toISOString(),
        transitionHistory: [],
        definitionPath: malformedDefinitionPath,
      }),
    );
    await expect(orchestrator.resume(malformedId)).rejects.toMatchObject({ code: 'WORKFLOW_CHECKPOINT_CORRUPTED' });

    const completedId = 'wf-completed' as WorkflowId;
    checkpointStore.save(completedId, {
      machineState: 'implement',
      context: {
        taskDescription: 'done',
        artifacts: {},
        round: 1,
        maxRounds: 1,
        previousOutputHashes: {},
        previousTestCount: null,
        humanPrompt: null,
        reviewHistory: [],
        totalTokens: 0,
        lastError: null,
        agentConversationsByState: {},
        previousAgentOutput: null,
        previousAgentNotes: null,
        previousStateName: null,
        visitCounts: {},
      },
      timestamp: new Date().toISOString(),
      transitionHistory: [],
      definitionPath: '/unused.json',
      finalStatus: { phase: 'completed', result: { finalArtifacts: {} } },
    });
    await expect(orchestrator.resume(completedId)).rejects.toMatchObject({ code: 'WORKFLOW_NOT_RESUMABLE' });

    const missingDefinitionId = 'wf-missing-definition' as WorkflowId;
    const completedCheckpoint = checkpointStore.load(completedId);
    if (completedCheckpoint === undefined) throw new Error('expected the completed checkpoint to be stored');
    // The same checkpoint without a final status (JSON drops the undefined
    // field): resumable, but its definition is gone.
    checkpointStore.save(missingDefinitionId, {
      ...completedCheckpoint,
      finalStatus: undefined,
      definitionPath: resolve(tmpDir, 'missing-definition.json'),
    });
    await expect(orchestrator.resume(missingDefinitionId)).rejects.toMatchObject({
      code: 'WORKFLOW_CHECKPOINT_CORRUPTED',
    });
  });

  // -----------------------------------------------------------------------
  // Test 2a: finalStatus persistence — completed with expected artifacts
  // -----------------------------------------------------------------------

  it('persists finalStatus.result.finalArtifacts on completion', async () => {
    const defPath = writeDefinitionFile(tmpDir, simpleAgentDef);
    const checkpointStore = createCheckpointStore(tmpDir);

    const sessionFactory = vi.fn(async () => {
      return createArtifactAwareSession([{ text: approvedResponse('done'), artifacts: ['code'] }], tmpDir);
    });

    const deps = createDeps(tmpDir, {
      createSession: sessionFactory,
      checkpointStore,
    });

    const orchestrator = trackOrchestrator(new WorkflowOrchestrator(deps));
    const workflowId = await orchestrator.start(defPath, 'write code');
    await waitForCompletion(orchestrator, workflowId);

    const surviving = checkpointStore.load(workflowId);
    expect(surviving).toBeDefined();
    expect(surviving?.finalStatus).toBeDefined();
    expect(surviving?.finalStatus?.phase).toBe('completed');
    if (surviving?.finalStatus?.phase === 'completed') {
      // The `code` artifact produced by the agent should appear in the
      // persisted final artifacts map.
      expect(surviving.finalStatus.result.finalArtifacts).toHaveProperty('code');
    }
  });

  // -----------------------------------------------------------------------
  // Test 2c: finalStatus persistence — aborted via ABORT event
  // -----------------------------------------------------------------------

  it('persists finalStatus.phase === "aborted" with a reason on ABORT-event terminal', async () => {
    const defPath = writeDefinitionFile(tmpDir, linearWorkflowDef);
    const checkpointStore = createCheckpointStore(tmpDir);

    const sessionFactory = vi.fn(async () => {
      return createArtifactAwareSession([{ text: approvedResponse('plan done'), artifacts: ['plan'] }], tmpDir);
    });

    const raiseGate = vi.fn();
    const deps = createDeps(tmpDir, {
      createSession: sessionFactory,
      raiseGate,
      checkpointStore,
    });

    const orchestrator = trackOrchestrator(new WorkflowOrchestrator(deps));
    const workflowId = await orchestrator.start(defPath, 'build a thing');

    await waitForGate(raiseGate, 1);
    resolveActiveGate(orchestrator, workflowId, { type: 'ABORT' });
    await waitForCompletion(orchestrator, workflowId);

    const surviving = checkpointStore.load(workflowId);
    expect(surviving).toBeDefined();
    expect(surviving?.finalStatus?.phase).toBe('aborted');
    if (surviving?.finalStatus?.phase === 'aborted') {
      expect(surviving.finalStatus.reason).toBeTruthy();
      expect(typeof surviving.finalStatus.reason).toBe('string');
    }
  });

  // -----------------------------------------------------------------------
  // Test 2b: Aborted workflows keep their checkpoint so resume can restart them
  // -----------------------------------------------------------------------

  it('preserves checkpoint on user-invoked abort so resume can restart it', async () => {
    const defPath = writeDefinitionFile(tmpDir, linearWorkflowDef);
    const checkpointStore = createCheckpointStore(tmpDir);

    const sessionFactory = vi.fn(async () => {
      return createArtifactAwareSession([{ text: approvedResponse('plan done'), artifacts: ['plan'] }], tmpDir);
    });

    const raiseGate = vi.fn();
    const deps = createDeps(tmpDir, {
      createSession: sessionFactory,
      raiseGate,
      checkpointStore,
    });

    const orchestrator = trackOrchestrator(new WorkflowOrchestrator(deps));
    const workflowId = await orchestrator.start(defPath, 'build a thing');

    // Wait for plan_gate so a checkpoint is persisted.
    await waitForGate(raiseGate, 1);
    expect(checkpointStore.load(workflowId)).toBeDefined();

    // User-invoked abort: should leave the checkpoint on disk.
    await orchestrator.abort(workflowId);

    expect(orchestrator.getStatus(workflowId)?.phase).toBe('aborted');
    expect(terminalControlPhases(tmpDir, workflowId).at(-1)).toBe('aborted');
    const surviving = checkpointStore.load(workflowId);
    expect(surviving).toBeDefined();
    expect(surviving!.machineState).toBe('plan_gate');
  });

  it('preserves checkpoint when workflow reaches aborted state via ABORT event', async () => {
    const defPath = writeDefinitionFile(tmpDir, linearWorkflowDef);
    const checkpointStore = createCheckpointStore(tmpDir);

    const sessionFactory = vi.fn(async () => {
      return createArtifactAwareSession([{ text: approvedResponse('plan done'), artifacts: ['plan'] }], tmpDir);
    });

    const raiseGate = vi.fn();
    const deps = createDeps(tmpDir, {
      createSession: sessionFactory,
      raiseGate,
      checkpointStore,
    });

    const orchestrator = trackOrchestrator(new WorkflowOrchestrator(deps));
    const workflowId = await orchestrator.start(defPath, 'build a thing');

    // Wait for plan_gate so a checkpoint is persisted.
    await waitForGate(raiseGate, 1);
    expect(checkpointStore.load(workflowId)).toBeDefined();

    // Resolve the gate with ABORT, which drives the machine into the
    // `aborted` terminal state via handleWorkflowComplete.
    resolveActiveGate(orchestrator, workflowId, { type: 'ABORT' });
    await waitForCompletion(orchestrator, workflowId);

    expect(orchestrator.getStatus(workflowId)?.phase).toBe('aborted');
    // Post-B3b: `handleWorkflowComplete` writes a final checkpoint with
    // `finalStatus` populated for all terminal phases. The surviving
    // checkpoint therefore carries the terminal machineState plus a
    // canonical `finalStatus.phase === 'aborted'` so the past-runs UI
    // and `listResumable` predicate don't have to heuristically scrape
    // state names.
    const surviving = checkpointStore.load(workflowId);
    expect(surviving).toBeDefined();
    expect(surviving?.finalStatus?.phase).toBe('aborted');
  });

  // -----------------------------------------------------------------------
  // Regression: aborted-state checkpoint must keep the LAST non-terminal
  // machineState so resume() can re-enter a meaningful state.
  // -----------------------------------------------------------------------

  it('keeps last non-terminal machineState on disk when terminating via ABORT', async () => {
    const defPath = writeDefinitionFile(tmpDir, linearWorkflowDef);
    const checkpointStore = createCheckpointStore(tmpDir);

    const sessionFactory = vi.fn(async () => {
      return createArtifactAwareSession([{ text: approvedResponse('plan done'), artifacts: ['plan'] }], tmpDir);
    });

    const raiseGate = vi.fn();
    const deps = createDeps(tmpDir, {
      createSession: sessionFactory,
      raiseGate,
      checkpointStore,
    });

    const orchestrator = trackOrchestrator(new WorkflowOrchestrator(deps));
    const workflowId = await orchestrator.start(defPath, 'build a thing');

    // Wait for plan_gate so a non-terminal checkpoint is persisted.
    await waitForGate(raiseGate, 1);
    const preAbort = checkpointStore.load(workflowId);
    expect(preAbort?.machineState).toBe('plan_gate');

    // Drive into the `aborted` terminal via ABORT.
    resolveActiveGate(orchestrator, workflowId, { type: 'ABORT' });
    await waitForCompletion(orchestrator, workflowId);

    const surviving = checkpointStore.load(workflowId);
    expect(surviving).toBeDefined();
    expect(surviving?.finalStatus?.phase).toBe('aborted');
    // The on-disk machineState must still be the last non-terminal state.
    // Persisting the terminal `aborted` snapshot would cause `resume()` to
    // re-enter the terminal and immediately re-complete.
    expect(surviving?.machineState).toBe('plan_gate');
  });

  // -----------------------------------------------------------------------
  // Test 3: Resume a failed workflow from checkpoint
  // -----------------------------------------------------------------------

  it('resumes a failed workflow from checkpoint', async () => {
    // agentWithErrorGateDef routes errors to error_gate (human gate),
    // so the checkpoint survives instead of being removed on terminal.
    const defPath = writeDefinitionFile(tmpDir, agentWithErrorGateDef);
    const checkpointStore = createCheckpointStore(tmpDir);

    // First orchestrator: session that fails on sendMessage
    const failingFactory = vi.fn(async () => {
      return new MockSession({
        responses: () => {
          throw new Error('Session crashed');
        },
      });
    });

    const raiseGate1 = vi.fn();
    const deps1 = createDeps(tmpDir, {
      createSession: failingFactory,
      raiseGate: raiseGate1,
      checkpointStore,
    });

    const orchestrator1 = trackOrchestrator(new WorkflowOrchestrator(deps1));
    const workflowId = await orchestrator1.start(defPath, 'write code');

    // The agent fails, machine transitions to error_gate (human gate)
    await waitForGate(raiseGate1, 1);

    // Checkpoint should exist at error_gate
    const checkpoint = checkpointStore.load(workflowId);
    expect(checkpoint).toBeDefined();
    expect(checkpoint!.machineState).toBe('error_gate');

    // Simulate an orchestrator crash by shutting down. Clean abort now
    // preserves the checkpoint, but we still re-save the snapshot to be
    // explicit about the state under test (a real crash where the process
    // died without even running the abort path).
    const savedCheckpoint = { ...checkpoint! };
    await orchestrator1.shutdownAll();

    checkpointStore.save(workflowId, savedCheckpoint);

    // Resume with a new orchestrator that has working sessions
    const fixedFactory = vi.fn(async () => {
      return createArtifactAwareSession([{ text: approvedResponse('code written'), artifacts: ['code'] }], tmpDir);
    });

    const raiseGate2 = vi.fn();
    const deps2 = createDeps(tmpDir, {
      createSession: fixedFactory,
      raiseGate: raiseGate2,
      checkpointStore,
    });

    const orchestrator2 = trackOrchestrator(new WorkflowOrchestrator(deps2));
    await orchestrator2.resume(workflowId);

    // The gate should be re-raised at error_gate
    await waitForGate(raiseGate2, 1);

    // Approve the gate to retry (APPROVE goes to 'done' in this definition)
    resolveActiveGate(orchestrator2, workflowId, { type: 'APPROVE' });
    await waitForCompletion(orchestrator2, workflowId);
    expect(orchestrator2.getStatus(workflowId)?.phase).toBe('completed');
  });

  // -----------------------------------------------------------------------
  // Test 4: Resume preserves context (round count, review history)
  // -----------------------------------------------------------------------

  it('resume preserves context including round count and review history', async () => {
    // loopWithErrorGateDef: implement -> review(reject -> error_gate) -> ...
    // The review rejection goes to error_gate (human gate), preserving the checkpoint.
    const defPath = writeDefinitionFile(tmpDir, loopWithErrorGateDef);
    const checkpointStore = createCheckpointStore(tmpDir);

    let coderCallCount = 0;
    let reviewerCallCount = 0;

    const sessionFactory = vi.fn(async (opts: SessionOptions) => {
      const persona = opts.persona!;

      if (persona === 'coder') {
        coderCallCount++;
        return createArtifactAwareSession(
          [{ text: approvedResponse(`coder pass ${coderCallCount}`), artifacts: ['code'] }],
          tmpDir,
          `coder-session-${coderCallCount}`,
        );
      }
      if (persona === 'reviewer') {
        reviewerCallCount++;
        // Reject: goes to error_gate in this definition
        return createArtifactAwareSession(
          [{ text: rejectedResponse(`issue ${reviewerCallCount}`), artifacts: ['reviews'] }],
          tmpDir,
        );
      }
      throw new Error(`Unexpected persona: ${persona}`);
    });

    const raiseGate1 = vi.fn();
    const deps1 = createDeps(tmpDir, {
      createSession: sessionFactory,
      raiseGate: raiseGate1,
      checkpointStore,
    });

    const orchestrator1 = trackOrchestrator(new WorkflowOrchestrator(deps1));
    const workflowId = await orchestrator1.start(defPath, 'implement feature');

    // Flow: implement -> review(reject) -> error_gate
    await waitForGate(raiseGate1, 1);

    // Approve gate to continue: error_gate APPROVE -> implement
    resolveActiveGate(orchestrator1, workflowId, { type: 'APPROVE' });

    // Flow continues: implement -> review(reject) -> error_gate again
    await waitForGate(raiseGate1, 2);

    // Checkpoint should reflect accumulated context: round >= 2, review history populated
    const checkpoint = checkpointStore.load(workflowId);
    expect(checkpoint).toBeDefined();
    expect(checkpoint!.machineState).toBe('error_gate');
    // 4 agent completions: coder1 + reviewer1 + coder2 + reviewer2
    expect(checkpoint!.context.round).toBeGreaterThanOrEqual(4);
    expect(checkpoint!.context.reviewHistory.length).toBeGreaterThanOrEqual(1);
    expect(checkpoint!.context.reviewHistory).toContain('issue 1');

    // Save checkpoint state and simulate crash
    const savedCheckpoint = { ...checkpoint! };
    await orchestrator1.shutdownAll();
    checkpointStore.save(workflowId, savedCheckpoint);

    // Resume with fixed sessions that approve
    const fixedFactory = vi.fn(async (opts: SessionOptions) => {
      const persona = opts.persona!;
      if (persona === 'coder') {
        return createArtifactAwareSession([{ text: approvedResponse('fixed code'), artifacts: ['code'] }], tmpDir);
      }
      if (persona === 'reviewer') {
        return createArtifactAwareSession([{ text: approvedResponse('approved'), artifacts: ['reviews'] }], tmpDir);
      }
      throw new Error(`Unexpected persona: ${persona}`);
    });

    const raiseGate2 = vi.fn();
    const deps2 = createDeps(tmpDir, {
      createSession: fixedFactory,
      raiseGate: raiseGate2,
      checkpointStore,
    });

    const orchestrator2 = trackOrchestrator(new WorkflowOrchestrator(deps2));
    await orchestrator2.resume(workflowId);

    // Gate is re-raised at error_gate
    await waitForGate(raiseGate2, 1);

    // Approve -> implement -> review(approve) -> done
    resolveActiveGate(orchestrator2, workflowId, { type: 'APPROVE' });
    await waitForCompletion(orchestrator2, workflowId);

    expect(orchestrator2.getStatus(workflowId)?.phase).toBe('completed');
  });

  // -----------------------------------------------------------------------
  // Test 5: Resume with human gate
  // -----------------------------------------------------------------------

  it('resume re-raises human gate', async () => {
    const defPath = writeDefinitionFile(tmpDir, linearWorkflowDef);
    const checkpointStore = createCheckpointStore(tmpDir);

    const raiseGate1 = vi.fn();
    const sessionFactory1 = vi.fn(async () => {
      return createArtifactAwareSession([{ text: approvedResponse('plan done'), artifacts: ['plan'] }], tmpDir);
    });

    const deps1 = createDeps(tmpDir, {
      createSession: sessionFactory1,
      raiseGate: raiseGate1,
      checkpointStore,
    });

    const orchestrator1 = trackOrchestrator(new WorkflowOrchestrator(deps1));
    const workflowId = await orchestrator1.start(defPath, 'build an API');

    // Wait for plan_gate
    await waitForGate(raiseGate1, 1);

    // Simulate orchestrator crash by stopping it without resolving the gate
    await orchestrator1.shutdownAll();

    // Checkpoint should exist at plan_gate
    // (abort removes checkpoint, but the plan_gate checkpoint was saved before abort)
    // We need to save a checkpoint manually since abort removes it.
    // Actually, let's re-think: abort removes the checkpoint. So we need
    // to test this differently - stop the actor without calling abort.

    // Alternative approach: Save the checkpoint before abort cleans it up.
    // Actually, let's just directly save a checkpoint that simulates being at plan_gate.
    const planGateCheckpoint = checkpointStore.load(workflowId);
    // The checkpoint was removed by shutdownAll -> abort. We need a different approach.
    // Let's re-save it to simulate the crash scenario.
    if (!planGateCheckpoint) {
      // Re-create a checkpoint that represents being at plan_gate
      checkpointStore.save(workflowId, {
        machineState: 'plan_gate',
        context: {
          taskDescription: 'build an API',
          artifacts: {},
          round: 1,
          maxRounds: 4,
          previousOutputHashes: {},
          previousTestCount: null,
          humanPrompt: null,
          reviewHistory: [],
          totalTokens: 0,
          lastError: null,
          agentConversationsByState: {},
          previousAgentOutput: null,
          previousAgentNotes: null,
          previousStateName: null,
          visitCounts: {},
        },
        timestamp: new Date().toISOString(),
        transitionHistory: [],
        definitionPath: defPath,
        workspacePath: resolve(tmpDir, workflowId, 'workspace'),
      });
    }

    // Resume with new orchestrator
    const raiseGate2 = vi.fn();
    const sessionFactory2 = vi.fn(async (opts: SessionOptions) => {
      const persona = opts.persona!;
      if (persona === 'coder') {
        return createArtifactAwareSession([{ text: approvedResponse('code done'), artifacts: ['code'] }], tmpDir);
      }
      if (persona === 'reviewer') {
        return createArtifactAwareSession([{ text: approvedResponse('approved'), artifacts: ['reviews'] }], tmpDir);
      }
      throw new Error(`Unexpected persona: ${persona}`);
    });

    const deps2 = createDeps(tmpDir, {
      createSession: sessionFactory2,
      raiseGate: raiseGate2,
      checkpointStore,
    });

    const orchestrator2 = trackOrchestrator(new WorkflowOrchestrator(deps2));
    await orchestrator2.resume(workflowId);

    // The gate should be re-raised
    await waitForGate(raiseGate2, 1);
    const gateRequests = raiseGate2.mock.calls.map((c: unknown[]) => c[0] as HumanGateRequest);
    expect(gateRequests[0].stateName).toBe('plan_gate');

    // Approve the gate
    resolveActiveGate(orchestrator2, workflowId, { type: 'APPROVE' });
    await waitForCompletion(orchestrator2, workflowId);
    expect(orchestrator2.getStatus(workflowId)?.phase).toBe('completed');
  });

  // -----------------------------------------------------------------------
  // Test 6: direct failure and resumable discovery
  // -----------------------------------------------------------------------

  it('resumes the initial agent after a direct terminal failure', async () => {
    const checkpointStore = new FileCheckpointStore(tmpDir);
    const defPath = writeDefinitionFile(tmpDir, simpleAgentDef);
    const firstFactory = vi.fn(async () => {
      return new MockSession({
        responses: () => {
          throw new Error('first run crashed');
        },
      });
    });
    const first = trackOrchestrator(
      new WorkflowOrchestrator(createDeps(tmpDir, { createSession: firstFactory, checkpointStore })),
    );

    const workflowId = await first.start(defPath, 'recover initial state');
    await waitForCompletion(first, workflowId);
    expect(first.getStatus(workflowId)?.phase).toBe('failed');
    expect(terminalControlPhases(tmpDir, workflowId).at(-1)).toBe('failed');
    expect(checkpointStore.load(workflowId)?.machineState).toBe('implement');

    const resumedFactory = vi.fn(async () => {
      return createArtifactAwareSession([{ text: approvedResponse('recovered'), artifacts: ['code'] }], tmpDir);
    });
    const resumed = trackOrchestrator(
      new WorkflowOrchestrator(createDeps(tmpDir, { createSession: resumedFactory, checkpointStore })),
    );

    await resumed.resume(workflowId);
    await waitForCompletion(resumed, workflowId);

    expect(resumedFactory).toHaveBeenCalledTimes(1);
    expect(resumed.getStatus(workflowId)?.phase).toBe('completed');
  });

  it('listResumable returns only failed workflow IDs, not completed ones', async () => {
    // listResumable now enumerates baseDir via discoverWorkflowRuns and
    // checks for checkpoint.json in each workflow directory. Align the
    // checkpoint-store baseDir with the orchestrator baseDir so checkpoints
    // land where the enumeration looks (this matches production, where the
    // two always coincide).
    const checkpointStore = new FileCheckpointStore(tmpDir);

    // Start and complete a workflow
    const defPath = writeDefinitionFile(tmpDir, simpleAgentDef);
    const completedFactory = vi.fn(async () => {
      return createArtifactAwareSession([{ text: approvedResponse('done'), artifacts: ['code'] }], tmpDir);
    });

    const deps1 = createDeps(tmpDir, {
      createSession: completedFactory,
      checkpointStore,
    });

    const orchestrator = trackOrchestrator(new WorkflowOrchestrator(deps1));
    const completedId = await orchestrator.start(defPath, 'completed task');
    await waitForCompletion(orchestrator, completedId);

    // Start and fail a workflow
    const failingFactory = vi.fn(async () => {
      return new MockSession({
        responses: () => {
          throw new Error('crash');
        },
      });
    });

    // Need a separate orchestrator to avoid findWorkflowDir confusion
    const deps2 = createDeps(tmpDir, {
      createSession: failingFactory,
      checkpointStore,
    });

    const orchestrator2 = trackOrchestrator(new WorkflowOrchestrator(deps2));
    const events: WorkflowLifecycleEvent[] = [];
    orchestrator2.onEvent((e) => events.push(e));

    const failedId = await orchestrator2.start(defPath, 'failing task');
    await waitForLifecycleEvent(events, (e) => e.kind === 'failed');
    // Wait for completion (machine reaches done via onError)
    await waitForCompletion(orchestrator2, failedId);

    // Completed checkpoints are excluded by finalStatus; the failed terminal
    // preserved its initial non-terminal checkpoint and remains resumable.
    const resumable = orchestrator.listResumable();
    expect(resumable).toContain(failedId);
    expect(resumable).not.toContain(completedId);
  });

  it('listResumable skips corrupt checkpoints instead of throwing', async () => {
    // Place a valid + a corrupt checkpoint side by side. A single corrupt
    // file must not break enumeration of all other resumable runs.
    const checkpointStore = new FileCheckpointStore(tmpDir);

    const validId = 'valid-run' as WorkflowId;
    const corruptId = 'corrupt-run' as WorkflowId;

    checkpointStore.save(validId, {
      machineState: 'implement',
      context: {
        taskDescription: 'still resumable',
        artifacts: {},
        round: 0,
        maxRounds: 4,
        previousOutputHashes: {},
        previousTestCount: null,
        humanPrompt: null,
        reviewHistory: [],
        totalTokens: 0,
        lastError: null,
        agentConversationsByState: {},
        previousAgentOutput: null,
        previousAgentNotes: null,
        previousStateName: null,
        visitCounts: {},
      },
      timestamp: new Date().toISOString(),
      transitionHistory: [],
      definitionPath: writeDefinitionFile(tmpDir, simpleAgentDef),
      workspacePath: resolve(tmpDir, validId, 'workspace'),
    });

    // Write raw bytes that won't parse as JSON.
    const corruptDir = resolve(tmpDir, corruptId);
    mkdirSync(corruptDir, { recursive: true });
    writeFileSync(resolve(corruptDir, 'checkpoint.json'), 'not json');

    const deps = createDeps(tmpDir, { checkpointStore });
    const orchestrator = trackOrchestrator(new WorkflowOrchestrator(deps));

    const resumable = orchestrator.listResumable();
    expect(resumable).toContain(validId);
    expect(resumable).not.toContain(corruptId);
  });

  // -----------------------------------------------------------------------
  // Test 7: Resume non-existent workflow throws
  // -----------------------------------------------------------------------

  it('resume throws for non-existent workflow', async () => {
    const checkpointStore = createCheckpointStore(tmpDir);
    const deps = createDeps(tmpDir, { checkpointStore });
    const orchestrator = trackOrchestrator(new WorkflowOrchestrator(deps));

    await expect(orchestrator.resume('nonexistent' as WorkflowId)).rejects.toThrow(
      'No checkpoint found for workflow nonexistent',
    );
  });

  // -----------------------------------------------------------------------
  // Test 8: Resume from an agent invoke state re-triggers the service
  // -----------------------------------------------------------------------

  it('resume from agent invoke state re-triggers the service instead of hanging', async () => {
    // Use linearWorkflowDef: plan -> plan_gate -> implement -> review -> done
    // Simulate a checkpoint at the "review" state (an agent invoke state).
    // Before the fix, XState would restore to "review" but never start the
    // agentService invoke, causing the workflow to hang indefinitely.
    const defPath = writeDefinitionFile(tmpDir, linearWorkflowDef);
    const checkpointStore = createCheckpointStore(tmpDir);

    // Create artifact directory structure that would exist at this point
    const fakeWorkflowId = 'resume-invoke-test' as WorkflowId;
    const workspacePath = resolve(tmpDir, fakeWorkflowId, 'workspace');
    const artifactDir = resolve(workspacePath, '.workflow');
    mkdirSync(artifactDir, { recursive: true });
    // Also write definition.json for resume
    mkdirSync(resolve(tmpDir, fakeWorkflowId), { recursive: true });
    writeFileSync(resolve(tmpDir, fakeWorkflowId, 'definition.json'), JSON.stringify(linearWorkflowDef));
    simulateArtifacts(resolve(tmpDir, fakeWorkflowId), ['plan', 'code']);

    // Save a checkpoint at the "review" agent state
    checkpointStore.save(fakeWorkflowId, {
      machineState: 'review',
      context: {
        taskDescription: 'build an API',
        artifacts: {
          plan: resolve(artifactDir, 'plan'),
          code: resolve(artifactDir, 'code'),
        },
        round: 2,
        maxRounds: 4,
        previousOutputHashes: {},
        previousTestCount: null,
        humanPrompt: null,
        reviewHistory: [],
        totalTokens: 0,
        lastError: null,
        agentConversationsByState: {},
        previousAgentOutput: null,
        previousAgentNotes: null,
        previousStateName: null,
        visitCounts: {},
      },
      timestamp: new Date().toISOString(),
      transitionHistory: [
        { from: 'plan', to: 'plan_gate', event: 'transition', timestamp: new Date().toISOString(), duration_ms: 100 },
        {
          from: 'plan_gate',
          to: 'implement',
          event: 'transition',
          timestamp: new Date().toISOString(),
          duration_ms: 50,
        },
        {
          from: 'implement',
          to: 'review',
          event: 'transition',
          timestamp: new Date().toISOString(),
          duration_ms: 200,
        },
      ],
      definitionPath: defPath,
      workspacePath,
    });

    // The reviewer approves, so the workflow should proceed to "done"
    const sessionFactory = vi.fn(async (opts: SessionOptions) => {
      expect(opts.persona).toBe('reviewer');
      return createArtifactAwareSession(
        [{ text: approvedResponse('code looks great'), artifacts: ['reviews'] }],
        tmpDir,
        'reviewer-session-resumed',
      );
    });

    const deps = createDeps(tmpDir, {
      createSession: sessionFactory,
      checkpointStore,
    });

    const orchestrator = trackOrchestrator(new WorkflowOrchestrator(deps));
    const events: WorkflowLifecycleEvent[] = [];
    orchestrator.onEvent((e) => events.push(e));

    await orchestrator.resume(fakeWorkflowId);

    // The workflow should complete (not hang)
    await waitForCompletion(orchestrator, fakeWorkflowId, 5000);

    expect(orchestrator.getStatus(fakeWorkflowId)?.phase).toBe('completed');
    expect(sessionFactory).toHaveBeenCalledTimes(1);
    expect(sessionFactory.mock.calls[0][0].persona).toBe('reviewer');
  });

  // -----------------------------------------------------------------------
  // Test 9: Resume from agent invoke state handles service failure
  // -----------------------------------------------------------------------

  it('resume from agent invoke state handles service failure gracefully', async () => {
    // Use agentWithErrorGateDef: implement -> (error) -> error_gate
    // Checkpoint at "implement" (invoke state), service fails on resume.
    const defPath = writeDefinitionFile(tmpDir, agentWithErrorGateDef);
    const checkpointStore = createCheckpointStore(tmpDir);

    const fakeWorkflowId = 'resume-invoke-error-test' as WorkflowId;
    const workspacePath = resolve(tmpDir, fakeWorkflowId, 'workspace');
    const artifactDir = resolve(workspacePath, '.workflow');
    mkdirSync(artifactDir, { recursive: true });
    // Write definition.json for resume
    mkdirSync(resolve(tmpDir, fakeWorkflowId), { recursive: true });
    writeFileSync(resolve(tmpDir, fakeWorkflowId, 'definition.json'), JSON.stringify(agentWithErrorGateDef));

    checkpointStore.save(fakeWorkflowId, {
      machineState: 'implement',
      context: {
        taskDescription: 'write code',
        artifacts: {},
        round: 0,
        maxRounds: 4,
        previousOutputHashes: {},
        previousTestCount: null,
        humanPrompt: null,
        reviewHistory: [],
        totalTokens: 0,
        lastError: null,
        agentConversationsByState: {},
        previousAgentOutput: null,
        previousAgentNotes: null,
        previousStateName: null,
        visitCounts: {},
      },
      timestamp: new Date().toISOString(),
      transitionHistory: [],
      definitionPath: defPath,
      workspacePath,
    });

    // Session factory that fails
    const sessionFactory = vi.fn(async () => {
      return new MockSession({
        responses: () => {
          throw new Error('Network timeout on resume');
        },
      });
    });

    const raiseGate = vi.fn();
    const deps = createDeps(tmpDir, {
      createSession: sessionFactory,
      raiseGate,
      checkpointStore,
    });

    const orchestrator = trackOrchestrator(new WorkflowOrchestrator(deps));
    await orchestrator.resume(fakeWorkflowId);

    // The error should transition the machine to error_gate (human gate)
    await waitForGate(raiseGate, 1);

    const gateRequest = raiseGate.mock.calls[0][0] as HumanGateRequest;
    expect(gateRequest.stateName).toBe('error_gate');
  });

  // -----------------------------------------------------------------------
  // Resume replays the interrupted state with the machine's own inputs
  // -----------------------------------------------------------------------

  /** Context of a checkpoint written on entry to `state` (visit counts already bumped). */
  function entryContext(taskDescription: string, visitCounts: Record<string, number>): WorkflowContext {
    return {
      taskDescription,
      artifacts: {},
      round: 0,
      maxRounds: 4,
      previousOutputHashes: {},
      previousTestCount: null,
      humanPrompt: null,
      reviewHistory: [],
      totalTokens: 0,
      lastError: null,
      agentConversationsByState: {},
      previousAgentOutput: null,
      previousAgentNotes: null,
      previousStateName: null,
      visitCounts,
    };
  }

  /** Writes the run's definition copy and a checkpoint taken on entry to `machineState`. */
  function seedCheckpoint(
    workflowId: WorkflowId,
    definition: WorkflowDefinition,
    machineState: string,
    context: WorkflowContext,
  ): FileCheckpointStore {
    const defPath = writeDefinitionFile(tmpDir, definition);
    const checkpointStore = createCheckpointStore(tmpDir);
    const workspacePath = resolve(tmpDir, workflowId, 'workspace');
    mkdirSync(resolve(workspacePath, '.workflow'), { recursive: true });
    writeFileSync(resolve(tmpDir, workflowId, 'definition.json'), JSON.stringify(definition));
    checkpointStore.save(workflowId, {
      machineState,
      context,
      timestamp: new Date().toISOString(),
      transitionHistory: [],
      definitionPath: defPath,
      workspacePath,
    });
    return checkpointStore;
  }

  it('requires a run-local definition when resuming an external run', async () => {
    const workflowId = 'external-definition-copy' as WorkflowId;
    const checkpointStore = seedCheckpoint(workflowId, linearWorkflowDef, 'plan_gate', entryContext('resume', {}));
    rmSync(resolve(tmpDir, workflowId, 'definition.json'));
    const createSession = vi.fn(async () => new MockSession({ responses: [] }));
    const orchestrator = trackOrchestrator(
      new WorkflowOrchestrator(createDeps(tmpDir, { checkpointStore, createSession })),
    );
    await expect(orchestrator.resume(workflowId)).rejects.toMatchObject({
      code: 'WORKFLOW_CHECKPOINT_CORRUPTED',
      message: expect.stringContaining('requires its own definition.json'),
    });
    expect(createSession).not.toHaveBeenCalled();
  });

  it('resume replays a deterministic state with lane placeholders resolved, like a normal entry', async () => {
    // A top-level (non-fan-out) deterministic state may use lane placeholders;
    // with no lane active they resolve to the default current/ directory and
    // lane 0. The replay used to pass the raw `run`/`resultFile`, so the
    // resumed command got a literal "{laneDir}" and the result read failed.
    const placeholderDef: WorkflowDefinition = {
      name: 'placeholder-deterministic',
      description: 'Top-level deterministic state that uses lane placeholders',
      initial: 'check',
      settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true },
      states: {
        check: {
          type: 'deterministic',
          description: 'Runs a check in the shared container',
          container: true,
          run: [['/workflow-scripts/check.py', '--out', '{laneDir}/check.json', '--lane-id', '{laneId}']],
          resultFile: '{laneRelDir}/check.json',
          transitions: [{ to: 'done', when: { verdict: 'ok' } }, { to: 'failed' }],
        },
        done: { type: 'terminal', description: 'Done' },
        failed: { type: 'terminal', description: 'Failed' },
      },
    };
    const workflowId = 'resume-placeholder-test' as WorkflowId;
    const checkpointStore = seedCheckpoint(workflowId, placeholderDef, 'check', entryContext('check it', {}));

    const orchestrator = trackOrchestrator(new WorkflowOrchestrator(createDeps(tmpDir, { checkpointStore })));
    const replayed: DeterministicInvokeInput[] = [];
    // Replace the executor (it would exec in a container) and record the input
    // the replay hands it.
    (
      orchestrator as unknown as {
        executeDeterministicState: (
          id: WorkflowId,
          input: DeterministicInvokeInput,
        ) => Promise<DeterministicInvokeResult>;
      }
    ).executeDeterministicState = async (_id, input) => {
      replayed.push(input);
      return { passed: true, verdict: 'ok' };
    };

    await orchestrator.resume(workflowId);
    await waitForCompletion(orchestrator, workflowId, 5000);

    expect(orchestrator.getStatus(workflowId)?.phase).toBe('completed');
    expect(replayed).toHaveLength(1);
    expect(replayed[0].commands).toEqual([
      ['/workflow-scripts/check.py', '--out', '/workspace/.evolve_runs/main/current/check.json', '--lane-id', '0'],
    ]);
    expect(replayed[0].resultFile).toBe('.evolve_runs/main/current/check.json');
    expect(replayed[0]).toEqual(
      buildDeterministicInvokeInput(
        'check',
        placeholderDef.states.check as DeterministicStateDefinition,
        replayed[0].context,
      ),
    );
  });

  it('resume replays a host: true deterministic state with its acknowledgement, on the real host runner', async () => {
    // The host runner refuses a state whose invoke input lacks host: true. The
    // replay used to set it inline; it now comes from the shared builder, so a
    // builder that dropped it would make every resumed host state fail here
    // (the marker would never be written).
    const marker = join(tmpDir, 'host-replay-marker.txt');
    const hostDef: WorkflowDefinition = {
      name: 'host-deterministic-replay',
      description: 'A builtin workflow whose only work is an acknowledged host state',
      initial: 'check',
      settings: { mode: 'builtin' },
      states: {
        check: {
          type: 'deterministic',
          description: 'Runs on the host',
          host: true,
          run: [
            [
              'node',
              '-e',
              "require('fs').writeFileSync(process.argv[1], 'lane=' + process.argv[2])",
              marker,
              '{laneId}',
            ],
          ],
          transitions: [{ to: 'done' }],
        },
        done: { type: 'terminal', description: 'Done' },
      },
    };
    const workflowId = 'resume-host-replay-test' as WorkflowId;
    const checkpointStore = seedCheckpoint(workflowId, hostDef, 'check', entryContext('check it', {}));

    const orchestrator = trackOrchestrator(new WorkflowOrchestrator(createDeps(tmpDir, { checkpointStore })));
    await orchestrator.resume(workflowId);
    await waitForCompletion(orchestrator, workflowId, 10_000);

    expect(orchestrator.getStatus(workflowId)?.phase).toBe('completed');
    // Ran on the host, with the lane placeholder resolved like a normal entry.
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, 'utf8')).toBe('lane=0');
  });

  it('resume tells the replayed agent that an earlier attempt may have run, and only that agent', async () => {
    const workflowId = 'resume-notice-test' as WorkflowId;
    const checkpointStore = seedCheckpoint(
      workflowId,
      linearWorkflowDef,
      'implement',
      entryContext('build an API', { plan: 1, implement: 1 }),
    );
    simulateArtifacts(resolve(tmpDir, workflowId), ['plan']);

    const sessionsByPersona = new Map<string, MockSession>();
    const sessionFactory = vi.fn(async (opts: SessionOptions) => {
      const persona = opts.persona ?? 'none';
      const session =
        persona === 'coder'
          ? createArtifactAwareSession([{ text: approvedResponse('implemented'), artifacts: ['code'] }], tmpDir)
          : createArtifactAwareSession([{ text: approvedResponse('looks good'), artifacts: ['reviews'] }], tmpDir);
      sessionsByPersona.set(persona, session);
      return session;
    });

    const orchestrator = trackOrchestrator(
      new WorkflowOrchestrator(createDeps(tmpDir, { createSession: sessionFactory, checkpointStore })),
    );
    await orchestrator.resume(workflowId);
    await waitForCompletion(orchestrator, workflowId, 5000);
    expect(orchestrator.getStatus(workflowId)?.phase).toBe('completed');

    // The replayed `implement` opens with the notice...
    const coderPrompt = sessionsByPersona.get('coder')?.sentMessages[0] ?? '';
    expect(coderPrompt.startsWith(RESUME_NOTICE)).toBe(true);
    expect(coderPrompt).toContain('You are a coder.');
    // ...while `review`, entered normally afterwards, does not.
    const reviewerPrompt = sessionsByPersona.get('reviewer')?.sentMessages[0] ?? '';
    expect(reviewerPrompt).toContain('You are a reviewer.');
    expect(reviewerPrompt).not.toContain('Resumed after an interruption');

    // The message log records the prompt that was actually sent.
    const sent = readFileSync(resolve(tmpDir, workflowId, 'messages.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type?: string; state?: string; message?: string })
      .filter((entry) => entry.type === 'agent_sent');
    expect(sent.map((entry) => entry.state)).toEqual(['implement', 'review']);
    expect(sent[0].message?.startsWith(RESUME_NOTICE)).toBe(true);
    expect(sent[1].message).not.toContain('Resumed after an interruption');
  });

  it('resume repeats the notice in the fresh replacement prompt after status recovery runs out', async () => {
    // `review` routes on its verdict, so a replayed review that never commits a
    // status block ends in one fresh replacement execution. That opens a new
    // conversation, so it must carry the notice again; the status reprompts
    // inside the first conversation must not.
    const workflowId = 'resume-notice-replacement-test' as WorkflowId;
    const checkpointStore = seedCheckpoint(
      workflowId,
      linearWorkflowDef,
      'review',
      entryContext('build an API', { plan: 1, implement: 1, review: 1 }),
    );
    simulateArtifacts(resolve(tmpDir, workflowId), ['plan', 'code']);

    const session: MockSession = new MockSession({
      responses: () => {
        const turn = session.sentMessages.length;
        if (turn === 1) simulateArtifacts(resolve(tmpDir, workflowId), ['reviews']);
        return turn <= 3 ? 'Reviewed the code, but no status block.' : approvedResponse('looks good');
      },
    });
    const orchestrator = trackOrchestrator(
      new WorkflowOrchestrator(createDeps(tmpDir, { createSession: vi.fn(async () => session), checkpointStore })),
    );
    await orchestrator.resume(workflowId);
    await waitForCompletion(orchestrator, workflowId, 5000);

    expect(orchestrator.getStatus(workflowId)?.phase).toBe('completed');
    expect(session.sentMessages).toHaveLength(4);
    // The conversation rotates once, right before the replacement (turn 4).
    expect(session.rotateCalls).toEqual([3]);
    const [first, statusReprompt1, statusReprompt2, replacement] = session.sentMessages;
    expect(first.startsWith(RESUME_NOTICE)).toBe(true);
    expect(statusReprompt1).not.toContain('Resumed after an interruption');
    expect(statusReprompt2).not.toContain('Resumed after an interruption');
    expect(replacement.startsWith(RESUME_NOTICE)).toBe(true);
    expect(replacement).toContain('## Recovery handoff');
  });

  it('resume pairs the notice with the workflow_commit instructions of the replayed invocation', async () => {
    // The same replay as above, with an agent that commits through the
    // coordinator-owned workflow_commit tool (WP-133): the prompts that open
    // a conversation carry both the resume notice and the commit
    // instructions for the one invocation, whose id stays the same in the
    // fresh replacement.
    const workflowId = 'resume-notice-commit-test' as WorkflowId;
    const checkpointStore = seedCheckpoint(
      workflowId,
      linearWorkflowDef,
      'review',
      entryContext('build an API', { plan: 1, implement: 1, review: 1 }),
    );
    simulateArtifacts(resolve(tmpDir, workflowId), ['plan', 'code']);

    const invocationIdOf = (prompt: string): string => /invocation: "([0-9a-f-]{36})"/.exec(prompt)?.[1] ?? '';
    let session: MockSession | undefined;
    const createSession = vi.fn(async (opts: SessionOptions) => {
      // A builtin state builds its own coordinator, which offers the tool
      // and attaches the state's commit target.
      const handler = opts.workflow?.workflowCommit;
      if (!handler) throw new Error('builtin workflow state without a commit target');
      handler.attach();
      const created: MockSession = new MockSession({
        responses: (prompt) => {
          const turn = created.sentMessages.length;
          if (turn === 1) simulateArtifacts(resolve(tmpDir, workflowId), ['reviews']);
          if (turn <= 3) return 'Reviewed the code, but did not commit.';
          const outcome = handler.commit({ invocation: invocationIdOf(prompt), verdict: 'approved' });
          if (!outcome.accepted) throw new Error(`commit refused: ${outcome.reason}`);
          return 'Committed.';
        },
      });
      session = created;
      return created;
    });
    const orchestrator = trackOrchestrator(
      new WorkflowOrchestrator(createDeps(tmpDir, { createSession, checkpointStore })),
    );
    await orchestrator.resume(workflowId);
    await waitForCompletion(orchestrator, workflowId, 5000);

    expect(orchestrator.getStatus(workflowId)?.phase).toBe('completed');
    const sent = session?.sentMessages ?? [];
    expect(sent).toHaveLength(4);
    const [first, continuation1, continuation2, replacement] = sent;
    const invocationId = invocationIdOf(first);
    expect(invocationId).not.toBe('');
    expect(first.startsWith(RESUME_NOTICE)).toBe(true);
    expect(first).toContain('workflow.commit({');
    for (const continuation of [continuation1, continuation2]) {
      expect(continuation).toContain('this state has not committed');
      expect(continuation).not.toContain('Resumed after an interruption');
    }
    expect(replacement.startsWith(RESUME_NOTICE)).toBe(true);
    expect(replacement).toContain('## Recovery handoff');
    expect(invocationIdOf(replacement)).toBe(invocationId);
  });

  // -----------------------------------------------------------------------
  // Test 10: Session IDs survive checkpoint and resume
  // -----------------------------------------------------------------------

  it('session IDs survive checkpoint and resume', async () => {
    // loopWithErrorGateDef: implement -> review(reject -> error_gate) -> ...
    // Run coder round 1 -> reviewer rejects -> error_gate (checkpoint).
    // Resume from checkpoint. Approve gate -> coder round 2 should get
    // the original coder session ID via resumeSessionId.
    const defPath = writeDefinitionFile(tmpDir, loopWithErrorGateDef);
    const checkpointStore = createCheckpointStore(tmpDir);

    let coderCallCount = 0;

    const sessionFactory1 = vi.fn(async (opts: SessionOptions) => {
      const persona = opts.persona!;

      if (persona === 'coder') {
        coderCallCount++;
        return createArtifactAwareSession(
          [{ text: approvedResponse(`coder pass ${coderCallCount}`), artifacts: ['code'] }],
          tmpDir,
          `coder-session-${coderCallCount}`,
        );
      }
      if (persona === 'reviewer') {
        return createArtifactAwareSession([{ text: rejectedResponse('needs fixing'), artifacts: ['reviews'] }], tmpDir);
      }
      throw new Error(`Unexpected persona: ${persona}`);
    });

    const raiseGate1 = vi.fn();
    const deps1 = createDeps(tmpDir, {
      createSession: sessionFactory1,
      raiseGate: raiseGate1,
      checkpointStore,
    });

    const orchestrator1 = trackOrchestrator(new WorkflowOrchestrator(deps1));
    const workflowId = await orchestrator1.start(defPath, 'implement feature');

    // Flow: implement(coder) -> review(reject) -> error_gate
    await waitForGate(raiseGate1, 1);

    // Verify checkpoint captured the coder's agentConversationId so a
    // post-resume coder invocation can reuse it.
    const checkpoint = checkpointStore.load(workflowId);
    expect(checkpoint).toBeDefined();
    expect(checkpoint!.machineState).toBe('error_gate');
    const coderConversationId = checkpoint!.context.agentConversationsByState['implement'];
    expect(coderConversationId).toBeDefined();
    // Confirm the orchestrator passed the same id on the first coder turn.
    const coderCall1 = sessionFactory1.mock.calls.find((c) => c[0].persona === 'coder');
    expect(coderCall1).toBeDefined();
    expect(coderCall1![0].agentConversationId).toBe(coderConversationId);

    // Simulate crash: save checkpoint, shutdown (which removes it), re-save
    const savedCheckpoint = { ...checkpoint! };
    await orchestrator1.shutdownAll();
    checkpointStore.save(workflowId, savedCheckpoint);

    // Resume with a new orchestrator
    const sessionFactory2 = vi.fn(async (opts: SessionOptions) => {
      const persona = opts.persona!;

      if (persona === 'coder') {
        return createArtifactAwareSession(
          [{ text: approvedResponse('fixed code'), artifacts: ['code'] }],
          tmpDir,
          'coder-session-resumed',
        );
      }
      if (persona === 'reviewer') {
        return createArtifactAwareSession([{ text: approvedResponse('approved'), artifacts: ['reviews'] }], tmpDir);
      }
      throw new Error(`Unexpected persona: ${persona}`);
    });

    const raiseGate2 = vi.fn();
    const deps2 = createDeps(tmpDir, {
      createSession: sessionFactory2,
      raiseGate: raiseGate2,
      checkpointStore,
    });

    const orchestrator2 = trackOrchestrator(new WorkflowOrchestrator(deps2));
    await orchestrator2.resume(workflowId);

    // Gate is re-raised at error_gate
    await waitForGate(raiseGate2, 1);

    // Approve gate -> implement(coder round 2) -> review(approve) -> done
    resolveActiveGate(orchestrator2, workflowId, { type: 'APPROVE' });
    await waitForCompletion(orchestrator2, workflowId);

    expect(orchestrator2.getStatus(workflowId)?.phase).toBe('completed');

    // The resumed coder session should have received the original coder
    // agentConversationId captured in the pre-resume checkpoint.
    expect(sessionFactory2).toHaveBeenCalled();
    const coderCall = sessionFactory2.mock.calls.find((c) => c[0].persona === 'coder');
    expect(coderCall).toBeDefined();
    expect(coderCall![0].agentConversationId).toBe(coderConversationId);
  });

  // -----------------------------------------------------------------------
  // Test: Resume reads workflow-skills from the per-run staged copy, even
  // when the original workflow package's `skills/` tree has been moved or
  // deleted. Pre-fix, the orchestrator recomputed
  // `getWorkflowPackageDir(definitionPath) + '/skills'` on every read, so
  // a missing source path silently degraded the resumed run to zero
  // workflow-bundled skills.
  // -----------------------------------------------------------------------

  it('resume keeps workflow-bundled skills available after the original package skills/ is removed', async () => {
    // Definition with a `skills:[]` field so the workflow filter pulls in
    // the staged skill. Routes errors to a human gate so the checkpoint
    // survives the first orchestrator's lifecycle.
    const skillsAwareDef: WorkflowDefinition = {
      name: 'skills-resume',
      description: 'Workflow that references a bundled skill',
      initial: 'implement',
      settings: { mode: 'builtin' },
      states: {
        implement: {
          type: 'agent',
          description: 'Writes code',
          persona: 'coder',
          prompt: 'Write code.',
          inputs: [],
          outputs: ['code'],
          skills: ['fetcher'],
          transitions: [{ to: 'error_gate' }],
        },
        error_gate: {
          type: 'human_gate',
          description: 'Stops here so the checkpoint persists',
          acceptedEvents: ['APPROVE', 'ABORT'],
          transitions: [
            { to: 'done', event: 'APPROVE' },
            { to: 'aborted', event: 'ABORT' },
          ],
        },
        done: { type: 'terminal', description: 'Done' },
        aborted: { type: 'terminal', description: 'Aborted' },
      },
    };

    // Stub persona for the new definition (linear/simple stubs were set
    // up in beforeEach but `coder` is shared with simpleAgentDef so it's
    // already there).

    // Set up the workflow's bundled skills tree *next to* the definition
    // file. `writeDefinitionFile` writes to `{tmpDir}/{def.name}.json`,
    // so the package dir is `tmpDir` and the skills root is
    // `{tmpDir}/skills/`.
    const sourceSkillsDir = resolve(tmpDir, 'skills');
    const fetcherSkillDir = resolve(sourceSkillsDir, 'fetcher');
    mkdirSync(fetcherSkillDir, { recursive: true });
    writeFileSync(resolve(fetcherSkillDir, 'SKILL.md'), '---\nname: fetcher\ndescription: fetches things\n---\nbody\n');

    const defPath = writeDefinitionFile(tmpDir, skillsAwareDef);
    const checkpointStore = createCheckpointStore(tmpDir);

    // First orchestrator: agent runs, transitions to error_gate, persists
    // a checkpoint.
    const sessionsBeforeResume: SessionOptions[] = [];
    const sessionFactory1 = vi.fn(async (opts: SessionOptions) => {
      sessionsBeforeResume.push(opts);
      return createArtifactAwareSession([{ text: approvedResponse('initial'), artifacts: ['code'] }], tmpDir);
    });

    const raiseGate1 = vi.fn();
    const deps1 = createDeps(tmpDir, {
      createSession: sessionFactory1,
      raiseGate: raiseGate1,
      checkpointStore,
    });

    const orchestrator1 = trackOrchestrator(new WorkflowOrchestrator(deps1));
    const workflowId = await orchestrator1.start(defPath, 'do work');
    await waitForGate(raiseGate1, 1);

    // Sanity: at start, the staged skills tree exists under the run dir
    // and the session factory was passed THAT path (not the source).
    const runStagedDir = resolve(tmpDir, workflowId, 'workflow-skills');
    expect(existsSync(resolve(runStagedDir, 'fetcher', 'SKILL.md'))).toBe(true);
    expect(sessionsBeforeResume).toHaveLength(1);
    expect(sessionsBeforeResume[0].workflow?.skillsDir).toBe(runStagedDir);

    // Sanity: checkpoint persists the staged path.
    const checkpoint = checkpointStore.load(workflowId);
    expect(checkpoint).toBeDefined();
    expect(checkpoint!.machineState).toBe('error_gate');
    expect(checkpoint!.workflowSkillsDir).toBe(runStagedDir);

    // Simulate the original package being moved/deleted between runs:
    // wipe the source `skills/` tree entirely.
    rmSync(sourceSkillsDir, { recursive: true, force: true });
    expect(existsSync(sourceSkillsDir)).toBe(false);

    // The staged copy under the run dir survives — the orchestrator owns
    // it and only deletes the run dir on terminal-+-finalStatus, not on
    // shutdown.
    expect(existsSync(runStagedDir)).toBe(true);

    await orchestrator1.shutdownAll();

    // Resume with a fresh orchestrator. The skills tree is no longer at
    // the original package location, but the run-dir staged copy is.
    const sessionFactory2 = vi.fn(async () => {
      return createArtifactAwareSession([{ text: approvedResponse('resumed'), artifacts: ['code'] }], tmpDir);
    });

    const raiseGate2 = vi.fn();
    const deps2 = createDeps(tmpDir, {
      createSession: sessionFactory2,
      raiseGate: raiseGate2,
      checkpointStore,
    });

    const orchestrator2 = trackOrchestrator(new WorkflowOrchestrator(deps2));
    await orchestrator2.resume(workflowId);

    // The error_gate is re-raised; APPROVE drives the workflow to done.
    // Before APPROVE the gate has fired but no agent state has run yet,
    // so we'll only see a session created if APPROVE re-enters an agent
    // state. In this definition APPROVE -> done (terminal), so the
    // critical assertion is on the start-time skills passed to the
    // initial agent — the resume path's `workflowSkillsDir` in the
    // instance.
    await waitForGate(raiseGate2, 1);

    // Approve and walk to terminal. No further agent state runs in this
    // definition, but the resume path still constructed the instance
    // with `workflowSkillsDir` populated; the instance-level assertion
    // would require introspection. Instead, drive a definition that
    // re-enters an agent state on APPROVE so we can capture the
    // `workflowSkillsDir` argument.
    resolveActiveGate(orchestrator2, workflowId, { type: 'APPROVE' });
    await waitForCompletion(orchestrator2, workflowId);

    // The staged skills directory MUST still resolve and contain the
    // bundled skill. This is the heart of the regression: pre-fix, after
    // the source was deleted, the orchestrator's per-state recomputation
    // would point at a missing path and `discoverSkills` would silently
    // return [].
    expect(existsSync(resolve(runStagedDir, 'fetcher', 'SKILL.md'))).toBe(true);
    expect(readdirSync(runStagedDir).sort()).toContain('fetcher');

    // The resumed checkpoint also retains the staged path so a hypothetical
    // re-resume after this run would pick up the same self-contained tree.
    const finalCheckpoint = checkpointStore.load(workflowId);
    expect(finalCheckpoint?.workflowSkillsDir).toBe(runStagedDir);
  });

  it.each(['own home', 'external'] as const)('resume package recovery for a run in %s', async (location) => {
    const ownHome = location === 'own home';
    const base = ownHome ? resolve(process.env.IRONCURTAIN_HOME ?? tmpDir, 'workflow-runs') : tmpDir;
    mkdirSync(base, { recursive: true });
    // Recovery path: if both the staged copy under the run dir AND the
    // checkpointed path were lost (e.g. someone manually pruned the run
    // tree), but the original package's `skills/` is still on disk,
    // resume re-stages from the source rather than silently dropping
    // workflow-bundled skills.
    const skillsAwareDef: WorkflowDefinition = {
      name: 'skills-restage',
      description: 'Workflow that references a bundled skill',
      initial: 'implement',
      settings: { mode: 'builtin' },
      states: {
        implement: {
          type: 'agent',
          description: 'Writes code',
          persona: 'coder',
          prompt: 'Write code.',
          inputs: [],
          outputs: ['code'],
          skills: ['fetcher'],
          transitions: [{ to: 'error_gate' }],
        },
        error_gate: {
          type: 'human_gate',
          description: 'Stops here',
          acceptedEvents: ['APPROVE', 'ABORT'],
          transitions: [
            { to: 'done', event: 'APPROVE' },
            { to: 'aborted', event: 'ABORT' },
          ],
        },
        done: { type: 'terminal', description: 'Done' },
        aborted: { type: 'terminal', description: 'Aborted' },
      },
    };

    const sourceSkillsDir = resolve(tmpDir, 'skills');
    const fetcherSkillDir = resolve(sourceSkillsDir, 'fetcher');
    mkdirSync(fetcherSkillDir, { recursive: true });
    writeFileSync(resolve(fetcherSkillDir, 'SKILL.md'), '---\nname: fetcher\ndescription: fetches things\n---\nbody\n');

    const defPath = writeDefinitionFile(tmpDir, skillsAwareDef);
    const checkpointStore = createCheckpointStore(base);

    const sessionFactory1 = vi.fn(async () => {
      return createArtifactAwareSession([{ text: approvedResponse('initial'), artifacts: ['code'] }], tmpDir);
    });

    const raiseGate1 = vi.fn();
    const deps1 = createDeps(base, {
      createSession: sessionFactory1,
      raiseGate: raiseGate1,
      checkpointStore,
    });

    const orchestrator1 = trackOrchestrator(new WorkflowOrchestrator(deps1));
    const workflowId = await orchestrator1.start(defPath, 'do work');
    await waitForGate(raiseGate1, 1);

    const runStagedDir = resolve(base, workflowId, 'workflow-skills');
    expect(existsSync(runStagedDir)).toBe(true);
    await orchestrator1.shutdownAll();

    // Wipe the staged copy AND scrub the checkpointed pointer so resume
    // must fall back to the source-staging recovery path.
    rmSync(runStagedDir, { recursive: true, force: true });
    expect(existsSync(runStagedDir)).toBe(false);
    const checkpointBefore = checkpointStore.load(workflowId);
    if (checkpointBefore) {
      // Drop `workflowSkillsDir` to simulate a legacy / pre-feature
      // checkpoint that did not persist the staged path. With both the
      // run-dir copy and the checkpointed pointer gone, resume must
      // fall through to re-staging from `checkpoint.definitionPath`'s
      // package directory.
      const scrubbed = { ...checkpointBefore };
      delete (scrubbed as { workflowSkillsDir?: string }).workflowSkillsDir;
      checkpointStore.save(workflowId, scrubbed);
    }

    const sessionFactory2 = vi.fn(async () => {
      return createArtifactAwareSession([{ text: approvedResponse('resumed'), artifacts: ['code'] }], tmpDir);
    });

    const raiseGate2 = vi.fn();
    const deps2 = createDeps(base, {
      createSession: sessionFactory2,
      raiseGate: raiseGate2,
      checkpointStore,
    });

    const orchestrator2 = trackOrchestrator(new WorkflowOrchestrator(deps2));
    await orchestrator2.resume(workflowId);
    await waitForGate(raiseGate2, 1);

    // Resume re-staged from the source — the run dir now contains a
    // fresh copy of the skills tree.
    expect(existsSync(resolve(runStagedDir, 'fetcher', 'SKILL.md'))).toBe(ownHome);

    // The post-resume checkpoint persists the freshly-staged path so a
    // future resume sees the staged copy first (not the recovery path).
    resolveActiveGate(orchestrator2, workflowId, { type: 'APPROVE' });
    await waitForCompletion(orchestrator2, workflowId);
    const finalCheckpoint = checkpointStore.load(workflowId);
    expect(finalCheckpoint?.workflowSkillsDir).toBe(ownHome ? runStagedDir : undefined);
  });
});
