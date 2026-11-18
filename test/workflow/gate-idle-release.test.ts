/**
 * Gate idle release (WP-133, GAP4-12).
 *
 * A run waiting at a human gate holds its shared containers, their proxies
 * and relays, and its run and workspace locks. When the gate goes undecided
 * for `settings.gateIdleTimeoutMinutes` (default: 4 hours for a run that
 * holds a container), the run is stopped through the ordinary abort path:
 * snapshot when configured, a resumable checkpoint that re-raises the same
 * gate, every bundle destroyed. Stub bundles stand in for containers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  WorkflowOrchestrator,
  resolveGateIdleTimeoutMinutes,
  type CreateWorkflowInfrastructureInput,
} from '../../src/workflow/orchestrator.js';
import { FileCheckpointStore, isCheckpointResumable } from '../../src/workflow/checkpoint.js';
import { validateDefinition } from '../../src/workflow/validate.js';
import {
  DEFAULT_GATE_IDLE_TIMEOUT_MINUTES,
  MAX_GATE_IDLE_TIMEOUT_MINUTES,
  type HumanGateRequest,
  type WorkflowDefinition,
  type WorkflowId,
} from '../../src/workflow/types.js';
import type { DockerInfrastructure } from '../../src/docker/docker-infrastructure.js';
import { isGateResolutionError } from '../../src/workflow/errors.js';
import { createMockDocker } from '../helpers/docker-mocks.js';
import {
  approvedResponse,
  createArtifactAwareSession,
  createCheckpointStore,
  createDeps,
  stubPersonasForTest,
  waitForCompletion,
  waitForGate,
  writeDefinitionFile,
} from './test-helpers.js';

/** About 120 ms: long enough to see the gate raised, short enough for a unit test. */
const SHORT_TIMEOUT_MINUTES = 0.002;

function gatedDefinition(settings: WorkflowDefinition['settings']): WorkflowDefinition {
  return {
    name: 'gate-idle',
    description: 'An agent state, then a human gate',
    initial: 'build',
    settings,
    states: {
      build: {
        type: 'agent',
        description: 'Builds',
        persona: 'global',
        prompt: 'Build it.',
        inputs: [],
        outputs: ['result'],
        transitions: [{ to: 'review' }],
      },
      review: {
        type: 'human_gate',
        description: 'Review the result',
        acceptedEvents: ['APPROVE', 'ABORT'],
        present: ['result'],
        transitions: [
          { to: 'done', event: 'APPROVE' },
          { to: 'aborted', event: 'ABORT' },
        ],
      },
      done: { type: 'terminal', description: 'Done' },
      aborted: { type: 'terminal', description: 'Aborted' },
    },
  };
}

const SHARED = { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true } as const;

/** Agent image build every stub bundle resolves (a snapshot records it). */
const STUB_AGENT_BUILD_HASH = 'a'.repeat(64);

function makeStubInfrastructure(input: CreateWorkflowInfrastructureInput): DockerInfrastructure {
  return {
    workflowId: input.workflowId,
    bundleId: input.bundleId,
    runtimeKind: 'docker',
    containerId: `container-${input.bundleId}`,
    // Like a real bundle, the stub knows the agent image build it runs: a
    // container is snapshotted (and later resumed) only under a known build.
    imageResolution: {
      mode: 'build-if-stale',
      logicalName: 'ironcurtain-claude-code:latest',
      imageRef: 'ironcurtain-claude-code:latest',
      buildHash: STUB_AGENT_BUILD_HASH,
    },
    setTokenSessionId: () => {},
    beginCaptureSession: () => {},
    endCaptureSession: async () => {},
  } as unknown as DockerInfrastructure;
}

interface Internal {
  workflows: Map<WorkflowId, { gateIdleTimer?: unknown; bundlesByScope: Map<string, unknown> }>;
}

describe('resolveGateIdleTimeoutMinutes', () => {
  it('uses the configured value whether or not a container is held', () => {
    expect(resolveGateIdleTimeoutMinutes({ gateIdleTimeoutMinutes: 30 }, true)).toBe(30);
    expect(resolveGateIdleTimeoutMinutes({ gateIdleTimeoutMinutes: 30 }, false)).toBe(30);
  });

  it('never times out when the workflow sets null', () => {
    expect(resolveGateIdleTimeoutMinutes({ gateIdleTimeoutMinutes: null }, true)).toBeUndefined();
  });

  it('defaults only for a run that holds a container at the gate', () => {
    expect(resolveGateIdleTimeoutMinutes(undefined, true)).toBe(DEFAULT_GATE_IDLE_TIMEOUT_MINUTES);
    expect(resolveGateIdleTimeoutMinutes({}, false)).toBeUndefined();
  });
});

describe('settings.gateIdleTimeoutMinutes validation', () => {
  const accepts = (value: unknown): boolean => {
    try {
      validateDefinition({ ...gatedDefinition({ ...SHARED, gateIdleTimeoutMinutes: value as number }) });
      return true;
    } catch {
      return false;
    }
  };

  it('accepts positive minutes up to the maximum, and null', () => {
    expect(accepts(1)).toBe(true);
    expect(accepts(0.5)).toBe(true);
    expect(accepts(MAX_GATE_IDLE_TIMEOUT_MINUTES)).toBe(true);
    expect(accepts(null)).toBe(true);
  });

  it('rejects zero, negative, oversized and non-numeric values', () => {
    expect(accepts(0)).toBe(false);
    expect(accepts(-5)).toBe(false);
    expect(accepts(MAX_GATE_IDLE_TIMEOUT_MINUTES + 1)).toBe(false);
    expect(accepts('60')).toBe(false);
  });
});

describe('WorkflowOrchestrator gate idle release', () => {
  let tmpDir: string;
  let cleanupPersonas: () => void;
  const orchestrators: WorkflowOrchestrator[] = [];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'gate-idle-'));
    cleanupPersonas = stubPersonasForTest(tmpDir, gatedDefinition(SHARED));
  });

  afterEach(async () => {
    for (const orchestrator of orchestrators.splice(0)) await orchestrator.shutdownAll();
    cleanupPersonas();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function track(orchestrator: WorkflowOrchestrator): WorkflowOrchestrator {
    orchestrators.push(orchestrator);
    return orchestrator;
  }

  function buildSession() {
    return vi.fn(async () =>
      createArtifactAwareSession([{ text: approvedResponse('built'), artifacts: ['result'] }], tmpDir),
    );
  }

  it('stops an idle gate past the timeout, leaving a resumable checkpoint and no running container', async () => {
    const definition = gatedDefinition({ ...SHARED, gateIdleTimeoutMinutes: SHORT_TIMEOUT_MINUTES });
    const defPath = writeDefinitionFile(tmpDir, definition);
    // The production layout (checkpoint in the run directory), so run
    // discovery (`listResumable`) sees it.
    const checkpointStore = new FileCheckpointStore(tmpDir);
    const bundles: DockerInfrastructure[] = [];
    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) => {
      const bundle = makeStubInfrastructure(input);
      bundles.push(bundle);
      return bundle;
    });
    const destroyInfra = vi.fn(async () => {});
    const raiseGate = vi.fn();
    const dismissGate = vi.fn();
    const failed: string[] = [];
    const orchestrator = track(
      new WorkflowOrchestrator(
        createDeps(tmpDir, {
          checkpointStore,
          createSession: buildSession(),
          createWorkflowInfrastructure: createInfra,
          destroyWorkflowInfrastructure: destroyInfra,
          raiseGate,
          dismissGate,
        }),
      ),
    );
    orchestrator.onEvent((event) => {
      if (event.kind === 'failed' && event.phase === 'aborted') failed.push(event.error);
    });

    const workflowId = await orchestrator.start(defPath, 'task');
    const [gate] = await waitForGate(raiseGate, 1);
    // Waiting at the gate, the run still holds its container.
    expect(createInfra).toHaveBeenCalledTimes(1);
    expect(destroyInfra).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(orchestrator.listActive()).not.toContain(workflowId), {
      timeout: 5000,
      interval: 10,
    });

    // No running container: the bundle was torn down, once.
    expect(destroyInfra).toHaveBeenCalledTimes(1);
    expect(destroyInfra).toHaveBeenCalledWith(bundles[0]);
    // The gate is withdrawn from the deciders, and a decision for it is refused.
    expect(dismissGate).toHaveBeenCalledWith(workflowId, gate.gateId);
    let refusal: unknown;
    try {
      orchestrator.resolveGate(workflowId, { gateId: gate.gateId, type: 'APPROVE', resolvedBy: 'cli' });
    } catch (err) {
      refusal = err;
    }
    expect(isGateResolutionError(refusal)).toBe(true);

    // A resumable checkpoint at the gate, with the raise id deciders saw.
    const status = orchestrator.getStatus(workflowId);
    expect(status?.phase).toBe('aborted');
    const checkpoint = checkpointStore.load(workflowId);
    expect(checkpoint).toBeDefined();
    expect(checkpoint && isCheckpointResumable(checkpoint)).toBe(true);
    expect(checkpoint?.machineState).toBe('review');
    expect(checkpoint?.activeGateId).toBe(gate.gateId);
    expect(checkpoint?.finalStatus).toMatchObject({
      phase: 'aborted',
      reason: expect.stringContaining('Gate "review" waited 0.002 minutes without a decision') as unknown,
    });
    expect(failed).toEqual([expect.stringContaining('its containers released')]);
    expect(orchestrator.listResumable()).toContain(workflowId);

    // Resuming re-raises the same gate; a decision on it completes the run.
    const resumedRaise = vi.fn((raised: HumanGateRequest) => {
      // Decide right away, well inside the (re-armed) idle timeout.
      queueMicrotask(() =>
        resumed.resolveGate(raised.workflowId as WorkflowId, {
          gateId: raised.gateId,
          type: 'APPROVE',
          resolvedBy: 'cli',
        }),
      );
    });
    const resumed = track(
      new WorkflowOrchestrator(
        createDeps(tmpDir, {
          checkpointStore,
          createSession: buildSession(),
          createWorkflowInfrastructure: createInfra,
          destroyWorkflowInfrastructure: destroyInfra,
          raiseGate: resumedRaise,
        }),
      ),
    );
    await resumed.resume(workflowId);
    await waitForCompletion(resumed, workflowId);
    expect(resumedRaise).toHaveBeenCalledTimes(1);
    expect(resumedRaise.mock.calls[0][0].gateId).toBe(gate.gateId);
    expect(resumed.getStatus(workflowId)?.phase).toBe('completed');
  });

  it('snapshots the container on release when the workflow snapshots on stop', async () => {
    const definition = gatedDefinition({
      ...SHARED,
      snapshotOnStop: true,
      gateIdleTimeoutMinutes: SHORT_TIMEOUT_MINUTES,
    });
    const defPath = writeDefinitionFile(tmpDir, definition);
    const checkpointStore = createCheckpointStore(tmpDir);
    const digest = `sha256:${'7'.repeat(64)}`;
    const docker = { ...createMockDocker(), commit: vi.fn(async () => digest), removeImage: vi.fn(async () => true) };
    const destroyInfra = vi.fn(async () => {});
    const raiseGate = vi.fn();
    const orchestrator = track(
      new WorkflowOrchestrator(
        createDeps(tmpDir, {
          checkpointStore,
          createSession: buildSession(),
          createWorkflowInfrastructure: async (input) => ({ ...makeStubInfrastructure(input), docker }),
          destroyWorkflowInfrastructure: destroyInfra,
          raiseGate,
        }),
      ),
    );

    const workflowId = await orchestrator.start(defPath, 'task');
    await waitForGate(raiseGate, 1);
    await vi.waitFor(() => expect(checkpointStore.load(workflowId)?.finalStatus?.phase).toBe('aborted'), {
      timeout: 5000,
      interval: 10,
    });
    await vi.waitFor(() => expect(destroyInfra).toHaveBeenCalledTimes(1), { timeout: 5000, interval: 10 });

    expect(docker.commit).toHaveBeenCalledTimes(1);
    expect(checkpointStore.load(workflowId)?.containerSnapshots?.primary).toMatchObject({
      image: digest,
      agentBuildHash: STUB_AGENT_BUILD_HASH,
    });
  });

  it('cancels the timer when the gate is decided in time', async () => {
    const definition = gatedDefinition({ ...SHARED, gateIdleTimeoutMinutes: SHORT_TIMEOUT_MINUTES });
    const defPath = writeDefinitionFile(tmpDir, definition);
    const destroyInfra = vi.fn(async () => {});
    const raiseGate = vi.fn((raised: HumanGateRequest) => {
      queueMicrotask(() =>
        orchestrator.resolveGate(raised.workflowId as WorkflowId, {
          gateId: raised.gateId,
          type: 'APPROVE',
          resolvedBy: 'cli',
        }),
      );
    });
    const orchestrator = track(
      new WorkflowOrchestrator(
        createDeps(tmpDir, {
          createSession: buildSession(),
          createWorkflowInfrastructure: async (input) => makeStubInfrastructure(input),
          destroyWorkflowInfrastructure: destroyInfra,
          raiseGate,
        }),
      ),
    );

    const workflowId = await orchestrator.start(defPath, 'task');
    await waitForCompletion(orchestrator, workflowId);
    // Well past the idle timeout: the run stays completed, torn down once.
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));

    expect(orchestrator.getStatus(workflowId)?.phase).toBe('completed');
    expect(destroyInfra).toHaveBeenCalledTimes(1);
    const internal = orchestrator as unknown as Internal;
    expect(internal.workflows.get(workflowId)?.gateIdleTimer).toBeUndefined();
  });

  it('arms the default timeout only while the run holds a container', async () => {
    const holding = gatedDefinition(SHARED);
    // The gate comes first: no bundle has been minted yet.
    const gateFirst: WorkflowDefinition = {
      name: 'gate-first',
      description: 'A human gate, then an agent state',
      initial: 'review',
      settings: SHARED,
      states: {
        review: {
          type: 'human_gate',
          description: 'Approve the plan',
          acceptedEvents: ['APPROVE', 'ABORT'],
          transitions: [
            { to: 'build', event: 'APPROVE' },
            { to: 'aborted', event: 'ABORT' },
          ],
        },
        build: holding.states.build,
        done: holding.states.done,
        aborted: holding.states.aborted,
      },
    };
    const buildState = gateFirst.states.build;
    if (buildState.type === 'agent') {
      gateFirst.states.build = { ...buildState, transitions: [{ to: 'done' }] };
    }
    const raiseGate = vi.fn();
    const orchestrator = track(
      new WorkflowOrchestrator(
        createDeps(tmpDir, {
          createSession: buildSession(),
          createWorkflowInfrastructure: async (input) => makeStubInfrastructure(input),
          destroyWorkflowInfrastructure: async () => {},
          raiseGate,
        }),
      ),
    );
    const internal = orchestrator as unknown as Internal;
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      const holdingId = await orchestrator.start(writeDefinitionFile(tmpDir, holding), 'task');
      await waitForGate(raiseGate, 1);
      const firstId = await orchestrator.start(writeDefinitionFile(tmpDir, gateFirst), 'task');
      await waitForGate(raiseGate, 2);

      expect(internal.workflows.get(holdingId)?.bundlesByScope.size).toBe(1);
      expect(internal.workflows.get(holdingId)?.gateIdleTimer).toBeDefined();
      expect(setTimeoutSpy.mock.calls.some((call) => call[1] === DEFAULT_GATE_IDLE_TIMEOUT_MINUTES * 60_000)).toBe(
        true,
      );
      expect(internal.workflows.get(firstId)?.bundlesByScope.size).toBe(0);
      expect(internal.workflows.get(firstId)?.gateIdleTimer).toBeUndefined();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it('never arms a timer when the workflow disables it', async () => {
    const definition = gatedDefinition({ ...SHARED, gateIdleTimeoutMinutes: null });
    const raiseGate = vi.fn();
    const orchestrator = track(
      new WorkflowOrchestrator(
        createDeps(tmpDir, {
          createSession: buildSession(),
          createWorkflowInfrastructure: async (input) => makeStubInfrastructure(input),
          destroyWorkflowInfrastructure: async () => {},
          raiseGate,
        }),
      ),
    );
    const workflowId = await orchestrator.start(writeDefinitionFile(tmpDir, definition), 'task');
    await waitForGate(raiseGate, 1);

    const internal = orchestrator as unknown as Internal;
    expect(internal.workflows.get(workflowId)?.bundlesByScope.size).toBe(1);
    expect(internal.workflows.get(workflowId)?.gateIdleTimer).toBeUndefined();
    expect(orchestrator.getStatus(workflowId)?.phase).toBe('waiting_human');
  });

  it('clears the timer when the run is aborted at the gate', async () => {
    const definition = gatedDefinition({ ...SHARED, gateIdleTimeoutMinutes: SHORT_TIMEOUT_MINUTES });
    const raiseGate = vi.fn();
    const dismissGate = vi.fn();
    const orchestrator = track(
      new WorkflowOrchestrator(
        createDeps(tmpDir, {
          createSession: buildSession(),
          createWorkflowInfrastructure: async (input) => makeStubInfrastructure(input),
          destroyWorkflowInfrastructure: async () => {},
          raiseGate,
          dismissGate,
        }),
      ),
    );
    const workflowId = await orchestrator.start(writeDefinitionFile(tmpDir, definition), 'task');
    await waitForGate(raiseGate, 1);
    await orchestrator.abort(workflowId, { reason: 'operator abort' });
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));

    const internal = orchestrator as unknown as Internal;
    expect(internal.workflows.get(workflowId)?.gateIdleTimer).toBeUndefined();
    expect(orchestrator.getStatus(workflowId)).toEqual({ phase: 'aborted', reason: 'operator abort' });
    expect(dismissGate).not.toHaveBeenCalled();
  });
});
