/**
 * Reconnect behaviour of the Sessions route, driven through the REAL store
 * with a mocked WebSocket client (WEB-5).
 *
 * The daemon drops a client's terminal subscription the moment its socket
 * closes and arms the idle reaper. The route must therefore re-send
 * `sessions.ptyAttach` after every reconnect (the attach effect is keyed on
 * the store's `connected` flag) and tell the user the terminal is detached in
 * the meantime. The attach effect used to depend only on the selected label,
 * which does not change on reconnect, so the terminal stayed frozen while
 * keystrokes still reached the agent.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/svelte';
import type { SessionDto } from '../lib/types.js';
import { mockSession } from '../lib/__tests__/fixtures.js';

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
    return true;
  },
  connect: vi.fn(),
  disconnect: vi.fn(),
};

vi.mock('../lib/ws-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/ws-client.js')>();
  return { ...actual, createWsClient: () => mockClient };
});

// xterm cannot run under jsdom; the stub ignores onready/onresize, which is
// fine here: the subject is the attach RPC traffic and the banner.
vi.mock('$lib/components/features/terminal-console.svelte', async () => await import('../__test_stubs__/Stub.svelte'));

import Sessions from './Sessions.svelte';
import { appState, getWsClient } from '../lib/stores.svelte.js';

const ptySession: SessionDto = mockSession(3, { source: { kind: 'web-pty' } });

function requestsFor(method: string): Array<Record<string, unknown> | undefined> {
  return mockRequest.mock.calls.filter(([m]) => m === method).map(([, params]) => params);
}

function configureRequests(
  attachImpl: (call: number) => Promise<unknown>,
  jobsListImpl: () => Promise<unknown> = () => Promise.resolve([]),
): void {
  let attachCalls = 0;
  mockRequest.mockImplementation((method) => {
    switch (method) {
      case 'sessions.ptyAttach':
        return attachImpl(++attachCalls);
      case 'jobs.list':
        return jobsListImpl();
      case 'sessions.list':
        return Promise.resolve([ptySession]);
      case 'status':
        return Promise.resolve({
          uptimeSeconds: 1,
          jobs: { total: 0, enabled: 0, running: 0 },
          signalConnected: false,
          webUiListening: true,
          activeSessions: 1,
          nextFireTime: null,
          sessionMode: 'container',
        });
      case 'personas.listCompiles':
        return Promise.resolve({ active: [], recent: [], queueDepth: 0 });
      case 'config.getModelProviders':
        return Promise.resolve({ providers: [], summaries: {}, default: 'native', profiles: {} });
      case 'escalations.list':
      case 'workflows.list':
      case 'personas.list':
        return Promise.resolve([]);
      default:
        return Promise.resolve(undefined);
    }
  });
}

describe('Sessions route: PTY re-attach after reconnect', () => {
  beforeEach(() => {
    mockRequest.mockReset();
    configureRequests(() => Promise.resolve({ attached: true }));
    // Wire the store's connection handler exactly once (module singleton).
    getWsClient();
    expect(capturedOnConnectionChange).toBeDefined();
    appState.connected = true;
    appState.daemonStatus = {
      uptimeSeconds: 1,
      jobs: { total: 0, enabled: 0, running: 0 },
      signalConnected: false,
      webUiListening: true,
      activeSessions: 1,
      nextFireTime: null,
      sessionMode: 'container',
    };
    appState.sessions = new Map([[ptySession.label, ptySession]]);
    appState.selectedSessionLabel = ptySession.label;
  });

  it('re-sends sessions.ptyAttach after the connection drops and returns, and shows a detached banner meanwhile', async () => {
    render(Sessions);
    await waitFor(() => expect(requestsFor('sessions.ptyAttach')).toHaveLength(1));
    expect(requestsFor('sessions.ptyAttach')[0]).toEqual({ label: ptySession.label });
    await waitFor(() => expect(screen.queryByTestId('pty-reattach-banner')).toBeNull());

    // The socket drops: the daemon has now removed this client's subscription.
    capturedOnConnectionChange?.(false);
    const banner = await screen.findByTestId('pty-reattach-banner');
    expect(banner.getAttribute('role')).toBe('status');
    expect(banner.textContent).toMatch(/detached/i);
    expect(requestsFor('sessions.ptyAttach')).toHaveLength(1);

    // Reconnect: the attach effect re-runs on the new connection.
    capturedOnConnectionChange?.(true);
    await waitFor(() => expect(requestsFor('sessions.ptyAttach')).toHaveLength(2));
    expect(requestsFor('sessions.ptyAttach')[1]).toEqual({ label: ptySession.label });
    await waitFor(() => expect(screen.queryByTestId('pty-reattach-banner')).toBeNull());

    // The reconnect must not have torn down the terminal binding: no detach
    // was sent (the sink keeps the mounted terminal's live handle).
    expect(requestsFor('sessions.ptyDetach')).toHaveLength(0);
  });

  it('reports a failed re-attach in the banner instead of silently leaving the terminal frozen', async () => {
    configureRequests((call) =>
      call === 1 ? Promise.resolve({ attached: true }) : Promise.reject(new Error('Session #3 not found')),
    );
    render(Sessions);
    await waitFor(() => expect(requestsFor('sessions.ptyAttach')).toHaveLength(1));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    capturedOnConnectionChange?.(false);
    await screen.findByTestId('pty-reattach-banner');
    capturedOnConnectionChange?.(true);

    await waitFor(() => expect(requestsFor('sessions.ptyAttach')).toHaveLength(2));
    await waitFor(() => expect(screen.getByTestId('pty-reattach-banner').textContent).toMatch(/failed/i));
    expect(screen.getByTestId('pty-reattach-banner').textContent).toContain('Session #3 not found');
    errorSpy.mockRestore();
  });

  it('detaches and unregisters only when the selection changes, not on reconnect', async () => {
    render(Sessions);
    await waitFor(() => expect(requestsFor('sessions.ptyAttach')).toHaveLength(1));

    capturedOnConnectionChange?.(false);
    capturedOnConnectionChange?.(true);
    await waitFor(() => expect(requestsFor('sessions.ptyAttach')).toHaveLength(2));
    expect(requestsFor('sessions.ptyDetach')).toHaveLength(0);

    // Deselecting the terminal is what detaches it.
    appState.selectedSessionLabel = null;
    await waitFor(() => expect(requestsFor('sessions.ptyDetach')).toHaveLength(1));
    expect(requestsFor('sessions.ptyDetach')[0]).toEqual({ label: ptySession.label });
  });

  // The re-attach must not hinge on the reconnect's unrelated state refresh:
  // `connectionGeneration` is only bumped when every refresh RPC succeeds, so
  // one failing or timed-out request (common exactly when the daemon is under
  // load, which is when sockets drop) used to leave the terminal frozen.
  it('re-attaches after a reconnect even when the state refresh fails', async () => {
    let failRefresh = false;
    configureRequests(
      () => Promise.resolve({ attached: true }),
      () => (failRefresh ? Promise.reject(new Error('Request timed out')) : Promise.resolve([])),
    );
    render(Sessions);
    await waitFor(() => expect(requestsFor('sessions.ptyAttach')).toHaveLength(1));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    capturedOnConnectionChange?.(false);
    await screen.findByTestId('pty-reattach-banner');
    failRefresh = true;
    capturedOnConnectionChange?.(true);

    await waitFor(() => expect(requestsFor('sessions.ptyAttach')).toHaveLength(2));
    await waitFor(() => expect(screen.queryByTestId('pty-reattach-banner')).toBeNull());
    errorSpy.mockRestore();
  });

  it('does not send a doomed attach while disconnected, and attaches once per reconnect', async () => {
    render(Sessions);
    await waitFor(() => expect(requestsFor('sessions.ptyAttach')).toHaveLength(1));

    capturedOnConnectionChange?.(false);
    await screen.findByTestId('pty-reattach-banner');
    expect(requestsFor('sessions.ptyAttach')).toHaveLength(1);

    capturedOnConnectionChange?.(true);
    await waitFor(() => expect(requestsFor('sessions.ptyAttach')).toHaveLength(2));
    // Let the reconnect's refresh (and its connectionGeneration bump) settle:
    // no second, redundant replay request for the same reconnect.
    await waitFor(() => expect(requestsFor('jobs.list').length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requestsFor('sessions.ptyAttach')).toHaveLength(2);
  });
});
