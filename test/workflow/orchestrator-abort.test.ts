/**
 * abort() stops the work that is in flight when it runs (WP-48): a session that
 * createSession hands back after the abort is closed and never sent a turn, a
 * turn that returns after it is not followed by another, fan-out lanes (free-
 * standing root actors) are stopped, a resumed state's replayed invocation is
 * covered too, a running host command is killed, and shutdownAll() records the
 * caller's reason and refuses later starts.
 *
 * Fake sessions and gated promises only: no LLM, no Docker.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { Session } from '../../src/session/types.js';
import type { WorkflowDefinition, WorkflowId } from '../../src/workflow/types.js';
import { WorkflowOrchestrator, type WorkflowLifecycleEvent } from '../../src/workflow/orchestrator.js';
import { FileCheckpointStore } from '../../src/workflow/checkpoint.js';
import {
  MockSession,
  approvedResponse,
  createDeps,
  noStatusResponse,
  waitForCompletion,
  waitForGate,
  writeDefinitionFile,
} from './test-helpers.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolveFn!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolveFn = r;
  });
  return { promise, resolve: resolveFn };
}

/** Lets every pending promise continuation and timer of the fakes run. */
async function settleAsync(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 5));
}

const singleAgentDef: WorkflowDefinition = {
  name: 'abort-single-agent',
  description: 'One agent state, then done',
  initial: 'work',
  settings: { mode: 'builtin', maxRounds: 3 },
  states: {
    work: {
      type: 'agent',
      description: 'Does the work',
      persona: 'global',
      prompt: 'You are a worker.',
      inputs: [],
      outputs: [],
      transitions: [{ to: 'done' }],
    },
    done: { type: 'terminal', description: 'Done' },
  },
};

const fanOutDef: WorkflowDefinition = {
  name: 'abort-fanout',
  description: 'Two concurrent agent lanes',
  initial: 'workers',
  settings: { mode: 'builtin', workers: 2, maxRounds: 3 },
  states: {
    workers: {
      type: 'deterministic',
      description: 'Runs the lanes',
      run: [],
      fanOut: { count: 'workers', join: 'barrier' },
      segment: ['research', 'review'],
      transitions: [{ to: 'done', when: { verdict: 'recorded' } }, { to: 'failed' }],
    },
    research: {
      type: 'agent',
      description: 'Researches',
      persona: 'global',
      prompt: 'You are a researcher.',
      inputs: [],
      outputs: [],
      fanOutMember: true,
      transitions: [{ to: 'review' }],
    },
    review: {
      type: 'agent',
      description: 'Reviews',
      persona: 'global',
      prompt: 'You are a reviewer.',
      inputs: [],
      outputs: [],
      fanOutMember: true,
      transitions: [{ to: 'done' }],
    },
    done: { type: 'terminal', description: 'Done' },
    failed: { type: 'terminal', description: 'Failed' },
  },
};

const gateFirstDef: WorkflowDefinition = {
  name: 'abort-gate-first',
  description: 'Starts at a gate',
  initial: 'approve',
  settings: { mode: 'builtin', maxRounds: 2 },
  states: {
    approve: {
      type: 'human_gate',
      description: 'Approve',
      acceptedEvents: ['APPROVE', 'ABORT'],
      transitions: [
        { to: 'done', event: 'APPROVE' },
        { to: 'aborted', event: 'ABORT' },
      ],
    },
    done: { type: 'terminal', description: 'Done' },
    aborted: { type: 'terminal', description: 'Aborted' },
  },
};

function messageLogTypes(baseDir: string, workflowId: WorkflowId): Array<{ type: string; phase?: string }> {
  const path = resolve(baseDir, workflowId, 'messages.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; phase?: string });
}

/** Internal state the tests inspect through bracket access. */
interface OrchestratorInternals {
  workflows: Map<WorkflowId, { fanOutChildren: Set<unknown>; activeSessions: Set<Session> }>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkflowOrchestrator abort stops in-flight work', () => {
  let tmpDir: string;
  const orchestrators: WorkflowOrchestrator[] = [];

  function track(orchestrator: WorkflowOrchestrator): WorkflowOrchestrator {
    orchestrators.push(orchestrator);
    return orchestrator;
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'wf-abort-'));
  });

  afterEach(async () => {
    for (const orchestrator of orchestrators.splice(0)) {
      await orchestrator.shutdownAll().catch(() => {});
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('joins a session already closing before declaring the abort ready', async () => {
    const closing = deferred<undefined>();
    const releaseClose = deferred<undefined>();
    const session = new MockSession({ responses: () => approvedResponse() });
    session.close = vi.fn(async () => {
      closing.resolve(undefined);
      await releaseClose.promise;
    });
    const deps = createDeps(tmpDir, { createSession: async () => session });
    const orchestrator = track(new WorkflowOrchestrator(deps));
    const workflowId = await orchestrator.start(writeDefinitionFile(tmpDir, singleAgentDef), 'task');
    await closing.promise;
    const stopping = orchestrator.abort(workflowId);
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    try {
      await settleAsync();
      expect(stopped).toBe(false);
      expect(session.close).toHaveBeenCalledTimes(1);
      expect(deps.checkpointStore.load(workflowId)?.usageSettlementPending).toBe(true);
    } finally {
      releaseClose.resolve(undefined);
      await stopping;
    }
    expect(stopped).toBe(true);
  });

  it('closes a session created after the abort and never sends it a turn', async () => {
    const defPath = writeDefinitionFile(tmpDir, singleAgentDef);
    const sessionGate = deferred<Session>();
    const createSession = vi.fn(() => sessionGate.promise);
    const events: WorkflowLifecycleEvent[] = [];
    const orchestrator = track(new WorkflowOrchestrator(createDeps(tmpDir, { createSession })));
    orchestrator.onEvent((event) => events.push(event));

    const workflowId = await orchestrator.start(defPath, 'task');
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1), { timeout: 2000, interval: 5 });

    await orchestrator.abort(workflowId);
    expect(orchestrator.getStatus(workflowId)?.phase).toBe('aborted');

    // createSession completes only now, after the abort returned.
    const late = new MockSession({ responses: () => approvedResponse() });
    sessionGate.resolve(late);
    await settleAsync();

    expect(late.closed).toBe(true);
    expect(late.sentMessages).toHaveLength(0);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.kind === 'agent_started')).toBe(false);
    const internals = orchestrator as unknown as OrchestratorInternals;
    expect(internals.workflows.get(workflowId)?.activeSessions.size).toBe(0);
    // Nothing the late session would have caused reaches the log after the
    // terminal marker.
    const log = messageLogTypes(tmpDir, workflowId);
    expect(log.at(-1)).toMatchObject({ type: 'run_terminal', phase: 'aborted' });
    expect(log.some((entry) => entry.type === 'agent_sent' || entry.type === 'error')).toBe(false);
  });

  it('does not continue the conversation when an in-flight turn returns after the abort', async () => {
    const defPath = writeDefinitionFile(tmpDir, singleAgentDef);
    const turnGate = deferred<string>();
    const session = new MockSession({ responses: () => turnGate.promise });
    const orchestrator = track(
      new WorkflowOrchestrator(createDeps(tmpDir, { createSession: vi.fn(async () => session) })),
    );

    const workflowId = await orchestrator.start(defPath, 'task');
    await vi.waitFor(() => expect(session.sentMessages).toHaveLength(1), { timeout: 2000, interval: 5 });

    await orchestrator.abort(workflowId);
    expect(session.closed).toBe(true);

    // A response without a status block would normally trigger recovery turns.
    turnGate.resolve(noStatusResponse());
    await settleAsync();

    expect(session.sentMessages).toHaveLength(1);
    const log = messageLogTypes(tmpDir, workflowId);
    expect(log.at(-1)).toMatchObject({ type: 'run_terminal', phase: 'aborted' });
    expect(log.some((entry) => entry.type === 'agent_received' || entry.type === 'agent_retry')).toBe(false);
  });

  it('stops every fan-out lane: no lane creates a session or sends a turn after the abort', async () => {
    const defPath = writeDefinitionFile(tmpDir, fanOutDef);
    const turnGates = [deferred<string>(), deferred<string>()];
    const sessions: MockSession[] = [];
    const createSession = vi.fn(async () => {
      const lane = sessions.length;
      const session: MockSession = new MockSession({
        sessionId: `lane-${lane}-${sessions.length}`,
        // The first turn of each lane blocks until released; any later turn
        // (the next segment member, a recovery turn) would answer at once.
        responses: (msg) => (lane < 2 && session.sentMessages.length === 1 ? turnGates[lane].promise : msg),
      });
      sessions.push(session);
      return session;
    });
    const orchestrator = track(new WorkflowOrchestrator(createDeps(tmpDir, { createSession })));
    const internals = orchestrator as unknown as OrchestratorInternals;

    const workflowId = await orchestrator.start(defPath, 'task');
    await vi.waitFor(
      () => {
        expect(sessions).toHaveLength(2);
        expect(sessions.every((s) => s.sentMessages.length === 1)).toBe(true);
      },
      { timeout: 2000, interval: 5 },
    );
    expect(internals.workflows.get(workflowId)?.fanOutChildren.size).toBe(2);

    await orchestrator.abort(workflowId);
    expect(orchestrator.getStatus(workflowId)?.phase).toBe('aborted');
    expect(sessions.every((s) => s.closed)).toBe(true);

    // Both lanes' turns now return a routable status: without the stop each
    // lane would move on to `review` and open a new session.
    turnGates[0].resolve(approvedResponse('lane 0'));
    turnGates[1].resolve(approvedResponse('lane 1'));
    await settleAsync(10);

    expect(createSession).toHaveBeenCalledTimes(2);
    expect(sessions.map((s) => s.sentMessages.length)).toEqual([1, 1]);
    expect(internals.workflows.get(workflowId)?.fanOutChildren.size).toBe(0);
    const log = messageLogTypes(tmpDir, workflowId);
    expect(log.at(-1)).toMatchObject({ type: 'run_terminal', phase: 'aborted' });
  });

  it('stops a resumed agent state whose invocation was replayed outside the actor', async () => {
    const defPath = writeDefinitionFile(tmpDir, singleAgentDef);
    const checkpointStore = new FileCheckpointStore(tmpDir);
    const first = track(
      new WorkflowOrchestrator(
        createDeps(tmpDir, {
          checkpointStore,
          createSession: vi.fn(() => new Promise<Session>(() => {})),
        }),
      ),
    );
    const workflowId = await first.start(defPath, 'task');
    await first.abort(workflowId);

    const sessionGate = deferred<Session>();
    const createSession = vi.fn(() => sessionGate.promise);
    const resumed = track(new WorkflowOrchestrator(createDeps(tmpDir, { checkpointStore, createSession })));
    await resumed.resume(workflowId);
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1), { timeout: 2000, interval: 5 });

    await resumed.abort(workflowId);
    const late = new MockSession({ responses: () => approvedResponse() });
    sessionGate.resolve(late);
    await settleAsync();

    expect(late.closed).toBe(true);
    expect(late.sentMessages).toHaveLength(0);
    expect(resumed.getStatus(workflowId)?.phase).toBe('aborted');
  });

  it('kills a running host command and starts none of the commands after it', async () => {
    const pidFile = join(tmpDir, 'child.pid');
    const markerFile = join(tmpDir, 'second-command-ran');
    const hostDef: WorkflowDefinition = {
      name: 'abort-host-command',
      description: 'A long host command followed by another',
      initial: 'build',
      settings: { mode: 'builtin', maxRounds: 2 },
      states: {
        build: {
          type: 'deterministic',
          description: 'Runs host commands',
          // Host commands need the explicit acknowledgement (WP-47).
          host: true,
          run: [
            [
              process.execPath,
              '-e',
              `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
            ],
            [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(markerFile)}, 'ran');`],
          ],
          transitions: [{ to: 'done' }],
        },
        done: { type: 'terminal', description: 'Done' },
      },
    };
    const defPath = writeDefinitionFile(tmpDir, hostDef);
    const orchestrator = track(new WorkflowOrchestrator(createDeps(tmpDir)));

    const workflowId = await orchestrator.start(defPath, 'task');
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 10_000, interval: 20 });
    const pid = Number(readFileSync(pidFile, 'utf8'));

    await orchestrator.abort(workflowId);

    await vi.waitFor(
      () => {
        expect(() => process.kill(pid, 0)).toThrow();
      },
      { timeout: 5000, interval: 20 },
    );
    await settleAsync();
    expect(existsSync(markerFile)).toBe(false);
    expect(orchestrator.getStatus(workflowId)?.phase).toBe('aborted');
  });

  it('records the caller reason and refuses new runs once shutdownAll began', async () => {
    const defPath = writeDefinitionFile(tmpDir, gateFirstDef);
    const raiseGate = vi.fn();
    const checkpointStore = new FileCheckpointStore(tmpDir);
    const events: WorkflowLifecycleEvent[] = [];
    const orchestrator = track(new WorkflowOrchestrator(createDeps(tmpDir, { raiseGate, checkpointStore })));
    orchestrator.onEvent((event) => events.push(event));

    const workflowId = await orchestrator.start(defPath, 'task');
    await waitForGate(raiseGate, 1);

    await orchestrator.shutdownAll({ reason: 'Daemon shutdown' });

    expect(orchestrator.getStatus(workflowId)).toEqual({ phase: 'aborted', reason: 'Daemon shutdown' });
    expect(checkpointStore.load(workflowId)?.finalStatus).toEqual({ phase: 'aborted', reason: 'Daemon shutdown' });
    expect(events).toContainEqual({ kind: 'failed', workflowId, error: 'Daemon shutdown', phase: 'aborted' });
    expect(messageLogTypes(tmpDir, workflowId).at(-1)).toMatchObject({ type: 'run_terminal', phase: 'aborted' });

    await expect(orchestrator.start(defPath, 'another task')).rejects.toThrow(/shutting down/);
    await expect(orchestrator.resume(workflowId)).rejects.toThrow(/shutting down/);
  });

  it('releases a policy swap that waits on another persona turn once the run stops', async () => {
    const orchestrator = track(new WorkflowOrchestrator(createDeps(tmpDir)));
    const stopController = new AbortController();
    const otherTurn = { persona: 'reviewer', ended: new Promise<void>(() => {}) };
    const instance = {
      id: 'wf-swap-wait' as WorkflowId,
      stopController,
      liveAgentTurnsByBundle: new Map([['bundle-1', new Set([otherTurn])]]),
      tab: { write: vi.fn(), setLabel: vi.fn(), close: vi.fn() },
    };
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const waiting = (
        orchestrator as unknown as {
          waitForOtherPersonaTurns(instance: unknown, bundle: { bundleId: string }, persona: string): Promise<void>;
        }
      ).waitForOtherPersonaTurns(instance, { bundleId: 'bundle-1' }, 'coder');
      let settledEarly = false;
      void waiting.then(
        () => (settledEarly = true),
        () => (settledEarly = true),
      );
      await settleAsync(2);
      // The other persona's turn never ends: the swap waits for it...
      expect(settledEarly).toBe(false);

      // ...until the run stops, which releases the wait instead of leaving it
      // pending forever.
      stopController.abort();
      await expect(waiting).rejects.toThrow(/is stopping/);
    } finally {
      stderr.mockRestore();
    }
  });

  it('keeps the default reason for a plain abort', async () => {
    const defPath = writeDefinitionFile(tmpDir, gateFirstDef);
    const raiseGate = vi.fn();
    const orchestrator = track(new WorkflowOrchestrator(createDeps(tmpDir, { raiseGate })));

    const workflowId = await orchestrator.start(defPath, 'task');
    await waitForGate(raiseGate, 1);
    await orchestrator.abort(workflowId);
    await waitForCompletion(orchestrator, workflowId);

    expect(orchestrator.getStatus(workflowId)).toEqual({ phase: 'aborted', reason: 'Workflow aborted by user' });
  });
});
