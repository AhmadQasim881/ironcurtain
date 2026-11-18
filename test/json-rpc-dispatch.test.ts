/**
 * Tests for json-rpc-dispatch: parameter validation, method routing,
 * error handling, and DTO builders.
 *
 * These tests exercise the dispatch function directly with a mock
 * DispatchContext, avoiding the need for a real HTTP/WS server.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  dispatch,
  toSessionDto,
  toBudgetDto,
  buildStatusDto,
  type DispatchContext,
} from '../src/web-ui/json-rpc-dispatch.js';
import { WebEventBus, type WebEventMap } from '../src/web-ui/web-event-bus.js';
import { SessionManager, type PendingEscalationData } from '../src/session/session-manager.js';
import type { ControlRequestHandler } from '../src/daemon/control-socket.js';
import { JobAlreadyRunningError, JobNotFoundError, type RunRecord } from '../src/cron/types.js';
import type { Session, SessionInfo, BudgetStatus } from '../src/session/types.js';
import type { Transport } from '../src/session/transport.js';
import { BudgetExhaustedError } from '../src/types/errors.js';
import type { AgentId } from '../src/docker/agent-adapter.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * An idle builtin session after a few turns: the per-turn fields are reset to
 * zero by endTurn(); the totals the web UI shows live in `cumulative`.
 */
function makeBudgetStatus(): BudgetStatus {
  return {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    stepCount: 0,
    elapsedSeconds: 0,
    estimatedCostUsd: 0,
    tokenTrackingAvailable: true,
    lastTurn: {
      totalInputTokens: 200,
      totalOutputTokens: 100,
      totalTokens: 300,
      stepCount: 2,
      elapsedSeconds: 30,
      estimatedCostUsd: 0.02,
    },
    cumulative: {
      totalInputTokens: 500,
      totalOutputTokens: 300,
      totalTokens: 800,
      stepCount: 5,
      activeSeconds: 120,
      estimatedCostUsd: 0.05,
    },
    limits: {
      maxTotalTokens: 1_000_000,
      maxSteps: 200,
      maxSessionSeconds: 1800,
      maxEstimatedCostUsd: 5,
      warnThresholdPercent: 80,
    },
  };
}

function stubSession(): Session {
  return {
    getInfo: () =>
      ({
        id: 'test-id',
        status: 'ready',
        turnCount: 3,
        createdAt: '2026-01-01T00:00:00Z',
      }) as SessionInfo,
    sendMessage: vi.fn().mockResolvedValue('response text'),
    getHistory: vi.fn().mockReturnValue([
      {
        turnNumber: 1,
        userMessage: 'hi',
        assistantResponse: 'hello',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cacheReadTokens: 0, cacheWriteTokens: 0 },
        timestamp: '2026-01-01T00:00:00Z',
      },
    ]),
    getDiagnosticLog: vi.fn().mockReturnValue([]),
    resolveEscalation: vi.fn().mockResolvedValue(undefined),
    getPendingEscalations: vi.fn(() => []),
    getBudgetStatus: vi.fn().mockReturnValue(makeBudgetStatus()),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function stubTransport(): Transport {
  return {
    run: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
}

const RUN_RECORD: RunRecord = {
  startedAt: '2026-03-05T09:00:00Z',
  completedAt: '2026-03-05T09:01:00Z',
  outcome: { kind: 'success' },
  budget: { totalTokens: 100, stepCount: 3, elapsedSeconds: 60, estimatedCostUsd: 0.01 },
  summary: 'Done',
  escalationsEncountered: 0,
  escalationsApproved: 0,
  discardedChanges: null,
};

function makeMockHandler(): ControlRequestHandler {
  return {
    getStatus: vi.fn().mockReturnValue({
      uptimeSeconds: 300,
      jobs: { total: 2, enabled: 1, running: 0, failing: 0 },
      failingJobs: [],
      signalConnected: false,
      nextFireTime: new Date('2026-03-05T10:00:00Z'),
    }),
    removeJob: vi.fn().mockResolvedValue(undefined),
    enableJob: vi.fn().mockResolvedValue(undefined),
    disableJob: vi.fn().mockResolvedValue(undefined),
    recompileJob: vi.fn().mockResolvedValue(undefined),
    refreshLists: vi.fn(),
    reloadJob: vi.fn().mockResolvedValue(undefined),
    startJobRun: vi.fn(() => ({ completion: Promise.resolve(RUN_RECORD) })),
    runJobNow: vi.fn().mockResolvedValue(RUN_RECORD),
    listJobs: vi.fn().mockReturnValue([]),
  };
}

function makeCtx(overrides?: Partial<DispatchContext>): DispatchContext {
  return {
    handler: makeMockHandler(),
    sessionManager: new SessionManager(),
    mode: { kind: 'builtin' },
    eventBus: new WebEventBus(),
    maxConcurrentWebSessions: 5,
    sessionQueues: new Map(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('json-rpc-dispatch', () => {
  describe('parameter validation', () => {
    it('rejects missing label for sessions.get', async () => {
      const ctx = makeCtx();
      await expect(dispatch(ctx, 'sessions.get', {})).rejects.toThrow();
    });

    it('rejects negative label', async () => {
      const ctx = makeCtx();
      await expect(dispatch(ctx, 'sessions.get', { label: -1 })).rejects.toThrow();
    });

    it('rejects non-integer label', async () => {
      const ctx = makeCtx();
      await expect(dispatch(ctx, 'sessions.get', { label: 1.5 })).rejects.toThrow();
    });

    it('rejects empty jobId', async () => {
      const ctx = makeCtx();
      await expect(dispatch(ctx, 'jobs.remove', { jobId: '' })).rejects.toThrow();
    });

    it('rejects missing escalationId for escalations.resolve', async () => {
      const ctx = makeCtx();
      await expect(dispatch(ctx, 'escalations.resolve', { decision: 'approved' })).rejects.toThrow();
    });

    it('rejects invalid decision for escalations.resolve', async () => {
      const ctx = makeCtx();
      await expect(dispatch(ctx, 'escalations.resolve', { escalationId: 'e1', decision: 'maybe' })).rejects.toThrow();
    });

    it('rejects empty text for sessions.send', async () => {
      const ctx = makeCtx();
      await expect(dispatch(ctx, 'sessions.send', { label: 1, text: '' })).rejects.toThrow();
    });
  });

  describe('method routing', () => {
    it('throws MethodNotFoundError for unknown methods', async () => {
      const ctx = makeCtx();
      await expect(dispatch(ctx, 'nonexistent' as never, {})).rejects.toThrow('Unknown method: nonexistent');
    });

    it('status returns DaemonStatusDto', async () => {
      const ctx = makeCtx();
      const result = await dispatch(ctx, 'status', {});
      expect(result).toMatchObject({
        uptimeSeconds: 300,
        jobs: { total: 2, enabled: 1, running: 0 },
        webUiListening: true,
      });
    });

    it('sessions.list returns empty array when no sessions', async () => {
      const ctx = makeCtx();
      const result = await dispatch(ctx, 'sessions.list', {});
      expect(result).toEqual([]);
    });

    it('sessions.list returns session DTOs', async () => {
      const ctx = makeCtx();
      const session = stubSession();
      ctx.sessionManager.register(session, stubTransport(), { kind: 'web' });

      const result = (await dispatch(ctx, 'sessions.list', {})) as unknown[];
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ label: 1, source: { kind: 'web' } });
    });

    it('sessions.get returns detail for existing session', async () => {
      const ctx = makeCtx();
      ctx.sessionManager.register(stubSession(), stubTransport(), { kind: 'signal' });

      const result = await dispatch(ctx, 'sessions.get', { label: 1 });
      expect(result).toMatchObject({
        label: 1,
        history: expect.any(Array),
        diagnosticLog: expect.any(Array),
      });
    });

    it('sessions.get throws SessionNotFoundError for missing session', async () => {
      const ctx = makeCtx();
      await expect(dispatch(ctx, 'sessions.get', { label: 99 })).rejects.toThrow('Session #99 not found');
    });

    it('sessions.end removes the session', async () => {
      const ctx = makeCtx();
      ctx.sessionManager.register(stubSession(), stubTransport(), { kind: 'web' });

      await dispatch(ctx, 'sessions.end', { label: 1 });
      expect(ctx.sessionManager.get(1)).toBeUndefined();
    });

    it('sessions.end emits session.ended event', async () => {
      const ctx = makeCtx();
      ctx.sessionManager.register(stubSession(), stubTransport(), { kind: 'web' });
      const handler = vi.fn();
      ctx.eventBus.subscribe(handler);

      await dispatch(ctx, 'sessions.end', { label: 1 });

      expect(handler).toHaveBeenCalledWith('session.ended', { label: 1, reason: 'user_ended' });
    });

    it('removes a budget-exhausted session before emitting session.ended', async () => {
      const ctx = makeCtx();
      const transport = {
        ...stubTransport(),
        forwardMessage: vi.fn(),
      } as Transport & { forwardMessage: ReturnType<typeof vi.fn> };
      const label = ctx.sessionManager.register(stubSession(), transport, { kind: 'web' });
      transport.forwardMessage.mockRejectedValue(new BudgetExhaustedError('tokens', 'token limit reached'));

      let sessionAtEndedEvent: unknown = 'event-not-emitted';
      ctx.eventBus.subscribe((event, payload) => {
        // The handler is generic over the event: narrowing `event` does not narrow `payload`.
        if (event === 'session.ended' && (payload as WebEventMap['session.ended']).label === label) {
          sessionAtEndedEvent = ctx.sessionManager.get(label);
        }
      });

      await dispatch(ctx, 'sessions.send', { label, text: 'hello' });
      const queuedSend = ctx.sessionQueues.get(label);
      expect(queuedSend).toBeDefined();
      await queuedSend;

      expect(sessionAtEndedEvent).toBeUndefined();
      expect(ctx.sessionManager.get(label)).toBeUndefined();
    });

    it('sessions.budget returns budget DTO', async () => {
      const ctx = makeCtx();
      ctx.sessionManager.register(stubSession(), stubTransport(), { kind: 'web' });

      const result = await dispatch(ctx, 'sessions.budget', { label: 1 });
      expect(result).toMatchObject({
        totalTokens: 800,
        stepCount: 5,
        tokenTrackingAvailable: true,
      });
    });

    it('sessions.history returns conversation history', async () => {
      const ctx = makeCtx();
      ctx.sessionManager.register(stubSession(), stubTransport(), { kind: 'web' });

      const result = await dispatch(ctx, 'sessions.history', { label: 1 });
      expect(result).toHaveLength(1);
    });

    it('sessions.diagnostics returns diagnostic log', async () => {
      const ctx = makeCtx();
      ctx.sessionManager.register(stubSession(), stubTransport(), { kind: 'web' });

      const result = await dispatch(ctx, 'sessions.diagnostics', { label: 1 });
      expect(result).toEqual([]);
    });
  });

  describe('escalations', () => {
    it('keeps a complete item visible beside a deny-only review and refuses approval of the original', async () => {
      const ctx = makeCtx();
      const session = stubSession();
      const label = ctx.sessionManager.register(session, stubTransport(), { kind: 'web' });
      const original: PendingEscalationData = {
        escalationId: 'example-large-review',
        sessionLabel: label,
        serverName: 'filesystem',
        toolName: 'write_file',
        arguments: { content: 'Example prose. '.repeat(1200) },
        reason: 'Review the example.',
        receivedAt: '2026-11-16T00:00:00Z',
      };
      ctx.sessionManager.setPendingEscalation(label, original);
      ctx.sessionManager.setPendingEscalation(label, {
        ...original,
        escalationId: 'example-small-review',
        arguments: { content: 'Example.' },
      });
      const listed = await dispatch(ctx, 'escalations.list', {});
      expect(listed).toEqual([
        expect.objectContaining({ escalationId: original.escalationId, reviewUnavailable: true, arguments: {} }),
        expect.objectContaining({ escalationId: 'example-small-review', arguments: { content: 'Example.' } }),
      ]);
      await expect(
        dispatch(ctx, 'escalations.resolve', { escalationId: original.escalationId, decision: 'approved' }),
      ).rejects.toThrow('can only be denied');
      expect(session.resolveEscalation).not.toHaveBeenCalled();
      await dispatch(ctx, 'escalations.resolve', { escalationId: original.escalationId, decision: 'denied' });
      expect(session.resolveEscalation).toHaveBeenCalledWith(original.escalationId, 'denied', undefined);
    });

    it('escalations.list returns empty when no escalations', async () => {
      const ctx = makeCtx();
      const result = await dispatch(ctx, 'escalations.list', {});
      expect(result).toEqual([]);
    });

    it('escalations.list includes sessions with pending escalations', async () => {
      const ctx = makeCtx();
      const label = ctx.sessionManager.register(stubSession(), stubTransport(), { kind: 'web' });
      const data: PendingEscalationData = {
        escalationId: 'esc-1',
        sessionLabel: label,
        toolName: 'write_file',
        serverName: 'filesystem',
        arguments: { path: '/test' },
        reason: 'Protected path',
        receivedAt: '2026-01-01T00:00:00Z',
      };
      ctx.sessionManager.setPendingEscalation(label, data);

      const result = (await dispatch(ctx, 'escalations.list', {})) as unknown[];
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        escalationId: 'esc-1',
        toolName: 'write_file',
        sessionSource: { kind: 'web' },
      });
    });

    it('escalations.resolve calls resolveSessionEscalation', async () => {
      const ctx = makeCtx();
      const session = stubSession();
      const label = ctx.sessionManager.register(session, stubTransport(), { kind: 'web' });
      ctx.sessionManager.setPendingEscalation(label, {
        escalationId: 'esc-2',
        sessionLabel: label,
        toolName: 'delete_file',
        serverName: 'filesystem',
        arguments: {},
        reason: 'Dangerous',
        receivedAt: '2026-01-01T00:00:00Z',
      });

      await dispatch(ctx, 'escalations.resolve', {
        escalationId: 'esc-2',
        decision: 'denied',
      });

      expect(session.resolveEscalation).toHaveBeenCalledWith('esc-2', 'denied', undefined);
    });

    it('escalations.resolve throws when escalation not found', async () => {
      const ctx = makeCtx();
      await expect(
        dispatch(ctx, 'escalations.resolve', {
          escalationId: 'nonexistent',
          decision: 'approved',
        }),
      ).rejects.toThrow('not_found');
    });

    it('escalations.resolve settles a workflow tool-call escalation by id', async () => {
      const resolveToolCallEscalation = vi.fn().mockReturnValue(true);
      const workflowManager = {
        findToolCallEscalation: vi.fn((id: string) =>
          id === 'wf-esc-1' ? { workflowId: 'wf-1', escalation: { escalationId: id } } : undefined,
        ),
        resolveToolCallEscalation,
      } as unknown as NonNullable<DispatchContext['workflowManager']>;
      const ctx = makeCtx({ workflowManager });

      await dispatch(ctx, 'escalations.resolve', {
        escalationId: 'wf-esc-1',
        decision: 'approved',
        whitelistSelection: 0,
      });
      expect(resolveToolCallEscalation).toHaveBeenCalledWith('wf-esc-1', {
        decision: 'approved',
        whitelistSelection: 0,
      });

      // Not a workflow escalation: falls through to the session managers.
      await expect(dispatch(ctx, 'escalations.resolve', { escalationId: 'other', decision: 'denied' })).rejects.toThrow(
        'not_found',
      );
    });

    it('escalations.resolve reports a workflow escalation that expired meanwhile', async () => {
      const workflowManager = {
        findToolCallEscalation: vi.fn().mockReturnValue({ workflowId: 'wf-1', escalation: {} }),
        resolveToolCallEscalation: vi.fn().mockReturnValue(false),
      } as unknown as NonNullable<DispatchContext['workflowManager']>;
      const ctx = makeCtx({ workflowManager });
      await expect(
        dispatch(ctx, 'escalations.resolve', { escalationId: 'wf-esc-2', decision: 'approved' }),
      ).rejects.toMatchObject({ code: 'ESCALATION_NOT_FOUND' });
    });
  });

  describe('jobs', () => {
    it('jobs.list returns formatted job list', async () => {
      const handler = makeMockHandler();
      (handler.listJobs as ReturnType<typeof vi.fn>).mockReturnValue([
        {
          job: { id: 'j1', name: 'Test Job', schedule: '0 9 * * *', task: 'do stuff', enabled: true },
          nextRun: new Date('2026-03-05T09:00:00Z'),
          lastRun: undefined,
          isRunning: false,
        },
      ]);
      const ctx = makeCtx({ handler });

      const result = (await dispatch(ctx, 'jobs.list', {})) as unknown[];
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        job: { id: 'j1' },
        nextRun: '2026-03-05T09:00:00.000Z',
        lastRun: null,
        isRunning: false,
      });
    });

    it('jobs.remove calls handler and emits event', async () => {
      const handler = makeMockHandler();
      const ctx = makeCtx({ handler });
      const eventHandler = vi.fn();
      ctx.eventBus.subscribe(eventHandler);

      await dispatch(ctx, 'jobs.remove', { jobId: 'j1' });

      expect(handler.removeJob).toHaveBeenCalledWith('j1');
      expect(eventHandler).toHaveBeenCalledWith('job.list_changed', {});
    });

    it('jobs.enable calls handler and emits event', async () => {
      const handler = makeMockHandler();
      const ctx = makeCtx({ handler });

      await dispatch(ctx, 'jobs.enable', { jobId: 'j1' });
      expect(handler.enableJob).toHaveBeenCalledWith('j1');
    });

    it('jobs.disable calls handler and emits event', async () => {
      const handler = makeMockHandler();
      const ctx = makeCtx({ handler });

      await dispatch(ctx, 'jobs.disable', { jobId: 'j1' });
      expect(handler.disableJob).toHaveBeenCalledWith('j1');
    });

    it('jobs.run returns accepted and emits job.started', async () => {
      const handler = makeMockHandler();
      const ctx = makeCtx({ handler });
      const eventHandler = vi.fn();
      ctx.eventBus.subscribe(eventHandler);

      const result = await dispatch(ctx, 'jobs.run', { jobId: 'j1' });
      expect(result).toEqual({ accepted: true, jobId: 'j1' });
      expect(handler.startJobRun).toHaveBeenCalledWith('j1');
      expect(eventHandler).toHaveBeenCalledWith('job.started', { jobId: 'j1', sessionLabel: 0 });
      await vi.waitFor(() => {
        expect(eventHandler).toHaveBeenCalledWith('job.completed', { jobId: 'j1', record: RUN_RECORD });
      });
    });

    it('jobs.run refuses a job that is already running before accepting it', async () => {
      const handler = makeMockHandler();
      vi.mocked(handler.startJobRun).mockImplementation((jobId) => {
        throw new JobAlreadyRunningError(jobId, 4);
      });
      const ctx = makeCtx({ handler });
      const eventHandler = vi.fn();
      ctx.eventBus.subscribe(eventHandler);

      await expect(dispatch(ctx, 'jobs.run', { jobId: 'j1' })).rejects.toMatchObject({
        name: 'RpcError',
        code: 'JOB_ALREADY_RUNNING',
        message: 'Job "j1" is already running (session #4)',
      });
      expect(eventHandler).not.toHaveBeenCalled();
    });

    it('jobs.run reports an unknown job as JOB_NOT_FOUND before accepting it', async () => {
      const handler = makeMockHandler();
      vi.mocked(handler.startJobRun).mockImplementation((jobId) => {
        throw new JobNotFoundError(jobId);
      });
      const ctx = makeCtx({ handler });
      const eventHandler = vi.fn();
      ctx.eventBus.subscribe(eventHandler);

      await expect(dispatch(ctx, 'jobs.run', { jobId: 'nope' })).rejects.toMatchObject({
        name: 'RpcError',
        code: 'JOB_NOT_FOUND',
        message: 'Job not found: nope',
      });
      expect(eventHandler).not.toHaveBeenCalled();
    });

    it('jobs.run passes other refusals through unchanged', async () => {
      const handler = makeMockHandler();
      vi.mocked(handler.startJobRun).mockImplementation(() => {
        throw new Error('the job store is unreadable');
      });
      const ctx = makeCtx({ handler });

      await expect(dispatch(ctx, 'jobs.run', { jobId: 'j1' })).rejects.toThrow('the job store is unreadable');
    });
  });

  describe('DTO builders', () => {
    it('toSessionDto maps managed session correctly', () => {
      const mgr = new SessionManager();
      const session = stubSession();
      const label = mgr.register(session, stubTransport(), { kind: 'web' });
      const managed = mgr.get(label)!;

      const dto = toSessionDto(managed);

      expect(dto).toMatchObject({
        label: 1,
        source: { kind: 'web' },
        status: 'ready',
        turnCount: 3,
        hasPendingEscalation: false,
        messageInFlight: false,
      });
    });

    it('toSessionDto reflects pending escalation', () => {
      const mgr = new SessionManager();
      const label = mgr.register(stubSession(), stubTransport(), { kind: 'web' });
      mgr.setPendingEscalation(label, {
        escalationId: 'e1',
        sessionLabel: label,
        toolName: 't',
        serverName: 's',
        arguments: {},
        reason: 'r',
        receivedAt: '2026-01-01T00:00:00Z',
      });
      const managed = mgr.get(label)!;

      expect(toSessionDto(managed).hasPendingEscalation).toBe(true);
    });

    it('toBudgetDto reports session totals, not the zeroed per-turn fields of an idle session', () => {
      const mgr = new SessionManager();
      const label = mgr.register(stubSession(), stubTransport(), { kind: 'web' });
      const managed = mgr.get(label)!;

      const dto = toBudgetDto(managed);

      expect(dto).toMatchObject({
        totalTokens: 800,
        stepCount: 5,
        elapsedSeconds: 120,
        estimatedCostUsd: 0.05,
        tokenTrackingAvailable: true,
        limits: {
          maxTotalTokens: 1_000_000,
          maxSteps: 200,
          maxSessionSeconds: 1800,
          maxEstimatedCostUsd: 5,
        },
      });
      // A session that prices every step itself carries no cost source.
      expect(dto).not.toHaveProperty('costSource');
    });

    it('toBudgetDto passes an unknown cost source through, so the UI does not show $0.00', () => {
      const session = stubSession();
      const status = session.getBudgetStatus();
      const mgr = new SessionManager();
      const label = mgr.register(
        { ...session, getBudgetStatus: () => ({ ...status, estimatedCostUsd: 0, costSource: 'unknown' as const }) },
        stubTransport(),
        { kind: 'web' },
      );

      expect(toBudgetDto(mgr.get(label)!)).toMatchObject({ costSource: 'unknown' });
    });

    it('buildStatusDto includes webUiListening=true', () => {
      const ctx = makeCtx();
      const dto = buildStatusDto(ctx);

      expect(dto.webUiListening).toBe(true);
      expect(dto.uptimeSeconds).toBe(300);
      expect(dto.nextFireTime).toBe('2026-03-05T10:00:00.000Z');
      expect(dto.sessionMode).toBe('builtin');
    });

    it('buildStatusDto maps internal docker mode to public container mode', () => {
      const ctx = makeCtx({ mode: { kind: 'docker', agent: 'claude-code' as AgentId, authKind: 'apikey' } });
      const dto = buildStatusDto(ctx);

      expect(dto.sessionMode).toBe('container');
    });

    it('buildStatusDto handles null nextFireTime', () => {
      const handler = makeMockHandler();
      (handler.getStatus as ReturnType<typeof vi.fn>).mockReturnValue({
        uptimeSeconds: 10,
        jobs: { total: 0, enabled: 0, running: 0 },
        signalConnected: false,
        nextFireTime: undefined,
      });
      const ctx = makeCtx({ handler });

      const dto = buildStatusDto(ctx);
      expect(dto.nextFireTime).toBeNull();
    });
  });
});
