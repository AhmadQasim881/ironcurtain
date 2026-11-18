/**
 * Escalation-related JSON-RPC method dispatch.
 *
 * Handles all `escalations.*` methods: list, resolve, approveGroup.
 *
 * `escalations.approveGroup` approves the members of one whitelist-pattern
 * group (escalation/escalation-groups.ts) that the UI listed for
 * confirmation. It is refused, with nothing resolved, unless the ids sent are
 * exactly the escalations pending in that group now: a member that arrived,
 * expired or was resolved since the list was shown means the user did not
 * review what would be approved. Each member is approved once; no pattern is
 * whitelisted. A human-only escalation is never in a group.
 */

import { z } from 'zod';

import { type DispatchContext, validateParams } from './types.js';
import {
  type EscalationDto,
  type EscalationGroupApprovalDto,
  type ErrorCode,
  RpcError,
  InvalidParamsError,
  MethodNotFoundError,
} from '../web-ui-types.js';
import { isCompleteEscalation } from '../../session/session-manager.js';
import { assertEscalationReviewable, escalationForWire } from '../escalation-wire.js';

// ---------------------------------------------------------------------------
// Param validation schemas
// ---------------------------------------------------------------------------

const escalationResolveSchema = z.object({
  escalationId: z.string().min(1),
  decision: z.enum(['approved', 'denied']),
  whitelistSelection: z.number().int().nonnegative().optional(),
});

/** Upper bound on one group approval; far above any realistic set of pending escalations. */
const MAX_GROUP_APPROVAL_SIZE = 200;

const escalationApproveGroupSchema = z.object({
  groupKey: z.string().min(1),
  escalationIds: z.array(z.string().min(1)).min(1).max(MAX_GROUP_APPROVAL_SIZE),
});

// ---------------------------------------------------------------------------
// Escalation dispatch
// ---------------------------------------------------------------------------

export async function escalationDispatch(
  ctx: DispatchContext,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (method) {
    case 'escalations.list':
      return listEscalations(ctx).map((item) => escalationForWire(item));
    case 'escalations.resolve': {
      const validated = validateParams(escalationResolveSchema, params);
      const options =
        validated.whitelistSelection != null ? { whitelistSelection: validated.whitelistSelection } : undefined;
      await resolveEscalation(ctx, validated.escalationId, validated.decision, options);
      return;
    }
    case 'escalations.approveGroup': {
      const validated = validateParams(escalationApproveGroupSchema, params);
      return approveGroup(ctx, validated.groupKey, validated.escalationIds);
    }
    default:
      throw new MethodNotFoundError(method);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolves one pending escalation, wherever it lives. Throws an `RpcError`
 * when it cannot be resolved (not found, expired, busy).
 */
async function resolveEscalation(
  ctx: DispatchContext,
  escalationId: string,
  decision: 'approved' | 'denied',
  options: { whitelistSelection?: number } | undefined,
): Promise<void> {
  // PTY sessions own their escalations outside SessionManager; route to the
  // PTY manager (writes the response file + emits escalation.resolved). A
  // response that arrives after the proxy already timed the request out is
  // surfaced as ESCALATION_EXPIRED (the manager emits escalation.expired),
  // never as a success for a tool call that was in fact denied.
  if (ctx.ptySessionManager?.hasEscalation(escalationId)) {
    ctx.ptySessionManager.resolveEscalation(escalationId, decision, options);
    return;
  }

  // Workflow tool-call escalations live on the orchestrator (keyed by
  // workflow, announced as `workflow.escalation_raised`). The id is a
  // coordinator UUID, so resolving by id alone is unambiguous.
  const workflowPending = ctx.workflowManager?.findToolCallEscalation(escalationId);
  if (workflowPending && ctx.workflowManager) {
    if (decision === 'approved') assertEscalationReviewable(workflowPending.escalation);
    const resolved = ctx.workflowManager.resolveToolCallEscalation(escalationId, {
      decision,
      ...(options ?? {}),
    });
    if (!resolved) {
      throw new RpcError('ESCALATION_NOT_FOUND', `Escalation ${escalationId} is no longer pending`);
    }
    return;
  }

  const owner = ctx.sessionManager.findByEscalation(escalationId);
  const pending = owner?.pendingEscalations.get(escalationId);
  if (decision === 'approved' && pending) {
    assertEscalationReviewable({ ...pending, sessionSource: owner?.source });
  }
  // Never approve a request that does not say what would be approved (the
  // card disables Approve for one too); it can still be denied. A group
  // member like that is reported in `failed`.
  if (decision === 'approved' && pending && !isCompleteEscalation(pending)) {
    throw new InvalidParamsError(
      `Escalation ${escalationId} does not name its tool or arguments, so it can only be denied`,
    );
  }
  const result = await ctx.sessionManager.resolveSessionEscalation(escalationId, decision, options);
  if (!result.resolved) {
    // A response written after the proxy's timeout was too late: the
    // call was denied. Announce the expiry (so every client drops the
    // card) and report it as ESCALATION_EXPIRED, never as a success.
    // The SessionManager already announced it for cron and Signal
    // sessions (see WebUiServer.bridgeSessionEscalation); a web
    // session's is announced here.
    if (result.reason === 'expired') {
      if (owner?.source.kind === 'web') {
        ctx.eventBus.emit('escalation.expired', { escalationId, sessionLabel: owner.label });
      }
      throw new RpcError(
        'ESCALATION_EXPIRED',
        `Escalation ${escalationId} expired before the response arrived; the tool call was denied`,
      );
    }
    throw new RpcError(
      result.reason === 'already_resolving' ? 'SESSION_BUSY' : 'ESCALATION_NOT_FOUND',
      result.reason ?? 'Failed to resolve escalation',
    );
  }
}

/**
 * Approves exactly the reviewed members of group `groupKey` (see the module
 * comment). The set check runs before anything is resolved; a member that
 * then fails on its own (it expired in the meantime) is reported in
 * `failed` and does not stop the others.
 */
async function approveGroup(
  ctx: DispatchContext,
  groupKey: string,
  escalationIds: readonly string[],
): Promise<EscalationGroupApprovalDto> {
  const reviewed = new Set(escalationIds);
  if (reviewed.size !== escalationIds.length) {
    throw new InvalidParamsError('escalationIds must not repeat an escalation');
  }
  const members = listEscalations(ctx).filter((esc) => esc.groupKey === groupKey);
  if (members.length === 0) {
    throw new RpcError('ESCALATION_GROUP_CHANGED', 'No escalation of that group is pending any more');
  }
  if (members.length !== reviewed.size || !members.every((esc) => reviewed.has(esc.escalationId))) {
    throw new RpcError(
      'ESCALATION_GROUP_CHANGED',
      "The group's escalations changed since they were listed; nothing was approved. Review the group again.",
    );
  }
  // Refuse the whole group before any member is resolved: a deny-only view
  // must not disappear from the original group's membership comparison.
  for (const member of members) assertEscalationReviewable(member);

  const approved: string[] = [];
  const failed: { escalationId: string; code: ErrorCode; message: string }[] = [];
  for (const esc of members) {
    try {
      await resolveEscalation(ctx, esc.escalationId, 'approved', undefined);
      approved.push(esc.escalationId);
    } catch (err) {
      failed.push({
        escalationId: esc.escalationId,
        code: err instanceof RpcError ? err.code : 'INTERNAL_ERROR',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { approved, failed };
}

function listEscalations(ctx: DispatchContext): EscalationDto[] {
  // Every pending escalation of every session: a session can have several.
  const turnBased = ctx.sessionManager
    .allPendingEscalations()
    .map(({ managed, escalation }) => ({ ...escalation, sessionSource: managed.source }));
  const pty = ctx.ptySessionManager?.listPendingEscalationDtos() ?? [];
  return [...turnBased, ...pty];
}
