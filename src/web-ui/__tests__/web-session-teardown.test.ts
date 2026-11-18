/**
 * Tests for the single web-session teardown path (web-session-teardown.ts)
 * and its wiring into `sessions.create` / `sessions.end` (GAP4-10):
 *  - each end closes the transport and session exactly once and emits ONE
 *    `session.ended`, even though the transport's run() completion also
 *    triggers a teardown;
 *  - the session stays registered (counted by `byKind('web')`) until its
 *    close() has finished;
 *  - concurrent callers join the in-flight teardown;
 *  - a transport closed by another path still tears the session down once;
 *  - a still-pending escalation is announced as expired before session.ended.
 *
 * Uses the real dispatch, SessionManager and WebSessionTransport; only
 * createStandaloneSession (the agent + sandbox) is stubbed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sessionFactory = vi.hoisted(() => ({
  createStandaloneSession: vi.fn(),
}));

vi.mock('../../session/index.js', () => ({
  createStandaloneSession: sessionFactory.createStandaloneSession,
}));
vi.mock('../../config/index.js', () => ({
  loadConfig: vi.fn().mockReturnValue({}),
}));
vi.mock('../../memory/auto-save.js', () => ({
  shouldAutoSaveMemory: vi.fn().mockReturnValue(false),
}));

import { dispatch, type DispatchContext } from '../json-rpc-dispatch.js';
import { endManagedSession } from '../web-session-teardown.js';
import { WebEventBus } from '../web-event-bus.js';
import { SessionManager } from '../../session/session-manager.js';
import { getTokenStreamBus } from '../../docker/token-stream-bus.js';
import type { Session, SessionInfo, BudgetStatus } from '../../session/types.js';
import type { ControlRequestHandler } from '../../daemon/control-socket.js';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

function budgetStatus(): BudgetStatus {
  return {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    stepCount: 0,
    elapsedSeconds: 0,
    estimatedCostUsd: 0,
    tokenTrackingAvailable: true,
    limits: {
      maxTotalTokens: null,
      maxSteps: null,
      maxSessionSeconds: null,
      maxEstimatedCostUsd: null,
      warnThresholdPercent: 80,
    },
    lastTurn: null,
    cumulative: {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      stepCount: 0,
      activeSeconds: 0,
      estimatedCostUsd: 0,
    },
  };
}

/**
 * A session whose close() mirrors AgentSession: idempotent (returns at once
 * when already closed) and slow the first time (sandbox shutdown).
 */
function stubSession(id: string, closeDelayMs: number): Session & { closeCalls: () => number } {
  let status: SessionInfo['status'] = 'ready';
  let closeCalls = 0;
  return {
    getInfo: () => ({ id: id as SessionInfo['id'], status, turnCount: 0, createdAt: '2026-01-01T00:00:00.000Z' }),
    getBudgetStatus: () => budgetStatus(),
    getHistory: () => [],
    getDiagnosticLog: () => [],
    sendMessage: vi.fn().mockResolvedValue('ok'),
    resolveEscalation: vi.fn().mockResolvedValue(undefined),
    getPendingEscalations: () => [],
    close: vi.fn(async () => {
      closeCalls++;
      if (status === 'closed') return;
      status = 'closed';
      await new Promise<void>((resolve) => setTimeout(resolve, closeDelayMs));
    }),
    closeCalls: () => closeCalls,
  };
}

function makeHandler(): ControlRequestHandler {
  return {
    getStatus: vi.fn().mockReturnValue({
      uptimeSeconds: 0,
      jobs: { total: 0, enabled: 0, running: 0 },
      signalConnected: false,
      nextFireTime: undefined,
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

interface Harness {
  ctx: DispatchContext;
  sessionManager: SessionManager;
  events: Array<{ event: string; payload: unknown }>;
}

function makeHarness(): Harness {
  const sessionManager = new SessionManager();
  const eventBus = new WebEventBus();
  const events: Array<{ event: string; payload: unknown }> = [];
  eventBus.subscribe((event, payload) => events.push({ event, payload }));
  return {
    ctx: {
      handler: makeHandler(),
      sessionManager,
      mode: { kind: 'builtin' },
      eventBus,
      maxConcurrentWebSessions: 5,
      sessionQueues: new Map(),
    },
    sessionManager,
    events,
  };
}

/** Lets settled promise chains (the run().then teardown) run to completion. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const endedEvents = (h: Harness) => h.events.filter((e) => e.event === 'session.ended');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('web session teardown', () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    // The transport's interaction log lives under the IronCurtain home.
    previousHome = process.env.IRONCURTAIN_HOME;
    home = mkdtempSync(join(tmpdir(), 'ironcurtain-web-teardown-'));
    process.env.IRONCURTAIN_HOME = home;
    sessionFactory.createStandaloneSession.mockReset();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  async function createWebSession(h: Harness, session: Session): Promise<number> {
    sessionFactory.createStandaloneSession.mockResolvedValueOnce(session);
    const { label } = (await dispatch(h.ctx, 'sessions.create', {})) as { label: number };
    return label;
  }

  it('sessions.end closes the session exactly once and emits one session.ended', async () => {
    const h = makeHarness();
    const session = stubSession('web-end-once', 30);
    const label = await createWebSession(h, session);
    expect(h.sessionManager.byKind('web')).toHaveLength(1);

    const ending = dispatch(h.ctx, 'sessions.end', { label });
    await flush(); // the transport's run() has resolved and its .then has run

    // Still registered and counted while its sandbox is shutting down, and the
    // run()-completion path joined the in-flight end instead of starting a second.
    expect(h.sessionManager.isEnding(label)).toBe(true);
    expect(h.sessionManager.get(label)).toBeDefined();
    expect(h.sessionManager.byKind('web')).toHaveLength(1);
    expect(endedEvents(h)).toHaveLength(0);

    await ending;
    await flush();

    expect(session.closeCalls()).toBe(1);
    expect(h.sessionManager.get(label)).toBeUndefined();
    expect(h.sessionManager.isEnding(label)).toBe(false);
    expect(endedEvents(h)).toHaveLength(1);
    expect(endedEvents(h)[0].payload).toEqual({ label, reason: 'user_ended' });
  });

  it('concurrent endManagedSession calls share one teardown and emit once', async () => {
    const h = makeHarness();
    const session = stubSession('web-concurrent', 20);
    const label = await createWebSession(h, session);

    await Promise.all([
      endManagedSession(h.ctx, label, 'first'),
      endManagedSession(h.ctx, label, 'second'),
      endManagedSession(h.ctx, label, 'third'),
    ]);
    await flush();

    expect(session.closeCalls()).toBe(1);
    expect(endedEvents(h)).toHaveLength(1);
    expect(endedEvents(h)[0].payload).toEqual({ label, reason: 'first' });
    expect(h.sessionManager.size).toBe(0);
  });

  it('is a no-op for an unknown label', async () => {
    const h = makeHarness();
    await expect(endManagedSession(h.ctx, 42, 'whatever')).resolves.toBeUndefined();
    expect(endedEvents(h)).toHaveLength(0);
  });

  it('a transport closed outside sessions.end still tears the session down exactly once', async () => {
    const h = makeHarness();
    const session = stubSession('web-transport-closed', 10);
    const label = await createWebSession(h, session);
    const managed = h.sessionManager.get(label);
    expect(managed).toBeDefined();

    managed?.transport.close(); // resolves run() -> the create-time .then runs

    await vi.waitFor(() => expect(endedEvents(h)).toHaveLength(1));
    await flush();
    expect(endedEvents(h)[0].payload).toEqual({ label, reason: 'transport_closed' });
    expect(session.closeCalls()).toBe(1);
    expect(h.sessionManager.get(label)).toBeUndefined();
  });

  // SessionManager.end() is public and not web-specific: the Signal bot's
  // `/quit #N` ends any label through it. The helper's own idempotency must
  // not mistake that teardown for one of its own, or nobody emits
  // session.ended (the daemon keeps its bridge maps, clients keep the row) and
  // the token-stream bookkeeping is never released.
  it('a teardown started by a direct SessionManager.end() still emits session.ended once and releases the token stream', async () => {
    const h = makeHarness();
    const session = stubSession('web-direct-end', 10);
    const label = await createWebSession(h, session);
    const endSessionSpy = vi.spyOn(getTokenStreamBus(), 'endSession');

    try {
      await h.sessionManager.end(label); // bypasses endManagedSession

      await vi.waitFor(() => expect(endedEvents(h)).toHaveLength(1));
      await flush();
      expect(endedEvents(h)[0].payload).toEqual({ label, reason: 'transport_closed' });
      expect(session.closeCalls()).toBe(1);
      expect(endSessionSpy).toHaveBeenCalledWith('web-direct-end');
      expect(h.sessionManager.get(label)).toBeUndefined();
    } finally {
      endSessionSpy.mockRestore();
    }
  });

  it('a caller joining an in-flight teardown resolves only after session.ended was emitted', async () => {
    const h = makeHarness();
    const session = stubSession('web-join', 20);
    const label = await createWebSession(h, session);

    const first = endManagedSession(h.ctx, label, 'orphaned');
    await flush();
    await endManagedSession(h.ctx, label, 'daemon_shutdown');

    // The joiner (e.g. stop() after the orphan reaper) sees the full teardown.
    expect(endedEvents(h)).toEqual([{ event: 'session.ended', payload: { label, reason: 'orphaned' } }]);
    await first;
    expect(session.closeCalls()).toBe(1);
  });

  it('announces a still-pending escalation as expired before session.ended', async () => {
    const h = makeHarness();
    const session = stubSession('web-pending-esc', 5);
    const label = await createWebSession(h, session);
    h.sessionManager.setPendingEscalation(label, {
      escalationId: 'esc-web-1',
      sessionLabel: label,
      toolName: 'write_file',
      serverName: 'filesystem',
      arguments: { path: '/etc/hosts' },
      reason: 'Protected path',
      receivedAt: '2026-01-01T00:00:00.000Z',
    });

    await dispatch(h.ctx, 'sessions.end', { label });
    await flush();

    const expiredIdx = h.events.findIndex((e) => e.event === 'escalation.expired');
    const endedIdx = h.events.findIndex((e) => e.event === 'session.ended');
    expect(expiredIdx).toBeGreaterThanOrEqual(0);
    expect(h.events[expiredIdx].payload).toEqual({ escalationId: 'esc-web-1', sessionLabel: label });
    expect(endedIdx).toBeGreaterThan(expiredIdx);
    expect(h.events.filter((e) => e.event === 'escalation.expired')).toHaveLength(1);
  });

  it('clears the per-label send queue on teardown', async () => {
    const h = makeHarness();
    const session = stubSession('web-queue', 5);
    const label = await createWebSession(h, session);
    h.ctx.sessionQueues.set(label, Promise.resolve());

    await endManagedSession(h.ctx, label, 'user_ended');
    await flush();

    expect(h.ctx.sessionQueues.has(label)).toBe(false);
  });
});
