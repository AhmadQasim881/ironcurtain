/**
 * refreshAll runs on every (re)connect. It must keep the display number of
 * escalations the UI already knows: a fresh number above the dismissal
 * watermark re-opens the modal, and the user had already dismissed these.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EscalationDto } from '../types.js';

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

import { appState, getWsClient } from '../stores.svelte.js';

function escalation(id: string): EscalationDto {
  return {
    escalationId: id,
    sessionLabel: 1,
    sessionSource: { kind: 'web-pty' },
    toolName: 'write_file',
    serverName: 'filesystem',
    arguments: { path: '/etc/hosts' },
    reason: 'Write to protected system path',
    receivedAt: '2026-01-01T00:00:00.000Z',
  };
}

let escalationsList: EscalationDto[] = [];

function configureRefresh(): void {
  mockRequest.mockImplementation((method) => {
    switch (method) {
      case 'escalations.list':
        return Promise.resolve(escalationsList);
      case 'sessions.list':
      case 'jobs.list':
      case 'workflows.list':
        return Promise.resolve([]);
      case 'status':
        return Promise.resolve({});
      case 'personas.listCompiles':
        return Promise.resolve({ active: [], recent: [], queueDepth: 0 });
      default:
        return Promise.resolve(undefined);
    }
  });
}

async function connect(list: EscalationDto[]): Promise<void> {
  escalationsList = list;
  getWsClient();
  capturedOnConnectionChange?.(true);
  await vi.waitFor(() => {
    expect([...appState.pendingEscalations.keys()].sort()).toEqual(list.map((e) => e.escalationId).sort());
  });
  // Let the rest of refreshAll settle (the escalation map is set near its end).
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('refreshAll escalation numbering', () => {
  beforeEach(() => {
    mockRequest.mockReset();
    configureRefresh();
    appState.pendingEscalations = new Map();
    appState.sessionOutputs = new Map();
  });

  it('keeps display numbers across reconnects and numbers only unseen escalations', async () => {
    await connect([escalation('e1')]);
    const firstNumber = appState.pendingEscalations.get('e1')?.displayNumber;
    expect(firstNumber).toBeDefined();
    // Initial connect: pre-existing escalations never auto-open.
    expect(appState.escalationDismissedAt).toBe(appState.escalationDisplayNumber);
    const watermarkAfterInitial = appState.escalationDisplayNumber;

    // Reconnect with the same pending escalation: nothing is new.
    await connect([escalation('e1')]);
    expect(appState.pendingEscalations.get('e1')?.displayNumber).toBe(firstNumber);
    expect(appState.escalationDisplayNumber).toBe(watermarkAfterInitial);
    expect(appState.escalationDisplayNumber > appState.escalationDismissedAt).toBe(false);

    // Reconnect after a new escalation arrived while the socket was down.
    await connect([escalation('e1'), escalation('e2')]);
    expect(appState.pendingEscalations.get('e1')?.displayNumber).toBe(firstNumber);
    expect(appState.pendingEscalations.get('e2')?.displayNumber).toBe(watermarkAfterInitial + 1);
    expect(appState.escalationDisplayNumber).toBe(watermarkAfterInitial + 1);
    // Only the genuinely new one makes the modal eligible to open.
    expect(appState.escalationDisplayNumber > appState.escalationDismissedAt).toBe(true);
  });
});
