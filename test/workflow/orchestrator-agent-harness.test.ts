/**
 * Per-state agent harness (`states.<id>.dockerAgent`) through the
 * orchestrator, with the in-memory seams only (mocked session factory and
 * infrastructure factory; no Docker):
 *
 * - per-state-container mode: each agent state's session runs on the
 *   state's own harness (coder on claude-code, reviewer on codex);
 * - shared-container mode: each scope's bundle is minted for the harness of
 *   that scope's states, and the sessions borrowing it use the same harness.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BundleId, SessionOptions } from '../../src/session/types.js';
import type { WorkflowDefinition } from '../../src/workflow/types.js';
import type { DockerInfrastructure } from '../../src/docker/docker-infrastructure.js';
import { WorkflowOrchestrator, type CreateWorkflowInfrastructureInput } from '../../src/workflow/orchestrator.js';
import {
  approvedResponse,
  createArtifactAwareSession,
  createDeps,
  stubPersonasForTest,
  waitForCompletion,
  writeDefinitionFile,
} from './test-helpers.js';

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

/** Coder on the workflow default (claude-code), reviewer on codex. */
function coderReviewer(settings: WorkflowDefinition['settings'], reviewerScope?: string): WorkflowDefinition {
  return {
    name: 'diverse-reviewer',
    description: 'Coder and reviewer on different harnesses',
    initial: 'coder',
    settings,
    states: {
      coder: {
        type: 'agent',
        description: 'Writes the change',
        persona: 'global',
        prompt: 'Write it.',
        inputs: [],
        outputs: ['code'],
        transitions: [{ to: 'reviewer' }],
      },
      reviewer: {
        type: 'agent',
        description: 'Reviews the change',
        persona: 'global',
        prompt: 'Review it.',
        inputs: ['code'],
        outputs: ['review'],
        dockerAgent: 'codex',
        model: 'openai:gpt-5',
        ...(reviewerScope !== undefined ? { containerScope: reviewerScope } : {}),
        transitions: [{ to: 'done' }],
      },
      done: { type: 'terminal', description: 'Done' },
    },
  };
}

describe('per-state agent harness in the orchestrator', () => {
  let tmpDir: string;
  let orchestrator: WorkflowOrchestrator | undefined;
  let cleanupPersonas: (() => void) | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agent-harness-test-'));
    orchestrator = undefined;
  });

  afterEach(async () => {
    await orchestrator?.shutdownAll();
    cleanupPersonas?.();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function run(def: WorkflowDefinition, extra: Parameters<typeof createDeps>[1] = {}): Promise<SessionOptions[]> {
    cleanupPersonas = stubPersonasForTest(tmpDir, def);
    const defPath = writeDefinitionFile(tmpDir, def);
    const responses = [
      { text: approvedResponse('coded'), artifacts: ['code'] },
      { text: approvedResponse('reviewed'), artifacts: ['review'] },
    ];
    const captured: SessionOptions[] = [];
    const createSession = vi.fn((options: SessionOptions) => {
      captured.push(options);
      return Promise.resolve(createArtifactAwareSession([responses[captured.length - 1]], tmpDir));
    });
    orchestrator = new WorkflowOrchestrator(createDeps(tmpDir, { createSession, ...extra }));
    const workflowId = await orchestrator.start(defPath, 'task');
    await waitForCompletion(orchestrator, workflowId);
    expect(orchestrator.getStatus(workflowId)?.phase).toBe('completed');
    return captured;
  }

  it('runs each state on its own harness in per-state-container mode', async () => {
    const sessions = await run(coderReviewer({ mode: 'docker' }));

    expect(sessions.map((options) => options.mode)).toEqual([
      { kind: 'docker', agent: 'claude-code' },
      { kind: 'docker', agent: 'codex' },
    ]);
    expect(sessions[1].agentModelOverride).toBe('openai:gpt-5');
    for (const options of sessions) expect(options.workflow?.infrastructure).toBeUndefined();
  });

  it('a state without dockerAgent inherits settings.dockerAgent', async () => {
    const sessions = await run(coderReviewer({ mode: 'docker', dockerAgent: 'goose' }));
    expect(sessions.map((options) => options.mode)).toEqual([
      { kind: 'docker', agent: 'goose' },
      { kind: 'docker', agent: 'codex' },
    ]);
  });

  it('mints each shared-container scope for its own harness and borrows it with that harness', async () => {
    const minted: CreateWorkflowInfrastructureInput[] = [];
    const createWorkflowInfrastructure = vi.fn((input: CreateWorkflowInfrastructureInput) => {
      minted.push(input);
      return Promise.resolve(stubInfrastructure(input.workflowId, input.bundleId));
    });

    const sessions = await run(coderReviewer({ mode: 'docker', sharedContainer: true }, 'review_env'), {
      createWorkflowInfrastructure,
      destroyWorkflowInfrastructure: async () => {},
    });

    expect(minted.map((input) => [input.scope, input.agentId])).toEqual([
      ['primary', 'claude-code'],
      ['review_env', 'codex'],
    ]);
    expect(sessions.map((options) => options.mode)).toEqual([
      { kind: 'docker', agent: 'claude-code' },
      { kind: 'docker', agent: 'codex' },
    ]);
    // Each session borrows the bundle minted for its own scope.
    const bundleIds = sessions.map((options) => options.workflow?.infrastructure?.bundleId);
    expect(bundleIds).toEqual(minted.map((input) => input.bundleId));
  });

  it('refuses at load time a shared scope that mixes harnesses (no bundle is minted)', async () => {
    const def = coderReviewer({ mode: 'docker', sharedContainer: true });
    cleanupPersonas = stubPersonasForTest(tmpDir, def);
    const defPath = writeDefinitionFile(tmpDir, def);
    const createWorkflowInfrastructure = vi.fn();
    orchestrator = new WorkflowOrchestrator(createDeps(tmpDir, { createWorkflowInfrastructure }));

    await expect(orchestrator.start(defPath, 'task')).rejects.toThrow(/mixes agent harnesses/);
    expect(createWorkflowInfrastructure).not.toHaveBeenCalled();
  });
});
