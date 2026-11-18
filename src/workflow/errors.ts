import type { AgentConversationId } from '../session/types.js';
import { describeTransientFailureKind, type TransientFailureKind } from '../docker/agent-adapter.js';

/**
 * Wraps an error thrown from within `executeAgentState()` so the XState
 * error handler can recover the `agentConversationId` that was minted for
 * the failing invocation and persist it into `context.agentConversationsByState`.
 *
 * Without this, states that error mid-invocation drop their conversation
 * id on the floor — the `onDone` path stamps the id into context, but
 * `onError` used to record only `lastError`. For states configured with
 * `freshSession: false`, that silently broke resume on the next visit.
 */
export interface AgentInvocationErrorOptions {
  readonly stateId: string;
  readonly agentConversationId: AgentConversationId;
  readonly cause: unknown;
}

export class AgentInvocationError extends Error {
  readonly stateId: string;
  readonly agentConversationId: AgentConversationId;
  override readonly cause: unknown;

  constructor(options: AgentInvocationErrorOptions) {
    const message = options.cause instanceof Error ? options.cause.message : String(options.cause);
    super(message);
    this.name = 'AgentInvocationError';
    this.stateId = options.stateId;
    this.agentConversationId = options.agentConversationId;
    this.cause = options.cause;
  }
}

export function isAgentInvocationError(err: unknown): err is AgentInvocationError {
  return err instanceof AgentInvocationError;
}

/**
 * Thrown when the agent adapter reports upstream quota exhaustion for a
 * state's turn. Distinct from a generic `Error` so M4's paused-phase
 * handling (follow-up work) can intercept it cleanly and drive a
 * `paused` terminal instead of the current `aborted` terminal.
 *
 * `resetAt` is the provider-advertised reset time when the adapter
 * could parse one; `rawMessage` is the original provider/CLI text.
 */
export interface WorkflowQuotaExhaustedOptions {
  readonly stateId: string;
  readonly resetAt?: Date;
  readonly rawMessage: string;
}

export class WorkflowQuotaExhaustedError extends Error {
  readonly stateId: string;
  readonly resetAt?: Date;
  readonly rawMessage: string;

  constructor(options: WorkflowQuotaExhaustedOptions) {
    const resetHint = options.resetAt ? ` (resets at ${options.resetAt.toISOString()})` : '';
    super(`Agent turn aborted: upstream quota exhausted${resetHint}`);
    this.name = 'WorkflowQuotaExhaustedError';
    this.stateId = options.stateId;
    this.resetAt = options.resetAt;
    this.rawMessage = options.rawMessage;
  }
}

export function isWorkflowQuotaExhaustedError(err: unknown): err is WorkflowQuotaExhaustedError {
  return err instanceof WorkflowQuotaExhaustedError;
}

/**
 * Thrown when the agent adapter reports a transient upstream failure
 * (see `AgentResponse.transientFailure`). Sibling of
 * `WorkflowQuotaExhaustedError`: both signal terminal-but-resumable
 * conditions. Consumers MUST NOT remove the on-disk checkpoint; the
 * orchestrator forces `phase: 'aborted'` so `isCheckpointResumable`
 * returns true regardless of which terminal `findErrorTarget` resolved
 * to.
 */
export interface WorkflowTransientFailureOptions {
  readonly stateId: string;
  readonly kind: TransientFailureKind;
  readonly rawMessage: string;
}

export class WorkflowTransientFailureError extends Error {
  readonly stateId: string;
  readonly kind: TransientFailureKind;
  readonly rawMessage: string;

  constructor(options: WorkflowTransientFailureOptions) {
    super(`Agent turn aborted: transient upstream failure — ${describeTransientFailureKind(options.kind)}`);
    this.name = 'WorkflowTransientFailureError';
    this.stateId = options.stateId;
    this.kind = options.kind;
    this.rawMessage = options.rawMessage;
  }
}

export function isWorkflowTransientFailureError(err: unknown): err is WorkflowTransientFailureError {
  return err instanceof WorkflowTransientFailureError;
}

export interface WorkflowBudgetExhaustedOptions {
  /** The state (or fan-out lane step) that was about to start. */
  readonly stateId: string;
  /** The `settings.workflowBudget` field that was reached. */
  readonly limitField: string;
  readonly used: number;
  readonly limit: number;
  /** Human-readable description of the breach. */
  readonly detail: string;
}

/**
 * Thrown instead of starting a state (or a fan-out lane step) once the run
 * has used up its `settings.workflowBudget`. Like quota exhaustion it ends
 * the run in a resumable `aborted` terminal: the checkpoint is kept, so the
 * run can continue once the limit is raised. `code` is the discriminant for
 * callers in other modules.
 */
export class WorkflowBudgetExhaustedError extends Error {
  readonly code = 'WORKFLOW_BUDGET_EXHAUSTED' as const;
  readonly stateId: string;
  readonly limitField: string;
  readonly used: number;
  readonly limit: number;

  constructor(options: WorkflowBudgetExhaustedOptions) {
    super(
      `Workflow budget exhausted before "${options.stateId}": ${options.detail} ` +
        `(settings.workflowBudget.${options.limitField})`,
    );
    this.name = 'WorkflowBudgetExhaustedError';
    this.stateId = options.stateId;
    this.limitField = options.limitField;
    this.used = options.used;
    this.limit = options.limit;
  }
}

export function isWorkflowBudgetExhaustedError(err: unknown): err is WorkflowBudgetExhaustedError {
  if (err instanceof WorkflowBudgetExhaustedError) return true;
  return err !== null && typeof err === 'object' && 'code' in err && err.code === 'WORKFLOW_BUDGET_EXHAUSTED';
}

/**
 * True when `err` is — or, when wrapped in an `AgentInvocationError`,
 * carries as its `cause` — one of the resumable stops: the two upstream
 * failures (`WorkflowQuotaExhaustedError`, `WorkflowTransientFailureError`)
 * or the run reaching its spend ceiling (`WorkflowBudgetExhaustedError`).
 *
 * The machine builder's `__isResumableStop` guard uses this to route such a
 * rejection straight to an abort-preserving terminal instead of the state's
 * regular error target. A human gate there would let the run continue past
 * the failed turn while the orchestrator's stamp is still set, so a later
 * normal completion would be misreported as `aborted` (stale-flag bug), a
 * human could APPROVE past a turn that never ran, and a budget stop could be
 * waved through without raising the limit.
 */
export function isResumableWorkflowStop(err: unknown): boolean {
  const cause = isAgentInvocationError(err) ? err.cause : err;
  return (
    isWorkflowQuotaExhaustedError(cause) ||
    isWorkflowTransientFailureError(cause) ||
    isWorkflowBudgetExhaustedError(cause)
  );
}

/**
 * Stable failure reasons for attempts to resume (or import) a workflow.
 *
 * - `WORKFLOW_CHECKPOINT_TOO_NEW`: the checkpoint or run definition copy was
 *   written by a newer IronCurtain whose format this one cannot read safely.
 * - `WORKFLOW_WORKSPACE_MISSING`: the workspace the run recorded no longer
 *   exists (resume never recreates it empty).
 * - `WORKFLOW_IMPORT_UNTRUSTED`: an imported run's definition runs commands on
 *   the host and the caller did not pass `--trust` (RPC `trust: true`).
 * - `WORKFLOW_INVALID_ID`: the id is not a single safe path segment.
 * - `WORKFLOW_INVALID_BASE_DIR`: a directory given as a base directory of
 *   runs is itself a run directory.
 */
export type WorkflowResumeErrorCode =
  | 'WORKFLOW_ALREADY_ACTIVE'
  | 'WORKFLOW_CHECKPOINT_NOT_FOUND'
  | 'WORKFLOW_CHECKPOINT_CORRUPTED'
  | 'WORKFLOW_CHECKPOINT_TOO_NEW'
  | 'WORKFLOW_NOT_RESUMABLE'
  | 'WORKFLOW_WORKSPACE_MISSING'
  | 'WORKFLOW_IMPORT_UNTRUSTED'
  | 'WORKFLOW_INVALID_ID'
  | 'WORKFLOW_INVALID_BASE_DIR';

const WORKFLOW_RESUME_ERROR_CODES: ReadonlySet<string> = new Set<WorkflowResumeErrorCode>([
  'WORKFLOW_ALREADY_ACTIVE',
  'WORKFLOW_CHECKPOINT_NOT_FOUND',
  'WORKFLOW_CHECKPOINT_CORRUPTED',
  'WORKFLOW_CHECKPOINT_TOO_NEW',
  'WORKFLOW_NOT_RESUMABLE',
  'WORKFLOW_WORKSPACE_MISSING',
  'WORKFLOW_IMPORT_UNTRUSTED',
  'WORKFLOW_INVALID_ID',
  'WORKFLOW_INVALID_BASE_DIR',
]);

/**
 * Domain error raised before a resume mutates orchestrator state. The `code`
 * discriminant lets RPC callers preserve a useful error without depending on
 * `instanceof` across module boundaries.
 */
export class WorkflowResumeError extends Error {
  constructor(
    readonly code: WorkflowResumeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowResumeError';
  }
}

export function isWorkflowResumeError(err: unknown): err is WorkflowResumeError {
  if (err instanceof WorkflowResumeError) return true;
  if (err === null || typeof err !== 'object' || !('code' in err)) return false;
  return typeof err.code === 'string' && WORKFLOW_RESUME_ERROR_CODES.has(err.code);
}

/**
 * Stable reasons a gate decision is refused. Checked in this order, so a
 * stale decision reports the actionable `GATE_MISMATCH` even when it is also
 * malformed:
 *
 * - `WORKFLOW_NOT_FOUND`: no such workflow is loaded.
 * - `WORKFLOW_NOT_AT_GATE`: the workflow has no active gate (already
 *   resolved, running, or terminal).
 * - `GATE_MISMATCH`: the decision names a gate id other than the active
 *   raise (an earlier visit of the same gate, another gate, or a guess).
 * - `EVENT_NOT_ACCEPTED`: the gate's definition has no transition for the
 *   event.
 * - `FEEDBACK_REQUIRED`: `FORCE_REVISION` / `REPLAN` without non-empty
 *   feedback.
 */
export type GateResolutionErrorCode =
  'WORKFLOW_NOT_FOUND' | 'WORKFLOW_NOT_AT_GATE' | 'GATE_MISMATCH' | 'EVENT_NOT_ACCEPTED' | 'FEEDBACK_REQUIRED';

const GATE_RESOLUTION_ERROR_CODES: ReadonlySet<string> = new Set<GateResolutionErrorCode>([
  'WORKFLOW_NOT_FOUND',
  'WORKFLOW_NOT_AT_GATE',
  'GATE_MISMATCH',
  'EVENT_NOT_ACCEPTED',
  'FEEDBACK_REQUIRED',
]);

/**
 * Domain error raised by `resolveGate` before anything is mutated: the gate
 * stays up, nothing is logged and no event reaches the machine. The `code`
 * discriminant lets RPC and CLI callers map the refusal without `instanceof`
 * across module boundaries.
 */
export class GateResolutionError extends Error {
  constructor(
    readonly code: GateResolutionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GateResolutionError';
  }
}

export function isGateResolutionError(err: unknown): err is GateResolutionError {
  if (err instanceof GateResolutionError) return true;
  if (err === null || typeof err !== 'object' || !('code' in err)) return false;
  return typeof err.code === 'string' && GATE_RESOLUTION_ERROR_CODES.has(err.code);
}
