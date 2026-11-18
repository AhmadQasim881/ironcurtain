/**
 * The orchestrator runs `workspaceAccess: read-only` agent states on a
 * read-only workspace (WP-131):
 *
 * - Per-state sessions (no shared container, builtin) get the state's
 *   read-only workspace through `SessionOptions.workflow.readOnlyWorkspace`,
 *   which the session factory turns into a read-only `/workspace` mount, no
 *   nested Docker, and a coordinator that denies changes outside the outputs.
 * - In shared-container mode the read-only scope's bundle is minted with it
 *   (`CreateWorkflowInfrastructureInput.readOnlyWorkspace`), and a read-only
 *   state refuses a bundle that was not built read-only.
 * - Its output directories are made real directories first, so a symlink an
 *   earlier read-write state planted there is moved aside, never followed.
 *
 * Sessions and bundles are stubs: no Docker, no LLM.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionOptions } from '../../src/session/types.js';
import type { WorkflowDefinition } from '../../src/workflow/types.js';
import type { DockerInfrastructure } from '../../src/docker/docker-infrastructure.js';
import { WorkflowOrchestrator, type CreateWorkflowInfrastructureInput } from '../../src/workflow/orchestrator.js';
import {
  MockSession,
  approvedResponse,
  createDeps,
  simulateArtifacts,
  stubPersonasForTest,
  waitForCompletion,
  writeDefinitionFile,
} from './test-helpers.js';

function reviewLoop(settings: WorkflowDefinition['settings'], reviewScope?: string): WorkflowDefinition {
  return {
    name: 'read-only-review',
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

function stubBundle(input: CreateWorkflowInfrastructureInput, echoReadOnly: boolean): DockerInfrastructure {
  return {
    __stub: true,
    workflowId: input.workflowId,
    bundleId: input.bundleId,
    scope: input.scope,
    ...(echoReadOnly && input.readOnlyWorkspace ? { readOnlyWorkspace: input.readOnlyWorkspace } : {}),
    setTokenSessionId: () => {},
    beginCaptureSession: () => {},
    endCaptureSession: async () => {},
  } as unknown as DockerInfrastructure;
}

describe('WorkflowOrchestrator read-only agent states', () => {
  let tmpDir: string;
  let orchestrator: WorkflowOrchestrator | undefined;
  let cleanupPersonas: (() => void) | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orch-read-only-'));
    orchestrator = undefined;
    cleanupPersonas = stubPersonasForTest(tmpDir, reviewLoop({}));
  });

  afterEach(async () => {
    await orchestrator?.shutdownAll();
    cleanupPersonas?.();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('gives a per-state reviewer session the read-only workspace, with its output directory ready', async () => {
    const definition = reviewLoop({ mode: 'docker', dockerAgent: 'claude-code' });
    const captured: SessionOptions[] = [];
    const sessions = new Map<string, MockSession>();
    const reviewDirAtCreate: { isRealDirectory?: boolean } = {};

    const createSession = vi.fn((opts: SessionOptions) => {
      captured.push(opts);
      const stateId = opts.workflow?.stateId ?? '?';
      const workspace = opts.workspacePath ?? '';
      if (stateId === 'review') {
        const entry = lstatSync(join(workspace, '.workflow', 'reviews'), { throwIfNoEntry: false });
        reviewDirAtCreate.isRealDirectory = entry?.isDirectory() === true && !entry.isSymbolicLink();
      }
      const session = new MockSession({
        responses: () => {
          if (stateId === 'implement') {
            // A compromised implementer points the reviewer's output
            // directory at the code it wants rewritten.
            mkdirSync(join(workspace, 'src'), { recursive: true });
            symlinkSync(join(workspace, 'src'), join(workspace, '.workflow', 'reviews'));
            simulateArtifacts(join(workspace, '..'), ['code']);
          } else {
            simulateArtifacts(join(workspace, '..'), ['reviews']);
          }
          return approvedResponse();
        },
      });
      sessions.set(stateId, session);
      return Promise.resolve(session);
    });

    orchestrator = new WorkflowOrchestrator(createDeps(tmpDir, { createSession }));
    const workflowId = await orchestrator.start(writeDefinitionFile(tmpDir, definition), 'task');
    await waitForCompletion(orchestrator, workflowId);

    expect(orchestrator.getStatus(workflowId)?.phase).toBe('completed');
    const byState = new Map(captured.map((opts) => [opts.workflow?.stateId, opts]));
    expect(byState.get('implement')?.workflow?.readOnlyWorkspace).toBeUndefined();
    expect(byState.get('review')?.workflow?.readOnlyWorkspace?.writablePaths).toEqual(['.workflow/reviews']);
    expect(byState.get('review')?.workflow?.infrastructure).toBeUndefined();

    // The planted symlink was moved aside before the reviewer's session
    // existed; the code it pointed at was never written through it.
    expect(reviewDirAtCreate.isRealDirectory).toBe(true);
    const workspace = byState.get('review')?.workspacePath ?? '';
    expect(readdirSync(join(workspace, 'src'))).toEqual([]);
    expect(
      readdirSync(join(workspace, '.workflow')).some((name) => name.startsWith('reviews.ironcurtain-displaced-')),
    ).toBe(true);

    // The reviewer is told how to write its outputs.
    expect(sessions.get('review')?.sentMessages[0]).toContain('## Read-only workspace');
    expect(sessions.get('implement')?.sentMessages[0]).not.toContain('Read-only workspace');
  });

  it('mints a read-only bundle for a read-only shared-container scope', async () => {
    const definition = reviewLoop({ mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true }, 'review');
    const factoryInputs: CreateWorkflowInfrastructureInput[] = [];
    const captured: SessionOptions[] = [];

    const createSession = vi.fn((opts: SessionOptions) => {
      captured.push(opts);
      const workspace = opts.workspacePath ?? '';
      const output = opts.workflow?.stateId === 'implement' ? 'code' : 'reviews';
      return Promise.resolve(
        new MockSession({
          responses: () => {
            simulateArtifacts(join(workspace, '..'), [output]);
            return approvedResponse();
          },
        }),
      );
    });

    orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        createSession,
        createWorkflowInfrastructure: vi.fn((input: CreateWorkflowInfrastructureInput) => {
          factoryInputs.push(input);
          return Promise.resolve(stubBundle(input, true));
        }),
        destroyWorkflowInfrastructure: vi.fn(async () => {}),
      }),
    );
    const workflowId = await orchestrator.start(writeDefinitionFile(tmpDir, definition), 'task');
    await waitForCompletion(orchestrator, workflowId);

    expect(orchestrator.getStatus(workflowId)?.phase).toBe('completed');
    const byScope = Object.fromEntries(factoryInputs.map((input) => [input.scope, input]));
    expect(Object.keys(byScope).sort()).toEqual(['primary', 'review']);
    expect(byScope.primary.readOnlyWorkspace).toBeUndefined();
    expect(byScope.review.readOnlyWorkspace?.writablePaths).toEqual(['.workflow/reviews']);
    // The reviewer writes its outputs through the filesystem server.
    expect(byScope.review.requiredServers.has('filesystem')).toBe(true);
    expect(existsSync(join(byScope.review.workspacePath, '.workflow', 'reviews'))).toBe(true);

    // The borrowing session takes the bundle's access; it asks for none itself.
    const review = captured.find((opts) => opts.workflow?.stateId === 'review');
    expect(review?.workflow?.infrastructure).toBeDefined();
    expect(review?.workflow?.readOnlyWorkspace).toBeUndefined();
  });

  it('refuses to run a read-only state in a bundle that was not built read-only', async () => {
    const definition = reviewLoop({ mode: 'docker', dockerAgent: 'claude-code', sharedContainer: true }, 'review');
    const sessionStates: string[] = [];
    const createSession = vi.fn((opts: SessionOptions) => {
      sessionStates.push(opts.workflow?.stateId ?? '?');
      const workspace = opts.workspacePath ?? '';
      return Promise.resolve(
        new MockSession({
          responses: () => {
            simulateArtifacts(join(workspace, '..'), ['code']);
            return approvedResponse();
          },
        }),
      );
    });

    orchestrator = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        createSession,
        // A factory that ignores the scope's read-only workspace.
        createWorkflowInfrastructure: vi.fn((input: CreateWorkflowInfrastructureInput) =>
          Promise.resolve(stubBundle(input, false)),
        ),
        destroyWorkflowInfrastructure: vi.fn(async () => {}),
      }),
    );
    const workflowId = await orchestrator.start(writeDefinitionFile(tmpDir, definition), 'task');
    await waitForCompletion(orchestrator, workflowId);

    expect(orchestrator.getStatus(workflowId)?.phase).toBe('failed');
    // The reviewer never got a session in the read-write bundle.
    expect(sessionStates).toEqual(['implement']);
  });

  it('runs a builtin reviewer read-only too', async () => {
    const definition = reviewLoop({ mode: 'builtin' });
    const captured: SessionOptions[] = [];
    const createSession = vi.fn((opts: SessionOptions) => {
      captured.push(opts);
      const workspace = opts.workspacePath ?? '';
      const output = opts.workflow?.stateId === 'implement' ? 'code' : 'reviews';
      return Promise.resolve(
        new MockSession({
          responses: () => {
            simulateArtifacts(join(workspace, '..'), [output]);
            return approvedResponse();
          },
        }),
      );
    });

    orchestrator = new WorkflowOrchestrator(createDeps(tmpDir, { createSession }));
    const workflowId = await orchestrator.start(writeDefinitionFile(tmpDir, definition), 'task');
    await waitForCompletion(orchestrator, workflowId);

    expect(orchestrator.getStatus(workflowId)?.phase).toBe('completed');
    const review = captured.find((opts) => opts.workflow?.stateId === 'review');
    expect(review?.mode).toEqual({ kind: 'builtin' });
    expect(review?.workflow?.readOnlyWorkspace?.writablePaths).toEqual(['.workflow/reviews']);
  });
});
