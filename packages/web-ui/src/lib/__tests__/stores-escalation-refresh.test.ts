/**
 * refreshAll runs on every connect, reconnect and `daemon.resync`. Escalation
 * events keep arriving while its requests are in flight, and the answers it
 * applies must not undo them: an escalation raised meanwhile must stay
 * pending (dropping it lets it time out as a denial nobody saw), and one
 * resolved or expired meanwhile must not come back. Workflow tool-call
 * escalations, which feed the Workflows badge, are rebuilt from the daemon's
 * view of every live workflow the same way.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EscalationDto, WorkflowDetailDto, WorkflowEscalationDto, WorkflowSummaryDto } from '../types.js';
import { deferred } from './fixtures.js';

const mockRequest = vi.fn<(method: string, params?: Record<string, unknown>) => Promise<unknown>>();
let capturedOnEvent: ((event: string, payload: unknown) => void) | undefined;
let capturedOnConnectionChange: ((connected: boolean) => void) | undefined;

const mockClient = {
  request: mockRequest,
  onEvent: vi.fn((handler: (event: string, payload: unknown) => void) => {
    capturedOnEvent = handler;
    return () => {};
  }),
  onConnectionChange: vi.fn((handler: (connected: boolean) => void) => {
    capturedOnConnectionChange = handler;
    return () => {};
  }),
  onAuthError: vi.fn(() => () => {}),
  get isConnected() {
    return false;
  },
  connect: vi.fn(),
  disconnect: vi.fn(),
};

vi.mock('../ws-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ws-client.js')>();
  return { ...actual, createWsClient: () => mockClient };
});

import {
  appState,
  connectionGeneration,
  getWorkflowDetail,
  getWsClient,
  resolveWorkflowGate,
} from '../stores.svelte.js';

function escalation(id: string, sessionLabel = 1): EscalationDto {
  return {
    escalationId: id,
    sessionLabel,
    sessionSource: { kind: 'web-pty' },
    toolName: 'write_file',
    serverName: 'filesystem',
    arguments: { path: '/etc/hosts' },
    reason: 'Write to protected system path',
    receivedAt: '2026-01-01T00:00:00.000Z',
  };
}

function workflowEscalation(id: string, workflowId = 'wf-1'): WorkflowEscalationDto {
  return {
    escalationId: id,
    workflowId,
    stateId: 'implement',
    serverName: 'filesystem',
    toolName: 'write_file',
    arguments: { path: '/outside/f.txt' },
    reason: 'Writes outside the workspace require approval.',
    receivedAt: '2026-01-01T00:00:00.000Z',
  };
}

function summary(workflowId: string, phase: WorkflowSummaryDto['phase']): WorkflowSummaryDto {
  return {
    workflowId,
    name: 'wf',
    phase,
    currentState: 'implement',
    startedAt: '2026-01-01T00:00:00Z',
    taskDescription: '',
    round: 0,
    maxRounds: 0,
    totalTokens: 0,
  };
}

function detail(
  workflowId: string,
  phase: WorkflowSummaryDto['phase'],
  escalations: readonly WorkflowEscalationDto[] = [],
): WorkflowDetailDto {
  return {
    ...summary(workflowId, phase),
    description: '',
    stateGraph: { states: [], transitions: [] },
    transitionHistory: [],
    context: { taskDescription: '', round: 0, maxRounds: 0, totalTokens: 0, visitCounts: {} },
    workspacePath: '/tmp/ws',
    hasReadme: false,
    // The daemon leaves the field out while nothing is pending.
    ...(escalations.length > 0 ? { escalations } : {}),
  };
}

type Answer<T> = T | Promise<T>;

/** Routes the refresh's RPCs to canned (or deferred) answers. */
function answerRefresh(opts: {
  escalations?: Answer<EscalationDto[]>;
  workflows?: Answer<WorkflowSummaryDto[]>;
  details?: Record<string, Answer<WorkflowDetailDto>>;
}): void {
  mockRequest.mockImplementation((method, params) => {
    switch (method) {
      case 'status':
        return Promise.resolve({ running: true });
      case 'escalations.list':
        return Promise.resolve(opts.escalations ?? []);
      case 'workflows.list':
        return Promise.resolve(opts.workflows ?? []);
      case 'workflows.get': {
        const id = (params as { workflowId: string }).workflowId;
        const answer = opts.details?.[id];
        return answer === undefined ? Promise.reject(new Error(`no detail for ${id}`)) : Promise.resolve(answer);
      }
      case 'personas.listCompiles':
        return Promise.resolve({ active: [], recent: [], queueDepth: 0 });
      default:
        // sessions.list, jobs.list
        return Promise.resolve([]);
    }
  });
}

function requested(method: string): boolean {
  return mockRequest.mock.calls.some(([called]) => called === method);
}

/** Starts a (re)connect refresh and returns a promise for its completion. */
function reconnect(): () => Promise<void> {
  getWsClient();
  const generation = connectionGeneration.value;
  capturedOnConnectionChange?.(true);
  return () =>
    vi.waitFor(() => {
      expect(connectionGeneration.value).toBe(generation + 1);
    });
}

function event(name: string, payload: unknown): void {
  expect(capturedOnEvent).toBeDefined();
  capturedOnEvent?.(name, payload);
}

beforeEach(() => {
  mockRequest.mockReset();
  appState.sessions = new Map();
  appState.sessionOutputs = new Map();
  appState.pendingEscalations = new Map();
  appState.workflows = new Map();
  appState.pendingGates = new Map();
  appState.pendingWorkflowEscalations = new Map();
  appState.escalationLoadError = null;
  appState.refreshErrors = {};
  appState.workflowReviewErrors = new Map();
});

describe('refreshAll and session escalation events', () => {
  it('keeps successful refresh domains and gates visible when escalation loading fails', async () => {
    appState.daemonStatus = null;
    const gate = {
      gateId: 'gate-refresh',
      workflowId: 'wf-refresh',
      stateName: 'review',
      acceptedEvents: ['APPROVE'],
      presentedArtifacts: [],
      summary: 'Review the example result.',
    };
    answerRefresh({
      workflows: [summary('wf-refresh', 'waiting_human')],
      details: { 'wf-refresh': { ...detail('wf-refresh', 'waiting_human'), gate } },
    });
    const normal = mockRequest.getMockImplementation();
    if (!normal) throw new Error('expected refresh fixture');
    mockRequest.mockImplementation((method, params) =>
      method === 'escalations.list' ? Promise.reject(new Error('fixture unavailable')) : normal(method, params),
    );

    await reconnect()();

    expect(appState.daemonStatus).toEqual({ running: true });
    expect(appState.workflows.has('wf-refresh')).toBe(true);
    expect(appState.pendingGates.get('gate-refresh')).toEqual(gate);
    expect(appState.escalationLoadError).toBeTruthy();
  });

  // Runs first: the store treats the first connect of this module as the initial one.
  it('keeps an escalation raised while the rest of the refresh is in flight, and counts it as new', async () => {
    const workflowDetail = deferred<WorkflowDetailDto>();
    answerRefresh({
      escalations: [],
      workflows: [summary('wf-1', 'waiting_human')],
      details: { 'wf-1': workflowDetail.promise },
    });
    const done = reconnect();
    await vi.waitFor(() => expect(requested('workflows.get')).toBe(true));

    // escalations.list has answered; workflows.get has not.
    event('escalation.created', escalation('raised-meanwhile'));
    workflowDetail.resolve(detail('wf-1', 'waiting_human'));
    await done();

    const pending = appState.pendingEscalations.get('raised-meanwhile');
    expect(pending).toBeDefined();
    // It arrived after the initial snapshot, so it opens the modal.
    expect((pending?.displayNumber ?? 0) > appState.escalationDismissedAt).toBe(true);
  });

  it('does not bring back an escalation resolved while the rest of the refresh is in flight', async () => {
    const workflowDetail = deferred<WorkflowDetailDto>();
    answerRefresh({
      escalations: [escalation('resolved-meanwhile'), escalation('still-pending')],
      workflows: [summary('wf-1', 'waiting_human')],
      details: { 'wf-1': workflowDetail.promise },
    });
    const done = reconnect();
    await vi.waitFor(() => expect(requested('workflows.get')).toBe(true));

    event('escalation.resolved', { escalationId: 'resolved-meanwhile', decision: 'approved' });
    workflowDetail.resolve(detail('wf-1', 'waiting_human'));
    await done();

    expect([...appState.pendingEscalations.keys()]).toEqual(['still-pending']);
  });

  it('keeps an escalation raised before an answer that does not list it yet', async () => {
    const list = deferred<EscalationDto[]>();
    answerRefresh({ escalations: list.promise });
    const done = reconnect();
    await vi.waitFor(() => expect(requested('escalations.list')).toBe(true));

    // The answer was computed before this escalation was raised, and the
    // event reaches the client first.
    event('escalation.created', escalation('raised-before-answer'));
    list.resolve([escalation('listed')]);
    await done();

    expect([...appState.pendingEscalations.keys()].sort()).toEqual(['listed', 'raised-before-answer']);
  });

  it('does not bring back an escalation that ended before an answer that still lists it', async () => {
    appState.pendingEscalations = new Map([
      ['expired-before-answer', { ...escalation('expired-before-answer'), displayNumber: 1 }],
    ]);
    const list = deferred<EscalationDto[]>();
    answerRefresh({ escalations: list.promise });
    const done = reconnect();
    await vi.waitFor(() => expect(requested('escalations.list')).toBe(true));

    event('escalation.expired', { escalationId: 'expired-before-answer', sessionLabel: 1 });
    list.resolve([escalation('expired-before-answer'), escalation('listed')]);
    await done();

    expect([...appState.pendingEscalations.keys()]).toEqual(['listed']);
  });

  it('drops a listed escalation of a session that ended while the list was requested', async () => {
    const list = deferred<EscalationDto[]>();
    answerRefresh({ escalations: list.promise });
    const done = reconnect();
    await vi.waitFor(() => expect(requested('escalations.list')).toBe(true));

    event('session.ended', { label: 7, reason: 'user_ended' });
    list.resolve([escalation('of-ended-session', 7), escalation('of-live-session', 8)]);
    await done();

    expect([...appState.pendingEscalations.keys()]).toEqual(['of-live-session']);
  });

  it('drops escalations held from before the refresh that the daemon no longer lists', async () => {
    appState.pendingEscalations = new Map([['gone', { ...escalation('gone'), displayNumber: 1 }]]);
    answerRefresh({ escalations: [escalation('listed')] });
    await reconnect()();

    expect([...appState.pendingEscalations.keys()]).toEqual(['listed']);
  });
});

describe('refreshAll and workflow tool-call escalations', () => {
  it('rebuilds them from the detail of every live workflow after a reconnect', async () => {
    // While disconnected: wf-1 (running) and wf-2 (at a gate) raised tool-call
    // escalations, wf-1's earlier one was resolved, and wf-3 finished.
    appState.pendingWorkflowEscalations = new Map([
      ['wf-1-resolved', workflowEscalation('wf-1-resolved', 'wf-1')],
      ['wf-3-finished', workflowEscalation('wf-3-finished', 'wf-3')],
      ['wf-4-gone', workflowEscalation('wf-4-gone', 'wf-4')],
    ]);
    answerRefresh({
      workflows: [summary('wf-1', 'running'), summary('wf-2', 'waiting_human'), summary('wf-3', 'completed')],
      details: {
        'wf-1': detail('wf-1', 'running', [workflowEscalation('wf-1-live', 'wf-1')]),
        'wf-2': detail('wf-2', 'waiting_human', [workflowEscalation('wf-2-live', 'wf-2')]),
      },
    });
    await reconnect()();

    expect([...appState.pendingWorkflowEscalations.keys()].sort()).toEqual(['wf-1-live', 'wf-2-live']);
    // A finished workflow has nothing to fetch.
    expect(mockRequest).not.toHaveBeenCalledWith('workflows.get', { workflowId: 'wf-3' });
  });

  it('keeps one raised and drops one resolved while the detail was requested', async () => {
    appState.pendingWorkflowEscalations = new Map([['resolved', workflowEscalation('resolved')]]);
    const workflowDetail = deferred<WorkflowDetailDto>();
    answerRefresh({ workflows: [summary('wf-1', 'running')], details: { 'wf-1': workflowDetail.promise } });
    const done = reconnect();
    await vi.waitFor(() => expect(requested('workflows.get')).toBe(true));

    event('workflow.escalation_raised', { workflowId: 'wf-1', escalation: workflowEscalation('raised') });
    event('workflow.escalation_resolved', { workflowId: 'wf-1', escalationId: 'resolved', outcome: 'approved' });
    // Computed before both events.
    workflowDetail.resolve(detail('wf-1', 'running', [workflowEscalation('resolved')]));
    await done();

    expect([...appState.pendingWorkflowEscalations.keys()]).toEqual(['raised']);
  });

  it('keeps an escalation of a workflow that started after the list was taken', async () => {
    const workflows = deferred<WorkflowSummaryDto[]>();
    answerRefresh({ workflows: workflows.promise });
    const done = reconnect();
    await vi.waitFor(() => expect(requested('workflows.list')).toBe(true));

    event('workflow.escalation_raised', { workflowId: 'wf-new', escalation: workflowEscalation('new', 'wf-new') });
    workflows.resolve([]);
    await done();

    expect([...appState.pendingWorkflowEscalations.keys()]).toEqual(['new']);
  });

  it('keeps held reviews and newer events visible when a workflow detail cannot be read', async () => {
    appState.pendingWorkflowEscalations = new Map([['held', workflowEscalation('held')]]);
    const workflowDetail = deferred<WorkflowDetailDto>();
    answerRefresh({ workflows: [summary('wf-1', 'running')], details: { 'wf-1': workflowDetail.promise } });
    const done = reconnect();
    await vi.waitFor(() => expect(requested('workflows.get')).toBe(true));

    event('workflow.escalation_raised', { workflowId: 'wf-1', escalation: workflowEscalation('raised') });
    workflowDetail.reject(new Error('detail unavailable'));
    await done();

    expect([...appState.pendingWorkflowEscalations.keys()]).toEqual(['held', 'raised']);
    expect(appState.workflowReviewErrors.has('wf-1')).toBe(true);
  });
});

describe('getWorkflowDetail', () => {
  it('keeps a held gate visible on failed detail refresh and restores approval after a successful read', async () => {
    const gate = {
      gateId: 'held-gate',
      workflowId: 'wf-1',
      stateName: 'review',
      acceptedEvents: ['APPROVE'],
      presentedArtifacts: [],
      summary: 'Review an example result.',
    };
    appState.pendingGates = new Map([[gate.gateId, gate]]);
    answerRefresh({ workflows: [summary('wf-1', 'waiting_human')] });
    await reconnect()();
    expect(appState.pendingGates.get(gate.gateId)).toEqual(gate);
    expect(appState.workflowReviewErrors.has('wf-1')).toBe(true);
    expect(appState.reviewRefreshError).toBeTruthy();
    await expect(resolveWorkflowGate('wf-1', gate.gateId, 'APPROVE')).rejects.toThrow('Refresh this workflow review');
    expect(requested('workflows.resolveGate')).toBe(false);
    answerRefresh({ details: { 'wf-1': { ...detail('wf-1', 'waiting_human'), gate } } });
    await getWorkflowDetail('wf-1');
    expect(appState.workflowReviewErrors.has('wf-1')).toBe(false);
  });

  it('does not discard a held gate when the workflow list fails', async () => {
    const gate = {
      gateId: 'held-gate',
      workflowId: 'wf-1',
      stateName: 'review',
      acceptedEvents: ['APPROVE'],
      presentedArtifacts: [],
      summary: 'Review an example result.',
    };
    appState.pendingGates = new Map([[gate.gateId, gate]]);
    answerRefresh({});
    const normal = mockRequest.getMockImplementation();
    if (!normal) throw new Error('expected refresh fixture');
    mockRequest.mockImplementation((method, params) =>
      method === 'workflows.list' ? Promise.reject(new Error('fixture unavailable')) : normal(method, params),
    );
    await reconnect()();
    expect(appState.pendingGates.get(gate.gateId)).toEqual(gate);
    expect(appState.refreshErrors.workflows).toBeTruthy();
    answerRefresh({
      workflows: [summary('wf-1', 'waiting_human')],
      details: { 'wf-1': { ...detail('wf-1', 'waiting_human'), gate } },
    });
    await reconnect()();
    expect(appState.refreshErrors.workflows).toBeUndefined();
    expect(appState.escalationLoadError).toBeNull();
  });

  it("replaces the workflow's tool-call escalations with the detail's and keeps other workflows'", async () => {
    appState.pendingWorkflowEscalations = new Map([
      ['stale', workflowEscalation('stale', 'wf-1')],
      ['other', workflowEscalation('other', 'wf-2')],
    ]);
    answerRefresh({ details: { 'wf-1': detail('wf-1', 'running', [workflowEscalation('live', 'wf-1')]) } });

    await getWorkflowDetail('wf-1');

    expect([...appState.pendingWorkflowEscalations.keys()].sort()).toEqual(['live', 'other']);
  });

  it('keeps an escalation raised before an answer that does not list it yet', async () => {
    const workflowDetail = deferred<WorkflowDetailDto>();
    answerRefresh({ details: { 'wf-1': workflowDetail.promise } });
    getWsClient();

    const fetched = getWorkflowDetail('wf-1');
    event('workflow.escalation_raised', { workflowId: 'wf-1', escalation: workflowEscalation('raised') });
    workflowDetail.resolve(detail('wf-1', 'running'));
    await fetched;

    expect([...appState.pendingWorkflowEscalations.keys()]).toEqual(['raised']);
  });
});
