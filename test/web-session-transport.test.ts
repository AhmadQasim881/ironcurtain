/**
 * WebSessionTransport (src/web-ui/web-session-transport.ts): how a builtin
 * web session's escalations and progress reach the browser.
 *
 * An escalation must be stored on its ManagedSession, with every field the
 * approver needs, so `escalations.list` and a tab that connects later can
 * show it, and it must be announced live as `escalation.created`. Resolution
 * and expiry are announced, and expiry clears the stored escalation so no
 * stale, approvable card is left behind. The last block drives the real
 * `sessions.create` path: it fails if the transport's handlers are no longer
 * wired into the session, or if a browser decision no longer reaches it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sessionFactory = vi.hoisted(() => ({
  createStandaloneSession: vi.fn(),
}));

vi.mock('../src/session/index.js', () => ({
  createStandaloneSession: sessionFactory.createStandaloneSession,
}));
vi.mock('../src/config/index.js', () => ({
  loadConfig: vi.fn().mockReturnValue({}),
}));
vi.mock('../src/memory/auto-save.js', () => ({
  shouldAutoSaveMemory: vi.fn().mockReturnValue(false),
}));

import { WebSessionTransport } from '../src/web-ui/web-session-transport.js';
import { WebEventBus } from '../src/web-ui/web-event-bus.js';
import { dispatch, type DispatchContext } from '../src/web-ui/json-rpc-dispatch.js';
import { SessionManager } from '../src/session/session-manager.js';
import type { BudgetStatus, EscalationRequest, Session, SessionInfo, SessionOptions } from '../src/session/types.js';
import type { ControlRequestHandler } from '../src/daemon/control-socket.js';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

const REQUEST: EscalationRequest = {
  escalationId: 'esc-web-1',
  serverName: 'filesystem',
  toolName: 'write_file',
  arguments: { path: '/etc/hosts', content: '127.0.0.1 example.com' },
  reason: 'Writes outside the sandbox',
  context: { workingDirectory: '/workspace' },
  whitelistCandidates: [{ description: 'Allow write_file within /etc' }],
};

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

interface StubSession extends Session {
  readonly sendMessage: ReturnType<typeof vi.fn<Session['sendMessage']>>;
  readonly resolveEscalation: ReturnType<typeof vi.fn<Session['resolveEscalation']>>;
}

function stubSession(id: string): StubSession {
  let status: SessionInfo['status'] = 'ready';
  return {
    getInfo: () => ({ id: id as SessionInfo['id'], status, turnCount: 0, createdAt: '2026-01-01T00:00:00.000Z' }),
    getBudgetStatus: () => budgetStatus(),
    getHistory: () => [],
    getDiagnosticLog: () => [],
    sendMessage: vi.fn<Session['sendMessage']>().mockResolvedValue('ok'),
    resolveEscalation: vi.fn<Session['resolveEscalation']>().mockResolvedValue(undefined),
    getPendingEscalations: () => [],
    close: vi.fn(async () => {
      status = 'closed';
    }),
  };
}

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

/** Registers a web session the way `sessions.create` does: label assigned after construction. */
function registerWebSession(
  h: Harness,
  id: string,
): { label: number; transport: WebSessionTransport; session: StubSession } {
  const session = stubSession(id);
  const transport = new WebSessionTransport({ eventBus: h.ctx.eventBus, sessionManager: h.sessionManager });
  const label = h.sessionManager.register(session, transport, { kind: 'web' });
  transport.sessionLabel = label;
  return { label, transport, session };
}

type StandaloneOptions = Omit<SessionOptions, 'agentConversationId'>;

/** The transport callbacks `sessions.create` must hand to the session factory. */
function wiredCallbacks(
  options: StandaloneOptions | undefined,
): Required<Pick<StandaloneOptions, 'onEscalation' | 'onEscalationResolved' | 'onEscalationExpired' | 'onDiagnostic'>> {
  const { onEscalation, onEscalationResolved, onEscalationExpired, onDiagnostic } = options ?? {};
  if (!onEscalation || !onEscalationResolved || !onEscalationExpired || !onDiagnostic) {
    throw new Error('sessions.create did not wire the transport callbacks into the session');
  }
  return { onEscalation, onEscalationResolved, onEscalationExpired, onDiagnostic };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WebSessionTransport', () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    // run() writes the interaction log under the IronCurtain home.
    previousHome = process.env.IRONCURTAIN_HOME;
    home = mkdtempSync(join(tmpdir(), 'ironcurtain-web-transport-'));
    process.env.IRONCURTAIN_HOME = home;
    sessionFactory.createStandaloneSession.mockReset();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.IRONCURTAIN_HOME;
    else process.env.IRONCURTAIN_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  describe('escalation handlers', () => {
    it('stores the full escalation on its own session and announces it as escalation.created', async () => {
      const h = makeHarness();
      const other = registerWebSession(h, 'web-other');
      const target = registerWebSession(h, 'web-target');

      target.transport.createEscalationHandler()(REQUEST);

      const stored = h.sessionManager.get(target.label)?.pendingEscalations.get('esc-web-1');
      expect(stored).toEqual({
        escalationId: 'esc-web-1',
        sessionLabel: target.label,
        toolName: 'write_file',
        serverName: 'filesystem',
        arguments: { path: '/etc/hosts', content: '127.0.0.1 example.com' },
        reason: 'Writes outside the sandbox',
        context: { workingDirectory: '/workspace' },
        whitelistCandidates: [{ description: 'Allow write_file within /etc' }],
        receivedAt: expect.any(String),
      });
      expect(Number.isNaN(Date.parse(stored?.receivedAt ?? ''))).toBe(false);
      expect(h.sessionManager.get(other.label)?.pendingEscalations.size).toBe(0);

      // Announced live with the same data, tagged as a turn-based web session...
      expect(h.events).toEqual([
        { event: 'escalation.created', payload: { ...stored, sessionSource: { kind: 'web' } } },
      ]);

      // ...and still there for a client that connects afterwards.
      expect(await dispatch(h.ctx, 'escalations.list', {})).toEqual([{ ...stored, sessionSource: { kind: 'web' } }]);
      const listed = (await dispatch(h.ctx, 'sessions.list', {})) as Array<{
        label: number;
        hasPendingEscalation: boolean;
      }>;
      expect(listed.map((s) => [s.label, s.hasPendingEscalation])).toEqual([
        [other.label, false],
        [target.label, true],
      ]);
    });

    it('announces the decision when the escalation is resolved', () => {
      const h = makeHarness();
      const { transport } = registerWebSession(h, 'web-resolved');

      transport.createEscalationResolvedHandler()('esc-web-1', 'denied');

      expect(h.events).toEqual([
        { event: 'escalation.resolved', payload: { escalationId: 'esc-web-1', decision: 'denied' } },
      ]);
    });

    it('clears the stored escalation when it expires and announces which one expired', async () => {
      const h = makeHarness();
      const { label, transport } = registerWebSession(h, 'web-expired');
      transport.createEscalationHandler()(REQUEST);
      h.events.length = 0;

      transport.createEscalationExpiredHandler()('esc-web-1');

      expect(h.sessionManager.get(label)?.pendingEscalations.size).toBe(0);
      expect(h.events).toEqual([
        { event: 'escalation.expired', payload: { escalationId: 'esc-web-1', sessionLabel: label } },
      ]);
      expect(await dispatch(h.ctx, 'escalations.list', {})).toEqual([]);
    });

    it('lists two concurrent escalations of one session; one expiring leaves the other', async () => {
      const h = makeHarness();
      const { label, transport } = registerWebSession(h, 'web-two');
      transport.createEscalationHandler()(REQUEST);
      transport.createEscalationHandler()({ ...REQUEST, escalationId: 'esc-web-2', toolName: 'delete_file' });

      const listed = (await dispatch(h.ctx, 'escalations.list', {})) as Array<{ escalationId: string }>;
      expect(listed.map((esc) => esc.escalationId)).toEqual(['esc-web-1', 'esc-web-2']);
      expect(h.events.map((e) => e.event)).toEqual(['escalation.created', 'escalation.created']);

      transport.createEscalationExpiredHandler()('esc-web-1');

      const remaining = (await dispatch(h.ctx, 'escalations.list', {})) as Array<{ escalationId: string }>;
      expect(remaining.map((esc) => esc.escalationId)).toEqual(['esc-web-2']);
      expect(h.events.at(-1)).toEqual({
        event: 'escalation.expired',
        payload: { escalationId: 'esc-web-1', sessionLabel: label },
      });
    });
  });

  describe('session lifecycle and progress', () => {
    it('forwards messages only while running, and run() returns once closed', async () => {
      const h = makeHarness();
      const { transport, session } = registerWebSession(h, 'web-forward');

      await expect(transport.forwardMessage('too early')).rejects.toThrow('No active session');

      const run = transport.run(session);
      await expect(transport.forwardMessage('hello')).resolves.toBe('ok');
      expect(session.sendMessage).toHaveBeenCalledWith('hello');

      transport.close();
      await run;
      await expect(transport.forwardMessage('too late')).rejects.toThrow('No active session');
      expect(session.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('reports tool calls, text and finished steps under the session label', () => {
      const h = makeHarness();
      const { label, transport } = registerWebSession(h, 'web-progress');
      const onDiagnostic = transport.createDiagnosticHandler();

      onDiagnostic({ kind: 'tool_call', toolName: 'filesystem.read_file', preview: 'read /workspace/a.txt' });
      onDiagnostic({ kind: 'agent_text', preview: 'Reading the file' });
      onDiagnostic({ kind: 'step_finish', stepIndex: 2 });

      expect(h.events).toEqual([
        {
          event: 'session.tool_call',
          payload: { label, toolName: 'filesystem.read_file', preview: 'read /workspace/a.txt' },
        },
        { event: 'session.text_delta', payload: { label, preview: 'Reading the file' } },
        { event: 'session.tool_result', payload: { label, toolName: '', stepIndex: 2 } },
      ]);
    });
  });

  describe('wiring through sessions.create', () => {
    it("routes the session's escalations to the browser and the browser's decision back to the session", async () => {
      const h = makeHarness();
      const session = stubSession('web-wired');
      let factoryOptions: StandaloneOptions | undefined;
      sessionFactory.createStandaloneSession.mockImplementationOnce(async (options: StandaloneOptions) => {
        factoryOptions = options;
        return session;
      });

      const { label } = (await dispatch(h.ctx, 'sessions.create', {})) as { label: number };
      const callbacks = wiredCallbacks(factoryOptions);

      // The session raises an escalation: the browser hears about it with the session's label.
      callbacks.onEscalation(REQUEST);
      expect(h.events.filter((e) => e.event === 'escalation.created')).toEqual([
        {
          event: 'escalation.created',
          payload: expect.objectContaining({
            escalationId: 'esc-web-1',
            sessionLabel: label,
            sessionSource: { kind: 'web' },
            toolName: 'write_file',
            arguments: REQUEST.arguments,
          }),
        },
      ]);

      // The browser approves with the whitelist pattern: the decision reaches this session.
      await dispatch(h.ctx, 'escalations.resolve', {
        escalationId: 'esc-web-1',
        decision: 'approved',
        whitelistSelection: 0,
      });
      expect(session.resolveEscalation.mock.calls).toEqual([['esc-web-1', 'approved', { whitelistSelection: 0 }]]);
      expect(h.sessionManager.get(label)?.pendingEscalations.size).toBe(0);

      // The session confirms the resolution: the browser drops the card.
      callbacks.onEscalationResolved('esc-web-1', 'approved');
      expect(h.events.at(-1)).toEqual({
        event: 'escalation.resolved',
        payload: { escalationId: 'esc-web-1', decision: 'approved' },
      });

      // A second escalation times out instead.
      callbacks.onEscalation({ ...REQUEST, escalationId: 'esc-web-2' });
      callbacks.onEscalationExpired('esc-web-2');
      expect(h.events.at(-1)).toEqual({
        event: 'escalation.expired',
        payload: { escalationId: 'esc-web-2', sessionLabel: label },
      });
      expect(await dispatch(h.ctx, 'escalations.list', {})).toEqual([]);

      callbacks.onDiagnostic({ kind: 'agent_text', preview: 'Done' });
      expect(h.events.at(-1)).toEqual({ event: 'session.text_delta', payload: { label, preview: 'Done' } });

      await dispatch(h.ctx, 'sessions.end', { label });
      expect(h.sessionManager.get(label)).toBeUndefined();
    });
  });
});
