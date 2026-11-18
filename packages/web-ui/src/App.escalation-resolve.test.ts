/**
 * Escalation modal failure visibility, driven through the REAL store and the
 * real EscalationModal with a mocked WebSocket client (WEB-10).
 *
 * When an approval arrives after the proxy timed the request out, the daemon
 * first broadcasts `escalation.expired` (so every client drops the card) and
 * then answers the RPC with ESCALATION_EXPIRED. If that was the only pending
 * escalation, App's empty-queue effect closes the modal before the error
 * reply lands, so the operator would see exactly what a successful approval
 * looks like although the tool call was denied. The modal must stay up and
 * say why.
 *
 * Approve acts only once the escalation has been on screen for the modal's
 * arming delay; timers are faked so that wait costs no real time.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import type { EscalationDto } from './lib/types.js';

vi.stubGlobal(
  'matchMedia',
  vi.fn().mockImplementation(() => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })),
);

const mockRequest = vi.fn<(method: string, params?: Record<string, unknown>) => Promise<unknown>>();
let capturedOnEvent: ((event: string, payload: unknown) => void) | undefined;

const mockClient = {
  request: mockRequest,
  onEvent: vi.fn((handler: (event: string, payload: unknown) => void) => {
    capturedOnEvent = handler;
    return () => {};
  }),
  onConnectionChange: vi.fn(() => () => {}),
  onAuthError: vi.fn(() => () => {}),
  get isConnected() {
    return true;
  },
  connect: vi.fn(),
  disconnect: vi.fn(),
};

vi.mock('./lib/ws-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/ws-client.js')>();
  return { ...actual, createWsClient: () => mockClient };
});

// Routed views are irrelevant here; keep their RPC wiring out of the test.
vi.mock('./routes/Dashboard.svelte', async () => await import('./__test_stubs__/Stub.svelte'));
vi.mock('./routes/Sessions.svelte', async () => await import('./__test_stubs__/Stub.svelte'));
vi.mock('./routes/Escalations.svelte', async () => await import('./__test_stubs__/Stub.svelte'));
vi.mock('$lib/components/features/matrix-rain.svelte', async () => await import('./__test_stubs__/Stub.svelte'));
vi.mock('$lib/flash-title.js', () => ({ startFlashTitle: () => () => undefined }));

import App from './App.svelte';
import { ESCALATION_ARM_DELAY_MS } from './lib/components/features/escalation-modal.svelte';
import { appState, getWsClient } from './lib/stores.svelte.js';

/** A real mouse click: the press, then the click it produces. */
async function click(element: HTMLElement): Promise<void> {
  await fireEvent.pointerDown(element);
  await fireEvent.mouseDown(element);
  await fireEvent.pointerUp(element);
  await fireEvent.mouseUp(element);
  await fireEvent.click(element);
}

const resolveRequests = (): unknown[][] =>
  mockRequest.mock.calls.filter(([method]) => method === 'escalations.resolve');

function escalation(escalationId: string): EscalationDto {
  return {
    escalationId,
    sessionLabel: 3,
    sessionSource: { kind: 'web-pty' },
    toolName: 'write_file',
    serverName: 'filesystem',
    arguments: { path: '/etc/hosts' },
    reason: 'Protected path',
    receivedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('App escalation modal: a failed resolve stays visible', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mockRequest.mockReset();
    getWsClient(); // wires the store's event handler into capturedOnEvent
    expect(capturedOnEvent).toBeDefined();
    appState.hasToken = true;
    appState.connected = true;
    appState.currentView = 'dashboard';
    appState.pendingEscalations = new Map();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the modal open with the error when the only escalation expired before the approval landed', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockRequest.mockImplementation((method) => {
      if (method === 'escalations.resolve') {
        // The daemon announces the expiry, then replies with the error.
        capturedOnEvent?.('escalation.expired', { escalationId: 'esc-late', sessionLabel: 3 });
        return Promise.reject(
          new Error('Escalation esc-late expired before the response arrived; the tool call was denied'),
        );
      }
      return Promise.resolve([]);
    });
    render(App);

    capturedOnEvent?.('escalation.created', escalation('esc-late'));
    const approve = await screen.findByRole('button', { name: 'Approve' });

    // The modal opened on its own: a click during the arming delay sends nothing.
    await click(approve);
    expect(resolveRequests()).toHaveLength(0);
    expect(screen.queryByTestId('escalation-resolve-error')).toBeNull();

    await vi.advanceTimersByTimeAsync(ESCALATION_ARM_DELAY_MS);
    await tick();
    await click(approve);
    expect(resolveRequests()).toHaveLength(1);

    const alert = await screen.findByTestId('escalation-resolve-error');
    expect(alert.textContent).toContain('Failed to approve');
    expect(alert.textContent).toContain('the tool call was denied');
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(appState.pendingEscalations.size).toBe(0);

    // Dismissing it, then a new escalation: the old failure is not shown again.
    await fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    capturedOnEvent?.('escalation.created', escalation('esc-next'));
    expect(await screen.findByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(screen.queryByTestId('escalation-resolve-error')).toBeNull();
    errorSpy.mockRestore();
  });
});
