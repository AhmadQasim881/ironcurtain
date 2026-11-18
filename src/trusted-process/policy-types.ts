import type { PolicyDecisionStatus } from '../types/mcp.js';
import type { ArgumentRole } from '../types/argument-roles.js';
import type { CompiledPolicyFile, DynamicListsFile } from '../pipeline/types.js';

/** Trusted coordinator state, never copied from agent-supplied tool arguments. */
export interface PolicyEvaluationContext {
  readonly gitWorkingDirectory?: string;
}

/**
 * A task scope (`--task-scoped`): a policy compiled from the session's task
 * text that the engine intersects with the session policy. A call is
 * allowed only when both allow it; a call no task-scope rule covers
 * escalates (rule `task-scope-escalate`) instead of being denied; otherwise
 * the most restrictive decision wins (deny > escalate > allow). See
 * `PolicyEngine` and `src/config/task-scope-policy.ts`.
 */
export interface TaskScopePolicy {
  readonly compiledPolicy: CompiledPolicyFile;
  readonly dynamicLists?: DynamicListsFile;
}

export interface EvaluationResult {
  decision: PolicyDecisionStatus;
  rule: string;
  reason: string;
  /**
   * When decision is 'escalate', every role whose independent evaluation
   * produced an escalation. Every other resource role of the call was
   * allowed (sandbox containment or a compiled allow). The approval
   * whitelist builds a pattern's constraints from these roles and matches a
   * later call only when its pattern constrains every one of that call's
   * escalated roles; roots expansion adds roots only for these roles' paths.
   *
   * Populated by:
   * - evaluateCompiledRules(): roles whose per-role evaluation was 'escalate'.
   * - the task scope (when the session has one): roles the task policy did
   *   not allow (no task rule covers them, or a task rule escalates them),
   *   joined with the roles the session policy escalated for the same call.
   * - the structural escalations: the URL roles that reached an off-allowlist
   *   or unverifiable destination (structural-domain-escalate), the write or
   *   delete roles of a path inside `.git` (structural-git-internals-escalate),
   *   the path roles of an untrusted repository
   *   (structural-git-repository-escalate) and the roles of an argument
   *   holding a nested object or array (structural-nested-argument-escalate),
   *   joined with each other and with the roles the compiled rules escalated
   *   for the same call. A structural escalation does not skip any role: a
   *   compiled deny replaces it.
   *
   * Undefined for non-escalate decisions, and when the escalated roles are
   * unknown; consumers then fall back to their most restrictive behaviour
   * (the whitelist requires every resource role to be constrained, roots
   * expansion adds no root).
   */
  escalatedRoles?: readonly ArgumentRole[];
  /**
   * When decision is 'escalate': the escalation must be decided by a human,
   * one call at a time. The pipeline then never consults the auto-approver,
   * offers no whitelist candidate and matches no whitelist pattern, and the
   * escalation request tells the approval front-ends to leave the call out
   * of "approve all". Set from `CompiledRule.humanOnly`, which only the
   * hardcoded egress-expanding rules carry (`add_proxy_domain` opens an
   * uninspected passthrough tunnel, and so does admitting a MITM egress
   * destination under `network-egress-escalate`), and by the structural
   * escalation for an argument holding a nested object or array
   * (structural-nested-argument-escalate), whose inner values neither the
   * approver nor a whitelist pattern sees, and by the trusted-server policy
   * for a bulk `memory_forget` or a large `memory_ingest`
   * (`trusted-server-policy.ts`), calls with no resource argument for either
   * to anchor on. A human-only escalation keeps the flag when it combines
   * with any other escalation (the domain gate, a `.git` write, an untrusted
   * repository, a compiled escalation). The
   * security pipeline also sets it, after evaluation, on every sink call in
   * a tainted session when taint escalation is enabled (`evaluateWithTaint`
   * in `taint-policy.ts`). Undefined otherwise.
   */
  humanOnly?: boolean;
  /**
   * When decision is 'allow': the call is allowed subject to the outbound
   * content assessment (src/trusted-process/assessment.ts). The engine sets
   * it on every allow whose *resolved* annotation carries outbound-content
   * arguments, whatever authorized the call -- an `assess` rule (see
   * `RuleOutcome`), sandbox containment (a commit in the sandbox: containment
   * says nothing about the message), or a plain allow the static allow ->
   * assess pass did not convert (`settleContentAssessment`). The pipeline
   * assesses the call's outbound content only when the assessment is enabled;
   * otherwise the flag has no effect. Undefined for every other decision.
   */
  assessContent?: true;
}
