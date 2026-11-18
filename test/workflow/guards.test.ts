import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { createActor, fromPromise, waitFor, type AnyActorRef } from 'xstate';
import { guardImplementations, REGISTERED_GUARDS } from '../../src/workflow/guards.js';
import { buildWorkflowMachine, type AgentInvokeInput } from '../../src/workflow/machine-builder.js';
import { validateDefinition } from '../../src/workflow/validate.js';
import type { WorkflowContext, WorkflowEvent, AgentOutput } from '../../src/workflow/types.js';
import { makeAgentResult, makeRejectedResult } from './machine-test-helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseContext(overrides: Partial<WorkflowContext> = {}): WorkflowContext {
  return {
    taskDescription: 'test task',
    artifacts: {},
    round: 0,
    maxRounds: 4,
    previousOutputHashes: {},
    previousTestCount: null,
    humanPrompt: null,
    reviewHistory: [],
    totalTokens: 0,
    lastError: null,
    agentConversationsByState: {},
    previousAgentOutput: null,
    previousAgentNotes: null,
    previousStateName: null,
    visitCounts: {},
    ...overrides,
  };
}

function makeOutput(overrides: Partial<AgentOutput> = {}): AgentOutput {
  return {
    completed: true,
    verdict: 'approved',
    confidence: 'high',
    escalation: null,
    testCount: null,
    notes: null,
    ...overrides,
  };
}

function completedEvent(outputOverrides: Partial<AgentOutput> = {}): WorkflowEvent {
  return { type: 'AGENT_COMPLETED', output: makeOutput(outputOverrides) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const { isRoundLimitReached, isStalled, isPassed } = guardImplementations;

describe('REGISTERED_GUARDS', () => {
  it('contains all guard names', () => {
    expect(REGISTERED_GUARDS).toContain('isRoundLimitReached');
    expect(REGISTERED_GUARDS).toContain('isStalled');
    expect(REGISTERED_GUARDS).toContain('isStateVisitLimitReached');
    expect(REGISTERED_GUARDS).toContain('isPassed');
  });

  it('does not contain removed guards', () => {
    expect(REGISTERED_GUARDS).not.toContain('isApproved');
    expect(REGISTERED_GUARDS).not.toContain('isRejected');
  });

  it('matches the keys of guardImplementations', () => {
    expect(REGISTERED_GUARDS.size).toBe(Object.keys(guardImplementations).length);
    for (const key of Object.keys(guardImplementations)) {
      expect(REGISTERED_GUARDS).toContain(key);
    }
  });
});

describe('isRoundLimitReached', () => {
  it('returns true when any state visit count >= maxRounds', () => {
    expect(
      isRoundLimitReached({
        context: baseContext({ visitCounts: { implement: 4 }, maxRounds: 4 }),
        event: completedEvent(),
      }),
    ).toBe(true);
  });

  it('returns true when visit count exceeds maxRounds', () => {
    expect(
      isRoundLimitReached({
        context: baseContext({ visitCounts: { implement: 5, review: 4 }, maxRounds: 4 }),
        event: completedEvent(),
      }),
    ).toBe(true);
  });

  it('returns false when all visit counts < maxRounds', () => {
    expect(
      isRoundLimitReached({
        context: baseContext({ visitCounts: { implement: 2, review: 1 }, maxRounds: 4 }),
        event: completedEvent(),
      }),
    ).toBe(false);
  });

  it('returns false when visitCounts is empty', () => {
    expect(
      isRoundLimitReached({
        context: baseContext({ visitCounts: {}, maxRounds: 4 }),
        event: completedEvent(),
      }),
    ).toBe(false);
  });
});

describe('isStalled', () => {
  it('returns false for non-agent events', () => {
    expect(isStalled({ context: baseContext(), event: { type: 'VALIDATION_FAILED', errors: 'err' } })).toBe(false);
  });

  it('returns false for agent completed events (Phase 1 stub)', () => {
    // Stall detection requires machine builder integration for stateId+hash
    expect(isStalled({ context: baseContext(), event: completedEvent() })).toBe(false);
  });
});

describe('isPassed', () => {
  it('returns true for VALIDATION_PASSED event', () => {
    expect(isPassed({ context: baseContext(), event: { type: 'VALIDATION_PASSED', testCount: 42 } })).toBe(true);
  });

  it('returns false for VALIDATION_FAILED event', () => {
    expect(isPassed({ context: baseContext(), event: { type: 'VALIDATION_FAILED', errors: 'fail' } })).toBe(false);
  });

  it('returns false for AGENT_COMPLETED event', () => {
    expect(isPassed({ context: baseContext(), event: completedEvent() })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isRoundLimitReached in the bundled design-and-code workflow
// ---------------------------------------------------------------------------

/**
 * isRoundLimitReached is workflow-wide on purpose (it bounds evolve's whole
 * pipeline, for one), so design-and-code must keep plan/design revisions from
 * spending the implement/review budget. It does that by resetting the phase's
 * visit count when its gate approves. Driven through the real manifest and
 * machine, with every review rejecting.
 */
describe('design-and-code round budget (isRoundLimitReached)', () => {
  const manifestPath = resolve(
    __dirname,
    '..',
    '..',
    'src',
    'workflow',
    'workflows',
    'design-and-code',
    'workflow.yaml',
  );
  const definition = validateDefinition(parseYaml(readFileSync(manifestPath, 'utf-8'), { maxAliasCount: 0 }));

  interface Run {
    readonly actor: AnyActorRef;
    readonly entered: string[];
  }

  function startRejectingRun(): Run {
    const { machine } = buildWorkflowMachine(definition, 'build a widget');
    const entered: string[] = [];
    const provided = machine.provide({
      actors: {
        agentService: fromPromise(async ({ input }: { input: AgentInvokeInput }) => {
          entered.push(input.stateId);
          return input.stateId === 'review' ? makeRejectedResult({ notes: 'still broken' }) : makeAgentResult();
        }),
      },
    });
    const actor = createActor(provided);
    actor.start();
    return { actor, entered };
  }

  const valueOf = (snapshot: unknown): string => String((snapshot as { value: unknown }).value);
  const visitsOf = (snapshot: unknown): Readonly<Record<string, number>> =>
    (snapshot as { context: WorkflowContext }).context.visitCounts;

  /** Waits until the machine sits in `state` with `visits` of `visitState` (the gate after a revision). */
  async function reach(actor: AnyActorRef, state: string, visitState?: string, visits?: number): Promise<void> {
    await waitFor(
      actor,
      (snapshot) =>
        valueOf(snapshot) === state && (visitState === undefined || visitsOf(snapshot)[visitState] === visits),
      { timeout: 5_000 },
    );
  }

  /** At the gate for `phase`, requests `revisions` revisions (each re-runs the agent), then approves. */
  async function approveAfterRevisions(actor: AnyActorRef, phase: 'plan' | 'design', revisions: number): Promise<void> {
    const gate = `${phase}_review`;
    await reach(actor, gate);
    for (let i = 0; i < revisions; i++) {
      actor.send({ type: 'HUMAN_FORCE_REVISION', prompt: `revise the ${phase} (${i + 1})` });
      await reach(actor, gate, phase, i + 2);
    }
    actor.send({ type: 'HUMAN_APPROVE' });
  }

  it('gives the coder a revision round after two plan revisions', async () => {
    const { actor, entered } = startRejectingRun();
    await approveAfterRevisions(actor, 'plan', 2);
    await approveAfterRevisions(actor, 'design', 0);

    // The first rejection must send the work back to the coder, not escalate:
    // the three plan visits belong to a phase that is already approved.
    await reach(actor, 'escalate_gate');
    expect(entered.slice(0, 4)).toEqual(['plan', 'plan', 'plan', 'design']);
    const firstReview = entered.indexOf('review');
    expect(entered[firstReview + 1]).toBe('implement');
    // The full budget of maxRounds (3) implement/review rounds, then the gate.
    expect(entered.filter((state) => state === 'implement')).toHaveLength(3);
    expect(entered.filter((state) => state === 'review')).toHaveLength(3);
    expect(visitsOf(actor.getSnapshot())).toMatchObject({ plan: 0, design: 0, implement: 3, review: 3 });
    actor.stop();
  });

  it('gives the coder the same three rounds after a design revision', async () => {
    const { actor, entered } = startRejectingRun();
    await approveAfterRevisions(actor, 'plan', 0);
    await approveAfterRevisions(actor, 'design', 2);

    await reach(actor, 'escalate_gate');
    expect(entered.filter((state) => state === 'design')).toHaveLength(3);
    expect(entered.filter((state) => state === 'review')).toHaveLength(3);
    expect(visitsOf(actor.getSnapshot())).toMatchObject({ plan: 0, design: 0, implement: 3, review: 3 });
    actor.stop();
  });
});
