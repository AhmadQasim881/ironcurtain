/**
 * Applying a snapshot of pending escalations without undoing newer events.
 *
 * The client learns about escalations from events (`escalation.created`,
 * `escalation.resolved`, `escalation.expired`, `workflow.escalation_*`) and
 * from snapshots it requests: `escalations.list` after every connect,
 * reconnect and `daemon.resync`, and the `escalations` of each
 * `workflows.get`. A snapshot shows the daemon's state at one moment between
 * sending the request and receiving the answer, so an escalation event that
 * arrives in that window may or may not be reflected in it. Overwriting the
 * client's state with the snapshot can therefore drop an escalation raised
 * meanwhile (it times out as a denial nobody saw) or bring back one that was
 * resolved meanwhile.
 *
 * The store records the escalation events of that window (`ESCALATION_EVENTS`)
 * and merges the answer with them the moment it arrives. An escalation an
 * event touched in the window is decided by the client's live state, which
 * has already applied every event; every other one is decided by the
 * snapshot, which replaces what the client held from before the request (and
 * so drops what it missed while disconnected). Events after the answer are
 * applied on top as usual. Pure functions, no Svelte.
 */

import type { EscalationDto, PendingEscalation, WorkflowEscalationDto } from './types.js';
import { parseEvent } from './event-handler.js';

/** A server-push event as the WebSocket client delivered it. */
export interface ReceivedEvent {
  readonly event: string;
  readonly payload: unknown;
}

/** The events that change which escalations are pending (see the module comment). */
export const ESCALATION_EVENTS: ReadonlySet<string> = new Set([
  'escalation.created',
  'escalation.resolved',
  'escalation.expired',
  // Drops the ended session's escalations (event-handler.ts).
  'session.ended',
  'workflow.escalation_raised',
  'workflow.escalation_resolved',
  // A workflow that reaches a terminal phase withdraws its escalations.
  'workflow.completed',
  'workflow.failed',
]);

/**
 * The pending session escalations after an `escalations.list` answer.
 * `current` is the client's live state, `listed` the answer and `events` the
 * escalation events received while it was requested. An escalation the client
 * already shows keeps its display number (a new one would re-open the modal
 * the user may have dismissed); one it has not seen gets `nextDisplayNumber()`.
 */
export function mergeEscalationSnapshot(
  current: ReadonlyMap<string, PendingEscalation>,
  listed: readonly EscalationDto[],
  events: readonly ReceivedEvent[],
  nextDisplayNumber: () => number,
): Map<string, PendingEscalation> {
  const raised = new Set<string>();
  const touched = new Set<string>();
  const endedSessions = new Set<number>();
  for (const { event, payload } of events) {
    const parsed = parseEvent(event, payload);
    if (!parsed) continue;
    switch (parsed.event) {
      case 'escalation.created':
        raised.add(parsed.payload.escalationId);
        touched.add(parsed.payload.escalationId);
        break;
      case 'escalation.resolved':
      case 'escalation.expired':
        touched.add(parsed.payload.escalationId);
        break;
      case 'session.ended':
        endedSessions.add(parsed.payload.label);
        break;
    }
  }

  const next = new Map<string, PendingEscalation>();
  for (const escalation of listed) {
    // The live state, which applied the event, decides.
    if (touched.has(escalation.escalationId)) continue;
    // Its session ended meanwhile, so it can no longer be answered.
    if (endedSessions.has(escalation.sessionLabel)) continue;
    const displayNumber = current.get(escalation.escalationId)?.displayNumber ?? nextDisplayNumber();
    next.set(escalation.escalationId, { ...escalation, displayNumber });
  }
  // Raised meanwhile and still pending: an event that ended it, or its
  // session, has already removed it from the live state.
  for (const [escalationId, escalation] of current) {
    if (raised.has(escalationId)) next.set(escalationId, escalation);
  }
  return next;
}

/**
 * The pending workflow tool-call escalations after a `workflows.get` answer
 * for `workflowId`: that workflow's entries are replaced by the ones the
 * detail lists (`listed`), merged with the events received while it was
 * requested; other workflows' entries are kept.
 */
export function mergeWorkflowEscalationSnapshot(
  current: ReadonlyMap<string, WorkflowEscalationDto>,
  workflowId: string,
  listed: readonly WorkflowEscalationDto[],
  events: readonly ReceivedEvent[],
): Map<string, WorkflowEscalationDto> {
  const raised = new Set<string>();
  const touched = new Set<string>();
  let finished = false;
  for (const { event, payload } of events) {
    const parsed = parseEvent(event, payload);
    if (!parsed) continue;
    switch (parsed.event) {
      case 'workflow.escalation_raised':
        if (parsed.payload.workflowId !== workflowId) break;
        raised.add(parsed.payload.escalation.escalationId);
        touched.add(parsed.payload.escalation.escalationId);
        break;
      case 'workflow.escalation_resolved':
        if (parsed.payload.workflowId === workflowId) touched.add(parsed.payload.escalationId);
        break;
      case 'workflow.completed':
        if (parsed.payload.workflowId === workflowId) finished = true;
        break;
      case 'workflow.failed':
        // Only a failure that carries a terminal phase ends the run (event-handler.ts).
        if (parsed.payload.workflowId === workflowId && parsed.payload.phase !== undefined) finished = true;
        break;
    }
  }

  const next = new Map<string, WorkflowEscalationDto>();
  for (const [escalationId, escalation] of current) {
    if (escalation.workflowId !== workflowId || raised.has(escalationId)) next.set(escalationId, escalation);
  }
  // A run that finished meanwhile has nothing pending; the event already
  // removed what the client held for it.
  if (finished) return next;
  for (const escalation of listed) {
    if (!touched.has(escalation.escalationId)) next.set(escalation.escalationId, escalation);
  }
  return next;
}
