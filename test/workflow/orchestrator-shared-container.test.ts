import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { Session, SessionOptions } from '../../src/session/types.js';
import type { ContainerSnapshotRef, WorkflowDefinition, WorkflowId } from '../../src/workflow/types.js';
import { VERSION } from '../../src/version.js';
import type { DockerInfrastructure } from '../../src/docker/docker-infrastructure.js';
import type { DockerCommitOptions, DockerImageInfo } from '../../src/docker/types.js';
import type { BundleId } from '../../src/session/types.js';
import type { CheckpointStore } from '../../src/workflow/checkpoint.js';
import { WorkflowOrchestrator, type CreateWorkflowInfrastructureInput } from '../../src/workflow/orchestrator.js';
import {
  approvedResponse,
  createArtifactAwareSession,
  writeDefinitionFile,
  createDeps,
  createMockTab,
  makeTestUserConfig,
  waitForCompletion,
  stubPersonasForTest,
} from './test-helpers.js';
import { createMockDocker } from '../helpers/docker-mocks.js';
import { writePersonaPolicy } from '../fixtures/scoped-policy.js';
import { getLlmMetricsEventBus, resetLlmMetricsEventBus } from '../../src/llm-metrics/event-bus.js';
import { OpenAiResponsesAdapter } from '../../src/llm-metrics/protocols/openai-responses.js';
import type { LlmExchangeCompleted } from '../../src/llm-metrics/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Builds a minimal stub DockerInfrastructure bundle. Tests never exercise
 * the bundle's fields directly — they only track identity (was this
 * bundle handed out, was it passed to destroy, etc.) and use `bundleId`
 * to key per-bundle paths (audit log, control socket, invocation dirs).
 *
 * Under Step 6's lazy-mint model the orchestrator mints a fresh
 * `BundleId` per scope and passes it into the factory as `input.bundleId`;
 * the stub echoes that value back so identity comparisons work across
 * subsequent calls.
 *
 * `setTokenSessionId` is a no-op so the orchestrator's per-agent
 * rerouting calls don't crash. Tests that care about the routing calls
 * should override it with a `vi.fn()`.
 */
/** Agent image build every stub bundle resolves (snapshots record it). */
const STUB_AGENT_BUILD_HASH = 'a'.repeat(64);

function makeStubInfrastructure(workflowId: string, bundleId: BundleId): DockerInfrastructure {
  const bundle = {
    __stub: true,
    workflowId,
    bundleId,
    // Snapshotting is gated on the Docker runtime (apple-container has no image
    // commit); these tests exercise the snapshot path, so the stub is a Docker
    // bundle.
    runtimeKind: 'docker',
    // Like a real bundle, the stub knows the agent image build it runs: a
    // snapshot is committed (and later resumed) only under a known build.
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
  return bundle;
}

/**
 * A runtime whose snapshot commits return `digests` in order and keep the
 * labels each commit stamps, as `docker import --change LABEL ...` does, so
 * the stop path's removal (which removes only images labeled as the run's own
 * snapshots) sees them. `engineImages` are other images already on the
 * engine, by reference, with their labels.
 */
function labellingSnapshotDocker(
  digests: readonly string[],
  engineImages: Readonly<Record<string, Record<string, string>>> = {},
) {
  const labels = new Map<string, Record<string, string>>(Object.entries(engineImages));
  let next = 0;
  return {
    ...createMockDocker(),
    commit: vi.fn(async (_containerId: string, options?: DockerCommitOptions) => {
      const image = digests[next++];
      const stamped: Record<string, string> = {};
      for (const change of options?.changes ?? []) {
        const label = /^LABEL ([^=]+)=(.*)$/u.exec(change);
        if (label) stamped[label[1]] = label[2];
      }
      labels.set(image, stamped);
      return image;
    }),
    inspectImage: vi.fn(async (ref: string): Promise<DockerImageInfo | undefined> => {
      const stamped = labels.get(ref);
      return stamped === undefined
        ? undefined
        : { id: ref, repoTags: [], labels: stamped, created: new Date().toISOString() };
    }),
    removeImage: vi.fn(async (ref: string) => labels.delete(ref)),
  };
}

const dockerWorkflowDef: WorkflowDefinition = {
  name: 'docker-shared',
  description: 'Docker workflow exercising shared-container mode',
  initial: 'work',
  settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true },
  states: {
    work: {
      type: 'agent',
      description: 'Does work',
      persona: 'global',
      prompt: 'You are a worker.',
      inputs: [],
      outputs: ['result'],
      transitions: [{ to: 'done' }],
    },
    done: { type: 'terminal', description: 'Done' },
  },
};

const builtinSharedDef: WorkflowDefinition = {
  name: 'builtin-shared',
  description: 'Builtin workflow with sharedContainer=true (should still opt out)',
  initial: 'work',
  // sharedContainer is set, but builtin mode means no Docker infra is needed.
  settings: { mode: 'builtin', sharedContainer: true },
  states: {
    work: {
      type: 'agent',
      description: 'Does work',
      persona: 'global',
      prompt: 'You are a worker.',
      inputs: [],
      outputs: ['result'],
      transitions: [{ to: 'done' }],
    },
    done: { type: 'terminal', description: 'Done' },
  },
};

const optedOutDockerDef: WorkflowDefinition = {
  name: 'docker-per-state',
  description: 'Docker workflow without sharedContainer (default behavior)',
  initial: 'work',
  settings: { mode: 'docker', dockerAgent: 'claude-code' },
  states: {
    work: {
      type: 'agent',
      description: 'Does work',
      persona: 'global',
      prompt: 'You are a worker.',
      inputs: [],
      outputs: ['result'],
      transitions: [{ to: 'done' }],
    },
    done: { type: 'terminal', description: 'Done' },
  },
};

const builtinDefaultDef: WorkflowDefinition = {
  name: 'builtin-default',
  description: 'Builtin workflow without sharedContainer',
  initial: 'work',
  settings: { mode: 'builtin' },
  states: {
    work: {
      type: 'agent',
      description: 'Does work',
      persona: 'global',
      prompt: 'You are a worker.',
      inputs: [],
      outputs: ['result'],
      transitions: [{ to: 'done' }],
    },
    done: { type: 'terminal', description: 'Done' },
  },
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('WorkflowOrchestrator shared-container mode', () => {
  let tmpDir: string;
  let activeOrchestrator: WorkflowOrchestrator | undefined;
  let cleanupPersonas: (() => void) | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'shared-container-test-'));
    activeOrchestrator = undefined;
    cleanupPersonas = stubPersonasForTest(
      tmpDir,
      dockerWorkflowDef,
      builtinSharedDef,
      optedOutDockerDef,
      builtinDefaultDef,
    );
  });

  afterEach(async () => {
    if (activeOrchestrator) {
      await activeOrchestrator.shutdownAll();
    }
    cleanupPersonas?.();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Test 1: Opt-out default (no sharedContainer flag -> no infra)
  // -------------------------------------------------------------------------

  it('does not create infra for Docker workflows without sharedContainer=true', async () => {
    const defPath = writeDefinitionFile(tmpDir, optedOutDockerDef);

    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) =>
      makeStubInfrastructure(input.workflowId, input.bundleId),
    );
    const destroyInfra = vi.fn(async () => {});

    // Sessions in opted-out mode go through the normal (non-borrow) path.
    // The test stubs the factory because the persona is 'global', which
    // would otherwise require a real session.
    const sessionFactory = vi.fn(async () =>
      createArtifactAwareSession([{ text: approvedResponse('done'), artifacts: ['result'] }], tmpDir),
    );

    const orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        createSession: sessionFactory,
        createWorkflowInfrastructure: createInfra,
        destroyWorkflowInfrastructure: destroyInfra,
      }),
    );
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(defPath, 'task');
    await waitForCompletion(orchestrator, workflowId);

    expect(createInfra).not.toHaveBeenCalled();
    expect(destroyInfra).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 2: Opt-in lazy-mints the primary bundle on first state entry
  // -------------------------------------------------------------------------

  it('lazy-mints the primary bundle on first agent-state entry under sharedContainer=true', async () => {
    const defPath = writeDefinitionFile(tmpDir, dockerWorkflowDef);

    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) =>
      makeStubInfrastructure(input.workflowId, input.bundleId),
    );
    const destroyInfra = vi.fn(async () => {});

    const sessionFactory = vi.fn(async () =>
      createArtifactAwareSession([{ text: approvedResponse('done'), artifacts: ['result'] }], tmpDir),
    );

    const orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        createSession: sessionFactory,
        createWorkflowInfrastructure: createInfra,
        destroyWorkflowInfrastructure: destroyInfra,
      }),
    );
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(defPath, 'task');
    await waitForCompletion(orchestrator, workflowId);

    // With a single-scope workflow, exactly one bundle is minted.
    // Under lazy-mint, the factory is NOT called until the first
    // `executeAgentState` — not at `start()` — but for a single-state
    // workflow we just observe the end state: exactly one call total.
    expect(createInfra).toHaveBeenCalledTimes(1);
    expect(createInfra.mock.calls[0][0]).toMatchObject({
      workflowId,
      agentId: 'claude-code',
      scope: 'primary',
    });
    // Control socket lives under `~/.ironcurtain/run/<bundleId[0:12]>/`
    // — the workflow id is no longer part of the path. Match on the
    // minted bundle's short slug instead.
    // Slug is derived with hyphens stripped; see `toBundleSlug` in paths.ts.
    const mintedBundleId = createInfra.mock.calls[0][0].bundleId;
    expect(createInfra.mock.calls[0][0].controlSocketPath).toContain(mintedBundleId.replace(/-/g, '').substring(0, 12));
  });

  it("hands the run's effective budget to the bundle, whose MITM gate caps every lane together", async () => {
    const budgetedDef: WorkflowDefinition = {
      ...dockerWorkflowDef,
      name: 'docker-shared-budgeted',
      settings: {
        ...dockerWorkflowDef.settings,
        resourceBudget: { maxTotalTokens: 123_456, maxEstimatedCostUsd: 7.5 },
      },
    };
    const defPath = writeDefinitionFile(tmpDir, budgetedDef);
    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) =>
      makeStubInfrastructure(input.workflowId, input.bundleId),
    );
    const sessionFactory = vi.fn(async () =>
      createArtifactAwareSession([{ text: approvedResponse('done'), artifacts: ['result'] }], tmpDir),
    );
    const orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        createSession: sessionFactory,
        createWorkflowInfrastructure: createInfra,
        destroyWorkflowInfrastructure: vi.fn(async () => {}),
      }),
    );
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(defPath, 'task');
    await waitForCompletion(orchestrator, workflowId);

    expect(createInfra).toHaveBeenCalledTimes(1);
    const budget = createInfra.mock.calls[0][0].resourceBudget;
    expect(budget).toMatchObject({ maxTotalTokens: 123_456, maxEstimatedCostUsd: 7.5 });
    // Each state's session receives the same limits: the ones the workflow
    // sets as overrides (above a state persona's resourceBudget), the ones
    // the run inherited as its baseline (below it).
    const sessionOptions = sessionFactory.mock.calls[0] as unknown as [SessionOptions] | undefined;
    expect(sessionOptions?.[0].resourceBudgetOverrides).toEqual({ maxTotalTokens: 123_456, maxEstimatedCostUsd: 7.5 });
    expect({
      ...sessionOptions?.[0].resourceBudgetBaseline,
      ...sessionOptions?.[0].resourceBudgetOverrides,
    }).toEqual(budget);
  });

  // -------------------------------------------------------------------------
  // Test 3: Terminal state destroys infra exactly once
  // -------------------------------------------------------------------------

  it('destroys infra exactly once when the workflow reaches a terminal state', async () => {
    const defPath = writeDefinitionFile(tmpDir, dockerWorkflowDef);

    let createdBundle: DockerInfrastructure | undefined;
    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) => {
      createdBundle = makeStubInfrastructure(input.workflowId, input.bundleId);
      return createdBundle;
    });
    const destroyInfra = vi.fn(async () => {});

    const sessionFactory = vi.fn(async () =>
      createArtifactAwareSession([{ text: approvedResponse('done'), artifacts: ['result'] }], tmpDir),
    );

    const orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        createSession: sessionFactory,
        createWorkflowInfrastructure: createInfra,
        destroyWorkflowInfrastructure: destroyInfra,
      }),
    );
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(defPath, 'task');
    await waitForCompletion(orchestrator, workflowId);

    // destroy is kicked off asynchronously from handleWorkflowComplete.
    // Poll briefly for it to land.
    const start = Date.now();
    while (destroyInfra.mock.calls.length === 0 && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(destroyInfra).toHaveBeenCalledTimes(1);
    expect(destroyInfra).toHaveBeenCalledWith(createdBundle);
  });

  // -------------------------------------------------------------------------
  // Test 4: abort() destroys infra
  // -------------------------------------------------------------------------

  it('destroys infra when the workflow is aborted', async () => {
    // Use a definition that stalls at a human gate so abort() fires while
    // the workflow is still active (finalStatus not yet set).
    const gatedDef: WorkflowDefinition = {
      name: 'docker-gated',
      description: 'Docker workflow with a gate (for abort testing)',
      initial: 'work',
      settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true },
      states: {
        work: {
          type: 'agent',
          description: 'Does work',
          persona: 'global',
          prompt: 'You are a worker.',
          inputs: [],
          outputs: ['result'],
          transitions: [{ to: 'gate' }],
        },
        gate: {
          type: 'human_gate',
          description: 'Human review',
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

    const stubCleanup = stubPersonasForTest(tmpDir, gatedDef);
    try {
      const defPath = writeDefinitionFile(tmpDir, gatedDef);

      let createdBundle: DockerInfrastructure | undefined;
      const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) => {
        createdBundle = makeStubInfrastructure(input.workflowId, input.bundleId);
        return createdBundle;
      });
      const destroyInfra = vi.fn(async () => {});

      const raiseGate = vi.fn();
      const sessionFactory = vi.fn(async () =>
        createArtifactAwareSession([{ text: approvedResponse('done'), artifacts: ['result'] }], tmpDir),
      );

      const orchestrator = new WorkflowOrchestrator(
        createDeps(tmpDir, {
          createSession: sessionFactory,
          createWorkflowInfrastructure: createInfra,
          destroyWorkflowInfrastructure: destroyInfra,
          raiseGate,
        }),
      );
      activeOrchestrator = orchestrator;

      const workflowId = await orchestrator.start(defPath, 'task');

      // Wait for the gate to open before aborting so the workflow is mid-run.
      const gateStart = Date.now();
      while (raiseGate.mock.calls.length === 0 && Date.now() - gateStart < 2000) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(raiseGate).toHaveBeenCalled();

      await orchestrator.abort(workflowId);

      expect(destroyInfra).toHaveBeenCalledTimes(1);
      expect(destroyInfra).toHaveBeenCalledWith(createdBundle);
    } finally {
      stubCleanup();
    }
  });

  it('snapshots live scoped containers on abort and restores from the recorded digest on resume', async () => {
    const snapshotDef: WorkflowDefinition = {
      name: 'docker-snapshot-resume',
      description: 'Docker workflow with snapshot-on-stop enabled',
      initial: 'first',
      settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true, snapshotOnStop: true },
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

    const stubCleanup = stubPersonasForTest(tmpDir, snapshotDef);
    try {
      const defPath = writeDefinitionFile(tmpDir, snapshotDef);
      const checkpointStore = createDeps(tmpDir).checkpointStore;
      const snapshotDigest = `sha256:${'1'.repeat(64)}`;
      const docker = {
        ...createMockDocker(),
        commit: vi.fn(async () => snapshotDigest),
        removeImage: vi.fn(async () => true),
        imageExists: vi.fn(async (image: string) => image === snapshotDigest),
      };
      const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) => {
        return {
          ...makeStubInfrastructure(input.workflowId, input.bundleId),
          docker,
          containerId: `container-${input.bundleId}`,
        };
      });
      const destroyInfra = vi.fn(async () => {});

      let secondSessionRequested!: () => void;
      const secondSessionStarted = new Promise<void>((resolveStarted) => {
        secondSessionRequested = resolveStarted;
      });
      let sessionCount = 0;
      const sessionFactory = vi.fn(async () => {
        sessionCount++;
        if (sessionCount === 1) {
          return createArtifactAwareSession([{ text: approvedResponse('done'), artifacts: ['a'] }], tmpDir);
        }
        secondSessionRequested();
        return new Promise<never>(() => {
          /* keep second state active until abort */
        });
      });

      const orchestrator = new WorkflowOrchestrator(
        createDeps(tmpDir, {
          checkpointStore,
          createSession: sessionFactory,
          createWorkflowInfrastructure: createInfra,
          destroyWorkflowInfrastructure: destroyInfra,
        }),
      );
      activeOrchestrator = orchestrator;

      const workflowId = await orchestrator.start(defPath, 'task');
      await secondSessionStarted;

      await orchestrator.abort(workflowId);
      activeOrchestrator = undefined;

      const checkpoint = checkpointStore.load(workflowId);
      expect(checkpoint?.containerSnapshots?.primary.image).toBe(snapshotDigest);
      // The snapshot records the agent image build its container ran.
      expect(checkpoint?.containerSnapshots?.primary).toMatchObject({
        agentBuildHash: STUB_AGENT_BUILD_HASH,
        ironcurtainVersion: VERSION,
      });
      expect(docker.commit).toHaveBeenCalledTimes(1);
      expect(docker.removeImage).not.toHaveBeenCalled();

      const resumeCreateInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) => {
        return {
          ...makeStubInfrastructure(input.workflowId, input.bundleId),
          docker,
          containerId: `resume-container-${input.bundleId}`,
        };
      });
      const resumeSessionFactory = vi.fn(async () => {
        return new Promise<never>(() => {
          /* keep resumed second state active */
        });
      });
      const resumed = new WorkflowOrchestrator(
        createDeps(tmpDir, {
          checkpointStore,
          createSession: resumeSessionFactory,
          createWorkflowInfrastructure: resumeCreateInfra,
          destroyWorkflowInfrastructure: destroyInfra,
        }),
      );
      activeOrchestrator = resumed;

      await resumed.resume(workflowId);

      const start = Date.now();
      while (resumeCreateInfra.mock.calls.length === 0 && Date.now() - start < 2000) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(resumeCreateInfra).toHaveBeenCalled();
      expect(resumeCreateInfra.mock.calls[0][0].baseImageOverride).toBe(snapshotDigest);
      expect(resumeCreateInfra.mock.calls[0][0].baseImageAgentBuildHash).toBe(STUB_AGENT_BUILD_HASH);
    } finally {
      stubCleanup();
    }
  });

  describe('snapshot build identity on resume', () => {
    const buildCheckDef: WorkflowDefinition = {
      name: 'docker-snapshot-build-check',
      description: 'Docker workflow with snapshot-on-stop enabled',
      initial: 'first',
      settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true, snapshotOnStop: true },
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
    const snapshotDigest = `sha256:${'3'.repeat(64)}`;

    /** Runs to the second state, aborts (committing a snapshot), and returns the stopped run. */
    async function stoppedRunWithSnapshot() {
      const defPath = writeDefinitionFile(tmpDir, buildCheckDef);
      const checkpointStore = createDeps(tmpDir).checkpointStore;
      const docker = {
        ...createMockDocker(),
        commit: vi.fn(async () => snapshotDigest),
        removeImage: vi.fn(async () => true),
      };
      let secondStarted!: () => void;
      const secondActive = new Promise<void>((resolveStarted) => (secondStarted = resolveStarted));
      let count = 0;
      const orchestrator = new WorkflowOrchestrator(
        createDeps(tmpDir, {
          checkpointStore,
          createSession: vi.fn(async () => {
            count++;
            if (count === 1) {
              return createArtifactAwareSession([{ text: approvedResponse('done'), artifacts: ['a'] }], tmpDir);
            }
            secondStarted();
            return new Promise<never>(() => {});
          }),
          createWorkflowInfrastructure: vi.fn(async (input: CreateWorkflowInfrastructureInput) => ({
            ...makeStubInfrastructure(input.workflowId, input.bundleId),
            docker,
            containerId: `container-${input.bundleId}`,
          })),
          destroyWorkflowInfrastructure: vi.fn(async () => {}),
        }),
      );
      activeOrchestrator = orchestrator;
      const workflowId = await orchestrator.start(defPath, 'task');
      await secondActive;
      await orchestrator.abort(workflowId);
      activeOrchestrator = undefined;
      return { workflowId, checkpointStore, docker };
    }

    /** Resumes the run with a factory returning `extra` on its bundles; resolves once a bundle was minted. */
    async function resumeWith(
      run: Awaited<ReturnType<typeof stoppedRunWithSnapshot>>,
      extra: Partial<DockerInfrastructure> = {},
    ) {
      const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) => ({
        ...makeStubInfrastructure(input.workflowId, input.bundleId),
        docker: run.docker,
        containerId: `resume-${input.bundleId}`,
        ...extra,
      }));
      const sessions = vi.fn(async () => new Promise<never>(() => {}));
      const resumed = new WorkflowOrchestrator(
        createDeps(tmpDir, {
          checkpointStore: run.checkpointStore,
          createSession: sessions,
          createWorkflowInfrastructure: createInfra,
          destroyWorkflowInfrastructure: vi.fn(async () => {}),
        }),
      );
      activeOrchestrator = resumed;
      await resumed.resume(run.workflowId);
      await vi.waitFor(() => expect(sessions).toHaveBeenCalledTimes(1), { timeout: 2000, interval: 10 });
      return createInfra;
    }

    function rewriteSnapshot(
      run: Awaited<ReturnType<typeof stoppedRunWithSnapshot>>,
      edit: (snapshot: ContainerSnapshotRef) => ContainerSnapshotRef,
    ): void {
      const checkpoint = run.checkpointStore.load(run.workflowId);
      if (checkpoint?.containerSnapshots?.primary === undefined) throw new Error('no snapshot to rewrite');
      run.checkpointStore.save(run.workflowId, {
        ...checkpoint,
        containerSnapshots: { primary: edit({ ...checkpoint.containerSnapshots.primary }) },
      });
    }

    it('never offers a snapshot that records no agent image build', async () => {
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const run = await stoppedRunWithSnapshot();
        // A checkpoint written before snapshots recorded their build.
        rewriteSnapshot(run, ({ image, tag }) => ({ image, ...(tag === undefined ? {} : { tag }) }));

        const createInfra = await resumeWith(run);

        expect(createInfra.mock.calls[0][0].baseImageOverride).toBeUndefined();
        expect(createInfra.mock.calls[0][0].baseImageAgentBuildHash).toBeUndefined();
        const written = stderr.mock.calls.map((call) => String(call[0])).join('');
        expect(written).toContain(
          'scope "primary" starts from a fresh container instead of its snapshot: ' +
            'the snapshot does not record the agent image build it was taken from',
        );
      } finally {
        stderr.mockRestore();
      }
    });

    it("reports, without using it, a snapshot the bundle refused as another build's", async () => {
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const run = await stoppedRunWithSnapshot();
        const otherBuild = 'c'.repeat(64);
        rewriteSnapshot(run, (snapshot) => ({ ...snapshot, agentBuildHash: otherBuild, ironcurtainVersion: '0.13.0' }));
        const refusal =
          'the snapshot was taken from agent image build cccccccccccccccc, and this IronCurtain runs build aaaaaaaaaaaaaaaa';

        const createInfra = await resumeWith(run, { snapshotRefusal: refusal });

        // The recorded build travels with the digest, so the bundle can refuse it.
        expect(createInfra.mock.calls[0][0]).toMatchObject({
          baseImageOverride: snapshotDigest,
          baseImageAgentBuildHash: otherBuild,
        });
        const written = stderr.mock.calls.map((call) => String(call[0])).join('');
        expect(written).toContain(
          `scope "primary" starts from a fresh container instead of its snapshot: ${refusal} ` +
            '(snapshot taken by IronCurtain 0.13.0). Its workspace is unchanged',
        );
      } finally {
        stderr.mockRestore();
      }
    });

    it('does not commit a snapshot whose agent image build is unknown', async () => {
      const docker = { ...createMockDocker(), commit: vi.fn(async () => snapshotDigest) };
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
        type SnapshotHarness = {
          snapshotResumableScopes(instance: unknown): Promise<Readonly<Record<string, unknown>> | undefined>;
        };
        const instance = {
          id: 'workflow-unknown-build',
          definition: buildCheckDef,
          bundlesByScope: new Map([
            [
              'primary',
              {
                ...makeStubInfrastructure('workflow-unknown-build', 'primary' as BundleId),
                imageResolution: undefined,
                docker,
                containerId: 'container-primary',
              },
            ],
          ]),
        };

        const snapshots = await (orchestrator as unknown as SnapshotHarness).snapshotResumableScopes(instance);

        expect(snapshots).toBeUndefined();
        expect(docker.commit).not.toHaveBeenCalled();
        expect(stderr.mock.calls.map((call) => String(call[0])).join('')).toContain(
          'The agent image build of workflow-unknown-build scope "primary" is unknown',
        );
      } finally {
        stderr.mockRestore();
      }
    });
  });

  it('gates snapshotting on the runtime image-snapshot capability', async () => {
    const docker = {
      ...createMockDocker(),
      supportsImageSnapshots: false,
      commit: vi.fn(async () => {
        throw new Error('snapshot should not be attempted');
      }),
    };
    const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
    type SnapshotHarness = {
      snapshotResumableScopes(instance: unknown): Promise<Readonly<Record<string, unknown>> | undefined>;
    };
    const instance = {
      id: 'workflow-capability-gate',
      definition: {
        ...dockerWorkflowDef,
        settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true, snapshotOnStop: true },
      },
      bundlesByScope: new Map([
        [
          'primary',
          {
            ...makeStubInfrastructure('workflow-capability-gate', 'primary' as BundleId),
            docker,
            containerId: 'container-primary',
          },
        ],
      ]),
    };

    const snapshots = await (orchestrator as unknown as SnapshotHarness).snapshotResumableScopes(instance);

    expect(snapshots).toBeUndefined();
    expect(docker.commit).not.toHaveBeenCalled();
  });

  it('uses a snapshot-capable runtime for snapshot cleanup', async () => {
    const unsupportedRuntime = {
      ...createMockDocker(),
      supportsImageSnapshots: false,
      removeImage: vi.fn(async () => {
        throw new Error('unsupported runtime should not clean snapshots');
      }),
    };
    const snapshotRuntime = {
      ...createMockDocker(),
      removeImage: vi.fn(async () => true),
    };
    const orchestrator = new WorkflowOrchestrator(createDeps(tmpDir));
    type CleanupHarness = {
      dockerForSnapshotCleanup(instance: unknown): Promise<unknown>;
    };
    const instance = {
      bundlesByScope: new Map([
        ['apple', { docker: unsupportedRuntime }],
        ['docker', { docker: snapshotRuntime }],
      ]),
    };

    const cleanupRuntime = await (orchestrator as unknown as CleanupHarness).dockerForSnapshotCleanup(instance);

    expect(cleanupRuntime).toBe(snapshotRuntime);
  });

  it('supersedes (removes) the previous snapshot digest on a resume-then-stop', async () => {
    const snapshotDef: WorkflowDefinition = {
      name: 'docker-snapshot-supersede',
      description: 'Docker workflow with snapshot-on-stop enabled',
      initial: 'first',
      settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true, snapshotOnStop: true },
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

    const stubCleanup = stubPersonasForTest(tmpDir, snapshotDef);
    try {
      const defPath = writeDefinitionFile(tmpDir, snapshotDef);
      const checkpointStore = createDeps(tmpDir).checkpointStore;
      const digestA1 = `sha256:${'1'.repeat(64)}`;
      const digestA2 = `sha256:${'2'.repeat(64)}`;
      // Removal checks the labels the commit stamped (the run's id and base directory).
      const docker = labellingSnapshotDocker([digestA1, digestA2]);
      const makeInfra = (prefix: string) =>
        vi.fn(async (input: CreateWorkflowInfrastructureInput) => {
          return {
            ...makeStubInfrastructure(input.workflowId, input.bundleId),
            docker,
            containerId: `${prefix}-${input.bundleId}`,
          };
        });
      const destroyInfra = vi.fn(async () => {});

      // First run: advance to the (blocking) second state, then abort.
      let firstSecondStarted!: () => void;
      const firstSecondActive = new Promise<void>((r) => (firstSecondStarted = r));
      let firstCount = 0;
      const firstSessions = vi.fn(async () => {
        firstCount++;
        if (firstCount === 1) {
          return createArtifactAwareSession([{ text: approvedResponse('done'), artifacts: ['a'] }], tmpDir);
        }
        firstSecondStarted();
        return new Promise<never>(() => {});
      });
      const first = new WorkflowOrchestrator(
        createDeps(tmpDir, {
          checkpointStore,
          createSession: firstSessions,
          createWorkflowInfrastructure: makeInfra('container'),
          destroyWorkflowInfrastructure: destroyInfra,
        }),
      );
      activeOrchestrator = first;
      const workflowId = await first.start(defPath, 'task');
      await firstSecondActive;
      await first.abort(workflowId);
      activeOrchestrator = undefined;

      expect(checkpointStore.load(workflowId)?.containerSnapshots?.primary.image).toBe(digestA1);
      expect(docker.removeImage).not.toHaveBeenCalled();

      // Resume, advance to the blocking state again, then abort a second time.
      const resumeCreateInfra = makeInfra('resume-container');
      // Wait for the session (not just the factory call) so the resumed
      // scope's bundle is live: an abort that lands while the mint is still in
      // flight undoes the mint and carries the old snapshot forward instead
      // (covered by its own test below).
      const resumeSessions = vi.fn(async () => new Promise<never>(() => {}));
      const resume = new WorkflowOrchestrator(
        createDeps(tmpDir, {
          checkpointStore,
          createSession: resumeSessions,
          createWorkflowInfrastructure: resumeCreateInfra,
          destroyWorkflowInfrastructure: destroyInfra,
        }),
      );
      activeOrchestrator = resume;
      await resume.resume(workflowId);
      expect(checkpointStore.load(workflowId)?.containerSnapshots?.primary.image).toBe(digestA1);
      expect(checkpointStore.load(workflowId)?.finalStatus).toBeUndefined();
      await vi.waitFor(() => expect(resumeSessions).toHaveBeenCalledTimes(1), { timeout: 2000, interval: 10 });
      expect(resumeCreateInfra.mock.calls[0][0].baseImageOverride).toBe(digestA1);

      await resume.abort(workflowId);
      activeOrchestrator = undefined;

      // The second stop committed a fresh digest, recorded it, and removed the
      // superseded one — never the live one.
      expect(docker.commit).toHaveBeenCalledTimes(2);
      expect(checkpointStore.load(workflowId)?.containerSnapshots?.primary.image).toBe(digestA2);
      expect(docker.removeImage).toHaveBeenCalledWith(digestA1);
      expect(docker.removeImage).not.toHaveBeenCalledWith(digestA2);
    } finally {
      stubCleanup();
    }
  });

  // -------------------------------------------------------------------------
  // The snapshot references of a resumed run, from resume to its next stop
  // -------------------------------------------------------------------------

  describe('snapshot references of a resumed run', () => {
    const threeStateDef: WorkflowDefinition = {
      name: 'docker-snapshot-three-states',
      description: 'Docker workflow with snapshot-on-stop enabled',
      initial: 'first',
      settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true, snapshotOnStop: true },
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
          transitions: [{ to: 'third' }],
        },
        third: {
          type: 'agent',
          description: 'Third agent',
          persona: 'global',
          prompt: 'You are third.',
          inputs: ['b'],
          outputs: ['c'],
          transitions: [{ to: 'done' }],
        },
        done: { type: 'terminal', description: 'Done' },
      },
    };
    const digestA = `sha256:${'a1'.repeat(32)}`;
    const digestB = `sha256:${'b2'.repeat(32)}`;
    type SnapshotDocker = ReturnType<typeof labellingSnapshotDocker>;

    const blocked = (): Promise<Session> => new Promise<never>(() => {});
    const answering = async (artifact: string): Promise<Session> =>
      createArtifactAwareSession([{ text: approvedResponse('done'), artifacts: [artifact] }], tmpDir);

    /** One leg of the run: bundles share `docker`; `session(n)` scripts the n-th session it creates. */
    function leg(options: {
      docker: SnapshotDocker;
      checkpointStore: CheckpointStore;
      session: (n: number) => Promise<Session>;
      bundle?: Partial<DockerInfrastructure>;
    }) {
      const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) => ({
        ...makeStubInfrastructure(input.workflowId, input.bundleId),
        docker: options.docker,
        containerId: `container-${input.bundleId}`,
        ...options.bundle,
      }));
      let created = 0;
      const createSession = vi.fn(async () => options.session(++created));
      const orchestrator = new WorkflowOrchestrator(
        createDeps(tmpDir, {
          checkpointStore: options.checkpointStore,
          createSession,
          createWorkflowInfrastructure: createInfra,
          destroyWorkflowInfrastructure: vi.fn(async () => {}),
        }),
      );
      activeOrchestrator = orchestrator;
      return { orchestrator, createInfra, createSession };
    }

    /** Starts the run and aborts it in `second`, which commits the first snapshot. */
    async function abortedInSecond(
      docker: SnapshotDocker,
      checkpointStore: CheckpointStore,
      bundle?: Partial<DockerInfrastructure>,
    ): Promise<WorkflowId> {
      const defPath = writeDefinitionFile(tmpDir, threeStateDef);
      const first = leg({ docker, checkpointStore, bundle, session: (n) => (n === 1 ? answering('a') : blocked()) });
      const workflowId = await first.orchestrator.start(defPath, 'task');
      await vi.waitFor(() => expect(first.createSession).toHaveBeenCalledTimes(2), { timeout: 2000, interval: 10 });
      await first.orchestrator.abort(workflowId);
      activeOrchestrator = undefined;
      return workflowId;
    }

    /** A store that refuses to write the terminal checkpoint, as on a disk the stop's commit just filled. */
    function failingTerminalSaves(store: CheckpointStore): CheckpointStore {
      return {
        save: (id, checkpoint) => {
          if (checkpoint.finalStatus !== undefined) throw new Error('ENOSPC: no space left on device');
          store.save(id, checkpoint);
        },
        load: (id) => store.load(id),
        listAll: () => store.listAll(),
        remove: (id) => store.remove(id),
      };
    }

    it('keeps the restore snapshot in every checkpoint of the resumed run, and supersedes it at the next stop', async () => {
      const docker = labellingSnapshotDocker([digestA, digestB]);
      const store = createDeps(tmpDir).checkpointStore;
      const workflowId = await abortedInSecond(docker, store);
      expect(store.load(workflowId)?.containerSnapshots?.primary.image).toBe(digestA);

      // The resumed `second` finishes and `third` starts.
      const resumed = leg({ docker, checkpointStore: store, session: (n) => (n === 1 ? answering('b') : blocked()) });
      await resumed.orchestrator.resume(workflowId);
      await vi.waitFor(() => expect(resumed.createSession).toHaveBeenCalledTimes(2), { timeout: 2000, interval: 10 });
      expect(resumed.createInfra.mock.calls[0][0].baseImageOverride).toBe(digestA);
      const midRun = store.load(workflowId);
      expect(midRun?.machineState).toBe('third');
      // A crash now still resumes the scope from its snapshot.
      expect(midRun?.containerSnapshots?.primary.image).toBe(digestA);

      await resumed.orchestrator.abort(workflowId);
      activeOrchestrator = undefined;

      expect(store.load(workflowId)?.containerSnapshots?.primary.image).toBe(digestB);
      expect(docker.removeImage).toHaveBeenCalledWith(digestA);
      expect(docker.removeImage).not.toHaveBeenCalledWith(digestB);
    });

    it('removes the restore snapshot when the resumed run completes', async () => {
      const docker = labellingSnapshotDocker([digestA]);
      const store = createDeps(tmpDir).checkpointStore;
      const workflowId = await abortedInSecond(docker, store);

      const resumed = leg({ docker, checkpointStore: store, session: (n) => answering(n === 1 ? 'b' : 'c') });
      await resumed.orchestrator.resume(workflowId);
      await waitForCompletion(resumed.orchestrator, workflowId);
      await vi.waitFor(() => expect(docker.removeImage).toHaveBeenCalledWith(digestA), { timeout: 2000, interval: 10 });
      expect(store.load(workflowId)?.finalStatus?.phase).toBe('completed');
    });

    // A checkpoint's references are only strings: one restored from a backup
    // or edited by hand can name any image on the engine. Completion removes
    // every reference it supersedes, but only this run's own snapshot images.
    it('removes only its own snapshot images when a resumed run completes, whatever the checkpoint names', async () => {
      const foreignId = `sha256:${'f0'.repeat(32)}`;
      const docker = labellingSnapshotDocker([digestA], {
        'postgres:16': {},
        [foreignId]: { 'org.opencontainers.image.title': 'postgres' },
      });
      const store = createDeps(tmpDir).checkpointStore;
      // Stopped in the last agent state, so the resumed run goes straight to
      // completion, which supersedes every reference the checkpoint names.
      const first = leg({
        docker,
        checkpointStore: store,
        session: (n) => (n === 1 ? answering('a') : n === 2 ? answering('b') : blocked()),
      });
      const workflowId = await first.orchestrator.start(writeDefinitionFile(tmpDir, threeStateDef), 'task');
      await vi.waitFor(() => expect(first.createSession).toHaveBeenCalledTimes(3), { timeout: 2000, interval: 10 });
      await first.orchestrator.abort(workflowId);
      activeOrchestrator = undefined;
      const stopped = store.load(workflowId);
      expect(stopped?.machineState).toBe('third');
      expect(stopped?.containerSnapshots?.primary.image).toBe(digestA);
      if (stopped === undefined) throw new Error('the aborted run left no checkpoint');
      store.save(workflowId, {
        ...stopped,
        containerSnapshots: {
          ...stopped.containerSnapshots,
          tagged: { image: 'postgres:16', agentBuildHash: STUB_AGENT_BUILD_HASH },
          foreign: { image: foreignId, agentBuildHash: STUB_AGENT_BUILD_HASH },
        },
      });
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const resumed = leg({ docker, checkpointStore: store, session: () => answering('c') });
        await resumed.orchestrator.resume(workflowId);
        await waitForCompletion(resumed.orchestrator, workflowId);
        await vi.waitFor(() => expect(docker.removeImage).toHaveBeenCalledWith(digestA), {
          timeout: 2000,
          interval: 10,
        });
        await resumed.orchestrator.shutdownAll();
        activeOrchestrator = undefined;

        expect(store.load(workflowId)?.finalStatus?.phase).toBe('completed');
        expect(docker.removeImage.mock.calls.map(([ref]) => ref)).toEqual([digestA]);
      } finally {
        stderr.mockRestore();
      }
    });

    it('keeps the previous snapshot images when the terminal checkpoint cannot be saved', async () => {
      const docker = labellingSnapshotDocker([digestA, digestB]);
      const store = createDeps(tmpDir).checkpointStore;
      const workflowId = await abortedInSecond(docker, store);
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const resumed = leg({ docker, checkpointStore: failingTerminalSaves(store), session: () => blocked() });
        await resumed.orchestrator.resume(workflowId);
        await vi.waitFor(() => expect(resumed.createSession).toHaveBeenCalledTimes(1), { timeout: 2000, interval: 10 });

        await resumed.orchestrator.abort(workflowId);
        activeOrchestrator = undefined;

        expect(docker.commit).toHaveBeenCalledTimes(2);
        // The checkpoint on disk still names the first snapshot: the next resume needs it.
        expect(store.load(workflowId)?.containerSnapshots?.primary.image).toBe(digestA);
        expect(docker.removeImage).not.toHaveBeenCalled();
      } finally {
        stderr.mockRestore();
      }
    });

    it('keeps the restore snapshot when the terminal checkpoint of a completed run cannot be saved', async () => {
      const docker = labellingSnapshotDocker([digestA]);
      const store = createDeps(tmpDir).checkpointStore;
      const workflowId = await abortedInSecond(docker, store);
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const resumed = leg({
          docker,
          checkpointStore: failingTerminalSaves(store),
          session: (n) => answering(n === 1 ? 'b' : 'c'),
        });
        await resumed.orchestrator.resume(workflowId);
        await waitForCompletion(resumed.orchestrator, workflowId);
        await resumed.orchestrator.shutdownAll();
        activeOrchestrator = undefined;

        // On disk the run is still resumable at `third`, from the first snapshot.
        expect(store.load(workflowId)?.finalStatus).toBeUndefined();
        expect(store.load(workflowId)?.containerSnapshots?.primary.image).toBe(digestA);
        expect(docker.removeImage).not.toHaveBeenCalled();
      } finally {
        stderr.mockRestore();
      }
    });

    it('neither restores nor removes the snapshots of a checkpoint resumed with ignoreContainerSnapshots', async () => {
      const docker = labellingSnapshotDocker([digestA, digestB]);
      const store = createDeps(tmpDir).checkpointStore;
      const workflowId = await abortedInSecond(docker, store);
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const resumed = leg({ docker, checkpointStore: store, session: () => blocked() });
        await resumed.orchestrator.resume(workflowId, { ignoreContainerSnapshots: true });
        await vi.waitFor(() => expect(resumed.createSession).toHaveBeenCalledTimes(1), { timeout: 2000, interval: 10 });

        expect(resumed.createInfra.mock.calls[0][0].baseImageOverride).toBeUndefined();
        expect(store.load(workflowId)?.containerSnapshots).toBeUndefined();
        expect(stderr.mock.calls.map((call) => String(call[0])).join('')).toContain(
          'The container snapshots this checkpoint records are not used; scopes will start fresh.',
        );

        await resumed.orchestrator.abort(workflowId);
        activeOrchestrator = undefined;

        expect(store.load(workflowId)?.containerSnapshots?.primary.image).toBe(digestB);
        expect(docker.removeImage).not.toHaveBeenCalled();
      } finally {
        stderr.mockRestore();
      }
    });

    it('never removes an ignored snapshot, even when the resume checkpoint that dropped it is not saved', async () => {
      const docker = labellingSnapshotDocker([digestA, digestB]);
      const store = createDeps(tmpDir).checkpointStore;
      const workflowId = await abortedInSecond(docker, store);
      // The resume-time save fails, so the checkpoint on disk still references
      // the ignored snapshot when the next stop saves its own.
      let failNext = true;
      const failingResumeSave: CheckpointStore = {
        save: (id, checkpoint) => {
          if (failNext) {
            failNext = false;
            throw new Error('EIO: i/o error');
          }
          store.save(id, checkpoint);
        },
        load: (id) => store.load(id),
        listAll: () => store.listAll(),
        remove: (id) => store.remove(id),
      };
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const resumed = leg({ docker, checkpointStore: failingResumeSave, session: () => blocked() });
        await resumed.orchestrator.resume(workflowId, { ignoreContainerSnapshots: true });
        await vi.waitFor(() => expect(resumed.createSession).toHaveBeenCalledTimes(1), { timeout: 2000, interval: 10 });
        expect(store.load(workflowId)?.containerSnapshots?.primary.image).toBe(digestA);

        await resumed.orchestrator.abort(workflowId);
        activeOrchestrator = undefined;

        expect(store.load(workflowId)?.containerSnapshots?.primary.image).toBe(digestB);
        expect(docker.removeImage).not.toHaveBeenCalled();
      } finally {
        stderr.mockRestore();
      }
    });

    it("records the agent's privilege mode with the snapshot and hands it back to the bundle on resume", async () => {
      // The second digest serves the stop of the resumed run at teardown.
      const docker = labellingSnapshotDocker([digestA, digestB]);
      const store = createDeps(tmpDir).checkpointStore;
      const workflowId = await abortedInSecond(docker, store, { agentSudo: false });
      expect(store.load(workflowId)?.containerSnapshots?.primary).toMatchObject({ image: digestA, agentSudo: false });

      const resumed = leg({ docker, checkpointStore: store, session: () => blocked() });
      await resumed.orchestrator.resume(workflowId);
      await vi.waitFor(() => expect(resumed.createSession).toHaveBeenCalledTimes(1), { timeout: 2000, interval: 10 });
      expect(resumed.createInfra.mock.calls[0][0]).toMatchObject({
        baseImageOverride: digestA,
        baseImageAgentBuildHash: STUB_AGENT_BUILD_HASH,
        baseImageAgentSudo: false,
      });
    });

    it('records no privilege mode for a bundle that does not report one', async () => {
      const docker = labellingSnapshotDocker([digestA, digestB]);
      const store = createDeps(tmpDir).checkpointStore;
      const workflowId = await abortedInSecond(docker, store);
      expect(store.load(workflowId)?.containerSnapshots?.primary).not.toHaveProperty('agentSudo');

      const resumed = leg({ docker, checkpointStore: store, session: () => blocked() });
      await resumed.orchestrator.resume(workflowId);
      await vi.waitFor(() => expect(resumed.createSession).toHaveBeenCalledTimes(1), { timeout: 2000, interval: 10 });
      expect(resumed.createInfra.mock.calls[0][0]).not.toHaveProperty('baseImageAgentSudo');
    });
  });

  // -------------------------------------------------------------------------
  // Abort while a resumed scope is still being minted; bounded snapshots
  // -------------------------------------------------------------------------

  const snapshotOnStopDef: WorkflowDefinition = {
    name: 'docker-snapshot-abort',
    description: 'Docker workflow with snapshot-on-stop enabled',
    initial: 'work',
    settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true, snapshotOnStop: true },
    states: {
      work: {
        type: 'agent',
        description: 'Does work',
        persona: 'global',
        prompt: 'You are a worker.',
        inputs: [],
        outputs: [],
        transitions: [{ to: 'done' }],
      },
      done: { type: 'terminal', description: 'Done' },
    },
  };

  it('undoes a mint the abort overtook and carries the resumed-from snapshot forward', async () => {
    const defPath = writeDefinitionFile(tmpDir, snapshotOnStopDef);
    const checkpointStore = createDeps(tmpDir).checkpointStore;
    const docker = {
      ...createMockDocker(),
      commit: vi.fn(async () => `sha256:${'9'.repeat(64)}`),
      removeImage: vi.fn(async () => true),
    };
    const digest = `sha256:${'1'.repeat(64)}`;

    // A first leg stopped with a snapshot of its scope.
    const firstSession = vi.fn(() => new Promise<never>(() => {}));
    const first = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        checkpointStore,
        createSession: firstSession,
        createWorkflowInfrastructure: vi.fn(async (input: CreateWorkflowInfrastructureInput) => ({
          ...makeStubInfrastructure(input.workflowId, input.bundleId),
          docker: { ...docker, commit: vi.fn(async () => digest) },
          containerId: 'first-container',
        })),
        destroyWorkflowInfrastructure: async () => {},
      }),
    );
    activeOrchestrator = first;
    const workflowId = await first.start(defPath, 'task');
    await vi.waitFor(() => expect(firstSession).toHaveBeenCalled(), { timeout: 2000, interval: 5 });
    await first.abort(workflowId);
    expect(checkpointStore.load(workflowId)?.containerSnapshots?.primary.image).toBe(digest);

    // The resumed leg's mint is still in flight when the abort lands.
    let releaseMint: (bundle: DockerInfrastructure) => void = () => {};
    const destroyInfra = vi.fn(async () => {});
    const createSession = vi.fn();
    let mintInput: CreateWorkflowInfrastructureInput | undefined;
    const resumed = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        checkpointStore,
        createSession,
        createWorkflowInfrastructure: vi.fn((input: CreateWorkflowInfrastructureInput) => {
          mintInput = input;
          return new Promise<DockerInfrastructure>((r) => (releaseMint = r));
        }),
        destroyWorkflowInfrastructure: destroyInfra,
      }),
    );
    activeOrchestrator = resumed;
    await resumed.resume(workflowId);
    await vi.waitFor(() => expect(mintInput).toBeDefined(), { timeout: 2000, interval: 5 });

    const aborting = resumed.abort(workflowId);
    const orphan = {
      ...makeStubInfrastructure(workflowId, mintInput?.bundleId ?? ('orphan' as BundleId)),
      docker,
      containerId: 'resumed-container',
    } as DockerInfrastructure;
    releaseMint(orphan);
    await aborting;
    await vi.waitFor(() => expect(destroyInfra).toHaveBeenCalledWith(orphan), { timeout: 2000, interval: 5 });

    // No session ran in the undone container, so the old snapshot still
    // describes the scope: kept, not re-committed, not removed.
    expect(createSession).not.toHaveBeenCalled();
    expect(docker.commit).not.toHaveBeenCalled();
    expect(docker.removeImage).not.toHaveBeenCalled();
    expect(checkpointStore.load(workflowId)?.containerSnapshots?.primary.image).toBe(digest);
    expect(checkpointStore.load(workflowId)?.finalStatus?.phase).toBe('aborted');
  });

  it('bounds snapshot commits by the stop budget and skips them when it is spent', async () => {
    const defPath = writeDefinitionFile(tmpDir, snapshotOnStopDef);
    const runOnce = async (snapshotBudgetMs: number) => {
      const commit = vi.fn<(container: string, options: { timeoutMs?: number }) => Promise<string>>(
        async () => `sha256:${'3'.repeat(64)}`,
      );
      const sessionCreated = vi.fn();
      const orchestrator = new WorkflowOrchestrator(
        createDeps(tmpDir, {
          createSession: vi.fn(() => {
            sessionCreated();
            return new Promise<never>(() => {});
          }),
          createWorkflowInfrastructure: vi.fn(async (input: CreateWorkflowInfrastructureInput) => ({
            ...makeStubInfrastructure(input.workflowId, input.bundleId),
            docker: { ...createMockDocker(), commit },
            containerId: 'budget-container',
          })),
          destroyWorkflowInfrastructure: async () => {},
        }),
      );
      activeOrchestrator = orchestrator;
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const workflowId = await orchestrator.start(defPath, 'task');
        await vi.waitFor(() => expect(sessionCreated).toHaveBeenCalled(), { timeout: 2000, interval: 5 });
        await orchestrator.shutdownAll({ reason: 'Interrupted', snapshotBudgetMs });
        return { commit, workflowId, stderr: stderr.mock.calls.map((call) => String(call[0])).join('') };
      } finally {
        stderr.mockRestore();
        activeOrchestrator = undefined;
      }
    };

    const bounded = await runOnce(5_000);
    expect(bounded.commit).toHaveBeenCalledTimes(1);
    const timeoutMs = bounded.commit.mock.calls[0][1].timeoutMs ?? Infinity;
    expect(timeoutMs).toBeGreaterThan(0);
    expect(timeoutMs).toBeLessThanOrEqual(5_000);

    const spent = await runOnce(0);
    expect(spent.commit).not.toHaveBeenCalled();
    expect(spent.stderr).toContain('leaves no time to snapshot');
  });

  it('a shutdown that lands during a user abort waits for its snapshot instead of tearing down under it', async () => {
    const defPath = writeDefinitionFile(tmpDir, snapshotOnStopDef);
    const checkpointStore = createDeps(tmpDir).checkpointStore;
    const digest = `sha256:${'4'.repeat(64)}`;
    let finishCommit: (image: string) => void = () => {};
    const commit = vi.fn(() => new Promise<string>((r) => (finishCommit = r)));
    const destroyInfra = vi.fn(async () => {});
    const sessionCreated = vi.fn();
    const orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        checkpointStore,
        createSession: vi.fn(() => {
          sessionCreated();
          return new Promise<never>(() => {});
        }),
        createWorkflowInfrastructure: vi.fn(async (input: CreateWorkflowInfrastructureInput) => ({
          ...makeStubInfrastructure(input.workflowId, input.bundleId),
          docker: { ...createMockDocker(), commit },
          containerId: 'user-abort-container',
        })),
        destroyWorkflowInfrastructure: destroyInfra,
      }),
    );
    activeOrchestrator = orchestrator;
    const workflowId = await orchestrator.start(defPath, 'task');
    await vi.waitFor(() => expect(sessionCreated).toHaveBeenCalled(), { timeout: 2000, interval: 5 });

    // The user's abort is committing its snapshot when the shutdown begins.
    const userAbort = orchestrator.abort(workflowId);
    await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(1), { timeout: 2000, interval: 5 });
    let shutdownFinished = false;
    const shutdown = orchestrator.shutdownAll({ reason: 'Daemon shutdown' }).then(() => {
      shutdownFinished = true;
    });
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 5));
    expect(destroyInfra).not.toHaveBeenCalled();
    expect(shutdownFinished).toBe(false);

    finishCommit(digest);
    await userAbort;
    await shutdown;

    expect(destroyInfra).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
    const checkpoint = checkpointStore.load(workflowId);
    expect(checkpoint?.containerSnapshots?.primary.image).toBe(digest);
    // The stop that began first records its reason.
    expect(checkpoint?.finalStatus).toEqual({ phase: 'aborted', reason: 'Workflow aborted by user' });
  });

  it('a shutdown that lands while a failed run is snapshotting waits for its terminal handling', async () => {
    const defPath = writeDefinitionFile(tmpDir, snapshotOnStopDef);
    const checkpointStore = createDeps(tmpDir).checkpointStore;
    const digest = `sha256:${'5'.repeat(64)}`;
    let finishCommit: (image: string) => void = () => {};
    const commit = vi.fn(() => new Promise<string>((r) => (finishCommit = r)));
    const destroyInfra = vi.fn(async () => {});
    const orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        checkpointStore,
        // The agent state fails, so the run reaches a resumable `failed`
        // terminal whose handling snapshots the live scope.
        createSession: vi.fn(async () => {
          throw new Error('session refused');
        }),
        createWorkflowInfrastructure: vi.fn(async (input: CreateWorkflowInfrastructureInput) => ({
          ...makeStubInfrastructure(input.workflowId, input.bundleId),
          docker: { ...createMockDocker(), commit },
          containerId: 'failed-run-container',
        })),
        destroyWorkflowInfrastructure: destroyInfra,
      }),
    );
    activeOrchestrator = orchestrator;
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const workflowId = await orchestrator.start(defPath, 'task');
      await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(1), { timeout: 2000, interval: 5 });
      expect(orchestrator.getStatus(workflowId)?.phase).toBe('failed');

      let shutdownFinished = false;
      const shutdown = orchestrator.shutdownAll({ reason: 'Daemon shutdown' }).then(() => {
        shutdownFinished = true;
      });
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 5));
      expect(destroyInfra).not.toHaveBeenCalled();
      expect(shutdownFinished).toBe(false);

      finishCommit(digest);
      await shutdown;

      expect(destroyInfra).toHaveBeenCalledTimes(1);
      const checkpoint = checkpointStore.load(workflowId);
      expect(checkpoint?.finalStatus?.phase).toBe('failed');
      expect(checkpoint?.containerSnapshots?.primary.image).toBe(digest);
      expect(orchestrator.listActive()).toEqual([]);
    } finally {
      stderr.mockRestore();
    }
  });

  // -------------------------------------------------------------------------
  // Test 5: shutdownAll destroys infra for every active workflow
  // -------------------------------------------------------------------------

  it('destroys infra for every instance on shutdownAll', async () => {
    const defPath = writeDefinitionFile(tmpDir, dockerWorkflowDef);

    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) =>
      makeStubInfrastructure(input.workflowId, input.bundleId),
    );
    const destroyInfra = vi.fn(async () => {});

    // Never-completes session so the workflow stays active until shutdown.
    const sessionFactory = vi.fn(
      () =>
        new Promise(() => {
          /* hang */
        }),
    );

    const orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        createSession: sessionFactory as unknown as (opts: SessionOptions) => Promise<never>,
        createWorkflowInfrastructure: createInfra,
        destroyWorkflowInfrastructure: destroyInfra,
      }),
    );
    activeOrchestrator = orchestrator;

    const id1 = await orchestrator.start(defPath, 'task 1');
    // start() resolves after infra creation; then actor.start() kicks off
    // the hanging session. Spin briefly to ensure the workflow is registered.
    await new Promise((r) => setTimeout(r, 20));

    expect(createInfra).toHaveBeenCalledTimes(1);
    expect(orchestrator.listActive()).toContain(id1);

    await orchestrator.shutdownAll();
    activeOrchestrator = undefined; // already shut down

    // shutdownAll aborts the workflow (which destroys infra) and then
    // makes a second pass. The instance was destroyed only once because
    // destroyWorkflowInfrastructure is idempotent (clears instance.infra
    // on first call, early-returns on the second).
    expect(destroyInfra).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Test 6: Idempotent destroy
  // -------------------------------------------------------------------------

  it('destroyWorkflowInfrastructure is idempotent (second call is a no-op)', async () => {
    const defPath = writeDefinitionFile(tmpDir, dockerWorkflowDef);

    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) =>
      makeStubInfrastructure(input.workflowId, input.bundleId),
    );
    const destroyInfra = vi.fn(async () => {});

    const sessionFactory = vi.fn(async () =>
      createArtifactAwareSession([{ text: approvedResponse('done'), artifacts: ['result'] }], tmpDir),
    );

    const orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        createSession: sessionFactory,
        createWorkflowInfrastructure: createInfra,
        destroyWorkflowInfrastructure: destroyInfra,
      }),
    );
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(defPath, 'task');
    await waitForCompletion(orchestrator, workflowId);

    // Wait for the async destroy dispatched from handleWorkflowComplete.
    const start = Date.now();
    while (destroyInfra.mock.calls.length === 0 && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(destroyInfra).toHaveBeenCalledTimes(1);

    // A follow-up abort or shutdownAll must not call destroy again.
    await orchestrator.shutdownAll();
    activeOrchestrator = undefined;

    expect(destroyInfra).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Test 6b: shutdownAll drains the terminal handler's in-flight teardown
  //
  // Regression for the leaked-Docker-network bug: on a normal terminal,
  // handleWorkflowComplete kicks off destroyWorkflowInfrastructure as a
  // fire-and-forget (the actor subscription is synchronous). Because
  // destroyWorkflowInfrastructure snapshot-and-clears bundlesByScope up
  // front, shutdownAll's redundant destroy pass no-ops — so shutdownAll
  // MUST await the retained teardownPromise, otherwise the CLI's
  // process.exit() races the still-running `docker network rm` and orphans
  // the per-run --internal network.
  // -------------------------------------------------------------------------

  it('shutdownAll awaits the in-flight teardown started by a normal terminal', async () => {
    const defPath = writeDefinitionFile(tmpDir, dockerWorkflowDef);

    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) =>
      makeStubInfrastructure(input.workflowId, input.bundleId),
    );

    // Gate the teardown so it cannot finish until we release it. This models
    // the slow `docker stop`/`rm`/`network rm` calls inside cleanupContainers.
    let releaseDestroy!: () => void;
    const destroyGate = new Promise<void>((r) => {
      releaseDestroy = r;
    });
    let destroyFinished = false;
    const destroyInfra = vi.fn(async () => {
      await destroyGate;
      destroyFinished = true;
    });

    const sessionFactory = vi.fn(async () =>
      createArtifactAwareSession([{ text: approvedResponse('done'), artifacts: ['result'] }], tmpDir),
    );

    const orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        createSession: sessionFactory,
        createWorkflowInfrastructure: createInfra,
        destroyWorkflowInfrastructure: destroyInfra,
      }),
    );
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(defPath, 'task');
    await waitForCompletion(orchestrator, workflowId);

    // The terminal handler has dispatched destroy, but it is blocked on the
    // gate (still in flight).
    const start = Date.now();
    while (destroyInfra.mock.calls.length === 0 && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(destroyInfra).toHaveBeenCalledTimes(1);
    expect(destroyFinished).toBe(false);

    // shutdownAll must NOT resolve while the teardown is still running.
    let shutdownResolved = false;
    const shutdownPromise = orchestrator.shutdownAll().then(() => {
      shutdownResolved = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(shutdownResolved).toBe(false);
    expect(destroyFinished).toBe(false);

    // Release the teardown; now shutdownAll can complete — and only after the
    // teardown has fully finished.
    releaseDestroy();
    await shutdownPromise;
    activeOrchestrator = undefined;

    expect(shutdownResolved).toBe(true);
    expect(destroyFinished).toBe(true);
    expect(destroyInfra).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Test 7: Builtin workflows ignore the sharedContainer flag
  // -------------------------------------------------------------------------

  it('does not create infra for builtin workflows even when sharedContainer=true', async () => {
    const defPath = writeDefinitionFile(tmpDir, builtinSharedDef);

    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) =>
      makeStubInfrastructure(input.workflowId, input.bundleId),
    );
    const destroyInfra = vi.fn(async () => {});

    const sessionFactory = vi.fn(async () =>
      createArtifactAwareSession([{ text: approvedResponse('done'), artifacts: ['result'] }], tmpDir),
    );

    const orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        createSession: sessionFactory,
        createWorkflowInfrastructure: createInfra,
        destroyWorkflowInfrastructure: destroyInfra,
      }),
    );
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(defPath, 'task');
    await waitForCompletion(orchestrator, workflowId);

    expect(createInfra).not.toHaveBeenCalled();
    expect(destroyInfra).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 8: Builtin workflow without the flag also skips infra
  // -------------------------------------------------------------------------

  it('does not create infra for builtin workflows without sharedContainer', async () => {
    const defPath = writeDefinitionFile(tmpDir, builtinDefaultDef);

    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) =>
      makeStubInfrastructure(input.workflowId, input.bundleId),
    );
    const destroyInfra = vi.fn(async () => {});

    const sessionFactory = vi.fn(async () =>
      createArtifactAwareSession([{ text: approvedResponse('done'), artifacts: ['result'] }], tmpDir),
    );

    const orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        createSession: sessionFactory,
        createWorkflowInfrastructure: createInfra,
        destroyWorkflowInfrastructure: destroyInfra,
      }),
    );
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(defPath, 'task');
    await waitForCompletion(orchestrator, workflowId);

    expect(createInfra).not.toHaveBeenCalled();
    expect(destroyInfra).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Regression: per-agent `setTokenSessionId` on the shared MITM proxy
  // -------------------------------------------------------------------------
  //
  // Before the fix, `createWorkflowInfrastructure` baked the workflow ID
  // into the MITM proxy as a static sessionId. Each per-state agent session
  // has its own generated SessionId, so token events extracted by the
  // long-lived MITM proxy were pushed under the workflow ID instead of the
  // active agent's session ID. The daemon's `TokenStreamBridge` registers
  // the per-state ID (via the `agent_started` lifecycle event), so events
  // keyed on the workflow ID never reached any subscriber — silently
  // dropped at the bridge.
  //
  // The fix is that the orchestrator flips
  // `instance.infra.setTokenSessionId` around each agent run:
  //   - Before emitting `agent_started`: set to the session's ID.
  //   - In the `finally` block, BEFORE emitting `agent_session_ended`:
  //     set to `undefined`.
  //
  // These tests lock that contract.

  it('flips setTokenSessionId to the per-agent session ID around each agent run', async () => {
    // Two sequential agent states so we can observe two distinct session
    // IDs flow through the MITM proxy.
    const twoAgentDef: WorkflowDefinition = {
      name: 'docker-two-agents',
      description: 'Two back-to-back agents in shared-container mode',
      initial: 'first',
      settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true },
      states: {
        first: {
          type: 'agent',
          description: 'First agent',
          persona: 'global',
          prompt: 'You are the first agent.',
          inputs: [],
          outputs: ['a'],
          transitions: [{ to: 'second' }],
        },
        second: {
          type: 'agent',
          description: 'Second agent',
          persona: 'global',
          prompt: 'You are the second agent.',
          inputs: ['a'],
          outputs: ['b'],
          transitions: [{ to: 'done' }],
        },
        done: { type: 'terminal', description: 'Done' },
      },
    };

    const stubCleanup = stubPersonasForTest(tmpDir, twoAgentDef);
    try {
      const defPath = writeDefinitionFile(tmpDir, twoAgentDef);

      // Record every setTokenSessionId call on the shared bundle.
      const tokenSessionIdCalls: Array<string | undefined> = [];
      const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) => {
        const bundle = {
          __stub: true,
          workflowId: input.workflowId,
          bundleId: input.bundleId,
          setTokenSessionId: (id: string | undefined) => {
            tokenSessionIdCalls.push(id);
          },
          beginCaptureSession: () => {},
          endCaptureSession: async () => {},
        } as unknown as DockerInfrastructure;
        return bundle;
      });
      const destroyInfra = vi.fn(async () => {});

      // Each invocation returns a distinct session ID so the test can
      // assert the orchestrator used the session's ID (not the workflow's).
      let sessionCounter = 0;
      const sessionFactory = vi.fn(async () => {
        sessionCounter++;
        return createArtifactAwareSession(
          [{ text: approvedResponse('done'), artifacts: [sessionCounter === 1 ? 'a' : 'b'] }],
          tmpDir,
          `agent-session-${sessionCounter}`,
        );
      });

      const orchestrator = new WorkflowOrchestrator(
        createDeps(tmpDir, {
          createSession: sessionFactory,
          createWorkflowInfrastructure: createInfra,
          destroyWorkflowInfrastructure: destroyInfra,
        }),
      );
      activeOrchestrator = orchestrator;

      const workflowId = await orchestrator.start(defPath, 'task');
      await waitForCompletion(orchestrator, workflowId);

      // Expect the orchestrator to have driven the following sequence:
      //   1. set('agent-session-1')    ← before `agent_started` for "first"
      //   2. set(undefined)            ← in `finally` of "first"
      //   3. set('agent-session-2')    ← before `agent_started` for "second"
      //   4. set(undefined)            ← in `finally` of "second"
      // The per-agent ID (NOT the workflowId) is what lands on the proxy.
      expect(tokenSessionIdCalls).toEqual(['agent-session-1', undefined, 'agent-session-2', undefined]);
      // Sanity: the workflow ID was NEVER used as a routing target.
      expect(tokenSessionIdCalls).not.toContain(workflowId);
    } finally {
      stubCleanup();
    }
  });

  it('clears setTokenSessionId on failure so the next agent does not inherit a stale ID', async () => {
    // A workflow where the agent fails (no status block + retry also
    // fails). The `finally` block must still flip setTokenSessionId back
    // to `undefined` — otherwise a subsequent agent in a follow-up run
    // would see events routed under the previous session's ID.
    const failingAgentDef: WorkflowDefinition = {
      name: 'docker-failing-agent',
      description: 'Single agent that fails (status block retry exhausted)',
      initial: 'broken',
      settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true },
      states: {
        broken: {
          type: 'agent',
          description: 'Fails to produce a status block',
          persona: 'global',
          prompt: 'You are broken.',
          inputs: [],
          outputs: ['result'],
          transitions: [{ to: 'done' }],
        },
        done: { type: 'terminal', description: 'Done' },
      },
    };

    const stubCleanup = stubPersonasForTest(tmpDir, failingAgentDef);
    try {
      const defPath = writeDefinitionFile(tmpDir, failingAgentDef);

      const tokenSessionIdCalls: Array<string | undefined> = [];
      const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) => {
        return {
          __stub: true,
          workflowId: input.workflowId,
          bundleId: input.bundleId,
          setTokenSessionId: (id: string | undefined) => {
            tokenSessionIdCalls.push(id);
          },
          beginCaptureSession: () => {},
          endCaptureSession: async () => {},
        } as unknown as DockerInfrastructure;
      });
      const destroyInfra = vi.fn(async () => {});

      // Import inline to avoid leaking this helper import into every test
      // above.
      const { MockSession, noStatusResponse, simulateArtifacts, findWorkflowDir } = await import('./test-helpers.js');

      const sessionFactory = vi.fn(async () => {
        simulateArtifacts(findWorkflowDir(tmpDir), ['result']);
        return new MockSession({
          sessionId: 'failing-session-abc',
          responses: [noStatusResponse(), noStatusResponse()],
        });
      });

      const orchestrator = new WorkflowOrchestrator(
        createDeps(tmpDir, {
          createSession: sessionFactory,
          createWorkflowInfrastructure: createInfra,
          destroyWorkflowInfrastructure: destroyInfra,
        }),
      );
      activeOrchestrator = orchestrator;

      const workflowId = await orchestrator.start(defPath, 'task');
      await waitForCompletion(orchestrator, workflowId);

      // Even on the failure path (status retry exhausted → throw), the
      // `finally` block must set sessionId back to undefined.
      expect(tokenSessionIdCalls).toEqual(['failing-session-abc', undefined]);
    } finally {
      stubCleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Run-wide usage from the metrics bus (MET-9)
  // -------------------------------------------------------------------------
  //
  // The workflow's token totals come from the completed LLM exchanges the
  // MITM publishes on the metrics bus, attributed to the run (workflowRunId)
  // or to one of its bundles (bundle-only fallback attribution). The old
  // token-stream counter summed only `message_end.outputTokens`: it dropped
  // every input and cache token and counted 0 for OpenAI-format streams
  // (Codex), whose message_end events carry no output count.

  /** Usage the real OpenAI Responses adapter extracts from a Codex-style stream. */
  function codexStreamUsage(): LlmExchangeCompleted['usage'] {
    const accumulator = new OpenAiResponsesAdapter().createAccumulator();
    accumulator.observeStreamEvent({
      eventType: 'response.created',
      data: { type: 'response.created', response: { id: 'resp_codex', model: 'gpt-5.5-codex', status: 'in_progress' } },
    });
    accumulator.observeStreamEvent({
      eventType: 'response.output_text.delta',
      data: { type: 'response.output_text.delta', delta: 'done' },
    });
    accumulator.observeStreamEvent({
      eventType: 'response.completed',
      data: {
        type: 'response.completed',
        response: {
          id: 'resp_codex',
          model: 'gpt-5.5-codex',
          status: 'completed',
          usage: {
            input_tokens: 5000,
            input_tokens_details: { cached_tokens: 4000 },
            output_tokens: 300,
            output_tokens_details: { reasoning_tokens: 120 },
            total_tokens: 5300,
          },
        },
      },
    });
    return accumulator.snapshot().usage;
  }

  it('derives run-wide totals from metrics-bus exchanges, Codex-style OpenAI streams included', async () => {
    resetLlmMetricsEventBus();
    const bus = getLlmMetricsEventBus();

    const twoAgentDef: WorkflowDefinition = {
      name: 'docker-usage-totals',
      description: 'Two agents whose exchanges reach the metrics bus',
      initial: 'first',
      settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true },
      states: {
        first: {
          type: 'agent',
          description: 'First agent',
          persona: 'global',
          prompt: 'You are the first agent.',
          inputs: [],
          outputs: ['a'],
          transitions: [{ to: 'second' }],
        },
        second: {
          type: 'agent',
          description: 'Second agent',
          persona: 'global',
          prompt: 'You are the second agent.',
          inputs: ['a'],
          outputs: ['b'],
          transitions: [{ to: 'done' }],
        },
        done: { type: 'terminal', description: 'Done' },
      },
    };

    const stubCleanup = stubPersonasForTest(tmpDir, twoAgentDef);
    try {
      const defPath = writeDefinitionFile(tmpDir, twoAgentDef);
      const bundleIds: string[] = [];
      const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) => {
        bundleIds.push(input.bundleId);
        return makeStubInfrastructure(input.workflowId, input.bundleId);
      });
      const destroyInfra = vi.fn(async () => {});

      const { MockSession, approvedResponse, simulateArtifacts, findWorkflowDir, makeLlmExchange, mockBudgetStatus } =
        await import('./test-helpers.js');

      let workflowId = '' as WorkflowId;
      let sessionCounter = 0;
      const sessionFactory = vi.fn(async () => {
        sessionCounter++;
        const turn = sessionCounter;
        return new MockSession({
          sessionId: `agent-session-${turn}`,
          // Metrics-capable route: the session's exchanges reach the bus.
          budgetStatus: () => mockBudgetStatus({ tokenTrackingAvailable: true }),
          responses: () => {
            if (turn === 1) {
              // Claude Code (Anthropic Messages): input, cache reads and writes.
              bus.publish(
                makeLlmExchange({
                  workflowRunId: workflowId,
                  usage: {
                    inputTokensReported: 200,
                    inputTokensTotal: 1200,
                    inputTokensUncached: 200,
                    cacheReadInputTokens: 800,
                    cacheWriteInputTokens: 200,
                    outputTokensReported: 100,
                    outputTokensTotal: 100,
                    providerTotalTokens: null,
                    canonicalTotalTokens: 1300,
                  },
                }),
              );
            } else {
              // Codex over chatgpt.com (OpenAI Responses).
              bus.publish(
                makeLlmExchange({ workflowRunId: workflowId, protocol: 'openai-responses', usage: codexStreamUsage() }),
              );
              // An exchange the MITM could tie only to the bundle still counts.
              bus.publish(makeLlmExchange({ bundleId: bundleIds[0], quality: 'bundle_only' }));
              // Another run's exchange does not.
              bus.publish(makeLlmExchange({ workflowRunId: 'some-other-run' }));
            }
            simulateArtifacts(findWorkflowDir(tmpDir), [turn === 1 ? 'a' : 'b']);
            return approvedResponse('done');
          },
        });
      });

      const deps = createDeps(tmpDir, {
        createSession: sessionFactory,
        createWorkflowInfrastructure: createInfra,
        destroyWorkflowInfrastructure: destroyInfra,
      });
      const orchestrator = new WorkflowOrchestrator(deps);
      activeOrchestrator = orchestrator;

      workflowId = await orchestrator.start(defPath, 'task');
      await waitForCompletion(orchestrator, workflowId);

      const expected = {
        inputTokens: 1200 + 5000 + 100,
        cacheReadTokens: 800 + 4000,
        cacheWriteTokens: 200,
        outputTokens: 100 + 300 + 10,
        totalTokens: 1300 + 5300 + 110,
        observedExchanges: 3,
        incompleteExchanges: 0,
        meteredSessions: 2,
        untrackedSessions: 0,
        tokenTrackingStatus: 'complete',
      };
      const detail = orchestrator.getDetail(workflowId);
      expect(detail?.usage).toMatchObject(expected);
      // ctx.totalTokens is readable and now means the run-wide total.
      expect(detail?.context.totalTokens).toBe(expected.totalTokens);
      expect(detail?.budget?.workflowUsage).toMatchObject({ totalTokens: expected.totalTokens });
      // The terminal checkpoint keeps the breakdown for past-run displays and resume.
      const checkpoint = deps.checkpointStore.load(workflowId);
      expect(checkpoint?.usage).toMatchObject(expected);
      expect(checkpoint?.resourceBudget).not.toHaveProperty('workflowUsage');
    } finally {
      stubCleanup();
    }
  });

  it('reports token usage as unavailable when no agent session can be metered (statistics off)', async () => {
    resetLlmMetricsEventBus();

    const defPath = writeDefinitionFile(tmpDir, dockerWorkflowDef);
    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) =>
      makeStubInfrastructure(input.workflowId, input.bundleId),
    );
    const destroyInfra = vi.fn(async () => {});

    // MockSession reports tokenTrackingAvailable: false, like a Docker session
    // whose bundle has no metrics path (statistics.enabled false).
    const sessionFactory = vi.fn(async () =>
      createArtifactAwareSession([{ text: approvedResponse('done'), artifacts: ['result'] }], tmpDir),
    );

    const orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        createSession: sessionFactory,
        createWorkflowInfrastructure: createInfra,
        destroyWorkflowInfrastructure: destroyInfra,
      }),
    );
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(defPath, 'task');
    await waitForCompletion(orchestrator, workflowId);

    const detail = orchestrator.getDetail(workflowId);
    expect(detail?.usage).toMatchObject({
      totalTokens: 0,
      untrackedSessions: 1,
      meteredSessions: 0,
      tokenTrackingStatus: 'unavailable',
    });
    expect(detail?.context.totalTokens).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Memory in shared-container scopes. A bundle serves every persona in its
  // scope through one coordinator, so getRequiredServersForScope never asks
  // for the memory server, whatever the personas want: one bundle-wide memory
  // server would hand every persona in the scope the same database. Personas
  // that have memory enabled are reported on the workflow tab instead.
  // See docs/designs/per-persona-memory-optin.md §1.2 and §5 site F.
  // -------------------------------------------------------------------------

  describe('memory in shared-container scopes', () => {
    /**
     * Writes a persona.json (with optional memory config) and a minimal
     * compiled-policy.json inside the home stubbed by `stubPersonasForTest`.
     * The orchestrator's `getRequiredServersForScope` calls
     * `loadPersonaPolicyArtifacts`, and the memory report calls `loadPersona`;
     * both need real files under `IRONCURTAIN_HOME/personas/<name>/`.
     */
    function seedPersonaWithMemory(name: string, memory: { enabled: boolean } | undefined): void {
      const home = process.env.IRONCURTAIN_HOME;
      if (!home) throw new Error('IRONCURTAIN_HOME not set; call stubPersonasForTest first');
      const personaDir = resolve(home, 'personas', name);
      mkdirSync(personaDir, { recursive: true });
      const personaJson: Record<string, unknown> = {
        name,
        description: 'memory-gate test',
        createdAt: '2026-01-01T00:00:00.000Z',
      };
      if (memory !== undefined) personaJson.memory = memory;
      writeFileSync(resolve(personaDir, 'persona.json'), JSON.stringify(personaJson));
      writePersonaPolicy(personaDir);
    }

    /** Builds a single-state Docker workflow assigning the given persona. */
    function buildSinglePersonaDef(persona: string): WorkflowDefinition {
      return {
        name: `memory-gate-${persona}`,
        description: 'Single-persona shared-container workflow',
        initial: 'work',
        settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true },
        states: {
          work: {
            type: 'agent',
            description: 'Does work',
            persona,
            prompt: 'You are a worker.',
            inputs: [],
            outputs: ['result'],
            transitions: [{ to: 'done' }],
          },
          done: { type: 'terminal', description: 'Done' },
        },
      };
    }

    /**
     * Builds a two-state Docker workflow whose states share the default scope.
     * Two personas in one scope need `allowMixedPersonas: true`, which
     * declares the scope one trust domain (validateScopePersonaIsolation).
     */
    function buildTwoPersonaDef(name: string, first: string, second: string): WorkflowDefinition {
      return {
        name,
        description: 'Two personas in the same scope',
        initial: 'first',
        settings: { mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true, allowMixedPersonas: true },
        states: {
          first: {
            type: 'agent',
            description: 'First',
            persona: first,
            prompt: 'You are first.',
            inputs: [],
            outputs: ['a'],
            transitions: [{ to: 'second' }],
          },
          second: {
            type: 'agent',
            description: 'Second',
            persona: second,
            prompt: 'You are second.',
            inputs: ['a'],
            outputs: ['b'],
            transitions: [{ to: 'done' }],
          },
          done: { type: 'terminal', description: 'Done' },
        },
      };
    }

    /**
     * Runs `def` to completion with a stubbed bundle factory. Returns the
     * required-server set the single bundle was minted with and the
     * `[memory]` lines written to the workflow tab.
     */
    async function runAndCaptureMint(
      def: WorkflowDefinition,
      userConfig = makeTestUserConfig(),
    ): Promise<{ requiredServers: string[]; memoryNotices: string[] }> {
      const defPath = writeDefinitionFile(tmpDir, def);
      const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) =>
        makeStubInfrastructure(input.workflowId, input.bundleId),
      );
      const tab = createMockTab();
      // Each state writes the artifacts it declares, so the run completes.
      const sessionFactory = vi.fn(async (opts: SessionOptions) => {
        const stateId = opts.workflow?.stateId;
        const state = stateId === undefined ? undefined : def.states[stateId];
        const artifacts = state?.type === 'agent' ? [...state.outputs] : [];
        return createArtifactAwareSession([{ text: approvedResponse('done'), artifacts }], tmpDir);
      });

      const orchestrator = new WorkflowOrchestrator(
        createDeps(tmpDir, {
          createSession: sessionFactory,
          createWorkflowTab: () => tab,
          createWorkflowInfrastructure: createInfra,
          destroyWorkflowInfrastructure: vi.fn(async () => {}),
          userConfig,
        }),
      );
      activeOrchestrator = orchestrator;

      const workflowId = await orchestrator.start(defPath, 'task');
      await waitForCompletion(orchestrator, workflowId);

      expect(orchestrator.getStatus(workflowId)?.phase).toBe('completed');
      expect(createInfra).toHaveBeenCalledTimes(1);
      const memoryNotices = vi
        .mocked(tab.write)
        .mock.calls.map(([line]) => line)
        .filter((line) => line.startsWith('[memory]'));
      return { requiredServers: [...createInfra.mock.calls[0][0].requiredServers], memoryNotices };
    }

    it('never requests memory for a persona with memory enabled, and reports it', async () => {
      const def = buildSinglePersonaDef('default-persona');
      const stubCleanup = stubPersonasForTest(tmpDir, def);
      try {
        seedPersonaWithMemory('default-persona', undefined);

        const { requiredServers, memoryNotices } = await runAndCaptureMint(def);

        expect(requiredServers).not.toContain('memory');
        expect(memoryNotices).toHaveLength(1);
        expect(memoryNotices[0]).toContain('default-persona');
        expect(memoryNotices[0]).toContain('scope "primary"');
        expect(memoryNotices[0]).toContain('run without memory');
      } finally {
        stubCleanup();
      }
    });

    it('never requests one memory server for two memory-enabled personas sharing a scope', async () => {
      // The naive fix would mint one `memory` relay for the scope: both
      // personas would then read and write the same database.
      const def = buildTwoPersonaDef('memory-gate-two-on', 'researcher', 'writer');
      const stubCleanup = stubPersonasForTest(tmpDir, def);
      try {
        seedPersonaWithMemory('researcher', undefined);
        seedPersonaWithMemory('writer', { enabled: true });

        const { requiredServers, memoryNotices } = await runAndCaptureMint(def);

        expect(requiredServers).not.toContain('memory');
        expect(memoryNotices).toHaveLength(1);
        expect(memoryNotices[0]).toContain('researcher, writer');
      } finally {
        stubCleanup();
      }
    });

    it('reports only the persona that opted in when another in the scope opted out', async () => {
      const def = buildTwoPersonaDef('memory-gate-mixed', 'mixed-out', 'mixed-default');
      const stubCleanup = stubPersonasForTest(tmpDir, def);
      try {
        seedPersonaWithMemory('mixed-out', { enabled: false });
        seedPersonaWithMemory('mixed-default', undefined);

        const { requiredServers, memoryNotices } = await runAndCaptureMint(def);

        expect(requiredServers).not.toContain('memory');
        expect(memoryNotices).toHaveLength(1);
        expect(memoryNotices[0]).toContain('mixed-default');
        expect(memoryNotices[0]).not.toContain('mixed-out');
      } finally {
        stubCleanup();
      }
    });

    it('omits memory and reports nothing when the only persona in scope opts out', async () => {
      const def = buildSinglePersonaDef('opted-out');
      const stubCleanup = stubPersonasForTest(tmpDir, def);
      try {
        seedPersonaWithMemory('opted-out', { enabled: false });

        const { requiredServers, memoryNotices } = await runAndCaptureMint(def);

        expect(requiredServers).not.toContain('memory');
        expect(memoryNotices).toEqual([]);
      } finally {
        stubCleanup();
      }
    });

    it('omits memory and reports nothing when every persona in scope opts out', async () => {
      const def = buildTwoPersonaDef('memory-gate-all-out', 'all-out-1', 'all-out-2');
      const stubCleanup = stubPersonasForTest(tmpDir, def);
      try {
        seedPersonaWithMemory('all-out-1', { enabled: false });
        seedPersonaWithMemory('all-out-2', { enabled: false });

        const { requiredServers, memoryNotices } = await runAndCaptureMint(def);

        expect(requiredServers).not.toContain('memory');
        expect(memoryNotices).toEqual([]);
      } finally {
        stubCleanup();
      }
    });

    it('omits memory and reports nothing when the global kill switch is off, regardless of persona state', async () => {
      const def = buildSinglePersonaDef('kill-switch-default');
      const stubCleanup = stubPersonasForTest(tmpDir, def);
      try {
        seedPersonaWithMemory('kill-switch-default', undefined);

        const { requiredServers, memoryNotices } = await runAndCaptureMint(
          def,
          makeTestUserConfig({
            memory: {
              enabled: false,
              autoSave: true,
              llmBaseUrl: undefined,
              llmApiKey: undefined,
              offlineModels: false,
            },
          }),
        );

        expect(requiredServers).not.toContain('memory');
        expect(memoryNotices).toEqual([]);
      } finally {
        stubCleanup();
      }
    });

    it('reports nothing for the global persona, which never has memory', async () => {
      // `global` is the no-persona sentinel: the session factory runs its
      // states without a persona, so they never get memory, even when a
      // persona directory of that name exists with memory on by default.
      seedPersonaWithMemory('global', undefined);

      const { requiredServers, memoryNotices } = await runAndCaptureMint(dockerWorkflowDef);

      expect(requiredServers).not.toContain('memory');
      expect(memoryNotices).toEqual([]);
    });
  });
});
