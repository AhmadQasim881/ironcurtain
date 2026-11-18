/**
 * Task-scoped workflow runs (`ironcurtain workflow start --task-scoped`,
 * WP-119): the CLI compiles the task scope and hands its directory to
 * `start()`. The orchestrator validates it, narrows every agent state's
 * persona policy with it (session options for per-state sessions, the
 * bundle factory input for shared containers), persists it in the
 * checkpoint and keeps it across resume, refusing a resume whose scope no
 * longer validates.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { BundleId, SessionOptions } from '../../src/session/types.js';
import type { WorkflowDefinition } from '../../src/workflow/types.js';
import type { DockerInfrastructure } from '../../src/docker/docker-infrastructure.js';
import { WorkflowOrchestrator, type CreateWorkflowInfrastructureInput } from '../../src/workflow/orchestrator.js';
import { FileCheckpointStore } from '../../src/workflow/checkpoint.js';
import { TASK_SCOPE_RECORD_FILENAME } from '../../src/config/task-scope-policy.js';
import { scopeRule, writeTaskScopeDir } from '../fixtures/task-scope.js';
import {
  approvedResponse,
  createArtifactAwareSession,
  createDeps,
  resolveActiveGate,
  stubPersonasForTest,
  waitForCompletion,
  waitForGate,
  writeDefinitionFile,
} from './test-helpers.js';

const TASK = 'Add a CSV export to the report module.';

const gatedDef: WorkflowDefinition = {
  name: 'task-scope-gated',
  description: 'Plan, gate, implement',
  initial: 'plan',
  settings: { mode: 'builtin' },
  states: {
    plan: {
      type: 'agent',
      description: 'Plan',
      persona: 'planner',
      prompt: 'Plan.',
      inputs: [],
      outputs: ['plan'],
      transitions: [{ to: 'plan_gate' }],
    },
    plan_gate: {
      type: 'human_gate',
      description: 'Review the plan',
      acceptedEvents: ['APPROVE', 'ABORT'],
      present: ['plan'],
      transitions: [
        { to: 'implement', event: 'APPROVE' },
        { to: 'aborted', event: 'ABORT' },
      ],
    },
    implement: {
      type: 'agent',
      description: 'Implement',
      persona: 'coder',
      prompt: 'Code.',
      inputs: ['plan'],
      outputs: ['code'],
      transitions: [{ to: 'done' }],
    },
    done: { type: 'terminal', description: 'Done' },
    aborted: { type: 'terminal', description: 'Aborted' },
  },
};

const sharedDef: WorkflowDefinition = {
  name: 'task-scope-shared',
  description: 'One state in a shared container',
  initial: 'work',
  settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true },
  states: {
    work: {
      type: 'agent',
      description: 'Work',
      persona: 'global',
      prompt: 'Work.',
      inputs: [],
      outputs: ['result'],
      transitions: [{ to: 'done' }],
    },
    done: { type: 'terminal', description: 'Done' },
  },
};

function stubInfrastructure(workflowId: string, bundleId: BundleId): DockerInfrastructure {
  return {
    __stub: true,
    workflowId,
    bundleId,
    setTokenSessionId: () => {},
    beginCaptureSession: () => {},
    endCaptureSession: async () => {},
  } as unknown as DockerInfrastructure;
}

/** Session factory that records the options and writes the state's artifact. */
function recordingFactory(tmpDir: string, captured: SessionOptions[]) {
  return vi.fn(async (opts: SessionOptions) => {
    captured.push(opts);
    const artifact = opts.persona === 'planner' ? 'plan' : opts.persona === 'coder' ? 'code' : 'result';
    return createArtifactAwareSession([{ text: approvedResponse(), artifacts: [artifact] }], tmpDir);
  });
}

describe('task-scoped workflow runs', () => {
  let tmpDir: string;
  let cleanupPersonas: (() => void) | undefined;
  const orchestrators: WorkflowOrchestrator[] = [];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orch-task-scope-'));
    // Sets IRONCURTAIN_HOME, so task-scope directories are written there.
    cleanupPersonas = stubPersonasForTest(tmpDir, gatedDef, sharedDef);
  });

  afterEach(async () => {
    for (const orchestrator of orchestrators.splice(0)) await orchestrator.shutdownAll();
    cleanupPersonas?.();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function track(orchestrator: WorkflowOrchestrator): WorkflowOrchestrator {
    orchestrators.push(orchestrator);
    return orchestrator;
  }

  it('narrows every state, checkpoints the scope, and keeps it across resume', async () => {
    const scopeDir = writeTaskScopeDir(TASK, [scopeRule('scope-read', 'filesystem', { roles: ['read-path'] })]);
    const canonical = realpathSync(scopeDir);
    const defPath = writeDefinitionFile(tmpDir, gatedDef);
    const checkpointStore = new FileCheckpointStore(tmpDir);
    const captured: SessionOptions[] = [];
    const raiseGate = vi.fn();

    const first = track(
      new WorkflowOrchestrator(
        createDeps(tmpDir, { checkpointStore, raiseGate, createSession: recordingFactory(tmpDir, captured) }),
      ),
    );
    const workflowId = await first.start(defPath, TASK, undefined, { taskPolicyDir: scopeDir });
    await waitForGate(raiseGate, 1);
    expect(captured.map((o) => o.taskPolicyDir)).toEqual([canonical]);
    expect(checkpointStore.load(workflowId)?.taskPolicyDir).toBe(canonical);

    // Stop at the gate, then resume in a fresh orchestrator.
    await first.abort(workflowId);
    const resumedGate = vi.fn();
    const resumed = track(
      new WorkflowOrchestrator(
        createDeps(tmpDir, {
          checkpointStore,
          raiseGate: resumedGate,
          createSession: recordingFactory(tmpDir, captured),
        }),
      ),
    );
    await resumed.resume(workflowId);
    await waitForGate(resumedGate, 1);
    resolveActiveGate(resumed, workflowId, { type: 'APPROVE' });
    await waitForCompletion(resumed, workflowId);

    expect(captured.map((o) => o.persona)).toEqual(['planner', 'coder']);
    expect(captured.map((o) => o.taskPolicyDir)).toEqual([canonical, canonical]);
  });

  it('refuses to resume a task-scoped run whose scope no longer validates', async () => {
    const scopeDir = writeTaskScopeDir(TASK, []);
    const defPath = writeDefinitionFile(tmpDir, gatedDef);
    const checkpointStore = new FileCheckpointStore(tmpDir);
    const raiseGate = vi.fn();
    const first = track(
      new WorkflowOrchestrator(
        createDeps(tmpDir, { checkpointStore, raiseGate, createSession: recordingFactory(tmpDir, []) }),
      ),
    );
    const workflowId = await first.start(defPath, TASK, undefined, { taskPolicyDir: scopeDir });
    await waitForGate(raiseGate, 1);
    await first.abort(workflowId);

    rmSync(resolve(scopeDir, TASK_SCOPE_RECORD_FILENAME));
    const resumed = track(new WorkflowOrchestrator(createDeps(tmpDir, { checkpointStore })));
    await expect(resumed.resume(workflowId)).rejects.toMatchObject({
      code: 'WORKFLOW_NOT_RESUMABLE',
      message: expect.stringMatching(/task scope failed validation/),
    });
  });

  it('refuses to start with a task scope that does not validate, before creating anything', async () => {
    const scopeDir = writeTaskScopeDir(TASK, []);
    rmSync(resolve(scopeDir, 'compiled-policy.json'));
    const defPath = writeDefinitionFile(tmpDir, gatedDef);
    const orchestrator = track(new WorkflowOrchestrator(createDeps(tmpDir)));
    const before = readdirSync(tmpDir);

    await expect(orchestrator.start(defPath, TASK, undefined, { taskPolicyDir: scopeDir })).rejects.toThrow(
      /has no compiled policy/,
    );
    await expect(orchestrator.start(defPath, TASK, undefined, { taskPolicyDir: tmpdir() })).rejects.toThrow(
      /policyDir must be one of IronCurtain's compiled-policy directories/,
    );
    expect(readdirSync(tmpDir)).toEqual(before);
  });

  it('is not task-scoped unless asked', async () => {
    const defPath = writeDefinitionFile(tmpDir, gatedDef);
    const checkpointStore = new FileCheckpointStore(tmpDir);
    const captured: SessionOptions[] = [];
    const raiseGate = vi.fn();
    const orchestrator = track(
      new WorkflowOrchestrator(
        createDeps(tmpDir, { checkpointStore, raiseGate, createSession: recordingFactory(tmpDir, captured) }),
      ),
    );
    const workflowId = await orchestrator.start(defPath, TASK);
    await waitForGate(raiseGate, 1);
    expect(captured[0].taskPolicyDir).toBeUndefined();
    expect(checkpointStore.load(workflowId)?.taskPolicyDir).toBeUndefined();
  });

  it('hands the scope to the shared-container bundle, whose coordinator narrows every persona', async () => {
    const scopeDir = writeTaskScopeDir(TASK, []);
    const defPath = writeDefinitionFile(tmpDir, sharedDef);
    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) =>
      stubInfrastructure(input.workflowId, input.bundleId),
    );
    const captured: SessionOptions[] = [];
    const orchestrator = track(
      new WorkflowOrchestrator(
        createDeps(tmpDir, {
          createSession: recordingFactory(tmpDir, captured),
          createWorkflowInfrastructure: createInfra,
          destroyWorkflowInfrastructure: vi.fn(async () => {}),
        }),
      ),
    );
    const workflowId = await orchestrator.start(defPath, TASK, undefined, { taskPolicyDir: scopeDir });
    await waitForCompletion(orchestrator, workflowId);

    expect(createInfra).toHaveBeenCalledTimes(1);
    expect(createInfra.mock.calls[0][0].taskPolicyDir).toBe(realpathSync(scopeDir));
    expect(captured[0].taskPolicyDir).toBe(realpathSync(scopeDir));
    expect(existsSync(scopeDir)).toBe(true);
  });
});
