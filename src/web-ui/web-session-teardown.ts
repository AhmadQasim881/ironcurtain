/**
 * The single teardown path for turn-based web sessions (the `web` source
 * kind). Every way a web session can end converges here: an explicit
 * `sessions.end`, budget exhaustion inside `sessions.send`, the transport's
 * run() completing, the no-clients orphan reaper, and daemon shutdown.
 *
 * Why one path: `SessionManager.end()` alone neither tells the UI nor cleans
 * up the token-stream bookkeeping, while `session.ended` is what the daemon
 * uses to drop its TokenStreamBridge label maps and what clients use to drop
 * the row. Callers that ended sessions directly therefore leaked both. This
 * helper performs the full sequence, and it is idempotent per session: a
 * concurrent caller joins the helper teardown already in flight instead of
 * closing the session a second time or emitting a second `session.ended`.
 *
 * The in-flight record is the helper's own (keyed by the managed-session
 * entry), not `SessionManager.isEnding()`: `SessionManager.end()` is public
 * and not web-specific (the Signal bot's `/quit #N` ends any label through
 * it), so a teardown running there says nothing about whether anyone will
 * emit `session.ended`. When the helper finds such a teardown it joins it
 * (`end()` is memoized per label, so the session is still closed once) and
 * then performs the web-side steps itself.
 *
 * PTY sessions (`web-pty`) are not managed sessions; `PtySessionManager`
 * owns their lifecycle and emits `session.ended` from its exit handler.
 */

import type { DispatchContext } from './dispatch/types.js';
import type { ManagedSession } from '../session/session-manager.js';
import { getTokenStreamBus } from '../docker/token-stream-bus.js';

/** The slice of the dispatch context the teardown needs. */
export type WebSessionTeardownContext = Pick<DispatchContext, 'sessionManager' | 'eventBus' | 'sessionQueues'>;

/**
 * Helper teardowns in flight, by managed-session entry. Labels are never
 * reused and each entry object is unique to one registration, so the key
 * cannot collide; the WeakMap lets finished entries be collected.
 */
const teardownsInFlight = new WeakMap<ManagedSession, Promise<void>>();

/**
 * Ends a managed web session through the full teardown sequence:
 * `SessionManager.end()` (transport close, run() drain, session close, map
 * removal), token-stream bus cleanup, the per-label send queue, an
 * `escalation.expired` for each still-pending escalation, and finally
 * `session.ended`, emitted last so that a client listing sessions on receipt
 * never sees the ended session (the ordering contract on
 * `WebEventMap['session.ended']`).
 *
 * A no-op for an unknown label (already ended, or never a managed session).
 * When this helper is already tearing the session down, the call returns
 * that same teardown (resolving once `session.ended` has been emitted)
 * without repeating any side effect.
 */
export function endManagedSession(ctx: WebSessionTeardownContext, label: number, reason: string): Promise<void> {
  const managed = ctx.sessionManager.get(label);
  if (!managed) return Promise.resolve();

  const inFlight = teardownsInFlight.get(managed);
  if (inFlight) return inFlight;

  // Registered synchronously, before any microtask runs, so a re-entrant call
  // (the transport's run() settling once end() closes it) joins this one.
  const teardown = runTeardown(ctx, label, managed, reason);
  teardownsInFlight.set(managed, teardown);
  return teardown;
}

async function runTeardown(
  ctx: WebSessionTeardownContext,
  label: number,
  managed: ManagedSession,
  reason: string,
): Promise<void> {
  const sessionId = managed.session.getInfo().id;
  // Starts the teardown, or joins one already running in SessionManager.
  await ctx.sessionManager.end(label);
  getTokenStreamBus().endSession(sessionId);
  ctx.sessionQueues.delete(label);

  // Escalations still pending when the session goes away can never be
  // answered; tell consumers so cards and badges do not linger.
  for (const escalationId of managed.pendingEscalations.keys()) {
    ctx.eventBus.emit('escalation.expired', { escalationId, sessionLabel: label });
  }
  ctx.eventBus.emit('session.ended', { label, reason });
}
