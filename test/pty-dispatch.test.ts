/**
 * PTY terminal JSON-RPC dispatch (src/web-ui/dispatch/pty-dispatch.ts).
 *
 * `sessions.ptyPrompt` is the browser's only trusted-input channel: its text
 * becomes the trusted user context (source `mux-trusted-input`) that lets the
 * auto-approver act. `sessions.ptyInput` carries raw keystrokes and must never
 * be trusted. These tests pin that each method reaches exactly its manager
 * method, that malformed params are rejected before the manager is touched,
 * and that an unknown label is an error, both against a recording manager and
 * end to end through a real PtySessionManager with a stub bridge.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocket as WsWebSocket } from 'ws';

import { dispatch, type DispatchContext } from '../src/web-ui/json-rpc-dispatch.js';
import { ptyDispatch } from '../src/web-ui/dispatch/pty-dispatch.js';
import { PtySessionManager } from '../src/web-ui/pty-session-manager.js';
import { WebEventBus } from '../src/web-ui/web-event-bus.js';
import type { MethodName } from '../src/web-ui/web-ui-types.js';
import { SessionManager } from '../src/session/session-manager.js';
import type { ControlRequestHandler } from '../src/daemon/control-socket.js';
import type { PtyBridge } from '../src/pty/pty-bridge.js';
import type { AgentId } from '../src/docker/agent-adapter.js';
import { StubBridge } from './helpers/pty-stub-bridge.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeHandler(): ControlRequestHandler {
  return {
    getStatus: vi.fn<ControlRequestHandler['getStatus']>().mockReturnValue({
      uptimeSeconds: 0,
      jobs: { total: 0, enabled: 0, running: 0, failing: 0 },
      failingJobs: [],
      signalConnected: false,
      nextFireTime: null,
    }),
    removeJob: vi.fn(),
    enableJob: vi.fn(),
    disableJob: vi.fn(),
    recompileJob: vi.fn(),
    refreshLists: vi.fn(),
    reloadJob: vi.fn(),
    startJobRun: vi.fn(),
    runJobNow: vi.fn(),
    listJobs: vi.fn().mockReturnValue([]),
  };
}

function makeCtx(ptySessionManager: PtySessionManager | undefined): DispatchContext {
  return {
    handler: makeHandler(),
    sessionManager: new SessionManager(),
    mode: { kind: 'docker', agent: 'claude-code' as AgentId },
    eventBus: new WebEventBus(),
    maxConcurrentWebSessions: 4,
    sessionQueues: new Map(),
    ...(ptySessionManager ? { ptySessionManager } : {}),
  };
}

/** The manager methods pty-dispatch may call, each recorded. */
function recordingManager() {
  const calls = {
    attach: vi.fn<(label: number, client: WsWebSocket) => void>(),
    detach: vi.fn<(label: number, client: WsWebSocket) => void>(),
    input: vi.fn<(label: number, dataB64: string, client?: WsWebSocket) => void>(),
    resize: vi.fn<(label: number, cols: number, rows: number, client?: WsWebSocket) => void>(),
    sendPrompt: vi.fn<(label: number, text: string, client?: WsWebSocket) => void>(),
  };
  const manager = { ...calls } as unknown as PtySessionManager;
  const callCounts = (): Record<keyof typeof calls, number> => ({
    attach: calls.attach.mock.calls.length,
    detach: calls.detach.mock.calls.length,
    input: calls.input.mock.calls.length,
    resize: calls.resize.mock.calls.length,
    sendPrompt: calls.sendPrompt.mock.calls.length,
  });
  return { manager, calls, callCounts };
}

const NO_CALLS = { attach: 0, detach: 0, input: 0, resize: 0, sendPrompt: 0 };

/** A connected browser socket; dispatch only passes it through to the manager. */
function fakeClient(): WsWebSocket {
  return { bufferedAmount: 0, readyState: 1, send: vi.fn() } as unknown as WsWebSocket;
}

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

/** The error a synchronous call throws (fails the test if it does not throw). */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

// ---------------------------------------------------------------------------
// Routing against a recording manager
// ---------------------------------------------------------------------------

describe('ptyDispatch routing', () => {
  it('sends a trusted prompt to sendPrompt only, never as keystrokes', () => {
    const { manager, calls, callCounts } = recordingManager();
    const client = fakeClient();

    const result = ptyDispatch(makeCtx(manager), 'sessions.ptyPrompt', { label: 3, text: 'deploy to staging' }, client);

    expect(result).toEqual({ accepted: true });
    expect(calls.sendPrompt.mock.calls).toEqual([[3, 'deploy to staging', client]]);
    expect(callCounts()).toEqual({ ...NO_CALLS, sendPrompt: 1 });
  });

  it('sends raw keystrokes to input only, never as a trusted prompt', () => {
    const { manager, calls, callCounts } = recordingManager();
    const client = fakeClient();

    const result = ptyDispatch(makeCtx(manager), 'sessions.ptyInput', { label: 3, data: b64('y\r') }, client);

    expect(result).toEqual({ accepted: true });
    expect(calls.input.mock.calls).toEqual([[3, b64('y\r'), client]]);
    expect(callCounts()).toEqual({ ...NO_CALLS, input: 1 });
  });

  it('routes attach, detach and resize to their manager methods with the calling client', () => {
    const { manager, calls, callCounts } = recordingManager();
    const client = fakeClient();
    const ctx = makeCtx(manager);

    expect(ptyDispatch(ctx, 'sessions.ptyAttach', { label: 2 }, client)).toEqual({ attached: true });
    expect(ptyDispatch(ctx, 'sessions.ptyResize', { label: 2, cols: 120, rows: 40 }, client)).toEqual({
      resized: true,
    });
    expect(ptyDispatch(ctx, 'sessions.ptyDetach', { label: 2 }, client)).toEqual({ detached: true });

    expect(calls.attach.mock.calls).toEqual([[2, client]]);
    expect(calls.resize.mock.calls).toEqual([[2, 120, 40, client]]);
    expect(calls.detach.mock.calls).toEqual([[2, client]]);
    expect(callCounts()).toEqual({ ...NO_CALLS, attach: 1, resize: 1, detach: 1 });
  });

  it.each([
    ['sessions.ptyAttach', {}],
    ['sessions.ptyAttach', { label: 0 }],
    ['sessions.ptyAttach', { label: -1 }],
    ['sessions.ptyAttach', { label: 1.5 }],
    ['sessions.ptyAttach', { label: '1' }],
    ['sessions.ptyDetach', { label: 0 }],
    ['sessions.ptyInput', { label: 1 }],
    ['sessions.ptyInput', { label: 1, data: 42 }],
    ['sessions.ptyInput', { label: 0, data: b64('x') }],
    ['sessions.ptyResize', { label: 1, cols: 80 }],
    ['sessions.ptyResize', { label: 1, cols: '80', rows: 24 }],
    ['sessions.ptyPrompt', { label: 1 }],
    ['sessions.ptyPrompt', { label: 1, text: '' }],
    ['sessions.ptyPrompt', { label: 1, text: 7 }],
    ['sessions.ptyPrompt', { label: 1, text: ['approve'] }],
    ['sessions.ptyPrompt', { label: -1, text: 'hi' }],
  ])('rejects %s with params %j before the manager is touched', (method, params) => {
    const { manager, callCounts } = recordingManager();

    expect(thrownBy(() => ptyDispatch(makeCtx(manager), method, params, fakeClient()))).toMatchObject({
      code: 'INVALID_PARAMS',
    });
    expect(callCounts()).toEqual(NO_CALLS);
  });

  it('rejects an unknown sessions.pty* method', async () => {
    const { manager, callCounts } = recordingManager();

    await expect(
      dispatch(makeCtx(manager), 'sessions.ptyEval' as MethodName, { label: 1, text: 'x' }, fakeClient()),
    ).rejects.toMatchObject({ code: 'METHOD_NOT_FOUND' });
    expect(callCounts()).toEqual(NO_CALLS);
  });

  it('requires the calling WebSocket client and a PTY manager', async () => {
    const { manager, callCounts } = recordingManager();

    await expect(dispatch(makeCtx(manager), 'sessions.ptyPrompt', { label: 1, text: 'x' })).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
    expect(callCounts()).toEqual(NO_CALLS);

    await expect(
      dispatch(makeCtx(undefined), 'sessions.ptyPrompt', { label: 1, text: 'x' }, fakeClient()),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR', message: 'PTY session manager not available' });
  });
});

// ---------------------------------------------------------------------------
// End to end through a real PtySessionManager
// ---------------------------------------------------------------------------

describe('PTY dispatch through PtySessionManager', () => {
  const tempDirs: string[] = [];
  let bridges: StubBridge[];
  let manager: PtySessionManager;

  beforeEach(() => {
    vi.useFakeTimers();
    bridges = [];
    manager = new PtySessionManager({
      sender: { sendToSubscribers: vi.fn() },
      sessionManager: new SessionManager(),
      eventBus: new WebEventBus(),
      mode: { kind: 'docker', agent: 'claude-code' as AgentId },
      daemonId: 'test',
      daemonPid: 1,
      createBridge: async () => {
        const bridge = new StubBridge();
        bridges.push(bridge);
        return bridge as unknown as PtyBridge;
      },
      preflight: async () => {},
      idleTtlMs: 0,
    });
  });

  afterEach(async () => {
    // Stub bridges exit as soon as they are killed, so close() needs no timers.
    await manager.close();
    vi.useRealTimers();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** Creates a PTY session whose agent has announced its escalation directory. */
  async function discoveredSession(): Promise<{ label: number; bridge: StubBridge; escalationDir: string }> {
    const { label } = await manager.create();
    const bridge = bridges[bridges.length - 1];
    const escalationDir = mkdtempSync(join(tmpdir(), 'ironcurtain-pty-dispatch-'));
    tempDirs.push(escalationDir);
    bridge.emitDiscovered({ sessionId: 's', escalationDir, label: 'l', startedAt: '', pid: bridge.pid });
    return { label, bridge, escalationDir };
  }

  it('records a ptyPrompt as trusted user context and types it into the terminal', async () => {
    const { label, bridge, escalationDir } = await discoveredSession();
    const ctx = makeCtx(manager);

    await dispatch(ctx, 'sessions.ptyPrompt', { label, text: 'please delete the build cache' }, fakeClient());

    const context = JSON.parse(readFileSync(join(escalationDir, 'user-context.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(context).toMatchObject({ userMessage: 'please delete the build cache', source: 'mux-trusted-input' });
    expect(bridge.write.mock.calls).toEqual([['please delete the build cache']]);
    vi.advanceTimersByTime(100);
    expect(bridge.write.mock.calls).toEqual([['please delete the build cache'], ['\r']]);
  });

  it('types ptyInput keystrokes into the terminal without making them trusted', async () => {
    const { label, bridge, escalationDir } = await discoveredSession();
    const ctx = makeCtx(manager);

    await dispatch(ctx, 'sessions.ptyInput', { label, data: b64('please delete the build cache\r') }, fakeClient());

    expect(bridge.write.mock.calls).toEqual([['please delete the build cache\r']]);
    expect(existsSync(join(escalationDir, 'user-context.json'))).toBe(false);
  });

  it.each([
    ['sessions.ptyAttach', { label: 99 }],
    ['sessions.ptyInput', { label: 99, data: b64('x') }],
    ['sessions.ptyResize', { label: 99, cols: 80, rows: 24 }],
    ['sessions.ptyPrompt', { label: 99, text: 'x' }],
  ] as const)('%s on an unknown label is SESSION_NOT_FOUND', async (method, params) => {
    const { bridge } = await discoveredSession();

    await expect(dispatch(makeCtx(manager), method, params, fakeClient())).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
    });
    expect(bridge.write).not.toHaveBeenCalled();
    expect(bridge.resize).not.toHaveBeenCalled();
  });

  it('a detach from an unknown label is a no-op', async () => {
    await expect(dispatch(makeCtx(manager), 'sessions.ptyDetach', { label: 99 }, fakeClient())).resolves.toEqual({
      detached: true,
    });
  });
});
