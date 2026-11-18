/**
 * Tests for SessionManager -- session registration, lookup,
 * escalation tracking, and currentLabel management.
 *
 * Uses minimal Session/Transport stubs (no real LLM or Docker).
 */

import { describe, it, expect, vi } from 'vitest';
import { isCompleteEscalation, SessionManager } from '../src/session/session-manager.js';
import type { SessionEscalationEvent, SessionSource } from '../src/session/session-manager.js';
import type { EscalationRequest, Session, SessionInfo } from '../src/session/types.js';
import { EscalationExpiredError } from '../src/types/errors.js';
import type { Transport } from '../src/session/transport.js';
import type { JobId } from '../src/cron/types.js';

/** Minimal Session stub -- only methods actually called by SessionManager. */
function stubSession(): Session {
  return {
    getInfo: () =>
      ({ id: 'test-id', status: 'ready', turnCount: 0, createdAt: new Date().toISOString() }) as SessionInfo,
    sendMessage: vi.fn(),
    getHistory: vi.fn().mockReturnValue([]),
    getDiagnosticLog: vi.fn().mockReturnValue([]),
    resolveEscalation: vi.fn(),
    getPendingEscalations: vi.fn(() => []),
    getBudgetStatus: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

/** Minimal Transport stub. */
function stubTransport(): Transport {
  return {
    run: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
}

const signalSource: SessionSource = { kind: 'signal' };
const cronSource: SessionSource = { kind: 'cron', jobId: 'daily-check' as JobId, jobName: 'Daily Check' };

describe('SessionManager', () => {
  describe('register', () => {
    it('assigns monotonically increasing labels', () => {
      const mgr = new SessionManager();
      const l1 = mgr.register(stubSession(), stubTransport(), signalSource);
      const l2 = mgr.register(stubSession(), stubTransport(), signalSource);
      const l3 = mgr.register(stubSession(), stubTransport(), cronSource);

      expect(l1).toBe(1);
      expect(l2).toBe(2);
      expect(l3).toBe(3);
    });

    it('sets currentLabel for signal sessions', () => {
      const mgr = new SessionManager();
      mgr.register(stubSession(), stubTransport(), signalSource);
      expect(mgr.currentLabel).toBe(1);

      mgr.register(stubSession(), stubTransport(), signalSource);
      expect(mgr.currentLabel).toBe(2);
    });

    it('does NOT update currentLabel for cron sessions', () => {
      const mgr = new SessionManager();
      mgr.register(stubSession(), stubTransport(), signalSource);
      expect(mgr.currentLabel).toBe(1);

      mgr.register(stubSession(), stubTransport(), cronSource);
      expect(mgr.currentLabel).toBe(1); // unchanged
    });
  });

  describe('get / all / size', () => {
    it('retrieves a session by label', () => {
      const mgr = new SessionManager();
      const session = stubSession();
      const label = mgr.register(session, stubTransport(), signalSource);

      const managed = mgr.get(label);
      expect(managed).toBeDefined();
      expect(managed!.session).toBe(session);
      expect(managed!.source).toEqual(signalSource);
    });

    it('returns undefined for a non-existent label', () => {
      const mgr = new SessionManager();
      expect(mgr.get(999)).toBeUndefined();
    });

    it('returns all sessions as a snapshot', () => {
      const mgr = new SessionManager();
      mgr.register(stubSession(), stubTransport(), signalSource);
      mgr.register(stubSession(), stubTransport(), cronSource);

      const all = mgr.all();
      expect(all).toHaveLength(2);
    });

    it('reports the correct size', () => {
      const mgr = new SessionManager();
      expect(mgr.size).toBe(0);
      mgr.register(stubSession(), stubTransport(), signalSource);
      expect(mgr.size).toBe(1);
    });
  });

  describe('byKind', () => {
    it('filters sessions by source kind', () => {
      const mgr = new SessionManager();
      mgr.register(stubSession(), stubTransport(), signalSource);
      mgr.register(stubSession(), stubTransport(), cronSource);
      mgr.register(stubSession(), stubTransport(), signalSource);

      expect(mgr.byKind('signal')).toHaveLength(2);
      expect(mgr.byKind('cron')).toHaveLength(1);
    });
  });

  describe('end', () => {
    it('closes transport and session, then removes from map', async () => {
      const mgr = new SessionManager();
      const session = stubSession();
      const transport = stubTransport();
      const label = mgr.register(session, transport, signalSource);

      await mgr.end(label);

      expect(transport.close).toHaveBeenCalled();
      expect(session.close).toHaveBeenCalled();
      expect(mgr.get(label)).toBeUndefined();
      expect(mgr.size).toBe(0);
    });

    it('is a no-op for a non-existent label', async () => {
      const mgr = new SessionManager();
      await expect(mgr.end(999)).resolves.toBeUndefined();
    });

    it('updates currentLabel when the current session ends', async () => {
      const mgr = new SessionManager();
      const l1 = mgr.register(stubSession(), stubTransport(), signalSource);
      const l2 = mgr.register(stubSession(), stubTransport(), signalSource);
      expect(mgr.currentLabel).toBe(l2);

      await mgr.end(l2);
      // Should fall back to the remaining signal session
      expect(mgr.currentLabel).toBe(l1);
    });

    it('sets currentLabel to null when the last signal session ends', async () => {
      const mgr = new SessionManager();
      const l1 = mgr.register(stubSession(), stubTransport(), signalSource);
      mgr.register(stubSession(), stubTransport(), cronSource);

      await mgr.end(l1);
      // Cron sessions don't count for currentLabel
      expect(mgr.currentLabel).toBeNull();
    });

    it('does not change currentLabel when a non-current session ends', async () => {
      const mgr = new SessionManager();
      const l1 = mgr.register(stubSession(), stubTransport(), signalSource);
      const l2 = mgr.register(stubSession(), stubTransport(), signalSource);
      expect(mgr.currentLabel).toBe(l2);

      await mgr.end(l1);
      expect(mgr.currentLabel).toBe(l2);
    });

    it('handles transport.close() throwing without crashing', async () => {
      const mgr = new SessionManager();
      const transport = stubTransport();
      (transport.close as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('transport boom');
      });
      const label = mgr.register(stubSession(), transport, signalSource);

      // Should not throw
      await mgr.end(label);
      expect(mgr.get(label)).toBeUndefined();
    });

    it('handles session.close() rejecting without crashing', async () => {
      const mgr = new SessionManager();
      const session = stubSession();
      (session.close as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('session boom'));
      const label = mgr.register(session, stubTransport(), signalSource);

      await mgr.end(label);
      expect(mgr.get(label)).toBeUndefined();
    });

    // GAP4-10: concurrent ends (explicit end + the transport's run completion,
    // the orphan reaper, daemon shutdown) must share ONE teardown.
    it('memoizes an in-flight end: concurrent calls share one teardown and close once', async () => {
      const mgr = new SessionManager();
      const session = stubSession();
      let finishClose: (() => void) | undefined;
      vi.mocked(session.close).mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finishClose = resolve;
          }),
      );
      const transport = stubTransport();
      const label = mgr.register(session, transport, signalSource);

      const first = mgr.end(label);
      const second = mgr.end(label);

      expect(mgr.isEnding(label)).toBe(true);
      // Still registered (and counted) while the session is shutting down.
      expect(mgr.get(label)).toBeDefined();
      expect(mgr.size).toBe(1);
      expect(finishClose).toBeDefined();

      finishClose?.();
      await Promise.all([first, second]);

      expect(session.close).toHaveBeenCalledTimes(1);
      expect(transport.close).toHaveBeenCalledTimes(1);
      expect(mgr.get(label)).toBeUndefined();
      expect(mgr.isEnding(label)).toBe(false);
    });

    it('isEnding is false for unknown labels and for sessions that are not ending', () => {
      const mgr = new SessionManager();
      const label = mgr.register(stubSession(), stubTransport(), signalSource);
      expect(mgr.isEnding(label)).toBe(false);
      expect(mgr.isEnding(999)).toBe(false);
    });

    it('clears the 30s run-promise wait timer once the race settles', async () => {
      vi.useFakeTimers();
      try {
        const mgr = new SessionManager();
        const label = mgr.register(stubSession(), stubTransport(), signalSource);
        const managed = mgr.get(label);
        if (managed) managed.runPromise = Promise.resolve();

        await mgr.end(label);

        expect(vi.getTimerCount()).toBe(0);
        expect(mgr.get(label)).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('escalation tracking', () => {
    /** A full escalation request, as the proxy raises it. */
    function request(escalationId: string): EscalationRequest {
      return {
        escalationId,
        serverName: 'github',
        toolName: 'close_issue',
        arguments: { owner: 'o', repo: 'r', issue_number: 7 },
        reason: 'Closing issues requires approval',
        context: { cwd: '/w' },
        whitelistCandidates: [{ description: 'Allow close_issue in o/r' }],
      };
    }

    it('recordEscalation stores the full request, never a blank placeholder', () => {
      const mgr = new SessionManager();
      const label = mgr.register(stubSession(), stubTransport(), signalSource);

      const recorded = mgr.recordEscalation(label, request('esc-123'));
      const managed = mgr.get(label)!;
      expect(managed.pendingEscalations.get('esc-123')).toEqual(recorded);
      expect(managed.pendingEscalations.get('esc-123')).toMatchObject({
        escalationId: 'esc-123',
        sessionLabel: label,
        serverName: 'github',
        toolName: 'close_issue',
        arguments: { owner: 'o', repo: 'r', issue_number: 7 },
        reason: 'Closing issues requires approval',
        context: { cwd: '/w' },
        whitelistCandidates: [{ description: 'Allow close_issue in o/r' }],
      });
      expect(isCompleteEscalation(managed.pendingEscalations.get('esc-123')!)).toBe(true);
    });

    it('clearPendingEscalation clears that escalation only', () => {
      const mgr = new SessionManager();
      const label = mgr.register(stubSession(), stubTransport(), signalSource);

      mgr.recordEscalation(label, request('esc-123'));
      mgr.recordEscalation(label, request('esc-456'));
      mgr.clearPendingEscalation(label, 'esc-123');

      const managed = mgr.get(label)!;
      expect([...managed.pendingEscalations.keys()]).toEqual(['esc-456']);
      expect(managed.escalationsResolving.size).toBe(0);
    });

    it('holds several pending escalations of one session, each decided and expired on its own', async () => {
      const mgr = new SessionManager();
      const session = stubSession();
      const events: SessionEscalationEvent[] = [];
      mgr.subscribeEscalationEvents((event) => events.push(event));
      const label = mgr.register(session, stubTransport(), signalSource);

      mgr.recordEscalation(label, request('esc-a'));
      mgr.recordEscalation(label, request('esc-b'));
      mgr.recordEscalation(label, request('esc-c'));
      expect(mgr.findByEscalation('esc-b')?.label).toBe(label);
      expect(mgr.allPendingEscalations().map((entry) => entry.escalation.escalationId)).toEqual([
        'esc-a',
        'esc-b',
        'esc-c',
      ]);

      await expect(mgr.resolveSessionEscalation('esc-b', 'approved')).resolves.toEqual({ resolved: true });
      expect(session.resolveEscalation).toHaveBeenCalledWith('esc-b', 'approved', undefined);
      expect(mgr.expireEscalation(label, 'esc-a')).toBe(true);
      expect(mgr.expireEscalation(label, 'esc-a')).toBe(false);

      expect([...mgr.get(label)!.pendingEscalations.keys()]).toEqual(['esc-c']);
      expect(events.map((event) => event.kind)).toEqual(['pending', 'pending', 'pending', 'resolved', 'expired']);
    });

    it('a decision in progress on one escalation does not block another of the same session', async () => {
      const mgr = new SessionManager();
      const session = stubSession();
      let finishFirst: (() => void) | undefined;
      vi.mocked(session.resolveEscalation).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishFirst = resolve;
          }),
      );
      const label = mgr.register(session, stubTransport(), signalSource);
      mgr.recordEscalation(label, request('esc-a'));
      mgr.recordEscalation(label, request('esc-b'));

      const first = mgr.resolveSessionEscalation('esc-a', 'approved');
      await expect(mgr.resolveSessionEscalation('esc-a', 'denied')).resolves.toEqual({
        resolved: false,
        reason: 'already_resolving',
      });
      await expect(mgr.resolveSessionEscalation('esc-b', 'denied')).resolves.toEqual({ resolved: true });
      finishFirst?.();
      await expect(first).resolves.toEqual({ resolved: true });
      expect(mgr.get(label)!.pendingEscalations.size).toBe(0);
    });

    it('withPendingEscalation returns only sessions with active escalations', () => {
      const mgr = new SessionManager();
      const l1 = mgr.register(stubSession(), stubTransport(), signalSource);
      mgr.register(stubSession(), stubTransport(), signalSource);
      const l3 = mgr.register(stubSession(), stubTransport(), cronSource);

      mgr.recordEscalation(l1, request('esc-1'));
      mgr.recordEscalation(l3, request('esc-3'));

      const pending = mgr.withPendingEscalation();
      expect(pending).toHaveLength(2);
      expect(pending.map((m) => m.label).sort()).toEqual([l1, l3]);
    });

    it('recordEscalation is a no-op for non-existent labels', () => {
      const mgr = new SessionManager();
      expect(mgr.recordEscalation(999, request('esc'))).toBeUndefined();
    });

    it('clearPendingEscalation is a no-op for non-existent labels', () => {
      const mgr = new SessionManager();
      expect(() => mgr.clearPendingEscalation(999, 'esc')).not.toThrow();
    });

    it('tells its listeners when an escalation is recorded, resolved, expires or outlives its session', async () => {
      const mgr = new SessionManager();
      const events: SessionEscalationEvent[] = [];
      const unsubscribe = mgr.subscribeEscalationEvents((event) => events.push(event));
      const session = stubSession();
      const label = mgr.register(session, stubTransport(), cronSource);

      mgr.recordEscalation(label, request('esc-a'));
      await mgr.resolveSessionEscalation('esc-a', 'approved');
      mgr.recordEscalation(label, request('esc-b'));
      expect(mgr.expireEscalation(label, 'esc-b')).toBe(true);
      expect(mgr.expireEscalation(label, 'esc-b')).toBe(false);
      mgr.recordEscalation(label, request('esc-c'), { announce: false });
      mgr.recordEscalation(label, request('esc-d'));
      await mgr.end(label);

      expect(
        events.map((event) => [
          event.kind,
          event.kind === 'pending' ? event.escalation.escalationId : event.escalationId,
        ]),
      ).toEqual([
        ['pending', 'esc-a'],
        ['resolved', 'esc-a'],
        ['pending', 'esc-b'],
        ['expired', 'esc-b'],
        ['pending', 'esc-d'],
        // Both escalations still pending when the session ended expire.
        ['expired', 'esc-c'],
        ['expired', 'esc-d'],
      ]);
      expect(events.every((event) => event.managed.source === cronSource)).toBe(true);

      unsubscribe();
      const other = mgr.register(stubSession(), stubTransport(), cronSource);
      mgr.recordEscalation(other, request('esc-e'));
      expect(events).toHaveLength(7);
    });

    it('reports a response that came too late as expired to its listeners', async () => {
      const mgr = new SessionManager();
      const session = stubSession();
      vi.mocked(session.resolveEscalation).mockRejectedValueOnce(new EscalationExpiredError('esc-late'));
      const events: SessionEscalationEvent[] = [];
      mgr.subscribeEscalationEvents((event) => events.push(event));
      const label = mgr.register(session, stubTransport(), signalSource);
      mgr.recordEscalation(label, request('esc-late'));

      await expect(mgr.resolveSessionEscalation('esc-late', 'approved')).resolves.toEqual({
        resolved: false,
        reason: 'expired',
      });
      expect(events.map((event) => event.kind)).toEqual(['pending', 'expired']);
    });

    it('keeps resolving when a listener throws', async () => {
      const mgr = new SessionManager();
      mgr.subscribeEscalationEvents(() => {
        throw new Error('listener bug');
      });
      const label = mgr.register(stubSession(), stubTransport(), signalSource);
      mgr.recordEscalation(label, request('esc-x'));
      await expect(mgr.resolveSessionEscalation('esc-x', 'denied')).resolves.toEqual({ resolved: true });
    });
  });

  describe('managed session initial state', () => {
    it('initializes with correct defaults', () => {
      const mgr = new SessionManager();
      const label = mgr.register(stubSession(), stubTransport(), signalSource);
      const managed = mgr.get(label)!;

      expect(managed.label).toBe(label);
      expect(managed.messageInFlight).toBe(false);
      expect(managed.pendingEscalations.size).toBe(0);
      expect(managed.escalationsResolving.size).toBe(0);
    });
  });
});
