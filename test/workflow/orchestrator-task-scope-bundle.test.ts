/**
 * Task-scoped shared-container workflows (`workflow start --task-scoped`,
 * WP-119): the DEFAULT bundle factory must hand the run's task scope to the
 * bundle's config. The bundle's coordinator is the only policy engine a
 * shared-container state's tool calls reach (per-state sessions borrow it),
 * so a factory that dropped the scope would run every state unscoped while
 * the per-state sessions still validate it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IronCurtainConfig } from '../../src/config/types.js';
import type { DockerInfrastructure } from '../../src/docker/docker-infrastructure.js';
import type { AgentId } from '../../src/docker/agent-adapter.js';
import type { BundleId } from '../../src/session/types.js';
import type { WorkflowId } from '../../src/workflow/types.js';
import { WorkflowOrchestrator, type CreateWorkflowInfrastructureInput } from '../../src/workflow/orchestrator.js';
import { createDeps, makeTestUserConfig } from './test-helpers.js';

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  createDockerInfrastructure: vi.fn(),
}));

vi.mock('../../src/config/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/config/index.js')>()),
  loadConfig: mocks.loadConfig,
}));

vi.mock('../../src/docker/docker-infrastructure.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/docker-infrastructure.js')>()),
  createDockerInfrastructure: mocks.createDockerInfrastructure,
}));

type DefaultFactoryLoader = {
  loadDefaultInfrastructureFactory(): Promise<
    (input: CreateWorkflowInfrastructureInput) => Promise<DockerInfrastructure>
  >;
};

describe('default workflow bundle factory and the task scope', () => {
  let tempDir: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(join(tmpdir(), 'workflow-task-scope-bundle-'));
    previousHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = join(tempDir, 'home');
    // A fresh config per bundle, as loadConfig() returns in production.
    mocks.loadConfig.mockImplementation(
      () =>
        ({
          auditLogPath: join(tempDir, 'audit.jsonl'),
          allowedDirectory: join(tempDir, 'old-workspace'),
          mcpServers: {},
          protectedPaths: [],
          generatedDir: join(tempDir, 'generated'),
          constitutionPath: join(tempDir, 'constitution.md'),
          agentModelId: 'anthropic:claude-sonnet-4-6',
          escalationTimeoutSeconds: 300,
          userConfig: makeTestUserConfig(),
        }) as IronCurtainConfig,
    );
    mocks.createDockerInfrastructure.mockResolvedValue({ bundleId: 'bundle-1' });
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = previousHome;
    rmSync(tempDir, { recursive: true, force: true });
  });

  function input(taskPolicyDir?: string): CreateWorkflowInfrastructureInput {
    return {
      workflowId: 'workflow-task-scope-1' as WorkflowId,
      bundleId: 'bundle-1' as BundleId,
      agentId: 'claude-code' as AgentId,
      controlSocketPath: join(tempDir, 'control.sock'),
      workspacePath: join(tempDir, 'workspace'),
      scope: 'default',
      requiredServers: new Set(),
      maxLanes: 1,
      ...(taskPolicyDir !== undefined ? { taskPolicyDir } : {}),
    };
  }

  it("sets the run's task scope on the bundle config, so the bundle coordinator enforces it", async () => {
    const orchestrator = new WorkflowOrchestrator(createDeps(tempDir));
    const factory = await (orchestrator as unknown as DefaultFactoryLoader).loadDefaultInfrastructureFactory();
    const scope = join(tempDir, 'home', 'task-policies', 'd'.repeat(64));

    await factory(input(scope));
    await factory(input());

    expect(mocks.createDockerInfrastructure).toHaveBeenCalledTimes(2);
    const [scoped, unscoped] = mocks.createDockerInfrastructure.mock.calls.map((call) => call[0] as IronCurtainConfig);
    expect(scoped.taskPolicyDir).toBe(scope);
    expect(unscoped.taskPolicyDir).toBeUndefined();
  });
});
