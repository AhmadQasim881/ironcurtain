import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HumanGateRequestDto, WorkflowDetailDto, WorkflowSummaryDto } from '../types.js';

// ---------------------------------------------------------------------------
// Mock the WS client so the store's RPC calls and its reconnect refresh can be
// driven directly (same seam as stores-pty.test.ts).
// ---------------------------------------------------------------------------

const mockRequest = vi.fn<(method: string, params?: Record<string, unknown>) => Promise<unknown>>();
let capturedOnConnectionChange: ((connected: boolean) => void) | undefined;

const mockClient = {
  request: mockRequest,
  onEvent: vi.fn(() => () => {}),
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

import { appState, getWsClient, resolveWorkflowGate, syncWorkflowGateFromDetail } from '../stores.svelte.js';
import { RpcError } from '../ws-client.js';

function gate(workflowId: string, gateId: string, stateName = 'review'): HumanGateRequestDto {
  return { gateId, workflowId, stateName, acceptedEvents: ['APPROVE', 'ABORT'], presentedArtifacts: [], summary: 's' };
}

function summary(workflowId: string, phase: WorkflowSummaryDto['phase']): WorkflowSummaryDto {
  return {
    workflowId,
    name: 'wf',
    phase,
    currentState: 'review',
    startedAt: '2026-01-01T00:00:00Z',
    taskDescription: '',
    round: 0,
    maxRounds: 0,
    totalTokens: 0,
  };
}

function detail(workflowId: string, phase: WorkflowSummaryDto['phase'], g?: HumanGateRequestDto): WorkflowDetailDto {
  return {
    ...summary(workflowId, phase),
    startedAt: '2026-01-01T00:00:00Z',
    description: '',
    stateGraph: { states: [], transitions: [] },
    transitionHistory: [],
    context: { taskDescription: '', round: 0, maxRounds: 0, totalTokens: 0, visitCounts: {} },
    workspacePath: '/tmp/ws',
    hasReadme: false,
    ...(g ? { gate: g } : {}),
  } as WorkflowDetailDto;
}

/** Routes the reconnect refresh's RPCs to canned answers. */
function answerRefresh(opts: { workflows: WorkflowSummaryDto[]; details: Record<string, WorkflowDetailDto> }): void {
  mockRequest.mockImplementation((method, params) => {
    switch (method) {
      case 'status':
        return Promise.resolve({ running: true });
      case 'jobs.list':
      case 'escalations.list':
      case 'sessions.list':
        return Promise.resolve([]);
      case 'workflows.list':
        return Promise.resolve(opts.workflows);
      case 'personas.listCompiles':
        return Promise.resolve({ active: [], recent: [], queueDepth: 0 });
      case 'workflows.get': {
        const id = (params as { workflowId: string }).workflowId;
        const d = opts.details[id];
        return d ? Promise.resolve(d) : Promise.reject(new Error(`no detail for ${id}`));
      }
      default:
        return Promise.resolve(undefined);
    }
  });
}

describe('gate store actions', () => {
  beforeEach(() => {
    mockRequest.mockReset();
    mockRequest.mockResolvedValue(undefined);
    appState.pendingGates = new Map();
    appState.workflows = new Map();
  });

  it('resolveWorkflowGate binds the decision to the displayed gate and declares the web-ui channel', async () => {
    await resolveWorkflowGate('wf-1', 'wf-1-review-2-abcd', 'FORCE_REVISION', 'tighten it');
    expect(mockRequest).toHaveBeenCalledWith('workflows.resolveGate', {
      workflowId: 'wf-1',
      gateId: 'wf-1-review-2-abcd',
      event: 'FORCE_REVISION',
      prompt: 'tighten it',
      resolvedBy: 'web-ui',
    });
  });

  it('re-reads the workflow gate when a decision is refused as stale, then reports the refusal', async () => {
    // The panel showed visit 1; another decider resolved it and the run is
    // now waiting at visit 2. Nothing was applied, and the stale gate must be
    // replaced by the live one so the next click reviews what is waiting.
    appState.pendingGates = new Map([['wf-1-review-1-stale', gate('wf-1', 'wf-1-review-1-stale')]]);
    const live = gate('wf-1', 'wf-1-review-2-live');
    mockRequest.mockImplementation((method) => {
      if (method === 'workflows.resolveGate') return Promise.reject(new RpcError('GATE_MISMATCH', 'stale gate'));
      if (method === 'workflows.get') return Promise.resolve(detail('wf-1', 'waiting_human', live));
      return Promise.resolve(undefined);
    });

    await expect(resolveWorkflowGate('wf-1', 'wf-1-review-1-stale', 'APPROVE')).rejects.toMatchObject({
      code: 'GATE_MISMATCH',
    });
    expect(mockRequest).toHaveBeenCalledWith('workflows.get', { workflowId: 'wf-1' });
    expect([...appState.pendingGates.keys()]).toEqual(['wf-1-review-2-live']);
  });

  it('drops the gate when the refusal says the workflow is no longer waiting', async () => {
    appState.pendingGates = new Map([['wf-1-review-1-gone', gate('wf-1', 'wf-1-review-1-gone')]]);
    mockRequest.mockImplementation((method) => {
      if (method === 'workflows.resolveGate') {
        return Promise.reject(new RpcError('WORKFLOW_NOT_AT_GATE', 'not waiting'));
      }
      if (method === 'workflows.get') return Promise.resolve(detail('wf-1', 'running'));
      return Promise.resolve(undefined);
    });

    await expect(resolveWorkflowGate('wf-1', 'wf-1-review-1-gone', 'APPROVE')).rejects.toBeInstanceOf(RpcError);
    expect(appState.pendingGates.size).toBe(0);
  });

  it('keeps the gate and does not re-read it for a refusal that is not about staleness', async () => {
    const shown = gate('wf-1', 'wf-1-review-1-live');
    appState.pendingGates = new Map([[shown.gateId, shown]]);
    mockRequest.mockImplementation((method) =>
      method === 'workflows.resolveGate'
        ? Promise.reject(new RpcError('EVENT_NOT_ACCEPTED', 'no such event here'))
        : Promise.resolve(undefined),
    );

    await expect(resolveWorkflowGate('wf-1', shown.gateId, 'REPLAN', 'redo')).rejects.toMatchObject({
      code: 'EVENT_NOT_ACCEPTED',
    });
    expect(mockRequest).not.toHaveBeenCalledWith('workflows.get', expect.anything());
    expect([...appState.pendingGates.keys()]).toEqual([shown.gateId]);
  });

  it('syncWorkflowGateFromDetail replaces the workflow gate and drops it when the run is not waiting', () => {
    appState.pendingGates = new Map([
      ['wf-1-review-1-old', gate('wf-1', 'wf-1-review-1-old')],
      ['wf-2-review-1-keep', gate('wf-2', 'wf-2-review-1-keep')],
    ]);

    syncWorkflowGateFromDetail('wf-1', detail('wf-1', 'waiting_human', gate('wf-1', 'wf-1-review-2-new')));
    expect([...appState.pendingGates.keys()].sort()).toEqual(['wf-1-review-2-new', 'wf-2-review-1-keep']);

    syncWorkflowGateFromDetail('wf-1', detail('wf-1', 'running'));
    expect([...appState.pendingGates.keys()]).toEqual(['wf-2-review-1-keep']);
  });

  it('rebuilds pendingGates from server state on reconnect, dropping gates the client missed the dismissal of', async () => {
    // While disconnected: wf-1 moved from its first review visit to a second
    // (new gate id), and wf-2's gate was resolved (the run is now running).
    appState.pendingGates = new Map([
      ['wf-1-review-1-stale', gate('wf-1', 'wf-1-review-1-stale')],
      ['wf-2-review-1-gone', gate('wf-2', 'wf-2-review-1-gone')],
    ]);
    const live = gate('wf-1', 'wf-1-review-2-live');
    answerRefresh({
      workflows: [summary('wf-1', 'waiting_human'), summary('wf-2', 'running')],
      details: { 'wf-1': detail('wf-1', 'waiting_human', live) },
    });

    getWsClient();
    expect(capturedOnConnectionChange).toBeDefined();
    capturedOnConnectionChange?.(true);

    await vi.waitFor(() => {
      expect(appState.pendingGates.has('wf-1-review-2-live')).toBe(true);
    });
    expect([...appState.pendingGates.keys()]).toEqual(['wf-1-review-2-live']);
    expect(appState.pendingGates.get('wf-1-review-2-live')).toEqual(live);
  });

  it('keeps a gate raised during the reconnect fetch for a workflow the list did not yet report as waiting', async () => {
    const stale = gate('wf-1', 'wf-1-review-1-stale');
    appState.pendingGates = new Map([['wf-1-review-1-stale', stale]]);
    // The list snapshot says wf-1 is running; a gate_raised for a new raise
    // lands while the refresh is in flight (simulated by adding it before the
    // fetch resolves). The newer raise must survive the rebuild.
    const raisedDuringFetch = gate('wf-1', 'wf-1-review-2-fresh');
    mockRequest.mockImplementation((method) => {
      switch (method) {
        case 'workflows.list':
          appState.pendingGates = new Map(appState.pendingGates).set(raisedDuringFetch.gateId, raisedDuringFetch);
          return Promise.resolve([summary('wf-1', 'running')]);
        case 'status':
          return Promise.resolve({ running: true });
        case 'personas.listCompiles':
          return Promise.resolve({ active: [], recent: [], queueDepth: 0 });
        default:
          return Promise.resolve([]);
      }
    });

    getWsClient();
    capturedOnConnectionChange?.(true);

    await vi.waitFor(() => {
      expect(appState.pendingGates.has('wf-1-review-1-stale')).toBe(false);
    });
    expect([...appState.pendingGates.keys()]).toEqual(['wf-1-review-2-fresh']);
  });

  it('applies each reconnect gate answer on arrival, so a dismissal handled after it is not undone', async () => {
    // wf-1's answer arrives first; its gate is then resolved elsewhere and the
    // gate_dismissed is handled while wf-2's answer is still in flight. The
    // dismissal is newer than wf-1's answer and must survive the refresh.
    const g1 = gate('wf-1', 'wf-1-review-1-a');
    const g2 = gate('wf-2', 'wf-2-review-1-b');
    let answerWf2: (d: WorkflowDetailDto) => void = () => {};
    mockRequest.mockImplementation((method, params) => {
      switch (method) {
        case 'status':
          return Promise.resolve({ running: true });
        case 'workflows.list':
          return Promise.resolve([summary('wf-1', 'waiting_human'), summary('wf-2', 'waiting_human')]);
        case 'personas.listCompiles':
          return Promise.resolve({ active: [], recent: [], queueDepth: 0 });
        case 'workflows.get':
          if ((params as { workflowId: string }).workflowId === 'wf-1') {
            return Promise.resolve(detail('wf-1', 'waiting_human', g1));
          }
          return new Promise<WorkflowDetailDto>((resolve) => {
            answerWf2 = resolve;
          });
        default:
          return Promise.resolve([]);
      }
    });

    getWsClient();
    capturedOnConnectionChange?.(true);

    await vi.waitFor(() => {
      expect(appState.pendingGates.has(g1.gateId)).toBe(true);
    });
    // The event handler's effect of `workflow.gate_dismissed` for g1.
    const afterDismissal = new Map(appState.pendingGates);
    afterDismissal.delete(g1.gateId);
    appState.pendingGates = afterDismissal;

    answerWf2(detail('wf-2', 'waiting_human', g2));
    await vi.waitFor(() => {
      expect(appState.pendingGates.has(g2.gateId)).toBe(true);
    });
    expect([...appState.pendingGates.keys()]).toEqual([g2.gateId]);
  });
});
