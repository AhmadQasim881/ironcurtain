/**
 * Gate binding: the rules that tie a human-gate decision to one specific
 * raise of one specific gate.
 *
 * A workflow can visit the same `human_gate` state several times (every
 * `FORCE_REVISION` loops back and re-raises it), and several deciders can be
 * attached at once (a browser tab, the agent-driven `workflow gate` CLI, a
 * second tab). A decision therefore has to say *which* raise it reviewed.
 * This module owns the two halves of that contract:
 *
 * - `mintGateId` produces the per-raise id the orchestrator hands out in
 *   `HumanGateRequest.gateId`. Unique per raise and unguessable.
 *   `isGateIdFor` recognises an id minted for a given gate, so a resumed run
 *   only restores a checkpointed id that belongs to the gate it resumes at.
 * - `assertGateResolutionAllowed` is the single check every entry point
 *   (JSON-RPC, CLI, in-process) funnels through before the orchestrator
 *   dismisses the gate: the decision must name the active raise, the event
 *   must be one the gate's definition transitions on, and feedback events
 *   must carry feedback. It throws `GateResolutionError` and mutates nothing,
 *   so a refused decision leaves the run waiting with the same gate id and
 *   logs no `gate_resolved` entry. `acceptedGateEvents` is the event set that
 *   check accepts, which is also the set a gate request advertises.
 *
 * Leaf module: imports only types, `./errors.js` and `node:crypto`, so the
 * orchestrator, the dispatch layer and tests can share it without a runtime
 * cycle.
 */

import { randomBytes } from 'node:crypto';
import { GateResolutionError } from './errors.js';
import type { GateResolutionChannel, HumanGateEvent, HumanGateEventType, HumanGateStateDefinition } from './types.js';

/** Channels a JSON-RPC client may declare; `rpc` is the orchestrator-side default for undeclared callers. */
export const DECLARABLE_GATE_RESOLUTION_CHANNELS = ['web-ui', 'cli', 'signal'] as const satisfies readonly Exclude<
  GateResolutionChannel,
  'rpc'
>[];

/** Bytes of randomness in a gate id suffix (16 hex chars). */
const GATE_ID_NONCE_BYTES = 8;

/**
 * Mints the id for one raise of `gateName` in `workflowId`.
 *
 * `visit` is the 1-based count of entries into the gate state so far; it is
 * cosmetic (it lets a human or agent read "second time at `review`" off the
 * id). The random suffix is what makes the id unique per raise and
 * unguessable, so a stale or fabricated id never matches.
 */
export function mintGateId(workflowId: string, gateName: string, visit: number): string {
  const ordinal = Number.isInteger(visit) && visit > 0 ? visit : 1;
  return `${workflowId}-${gateName}-${ordinal}-${randomBytes(GATE_ID_NONCE_BYTES).toString('hex')}`;
}

/** `<visit>-<random suffix>`: what follows `<workflowId>-<gateName>-` in a minted id. */
const GATE_ID_TAIL = new RegExp(`^[1-9][0-9]*-[0-9a-f]{${GATE_ID_NONCE_BYTES * 2}}$`);

/**
 * True when `gateId` has the exact shape `mintGateId` produces for
 * `gateName` in `workflowId`. State ids cannot contain `-` (see
 * `STATE_ID_PATTERN` in `validate.ts`), so the prefix pins the gate and an id
 * minted for another gate, another run or by an older format never passes.
 * Used when restoring a checkpointed id: anything else is discarded and the
 * gate gets a fresh raise id instead.
 */
export function isGateIdFor(gateId: unknown, workflowId: string, gateName: string): gateId is string {
  if (typeof gateId !== 'string') return false;
  const prefix = `${workflowId}-${gateName}-`;
  return gateId.startsWith(prefix) && GATE_ID_TAIL.test(gateId.slice(prefix.length));
}

/** What `assertGateResolutionAllowed` needs to know about the workflow's current position. */
export interface GateResolutionTarget {
  readonly workflowId: string;
  /** Id of the raise currently up, or `undefined` when the workflow is not waiting at a gate. */
  readonly activeGateId: string | undefined;
  /** Definition of the state the machine is in, when that state is a human gate. */
  readonly gate: HumanGateStateDefinition | undefined;
}

/**
 * Events a decision may carry for this gate: the declared `acceptedEvents`
 * (in declared order, without duplicates) that also have a transition.
 * `acceptedEvents` is what deciders are offered; the `transitions` list is
 * what the machine compiles (`machine-builder.ts` builds one `HUMAN_<event>`
 * handler per transition). An event has to appear in both: XState silently
 * drops an event with no handler, which would strand the run at a dismissed
 * gate. `validate.ts` already rejects a transition whose event is not
 * declared; a declared event without a transition is the case this filters.
 *
 * The orchestrator advertises exactly this list in
 * `HumanGateRequest.acceptedEvents`, so the web UI buttons, the interactive
 * CLI menu and the agent-driven decider are only offered events the gate
 * will accept.
 */
export function acceptedGateEvents(gate: HumanGateStateDefinition): readonly HumanGateEventType[] {
  const routed = new Set<HumanGateEventType>(gate.transitions.map((t) => t.event));
  return [...new Set(gate.acceptedEvents)].filter((event) => routed.has(event));
}

/**
 * Validates `event` against the gate currently up for the workflow. Throws
 * `GateResolutionError` (codes documented on `GateResolutionErrorCode`) and
 * returns normally only when the decision may be applied.
 */
export function assertGateResolutionAllowed(target: GateResolutionTarget, event: HumanGateEvent): void {
  const { workflowId, activeGateId, gate } = target;

  if (activeGateId === undefined || gate === undefined) {
    throw new GateResolutionError('WORKFLOW_NOT_AT_GATE', `Workflow ${workflowId} is not waiting at a gate`);
  }

  // Strict equality also rejects a missing id from an untyped caller. The
  // message deliberately does not name the active id: the decider has to
  // re-read the gate (status / await / the web UI), which shows what is
  // waiting now, instead of retrying blind with an id it never reviewed.
  if (event.gateId !== activeGateId) {
    throw new GateResolutionError(
      'GATE_MISMATCH',
      `Gate ${event.gateId} is not the active gate of workflow ${workflowId}; ` +
        're-read the gate and review what is waiting now before deciding against its current id',
    );
  }

  const accepted = acceptedGateEvents(gate);
  if (!accepted.includes(event.type)) {
    throw new GateResolutionError(
      'EVENT_NOT_ACCEPTED',
      `Gate ${activeGateId} does not accept ${event.type}; accepted events: ${accepted.join(', ')}`,
    );
  }

  // FORCE_REVISION and REPLAN loop back to an earlier state with the
  // feedback injected into the next agent's prompt (via context.humanPrompt).
  // Without feedback the agent has no signal for what to change and the
  // re-entry prompt ("Revise it to address the human feedback above")
  // references content that does not exist.
  if ((event.type === 'FORCE_REVISION' || event.type === 'REPLAN') && (event.prompt ?? '').trim().length === 0) {
    throw new GateResolutionError('FEEDBACK_REQUIRED', `Feedback is required for ${event.type} events`);
  }
}
