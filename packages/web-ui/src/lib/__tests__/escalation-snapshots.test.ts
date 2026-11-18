import { describe, it, expect } from 'vitest';
import {
  ESCALATION_EVENTS,
  mergeEscalationSnapshot,
  mergeWorkflowEscalationSnapshot,
  type ReceivedEvent,
} from '../escalation-snapshots.js';
import type { EscalationDto, PendingEscalation, WorkflowEscalationDto } from '../types.js';

function escalation(id: string, sessionLabel = 1): EscalationDto {
  return {
    escalationId: id,
    sessionLabel,
    sessionSource: { kind: 'web-pty' },
    toolName: 'write_file',
    serverName: 'filesystem',
    arguments: { path: '/etc/hosts' },
    reason: 'r',
    receivedAt: '2026-01-01T00:00:00.000Z',
  };
}

function pending(id: string, displayNumber: number, sessionLabel = 1): PendingEscalation {
  return { ...escalation(id, sessionLabel), displayNumber };
}

function workflowEscalation(id: string, workflowId = 'wf-1'): WorkflowEscalationDto {
  return {
    escalationId: id,
    workflowId,
    stateId: 's',
    serverName: 'filesystem',
    toolName: 'write_file',
    arguments: {},
    reason: 'r',
    receivedAt: '2026-01-01T00:00:00.000Z',
  };
}

function counter(start: number): () => number {
  let value = start;
  return () => ++value;
}

describe('mergeEscalationSnapshot', () => {
  it('replaces what was held with the snapshot when no event arrived meanwhile', () => {
    const current = new Map([
      ['kept', pending('kept', 3)],
      ['missed-resolution', pending('missed-resolution', 4)],
    ]);
    const merged = mergeEscalationSnapshot(current, [escalation('kept'), escalation('missed-raise')], [], counter(10));
    expect([...merged.keys()]).toEqual(['kept', 'missed-raise']);
    // Known escalations keep their number; unseen ones get the next.
    expect(merged.get('kept')?.displayNumber).toBe(3);
    expect(merged.get('missed-raise')?.displayNumber).toBe(11);
  });

  it('lets the events of the request window decide the escalations they touched', () => {
    // Live state after the window's events: `raised` was added, `resolved`,
    // `expired` and `short-lived` (raised, then resolved) are gone.
    const current = new Map([['raised', pending('raised', 7)]]);
    const events: ReceivedEvent[] = [
      { event: 'escalation.created', payload: escalation('raised') },
      { event: 'escalation.resolved', payload: { escalationId: 'resolved', decision: 'denied' } },
      { event: 'escalation.expired', payload: { escalationId: 'expired', sessionLabel: 1 } },
      { event: 'escalation.created', payload: escalation('short-lived') },
      { event: 'escalation.resolved', payload: { escalationId: 'short-lived', decision: 'approved' } },
    ];
    const listed = [escalation('resolved'), escalation('expired'), escalation('short-lived'), escalation('other')];
    const nextNumber = counter(20);

    const merged = mergeEscalationSnapshot(current, listed, events, nextNumber);

    expect([...merged.keys()].sort()).toEqual(['other', 'raised']);
    expect(merged.get('raised')?.displayNumber).toBe(7);
    // Only the one escalation the client had not seen was numbered.
    expect(nextNumber()).toBe(22);
  });

  it('drops listed escalations of a session that ended meanwhile, but not one raised after', () => {
    const current = new Map([['raised-after', pending('raised-after', 5, 2)]]);
    const events: ReceivedEvent[] = [
      { event: 'session.ended', payload: { label: 2 } },
      { event: 'escalation.created', payload: escalation('raised-after', 2) },
    ];
    const listed = [escalation('stale', 2), escalation('raised-after', 2), escalation('other', 3)];

    const merged = mergeEscalationSnapshot(current, listed, events, counter(0));

    expect([...merged.keys()].sort()).toEqual(['other', 'raised-after']);
  });

  it('ignores events of other kinds', () => {
    const events: ReceivedEvent[] = [
      { event: 'session.updated', payload: { label: 1 } },
      { event: 'workflow.escalation_resolved', payload: { workflowId: 'wf', escalationId: 'a', outcome: 'x' } },
    ];
    expect([...mergeEscalationSnapshot(new Map(), [escalation('a')], events, counter(0)).keys()]).toEqual(['a']);
  });
});

describe('mergeWorkflowEscalationSnapshot', () => {
  it("rebuilds only the fetched workflow's entries", () => {
    const current = new Map([
      ['stale', workflowEscalation('stale', 'wf-1')],
      ['other', workflowEscalation('other', 'wf-2')],
    ]);
    const merged = mergeWorkflowEscalationSnapshot(current, 'wf-1', [workflowEscalation('live', 'wf-1')], []);
    expect([...merged.keys()].sort()).toEqual(['live', 'other']);
  });

  it("applies the window's events of that workflow on top of the detail", () => {
    const current = new Map([['raised', workflowEscalation('raised')]]);
    const events: ReceivedEvent[] = [
      {
        event: 'workflow.escalation_raised',
        payload: { workflowId: 'wf-1', escalation: workflowEscalation('raised') },
      },
      {
        event: 'workflow.escalation_resolved',
        payload: { workflowId: 'wf-1', escalationId: 'resolved', outcome: 'x' },
      },
      // Another workflow's resolution says nothing about this one's entries.
      { event: 'workflow.escalation_resolved', payload: { workflowId: 'wf-2', escalationId: 'listed', outcome: 'x' } },
    ];
    const merged = mergeWorkflowEscalationSnapshot(
      current,
      'wf-1',
      [workflowEscalation('resolved'), workflowEscalation('listed')],
      events,
    );
    expect([...merged.keys()].sort()).toEqual(['listed', 'raised']);
  });

  it('keeps nothing of a workflow that finished meanwhile', () => {
    const listed = [workflowEscalation('withdrawn')];
    const completed: ReceivedEvent[] = [{ event: 'workflow.completed', payload: { workflowId: 'wf-1' } }];
    expect(mergeWorkflowEscalationSnapshot(new Map(), 'wf-1', listed, completed).size).toBe(0);

    const aborted: ReceivedEvent[] = [
      { event: 'workflow.failed', payload: { workflowId: 'wf-1', error: 'x', phase: 'aborted' } },
    ];
    expect(mergeWorkflowEscalationSnapshot(new Map(), 'wf-1', listed, aborted).size).toBe(0);

    // A failure without a terminal phase (older daemons) does not end the run.
    const failed: ReceivedEvent[] = [{ event: 'workflow.failed', payload: { workflowId: 'wf-1', error: 'x' } }];
    expect(mergeWorkflowEscalationSnapshot(new Map(), 'wf-1', listed, failed).size).toBe(1);
  });
});

describe('ESCALATION_EVENTS', () => {
  it('covers every event the merges read', () => {
    expect([...ESCALATION_EVENTS].sort()).toEqual([
      'escalation.created',
      'escalation.expired',
      'escalation.resolved',
      'session.ended',
      'workflow.completed',
      'workflow.escalation_raised',
      'workflow.escalation_resolved',
      'workflow.failed',
    ]);
  });
});
