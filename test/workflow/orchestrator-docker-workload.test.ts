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
import { resolveDockerWorkloadConfig } from '../../src/docker-workload/config.js';
import { WorkflowCommitChannel } from '../../src/workflow/workflow-commit.js';
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

describe('workflow nested-Docker configuration', () => {
  let tempDir: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(join(tmpdir(), 'workflow-docker-workload-'));
    previousHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = join(tempDir, 'home');
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = previousHome;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('passes the global nested-Docker opt-in to each default workflow bundle', async () => {
    const config = {
      auditLogPath: join(tempDir, 'audit.jsonl'),
      allowedDirectory: join(tempDir, 'old-workspace'),
      mcpServers: {},
      protectedPaths: [],
      generatedDir: join(tempDir, 'generated'),
      constitutionPath: join(tempDir, 'constitution.md'),
      agentModelId: 'anthropic:claude-sonnet-4-6',
      escalationTimeoutSeconds: 300,
      userConfig: makeTestUserConfig({
        dockerWorkload: resolveDockerWorkloadConfig({ enabled: true }),
      }),
    } as IronCurtainConfig;
    const infrastructure = { bundleId: 'bundle-workflow-1' } as unknown as DockerInfrastructure;
    mocks.loadConfig.mockReturnValue(config);
    mocks.createDockerInfrastructure.mockResolvedValue(infrastructure);

    const orchestrator = new WorkflowOrchestrator(createDeps(tempDir));
    const factory = await (orchestrator as unknown as DefaultFactoryLoader).loadDefaultInfrastructureFactory();
    const input: CreateWorkflowInfrastructureInput = {
      workflowId: 'workflow-docker-1' as WorkflowId,
      bundleId: 'bundle-workflow-1' as BundleId,
      agentId: 'claude-code' as AgentId,
      controlSocketPath: join(tempDir, 'control.sock'),
      workspacePath: join(tempDir, 'workspace'),
      scope: 'default',
      requiredServers: new Set(),
      maxLanes: 1,
    };

    await expect(factory(input)).resolves.toBe(infrastructure);
    expect(mocks.createDockerInfrastructure).toHaveBeenCalledOnce();
    const passedConfig = mocks.createDockerInfrastructure.mock.calls[0][0] as IronCurtainConfig;
    expect(passedConfig.userConfig.dockerWorkload).toEqual(resolveDockerWorkloadConfig({ enabled: true }));
    expect(passedConfig.allowedDirectory).toBe(input.workspacePath);
  });

  it("builds each default workflow bundle with the run's effective resource budget", async () => {
    const userConfig = makeTestUserConfig();
    mocks.loadConfig.mockReturnValue({
      auditLogPath: join(tempDir, 'audit.jsonl'),
      mcpServers: {},
      protectedPaths: [],
      userConfig,
    });
    mocks.createDockerInfrastructure.mockResolvedValue({ bundleId: 'bundle-budget' });

    const orchestrator = new WorkflowOrchestrator(createDeps(tempDir));
    const factory = await (orchestrator as unknown as DefaultFactoryLoader).loadDefaultInfrastructureFactory();
    const resourceBudget = { ...userConfig.resourceBudget, maxTotalTokens: 42_000, maxEstimatedCostUsd: 0.5 };
    await factory({
      workflowId: 'workflow-budget' as WorkflowId,
      bundleId: 'bundle-budget' as BundleId,
      agentId: 'claude-code' as AgentId,
      controlSocketPath: join(tempDir, 'control.sock'),
      workspacePath: join(tempDir, 'workspace'),
      scope: 'default',
      requiredServers: new Set(),
      maxLanes: 1,
      resourceBudget,
    });

    // The bundle's budget gate reads its limits from this config.
    const passedConfig = mocks.createDockerInfrastructure.mock.calls[0][0] as IronCurtainConfig;
    expect(passedConfig.userConfig.resourceBudget).toEqual(resourceBudget);
    // The global config object itself is not mutated.
    expect(userConfig.resourceBudget.maxTotalTokens).not.toBe(42_000);
  });

  // WP-117: a resumed run's bundle coordinator replays the earlier legs'
  // bundle audit logs to restore taint (taint escalation enabled).
  it('hands the earlier legs’ bundle audit logs to the bundle config for taint replay', async () => {
    const baseConfig = (): IronCurtainConfig => ({
      auditLogPath: join(tempDir, 'audit.jsonl'),
      allowedDirectory: join(tempDir, 'old-workspace'),
      mcpServers: {},
      protectedPaths: [],
      generatedDir: join(tempDir, 'generated'),
      constitutionPath: join(tempDir, 'constitution.md'),
      agentModelId: 'anthropic:claude-sonnet-4-6',
      escalationTimeoutSeconds: 300,
      userConfig: makeTestUserConfig(),
    });
    mocks.loadConfig.mockImplementation(baseConfig);
    mocks.createDockerInfrastructure.mockResolvedValue({ bundleId: 'bundle-2' });

    const orchestrator = new WorkflowOrchestrator(createDeps(tempDir));
    const factory = await (orchestrator as unknown as DefaultFactoryLoader).loadDefaultInfrastructureFactory();
    const input: CreateWorkflowInfrastructureInput = {
      workflowId: 'workflow-taint-1' as WorkflowId,
      bundleId: 'bundle-2' as BundleId,
      agentId: 'claude-code' as AgentId,
      controlSocketPath: join(tempDir, 'control.sock'),
      workspacePath: join(tempDir, 'workspace'),
      scope: 'primary',
      requiredServers: new Set(),
      maxLanes: 1,
      taintReplayAuditLogPaths: ['/runs/workflow-taint-1/containers/bundle-1/audit.jsonl'],
    };

    await factory(input);
    await factory({ ...input, taintReplayAuditLogPaths: undefined });

    const [resumed, fresh] = mocks.createDockerInfrastructure.mock.calls.map((call) => call[0] as IronCurtainConfig);
    expect(resumed.taintReplayAuditLogPaths).toEqual(['/runs/workflow-taint-1/containers/bundle-1/audit.jsonl']);
    expect(resumed.auditLogPath).toMatch(/containers\/bundle-2\/audit\.jsonl$/);
    expect(fresh.taintReplayAuditLogPaths).toEqual([]);
  });

  it("hands the bundle's workflow_commit channel to the bundle's coordinator", async () => {
    const config = {
      auditLogPath: join(tempDir, 'audit.jsonl'),
      allowedDirectory: join(tempDir, 'old-workspace'),
      mcpServers: {},
      protectedPaths: [],
      generatedDir: join(tempDir, 'generated'),
      constitutionPath: join(tempDir, 'constitution.md'),
      agentModelId: 'anthropic:claude-sonnet-4-6',
      escalationTimeoutSeconds: 300,
      userConfig: makeTestUserConfig(),
    } as IronCurtainConfig;
    const infrastructure = { bundleId: 'bundle-workflow-2' } as unknown as DockerInfrastructure;
    mocks.loadConfig.mockReturnValue(config);
    mocks.createDockerInfrastructure.mockResolvedValue(infrastructure);
    const workflowCommit = new WorkflowCommitChannel();

    const orchestrator = new WorkflowOrchestrator(createDeps(tempDir));
    const factory = await (orchestrator as unknown as DefaultFactoryLoader).loadDefaultInfrastructureFactory();
    await factory({
      workflowId: 'workflow-docker-2' as WorkflowId,
      bundleId: 'bundle-workflow-2' as BundleId,
      agentId: 'claude-code' as AgentId,
      controlSocketPath: join(tempDir, 'control.sock'),
      workspacePath: join(tempDir, 'workspace'),
      scope: 'default',
      requiredServers: new Set(),
      maxLanes: 1,
      workflowCommit,
    });

    // The 12th argument is CreateDockerInfrastructureOptions: without the
    // channel the bundle's coordinator would offer no workflow_commit, and
    // every state borrowing the bundle would fall back to the YAML block.
    const options = mocks.createDockerInfrastructure.mock.calls[0][11] as { workflowCommit?: unknown };
    expect(options.workflowCommit).toBe(workflowCommit);
  });
});
