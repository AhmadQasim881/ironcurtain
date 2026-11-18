/**
 * SessionManager -- Unified session state management.
 *
 * Extracted from SignalBotDaemon to serve as the single owner of all
 * managed session state. Both Signal-initiated and cron-initiated
 * sessions register here for unified lifecycle management and
 * escalation routing.
 *
 * This is the canonical location for SessionSource and ManagedSession
 * types. The daemon module re-exports them for convenience.
 */

import type { EscalationRequest, Session } from './types.js';
import type { Transport } from './transport.js';
import type { JobId } from '../cron/types.js';
import { isEscalationExpiredError } from '../types/errors.js';
import type { EscalationDisplayFields } from '../escalation/escalation-review.js';
import * as logger from '../logger.js';

/**
 * The escalation data stored on a ManagedSession: the full request, so that
 * every client that lists pending escalations (a late-connecting browser
 * tab, the web UI showing a cron or Signal session's escalation) sees
 * exactly what is being asked without having received the original event.
 */
export interface PendingEscalationData extends EscalationDisplayFields {
  readonly escalationId: string;
  readonly sessionLabel: number;
  readonly toolName: string;
  readonly serverName: string;
  readonly arguments: Record<string, unknown>;
  readonly reason: string;
  readonly context?: Record<string, string>;
  readonly whitelistCandidates?: readonly { readonly description: string; readonly patternKey?: string }[];
  readonly receivedAt: string;
}

/**
 * The {@link PendingEscalationData} of `request`, raised on session `label`
 * at `receivedAt` (epoch milliseconds, default now). It keeps the whitelist
 * candidates (the patterns `whitelistSelection` indexes) and the reviewer
 * context (the human's task and last message; the agent's untrusted
 * justification), so a client listing it shows what the request asks. It
 * carries no group key: an escalation recorded here (a Signal or cron
 * session's) is decided on its own, never as part of a web UI group
 * approval.
 */
export function toPendingEscalationData(
  request: EscalationRequest,
  label: number,
  receivedAt: number = Date.now(),
): PendingEscalationData {
  return {
    escalationId: request.escalationId,
    sessionLabel: label,
    toolName: request.toolName,
    serverName: request.serverName,
    arguments: request.arguments,
    reason: request.reason,
    ...(request.context ? { context: { ...request.context } } : {}),
    ...(request.whitelistCandidates ? { whitelistCandidates: request.whitelistCandidates } : {}),
    ...(request.taskSummary !== undefined ? { taskSummary: request.taskSummary } : {}),
    ...(request.lastTrustedUserMessage !== undefined ? { lastTrustedUserMessage: request.lastTrustedUserMessage } : {}),
    ...(request.agentJustification !== undefined ? { agentJustification: request.agentJustification } : {}),
    receivedAt: new Date(receivedAt).toISOString(),
  };
}

/**
 * Whether a pending escalation names what would be approved: its server, its
 * tool and an arguments object. One that does not can only be denied
 * (approving it would be approving an unknown call).
 */
export function isCompleteEscalation(escalation: PendingEscalationData): boolean {
  // The request was parsed from a file without a schema: check the values
  // themselves, not what the type promises.
  const fields: { readonly serverName: unknown; readonly toolName: unknown; readonly arguments: unknown } = escalation;
  return (
    typeof fields.serverName === 'string' &&
    fields.serverName !== '' &&
    typeof fields.toolName === 'string' &&
    fields.toolName !== '' &&
    typeof fields.arguments === 'object' &&
    fields.arguments !== null &&
    !Array.isArray(fields.arguments)
  );
}

/**
 * A change to one of a session's pending escalations, as told to
 * {@link SessionManager.subscribeEscalationEvents} listeners (the web UI
 * pushes them to browsers for the sessions whose transports do not).
 */
export type SessionEscalationEvent =
  | { readonly kind: 'pending'; readonly managed: ManagedSession; readonly escalation: PendingEscalationData }
  | {
      readonly kind: 'resolved';
      readonly managed: ManagedSession;
      readonly escalationId: string;
      readonly decision: 'approved' | 'denied';
    }
  | { readonly kind: 'expired'; readonly managed: ManagedSession; readonly escalationId: string };

export type SessionEscalationListener = (event: SessionEscalationEvent) => void;

/**
 * Source discriminant for managed sessions.
 * Determines cleanup behavior, notification routing, and
 * message forwarding eligibility.
 *
 * - 'signal': interactive session created via Signal message.
 *   Accepts follow-up messages via forwardToSession().
 * - 'cron': headless session created by the cron scheduler.
 *   Does NOT accept follow-up messages.
 * - 'web': interactive session created via the web UI.
 *   Always targeted by explicit label (no currentLabel focus).
 * - 'web-pty': live Docker-agent PTY session streamed to the web UI as a
 *   terminal. Never registered in SessionManager (it has no Session/Transport);
 *   the label is only borrowed via reserveLabel(). Produced solely by
 *   `toPtySessionDto` for the sessions list — see PtySessionManager.
 */
export type SessionSource =
  | { readonly kind: 'signal' }
  | { readonly kind: 'cron'; readonly jobId: JobId; readonly jobName: string }
  | { readonly kind: 'web'; readonly persona?: string }
  | { readonly kind: 'web-pty'; readonly persona?: string };

/**
 * Unified managed session entry. Used for both Signal-initiated
 * interactive sessions and cron-initiated headless sessions.
 *
 * The transport field uses the base Transport interface because
 * cron sessions use HeadlessTransport. Code that needs
 * Signal-specific methods must guard on source.kind === 'signal'.
 */
export interface ManagedSession {
  readonly label: number;
  readonly session: Session;
  readonly transport: Transport;
  readonly source: SessionSource;
  messageInFlight: boolean;
  /**
   * Full data of every escalation of this session that waits for a
   * decision, by escalation id, in the order they were recorded, for
   * late-connecting clients and expiry handling. Several can be pending at
   * once: the coordinator releases its call mutex while a call waits for a
   * decision, so parallel tool calls each raise their own escalation.
   */
  readonly pendingEscalations: Map<string, PendingEscalationData>;
  /** Ids of the pending escalations whose resolution is in progress. */
  readonly escalationsResolving: Set<string>;
  /**
   * The promise returned by transport.run(). When set, SessionManager.end()
   * awaits it after closing the transport but before closing the session,
   * giving the transport time to finish cleanup (e.g., auto-save).
   */
  runPromise: Promise<void> | null;
}

/**
 * Outcome of {@link SessionManager.resolveSessionEscalation}. `expired`
 * means the session wrote the response after the proxy had already timed
 * the request out: the tool call was denied whatever the decision was, so
 * callers must report it as expired, never as approved.
 */
export interface EscalationResolutionResult {
  readonly resolved: boolean;
  readonly reason?: 'not_found' | 'already_resolving' | 'expired';
}

/**
 * Owns all managed session state. Both SignalBotDaemon and
 * CronScheduler delegate to this class for session registration,
 * lookup, and teardown.
 *
 * Invariants:
 * - Labels are monotonically increasing integers starting at 1.
 * - At most one registered session exists per label.
 * - currentLabel is always either null or a valid label in the map.
 *
 * Label space is shared with workflow-owned agent sessions via
 * `reserveLabel()` — those labels are live at the TokenStreamBridge
 * but have no entry in this manager's `sessions` map. Code that
 * iterates `sessions` or calls `end(label)` will silently skip them;
 * their lifecycle is owned by the workflow orchestrator.
 */
export class SessionManager {
  private sessions = new Map<number, ManagedSession>();
  /**
   * In-flight teardowns by label. `end()` memoizes one promise per label so
   * concurrent callers (an explicit `sessions.end`, the transport's run
   * completion, the orphan reaper, daemon shutdown) share a single teardown:
   * the transport and session are closed exactly once and the entry stays
   * registered until that teardown has finished.
   */
  private readonly ending = new Map<number, Promise<void>>();
  private nextLabel = 1;
  private readonly escalationListeners = new Set<SessionEscalationListener>();

  /**
   * The currently "focused" session label for Signal message routing.
   * When a Signal message arrives without an explicit #N prefix, it
   * is routed to this session.
   *
   * Only updated by register() for Signal sessions. Cron and web
   * sessions do not steal Signal focus.
   */
  currentLabel: number | null = null;

  /**
   * Reserves a fresh label without registering a session. Exists so
   * that non-managed sessions (workflow-owned agent sessions, which
   * run without a Transport) can share the same label space as
   * managed sessions. A single label authority avoids collisions in
   * the TokenStreamBridge, which keys per-session state by label.
   */
  reserveLabel(): number {
    return this.nextLabel++;
  }

  /**
   * Registers a new session and returns its assigned label.
   *
   * For Signal sessions: sets currentLabel to the new session.
   * For cron/web sessions: currentLabel is NOT changed.
   */
  register(session: Session, transport: Transport, source: SessionSource): number {
    const label = this.nextLabel++;

    const managed: ManagedSession = {
      label,
      session,
      transport,
      source,
      messageInFlight: false,
      pendingEscalations: new Map(),
      escalationsResolving: new Set(),
      runPromise: null,
    };

    this.sessions.set(label, managed);

    // Only Signal sessions update currentLabel
    if (source.kind === 'signal') {
      this.currentLabel = label;
    }

    return label;
  }

  /**
   * Ends a session by label: closes the transport, closes the
   * session, and removes it from the map.
   *
   * Idempotent while a teardown is in flight: a second call for the same
   * label returns the same promise instead of starting a second teardown
   * (see {@link isEnding}). The entry is removed from the map only after
   * `session.close()` has finished, so `byKind()` keeps counting a session
   * whose sandbox is still shutting down.
   *
   * If the ended session was currentLabel, switches to the most
   * recently registered remaining Signal session, or null if none.
   */
  async end(label: number): Promise<void> {
    const inFlight = this.ending.get(label);
    if (inFlight) return inFlight;

    const managed = this.sessions.get(label);
    if (!managed) return;

    const teardown = this.teardown(label, managed).finally(() => {
      this.ending.delete(label);
    });
    this.ending.set(label, teardown);
    return teardown;
  }

  /**
   * Whether a teardown started by {@link end} is still running for this
   * label (the session is still registered until it finishes). It says
   * nothing about who started the teardown, so a caller that wraps `end()`
   * with its own side effects (events, bookkeeping) must track its own
   * in-flight work rather than skip those effects on `isEnding()`: another
   * caller may have started the teardown through a bare `end()` (see
   * web-session-teardown.ts).
   */
  isEnding(label: number): boolean {
    return this.ending.has(label);
  }

  private async teardown(label: number, managed: ManagedSession): Promise<void> {
    try {
      managed.transport.close();
    } catch (err: unknown) {
      logger.warn(`[SessionManager] Error closing transport for session #${label}: ${String(err)}`);
    }

    // Wait for the transport's run() to finish (e.g., auto-save) before
    // closing the session. Bounded to 30s to avoid hanging on stuck transports;
    // the timer is cleared once the race settles so it never outlives the end.
    if (managed.runPromise) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 30_000);
      });
      try {
        await Promise.race([managed.runPromise, timeout]);
      } catch {
        // run() errors are already handled by the caller that started it
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }

    try {
      await managed.session.close();
    } catch (err: unknown) {
      logger.warn(`[SessionManager] Error closing session #${label}: ${String(err)}`);
    }

    // A closed session can no longer take a decision on its escalations.
    // The records stay on the (now unregistered) entry: the web teardown
    // reads them to announce the expiry of a web session's escalations itself.
    for (const escalationId of [...managed.pendingEscalations.keys()]) {
      this.notifyEscalation({ kind: 'expired', managed, escalationId });
    }

    this.sessions.delete(label);

    // If the ended session was the current label, find a replacement
    if (this.currentLabel === label) {
      this.currentLabel = this.findMostRecentSignalLabel();
    }
  }

  /** Returns the ManagedSession for a label, or undefined. */
  get(label: number): ManagedSession | undefined {
    return this.sessions.get(label);
  }

  /** Returns all managed sessions (snapshot). */
  all(): readonly ManagedSession[] {
    return [...this.sessions.values()];
  }

  /** Returns managed sessions filtered by source kind. */
  byKind(kind: SessionSource['kind']): readonly ManagedSession[] {
    return [...this.sessions.values()].filter((m) => m.source.kind === kind);
  }

  /** Returns the number of active sessions. */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * Registers a listener for changes to pending escalations: recorded
   * (`pending`), resolved through {@link resolveSessionEscalation}, expired
   * ({@link expireEscalation}, a response that came too late, or the session
   * ending with one pending). Returns the unsubscribe thunk. Listener errors
   * are logged, never thrown into the escalation path.
   */
  subscribeEscalationEvents(listener: SessionEscalationListener): () => void {
    this.escalationListeners.add(listener);
    return () => {
      this.escalationListeners.delete(listener);
    };
  }

  private notifyEscalation(event: SessionEscalationEvent): void {
    for (const listener of [...this.escalationListeners]) {
      try {
        listener(event);
      } catch (err: unknown) {
        logger.warn(`[SessionManager] Escalation listener failed: ${String(err)}`);
      }
    }
  }

  /**
   * Records a pending escalation of a session, with its full data (server,
   * tool, arguments, reason, context, whitelist candidates), next to any
   * others the session already has pending, and tells the listeners unless
   * `announce` is false (an escalation about to be denied automatically,
   * which nobody is asked to decide).
   */
  setPendingEscalation(label: number, escalation: PendingEscalationData, options?: { announce?: boolean }): void {
    const managed = this.sessions.get(label);
    if (!managed) return;
    managed.pendingEscalations.set(escalation.escalationId, escalation);
    if (options?.announce !== false) this.notifyEscalation({ kind: 'pending', managed, escalation });
  }

  /**
   * Records `request` as a pending escalation of session `label` (see
   * {@link setPendingEscalation} and {@link toPendingEscalationData};
   * `receivedAt` is when it was raised, in epoch milliseconds, default now)
   * and returns what was recorded, or undefined when no such session is
   * registered.
   */
  recordEscalation(
    label: number,
    request: EscalationRequest,
    options?: { announce?: boolean; receivedAt?: number },
  ): PendingEscalationData | undefined {
    if (!this.sessions.has(label)) return undefined;
    const escalation = toPendingEscalationData(request, label, options?.receivedAt);
    this.setPendingEscalation(label, escalation, options);
    return escalation;
  }

  /** Clears one pending escalation of a session (it was decided elsewhere). */
  clearPendingEscalation(label: number, escalationId: string): void {
    const managed = this.sessions.get(label);
    if (managed) {
      managed.pendingEscalations.delete(escalationId);
      managed.escalationsResolving.delete(escalationId);
    }
  }

  /**
   * Clears one pending escalation of a session because it expired (the
   * proxy timed it out and denied the call), telling the listeners. The
   * session's other pending escalations are unaffected. Returns false when
   * that escalation was not pending.
   */
  expireEscalation(label: number, escalationId: string): boolean {
    const managed = this.sessions.get(label);
    if (!managed?.pendingEscalations.has(escalationId)) return false;
    managed.pendingEscalations.delete(escalationId);
    managed.escalationsResolving.delete(escalationId);
    this.notifyEscalation({ kind: 'expired', managed, escalationId });
    return true;
  }

  /** Returns sessions that have at least one pending escalation. */
  withPendingEscalation(): readonly ManagedSession[] {
    return [...this.sessions.values()].filter((m) => m.pendingEscalations.size > 0);
  }

  /** Every pending escalation of every session, each with its session, sessions in label order. */
  allPendingEscalations(): readonly { readonly managed: ManagedSession; readonly escalation: PendingEscalationData }[] {
    return [...this.sessions.values()].flatMap((managed) =>
      [...managed.pendingEscalations.values()].map((escalation) => ({ managed, escalation })),
    );
  }

  /** Finds the session that has this escalation pending. */
  findByEscalation(escalationId: string): ManagedSession | undefined {
    return [...this.sessions.values()].find((m) => m.pendingEscalations.has(escalationId));
  }

  /**
   * Resolves a pending escalation on any session. Encapsulates the
   * per-escalation resolving guard (a second decision on the same escalation
   * while the first is being written is refused; other escalations of the
   * session can be decided meanwhile), the resolveEscalation call, and the
   * cleanup of that escalation's record.
   *
   * This is the single codepath for escalation resolution. Every caller
   * (Signal replies, the web UI, the cron auto-deny) goes through here, and
   * the outcome is told to the escalation listeners.
   *
   * A response that arrived after the proxy's timeout (the session throws
   * `ESCALATION_EXPIRED`) is reported as `{ resolved: false, reason:
   * 'expired' }`; any other error propagates.
   */
  async resolveSessionEscalation(
    escalationId: string,
    decision: 'approved' | 'denied',
    options?: { whitelistSelection?: number },
  ): Promise<EscalationResolutionResult> {
    const managed = this.findByEscalation(escalationId);
    if (!managed) {
      return { resolved: false, reason: 'not_found' };
    }

    if (managed.escalationsResolving.has(escalationId)) {
      return { resolved: false, reason: 'already_resolving' };
    }

    managed.escalationsResolving.add(escalationId);
    try {
      await managed.session.resolveEscalation(escalationId, decision, options);
      this.notifyEscalation({ kind: 'resolved', managed, escalationId, decision });
      return { resolved: true };
    } catch (error) {
      if (isEscalationExpiredError(error)) {
        this.notifyEscalation({ kind: 'expired', managed, escalationId });
        return { resolved: false, reason: 'expired' };
      }
      throw error;
    } finally {
      managed.escalationsResolving.delete(escalationId);
      managed.pendingEscalations.delete(escalationId);
    }
  }

  /**
   * Finds the most recently registered Signal session label.
   * Returns null if no Signal sessions exist.
   */
  private findMostRecentSignalLabel(): number | null {
    const signalSessions = this.byKind('signal');
    if (signalSessions.length === 0) return null;
    return Math.max(...signalSessions.map((m) => m.label));
  }
}
