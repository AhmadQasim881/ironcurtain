/**
 * Session notices in the session view (FU-10, triage 08-07 and 05-02), driven
 * through the REAL store with a mocked WebSocket client.
 *
 * The daemon reports start-up notices (an MCP server that could not start, a
 * host model without credentials, annotation drift, a stale compiled policy)
 * and host-mount findings as `session.diagnostic` events and keeps them in
 * the session's `diagnosticLog` (`sessions.get`). The web UI used to handle
 * neither, so a web user was never told that, say, the github server's
 * tools were missing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import type { DaemonStatusDto, SessionDto } from '../lib/types.js';
import { mockSession } from '../lib/__tests__/fixtures.js';

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
    return true;
  },
  connect: vi.fn(),
  disconnect: vi.fn(),
};

vi.mock('../lib/ws-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/ws-client.js')>();
  return { ...actual, createWsClient: () => mockClient };
});

vi.mock('$lib/components/features/terminal-console.svelte', async () => await import('../__test_stubs__/Stub.svelte'));

import Sessions from './Sessions.svelte';
import { appState, getWsClient } from '../lib/stores.svelte.js';

/** A Signal session: the web UI cannot show it, but shows what it reported. */
const signalSession: SessionDto = mockSession(5, { source: { kind: 'signal' } });

/** U+202E (right-to-left override), built so no raw one sits in this source. */
const RLO = String.fromCodePoint(0x202e);

const UNAVAILABLE = {
  kind: 'mcp_server_unavailable',
  serverName: 'github',
  reason: 'relay exited before the handshake',
};

const DAEMON_STATUS: DaemonStatusDto = {
  uptimeSeconds: 1,
  jobs: { total: 0, enabled: 0, running: 0 },
  signalConnected: true,
  webUiListening: true,
  activeSessions: 1,
  nextFireTime: null,
  sessionMode: 'container',
};

function requestsFor(method: string): Array<Record<string, unknown> | undefined> {
  return mockRequest.mock.calls.filter(([m]) => m === method).map(([, params]) => params);
}

function notices(): HTMLElement[] {
  return screen.queryAllByTestId('session-notice');
}

describe('Sessions route: session notices', () => {
  beforeEach(() => {
    mockRequest.mockReset();
    mockRequest.mockImplementation((method, params) => {
      if (method === 'sessions.get' && params?.label === signalSession.label) {
        return Promise.resolve({
          ...signalSession,
          history: [],
          diagnosticLog: [{ kind: 'tool_call', toolName: 'github.list_issues', preview: 'allowed' }, UNAVAILABLE],
        });
      }
      if (method === 'personas.list') return Promise.resolve([]);
      if (method === 'config.getModelProviders') {
        return Promise.resolve({ providers: [], summaries: {}, default: 'native', profiles: {} });
      }
      return Promise.resolve(undefined);
    });
    getWsClient();
    expect(capturedOnEvent).toBeDefined();
    appState.connected = true;
    appState.daemonStatus = DAEMON_STATUS;
    appState.sessionNotices = new Map();
    appState.sessions = new Map([[signalSession.label, signalSession]]);
    appState.selectedSessionLabel = signalSession.label;
  });

  it("shows the notices in the session's diagnostic log when the session is selected", async () => {
    render(Sessions);

    await waitFor(() => expect(notices()).toHaveLength(1));
    expect(requestsFor('sessions.get')).toEqual([{ label: signalSession.label }]);
    expect(notices()[0].textContent).toContain('MCP server "github" is unavailable');
    expect(notices()[0].textContent).toContain('relay exited before the handshake');
    expect(notices()[0].getAttribute('role')).toBe('alert');
  });

  it('shows a notice pushed as session.diagnostic, and hides one the user dismisses', async () => {
    render(Sessions);
    await waitFor(() => expect(notices()).toHaveLength(1));

    capturedOnEvent?.('session.diagnostic', {
      label: signalSession.label,
      event: {
        kind: 'policy_stale',
        message: 'Warning: the compiled policy at /home/u/.ironcurtain/generated/compiled-policy.json may be stale:',
      },
    });
    await waitFor(() => expect(notices()).toHaveLength(2));
    expect(notices()[1].textContent).toContain('The compiled policy may be stale');

    // A diagnostic that is not a notice is not shown.
    capturedOnEvent?.('session.diagnostic', {
      label: signalSession.label,
      event: { kind: 'tool_call', toolName: 'github.list_issues', preview: 'allowed' },
    });

    await fireEvent.click(screen.getAllByRole('button', { name: 'Dismiss' })[0]);
    await waitFor(() => expect(notices()).toHaveLength(1));
    expect(notices()[0].textContent).toContain('The compiled policy may be stale');
  });

  it('renders agent-chosen file names in a host-mount finding with visible escapes', async () => {
    render(Sessions);
    await waitFor(() => expect(notices()).toHaveLength(1));

    capturedOnEvent?.('session.diagnostic', {
      label: signalSession.label,
      event: {
        kind: 'host_privileged_files',
        when: 'after agent turn',
        stripped: 0,
        unstripped: 1,
        rootOwned: 0,
        unlisted: 0,
        paths: [`/home/u/project/bin/sh${RLO}exe.txt`],
        incomplete: false,
        hint: 'Remove them as root (for example with sudo rm).',
      },
    });

    await waitFor(() => expect(notices()).toHaveLength(2));
    const finding = notices()[1];
    expect(finding.textContent).toContain("Setuid/setgid or root-owned files in the agent's host mounts");
    expect(finding.textContent).toContain('sudo rm');
    expect(finding.textContent).not.toContain(RLO);
    expect(finding.querySelector('[data-invisible-char]')?.textContent).toBe('\\u202e');
  });

  it("never shows a session another session's notices when a restarted daemon gives it the same label", async () => {
    render(Sessions);
    await waitFor(() => expect(notices()).toHaveLength(1));
    expect(notices()[0].textContent).toContain('MCP server "github" is unavailable');

    // The daemon restarts and numbers its sessions from 1 again: label 5 now
    // names a cron run, which reported a stale policy and nothing about github.
    const cronSession = mockSession(signalSession.label, {
      source: { kind: 'cron', jobId: 'triage', jobName: 'Triage' },
      createdAt: '2026-11-15T09:00:00Z',
    });
    mockRequest.mockImplementation((method, params) => {
      switch (method) {
        case 'sessions.list':
          return Promise.resolve([cronSession]);
        case 'sessions.get':
          return params?.label === cronSession.label
            ? Promise.resolve({
                ...cronSession,
                history: [],
                diagnosticLog: [{ kind: 'policy_stale', message: 'Warning: the compiled policy at /p may be stale:' }],
              })
            : Promise.reject(new Error('Session not found'));
        case 'status':
          return Promise.resolve(DAEMON_STATUS);
        case 'personas.listCompiles':
          return Promise.resolve({ active: [], recent: [], queueDepth: 0 });
        case 'config.getModelProviders':
          return Promise.resolve({ providers: [], summaries: {}, default: 'native', profiles: {} });
        case 'jobs.list':
        case 'escalations.list':
        case 'workflows.list':
        case 'personas.list':
          return Promise.resolve([]);
        default:
          return Promise.resolve(undefined);
      }
    });
    capturedOnConnectionChange?.(false);
    capturedOnConnectionChange?.(true);

    await waitFor(() => {
      expect(notices()).toHaveLength(1);
      expect(notices()[0].textContent).toContain('The compiled policy may be stale');
    });
    expect(screen.queryByText(/github/u)).toBeNull();
  });

  it('does not read the diagnostic log of a web-pty terminal, which prints its notices itself', async () => {
    const ptySession = mockSession(6, { source: { kind: 'web-pty' } });
    appState.sessions = new Map([[ptySession.label, ptySession]]);
    appState.selectedSessionLabel = ptySession.label;

    render(Sessions);
    await waitFor(() => expect(requestsFor('sessions.ptyAttach')).toHaveLength(1));

    expect(requestsFor('sessions.get')).toEqual([]);
    expect(notices()).toEqual([]);
  });
});
