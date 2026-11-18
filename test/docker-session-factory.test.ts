/**
 * Tests for `createDockerSession()` in `src/session/index.ts`.
 *
 * Covers both standalone and borrow paths. The borrow path (where the
 * caller supplies a pre-built `DockerInfrastructure` via
 * `options.workflow.infrastructure`) is the Step 4 addition for workflow
 * mode: the session must use the supplied bundle as-is and must not
 * destroy it on `close()` -- the caller retains ownership.
 *
 * We mock the infrastructure module so we can observe whether
 * `createDockerInfrastructure` / `destroyDockerInfrastructure` are called,
 * without requiring a real Docker daemon.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeFileSync,
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import * as logger from '../src/logger.js';
import { getSessionDir, getSessionMetadataPath, getSessionsDir, SESSION_LOCK_FILENAME } from '../src/config/paths.js';
import { acquireProcessLock, type ProcessLockHandle } from '../src/docker-workload/process-lock.js';
import { runPrune } from '../src/maintenance/prune.js';
import type { Session } from '../src/session/types.js';

// --- Module mocks (hoisted) ---

// Track calls to the infrastructure lifecycle functions. We expose the
// control surface via dedicated hooks so tests can reconfigure behavior
// per-case (e.g., make claude-md write throw to exercise the error path,
// or return a pre-built bundle for the standalone success path).
const infraState: {
  createCalls: number;
  destroyCalls: number;
  createShouldThrow: boolean | Error;
  // When set, `createDockerInfrastructure` resolves with this bundle,
  // simulating a successful standalone setup so we can drive the factory
  // all the way through to `session.close()` -> destroy on the happy path.
  createReturnValue: unknown;
} = {
  createCalls: 0,
  destroyCalls: 0,
  createShouldThrow: false,
  createReturnValue: undefined,
};

vi.mock('../src/docker/docker-infrastructure.js', async (importOriginal) => ({
  createDockerInfrastructure: vi.fn(async () => {
    infraState.createCalls++;
    if (infraState.createShouldThrow) {
      throw infraState.createShouldThrow instanceof Error
        ? infraState.createShouldThrow
        : new Error('createDockerInfrastructure failure (scripted)');
    }
    if (infraState.createReturnValue !== undefined) {
      return infraState.createReturnValue;
    }
    // Default: no bundle scripted. Tests that want the standalone path to
    // resolve must populate `infraState.createReturnValue` explicitly.
    throw new Error('standalone path not used by these tests');
  }),
  destroyDockerInfrastructure: vi.fn(async () => {
    infraState.destroyCalls++;
    // Nothing found to report (the real teardown resolves with its findings).
    return {};
  }),
  // Not used in our tests but present on the real module.
  prepareDockerInfrastructure: vi.fn(),
  createSessionContainers: vi.fn(),
  prepareConversationStateDir: vi.fn(),
  dockerWorkloadSessionMetadata: (await importOriginal<typeof import('../src/docker/docker-infrastructure.js')>())
    .dockerWorkloadSessionMetadata,
}));

// Mock claude-md-seed so every session has CLAUDE.md content to seed, which
// lets the error-path test make the seeding throw (by pointing
// conversationStateDir at a non-existent directory). The agent-writable
// state-dir tests below swap in the real builder for one call, driven by a
// real memory-enabled persona.
vi.mock('../src/docker/claude-md-seed.js', () => ({
  buildDockerClaudeMd: vi.fn(() => 'test claude md content'),
}));

// Stub DockerAgentSession's dynamic-import target. We need the real
// implementation because the factory constructs it and calls initialize().
// Do NOT mock this module -- the real DockerAgentSession wires up the
// escalation watcher + audit tailer against the infra's paths, which is
// what we want to verify.

// --- Imports (after mocks are set up) ---

import { createSession } from '../src/session/index.js';
import type { IronCurtainConfig } from '../src/config/types.js';
import type { DockerInfrastructure } from '../src/docker/docker-infrastructure.js';
import type { AgentId } from '../src/docker/agent-adapter.js';
import { createDockerInfrastructure, destroyDockerInfrastructure } from '../src/docker/docker-infrastructure.js';
import { buildDockerClaudeMd } from '../src/docker/claude-md-seed.js';
import { createAgentConversationId } from '../src/session/types.js';
import { loadSessionMetadata } from '../src/session/session-metadata.js';
import { resolveDockerWorkloadConfig } from '../src/docker-workload/config.js';
import {
  buildRuntimeWatchdogPolicy,
  loadFrozenWatchdogPolicyTemplate,
} from '../src/docker-workload/watchdog-policy.js';
import { resolve } from 'node:path';
import {
  createMockAdapter,
  createMockCA,
  createMockDocker,
  createMockMitmProxy,
  createMockProxy,
} from './helpers/docker-mocks.js';
import { writePersonaPolicy } from './fixtures/scoped-policy.js';

// --- Helpers ---

const TEST_HOME = `/tmp/ironcurtain-docker-factory-test-${process.pid}`;

function createTestConfig(options: { readonly memoryEnabled?: boolean } = {}): IronCurtainConfig {
  return {
    auditLogPath: './audit.jsonl',
    allowedDirectory: `${TEST_HOME}/sandbox`,
    mcpServers: {},
    protectedPaths: [],
    generatedDir: `${TEST_HOME}/generated`,
    constitutionPath: `${TEST_HOME}/constitution.md`,
    agentModelId: 'anthropic:claude-sonnet-4-6',
    escalationTimeoutSeconds: 300,
    userConfig: {
      agentModelId: 'anthropic:claude-sonnet-4-6',
      policyModelId: 'anthropic:claude-sonnet-4-6',
      anthropicApiKey: 'test-api-key',
      googleApiKey: '',
      openaiApiKey: '',
      escalationTimeoutSeconds: 300,
      resourceBudget: {
        maxTotalTokens: 1_000_000,
        maxSteps: 200,
        maxSessionSeconds: 1800,
        maxEstimatedCostUsd: 5.0,
        warnThresholdPercent: 80,
      },
      autoCompact: {
        enabled: false,
        thresholdTokens: 80_000,
        keepRecentMessages: 10,
        summaryModelId: 'anthropic:claude-haiku-4-5',
      },
      autoApprove: { enabled: false, modelId: 'anthropic:claude-haiku-4-5' },
      auditRedaction: { enabled: true },
      memory: { enabled: options.memoryEnabled ?? false, llmBaseUrl: undefined, llmApiKey: undefined },
      dockerResources: { memoryMb: null, cpus: null },
      modelProviders: { default: 'native', profiles: { native: { type: 'native' } } },
    },
  } as unknown as IronCurtainConfig;
}

/**
 * Builds a mock DockerInfrastructure bundle suitable for the borrow path.
 * The directories on the bundle must exist so DockerAgentSession.initialize()
 * can write system-prompt.txt and start the escalation watcher against them.
 * The adapter id defaults to Claude Code, matching the `agent` these tests
 * request: only a Claude Code bundle gets CLAUDE.md seeded.
 */
function createMockInfra(rootDir: string, idSuffix = 'borrow', adapterId = 'claude-code'): DockerInfrastructure {
  const sessionDir = join(rootDir, `infra-${idSuffix}`);
  const sandboxDir = join(sessionDir, 'sandbox');
  const escalationDir = join(sessionDir, 'escalations');
  const auditLogPath = join(sessionDir, 'audit.jsonl');
  const conversationStateDir = join(sessionDir, 'conversation-state');
  const orientationDir = join(sessionDir, 'orientation');
  const socketsDir = join(sessionDir, 'sockets');

  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(sandboxDir, { recursive: true });
  mkdirSync(escalationDir, { recursive: true });
  mkdirSync(conversationStateDir, { recursive: true });
  mkdirSync(orientationDir, { recursive: true });
  mkdirSync(socketsDir, { recursive: true });
  writeFileSync(auditLogPath, '');

  return {
    bundleId: `infra-${idSuffix}` as import('../src/session/types.js').BundleId,
    bundleDir: sessionDir,
    workspaceDir: sandboxDir,
    escalationDir,
    auditLogPath,
    proxy: createMockProxy(join(sessionDir, 'proxy.sock')),
    mitmProxy: createMockMitmProxy(),
    docker: createMockDocker(),
    adapter: { ...createMockAdapter(), id: adapterId as AgentId },
    ca: createMockCA(rootDir),
    fakeKeys: new Map([['api.test.com', 'sk-test-fake']]),
    orientationDir,
    systemPrompt: 'You are a borrowed test agent.',
    image: 'ironcurtain-claude-code:latest',
    runtimeKind: 'docker',
    topology: 'uds',
    useTcp: false,
    socketsDir,
    mitmAddr: { socketPath: '/tmp/test-mitm-proxy.sock' },
    metricsProxyUrl: 'http://127.0.0.1:18080',
    authKind: 'apikey',
    providerProfileId: 'native',
    conversationStateDir,
    conversationStateConfig: undefined,
    containerId: 'container-borrowed-abc123',
    containerName: 'ironcurtain-borrowed',
    sidecarContainerId: undefined,
    internalNetwork: undefined,
    setTokenSessionId: () => {},
    restageSkills: () => {},
    beginCaptureSession: () => {},
    endCaptureSession: async () => {},
  };
}

// --- Tests ---

describe('createDockerSession borrow path', () => {
  let originalHome: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    originalHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = TEST_HOME;
    mkdirSync(TEST_HOME, { recursive: true });

    tempDir = join(TEST_HOME, `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tempDir, { recursive: true });

    // Reset mock call counters each test
    infraState.createCalls = 0;
    infraState.destroyCalls = 0;
    infraState.createShouldThrow = false;
    infraState.createReturnValue = undefined;
    vi.mocked(createDockerInfrastructure).mockClear();
    vi.mocked(destroyDockerInfrastructure).mockClear();
  });

  afterEach(() => {
    logger.teardown();
    if (originalHome !== undefined) {
      process.env.IRONCURTAIN_HOME = originalHome;
    } else {
      delete process.env.IRONCURTAIN_HOME;
    }
    if (existsSync(TEST_HOME)) {
      rmSync(TEST_HOME, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it('basic borrow: session uses the caller-supplied bundle, does NOT call createDockerInfrastructure', async () => {
    const infra = createMockInfra(tempDir, 'basic');

    const session = await createSession({
      config: createTestConfig(),
      mode: { kind: 'docker', agent: 'claude-code' as never },
      workflow: { infrastructure: infra },
      agentConversationId: createAgentConversationId(),
    });

    try {
      // Factory must have skipped its own infra creation entirely.
      expect(vi.mocked(createDockerInfrastructure)).not.toHaveBeenCalled();
      expect(infraState.createCalls).toBe(0);

      // Session is fully wired: status is ready and the bundle's system
      // prompt was written to the infra session dir for debugging.
      expect(session.getInfo().status).toBe('ready');
      expect(existsSync(join(infra.bundleDir, 'system-prompt.txt'))).toBe(true);

      // CLAUDE.md was seeded into the bundle's conversation-state dir.
      expect(existsSync(join(infra.conversationStateDir as string, 'CLAUDE.md'))).toBe(true);
    } finally {
      await session.close();
    }
  });

  it('borrow with workflow.stateDir: creates zero entries under sessions/', async () => {
    // When the orchestrator passes a per-state artifact dir alongside
    // the bundle, the factory must route session.log and metadata into
    // that dir instead of under ~/.ironcurtain/sessions/<uuid>/. This
    // is the core invariant of the workflow-scoped artifact plan.
    const infra = createMockInfra(tempDir, 'state-dir');
    const workflowStateDir = join(tempDir, 'workflow-state', 'fetch.1');
    mkdirSync(workflowStateDir, { recursive: true });

    // Sanity: sessions dir is empty at test start.
    const sessionsDir = getSessionsDir();
    const pre = existsSync(sessionsDir) ? readdirSync(sessionsDir) : [];

    const session = await createSession({
      config: createTestConfig(),
      mode: { kind: 'docker', agent: 'claude-code' as never },
      workflow: { infrastructure: infra, stateDir: workflowStateDir, stateSlug: 'fetch.1' },
      agentConversationId: createAgentConversationId(),
    });

    try {
      // No new entries under ~/.ironcurtain/sessions/
      const post = existsSync(sessionsDir) ? readdirSync(sessionsDir) : [];
      expect(post).toEqual(pre);

      // session.log + session-metadata.json landed in the state dir.
      expect(existsSync(join(workflowStateDir, 'session.log'))).toBe(true);
      expect(existsSync(join(workflowStateDir, 'session-metadata.json'))).toBe(true);
      const meta = JSON.parse(readFileSync(join(workflowStateDir, 'session-metadata.json'), 'utf-8'));
      expect(meta.createdAt).toBeDefined();
    } finally {
      await session.close();
    }
  });

  it('rejects a workflow ID that disagrees with borrowed infrastructure', async () => {
    const infra = {
      ...createMockInfra(tempDir, 'workflow-mismatch'),
      workflowId: 'workflow-a',
    } as DockerInfrastructure;
    const borrowedClaudeMd = join(infra.conversationStateDir!, 'CLAUDE.md');
    writeFileSync(borrowedClaudeMd, 'borrowed workflow sentinel');

    await expect(
      createSession({
        config: createTestConfig(),
        mode: { kind: 'docker', agent: 'claude-code' as never },
        workflow: {
          infrastructure: infra,
          workflowRunId: 'workflow-b' as import('../src/workflow/types.js').WorkflowId,
        },
        agentConversationId: createAgentConversationId(),
      }),
    ).rejects.toThrow(/workflow run ID does not match/);
    expect(readFileSync(borrowedClaudeMd, 'utf8')).toBe('borrowed workflow sentinel');
  });

  it('workflow.stateDir without workflow.infrastructure is rejected', async () => {
    const workflowStateDir = join(tempDir, 'orphan-state');
    mkdirSync(workflowStateDir, { recursive: true });

    await expect(
      createSession({
        config: createTestConfig(),
        mode: { kind: 'docker', agent: 'claude-code' as never },
        // Deliberately omit infrastructure inside the workflow record.
        workflow: { stateDir: workflowStateDir, stateSlug: 'orphan.1' },
        agentConversationId: createAgentConversationId(),
      }),
    ).rejects.toThrow(/workflow\.stateDir requires workflow\.infrastructure/);
  });

  it('close preserves bundle: destroyDockerInfrastructure is NOT invoked', async () => {
    const infra = createMockInfra(tempDir, 'preserve');

    const session = await createSession({
      config: createTestConfig(),
      mode: { kind: 'docker', agent: 'claude-code' as never },
      workflow: { infrastructure: infra },
      agentConversationId: createAgentConversationId(),
    });

    await session.close();

    // Bundle is the caller's responsibility; factory + session must not
    // have torn it down. (Real implementation: DockerAgentSession.close()
    // only calls destroyDockerInfrastructure when ownsInfra=true.)
    expect(vi.mocked(destroyDockerInfrastructure)).not.toHaveBeenCalled();
    expect(infraState.destroyCalls).toBe(0);
  });

  it('bundle reusable across multiple sessions (workflow state transitions)', async () => {
    const infra = createMockInfra(tempDir, 'reuse');

    // First session: borrow, run, close. Bundle stays alive.
    const session1 = await createSession({
      config: createTestConfig(),
      mode: { kind: 'docker', agent: 'claude-code' as never },
      workflow: { infrastructure: infra },
      agentConversationId: createAgentConversationId(),
    });
    expect(session1.getInfo().status).toBe('ready');
    await session1.close();
    expect(infraState.destroyCalls).toBe(0);

    // Second session with the *same* bundle: this is the actual workflow
    // use case -- multiple states share the same container.
    const session2 = await createSession({
      config: createTestConfig(),
      mode: { kind: 'docker', agent: 'claude-code' as never },
      workflow: { infrastructure: infra },
      agentConversationId: createAgentConversationId(),
    });
    try {
      expect(session2.getInfo().status).toBe('ready');
      // Still no factory-driven infra creation or destruction on either session.
      expect(infraState.createCalls).toBe(0);
      expect(infraState.destroyCalls).toBe(0);
    } finally {
      await session2.close();
    }

    // After both sessions have closed, the bundle is still alive.
    expect(infraState.destroyCalls).toBe(0);
  });

  it('standalone path (regression): factory calls createDockerInfrastructure when workflow.infrastructure is absent', async () => {
    // In the standalone path the factory is expected to call
    // createDockerInfrastructure. Our mock for that function is scripted
    // to throw (see the module mock at top of file) because we do not
    // want to spin up a full bundle here -- this test only verifies the
    // branching, not a successful end-to-end standalone session.
    await expect(
      createSession({
        config: createTestConfig(),
        mode: { kind: 'docker', agent: 'claude-code' as never },
        // workflow record intentionally omitted.
        agentConversationId: createAgentConversationId(),
      }),
    ).rejects.toThrow(/standalone path not used/);

    expect(vi.mocked(createDockerInfrastructure)).toHaveBeenCalledTimes(1);
    expect(infraState.createCalls).toBe(1);

    // Even though the standalone factory threw, we did not allocate a
    // bundle (the mock throws before returning), so destroy must not run.
    expect(infraState.destroyCalls).toBe(0);
  });

  it("standalone path hands a workflow state's commit target to the bundle it creates", async () => {
    const workflowCommit = { attach: vi.fn(), commit: vi.fn() };
    await expect(
      createSession({
        config: createTestConfig(),
        mode: { kind: 'docker', agent: 'claude-code' as never },
        agentConversationId: createAgentConversationId(),
        workflow: { stateId: 'review', workflowCommit },
      }),
    ).rejects.toThrow(/standalone path not used/);

    // The 12th argument is CreateDockerInfrastructureOptions: the bundle's
    // coordinator offers workflow_commit with this target.
    expect(vi.mocked(createDockerInfrastructure).mock.calls[0][11]).toEqual({ workflowCommit });
  });

  it('error-path cleanup: borrow path does NOT destroy the caller bundle when session setup fails', async () => {
    // Point conversationStateDir at a non-existent location so seeding
    // CLAUDE.md throws mid-setup. This exercises the catch block on the
    // borrow branch: the factory must NOT call destroyDockerInfrastructure
    // on the caller's bundle.
    const infra = createMockInfra(tempDir, 'error');
    const brokenInfra: DockerInfrastructure = {
      ...infra,
      conversationStateDir: join(tempDir, 'does', 'not', 'exist'),
    };

    await expect(
      createSession({
        config: createTestConfig(),
        mode: { kind: 'docker', agent: 'claude-code' as never },
        workflow: { infrastructure: brokenInfra },
        agentConversationId: createAgentConversationId(),
      }),
    ).rejects.toThrow();

    // The factory must not call createDockerInfrastructure (borrow path)...
    expect(vi.mocked(createDockerInfrastructure)).not.toHaveBeenCalled();
    // ...and it MUST NOT destroy the caller's bundle on the failure path.
    expect(vi.mocked(destroyDockerInfrastructure)).not.toHaveBeenCalled();
    expect(infraState.destroyCalls).toBe(0);
  });

  it('post-construction failure in borrow mode: session.close() must NOT tear down the caller bundle', async () => {
    // The sibling error-path test above fires BEFORE the DockerAgentSession
    // is constructed (CLAUDE.md write throws). This test fires AFTER
    // construction: the session exists, but `session.initialize()` throws
    // because `escalationDir` points at a regular file so the mkdirSync
    // inside initialize() fails with ENOTDIR. The factory's catch block
    // must take the `if (session)` branch and call `session.close()` --
    // which, because `ownsInfra=false` for borrow mode, must leave the
    // caller's docker/proxy resources untouched. The `builtInfra && infra`
    // fallback branch must NOT run.
    const infra = createMockInfra(tempDir, 'post-construct');

    // Replace escalationDir with a path that exists as a FILE. mkdirSync
    // with recursive:true throws ENOTDIR/EEXIST in that case, surfacing
    // from inside initialize() after the session is constructed.
    const escalationAsFile = join(tempDir, 'escalation-as-file.txt');
    writeFileSync(escalationAsFile, 'not a directory');

    // Wrap the mock docker/proxy/mitm so we can assert they were NOT
    // invoked if the factory accidentally tore down the borrowed bundle.
    const teardownCounts = { dockerStop: 0, dockerRemove: 0, proxyStop: 0, mitmStop: 0 };
    const borrowedInfra: DockerInfrastructure = {
      ...infra,
      escalationDir: escalationAsFile,
      docker: {
        ...infra.docker,
        async stop(id: string) {
          teardownCounts.dockerStop++;
          await infra.docker.stop(id);
        },
        async remove(id: string) {
          teardownCounts.dockerRemove++;
          await infra.docker.remove(id);
        },
      },
      proxy: {
        ...infra.proxy,
        async stop() {
          teardownCounts.proxyStop++;
          await infra.proxy.stop();
        },
      },
      mitmProxy: {
        ...infra.mitmProxy,
        async stop() {
          teardownCounts.mitmStop++;
          await infra.mitmProxy.stop();
        },
      },
    };

    await expect(
      createSession({
        config: createTestConfig(),
        mode: { kind: 'docker', agent: 'claude-code' as never },
        workflow: { infrastructure: borrowedInfra },
        agentConversationId: createAgentConversationId(),
      }),
    ).rejects.toThrow();

    // Borrow path: factory did not build the bundle, so it must not
    // call createDockerInfrastructure.
    expect(vi.mocked(createDockerInfrastructure)).not.toHaveBeenCalled();

    // Post-construction path: session.close() ran via the `if (session)`
    // branch, but `ownsInfra=false` so destroyDockerInfrastructure must
    // not have been invoked and the mock docker/proxy resources must
    // remain untouched.
    expect(vi.mocked(destroyDockerInfrastructure)).not.toHaveBeenCalled();
    expect(infraState.destroyCalls).toBe(0);
    expect(teardownCounts.dockerStop).toBe(0);
    expect(teardownCounts.dockerRemove).toBe(0);
    expect(teardownCounts.proxyStop).toBe(0);
    expect(teardownCounts.mitmStop).toBe(0);
  });

  it('standalone batch persists complete workload configuration through the shared metadata factory', async () => {
    const configuration = resolveDockerWorkloadConfig(
      { enabled: true, networkAccess: 'packages' },
      { memoryMb: 8192, cpus: 4 },
    );
    const watchdogPolicy = buildRuntimeWatchdogPolicy(
      loadFrozenWatchdogPolicyTemplate(resolve('config/docker-workload/resource-watchdog-policy.json')),
      'docker',
      { root: '/state', device: 1, inode: 2 },
    );
    const builtBundle = {
      ...createMockInfra(tempDir, 'standalone-workload'),
      runtimeKind: 'docker' as const,
      dockerWorkload: {
        leaseId: 'lease-batch',
        generation: 'generation-batch',
        loadedPolicy: { policy: watchdogPolicy },
      } as unknown as NonNullable<DockerInfrastructure['dockerWorkload']>,
    };
    infraState.createReturnValue = builtBundle;
    const baseConfig = createTestConfig();
    const session = await createSession({
      config: { ...baseConfig, userConfig: { ...baseConfig.userConfig, dockerWorkload: configuration } },
      mode: { kind: 'docker', agent: 'claude-code' as never },
      agentConversationId: createAgentConversationId(),
    });
    try {
      expect(loadSessionMetadata(session.getInfo().id)?.dockerWorkload).toEqual({
        leaseId: 'lease-batch',
        generation: 'generation-batch',
        configuration,
        watchdogPolicy,
        backend: 'docker',
      });
    } finally {
      await session.close();
    }
  });

  it('standalone success path: session.close() destroys the factory-owned bundle', async () => {
    // Complement to the standalone-regression test above (which mocks
    // createDockerInfrastructure to THROW, proving the branching but not
    // the happy-path teardown). Here we hand the mock a real bundle so
    // createDockerSession drives all the way through to a ready session,
    // then assert that session.close() invokes destroyDockerInfrastructure
    // with that same bundle -- the ownership contract for standalone mode.
    //
    // Note: DockerAgentSession.close() itself calls destroyDockerInfrastructure
    // when ownsInfra=true; `docker-session.test.ts` exercises that at the
    // class level. This test is the factory-level twin: the factory sets
    // ownsInfra=true on the standalone path, and the session honors it.
    const builtBundle = createMockInfra(tempDir, 'standalone-success');
    infraState.createReturnValue = builtBundle;

    const session = await createSession({
      config: createTestConfig(),
      mode: { kind: 'docker', agent: 'claude-code' as never },
      // workflow record intentionally omitted -- standalone path.
      agentConversationId: createAgentConversationId(),
    });

    // Factory consulted createDockerInfrastructure exactly once.
    expect(vi.mocked(createDockerInfrastructure)).toHaveBeenCalledTimes(1);
    expect(infraState.createCalls).toBe(1);
    expect(session.getInfo().status).toBe('ready');
    // Nothing should have been torn down yet.
    expect(vi.mocked(destroyDockerInfrastructure)).not.toHaveBeenCalled();

    await session.close();

    // Standalone close() must destroy the bundle it owns, exactly once,
    // with the same reference the factory built.
    expect(vi.mocked(destroyDockerInfrastructure)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(destroyDockerInfrastructure)).toHaveBeenCalledWith(builtBundle);
    expect(infraState.destroyCalls).toBe(1);
  });
});

// --- One running process per session directory (resume.lock) ---

describe('standalone container sessions claim their session directory', () => {
  // A standalone container session, fresh or resumed, holds
  // sessions/<id>/resume.lock (src/session/session-lock.ts) from start-up
  // until its bundle is torn down, as builtin and PTY sessions do. Without
  // it a second `--resume` (or a resume of the session while it still runs)
  // shares its sandbox, escalation directory and agent conversation state,
  // and prune does not see the resumed session as live.
  const mode = { kind: 'docker', agent: 'claude-code' as never } as const;
  const held: ProcessLockHandle[] = [];
  let originalHome: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    originalHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = TEST_HOME;
    tempDir = join(TEST_HOME, `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tempDir, { recursive: true });
    infraState.createCalls = 0;
    infraState.destroyCalls = 0;
    infraState.createShouldThrow = false;
    infraState.createReturnValue = undefined;
    vi.mocked(createDockerInfrastructure).mockClear();
    vi.mocked(destroyDockerInfrastructure).mockClear();
  });

  afterEach(() => {
    for (const lock of held.splice(0)) lock.release();
    logger.teardown();
    if (originalHome !== undefined) {
      process.env.IRONCURTAIN_HOME = originalHome;
    } else {
      delete process.env.IRONCURTAIN_HOME;
    }
    if (existsSync(TEST_HOME)) {
      rmSync(TEST_HOME, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  /** Starts a standalone session (a resume of `resumeSessionId`, if given) on a fresh mock bundle. */
  function startStandalone(bundle: string, resumeSessionId?: string): Promise<Session> {
    infraState.createReturnValue = createMockInfra(tempDir, bundle);
    return createSession({
      config: createTestConfig(),
      mode,
      agentConversationId: createAgentConversationId(),
      ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
    });
  }

  function lockPath(sessionId: string): string {
    return join(getSessionDir(sessionId), SESSION_LOCK_FILENAME);
  }

  /** The id of a container session that ran and ended (its directory and metadata exist). */
  async function endedSessionId(): Promise<string> {
    const session = await startStandalone('first');
    const id = session.getInfo().id;
    await session.close();
    vi.mocked(createDockerInfrastructure).mockClear();
    vi.mocked(destroyDockerInfrastructure).mockClear();
    return id;
  }

  it('refuses to resume a session another live process holds, before building anything', async () => {
    const id = await endedSessionId();
    held.push(acquireProcessLock(lockPath(id)));

    await expect(startStandalone('second', id)).rejects.toMatchObject({
      code: 'SESSION_INIT_FAILED',
      message: expect.stringContaining(`Cannot resume session "${id}": it is already in use by a running session`),
    });
    expect(vi.mocked(createDockerInfrastructure)).not.toHaveBeenCalled();
  });

  it('refuses a second concurrent resume until the first one closes', async () => {
    const id = await endedSessionId();

    const resumed = await startStandalone('resumed', id);
    try {
      expect(existsSync(lockPath(id))).toBe(true);
      await expect(startStandalone('second', id)).rejects.toMatchObject({
        code: 'SESSION_INIT_FAILED',
        message: expect.stringContaining('already in use by a running session'),
      });
      // Only the first resume built a bundle.
      expect(vi.mocked(createDockerInfrastructure)).toHaveBeenCalledTimes(1);
    } finally {
      await resumed.close();
    }
    expect(existsSync(lockPath(id))).toBe(false);

    const again = await startStandalone('again', id);
    await again.close();
  });

  it('holds the claim of a fresh session until its bundle is torn down', async () => {
    const session = await startStandalone('fresh');
    const id = session.getInfo().id;
    let heldDuringTeardown: boolean | undefined;
    try {
      expect(existsSync(lockPath(id))).toBe(true);
      // The session is still running: a resume of it is refused.
      await expect(startStandalone('resume-live', id)).rejects.toThrow(/already in use by a running session/);
      vi.mocked(destroyDockerInfrastructure).mockImplementationOnce(async () => {
        heldDuringTeardown = existsSync(lockPath(id));
        return {};
      });
    } finally {
      await session.close();
    }
    expect(heldDuringTeardown).toBe(true);
    expect(existsSync(lockPath(id))).toBe(false);
  });

  it('releases the claim when the session fails to start', async () => {
    const id = await endedSessionId();
    infraState.createShouldThrow = new Error('scripted infrastructure failure');

    await expect(startStandalone('failing', id)).rejects.toThrow(/scripted infrastructure failure/);
    expect(existsSync(lockPath(id))).toBe(false);

    infraState.createShouldThrow = false;
    const resumed = await startStandalone('after-failure', id);
    await resumed.close();
  });

  it('releases the claim when a constructed session fails to initialize, after its bundle is torn down', async () => {
    const id = await endedSessionId();
    // initialize() creates the escalation directory, which fails on a file.
    const bundle = createMockInfra(tempDir, 'broken');
    const escalationAsFile = join(tempDir, 'escalation-as-file.txt');
    writeFileSync(escalationAsFile, 'not a directory');
    infraState.createReturnValue = { ...bundle, escalationDir: escalationAsFile };
    let heldDuringTeardown: boolean | undefined;
    vi.mocked(destroyDockerInfrastructure).mockImplementationOnce(async () => {
      heldDuringTeardown = existsSync(lockPath(id));
      return {};
    });

    await expect(
      createSession({
        config: createTestConfig(),
        mode,
        agentConversationId: createAgentConversationId(),
        resumeSessionId: id,
      }),
    ).rejects.toMatchObject({ code: 'SESSION_INIT_FAILED' });

    expect(heldDuringTeardown).toBe(true);
    expect(existsSync(lockPath(id))).toBe(false);
  });

  it('refuses to resume a session whose directory does not exist, and creates none', async () => {
    await expect(startStandalone('missing', 'no-such-session')).rejects.toMatchObject({
      code: 'SESSION_INIT_FAILED',
      message: expect.stringContaining('Cannot resume session "no-such-session": session directory not found'),
    });
    expect(vi.mocked(createDockerInfrastructure)).not.toHaveBeenCalled();
    expect(existsSync(getSessionDir('no-such-session'))).toBe(false);
  });

  it('refuses to resume a session whose metadata cannot be used, before claiming or building anything', async () => {
    const id = await endedSessionId();
    const metadataPath = getSessionMetadataPath(id);
    const metadata = readFileSync(metadataPath, 'utf-8');
    // A truncated write.
    writeFileSync(metadataPath, '{');

    await expect(startStandalone('damaged', id)).rejects.toMatchObject({
      code: 'SESSION_INIT_FAILED',
      message: expect.stringContaining(metadataPath),
    });
    expect(vi.mocked(createDockerInfrastructure)).not.toHaveBeenCalled();
    expect(existsSync(lockPath(id))).toBe(false);

    writeFileSync(metadataPath, metadata);
    const resumed = await startStandalone('repaired', id);
    await resumed.close();
  });

  it('keeps a running resumed session from prune, however long it looks idle', async () => {
    const id = await endedSessionId();
    const resumed = await startStandalone('resumed-idle', id);
    try {
      const report = await runPrune({
        dryRun: false,
        // The resumed session's owner lease names its new runtime ID, not the
        // session's, so only its claim on the directory says it is live.
        listLeaseBundles: () => ({ bundleIds: new Set([resumed.getInfo().id]), unreadable: 0 }),
        // Ninety days on, everything in the session directory looks idle.
        now: () => Date.now() + 90 * 24 * 60 * 60 * 1000,
      });
      expect(existsSync(getSessionDir(id))).toBe(true);
      expect(report.kept.find((item) => item.id === id)?.reason).toMatch(/a running session holds it \(pid \d+\)/);
    } finally {
      await resumed.close();
    }
  });

  it('a session on a borrowed workflow bundle takes no claim', async () => {
    const infra = createMockInfra(tempDir, 'borrowed');
    const session = await createSession({
      config: createTestConfig(),
      mode,
      workflow: { infrastructure: infra },
      agentConversationId: createAgentConversationId(),
    });
    try {
      expect(readdirSync(infra.bundleDir)).not.toContain(SESSION_LOCK_FILENAME);
    } finally {
      await session.close();
    }
  });
});

// --- CLAUDE.md in the agent-writable conversation-state dir ---

/**
 * Writes a persona with no `memory` field (memory on by default, subject to
 * the global switch) and a minimal compiled policy under TEST_HOME. The rule
 * escalates: an unconditioned `allow` would grant broad access, which
 * `resolvePersona` refuses for a persona without the broad-policy opt-in.
 */
function createMemoryPersonaOnDisk(name: string): void {
  const personaDir = join(TEST_HOME, 'personas', name);
  mkdirSync(join(personaDir, 'generated'), { recursive: true });
  mkdirSync(join(personaDir, 'workspace'), { recursive: true });
  writeFileSync(
    join(personaDir, 'persona.json'),
    JSON.stringify({ name, description: `Test persona ${name}`, createdAt: '2026-11-07T00:00:00.000Z' }),
  );
  writePersonaPolicy(personaDir, {
    rules: [
      {
        name: 'escalate-fs',
        description: 'test',
        principle: 'test',
        if: { server: ['filesystem'] },
        then: 'escalate',
        reason: 'test',
      },
    ],
  });
}

/** Bytes waiting in a FIFO opened non-blocking for reading (0 when nothing was written). */
function pendingFifoBytes(reader: number): number {
  try {
    return readSync(reader, Buffer.alloc(64 * 1024), 0, 64 * 1024, null);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EAGAIN') return 0;
    throw error;
  }
}

describe('createDockerSession: CLAUDE.md in the agent-writable conversation-state dir', () => {
  // The conversation-state dir is the agent's read-write ~/.claude/ mount, so
  // whatever an earlier agent left at CLAUDE.md is untrusted: a resumed
  // standalone session finds what its previous run planted there, and the next
  // workflow state on a shared container finds what an earlier state planted.
  // Session start must replace that entry (memory on) or unlink it (memory
  // off), and never write through it, create its target, or block on it.
  const PERSONA = 'researcher';
  const PERSONA_LINE = `You are operating as the "${PERSONA}" persona.`;
  let originalHome: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    originalHome = process.env.IRONCURTAIN_HOME;
    process.env.IRONCURTAIN_HOME = TEST_HOME;
    tempDir = join(TEST_HOME, `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tempDir, { recursive: true });
    createMemoryPersonaOnDisk(PERSONA);
    infraState.createCalls = 0;
    infraState.destroyCalls = 0;
    infraState.createShouldThrow = false;
    infraState.createReturnValue = undefined;
    vi.mocked(destroyDockerInfrastructure).mockClear();
  });

  afterEach(() => {
    logger.teardown();
    // Drop any unused one-shot real builder so later tests see the file-level mock.
    vi.mocked(buildDockerClaudeMd).mockReset();
    if (originalHome !== undefined) {
      process.env.IRONCURTAIN_HOME = originalHome;
    } else {
      delete process.env.IRONCURTAIN_HOME;
    }
    if (existsSync(TEST_HOME)) {
      rmSync(TEST_HOME, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  /**
   * Starts and closes one session for `persona` (undefined: no persona, so
   * memory is off) with the global memory switch on and the real memory gate
   * and CLAUDE.md builder. `'borrow'` runs it as a workflow state on the
   * shared-container bundle `infra`; `'standalone'` runs a standalone session
   * whose (mocked) factory builds `infra`.
   */
  async function runSession(
    infra: DockerInfrastructure,
    persona: string | undefined,
    how: 'standalone' | 'borrow',
  ): Promise<void> {
    const actualSeed = await vi.importActual<typeof import('../src/docker/claude-md-seed.js')>(
      '../src/docker/claude-md-seed.js',
    );
    vi.mocked(buildDockerClaudeMd).mockImplementationOnce(actualSeed.buildDockerClaudeMd);
    if (how === 'standalone') infraState.createReturnValue = infra;
    const session = await createSession({
      config: createTestConfig({ memoryEnabled: true }),
      mode: { kind: 'docker', agent: 'claude-code' as never },
      ...(persona !== undefined ? { persona } : {}),
      ...(how === 'borrow' ? { workflow: { infrastructure: infra } } : {}),
      agentConversationId: createAgentConversationId(),
    });
    await session.close();
  }

  function claudeMdPath(infra: DockerInfrastructure): string {
    return join(infra.conversationStateDir as string, 'CLAUDE.md');
  }

  function expectSeededRegularFile(infra: DockerInfrastructure): void {
    expect(lstatSync(claudeMdPath(infra)).isFile()).toBe(true);
    expect(readFileSync(claudeMdPath(infra), 'utf8').startsWith(PERSONA_LINE)).toBe(true);
  }

  function expectNoClaudeMd(infra: DockerInfrastructure): void {
    expect(lstatSync(claudeMdPath(infra), { throwIfNoEntry: false })).toBeUndefined();
  }

  // A standalone session spawns the memory server from its own config, so a
  // memory-enabled persona gets the memory protocol seeded.
  describe('standalone session, memory-enabled persona: seeds CLAUDE.md', () => {
    const runState = (infra: DockerInfrastructure): Promise<void> => runSession(infra, PERSONA, 'standalone');

    it('replaces an absolute symlink and leaves its target untouched', async () => {
      const infra = createMockInfra(tempDir, 'abs-link');
      const victim = join(tempDir, 'victim-home', '.ssh', 'authorized_keys');
      mkdirSync(join(tempDir, 'victim-home', '.ssh'), { recursive: true });
      writeFileSync(victim, 'ssh-ed25519 AAAA original\n');
      symlinkSync(victim, claudeMdPath(infra));

      await runState(infra);

      expect(readFileSync(victim, 'utf8')).toBe('ssh-ed25519 AAAA original\n');
      expectSeededRegularFile(infra);
    });

    it('replaces a relative symlink that resolves against the host bundle dir', async () => {
      // The state dir is <tempDir>/infra-rel-link/conversation-state, so
      // ../audit.jsonl is the bundle's own audit log.
      const infra = createMockInfra(tempDir, 'rel-link');
      writeFileSync(infra.auditLogPath, '{"decision":"allow"}\n');
      symlinkSync('../audit.jsonl', claudeMdPath(infra));

      await runState(infra);

      expect(readFileSync(infra.auditLogPath, 'utf8')).toBe('{"decision":"allow"}\n');
      expectSeededRegularFile(infra);
    });

    it('replaces a dangling symlink without creating its target', async () => {
      const infra = createMockInfra(tempDir, 'dangling-link');
      const target = join(tempDir, 'created-by-host.txt');
      symlinkSync(target, claudeMdPath(infra));

      await runState(infra);

      expect(existsSync(target)).toBe(false);
      expectSeededRegularFile(infra);
    });

    it('replaces a hard link without changing the other name', async () => {
      const infra = createMockInfra(tempDir, 'hard-link');
      const other = join(infra.conversationStateDir as string, 'settings.json');
      writeFileSync(other, '{"theme":"dark"}\n');
      linkSync(other, claudeMdPath(infra));

      await runState(infra);

      expect(readFileSync(other, 'utf8')).toBe('{"theme":"dark"}\n');
      expectSeededRegularFile(infra);
    });

    it('replaces a FIFO without opening it', async () => {
      const infra = createMockInfra(tempDir, 'fifo');
      execFileSync('mkfifo', [claudeMdPath(infra)]);
      // Keep a non-blocking read end open so a regressed writer would complete
      // (leaving bytes in the pipe) instead of blocking this worker forever.
      const reader = openSync(claudeMdPath(infra), constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        await runState(infra);
        expect(pendingFifoBytes(reader)).toBe(0);
      } finally {
        closeSync(reader);
      }
      expectSeededRegularFile(infra);
    });

    it('fails session start on a directory at CLAUDE.md and leaves it intact', async () => {
      const infra = createMockInfra(tempDir, 'dir');
      mkdirSync(join(claudeMdPath(infra), 'agent-data'), { recursive: true });

      await expect(runState(infra)).rejects.toThrow(/directory occupies/u);

      expect(lstatSync(join(claudeMdPath(infra), 'agent-data')).isDirectory()).toBe(true);
      // The factory built this bundle, so it tears it down on the failure.
      expect(vi.mocked(destroyDockerInfrastructure)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(destroyDockerInfrastructure)).toHaveBeenCalledWith(infra);
    });

    it('reports a mocked teardown finding when startup fails before the session exists', async () => {
      const infra = createMockInfra(tempDir, 'notice');
      mkdirSync(claudeMdPath(infra));
      vi.mocked(destroyDockerInfrastructure).mockResolvedValueOnce({
        privilegedFiles: {
          kind: 'host_privileged_files',
          when: 'session end',
          rootOwned: 1,
          stripped: 0,
          unstripped: 0,
          unlisted: 0,
          paths: ['/workspace/example'],
          incomplete: false,
          hint: 'Inspect the example file.',
        },
      });

      await expect(runState(infra)).rejects.toThrow('Inspect the example file.');
    });
  });

  // A borrowed workflow bundle runs no memory server, so the memory gate is
  // closed for every state on it and CLAUDE.md is only ever removed: the
  // agent must not be told to call a memory tool that does not exist.
  describe('borrowed workflow bundle: never seeds the memory protocol', () => {
    /** One workflow state on `infra`, run as the memory-enabled persona. */
    const runState = (infra: DockerInfrastructure): Promise<void> => runSession(infra, PERSONA, 'borrow');

    it('removes a memory CLAUDE.md an earlier session left, even for a memory-enabled persona', async () => {
      const infra = createMockInfra(tempDir, 'stale');
      writeFileSync(
        claudeMdPath(infra),
        `${PERSONA_LINE}\n\nBefore responding, call the \`memory.context\` MCP tool.\n`,
      );

      await runState(infra);

      expectNoClaudeMd(infra);
    });

    it('removes an absolute symlink and leaves its target untouched', async () => {
      const infra = createMockInfra(tempDir, 'abs-link');
      const victim = join(tempDir, 'victim-home', '.ssh', 'authorized_keys');
      mkdirSync(join(tempDir, 'victim-home', '.ssh'), { recursive: true });
      writeFileSync(victim, 'ssh-ed25519 AAAA original\n');
      symlinkSync(victim, claudeMdPath(infra));

      await runState(infra);

      expect(readFileSync(victim, 'utf8')).toBe('ssh-ed25519 AAAA original\n');
      expectNoClaudeMd(infra);
    });

    it('removes a FIFO without opening it', async () => {
      const infra = createMockInfra(tempDir, 'fifo');
      execFileSync('mkfifo', [claudeMdPath(infra)]);
      const reader = openSync(claudeMdPath(infra), constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        await runState(infra);
        expect(pendingFifoBytes(reader)).toBe(0);
      } finally {
        closeSync(reader);
      }
      expectNoClaudeMd(infra);
    });

    it('leaves a directory at CLAUDE.md intact, starts the state and keeps the bundle', async () => {
      // Nothing is written, so a planted directory cannot fail the state; it
      // holds no instructions Claude Code would read.
      const infra = createMockInfra(tempDir, 'dir');
      mkdirSync(join(claudeMdPath(infra), 'agent-data'), { recursive: true });

      await runState(infra);

      expect(lstatSync(join(claudeMdPath(infra), 'agent-data')).isDirectory()).toBe(true);
      expect(vi.mocked(destroyDockerInfrastructure)).not.toHaveBeenCalled();
      expect(infraState.destroyCalls).toBe(0);
    });

    it('does not seed a non-Claude bundle and only unlinks a planted link', async () => {
      const infra = createMockInfra(tempDir, 'codex', 'codex');
      const victim = join(tempDir, 'codex-victim.txt');
      writeFileSync(victim, 'untouched\n');
      symlinkSync(victim, claudeMdPath(infra));

      await runState(infra);

      expect(readFileSync(victim, 'utf8')).toBe('untouched\n');
      expectNoClaudeMd(infra);
    });

    it('memory off (no persona): unlinks a planted link without touching its target', async () => {
      const infra = createMockInfra(tempDir, 'no-persona');
      const victim = join(tempDir, 'no-persona-victim.txt');
      writeFileSync(victim, 'untouched\n');
      symlinkSync(victim, claudeMdPath(infra));

      await runSession(infra, undefined, 'borrow');

      expect(readFileSync(victim, 'utf8')).toBe('untouched\n');
      expectNoClaudeMd(infra);
    });
  });
});
