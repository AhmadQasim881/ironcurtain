/**
 * Gate binding: a human-gate decision is tied to one raise of one gate.
 *
 * Covers the pure rules in `src/workflow/gate-binding.ts` and the
 * orchestrator behaviour built on them:
 *   - every entry into a gate state mints a new per-raise id, stable across
 *     status polls and persisted in the checkpoint;
 *   - a decision quoting an earlier visit's id is refused (GATE_MISMATCH),
 *     an event the gate does not route is refused (EVENT_NOT_ACCEPTED), and
 *     a refusal mutates nothing: the run keeps waiting at the same id, the
 *     gate is not dismissed or re-raised, and no `gate_resolved` is logged;
 *   - resume keeps the id a decider already read (and mints a fresh one for
 *     a legacy checkpoint without it);
 *   - `gate_raised` / `gate_resolved` log entries carry the id and channel.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SessionOptions } from '../../src/session/types.js';
import type {
  HumanGateEvent,
  HumanGateStateDefinition,
  WorkflowCheckpoint,
  WorkflowDefinition,
  WorkflowId,
} from '../../src/workflow/types.js';
import { WorkflowOrchestrator, type WorkflowLifecycleEvent } from '../../src/workflow/orchestrator.js';
import { GateResolutionError, isGateResolutionError } from '../../src/workflow/errors.js';
import {
  acceptedGateEvents,
  assertGateResolutionAllowed,
  isGateIdFor,
  mintGateId,
} from '../../src/workflow/gate-binding.js';
import type { GateResolvedEntry, GateRaisedEntry, MessageLogEntry } from '../../src/workflow/message-log.js';
import {
  approvedResponse,
  createArtifactAwareSession,
  writeDefinitionFile,
  createDeps,
  createCheckpointStore,
  waitForGate,
  waitForCompletion,
  stubPersonasForTest,
} from './test-helpers.js';

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

const reviewGate: HumanGateStateDefinition = {
  type: 'human_gate',
  description: 'Review',
  acceptedEvents: ['APPROVE', 'FORCE_REVISION', 'ABORT'],
  transitions: [
    { to: 'implement', event: 'APPROVE' },
    { to: 'plan', event: 'FORCE_REVISION' },
    { to: 'aborted', event: 'ABORT' },
  ],
};

function decision(overrides: Partial<HumanGateEvent> = {}): HumanGateEvent {
  return { gateId: 'wf-1-review-1-aaaa', type: 'APPROVE', resolvedBy: 'cli', ...overrides };
}

function codeOf(fn: () => void): string | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return isGateResolutionError(err) ? err.code : `unexpected: ${String(err)}`;
  }
}

describe('mintGateId', () => {
  it('embeds workflow, gate and visit and never repeats', () => {
    const ids = new Set(Array.from({ length: 50 }, () => mintGateId('wf-1', 'review', 2)));
    expect(ids.size).toBe(50);
    for (const id of ids) {
      expect(id.startsWith('wf-1-review-2-')).toBe(true);
      expect(id.slice('wf-1-review-2-'.length)).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('clamps a missing or invalid visit ordinal to 1', () => {
    expect(mintGateId('wf', 'g', 0).startsWith('wf-g-1-')).toBe(true);
    expect(mintGateId('wf', 'g', -3).startsWith('wf-g-1-')).toBe(true);
    expect(mintGateId('wf', 'g', Number.NaN).startsWith('wf-g-1-')).toBe(true);
  });
});

describe('isGateIdFor', () => {
  const workflowId = '3f2a9c1e-7b4d-4e8a-9c0f-1a2b3c4d5e6f';

  it('recognises ids minted for that gate of that run', () => {
    expect(isGateIdFor(mintGateId(workflowId, 'review', 1), workflowId, 'review')).toBe(true);
    expect(isGateIdFor(mintGateId(workflowId, 'review', 12), workflowId, 'review')).toBe(true);
  });

  it('rejects ids of another gate, another run, an older format or a non-string', () => {
    // Another gate, including one whose name extends this one.
    expect(isGateIdFor(mintGateId(workflowId, 'review_2', 1), workflowId, 'review')).toBe(false);
    expect(isGateIdFor(mintGateId(workflowId, 'plan_review', 1), workflowId, 'review')).toBe(false);
    // Another run.
    expect(isGateIdFor(mintGateId('wf-other', 'review', 1), workflowId, 'review')).toBe(false);
    // The pre-binding deterministic spelling and other malformed tails.
    expect(isGateIdFor(`${workflowId}-review`, workflowId, 'review')).toBe(false);
    expect(isGateIdFor(`${workflowId}-review-1-abc`, workflowId, 'review')).toBe(false);
    expect(isGateIdFor(`${workflowId}-review-0-0123456789abcdef`, workflowId, 'review')).toBe(false);
    expect(isGateIdFor(`${workflowId}-review-1-0123456789ABCDEF`, workflowId, 'review')).toBe(false);
    expect(isGateIdFor(`${workflowId}-review-1-0123456789abcdef-x`, workflowId, 'review')).toBe(false);
    expect(isGateIdFor(undefined, workflowId, 'review')).toBe(false);
    expect(isGateIdFor(42, workflowId, 'review')).toBe(false);
  });
});

describe('acceptedGateEvents', () => {
  it('is the intersection of acceptedEvents and the compiled transitions', () => {
    expect(acceptedGateEvents(reviewGate)).toEqual(['APPROVE', 'FORCE_REVISION', 'ABORT']);
    // Declared but without a transition: XState would drop it, so it is not accepted.
    const declaredOnly: HumanGateStateDefinition = { ...reviewGate, acceptedEvents: ['APPROVE', 'REPLAN'] };
    expect(acceptedGateEvents(declaredOnly)).toEqual(['APPROVE']);
    // Transition present but not declared: not offered to deciders, so not accepted either.
    const transitionOnly: HumanGateStateDefinition = { ...reviewGate, acceptedEvents: ['APPROVE'] };
    expect(acceptedGateEvents(transitionOnly)).toEqual(['APPROVE']);
  });

  it('keeps the declared order and lists each event once', () => {
    const reordered: HumanGateStateDefinition = {
      ...reviewGate,
      acceptedEvents: ['ABORT', 'APPROVE', 'ABORT', 'FORCE_REVISION'],
    };
    expect(acceptedGateEvents(reordered)).toEqual(['ABORT', 'APPROVE', 'FORCE_REVISION']);
  });
});

describe('assertGateResolutionAllowed', () => {
  const target = { workflowId: 'wf-1', activeGateId: 'wf-1-review-1-aaaa', gate: reviewGate };

  it('accepts a decision bound to the active raise with an accepted event', () => {
    expect(codeOf(() => assertGateResolutionAllowed(target, decision()))).toBeUndefined();
    expect(
      codeOf(() => assertGateResolutionAllowed(target, decision({ type: 'FORCE_REVISION', prompt: 'more tests' }))),
    ).toBeUndefined();
  });

  it('refuses when the workflow is not waiting at a gate', () => {
    expect(codeOf(() => assertGateResolutionAllowed({ ...target, activeGateId: undefined }, decision()))).toBe(
      'WORKFLOW_NOT_AT_GATE',
    );
    expect(codeOf(() => assertGateResolutionAllowed({ ...target, gate: undefined }, decision()))).toBe(
      'WORKFLOW_NOT_AT_GATE',
    );
  });

  it('refuses a decision naming another raise, before any other check', () => {
    expect(codeOf(() => assertGateResolutionAllowed(target, decision({ gateId: 'wf-1-review-2-bbbb' })))).toBe(
      'GATE_MISMATCH',
    );
    // Missing or non-string ids never match.
    expect(
      codeOf(() => assertGateResolutionAllowed(target, { type: 'APPROVE', resolvedBy: 'cli' } as HumanGateEvent)),
    ).toBe('GATE_MISMATCH');
    // Stale id AND missing feedback: the binding error wins.
    expect(
      codeOf(() =>
        assertGateResolutionAllowed(target, decision({ gateId: 'wf-1-review-2-bbbb', type: 'FORCE_REVISION' })),
      ),
    ).toBe('GATE_MISMATCH');
  });

  it('does not hand the active id to a decider whose id is stale', () => {
    // The decider must re-read (and review) the gate, not retry blind with an id from the error.
    expect(() => assertGateResolutionAllowed(target, decision({ gateId: 'wf-1-review-2-bbbb' }))).toThrow(
      /re-read the gate/,
    );
    let message = '';
    try {
      assertGateResolutionAllowed(target, decision({ gateId: 'wf-1-review-2-bbbb' }));
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('wf-1-review-2-bbbb');
    expect(message).not.toContain(target.activeGateId);
  });

  it('refuses an event the gate does not transition on', () => {
    expect(codeOf(() => assertGateResolutionAllowed(target, decision({ type: 'REPLAN', prompt: 'redo' })))).toBe(
      'EVENT_NOT_ACCEPTED',
    );
  });

  it('refuses feedback events without feedback', () => {
    expect(codeOf(() => assertGateResolutionAllowed(target, decision({ type: 'FORCE_REVISION' })))).toBe(
      'FEEDBACK_REQUIRED',
    );
    expect(codeOf(() => assertGateResolutionAllowed(target, decision({ type: 'FORCE_REVISION', prompt: ' \n' })))).toBe(
      'FEEDBACK_REQUIRED',
    );
  });

  it('throws GateResolutionError instances recognisable by code', () => {
    expect(() => assertGateResolutionAllowed(target, decision({ gateId: 'nope' }))).toThrow(GateResolutionError);
    expect(isGateResolutionError({ code: 'GATE_MISMATCH' })).toBe(true);
    expect(isGateResolutionError({ code: 'WORKFLOW_ALREADY_ACTIVE' })).toBe(false);
    expect(isGateResolutionError(new Error('x'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Orchestrator behaviour
// ---------------------------------------------------------------------------

const gatedDef: WorkflowDefinition = {
  name: 'gate-binding',
  description: 'plan -> plan_gate -> implement -> done; FORCE_REVISION loops back to plan',
  initial: 'plan',
  settings: { mode: 'builtin', maxRounds: 6 },
  states: {
    plan: {
      type: 'agent',
      description: 'Creates a plan',
      persona: 'planner',
      freshSession: false,
      prompt: 'You are a planner.',
      inputs: [],
      outputs: ['plan'],
      transitions: [{ to: 'plan_gate' }],
    },
    plan_gate: {
      type: 'human_gate',
      description: 'Human review gate',
      acceptedEvents: ['APPROVE', 'FORCE_REVISION', 'ABORT'],
      present: ['plan'],
      transitions: [
        { to: 'implement', event: 'APPROVE' },
        { to: 'plan', event: 'FORCE_REVISION' },
        { to: 'aborted', event: 'ABORT' },
      ],
    },
    implement: {
      type: 'agent',
      description: 'Writes code',
      persona: 'coder',
      prompt: 'You are a coder.',
      inputs: ['plan'],
      outputs: ['code'],
      transitions: [{ to: 'done' }],
    },
    done: { type: 'terminal', description: 'Done' },
    aborted: { type: 'terminal', description: 'Aborted' },
  },
};

function makeSessionFactory(tmpDir: string) {
  return vi.fn(async (opts: SessionOptions) => {
    switch (opts.persona) {
      case 'planner':
        return createArtifactAwareSession([{ text: approvedResponse('plan complete'), artifacts: ['plan'] }], tmpDir);
      case 'coder':
        return createArtifactAwareSession([{ text: approvedResponse('code complete'), artifacts: ['code'] }], tmpDir);
      default:
        throw new Error(`Unexpected persona: ${String(opts.persona)}`);
    }
  });
}

function readLog(tmpDir: string, workflowId: WorkflowId): MessageLogEntry[] {
  return readFileSync(resolve(tmpDir, workflowId, 'messages.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as MessageLogEntry);
}

function gateResolvedEntries(tmpDir: string, workflowId: WorkflowId): GateResolvedEntry[] {
  return readLog(tmpDir, workflowId).filter((e): e is GateResolvedEntry => e.type === 'gate_resolved');
}

function gateRaisedEntries(tmpDir: string, workflowId: WorkflowId): GateRaisedEntry[] {
  return readLog(tmpDir, workflowId).filter((e): e is GateRaisedEntry => e.type === 'gate_raised');
}

function activeGateId(orchestrator: WorkflowOrchestrator, workflowId: WorkflowId): string {
  const status = orchestrator.getStatus(workflowId);
  if (status?.phase !== 'waiting_human') throw new Error(`not waiting: ${JSON.stringify(status)}`);
  return status.gate.gateId;
}

describe('WorkflowOrchestrator gate binding', () => {
  let tmpDir: string;
  const orchestrators: WorkflowOrchestrator[] = [];
  let cleanupPersonas: (() => void) | undefined;

  function track(orchestrator: WorkflowOrchestrator): WorkflowOrchestrator {
    orchestrators.push(orchestrator);
    return orchestrator;
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'gate-binding-test-'));
    cleanupPersonas = stubPersonasForTest(tmpDir, gatedDef);
  });

  afterEach(async () => {
    for (const orchestrator of orchestrators.splice(0)) {
      await orchestrator.shutdownAll();
    }
    cleanupPersonas?.();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects a decision minted for visit 1 on visit 2 of the same gate and logs nothing for it', async () => {
    const defPath = writeDefinitionFile(tmpDir, gatedDef);
    const raiseGate = vi.fn();
    const dismissGate = vi.fn();
    const deps = createDeps(tmpDir, { createSession: makeSessionFactory(tmpDir), raiseGate, dismissGate });
    const orchestrator = track(new WorkflowOrchestrator(deps));
    const raisedEvents: string[] = [];
    orchestrator.onEvent((e: WorkflowLifecycleEvent) => {
      if (e.kind === 'gate_raised') raisedEvents.push(e.gate.gateId);
    });

    const workflowId = await orchestrator.start(defPath, 'build it');
    const [firstGate] = await waitForGate(raiseGate, 1);
    const visit1 = firstGate.gateId;
    expect(visit1.startsWith(`${workflowId}-plan_gate-1-`)).toBe(true);
    // The id is stable across polls and matches what was raised.
    expect(activeGateId(orchestrator, workflowId)).toBe(visit1);
    expect(activeGateId(orchestrator, workflowId)).toBe(visit1);
    expect(raiseGate).toHaveBeenCalledTimes(1);

    orchestrator.resolveGate(workflowId, {
      gateId: visit1,
      type: 'FORCE_REVISION',
      prompt: 'add error handling',
      resolvedBy: 'web-ui',
    });
    expect(dismissGate).toHaveBeenCalledWith(workflowId, visit1);

    const [, secondGate] = await waitForGate(raiseGate, 2);
    const visit2 = secondGate.gateId;
    expect(visit2).not.toBe(visit1);
    expect(visit2.startsWith(`${workflowId}-plan_gate-2-`)).toBe(true);
    expect(activeGateId(orchestrator, workflowId)).toBe(visit2);
    expect(raisedEvents).toEqual([visit1, visit2]);

    // A stale approval from the first visit must not land on the second.
    let thrown: unknown;
    try {
      orchestrator.resolveGate(workflowId, { gateId: visit1, type: 'APPROVE', resolvedBy: 'cli' });
    } catch (err) {
      thrown = err;
    }
    expect(isGateResolutionError(thrown) && thrown.code).toBe('GATE_MISMATCH');

    // Nothing moved: still waiting at visit 2, not dismissed, not re-raised, not logged.
    expect(activeGateId(orchestrator, workflowId)).toBe(visit2);
    expect(dismissGate).toHaveBeenCalledTimes(1);
    expect(raiseGate).toHaveBeenCalledTimes(2);
    const resolvedSoFar = gateResolvedEntries(tmpDir, workflowId);
    expect(resolvedSoFar).toHaveLength(1);
    expect(resolvedSoFar[0]).toMatchObject({
      gateId: visit1,
      event: 'FORCE_REVISION',
      prompt: 'add error handling',
      resolvedBy: 'web-ui',
    });

    // The current raise's id is what unlocks the gate.
    orchestrator.resolveGate(workflowId, { gateId: visit2, type: 'APPROVE', resolvedBy: 'cli' });
    await waitForCompletion(orchestrator, workflowId);
    expect(orchestrator.getStatus(workflowId)?.phase).toBe('completed');

    const resolved = gateResolvedEntries(tmpDir, workflowId);
    expect(resolved.map((e) => [e.gateId, e.event, e.resolvedBy])).toEqual([
      [visit1, 'FORCE_REVISION', 'web-ui'],
      [visit2, 'APPROVE', 'cli'],
    ]);
    expect(gateRaisedEntries(tmpDir, workflowId).map((e) => e.gateId)).toEqual([visit1, visit2]);

    // Once the run has moved on there is no gate left to resolve.
    let afterCompletion: unknown;
    try {
      orchestrator.resolveGate(workflowId, { gateId: visit2, type: 'APPROVE', resolvedBy: 'cli' });
    } catch (err) {
      afterCompletion = err;
    }
    expect(isGateResolutionError(afterCompletion) && afterCompletion.code).toBe('WORKFLOW_NOT_AT_GATE');
  });

  it('refuses an event the gate does not accept, leaves the run waiting and logs no resolution', async () => {
    const defPath = writeDefinitionFile(tmpDir, gatedDef);
    const raiseGate = vi.fn();
    const dismissGate = vi.fn();
    const deps = createDeps(tmpDir, { createSession: makeSessionFactory(tmpDir), raiseGate, dismissGate });
    const orchestrator = track(new WorkflowOrchestrator(deps));

    const workflowId = await orchestrator.start(defPath, 'build it');
    const [gate] = await waitForGate(raiseGate, 1);
    expect(gate.acceptedEvents).not.toContain('REPLAN');

    let thrown: unknown;
    try {
      orchestrator.resolveGate(workflowId, { gateId: gate.gateId, type: 'REPLAN', prompt: 'redo', resolvedBy: 'rpc' });
    } catch (err) {
      thrown = err;
    }
    expect(isGateResolutionError(thrown) && thrown.code).toBe('EVENT_NOT_ACCEPTED');

    // Previously this dismissed the gate, logged a resolution and re-raised
    // the gate on XState's no-op snapshot. Now the raise is untouched.
    expect(orchestrator.getStatus(workflowId)?.phase).toBe('waiting_human');
    expect(activeGateId(orchestrator, workflowId)).toBe(gate.gateId);
    expect(dismissGate).not.toHaveBeenCalled();
    expect(raiseGate).toHaveBeenCalledTimes(1);
    expect(gateResolvedEntries(tmpDir, workflowId)).toHaveLength(0);

    // Feedback is still required for the accepted revision event.
    expect(() =>
      orchestrator.resolveGate(workflowId, { gateId: gate.gateId, type: 'FORCE_REVISION', resolvedBy: 'cli' }),
    ).toThrow(/Feedback is required/);
    expect(gateResolvedEntries(tmpDir, workflowId)).toHaveLength(0);

    orchestrator.resolveGate(workflowId, { gateId: gate.gateId, type: 'APPROVE', resolvedBy: 'cli' });
    await waitForCompletion(orchestrator, workflowId);
    expect(orchestrator.getStatus(workflowId)?.phase).toBe('completed');
  });

  it('throws WORKFLOW_NOT_FOUND for an unknown workflow', () => {
    const deps = createDeps(tmpDir, { createSession: makeSessionFactory(tmpDir) });
    const orchestrator = track(new WorkflowOrchestrator(deps));
    let thrown: unknown;
    try {
      orchestrator.resolveGate('wf-missing' as WorkflowId, { gateId: 'x', type: 'APPROVE', resolvedBy: 'cli' });
    } catch (err) {
      thrown = err;
    }
    expect(isGateResolutionError(thrown) && thrown.code).toBe('WORKFLOW_NOT_FOUND');
  });

  it('persists the gate id in the checkpoint and keeps it across resume', async () => {
    const defPath = writeDefinitionFile(tmpDir, gatedDef);
    const checkpointStore = createCheckpointStore(tmpDir);
    const raiseGate1 = vi.fn();
    const deps1 = createDeps(tmpDir, {
      createSession: makeSessionFactory(tmpDir),
      raiseGate: raiseGate1,
      checkpointStore,
    });
    const orchestrator1 = track(new WorkflowOrchestrator(deps1));

    const workflowId = await orchestrator1.start(defPath, 'build it');
    const [gate] = await waitForGate(raiseGate1, 1);

    const checkpoint = checkpointStore.load(workflowId);
    expect(checkpoint?.machineState).toBe('plan_gate');
    expect(checkpoint?.activeGateId).toBe(gate.gateId);

    // Simulate a crash at the gate: shut down, then restore the pre-shutdown checkpoint.
    const saved = checkpoint ? { ...checkpoint } : undefined;
    await orchestrator1.shutdownAll();
    if (saved) checkpointStore.save(workflowId, saved);

    const raiseGate2 = vi.fn();
    const deps2 = createDeps(tmpDir, {
      createSession: makeSessionFactory(tmpDir),
      raiseGate: raiseGate2,
      checkpointStore,
    });
    const orchestrator2 = track(new WorkflowOrchestrator(deps2));
    await orchestrator2.resume(workflowId);

    const [reraised] = await waitForGate(raiseGate2, 1);
    expect(reraised.gateId).toBe(gate.gateId);
    expect(activeGateId(orchestrator2, workflowId)).toBe(gate.gateId);
    expect(checkpointStore.load(workflowId)?.activeGateId).toBe(gate.gateId);

    // A decision read before the restart is still valid after it.
    orchestrator2.resolveGate(workflowId, { gateId: gate.gateId, type: 'APPROVE', resolvedBy: 'cli' });
    await waitForCompletion(orchestrator2, workflowId);
    expect(orchestrator2.getStatus(workflowId)?.phase).toBe('completed');
  });

  it('mints a fresh id when resuming a legacy checkpoint without one', async () => {
    const defPath = writeDefinitionFile(tmpDir, gatedDef);
    const checkpointStore = createCheckpointStore(tmpDir);
    const raiseGate1 = vi.fn();
    const deps1 = createDeps(tmpDir, {
      createSession: makeSessionFactory(tmpDir),
      raiseGate: raiseGate1,
      checkpointStore,
    });
    const orchestrator1 = track(new WorkflowOrchestrator(deps1));

    const workflowId = await orchestrator1.start(defPath, 'build it');
    const [gate] = await waitForGate(raiseGate1, 1);
    const checkpoint = checkpointStore.load(workflowId);
    await orchestrator1.shutdownAll();
    if (!checkpoint) throw new Error('expected a checkpoint at the gate');
    expect(checkpoint.activeGateId).toBe(gate.gateId);
    const legacy = Object.fromEntries(
      Object.entries(checkpoint).filter(([key]) => key !== 'activeGateId'),
    ) as unknown as WorkflowCheckpoint;
    checkpointStore.save(workflowId, legacy);

    const raiseGate2 = vi.fn();
    const deps2 = createDeps(tmpDir, {
      createSession: makeSessionFactory(tmpDir),
      raiseGate: raiseGate2,
      checkpointStore,
    });
    const orchestrator2 = track(new WorkflowOrchestrator(deps2));
    await orchestrator2.resume(workflowId);

    const [reraised] = await waitForGate(raiseGate2, 1);
    expect(reraised.gateId).not.toBe(gate.gateId);
    expect(reraised.gateId.startsWith(`${workflowId}-plan_gate-1-`)).toBe(true);
    // The fresh id is persisted at resume, so a second restart before the
    // decision keeps it instead of minting yet another one.
    expect(checkpointStore.load(workflowId)?.activeGateId).toBe(reraised.gateId);

    let thrown: unknown;
    try {
      orchestrator2.resolveGate(workflowId, { gateId: gate.gateId, type: 'APPROVE', resolvedBy: 'cli' });
    } catch (err) {
      thrown = err;
    }
    expect(isGateResolutionError(thrown) && thrown.code).toBe('GATE_MISMATCH');

    orchestrator2.resolveGate(workflowId, { gateId: reraised.gateId, type: 'APPROVE', resolvedBy: 'cli' });
    await waitForCompletion(orchestrator2, workflowId);
    expect(orchestrator2.getStatus(workflowId)?.phase).toBe('completed');
  });

  it('discards a checkpointed id that was not minted for the gate it resumes at', async () => {
    const defPath = writeDefinitionFile(tmpDir, gatedDef);
    const checkpointStore = createCheckpointStore(tmpDir);
    const raiseGate1 = vi.fn();
    const orchestrator1 = track(
      new WorkflowOrchestrator(
        createDeps(tmpDir, { createSession: makeSessionFactory(tmpDir), raiseGate: raiseGate1, checkpointStore }),
      ),
    );

    const workflowId = await orchestrator1.start(defPath, 'build it');
    await waitForGate(raiseGate1, 1);
    const checkpoint = checkpointStore.load(workflowId);
    await orchestrator1.shutdownAll();
    if (!checkpoint) throw new Error('expected a checkpoint at the gate');
    // An id from another gate of the same run (e.g. a checkpoint whose
    // machineState and gate id disagree) must not be honoured here.
    const foreignId = mintGateId(workflowId, 'implement', 1);
    checkpointStore.save(workflowId, { ...checkpoint, activeGateId: foreignId });

    const raiseGate2 = vi.fn();
    const orchestrator2 = track(
      new WorkflowOrchestrator(
        createDeps(tmpDir, { createSession: makeSessionFactory(tmpDir), raiseGate: raiseGate2, checkpointStore }),
      ),
    );
    await orchestrator2.resume(workflowId);

    const [reraised] = await waitForGate(raiseGate2, 1);
    expect(reraised.gateId).not.toBe(foreignId);
    expect(isGateIdFor(reraised.gateId, workflowId, 'plan_gate')).toBe(true);
    expect(checkpointStore.load(workflowId)?.activeGateId).toBe(reraised.gateId);
    expect(() =>
      orchestrator2.resolveGate(workflowId, { gateId: foreignId, type: 'APPROVE', resolvedBy: 'cli' }),
    ).toThrow(GateResolutionError);

    orchestrator2.resolveGate(workflowId, { gateId: reraised.gateId, type: 'APPROVE', resolvedBy: 'cli' });
    await waitForCompletion(orchestrator2, workflowId);
    expect(orchestrator2.getStatus(workflowId)?.phase).toBe('completed');
  });

  it('refuses a decision once the run is terminal, and a resume after abort keeps the raise id', async () => {
    const defPath = writeDefinitionFile(tmpDir, gatedDef);
    const checkpointStore = createCheckpointStore(tmpDir);
    const raiseGate = vi.fn();
    const dismissGate = vi.fn();
    const orchestrator = track(
      new WorkflowOrchestrator(
        createDeps(tmpDir, {
          createSession: makeSessionFactory(tmpDir),
          raiseGate,
          dismissGate,
          checkpointStore,
        }),
      ),
    );

    const workflowId = await orchestrator.start(defPath, 'build it');
    const [gate] = await waitForGate(raiseGate, 1);
    await orchestrator.abort(workflowId);
    expect(orchestrator.getStatus(workflowId)?.phase).toBe('aborted');

    // The aborted run still remembers the raise (for its checkpoint) but has
    // nothing left to decide: the right id is refused and nothing is logged.
    let thrown: unknown;
    try {
      orchestrator.resolveGate(workflowId, { gateId: gate.gateId, type: 'APPROVE', resolvedBy: 'cli' });
    } catch (err) {
      thrown = err;
    }
    expect(isGateResolutionError(thrown) && thrown.code).toBe('WORKFLOW_NOT_AT_GATE');
    expect(dismissGate).not.toHaveBeenCalled();
    expect(gateResolvedEntries(tmpDir, workflowId)).toHaveLength(0);

    // The terminal checkpoint still points at the same raise, so a resume
    // re-raises the gate the decider reviewed under the same id.
    expect(checkpointStore.load(workflowId)?.activeGateId).toBe(gate.gateId);
    await orchestrator.resume(workflowId);
    const raises = await waitForGate(raiseGate, 2);
    expect(raises[1].gateId).toBe(gate.gateId);

    orchestrator.resolveGate(workflowId, { gateId: gate.gateId, type: 'APPROVE', resolvedBy: 'web-ui' });
    await waitForCompletion(orchestrator, workflowId);
    expect(orchestrator.getStatus(workflowId)?.phase).toBe('completed');
    expect(gateResolvedEntries(tmpDir, workflowId).map((e) => [e.gateId, e.resolvedBy])).toEqual([
      [gate.gateId, 'web-ui'],
    ]);
  });

  it('gives a decision whose transition re-enters the same gate a new raise id, persisted for restart', async () => {
    // FORCE_REVISION targets the gate itself: the machine stays in
    // `plan_gate`, so there is no state change, yet the decision consumed
    // the raise. The re-raise needs its own id, and the checkpoint must not
    // keep offering the one just resolved after a restart.
    const selfLoopDef: WorkflowDefinition = {
      ...gatedDef,
      name: 'gate-self-loop',
      states: {
        ...gatedDef.states,
        plan_gate: {
          type: 'human_gate',
          description: 'Human review gate',
          acceptedEvents: ['APPROVE', 'FORCE_REVISION', 'ABORT'],
          present: ['plan'],
          transitions: [
            { to: 'implement', event: 'APPROVE' },
            { to: 'plan_gate', event: 'FORCE_REVISION' },
            { to: 'aborted', event: 'ABORT' },
          ],
        },
      },
    };
    const defPath = writeDefinitionFile(tmpDir, selfLoopDef);
    const checkpointStore = createCheckpointStore(tmpDir);
    const raiseGate1 = vi.fn();
    const orchestrator1 = track(
      new WorkflowOrchestrator(
        createDeps(tmpDir, { createSession: makeSessionFactory(tmpDir), raiseGate: raiseGate1, checkpointStore }),
      ),
    );

    const workflowId = await orchestrator1.start(defPath, 'build it');
    const [first] = await waitForGate(raiseGate1, 1);
    expect(checkpointStore.load(workflowId)?.activeGateId).toBe(first.gateId);

    orchestrator1.resolveGate(workflowId, {
      gateId: first.gateId,
      type: 'FORCE_REVISION',
      prompt: 'look again',
      resolvedBy: 'cli',
    });
    const [, second] = await waitForGate(raiseGate1, 2);
    expect(second.gateId).not.toBe(first.gateId);
    expect(isGateIdFor(second.gateId, workflowId, 'plan_gate')).toBe(true);
    expect(activeGateId(orchestrator1, workflowId)).toBe(second.gateId);
    const atSecondRaise = checkpointStore.load(workflowId);
    expect(atSecondRaise?.activeGateId).toBe(second.gateId);
    expect(() =>
      orchestrator1.resolveGate(workflowId, { gateId: first.gateId, type: 'APPROVE', resolvedBy: 'cli' }),
    ).toThrow(GateResolutionError);

    // Crash at the second raise: the resumed run offers the second id, and
    // the first (already resolved) one stays refused.
    await orchestrator1.shutdownAll();
    if (!atSecondRaise) throw new Error('expected a checkpoint at the second raise');
    checkpointStore.save(workflowId, atSecondRaise);
    const raiseGate2 = vi.fn();
    const orchestrator2 = track(
      new WorkflowOrchestrator(
        createDeps(tmpDir, { createSession: makeSessionFactory(tmpDir), raiseGate: raiseGate2, checkpointStore }),
      ),
    );
    await orchestrator2.resume(workflowId);
    const [reraised] = await waitForGate(raiseGate2, 1);
    expect(reraised.gateId).toBe(second.gateId);

    let thrown: unknown;
    try {
      orchestrator2.resolveGate(workflowId, { gateId: first.gateId, type: 'APPROVE', resolvedBy: 'cli' });
    } catch (err) {
      thrown = err;
    }
    expect(isGateResolutionError(thrown) && thrown.code).toBe('GATE_MISMATCH');

    orchestrator2.resolveGate(workflowId, { gateId: second.gateId, type: 'APPROVE', resolvedBy: 'cli' });
    await waitForCompletion(orchestrator2, workflowId);
    expect(orchestrator2.getStatus(workflowId)?.phase).toBe('completed');
  });

  it('mints and persists a raise id for a workflow that starts at a gate', async () => {
    const initialGateDef: WorkflowDefinition = {
      name: 'gate-initial',
      description: 'approve_start -> implement -> done',
      initial: 'approve_start',
      settings: { mode: 'builtin', maxRounds: 2 },
      states: {
        approve_start: {
          type: 'human_gate',
          description: 'Approve the start',
          acceptedEvents: ['APPROVE', 'ABORT'],
          transitions: [
            { to: 'implement', event: 'APPROVE' },
            { to: 'aborted', event: 'ABORT' },
          ],
        },
        implement: {
          type: 'agent',
          description: 'Writes code',
          persona: 'coder',
          prompt: 'You are a coder.',
          inputs: [],
          outputs: ['code'],
          transitions: [{ to: 'done' }],
        },
        done: { type: 'terminal', description: 'Done' },
        aborted: { type: 'terminal', description: 'Aborted' },
      },
    };
    const defPath = writeDefinitionFile(tmpDir, initialGateDef);
    const checkpointStore = createCheckpointStore(tmpDir);
    const raiseGate = vi.fn();
    const orchestrator = track(
      new WorkflowOrchestrator(
        createDeps(tmpDir, { createSession: makeSessionFactory(tmpDir), raiseGate, checkpointStore }),
      ),
    );

    const workflowId = await orchestrator.start(defPath, 'build it');
    const [gate] = await waitForGate(raiseGate, 1);
    expect(isGateIdFor(gate.gateId, workflowId, 'approve_start')).toBe(true);
    expect(activeGateId(orchestrator, workflowId)).toBe(gate.gateId);
    expect(checkpointStore.load(workflowId)?.activeGateId).toBe(gate.gateId);
    expect(raiseGate).toHaveBeenCalledTimes(1);

    orchestrator.resolveGate(workflowId, { gateId: gate.gateId, type: 'APPROVE', resolvedBy: 'cli' });
    await waitForCompletion(orchestrator, workflowId);
    expect(orchestrator.getStatus(workflowId)?.phase).toBe('completed');
  });

  it('advertises only the events the gate routes, and logs the same set on gate_raised', async () => {
    // REPLAN is declared but has no transition: a decider must not be offered it.
    const declaredOnlyDef: WorkflowDefinition = {
      ...gatedDef,
      name: 'gate-declared-only',
      states: {
        ...gatedDef.states,
        plan_gate: {
          type: 'human_gate',
          description: 'Human review gate',
          acceptedEvents: ['APPROVE', 'REPLAN', 'FORCE_REVISION', 'ABORT'],
          present: ['plan'],
          transitions: [
            { to: 'implement', event: 'APPROVE' },
            { to: 'plan', event: 'FORCE_REVISION' },
            { to: 'aborted', event: 'ABORT' },
          ],
        },
      },
    };
    const defPath = writeDefinitionFile(tmpDir, declaredOnlyDef);
    const raiseGate = vi.fn();
    const orchestrator = track(
      new WorkflowOrchestrator(createDeps(tmpDir, { createSession: makeSessionFactory(tmpDir), raiseGate })),
    );

    const workflowId = await orchestrator.start(defPath, 'build it');
    const [gate] = await waitForGate(raiseGate, 1);
    expect(gate.acceptedEvents).toEqual(['APPROVE', 'FORCE_REVISION', 'ABORT']);
    const status = orchestrator.getStatus(workflowId);
    expect(status?.phase === 'waiting_human' && status.gate.acceptedEvents).toEqual([
      'APPROVE',
      'FORCE_REVISION',
      'ABORT',
    ]);
    expect(gateRaisedEntries(tmpDir, workflowId).map((e) => e.acceptedEvents)).toEqual([
      ['APPROVE', 'FORCE_REVISION', 'ABORT'],
    ]);

    let thrown: unknown;
    try {
      orchestrator.resolveGate(workflowId, { gateId: gate.gateId, type: 'REPLAN', prompt: 'redo', resolvedBy: 'cli' });
    } catch (err) {
      thrown = err;
    }
    expect(isGateResolutionError(thrown) && thrown.code).toBe('EVENT_NOT_ACCEPTED');
    expect(activeGateId(orchestrator, workflowId)).toBe(gate.gateId);

    orchestrator.resolveGate(workflowId, { gateId: gate.gateId, type: 'APPROVE', resolvedBy: 'cli' });
    await waitForCompletion(orchestrator, workflowId);
  });
});
