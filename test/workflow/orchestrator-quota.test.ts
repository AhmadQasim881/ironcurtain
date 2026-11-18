/**
 * Orchestrator quota-exhaustion short-circuit tests.
 *
 * Paired with `test/docker-agent-adapter.test.ts` which covers the
 * adapter-level 429 envelope detection. These tests exercise the
 * orchestrator-side contract:
 *
 *  - When `sendMessageDetailed()` returns `quotaExhausted`, the
 *    orchestrator MUST halt the run immediately — no missing-status-block
 *    reprompt, no hard-retry rotation. Retrying would only burn more of
 *    the already-exhausted provider budget.
 *  - The quota check runs before the hard-retry loop, so a response that
 *    also sets `hardFailure: true` must NOT enter the retry loop.
 *  - The short-circuit applies to every agent-turn site: the initial
 *    command AND every reprompt (missing-status-block, invalid-verdict,
 *    missing-artifacts). We spot-check the initial-command site and the
 *    missing-status-block reprompt site; the four sites share the same
 *    `sendAgentTurn` closure, so coverage of two is sufficient.
 *  - A `quota_exhausted` entry lands in the message log with the
 *    expected fields.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { WorkflowDefinition } from '../../src/workflow/types.js';
import type { SessionOptions } from '../../src/session/types.js';
import { WorkflowOrchestrator } from '../../src/workflow/orchestrator.js';
import type { MessageLogEntry, QuotaExhaustedEntry } from '../../src/workflow/message-log.js';
import {
  MockSession,
  approvedResponse,
  noStatusResponse,
  simulateArtifacts,
  findWorkflowDir,
  writeDefinitionFile,
  createDeps,
  createCheckpointStore,
  waitForCompletion,
  waitForGateOrCompletion,
  stubPersonasForTest,
} from './test-helpers.js';

const simpleAgentDef: WorkflowDefinition = {
  name: 'simple-agent',
  description: 'Single agent to done',
  initial: 'implement',
  settings: { mode: 'builtin' },
  states: {
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
  },
};

const RESET_AT = new Date('2026-04-22T18:27:36Z');
const RAW_MESSAGE = 'Usage limit reached. Resets at 18:27 UTC.';

function readMessageLog(baseDir: string): MessageLogEntry[] {
  const logPath = resolve(findWorkflowDir(baseDir), 'messages.jsonl');
  if (!existsSync(logPath)) return [];
  const lines = readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
  return lines.map((l) => JSON.parse(l) as MessageLogEntry);
}

describe('WorkflowOrchestrator quota-exhaustion short-circuit', () => {
  let tmpDir: string;
  let activeOrchestrator: WorkflowOrchestrator | undefined;
  let cleanupPersonas: (() => void) | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orchestrator-quota-test-'));
    activeOrchestrator = undefined;
    cleanupPersonas = stubPersonasForTest(tmpDir, simpleAgentDef);
  });

  afterEach(async () => {
    if (activeOrchestrator) {
      await activeOrchestrator.shutdownAll();
    }
    cleanupPersonas?.();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('halts immediately when the primary turn reports quotaExhausted, preserves checkpoint, and does not double-log', async () => {
    const defPath = writeDefinitionFile(tmpDir, simpleAgentDef);
    const allSessions: MockSession[] = [];

    const sessionFactory = vi.fn(async () => {
      const session = new MockSession({
        responses: [
          {
            text: 'Agent stopped mid-stream.',
            hardFailure: false,
            quotaExhausted: { resetAt: RESET_AT, rawMessage: RAW_MESSAGE },
          },
        ],
      });
      allSessions.push(session);
      return session;
    });

    // Share the checkpoint store with the orchestrator so we can verify
    // it was NOT cleared after quota exhaustion.
    const checkpointStore = createCheckpointStore(tmpDir);
    const deps = createDeps(tmpDir, { createSession: sessionFactory, checkpointStore });
    const orchestrator = new WorkflowOrchestrator(deps);
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(defPath, 'write code');
    await waitForCompletion(orchestrator, workflowId);

    // Quota exhaustion must force an abort-like phase regardless of which
    // terminal the state's `onError` target resolved to. This simple
    // workflow has no `aborted`/`failed` terminal, so `findErrorTarget`
    // would otherwise route to `done` and `handleWorkflowComplete` would
    // mark the run as `completed` and delete the checkpoint — breaking
    // resume. The `instance.quotaExhausted` check in
    // `handleWorkflowComplete` is what keeps this from happening.
    const status = orchestrator.getStatus(workflowId);
    expect(status?.phase).toBe('aborted');
    if (status?.phase === 'aborted') {
      expect(status.reason).toContain('quota');
      expect(status.reason).toContain(RESET_AT.toISOString());
    }

    // Checkpoint MUST be preserved so `workflow resume` works once the
    // provider window reopens.
    expect(checkpointStore.load(workflowId)).not.toBeNull();

    // Exactly ONE turn — no hard-retry rotation, no missing-status-block
    // reprompt. Any further sends would burn the exhausted budget.
    const session = allSessions[0];
    expect(session.sentMessages).toHaveLength(1);
    expect(session.rotateCalls).toEqual([]);

    // A quota_exhausted entry lands in the message log with the expected fields.
    const log = readMessageLog(tmpDir);
    const quotaEntries = log.filter((e): e is QuotaExhaustedEntry => e.type === 'quota_exhausted');
    expect(quotaEntries).toHaveLength(1);
    expect(quotaEntries[0].role).toBe('coder');
    expect(quotaEntries[0].rawMessage).toBe(RAW_MESSAGE);
    expect(quotaEntries[0].resetAt).toBe(RESET_AT.toISOString());

    // Concern #2 regression guard: no generic `error` entry should be
    // appended alongside the quota_exhausted entry. `workflow inspect`
    // must show a single structured quota line, not a duplicate red
    // error line for the same event.
    const errorEntries = log.filter((e) => e.type === 'error');
    expect(errorEntries).toHaveLength(0);
  });

  it('prefers the quota short-circuit over the hard-retry loop when both signals are set', async () => {
    // Regression guard: if the orchestrator checked `hardFailure` before
    // `quotaExhausted`, a concurrent hard-failure would drive the retry
    // loop and burn 2 more turns of exhausted quota.
    const defPath = writeDefinitionFile(tmpDir, simpleAgentDef);
    const allSessions: MockSession[] = [];

    const sessionFactory = vi.fn(async () => {
      const session = new MockSession({
        responses: [
          {
            text: '',
            hardFailure: true,
            quotaExhausted: { resetAt: RESET_AT, rawMessage: RAW_MESSAGE },
          },
        ],
      });
      allSessions.push(session);
      return session;
    });

    const deps = createDeps(tmpDir, { createSession: sessionFactory });
    const orchestrator = new WorkflowOrchestrator(deps);
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(defPath, 'write code');
    await waitForCompletion(orchestrator, workflowId);

    expect(orchestrator.getStatus(workflowId)?.phase).toBe('aborted');

    const session = allSessions[0];
    // The quota check runs BEFORE the hard-retry loop, so only one turn
    // is sent and no rotation occurs — despite hardFailure=true.
    expect(session.sentMessages).toHaveLength(1);
    expect(session.rotateCalls).toEqual([]);

    const log = readMessageLog(tmpDir);
    const quotaEntries = log.filter((e): e is QuotaExhaustedEntry => e.type === 'quota_exhausted');
    expect(quotaEntries).toHaveLength(1);
  });

  it('halts when quotaExhausted surfaces on the missing-status-block reprompt', async () => {
    // The missing-status-block reprompt site is one of four `sendAgentTurn`
    // call sites. A quota signal surfacing on the reprompt (not the
    // primary turn) must also short-circuit — otherwise we'd fall through
    // to the "no status block after retry" error path and lose the
    // structured signal.
    const defPath = writeDefinitionFile(tmpDir, simpleAgentDef);
    const allSessions: MockSession[] = [];

    const sessionFactory = vi.fn(async () => {
      let callCount = 0;
      const session = new MockSession({
        responses: () => {
          callCount++;
          if (callCount === 1) {
            // Primary turn: produces text but no agent_status block,
            // triggering the missing-status-block reprompt.
            simulateArtifacts(findWorkflowDir(tmpDir), ['code']);
            return noStatusResponse();
          }
          if (callCount === 2) {
            // Reprompt turn: adapter reports quota exhaustion.
            return {
              text: 'Agent stopped mid-stream.',
              hardFailure: false,
              quotaExhausted: { resetAt: RESET_AT, rawMessage: RAW_MESSAGE },
            };
          }
          throw new Error(`Unexpected call ${callCount} — reprompt should have short-circuited`);
        },
      });
      allSessions.push(session);
      return session;
    });

    const deps = createDeps(tmpDir, { createSession: sessionFactory });
    const orchestrator = new WorkflowOrchestrator(deps);
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(defPath, 'write code');
    await waitForCompletion(orchestrator, workflowId);

    expect(orchestrator.getStatus(workflowId)?.phase).toBe('aborted');

    const session = allSessions[0];
    // Exactly two turns: the primary + the reprompt that quota-exhausted.
    // No further sends (no third reprompt, no rotation).
    expect(session.sentMessages).toHaveLength(2);
    expect(session.rotateCalls).toEqual([]);

    const log = readMessageLog(tmpDir);
    const quotaEntries = log.filter((e): e is QuotaExhaustedEntry => e.type === 'quota_exhausted');
    expect(quotaEntries).toHaveLength(1);
    expect(quotaEntries[0].rawMessage).toBe(RAW_MESSAGE);
  });

  it('omits resetAt in the log entry when the adapter could not parse one', async () => {
    const defPath = writeDefinitionFile(tmpDir, simpleAgentDef);
    const allSessions: MockSession[] = [];

    const sessionFactory = vi.fn(async () => {
      const session = new MockSession({
        responses: [
          {
            text: 'Agent stopped mid-stream.',
            hardFailure: false,
            quotaExhausted: { rawMessage: 'Rate limit exceeded. Try again later.' },
          },
        ],
      });
      allSessions.push(session);
      return session;
    });

    const deps = createDeps(tmpDir, { createSession: sessionFactory });
    const orchestrator = new WorkflowOrchestrator(deps);
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(defPath, 'write code');
    await waitForCompletion(orchestrator, workflowId);

    expect(orchestrator.getStatus(workflowId)?.phase).toBe('aborted');

    const log = readMessageLog(tmpDir);
    const quotaEntries = log.filter((e): e is QuotaExhaustedEntry => e.type === 'quota_exhausted');
    expect(quotaEntries).toHaveLength(1);
    expect(quotaEntries[0].resetAt).toBeUndefined();
    expect(quotaEntries[0].rawMessage).toBe('Rate limit exceeded. Try again later.');
  });

  it("ends aborted-resumable without raising a gate when the failing state's error target is a human gate", async () => {
    // Regression guard for the stale-flag misreport. `findErrorTarget` picks a
    // human gate whenever any transition targets one; routing a quota error
    // there would park the run at the gate with `instance.quotaExhausted`
    // still set, so a FORCE_REVISION retry that then succeeded would be
    // reported as `aborted` (checkpoint kept resumable, snapshot retained).
    // Quota must halt on a terminal immediately: no gate, checkpoint pinned
    // at the failing state.
    const gateDef: WorkflowDefinition = {
      name: 'quota-gate-target',
      description: 'Plan, then a review whose error target resolves to a gate',
      initial: 'plan',
      settings: { mode: 'builtin' },
      states: {
        plan: {
          type: 'agent',
          description: 'Plans',
          persona: 'coder',
          prompt: 'You are a planner.',
          inputs: [],
          outputs: ['plan'],
          transitions: [{ to: 'review' }],
        },
        review: {
          type: 'agent',
          description: 'Reviews',
          persona: 'coder',
          prompt: 'You are a reviewer.',
          inputs: ['plan'],
          outputs: [],
          transitions: [
            { to: 'done', when: { verdict: 'approved' } },
            { to: 'escalate_gate', when: { verdict: 'rejected' } },
          ],
        },
        escalate_gate: {
          type: 'human_gate',
          description: 'Human review',
          acceptedEvents: ['APPROVE', 'FORCE_REVISION', 'ABORT'],
          transitions: [
            { to: 'done', event: 'APPROVE' },
            { to: 'review', event: 'FORCE_REVISION' },
            { to: 'aborted', event: 'ABORT' },
          ],
        },
        done: { type: 'terminal', description: 'Done' },
        aborted: { type: 'terminal', description: 'Aborted' },
      },
    };
    const defPath = writeDefinitionFile(tmpDir, gateDef);

    const sessionFactory = vi.fn(async (opts: SessionOptions) => {
      if (opts.workflow?.stateId === 'plan') {
        simulateArtifacts(findWorkflowDir(tmpDir), ['plan']);
        return new MockSession({ responses: [approvedResponse('planned')] });
      }
      return new MockSession({
        responses: [
          {
            text: 'Agent stopped mid-stream.',
            hardFailure: false,
            quotaExhausted: { resetAt: RESET_AT, rawMessage: RAW_MESSAGE },
          },
        ],
      });
    });
    const raiseGate = vi.fn();
    const checkpointStore = createCheckpointStore(tmpDir);
    const deps = createDeps(tmpDir, { createSession: sessionFactory, checkpointStore, raiseGate });
    const orchestrator = new WorkflowOrchestrator(deps);
    activeOrchestrator = orchestrator;

    const workflowId = await orchestrator.start(defPath, 'write code');
    expect(await waitForGateOrCompletion(orchestrator, workflowId)).toBe('done');

    const status = orchestrator.getStatus(workflowId);
    expect(status?.phase).toBe('aborted');
    if (status?.phase === 'aborted') {
      expect(status.reason).toContain('quota');
    }
    expect(raiseGate).not.toHaveBeenCalled();

    // Checkpoint pinned at the failing state and marked resumable.
    const checkpoint = checkpointStore.load(workflowId);
    expect(checkpoint?.machineState).toBe('review');
    expect(checkpoint?.finalStatus?.phase).toBe('aborted');

    const log = readMessageLog(tmpDir);
    expect(log.filter((e) => e.type === 'gate_raised')).toHaveLength(0);
    expect(log.filter((e) => e.type === 'quota_exhausted')).toHaveLength(1);
    expect(log.filter((e) => e.type === 'error')).toHaveLength(0);
  });
});
