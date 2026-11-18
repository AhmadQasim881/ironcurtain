/**
 * The daemon-wide cap on workflow agent environments
 * (`maxConcurrentAgentSessions`, src/workflow/agent-slot-pool.ts) as the
 * orchestrator applies it: a shared-container run reserves one slot per
 * scope before its first bundle mint and returns them at teardown; a
 * session that brings its own environment holds one slot while it lives.
 * Requests over the cap queue; they never fail.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { WorkflowDefinition, WorkflowId } from '../../src/workflow/types.js';
import type { DockerInfrastructure } from '../../src/docker/docker-infrastructure.js';
import type { WorkflowTabHandle } from '../../src/workflow/orchestrator.js';
import { WorkflowOrchestrator, type CreateWorkflowInfrastructureInput } from '../../src/workflow/orchestrator.js';
import { AGENT_SLOT_REQUEST_TOO_LARGE, AgentSlotPool } from '../../src/workflow/agent-slot-pool.js';
import {
  MockSession,
  approvedResponse,
  createDeps,
  createMockTab,
  makeTestUserConfig,
  stubPersonasForTest,
  waitForCompletion,
  waitForGateOrCompletion,
  writeDefinitionFile,
} from './test-helpers.js';

/** `vi.waitFor` with room for a loaded test host. */
function eventually(assertion: () => void): Promise<void> {
  return vi.waitFor(assertion, { timeout: 5_000, interval: 10 });
}

function stubBundle(input: CreateWorkflowInfrastructureInput): DockerInfrastructure {
  return {
    workflowId: input.workflowId,
    bundleId: input.bundleId,
    runtimeKind: 'docker',
    setTokenSessionId: () => {},
    beginCaptureSession: () => {},
    endCaptureSession: async () => {},
  } as unknown as DockerInfrastructure;
}

function agentState(next: string, containerScope?: string): WorkflowDefinition['states'][string] {
  return {
    type: 'agent',
    description: 'Works',
    persona: 'global',
    prompt: 'Do the work.',
    inputs: [],
    outputs: [],
    transitions: [{ to: next }],
    ...(containerScope !== undefined ? { containerScope } : {}),
  };
}

const sharedDef: WorkflowDefinition = {
  name: 'slots-shared',
  description: 'One shared-container agent state',
  initial: 'work',
  settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true },
  states: { work: agentState('done'), done: { type: 'terminal', description: 'Done' } },
};

const twoScopeDef: WorkflowDefinition = {
  name: 'slots-two-scopes',
  description: 'Two shared-container scopes',
  initial: 'first',
  settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true },
  states: {
    first: agentState('second', 'alpha'),
    second: agentState('done', 'beta'),
    done: { type: 'terminal', description: 'Done' },
  },
};

/** Errors of `work` route to the gate, so the run outlives a failed mint. */
const gatedDef: WorkflowDefinition = {
  name: 'slots-gated',
  description: 'A shared-container agent state whose errors go to a human gate',
  initial: 'work',
  settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true },
  states: {
    work: agentState('review'),
    review: {
      type: 'human_gate',
      description: 'Review',
      acceptedEvents: ['APPROVE', 'ABORT'],
      transitions: [
        { to: 'done', event: 'APPROVE' },
        { to: 'done', event: 'ABORT' },
      ],
    },
    done: { type: 'terminal', description: 'Done' },
  },
};

const builtinDef: WorkflowDefinition = {
  name: 'slots-builtin',
  description: 'One builtin agent state (its session brings its own sandbox)',
  initial: 'work',
  settings: { mode: 'builtin' },
  states: { work: agentState('done'), done: { type: 'terminal', description: 'Done' } },
};

/** A turn that answers only when released. */
interface HeldTurn {
  readonly started: Promise<void>;
  release(): void;
}

/** Sessions whose every turn waits for `release()`; handed out in creation order. */
function heldSessions(): { create: () => Promise<MockSession>; turns: HeldTurn[] } {
  const turns: HeldTurn[] = [];
  const create = async (): Promise<MockSession> => {
    let release = (): void => {};
    let markStarted = (): void => {};
    const answered = new Promise<string>((resolve) => {
      release = () => resolve(approvedResponse());
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    turns.push({ started, release });
    return new MockSession({
      responses: () => {
        markStarted();
        return answered;
      },
    });
  };
  return { create, turns };
}

describe('WorkflowOrchestrator agent concurrency cap', () => {
  let tmpDir: string;
  let orchestrator: WorkflowOrchestrator | undefined;
  let cleanupPersonas: (() => void) | undefined;
  const tabs = new Map<WorkflowId, WorkflowTabHandle>();

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agent-slots-test-'));
    orchestrator = undefined;
    tabs.clear();
    cleanupPersonas = stubPersonasForTest(tmpDir, sharedDef, twoScopeDef, gatedDef, builtinDef);
  });

  afterEach(async () => {
    await orchestrator?.shutdownAll();
    cleanupPersonas?.();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeOrchestrator(overrides: Parameters<typeof createDeps>[1]): WorkflowOrchestrator {
    orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        createWorkflowTab: (_label, workflowId) => {
          const tab = createMockTab();
          tabs.set(workflowId, tab);
          return tab;
        },
        destroyWorkflowInfrastructure: vi.fn(async () => {}),
        ...overrides,
      }),
    );
    return orchestrator;
  }

  function tabLines(workflowId: WorkflowId): string[] {
    const tab = tabs.get(workflowId);
    return tab ? vi.mocked(tab.write).mock.calls.map(([line]) => line) : [];
  }

  it('a fifth bundle mint waits when the cap is 4', async () => {
    const defPath = writeDefinitionFile(tmpDir, sharedDef);
    const sessions = heldSessions();
    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) => stubBundle(input));
    const orch = makeOrchestrator({
      // The cap comes from user config, as in the daemon.
      userConfig: makeTestUserConfig({ maxConcurrentAgentSessions: 4 }),
      createSession: sessions.create,
      createWorkflowInfrastructure: createInfra,
    });

    const ids: WorkflowId[] = [];
    for (let i = 0; i < 5; i++) ids.push(await orch.start(defPath, `task ${i}`));

    await eventually(() => expect(createInfra).toHaveBeenCalledTimes(4));
    await eventually(() => expect(sessions.turns).toHaveLength(4));
    // Give the fifth run every chance to mint: it must stay queued.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(createInfra).toHaveBeenCalledTimes(4);

    const minted = createInfra.mock.calls.map(([input]) => input.workflowId);
    const queued = ids.find((id) => !minted.includes(id));
    if (queued === undefined) throw new Error('expected one run without a bundle');
    // Queued, not failed, and told why it is waiting.
    expect(orch.getStatus(queued)?.phase).toBe('running');
    expect(tabLines(queued).some((line) => line.includes('waiting for a free agent slot'))).toBe(true);

    // One run finishing frees its slot: the fifth mints.
    sessions.turns[0].release();
    await eventually(() => expect(createInfra).toHaveBeenCalledTimes(5));
    expect(createInfra.mock.calls[4][0].workflowId).toBe(queued);

    for (const turn of sessions.turns) turn.release();
    await eventually(() => expect(sessions.turns).toHaveLength(5));
    sessions.turns[4].release();
    for (const id of ids) await waitForCompletion(orch, id);
    for (const id of ids) expect(orch.getStatus(id)?.phase).toBe('completed');
  });

  it('frees the slots of an aborted run for the next one', async () => {
    const defPath = writeDefinitionFile(tmpDir, sharedDef);
    const sessions = heldSessions();
    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) => stubBundle(input));
    const pool = new AgentSlotPool(1);
    const orch = makeOrchestrator({
      agentSlots: pool,
      createSession: sessions.create,
      createWorkflowInfrastructure: createInfra,
    });

    const first = await orch.start(defPath, 'first');
    await eventually(() => expect(sessions.turns).toHaveLength(1));
    const second = await orch.start(defPath, 'second');
    await eventually(() => expect(pool.waiting).toBe(1));
    expect(createInfra).toHaveBeenCalledTimes(1);

    await orch.abort(first);
    await eventually(() => expect(createInfra).toHaveBeenCalledTimes(2));
    expect(createInfra.mock.calls[1][0].workflowId).toBe(second);
    expect(pool.inUse).toBe(1);

    await eventually(() => expect(sessions.turns).toHaveLength(2));
    sessions.turns[1].release();
    await waitForCompletion(orch, second);
    await eventually(() => expect(pool.inUse).toBe(0));
  });

  it('drops a run that is aborted while it waits for a slot from the queue', async () => {
    const defPath = writeDefinitionFile(tmpDir, sharedDef);
    const sessions = heldSessions();
    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) => stubBundle(input));
    const pool = new AgentSlotPool(1);
    const orch = makeOrchestrator({
      agentSlots: pool,
      createSession: sessions.create,
      createWorkflowInfrastructure: createInfra,
    });

    const holder = await orch.start(defPath, 'holder');
    await eventually(() => expect(sessions.turns).toHaveLength(1));
    const waiter = await orch.start(defPath, 'waiter');
    await eventually(() => expect(pool.waiting).toBe(1));

    await orch.abort(waiter);
    expect(pool.waiting).toBe(0);
    expect(pool.inUse).toBe(1);

    sessions.turns[0].release();
    await waitForCompletion(orch, holder);
    await eventually(() => expect(pool.inUse).toBe(0));
    // The aborted run never minted.
    expect(createInfra).toHaveBeenCalledTimes(1);
  });

  it('reserves one slot per scope in a single request and returns them at teardown', async () => {
    const defPath = writeDefinitionFile(tmpDir, twoScopeDef);
    const sessions = heldSessions();
    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) => stubBundle(input));
    const pool = new AgentSlotPool(3);
    const acquire = vi.spyOn(pool, 'acquire');
    const orch = makeOrchestrator({
      agentSlots: pool,
      createSession: sessions.create,
      createWorkflowInfrastructure: createInfra,
    });

    const id = await orch.start(defPath, 'task');
    await eventually(() => expect(sessions.turns).toHaveLength(1));
    // Both scopes are reserved before the first mint, so a second mint never
    // waits while holding a slot.
    expect(pool.inUse).toBe(2);
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(acquire.mock.calls[0][0]).toBe(2);

    sessions.turns[0].release();
    await eventually(() => expect(createInfra).toHaveBeenCalledTimes(2));
    await eventually(() => expect(sessions.turns).toHaveLength(2));
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(pool.inUse).toBe(2);
    // No fan-out runs in either scope: each bundle expects a single lane.
    expect(createInfra.mock.calls.map(([input]) => [input.scope, input.maxLanes])).toEqual([
      ['alpha', 1],
      ['beta', 1],
    ]);

    sessions.turns[1].release();
    await waitForCompletion(orch, id);
    await eventually(() => expect(pool.inUse).toBe(0));
  });

  it('keeps the reservation of a mint that races an abort until its orphan is gone, then returns it', async () => {
    const defPath = writeDefinitionFile(tmpDir, sharedDef);
    const pool = new AgentSlotPool(1);
    let releaseFactory: (infra: DockerInfrastructure) => void = () => {};
    const factoryGate = new Promise<DockerInfrastructure>((resolve) => {
      releaseFactory = resolve;
    });
    let factoryInput: CreateWorkflowInfrastructureInput | undefined;
    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) => {
      factoryInput = input;
      return factoryGate;
    });
    const destroyInfra = vi.fn(async () => {});
    const createSession = vi.fn();
    const orch = makeOrchestrator({
      agentSlots: pool,
      createSession,
      createWorkflowInfrastructure: createInfra,
      destroyWorkflowInfrastructure: destroyInfra,
    });

    const id = await orch.start(defPath, 'task');
    await eventually(() => expect(createInfra).toHaveBeenCalledTimes(1));
    expect(pool.inUse).toBe(1);

    // The run's teardown finishes while its mint is still building the
    // container: the slot stays taken, because that container will exist.
    await orch.abort(id);
    expect(pool.inUse).toBe(1);

    // The mint completes, sees the abort, destroys its orphan, and only then
    // returns the run's slot.
    if (factoryInput === undefined) throw new Error('factory was not called');
    const orphan = stubBundle(factoryInput);
    releaseFactory(orphan);
    await eventually(() => expect(destroyInfra).toHaveBeenCalledWith(orphan));
    await eventually(() => expect(pool.inUse).toBe(0));
    expect(createSession).not.toHaveBeenCalled();
  });

  it('refuses to resume a shared-container run that needs more slots than the cap now allows', async () => {
    const defPath = writeDefinitionFile(tmpDir, twoScopeDef);
    const checkpointStore = createDeps(tmpDir).checkpointStore;
    const sessions = heldSessions();
    const first = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        checkpointStore,
        agentSlots: new AgentSlotPool(2),
        createSession: sessions.create,
        createWorkflowInfrastructure: vi.fn(async (input: CreateWorkflowInfrastructureInput) => stubBundle(input)),
        destroyWorkflowInfrastructure: vi.fn(async () => {}),
      }),
    );
    const id = await first.start(defPath, 'task');
    try {
      await eventually(() => expect(sessions.turns).toHaveLength(1));
      // An aborted run stays resumable.
      await first.abort(id);
    } finally {
      await first.shutdownAll();
    }

    // The cap has since been lowered below the run's two scopes.
    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) => stubBundle(input));
    const createWorkflowTab = vi.fn(() => createMockTab());
    const orch = makeOrchestrator({
      checkpointStore,
      userConfig: makeTestUserConfig({ maxConcurrentAgentSessions: 1 }),
      createWorkflowInfrastructure: createInfra,
      createWorkflowTab,
    });

    const refusal = await orch.resume(id).catch((err: unknown) => err);
    expect(refusal).toMatchObject({ code: AGENT_SLOT_REQUEST_TOO_LARGE });
    expect(String(refusal)).toContain('maxConcurrentAgentSessions');
    // Refused before anything was created.
    expect(createWorkflowTab).not.toHaveBeenCalled();
    expect(orch.listActive()).toEqual([]);
    expect(createInfra).not.toHaveBeenCalled();
  });

  it('returns the reservation when the first mint fails, while the run lives on', async () => {
    const defPath = writeDefinitionFile(tmpDir, gatedDef);
    const pool = new AgentSlotPool(1);
    const createInfra = vi.fn(async () => {
      throw new Error('docker is down');
    });
    const orch = makeOrchestrator({ agentSlots: pool, createWorkflowInfrastructure: createInfra });

    const id = await orch.start(defPath, 'task');
    // The failed state routes to the gate: the run is alive but holds no bundle.
    expect(await waitForGateOrCompletion(orch, id)).toBe('gate');
    expect(createInfra).toHaveBeenCalledTimes(1);
    expect(pool.inUse).toBe(0);
    await orch.abort(id);
  });

  it('refuses at start a shared-container workflow that needs more slots than the cap', async () => {
    const defPath = writeDefinitionFile(tmpDir, twoScopeDef);
    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) => stubBundle(input));
    const orch = makeOrchestrator({
      userConfig: makeTestUserConfig({ maxConcurrentAgentSessions: 1 }),
      createWorkflowInfrastructure: createInfra,
    });

    const refusal = await orch.start(defPath, 'task').catch((err: unknown) => err);
    expect(refusal).toMatchObject({ code: AGENT_SLOT_REQUEST_TOO_LARGE });
    expect(String(refusal)).toContain('maxConcurrentAgentSessions');
    expect(orch.listActive()).toEqual([]);
    expect(createInfra).not.toHaveBeenCalled();
  });

  it('makes a session that brings its own environment wait for a slot', async () => {
    const defPath = writeDefinitionFile(tmpDir, builtinDef);
    const sessions = heldSessions();
    const createSession = vi.fn(sessions.create);
    const pool = new AgentSlotPool(1);
    const orch = makeOrchestrator({ agentSlots: pool, createSession });

    const first = await orch.start(defPath, 'first');
    await eventually(() => expect(sessions.turns).toHaveLength(1));
    const second = await orch.start(defPath, 'second');
    await eventually(() => expect(pool.waiting).toBe(1));
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(tabLines(second).some((line) => line.includes('waiting for a free agent slot'))).toBe(true);

    // The first session ends (its state completes): the second is created.
    sessions.turns[0].release();
    await waitForCompletion(orch, first);
    await eventually(() => expect(createSession).toHaveBeenCalledTimes(2));
    await eventually(() => expect(sessions.turns).toHaveLength(2));
    expect(pool.inUse).toBe(1);

    sessions.turns[1].release();
    await waitForCompletion(orch, second);
    await eventually(() => expect(pool.inUse).toBe(0));
  });

  it("returns an aborted run's session slots even when its turn never unwinds", async () => {
    const defPath = writeDefinitionFile(tmpDir, builtinDef);
    // A turn that never answers, even after the session closes.
    const createSession = vi.fn(async () => new MockSession({ responses: () => new Promise<never>(() => {}) }));
    const pool = new AgentSlotPool(1);
    const orch = makeOrchestrator({ agentSlots: pool, createSession });

    const id = await orch.start(defPath, 'task');
    await eventually(() => expect(pool.inUse).toBe(1));
    await orch.abort(id);
    expect(pool.inUse).toBe(0);
  });

  it('returns the slot of a session whose creation finishes after the run was aborted', async () => {
    const defPath = writeDefinitionFile(tmpDir, builtinDef);
    // Session creation is held until the abort has run: abort() closes only
    // the sessions that already exist, so this one is closed by the state
    // invocation itself once creation returns.
    let finishCreation: (session: MockSession) => void = () => {};
    const created = new Promise<MockSession>((resolve) => {
      finishCreation = resolve;
    });
    const createSession = vi.fn(() => created);
    const pool = new AgentSlotPool(1);
    const orch = makeOrchestrator({ agentSlots: pool, createSession });

    const id = await orch.start(defPath, 'task');
    await eventually(() => expect(createSession).toHaveBeenCalledTimes(1));
    // The slot is taken before the session is created.
    expect(pool.inUse).toBe(1);

    await orch.abort(id);
    // The session being created will exist: its slot stays taken until then.
    expect(pool.inUse).toBe(1);

    const late = new MockSession({ responses: () => new Promise<never>(() => {}) });
    finishCreation(late);
    // Closed at once, never sent a turn, and its slot goes back to the pool.
    await eventually(() => expect(late.closed).toBe(true));
    await eventually(() => expect(pool.inUse).toBe(0));
    expect(late.sentMessages).toEqual([]);
  });
});
