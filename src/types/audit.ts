import type { PolicyDecision } from './mcp.js';
import type { TaintEvent } from './taint.js';

/**
 * `result.status` of the write-ahead record the security pipeline appends
 * immediately before an allowed call first acts on its backend: before it
 * forwards the call (or runs a virtual proxy tool), or, for an approved
 * escalation that needs a new root, before the roots update. The outcome
 * record for the same `requestId` follows once the call settles (`denied`
 * when roots verification fails). A `dispatching` record with no outcome record
 * means the process died (or the audit log failed) while the call was in
 * flight -- the side effect may or may not have happened. See
 * `AuditLog` in `src/trusted-process/audit-log.ts`.
 */
export const AUDIT_STATUS_DISPATCHING = 'dispatching';

/**
 * Sequence-aware (taint) policy facts about one call. Recorded only while
 * taint escalation is enabled (`taintEscalation.enabled`); see
 * `trusted-process/taint-policy.ts`.
 */
export interface AuditTaintFacts {
  /**
   * The call is a taint source and was dispatched: its result may carry
   * content other people wrote, so the session is tainted from its
   * write-ahead record on. Set on that record and on the call's outcome.
   * Replayed when a coordinator is built on an existing audit log (resume).
   */
  readonly source?: true;
  /**
   * The call is a taint sink and the session was tainted when policy
   * evaluated it, so only a human could approve it (no whitelist, no
   * auto-approver).
   */
  readonly sink?: true;
  /** Sink records: what first tainted the session. */
  readonly taintedBy?: TaintEvent;
}

/** One thing the outbound content assessment found in an assessed argument. */
export interface ContentAssessmentFinding {
  /** Name of the assessed argument (from the tool annotation, never agent-chosen). */
  readonly argument: string;
  /**
   * The check that fired: a deterministic detector (`base64`, `hex`,
   * `byte-sequence`, `high-entropy`, `rot-n`, `hidden-characters`, `size`,
   * `encoded-ratio`), the optional `llm` intelligibility check, or `error`
   * when the assessment itself failed.
   */
  readonly check: string;
  /** Fixed-phrase description with counts and sizes; never the content itself. */
  readonly detail: string;
}

/**
 * The outbound content assessment of one call (see
 * src/trusted-process/assessment.ts), as recorded on its audit entries.
 * `pass`: every assessed value passed the enabled checks. `flagged`: a check
 * found encoded, hidden or unintelligible content. `error`: the assessment
 * could not complete. `flagged` and `error` both escalate the call to a human.
 */
export interface ContentAssessmentRecord {
  readonly verdict: 'pass' | 'flagged' | 'error';
  /** The checks that ran: the deterministic detectors, plus `llm` when the intelligibility check ran. */
  readonly checks: readonly ('deterministic' | 'llm')[];
  readonly findings: readonly ContentAssessmentFinding[];
  /** The arguments that were assessed. */
  readonly arguments: readonly string[];
  /**
   * Keyed digest (HMAC-SHA256 with a random per-session key) of the
   * assessed values and settings: the verdict cache key. Equal digests mean
   * the same content within one session; the digest reveals nothing about
   * the content itself.
   */
  readonly digest: string;
  /** True when the verdict was served from the session's verdict cache. */
  readonly cached?: true;
}

/**
 * `policyDecision.reason` of an escalated call a human denied. Readers that
 * tell a human denial apart from the other `escalationResult: 'denied'`
 * outcomes (no escalation handler, a failed wait) compare against it.
 */
export const HUMAN_DENIAL_REASON = 'Denied by human during escalation';

/** `policyDecision.reason` of an escalated call a human approved. */
export const HUMAN_APPROVAL_REASON = 'Approved by human during escalation';

/**
 * Prefix of the interim `error` outcome the pipeline appends before it
 * retries a call that lost the roots-expansion race. The call's real
 * outcome record (same `requestId`) follows it.
 */
export const ROOTS_RACE_RETRY_ERROR_PREFIX = 'Roots race detected, retrying:';

export interface AuditEntry {
  timestamp: string;
  requestId: string;
  serverName: string;
  toolName: string;
  arguments: Record<string, unknown>;
  policyDecision: PolicyDecision;
  /**
   * How an escalated call was settled. `approved` / `denied` record a
   * decision (human, auto-approver or whitelist). `timed-out` records that
   * nobody decided before the configured escalation timeout (`denied` is
   * no longer written for that case), and `cancelled` that the wait was
   * withdrawn: by the coordinator (session teardown, workflow policy swap)
   * or by the in-process handler (the workflow turn that raised it ended,
   * or the run was aborted). Neither of the last two is a human denial;
   * all three of `denied`, `timed-out` and `cancelled` deny the call.
   */
  escalationResult?: 'approved' | 'denied' | 'timed-out' | 'cancelled';
  result: {
    /**
     * Outcome of the call. `dispatching` marks the write-ahead record
     * appended before a dispatch (see `AUDIT_STATUS_DISPATCHING`); every
     * other value is an outcome. Consumers that want one record per call
     * filter with `isDispatchingAuditEntry`.
     */
    status: 'success' | 'denied' | 'error' | typeof AUDIT_STATUS_DISPATCHING;
    content?: unknown;
    error?: string;
  };
  durationMs: number;
  /**
   * OS-level sandbox status of the MCP server process. `true`: it runs
   * inside an OS sandbox. `false`: it asked for one but runs without it
   * (sandbox-runtime unavailable and `sandboxPolicy` is "warn"). Absent:
   * the server opted out (`"sandbox": false`) or the status is unknown.
   */
  sandboxed?: boolean;
  /**
   * When true, the escalation was approved by the auto-approver
   * rather than a human. Only present when escalationResult is 'approved'.
   */
  autoApproved?: boolean;

  /**
   * When true, the escalation was bypassed because a whitelist
   * pattern matched. The whitelistPatternId links to the original
   * approval that created the pattern.
   */
  whitelistApproved?: boolean;

  /**
   * ID of the whitelist pattern that matched, linking back to the
   * original escalation approval. Only present when whitelistApproved is true.
   */
  whitelistPatternId?: string;

  /**
   * Persona under which the tool call was evaluated. Set by the
   * `ToolCallCoordinator` from its `currentPersona` field (updated
   * inside `loadPolicy`). Absent for single-session modes (CLI, daemon,
   * cron) that never call `loadPolicy`. In workflow runs every audit
   * entry carries a persona because `loadPolicy` is invoked before the
   * first tool call of each agent-state entry.
   */
  persona?: string;

  /**
   * Taint facts (see {@link AuditTaintFacts}). Absent when taint escalation
   * is disabled, and on calls that are neither a dispatched source nor a
   * sink evaluated in a tainted session.
   */
  taint?: AuditTaintFacts;

  /**
   * The outbound content assessment of the call, when one ran: the opt-in
   * `contentAssessment` setting is on and the call was allowed subject to
   * the assessment, or escalated, with outbound-content arguments. Absent
   * otherwise.
   */
  contentAssessment?: ContentAssessmentRecord;
}

/**
 * True for the write-ahead `dispatching` record appended before a dispatch;
 * false for every outcome record (`success`, `denied`, `error`). Accepts
 * any parsed JSONL line so readers can filter before trusting the shape.
 */
export function isDispatchingAuditEntry(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const result = (entry as { result?: unknown }).result;
  if (typeof result !== 'object' || result === null) return false;
  return (result as { status?: unknown }).status === AUDIT_STATUS_DISPATCHING;
}
