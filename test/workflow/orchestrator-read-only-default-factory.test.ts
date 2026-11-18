/**
 * Read-only reviewer states end to end through the real default
 * infrastructure factory and the production session factory (WP-131).
 *
 * Everything below the orchestrator is real except what needs Docker:
 * `createDockerInfrastructure` returns a stub bundle and records the config it
 * was handed, and `DockerAgentSession` is a scripted session. What reaches
 * `createDockerInfrastructure` is what builds the container mounts
 * (`createSessionContainers`, mount tested in docker-infrastructure.test.ts)
 * and the coordinator's policy engine (structural deny, tested in
 * policy-engine-read-only-workspace.test.ts), so asserting on it here closes
 * the chain from `workspaceAccess: read-only` in a workflow definition to a
 * reviewer that cannot write `/workspace`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IronCurtainConfig } from '../../src/config/types.js';
import type { DockerInfrastructure } from '../../src/docker/docker-infrastructure.js';
import type { DockerAgentSessionDeps } from '../../src/docker/docker-agent-session.js';
import type { BundleId } from '../../src/session/types.js';
import type { WorkflowDefinition, WorkflowId } from '../../src/workflow/types.js';
import * as logger from '../../src/logger.js';
import { WorkflowOrchestrator } from '../../src/workflow/orchestrator.js';
import { createWorkflowSessionFactory } from '../../src/workflow/cli-support.js';
import { createDeps, stubPersonasForTest, waitForCompletion, writeDefinitionFile } from './test-helpers.js';

const mocks = vi.hoisted(() => ({
  createDockerInfrastructure: vi.fn(),
  /** Artifacts each workflow state writes, keyed by state id. */
  outputsByState: new Map<string, readonly string[]>(),
  sessionStates: [] as Array<string | undefined>,
}));

vi.mock('../../src/docker/docker-infrastructure.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/docker-infrastructure.js')>()),
  createDockerInfrastructure: mocks.createDockerInfrastructure,
}));

vi.mock('../../src/docker/docker-agent-session.js', async () => {
  const { MockSession, approvedResponse } = await import('./test-helpers.js');
  class ScriptedDockerAgentSession extends MockSession {
    constructor(deps: DockerAgentSessionDeps) {
      const stateId = deps.metricsStateId;
      const workspace = deps.config.allowedDirectory;
      super({
        responses: () => {
          for (const name of mocks.outputsByState.get(stateId ?? '') ?? []) {
            mkdirSync(join(workspace, '.workflow', name), { recursive: true });
            writeFileSync(join(workspace, '.workflow', name, `${name}.md`), `content for ${name}`);
          }
          return approvedResponse('done');
        },
      });
      mocks.sessionStates.push(stateId);
    }

    async initialize(): Promise<void> {}
  }
  return { DockerAgentSession: ScriptedDockerAgentSession };
});

/** The arguments `createDockerInfrastructure` receives, as far as the stub reads them. */
type CreateInfraArgs = [
  config: IronCurtainConfig,
  mode: unknown,
  bundleDir: string,
  workspaceDir: string,
  escalationDir: string,
  bundleId: BundleId,
  workflowId: WorkflowId | undefined,
  scope: string | undefined,
];

/** A bundle as the real `createDockerInfrastructure` would return it, minus Docker. */
function makeStubBundle(...args: CreateInfraArgs): DockerInfrastructure {
  const [config, , bundleDir, workspaceDir, escalationDir, bundleId, workflowId, scope] = args;
  const conversationStateDir = join(bundleDir, 'conversation-state');
  mkdirSync(conversationStateDir, { recursive: true, mode: 0o700 });
  return {
    bundleId,
    workflowId,
    scope,
    bundleDir,
    workspaceDir,
    // As prepareDockerInfrastructure records it.
    ...(config.readOnlyWorkspace ? { readOnlyWorkspace: config.readOnlyWorkspace } : {}),
    escalationDir,
    auditLogPath: config.auditLogPath,
    conversationStateDir,
    adapter: { id: 'claude-code' },
    systemPrompt: 'You are a test agent.',
    runtimeKind: 'docker',
    setTokenSessionId: () => {},
    beginCaptureSession: () => {},
    endCaptureSession: async () => {},
    restageSkills: () => {},
  } as unknown as DockerInfrastructure;
}

function reviewLoop(settings: WorkflowDefinition['settings'], reviewScope?: string): WorkflowDefinition {
  return {
    name: 'read-only-review-e2e',
    description: 'implement, then a read-only review',
    initial: 'implement',
    settings,
    states: {
      implement: {
        type: 'agent',
        description: 'Implements',
        persona: 'global',
        prompt: 'Write the code.',
        inputs: [],
        outputs: ['code'],
        transitions: [{ to: 'review' }],
      },
      review: {
        type: 'agent',
        description: 'Reviews',
        persona: 'global',
        prompt: 'Review the code.',
        inputs: ['code'],
        outputs: ['reviews'],
        workspaceAccess: 'read-only',
        ...(reviewScope !== undefined ? { containerScope: reviewScope } : {}),
        transitions: [
          { to: 'done', when: { verdict: 'approved' } },
          { to: 'implement', when: { verdict: 'rejected' } },
        ],
      },
      done: { type: 'terminal', description: 'Done' },
    },
  };
}

/** The config of the `createDockerInfrastructure` call for `scope` (shared) or the n-th call (per state). */
function infraConfig(index: number): IronCurtainConfig {
  return (mocks.createDockerInfrastructure.mock.calls[index] as CreateInfraArgs)[0];
}

describe('read-only reviewer through the real default factory and session factory', () => {
  let tmpDir: string;
  let cleanupPersonas: () => void;
  let orchestrator: WorkflowOrchestrator | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'read-only-e2e-'));
    cleanupPersonas = stubPersonasForTest(tmpDir, reviewLoop({}));
    mocks.outputsByState.clear();
    mocks.outputsByState.set('implement', ['code']);
    mocks.outputsByState.set('review', ['reviews']);
    mocks.sessionStates.length = 0;
    mocks.createDockerInfrastructure.mockReset();
    mocks.createDockerInfrastructure.mockImplementation(async (...args: CreateInfraArgs) => makeStubBundle(...args));
    orchestrator = undefined;
  });

  afterEach(async () => {
    await orchestrator?.shutdownAll();
    logger.teardown();
    vi.restoreAllMocks();
    cleanupPersonas();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('builds the reviewer’s own container read-only when states do not share one', async () => {
    orchestrator = new WorkflowOrchestrator(createDeps(tmpDir, { createSession: createWorkflowSessionFactory() }));
    const workflowId = await orchestrator.start(
      writeDefinitionFile(tmpDir, reviewLoop({ mode: 'docker', dockerAgent: 'claude-code' })),
      'task',
    );
    await waitForCompletion(orchestrator, workflowId);
    expect(orchestrator.getStatus(workflowId)?.phase).toBe('completed');

    expect(mocks.sessionStates).toEqual(['implement', 'review']);
    expect(mocks.createDockerInfrastructure).toHaveBeenCalledTimes(2);
    const implement = infraConfig(0);
    const review = infraConfig(1);

    expect(implement.readOnlyWorkspace).toBeUndefined();
    expect(review.readOnlyWorkspace?.writablePaths).toEqual(['.workflow/reviews']);
    // Nested Docker would hand the workspace back read-write.
    expect(review.userConfig.dockerWorkload).toEqual({ enabled: false });
    // The reviewer writes its review through the filesystem server.
    expect(Object.keys(review.mcpServers)).toContain('filesystem');
    // Both ran on the same workspace, which the reviewer's engine resolves its
    // writable directories against.
    expect(review.allowedDirectory).toBe(implement.allowedDirectory);
  });

  it('mints the reviewer scope’s bundle read-only and the coder scope’s read-write', async () => {
    orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        createSession: createWorkflowSessionFactory(),
        // No createWorkflowInfrastructure: the orchestrator's default factory runs.
        destroyWorkflowInfrastructure: vi.fn(async () => {}),
      }),
    );
    const workflowId = await orchestrator.start(
      writeDefinitionFile(
        tmpDir,
        reviewLoop({ mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true }, 'review'),
      ),
      'task',
    );
    await waitForCompletion(orchestrator, workflowId);
    expect(orchestrator.getStatus(workflowId)?.phase).toBe('completed');

    const byScope = new Map(
      mocks.createDockerInfrastructure.mock.calls.map((call) => {
        const [config, , , , , , , scope] = call as CreateInfraArgs;
        return [scope, config];
      }),
    );
    expect([...byScope.keys()].sort()).toEqual(['primary', 'review']);
    expect(byScope.get('primary')?.readOnlyWorkspace).toBeUndefined();
    const review = byScope.get('review');
    expect(review?.readOnlyWorkspace?.writablePaths).toEqual(['.workflow/reviews']);
    expect(review?.userConfig.dockerWorkload).toEqual({ enabled: false });
    expect(Object.keys(review?.mcpServers ?? {})).toContain('filesystem');
    expect(mocks.sessionStates).toEqual(['implement', 'review']);
  });
});
