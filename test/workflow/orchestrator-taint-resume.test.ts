/**
 * Taint escalation across a workflow resume (WP-117). A resumed
 * shared-container run mints new bundles, each with a new audit log, so
 * the taint an earlier leg recorded lives only in the earlier bundles'
 * audit logs. The orchestrator lists them at resume, before the resumed
 * leg mints anything, and hands them to every bundle it mints
 * (`CreateWorkflowInfrastructureInput.taintReplayAuditLogPaths`); the
 * bundle's coordinator replays them (see test/taint-policy.test.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { WorkflowDefinition } from '../../src/workflow/types.js';
import type { DockerInfrastructure } from '../../src/docker/docker-infrastructure.js';
import type { BundleId } from '../../src/session/types.js';
import { WorkflowOrchestrator, type CreateWorkflowInfrastructureInput } from '../../src/workflow/orchestrator.js';
import { getBundleAuditLogPath, getWorkflowContainersDir } from '../../src/config/paths.js';
import {
  approvedResponse,
  createArtifactAwareSession,
  createDeps,
  stubPersonasForTest,
  writeDefinitionFile,
} from './test-helpers.js';

function makeStubInfrastructure(workflowId: string, bundleId: BundleId): DockerInfrastructure {
  return {
    __stub: true,
    workflowId,
    bundleId,
    runtimeKind: 'docker',
    setTokenSessionId: () => {},
    beginCaptureSession: () => {},
    endCaptureSession: async () => {},
  } as unknown as DockerInfrastructure;
}

const twoStateDef: WorkflowDefinition = {
  name: 'docker-taint-resume',
  description: 'Shared-container workflow that is aborted in its second state and resumed',
  initial: 'first',
  settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true },
  states: {
    first: {
      type: 'agent',
      description: 'First agent',
      persona: 'global',
      prompt: 'You are first.',
      inputs: [],
      outputs: ['a'],
      transitions: [{ to: 'second' }],
    },
    second: {
      type: 'agent',
      description: 'Second agent',
      persona: 'global',
      prompt: 'You are second.',
      inputs: ['a'],
      outputs: ['b'],
      transitions: [{ to: 'done' }],
    },
    done: { type: 'terminal', description: 'Done' },
  },
};

async function waitForCalls(mock: { mock: { calls: unknown[] } }, count: number): Promise<void> {
  const start = Date.now();
  while (mock.mock.calls.length < count && Date.now() - start < 5000) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('workflow resume hands earlier bundle audit logs to new bundles (taint escalation)', () => {
  let tmpDir: string;
  let cleanupPersonas: (() => void) | undefined;
  const orchestrators: WorkflowOrchestrator[] = [];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'taint-resume-test-'));
    cleanupPersonas = stubPersonasForTest(tmpDir, twoStateDef);
  });

  afterEach(async () => {
    for (const orchestrator of orchestrators.splice(0)) {
      await orchestrator.shutdownAll().catch(() => {});
    }
    cleanupPersonas?.();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('passes nothing on a fresh run and the earlier legs’ bundle logs on resume', async () => {
    const defPath = writeDefinitionFile(tmpDir, twoStateDef);
    const checkpointStore = createDeps(tmpDir).checkpointStore;

    // Leg 1: "first" completes, "second" stays active until the abort.
    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) =>
      makeStubInfrastructure(input.workflowId, input.bundleId),
    );
    let sessionCount = 0;
    let secondStarted!: () => void;
    const secondSessionStarted = new Promise<void>((resolveStarted) => {
      secondStarted = resolveStarted;
    });
    const sessionFactory = vi.fn(async () => {
      sessionCount++;
      if (sessionCount === 1) {
        return createArtifactAwareSession([{ text: approvedResponse('done'), artifacts: ['a'] }], tmpDir);
      }
      secondStarted();
      return new Promise<never>(() => {});
    });
    const firstLeg = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        checkpointStore,
        createSession: sessionFactory,
        createWorkflowInfrastructure: createInfra,
        destroyWorkflowInfrastructure: async () => {},
      }),
    );
    orchestrators.push(firstLeg);

    const workflowId = await firstLeg.start(defPath, 'task');
    await secondSessionStarted;
    expect(createInfra).toHaveBeenCalledTimes(1);
    const firstInput = createInfra.mock.calls[0][0];
    // A fresh run has no earlier legs.
    expect(firstInput.taintReplayAuditLogPaths).toEqual([]);
    await firstLeg.abort(workflowId);

    // The earlier leg's bundle directory is on disk (its audit log would
    // be written by its coordinator); a stray file next to it is ignored.
    mkdirSync(join(getWorkflowContainersDir(workflowId), firstInput.bundleId), { recursive: true });
    writeFileSync(join(getWorkflowContainersDir(workflowId), 'notes.txt'), 'not a bundle');

    // Leg 2: resume mints a new bundle that must replay leg 1's audit log.
    const resumeCreateInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) =>
      makeStubInfrastructure(input.workflowId, input.bundleId),
    );
    const resumed = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        checkpointStore,
        createSession: vi.fn(async () => new Promise<never>(() => {})),
        createWorkflowInfrastructure: resumeCreateInfra,
        destroyWorkflowInfrastructure: async () => {},
      }),
    );
    orchestrators.push(resumed);

    await resumed.resume(workflowId);
    await waitForCalls(resumeCreateInfra, 1);

    expect(resumeCreateInfra).toHaveBeenCalledTimes(1);
    const resumedInput = resumeCreateInfra.mock.calls[0][0];
    expect(resumedInput.bundleId).not.toBe(firstInput.bundleId);
    expect(resumedInput.taintReplayAuditLogPaths).toEqual([getBundleAuditLogPath(workflowId, firstInput.bundleId)]);
  });
});
