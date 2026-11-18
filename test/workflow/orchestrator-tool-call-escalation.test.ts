/**
 * Tool-call escalations inside workflow runs (WP-35 / TPM-9, DTL-6).
 *
 * The orchestrator is the human route for escalations raised during agent
 * states:
 *   - shared-container bundles hand their coordinator an in-process
 *     `onEscalation` handler (passed to the infrastructure factory);
 *   - per-state sessions (builtin, per-state containers) surface file-IPC
 *     escalations through `SessionOptions.onEscalation`.
 * Either way the escalation is listed by `listToolCallEscalations`, announced
 * as a lifecycle event, logged, and settled by `resolveToolCallEscalation`.
 * An escalation nobody can answer any more (the coordinator stopped waiting,
 * the turn that raised it ended, the run was aborted) is reported as expired
 * and, for a coordinator escalation, withdrawn so the pipeline denies it as
 * cancelled rather than as a human denial.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { BundleId, EscalationRequest, SessionOptions } from '../../src/session/types.js';
import type { ToolCallRequest } from '../../src/types/mcp.js';
import type { WorkflowDefinition, WorkflowId } from '../../src/workflow/types.js';
import type { DockerInfrastructure } from '../../src/docker/docker-infrastructure.js';
import type { IronCurtainConfig } from '../../src/config/types.js';
import {
  WorkflowOrchestrator,
  withWorkflowEscalationRouting,
  type CreateWorkflowInfrastructureInput,
  type WorkflowLifecycleEvent,
} from '../../src/workflow/orchestrator.js';
import type { EscalationPromptFn, EscalationResult } from '../../src/trusted-process/tool-call-coordinator.js';
import { escalationAbortReason, isEscalationWithdrawnError } from '../../src/trusted-process/escalation-wait.js';
import { MessageLog, type MessageLogEntry } from '../../src/workflow/message-log.js';
import {
  MockSession,
  approvedResponse,
  createDeps,
  findWorkflowDir,
  simulateArtifacts,
  stubPersonasForTest,
  waitForCompletion,
  writeDefinitionFile,
} from './test-helpers.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const sharedDef: WorkflowDefinition = {
  name: 'escalation-shared',
  description: 'Shared-container workflow whose agent hits an escalation',
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

const builtinDef: WorkflowDefinition = {
  ...sharedDef,
  name: 'escalation-builtin',
  settings: { mode: 'builtin' },
};

/** Shared-container workflow that parks at a human gate after its agent state. */
const gatedSharedDef: WorkflowDefinition = {
  ...sharedDef,
  name: 'escalation-shared-gated',
  states: {
    work: { ...sharedDef.states.work, transitions: [{ to: 'review' }] } as WorkflowDefinition['states'][string],
    review: {
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

const WRITE_REQUEST: ToolCallRequest = {
  requestId: 'req-1',
  serverName: 'filesystem',
  toolName: 'write_file',
  arguments: { path: '/outside/f.txt', content: 'x' },
  timestamp: new Date().toISOString(),
};

const CANDIDATES = [
  { description: 'Allow writes within /outside', patternId: 'p0' },
] as unknown as Parameters<EscalationPromptFn>[3];

/** Calls the coordinator-side handler the way the security pipeline does. */
function raiseCoordinatorEscalation(
  handler: EscalationPromptFn,
  escalationId: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<EscalationResult> {
  return handler(WRITE_REQUEST, 'Writes outside the workspace require approval.', undefined, CANDIDATES, {
    humanOnly: false,
    escalationId,
    persona: 'global',
    signal,
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function escalationLog(baseDir: string, workflowId: WorkflowId): MessageLogEntry[] {
  return new MessageLog(resolve(baseDir, workflowId, 'messages.jsonl'))
    .readAll()
    .filter((entry) => entry.type === 'tool_call_escalation');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkflowOrchestrator tool-call escalations', () => {
  let tmpDir: string;
  let orchestrator: WorkflowOrchestrator | undefined;
  let cleanupPersonas: (() => void) | undefined;
  let events: WorkflowLifecycleEvent[];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'wf-tool-escalation-'));
    orchestrator = undefined;
    events = [];
    cleanupPersonas = stubPersonasForTest(tmpDir, sharedDef, builtinDef);
  });

  afterEach(async () => {
    await orchestrator?.shutdownAll();
    cleanupPersonas?.();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Starts the shared-container workflow. The single agent turn runs
   * `turn(handler)`, where `handler` is the in-process escalation handler the
   * orchestrator gave the bundle's infrastructure factory.
   */
  async function startShared(turn: (handler: EscalationPromptFn) => Promise<void>): Promise<WorkflowId> {
    let handler: EscalationPromptFn | undefined;
    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) => {
      handler = input.onEscalation;
      return makeStubInfrastructure(input.workflowId, input.bundleId);
    });
    const createSession = vi.fn(
      async () =>
        new MockSession({
          responses: async () => {
            if (!handler) throw new Error('the infrastructure factory got no escalation handler');
            await turn(handler);
            simulateArtifacts(findWorkflowDir(tmpDir), ['result']);
            return approvedResponse();
          },
        }),
    );
    const orch = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        createSession,
        createWorkflowInfrastructure: createInfra,
        destroyWorkflowInfrastructure: async () => {},
      }),
    );
    orchestrator = orch;
    orch.onEvent((event) => events.push(event));
    return orch.start(writeDefinitionFile(tmpDir, sharedDef), 'task');
  }

  it('lists a shared-container escalation and settles it with the human decision', async () => {
    let decision: EscalationResult | undefined;
    const workflowId = await startShared(async (handler) => {
      decision = await raiseCoordinatorEscalation(handler, 'esc-approve');
    });
    const orch = orchestrator as WorkflowOrchestrator;

    await waitFor(() => orch.listToolCallEscalations(workflowId).length === 1);
    const [pending] = orch.listToolCallEscalations(workflowId);
    expect(pending).toMatchObject({
      escalationId: 'esc-approve',
      workflowId,
      stateId: 'work',
      persona: 'global',
      serverName: 'filesystem',
      toolName: 'write_file',
      arguments: { path: '/outside/f.txt', content: 'x' },
      reason: 'Writes outside the workspace require approval.',
    });
    expect(pending.whitelistCandidates).toHaveLength(1);
    expect(events.some((e) => e.kind === 'tool_call_escalation_raised')).toBe(true);

    expect(
      orch.resolveToolCallEscalation(workflowId, 'esc-approve', { decision: 'approved', whitelistSelection: 0 }),
    ).toBe(true);
    // A second answer finds nothing to act on.
    expect(orch.resolveToolCallEscalation(workflowId, 'esc-approve', { decision: 'denied' })).toBe(false);

    await waitForCompletion(orch, workflowId);
    expect(orch.getStatus(workflowId)?.phase).toBe('completed');
    expect(decision).toEqual({ decision: 'approved', whitelistSelection: 0 });
    expect(orch.listToolCallEscalations(workflowId)).toEqual([]);
    expect(events).toContainEqual({
      kind: 'tool_call_escalation_resolved',
      workflowId,
      escalationId: 'esc-approve',
      outcome: 'approved',
    });
    expect(escalationLog(tmpDir, workflowId).map((e) => (e as { outcome: string }).outcome)).toEqual([
      'raised',
      'approved',
    ]);
  });

  it('flags a human-only escalation and approves it once, never with a whitelist selection', async () => {
    // A human-only call (opening a passthrough domain) is decided by a human
    // one escalation at a time and never whitelisted. The pipeline offers it
    // no candidate; the workflow route marks it for the deciders and drops a
    // selection rather than passing one to the coordinator.
    let decision: EscalationResult | undefined;
    const workflowId = await startShared(async (handler) => {
      decision = await handler(
        { ...WRITE_REQUEST, serverName: 'proxy', toolName: 'add_proxy_domain', arguments: { domain: 'example.com' } },
        'Opening a passthrough domain requires approval.',
        undefined,
        undefined,
        { humanOnly: true, escalationId: 'esc-human-only', persona: 'global', signal: new AbortController().signal },
      );
    });
    const orch = orchestrator as WorkflowOrchestrator;

    await waitFor(() => orch.listToolCallEscalations(workflowId).length === 1);
    const [pending] = orch.listToolCallEscalations(workflowId);
    expect(pending).toMatchObject({ escalationId: 'esc-human-only', toolName: 'add_proxy_domain', humanOnly: true });
    expect(pending.whitelistCandidates).toBeUndefined();

    expect(
      orch.resolveToolCallEscalation(workflowId, 'esc-human-only', { decision: 'approved', whitelistSelection: 0 }),
    ).toBe(true);
    await waitForCompletion(orch, workflowId);
    expect(decision).toEqual({ decision: 'approved' });
  });

  it('carries the human-only flag of a per-state session escalation', async () => {
    let releaseTurn: (() => void) | undefined;
    const resolveEscalation = vi.fn(async () => {
      releaseTurn?.();
    });
    const createSession = vi.fn(async (opts: SessionOptions) => {
      const session = new MockSession({
        responses: async () => {
          const turnReleased = new Promise<void>((r) => {
            releaseTurn = r;
          });
          opts.onEscalation?.({
            escalationId: 'file-human-only',
            serverName: 'proxy',
            toolName: 'add_proxy_domain',
            arguments: { domain: 'example.com' },
            reason: 'Opening a passthrough domain requires approval.',
            humanOnly: true,
          });
          await turnReleased;
          simulateArtifacts(findWorkflowDir(tmpDir), ['result']);
          return approvedResponse();
        },
      });
      session.resolveEscalation = resolveEscalation;
      return session;
    });
    const orch = new WorkflowOrchestrator(createDeps(tmpDir, { createSession }));
    orchestrator = orch;
    const workflowId = await orch.start(writeDefinitionFile(tmpDir, builtinDef), 'task');

    await waitFor(() => orch.listToolCallEscalations(workflowId).length === 1);
    expect(orch.listToolCallEscalations(workflowId)[0]).toMatchObject({
      escalationId: 'file-human-only',
      humanOnly: true,
    });
    expect(
      orch.resolveToolCallEscalation(workflowId, 'file-human-only', { decision: 'approved', whitelistSelection: 0 }),
    ).toBe(true);
    await waitForCompletion(orch, workflowId);

    // Approved once: no whitelist selection reaches the session's response file.
    expect(resolveEscalation).toHaveBeenCalledWith('file-human-only', 'approved', {});
  });

  it('reports an escalation the coordinator stopped waiting for as expired', async () => {
    const controller = new AbortController();
    let late: Promise<EscalationResult> | undefined;
    const workflowId = await startShared(async (handler) => {
      late = raiseCoordinatorEscalation(handler, 'esc-timeout', controller.signal);
      late.catch(() => {});
      // The pipeline races the handler against this signal; the turn only
      // continues once it fired.
      await new Promise<void>((r) => controller.signal.addEventListener('abort', () => r(), { once: true }));
    });
    const orch = orchestrator as WorkflowOrchestrator;

    await waitFor(() => orch.listToolCallEscalations(workflowId).length === 1);
    controller.abort(escalationAbortReason('timed-out', 'no decision within the 1s escalation timeout'));

    expect(orch.listToolCallEscalations(workflowId)).toEqual([]);
    expect(orch.resolveToolCallEscalation(workflowId, 'esc-timeout', { decision: 'approved' })).toBe(false);
    expect(events).toContainEqual({
      kind: 'tool_call_escalation_resolved',
      workflowId,
      escalationId: 'esc-timeout',
      outcome: 'expired',
    });
    await waitForCompletion(orch, workflowId);
    expect(escalationLog(tmpDir, workflowId).map((e) => (e as { outcome: string }).outcome)).toEqual([
      'raised',
      'expired',
    ]);
  });

  it('withdraws an escalation once the agent turn that raised it has ended', async () => {
    let pendingDecision: Promise<EscalationResult> | undefined;
    const workflowId = await startShared((handler) => {
      // The turn ends (crash, timeout, drained lane) while its call is still
      // parked in the coordinator.
      pendingDecision = raiseCoordinatorEscalation(handler, 'esc-orphan');
      pendingDecision.catch(() => {});
      return Promise.resolve();
    });
    const orch = orchestrator as WorkflowOrchestrator;

    await waitForCompletion(orch, workflowId);
    const outcome = await (pendingDecision as Promise<EscalationResult>).then(
      () => 'settled',
      (err: unknown) => err,
    );
    // Withdrawn, so the pipeline denies the call as cancelled -- not answered
    // with a fake human denial, and no longer approvable.
    expect(isEscalationWithdrawnError(outcome)).toBe(true);
    expect((outcome as Error).message).toContain('agent turn that raised it has ended');
    expect(orch.listToolCallEscalations(workflowId)).toEqual([]);
    expect(orch.resolveToolCallEscalation(workflowId, 'esc-orphan', { decision: 'approved' })).toBe(false);
    expect(escalationLog(tmpDir, workflowId).map((e) => (e as { outcome: string }).outcome)).toEqual([
      'raised',
      'expired',
    ]);
  });

  it('withdraws at once an escalation raised while no agent turn is live on the bundle', async () => {
    // A process the agent left running in the shared container (or a
    // command a deterministic state runs there) can still reach the
    // bundle's coordinator between agent turns. No turn waits on that call,
    // and an approval would run its side effect under whatever state comes
    // next, so it is never offered to a human.
    let handler: EscalationPromptFn | undefined;
    const createInfra = vi.fn(async (input: CreateWorkflowInfrastructureInput) => {
      handler = input.onEscalation;
      return makeStubInfrastructure(input.workflowId, input.bundleId);
    });
    const createSession = vi.fn(
      async () =>
        new MockSession({
          responses: async () => {
            simulateArtifacts(findWorkflowDir(tmpDir), ['result']);
            return approvedResponse();
          },
        }),
    );
    const raiseGate = vi.fn();
    const orch = new WorkflowOrchestrator(
      createDeps(tmpDir, {
        createSession,
        createWorkflowInfrastructure: createInfra,
        destroyWorkflowInfrastructure: async () => {},
        raiseGate,
      }),
    );
    orchestrator = orch;
    orch.onEvent((event) => events.push(event));
    const workflowId = await orch.start(writeDefinitionFile(tmpDir, gatedSharedDef), 'task');

    // The agent turn is over; the run waits at the gate with the bundle alive.
    await waitFor(() => raiseGate.mock.calls.length === 1);
    expect(orch.getStatus(workflowId)?.phase).toBe('waiting_human');
    if (!handler) throw new Error('the infrastructure factory got no escalation handler');

    const outcome = await raiseCoordinatorEscalation(handler, 'esc-stray').then(
      () => 'settled',
      (err: unknown) => err,
    );
    expect(isEscalationWithdrawnError(outcome)).toBe(true);
    expect((outcome as Error).message).toContain('no agent turn is live');
    expect(orch.listToolCallEscalations(workflowId)).toEqual([]);
    expect(orch.resolveToolCallEscalation(workflowId, 'esc-stray', { decision: 'approved' })).toBe(false);
    expect(events.some((e) => e.kind === 'tool_call_escalation_raised')).toBe(false);
    expect(escalationLog(tmpDir, workflowId)).toEqual([]);
  });

  it('refuses a decision once the run is terminal, before the teardown withdraws it', async () => {
    // abort() claims the terminal status first and only then closes the
    // sessions; an approval landing in between must not run the call.
    let pendingDecision: Promise<EscalationResult> | undefined;
    let settledWith: unknown;
    const workflowId = await startShared(async (handler) => {
      pendingDecision = raiseCoordinatorEscalation(handler, 'esc-late');
      settledWith = await pendingDecision.catch((err: unknown) => err);
    });
    const orch = orchestrator as WorkflowOrchestrator;
    await waitFor(() => orch.listToolCallEscalations(workflowId).length === 1);

    const aborting = orch.abort(workflowId);
    // Same tick as abort(): the terminal status is set, the teardown has
    // not run yet.
    expect(orch.resolveToolCallEscalation(workflowId, 'esc-late', { decision: 'approved' })).toBe(false);
    await aborting;

    expect(isEscalationWithdrawnError(settledWith)).toBe(true);
    expect(orch.listToolCallEscalations(workflowId)).toEqual([]);
    expect(escalationLog(tmpDir, workflowId).map((e) => (e as { outcome: string }).outcome)).toEqual([
      'raised',
      'expired',
    ]);
  });

  it('withdraws every pending escalation when the workflow is aborted', async () => {
    let pendingDecision: Promise<EscalationResult> | undefined;
    const workflowId = await startShared(async (handler) => {
      pendingDecision = raiseCoordinatorEscalation(handler, 'esc-abort');
      await pendingDecision.catch(() => undefined);
    });
    const orch = orchestrator as WorkflowOrchestrator;

    await waitFor(() => orch.listToolCallEscalations(workflowId).length === 1);
    await orch.abort(workflowId);

    const outcome = await (pendingDecision as Promise<EscalationResult>).then(
      () => 'settled',
      (err: unknown) => err,
    );
    expect(isEscalationWithdrawnError(outcome)).toBe(true);
    expect((outcome as Error).message).toContain('aborted');
    expect(orch.listToolCallEscalations(workflowId)).toEqual([]);
  });

  it('routes a per-state session escalation to session.resolveEscalation', async () => {
    let sessionOpts: SessionOptions | undefined;
    let releaseTurn: (() => void) | undefined;
    const resolveEscalation = vi.fn(async () => {
      releaseTurn?.();
    });
    const createSession = vi.fn(async (opts: SessionOptions) => {
      sessionOpts = opts;
      const session = new MockSession({
        responses: async () => {
          const request: EscalationRequest = {
            escalationId: 'file-esc',
            serverName: 'filesystem',
            toolName: 'write_file',
            arguments: { path: '/outside/f.txt' },
            reason: 'Writes outside the workspace require approval.',
          };
          // The session's escalation watcher found a request file.
          const turnReleased = new Promise<void>((r) => {
            releaseTurn = r;
          });
          opts.onEscalation?.(request);
          await turnReleased;
          simulateArtifacts(findWorkflowDir(tmpDir), ['result']);
          return approvedResponse();
        },
      });
      session.resolveEscalation = resolveEscalation;
      return session;
    });
    const orch = new WorkflowOrchestrator(createDeps(tmpDir, { createSession }));
    orchestrator = orch;
    const workflowId = await orch.start(writeDefinitionFile(tmpDir, builtinDef), 'task');

    await waitFor(() => orch.listToolCallEscalations(workflowId).length === 1);
    expect(orch.listToolCallEscalations(workflowId)[0]).toMatchObject({
      escalationId: 'file-esc',
      stateId: 'work',
      persona: 'global',
    });
    expect(orch.resolveToolCallEscalation(workflowId, 'file-esc', { decision: 'denied' })).toBe(true);
    await waitForCompletion(orch, workflowId);

    expect(resolveEscalation).toHaveBeenCalledWith('file-esc', 'denied', {});
    expect(sessionOpts?.onEscalationExpired).toBeTypeOf('function');
    expect(escalationLog(tmpDir, workflowId).map((e) => (e as { outcome: string }).outcome)).toEqual([
      'raised',
      'denied',
    ]);
  });

  it('expires a per-state session escalation when its watcher reports expiry', async () => {
    let expire: ((escalationId: string) => void) | undefined;
    let releaseTurn: (() => void) | undefined;
    const createSession = vi.fn(
      async (opts: SessionOptions) =>
        new MockSession({
          responses: async () => {
            expire = opts.onEscalationExpired;
            const turnReleased = new Promise<void>((r) => {
              releaseTurn = r;
            });
            opts.onEscalation?.({
              escalationId: 'file-expire',
              serverName: 'filesystem',
              toolName: 'write_file',
              arguments: {},
              reason: 'r',
            });
            // A parallel tool call of the same session escalates too.
            opts.onEscalation?.({
              escalationId: 'file-keep',
              serverName: 'filesystem',
              toolName: 'delete_file',
              arguments: {},
              reason: 'r',
            });
            await turnReleased;
            simulateArtifacts(findWorkflowDir(tmpDir), ['result']);
            return approvedResponse();
          },
        }),
    );
    const orch = new WorkflowOrchestrator(createDeps(tmpDir, { createSession }));
    orchestrator = orch;
    const workflowId = await orch.start(writeDefinitionFile(tmpDir, builtinDef), 'task');

    await waitFor(() => orch.listToolCallEscalations(workflowId).length === 2);
    // Only the escalation that expired goes; the session's other one stays.
    expire?.('file-expire');
    expect(orch.listToolCallEscalations(workflowId).map((e) => e.escalationId)).toEqual(['file-keep']);
    expire?.('file-keep');
    expect(orch.listToolCallEscalations(workflowId)).toEqual([]);
    releaseTurn?.();
    await waitForCompletion(orch, workflowId);
    expect(escalationLog(tmpDir, workflowId).map((e) => (e as { outcome: string }).outcome)).toEqual([
      'raised',
      'raised',
      'expired',
      'expired',
    ]);
  });

  it('expires what a session created after the abort surfaced while it was being closed', async () => {
    // WP-48: a session that createSession hands back after abort() is closed
    // unused, outside abort()'s own close-and-sweep. What its watcher surfaces
    // meanwhile can no longer be answered, so it must not stay pending.
    let sessionOpts: SessionOptions | undefined;
    let releaseSession: ((session: MockSession) => void) | undefined;
    const createSession = vi.fn(
      (opts: SessionOptions) =>
        new Promise<MockSession>((r) => {
          sessionOpts = opts;
          releaseSession = r;
        }),
    );
    const orch = new WorkflowOrchestrator(createDeps(tmpDir, { createSession }));
    orchestrator = orch;
    const workflowId = await orch.start(writeDefinitionFile(tmpDir, builtinDef), 'task');
    await waitFor(() => releaseSession !== undefined);

    await orch.abort(workflowId);

    const late = new MockSession({ responses: () => approvedResponse() });
    const closeSession = late.close.bind(late);
    late.close = async () => {
      // The watcher finds a request file while the session shuts down.
      sessionOpts?.onEscalation?.({
        escalationId: 'late-esc',
        serverName: 'filesystem',
        toolName: 'write_file',
        arguments: {},
        reason: 'r',
      });
      await closeSession();
    };
    releaseSession?.(late);
    await waitFor(() => late.closed);
    await new Promise((r) => setTimeout(r, 20));

    expect(late.sentMessages).toHaveLength(0);
    expect(orch.listToolCallEscalations(workflowId)).toEqual([]);
    expect(escalationLog(tmpDir, workflowId).map((e) => (e as { outcome: string }).outcome)).toEqual([
      'raised',
      'expired',
    ]);
  });
});

describe('withWorkflowEscalationRouting', () => {
  it('points the bundle at its escalation dir and switches the auto-approver off', () => {
    const config = {
      escalationDir: undefined,
      userConfig: { autoApprove: { enabled: true, modelId: 'anthropic:claude-haiku-4-5' } },
    } as unknown as IronCurtainConfig;

    const routed = withWorkflowEscalationRouting(config, '/bundle/escalations');

    expect(routed.escalationDir).toBe('/bundle/escalations');
    expect(routed.userConfig.autoApprove).toEqual({ enabled: false, modelId: 'anthropic:claude-haiku-4-5' });
    // The loaded config is not mutated.
    expect(config.userConfig.autoApprove.enabled).toBe(true);
  });
});
