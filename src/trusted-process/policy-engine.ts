/**
 * PolicyEngine -- Two-layer declarative policy evaluation.
 *
 * Structural checks: Hardcoded invariants (protected paths, unknown tools,
 *          local or cloud-metadata fetch destinations, and for a read-only
 *          workspace every change outside its writable directories and every
 *          change to a git repository). These
 *          are never overridden by compiled rules. Protected paths are matched
 *          spelling-insensitively and stay protected inside the sandbox (see
 *          protected-paths.ts). Sandbox containment is checked per-role:
 *          roles whose paths are all within the sandbox are resolved here and
 *          skipped in compiled rule evaluation. Four structural escalations
 *          are recorded rather than returned: the domain gate (a URL role
 *          reaching a destination off the server's allowlist, `['*']` when
 *          the server has none), a write or delete inside a `.git` directory,
 *          a git repository whose layout or config host git must not run
 *          in unseen (see git-structural-rules.ts), and a role-bearing
 *          argument holding a nested object or array (human-only; its
 *          strings are still checked, see argument-values.ts). None is
 *          final: compiled rules still run and a compiled deny wins over
 *          them. A git remote argument that names a local repository is
 *          evaluated as a read of that path.
 *
 * Compiled rule evaluation: Declarative rules loaded from compiled-policy.json.
 *          Each distinct role from the tool's annotation is evaluated
 *          independently through the rule chain (first-match-wins per role).
 *          The most restrictive result wins: deny > escalate > assess >
 *          allow, where `assess` is an allow subject to the outbound content
 *          assessment (`assessContent`, see assessment.ts). Roles already
 *          resolved by sandbox containment are skipped; a sandbox allow of a
 *          call that carries outbound content requires the assessment too. A
 *          matched rule whose outcome is not allow, assess, escalate or deny
 *          denies (fail closed); the loaders already reject such files
 *          (src/types/policy-schema.ts).
 *
 * Task scope (optional, `--task-scoped`): a second compiled policy, compiled
 *          from the session's task text, intersected with the session policy
 *          after its compiled rules. Its rules are evaluated per role the same
 *          way, over the same roles (sandbox-resolved roles stay allowed). A
 *          call is allowed only when both policies allow it; a role no task
 *          rule covers is out of scope and escalates (`task-scope-escalate`)
 *          rather than being denied; otherwise the most restrictive decision
 *          wins, so a session-policy deny is final and a session-policy
 *          escalation stays an escalation. The task scope can never allow a
 *          call the session policy does not. The structural escalations are
 *          combined after the intersection, as without a task scope. Whether
 *          an allow requires the outbound content assessment is settled on
 *          the final result, from the call's resolved annotation.
 *
 * An escalation names every role that escalated (`escalatedRoles`), whether
 * a structural check, a compiled rule or the task scope escalated it, so an
 * approval whitelist pattern has to cover all of them (see
 * approval-whitelist.ts).
 *
 * Path resolution (symlink-following, see resolveRealPath): the trusted
 * directory operands, `allowedDirectory` and every rule's `paths.within`
 * (the task scope's rules included), are canonicalized once when the engine
 * is built (a policy hot-swap builds a new engine). Every path the call
 * supplies, and every protected entry, is canonicalized during the
 * evaluation, once per evaluation however many checks compare it; protected
 * entries are not precomputed so that one is matched by what it names when
 * the call is made.
 */

import { join, resolve, isAbsolute } from 'node:path';
import type { ToolCallRequest, PolicyDecisionStatus } from '../types/mcp.js';
import type { EvaluationResult, TaskScopePolicy, PolicyEvaluationContext } from './policy-types.js';
import { findRepoRoot } from '../security/git-hardening.js';
import { evaluateTrustedServerCall } from './trusted-server-policy.js';
import type {
  CompiledPolicyFile,
  DynamicListsFile,
  ListCondition,
  ResolvedList,
  StoredToolAnnotationsFile,
  StoredToolAnnotation,
  ToolAnnotation,
  CompiledRule,
  ArgumentRole,
} from '../pipeline/types.js';
import { isPlainRelativePath, type ReadOnlyWorkspace } from '../types/read-only-workspace.js';
import {
  annotationCarriesOutboundContent,
  getPathRoles,
  getUrlRoles,
  getRoleDefinition,
  resolveRealPath,
  expandTilde,
  resolvePathLinkChain,
  isWithinDirectory,
  isWithinResolvedDirectory,
  isPathResolutionError,
  resolveStoredAnnotation,
  SANDBOX_SAFE_PATH_ROLES,
} from '../types/argument-roles.js';
import { argumentValues, isStructuredValue, ownArgument } from './argument-values.js';
import {
  ARGUMENT_BUDGET_DENY_RESULT,
  assertArgumentValueBudget,
  isArgumentBudgetError,
  type ArgumentValueLimits,
} from './argument-budget.js';
import {
  domainMatchesAllowlist,
  displayableDomain,
  isIpAddress,
  isLocalOrMetadataHost,
  isPlainGitRemoteName,
  resolveUrlForDomainCheck,
  type DomainCheckTarget,
} from './domain-utils.js';
import { isGitBackend } from './git-backend-env.js';
import { DEFAULT_GIT_REMOTE } from './git-remote-resolution.js';
import {
  GIT_INTERNALS_ESCALATE_REASON,
  GIT_INTERNALS_ROLES,
  STRUCTURAL_GIT_INTERNALS_ESCALATE,
  STRUCTURAL_GIT_REPOSITORY_ESCALATE,
  hasGitInternalsSegment,
  inspectRepositoryForPolicy,
  requiresPerCallApproval,
  withLocalGitSourceReads,
  type RepositoryInspections,
} from './git-structural-rules.js';
import { getListMatcher } from './list-matcher.js';
import { applyOutboundAssessment } from './outbound-rules.js';
import {
  isProtectedResolvedPath,
  containsProtectedResolvedPath,
  resolveProtectedEntries,
  foldPathForComparison,
  type ResolvedProtectedEntry,
} from './protected-paths.js';
import { isRuleOutcome } from '../types/policy-schema.js';
import * as logger from '../logger.js';

/**
 * The domain gate for a server whose mcp-servers.json entry has no
 * `allowedDomains`: every name passes, every IP literal escalates (`*` never
 * matches one, see domainMatchesAllowlist). Without this default a server
 * with URL roles and no allowlist had no structural URL gate at all, so a
 * compiled allow without a `domains` condition admitted any address.
 */
const DEFAULT_DOMAIN_GATE: readonly string[] = ['*'];

/**
 * Git server tools that use `origin` when their remote argument is omitted
 * (git-mcp-server runs `git push|pull|fetch <remote || "origin">`).
 */
const GIT_TOOLS_DEFAULTING_TO_ORIGIN: ReadonlySet<string> = new Set(['git_push', 'git_pull', 'git_fetch']);

/**
 * Extracts string values from arguments based on annotation roles.
 * Only returns values for arguments whose annotated roles intersect
 * with the target roles. Used for paths, URLs, and list values alike.
 *
 * A string, a finite number (in decimal form) and an array of those yield
 * their values. Any other present value (an object, an array with another
 * kind of element, a boolean) yields every string and number inside it
 * (see `argumentValues`), never nothing: the protected-path check, the
 * forbidden-destination deny and the compiled rules judge each of them, and
 * `evaluate()` additionally escalates the call to a human
 * (`structural-nested-argument-escalate`).
 */
function extractAnnotatedPaths(
  args: Record<string, unknown>,
  annotation: ToolAnnotation,
  targetRoles: readonly ArgumentRole[],
): string[] {
  const paths: string[] = [];
  for (const [argName, roles] of Object.entries(annotation.args)) {
    if (!roles.some((r) => targetRoles.includes(r))) continue;
    // A loop rather than push(...values): a large value must not exceed the
    // engine's argument-count limit.
    for (const value of argumentValues(ownArgument(args, argName)).values) paths.push(value);
  }
  return paths;
}

/**
 * Result of structural invariant evaluation.
 *
 * Three possible outcomes:
 * 1. Final decision (deny for protected paths or unknown tools, the
 *    introspection allow)
 * 2. Partial sandbox resolution (some roles' paths are all within sandbox)
 * 3. No structural match (empty sandboxResolvedRoles, fall through to compiled rule evaluation)
 *
 * In cases 2 and 3 structural checks may also have escalated
 * (`escalations`): the domain gate, a write or delete inside `.git`, a git
 * repository that must not be acted on unseen, a role-bearing argument
 * holding a nested object or array (human-only). None is a final decision:
 * each is combined with the compiled-rule result rather than returned on
 * its own, and a deny among the call's roles wins.
 */
interface StructuralResult {
  readonly decision?: EvaluationResult;
  readonly sandboxResolvedRoles: ReadonlySet<ArgumentRole>;
  /**
   * Structural escalations, in the order they are combined with the compiled
   * result (the last one supplies the rule and reason when several apply).
   */
  readonly escalations: readonly EvaluationResult[];
}

const NO_ROLES_RESOLVED: ReadonlySet<ArgumentRole> = new Set();
const NO_ESCALATIONS: readonly EvaluationResult[] = [];

/** Wraps a final EvaluationResult into a StructuralResult. */
function finalDecision(decision: EvaluationResult): StructuralResult {
  return { decision, sandboxResolvedRoles: NO_ROLES_RESOLVED, escalations: NO_ESCALATIONS };
}

/**
 * Higher severity = more restrictive. Used to pick the strictest per-role
 * result. An allow that is subject to the outbound content assessment (from
 * an `assess` rule) ranks above a plain allow and below an escalation.
 */
const DECISION_SEVERITY: Record<PolicyDecisionStatus, number> = {
  allow: 0,
  escalate: 2,
  deny: 3,
};

/** Severity of one result: {@link DECISION_SEVERITY}, with an assessed allow between allow and escalate. */
function resultSeverity(result: EvaluationResult): number {
  if (result.decision === 'allow' && result.assessContent === true) return 1;
  return DECISION_SEVERITY[result.decision];
}

/**
 * Marker rule name for the structural sandbox-containment allow. Not a
 * compiled rule — placeholder used when paths are auto-discharged because
 * they sit inside `allowedDirectory`. Compiled-rule attribution is
 * preferred when a real rule produces an equal-severity result, so this
 * string is checked at tie-break time.
 */
const STRUCTURAL_SANDBOX_ALLOW = 'structural-sandbox-allow';

/**
 * Settles `assessContent` on the final result of a call, from the call's
 * *resolved* annotation: an allow is assessed exactly when the call carries
 * outbound-content arguments. The resolved annotation is the authority, so
 * the flag never depends on which allow authorized the call:
 *
 * - it is cleared on an allow whose call sends no content, even from an
 *   `assess` rule (a rule for a whole server can allow tools, like
 *   `get_me`, that have nothing to assess);
 * - it is set on any allow of a call that does carry outbound content, even
 *   when no `assess` rule produced it: sandbox containment allows a call on
 *   its paths alone (a commit message written in the sandbox leaves with the
 *   history when it is pushed), and the static allow -> assess pass
 *   (outbound-rules.ts) judges a rule on an argument's *default* roles, so it
 *   misses an outbound role that a `when` clause adds only for some modes.
 *   Settling here from the resolved roles closes both gaps: a call that sends
 *   content is assessed however it was allowed, as the feature intends.
 */
function settleContentAssessment(result: EvaluationResult, annotation: ToolAnnotation | undefined): EvaluationResult {
  if (result.decision !== 'allow') return result;
  const carriesContent = annotation !== undefined && annotationCarriesOutboundContent(annotation);
  if (result.assessContent === true && !carriesContent) {
    const { assessContent: _unused, ...plain } = result; // eslint-disable-line @typescript-eslint/no-unused-vars
    return plain;
  }
  if (result.assessContent !== true && carriesContent) {
    return { ...result, assessContent: true };
  }
  return result;
}

/**
 * Collects all distinct non-"none" roles from a tool annotation's arguments.
 * Returns an empty array if the tool has no role-bearing arguments.
 */
function collectDistinctRoles(annotation: ToolAnnotation): ArgumentRole[] {
  const roles = new Set<ArgumentRole>();
  for (const argRoles of Object.values(annotation.args)) {
    for (const role of argRoles) {
      if (getRoleDefinition(role).isResourceIdentifier) roles.add(role);
    }
  }
  return [...roles];
}

/**
 * Extracts URL values from arguments based on annotation roles.
 * Returns an array of { value, role } for each URL-category argument,
 * reading values the way {@link extractAnnotatedPaths} does (every string
 * inside a structured value included).
 */
function extractAnnotatedUrls(
  args: Record<string, unknown>,
  annotation: ToolAnnotation,
  targetRoles: ArgumentRole[],
): Array<{ value: string; role: ArgumentRole }> {
  const urls: Array<{ value: string; role: ArgumentRole }> = [];
  for (const [argName, roles] of Object.entries(annotation.args)) {
    const matchingRole = roles.find((r) => targetRoles.includes(r));
    if (!matchingRole) continue;
    for (const value of argumentValues(ownArgument(args, argName)).values) {
      urls.push({ value, role: matchingRole });
    }
  }
  return urls;
}

/**
 * The values a `lists` condition compares, as {@link extractAnnotatedPaths}
 * extracts them, each with the URL role it carries when one of its
 * argument's roles among `targetRoles` is a URL role (a `domains` list then
 * matches where the value connects, not how it is spelled).
 */
function extractAnnotatedListValues(
  args: Record<string, unknown>,
  annotation: ToolAnnotation,
  targetRoles: readonly ArgumentRole[],
): Array<{ value: string; urlRole: ArgumentRole | undefined }> {
  const values: Array<{ value: string; urlRole: ArgumentRole | undefined }> = [];
  for (const [argName, roles] of Object.entries(annotation.args)) {
    const matching = roles.filter((r) => targetRoles.includes(r));
    if (matching.length === 0) continue;
    const urlRole = matching.find((r) => getRoleDefinition(r).category === 'url');
    for (const value of argumentValues(ownArgument(args, argName)).values) values.push({ value, urlRole });
  }
  return values;
}

/** A domain quoted for a reason, or a neutral phrase when its host could not be validated. */
function describeDomainForReason(domain: string): string {
  const shown = displayableDomain(domain);
  return shown === undefined ? 'with an unrecognized host' : `"${shown}"`;
}

/** At most this many destinations are named in one reason; the rest are counted. */
const MAX_DOMAINS_IN_REASON = 3;

/** The destinations of an unverifiable target for a reason, bounded in length whatever the config holds. */
function describeDomainsForReason(domains: readonly string[]): string {
  const named = domains.slice(0, MAX_DOMAINS_IN_REASON).map((domain) => {
    const shown = displayableDomain(domain);
    return shown === undefined ? 'an unrecognized host' : `"${shown}"`;
  });
  const rest = domains.length - named.length;
  return rest > 0 ? `${named.join(', ')} and ${rest} more` : named.join(', ');
}

/** How a URL-role argument is named in a reason; agent-chosen text appears only when it is a plain remote name. */
function describeUrlArgument(value: string, role: ArgumentRole): string {
  if (role !== 'git-remote-url') return 'the URL';
  return isPlainGitRemoteName(value) ? `git remote "${value}"` : 'the git remote';
}

/**
 * The arguments `evaluate()` evaluates for a call: the call's own arguments,
 * with an absent or empty git-remote-url argument of git_push, git_pull or
 * git_fetch on the 'git' server made explicit as `origin`. git-mcp-server
 * runs `git push|pull|fetch <remote || "origin">`, so `branch.<name>.remote`,
 * `remote.pushDefault` and the branch's upstream never apply.
 *
 * Anything that must agree with the decision about which destination a call
 * reaches (the approval whitelist, the approver's view of the destination)
 * uses these arguments rather than the raw ones. The transport still
 * receives the agent's own arguments. Returns `args` itself when nothing is
 * filled in.
 */
export function evaluatedArguments(
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
  annotation: ToolAnnotation | undefined,
): Record<string, unknown> {
  if (serverName !== 'git' || !annotation || !GIT_TOOLS_DEFAULTING_TO_ORIGIN.has(toolName)) return args;

  // Collect git-remote-url annotated args whose value is absent or empty
  // (the server treats an empty remote as omitted).
  const missingUrlArgNames: string[] = [];
  for (const [argName, roles] of Object.entries(annotation.args)) {
    if (!roles.includes('git-remote-url')) continue;
    const value = args[argName];
    const isAbsent = !(argName in args) || value === null || value === undefined || value === '';
    if (isAbsent) missingUrlArgNames.push(argName);
  }
  if (missingUrlArgNames.length === 0) return args;

  const filled = { ...args };
  for (const argName of missingUrlArgNames) filled[argName] = DEFAULT_GIT_REMOTE;
  return filled;
}

/**
 * Combines a structural escalation (the domain gate, a `.git` write, an
 * untrusted repository, a nested argument value) with the compiled-rule
 * result for the same call (every role the sandbox did not resolve, the
 * gate's URL roles included).
 * The structural check only ever adds a restriction: a compiled deny still
 * wins, so an off-allowlist or unverifiable destination never turns a call
 * the policy denies into one a human (or a whitelist pattern) can approve.
 * A git call on a repository outside every permitted directory stays denied
 * when its remote is also untrusted. Otherwise the call escalates with the
 * structural rule and reason, and `escalatedRoles` names every role that
 * escalated, the structural check's roles and every role the compiled rules
 * escalated (a path outside the sandbox, say), so an approval covers the
 * whole call rather than its URL alone. An allow leaves the structural
 * escalation as it is.
 */
function withStructuralEscalation(gate: EvaluationResult, compiled: EvaluationResult): EvaluationResult {
  if (compiled.decision === 'deny') return compiled;
  // A human-only escalation stays human-only, whichever side carries the
  // flag (a compiled human-only rule, or the structural nested-argument
  // escalation): the combination adds a restriction, it never hands the
  // call back to a delegate. When several structural escalations apply,
  // `compiled` is the result combined so far, so the flag survives every
  // step.
  const isHumanOnly = (compiled.decision === 'escalate' && compiled.humanOnly === true) || gate.humanOnly === true;
  const humanOnly = isHumanOnly ? { humanOnly: true } : {};
  if (compiled.decision === 'escalate' && compiled.escalatedRoles === undefined) {
    // Which roles escalated is unknown, so name none rather than a narrower
    // set: consumers then fall back to their most restrictive behaviour.
    return { decision: gate.decision, rule: gate.rule, reason: gate.reason, ...humanOnly };
  }
  const roles = new Set<ArgumentRole>(gate.escalatedRoles);
  if (compiled.decision === 'escalate') {
    for (const role of compiled.escalatedRoles ?? []) roles.add(role);
  }
  return { ...gate, escalatedRoles: [...roles], ...humanOnly };
}

/** Rule name of the structural domain gate (see `evaluateDomainGate`). */
export const STRUCTURAL_DOMAIN_ESCALATE_RULE = 'structural-domain-escalate';

/**
 * Rule name of the structural escalation for an argument whose value policy
 * cannot evaluate value by value (see `evaluateNestedArguments`).
 */
export const STRUCTURAL_NESTED_ARGUMENT_ESCALATE = 'structural-nested-argument-escalate';

/** Fixed text: names no argument and no value, so nothing agent-chosen reaches a reason. */
const NESTED_ARGUMENT_ESCALATE_REASON =
  'An argument that policy evaluates holds a nested object or array (or another value that is not a string, ' +
  'a number or a list of them), so its contents cannot be checked one by one; a human must approve the call';

/**
 * The structural domain gate's reason as the auto-approver sees it. The real
 * reason names the destination so a human can judge it; the approver gets
 * the destination as structured data instead (see `extractArgsForAutoApprove`).
 */
const STRUCTURAL_DOMAIN_ESCALATE_APPROVER_REASON =
  'A URL argument reaches a destination that is not on the server’s domain allowlist or whose destination cannot be verified';

/**
 * The escalation reason that may be placed in the auto-approver's prompt.
 *
 * Compiled-rule reasons are fixed text from the compiled policy and the
 * other structural reasons are constants or built from fixed phrases (the
 * untrusted-repository reason names a config key only with its agent-chosen
 * subsection elided), so they are returned as they are.
 * The structural domain gate is the one escalation whose reason is built
 * from agent-chosen data (the destination of a URL or git remote argument,
 * validated for display); the approver must not read it as prose, so it gets
 * a fixed template and the validated destination arrives as structured data.
 * Add a case here before any other reason starts carrying agent input.
 */
export function reasonForAutoApprover(result: EvaluationResult): string {
  return result.rule === STRUCTURAL_DOMAIN_ESCALATE_RULE ? STRUCTURAL_DOMAIN_ESCALATE_APPROVER_REASON : result.reason;
}

/**
 * Whether the auto-approver must treat the call's destination as the
 * question (`ApproverExtractionContext.destinationGate`): a named git remote
 * then anchors only through the host it connects to, never through its name.
 *
 * True when the structural domain gate names the escalation, and also when a
 * per-call git escalation does (a write inside `.git`, an untrusted
 * repository; see requiresPerCallApproval). Those are combined after the
 * gate and name the call in its place (evaluateStructuralInvariants), so the
 * gate may have escalated the same call; and a repository whose config
 * cannot be trusted says little about where its remotes lead. Erring towards
 * true only ever asks the human's message for more.
 */
export function destinationGateMayHaveEscalated(result: EvaluationResult): boolean {
  return result.rule === STRUCTURAL_DOMAIN_ESCALATE_RULE || requiresPerCallApproval(result);
}

// Re-export utilities used by sibling modules (mcp-proxy-server, index, approval-whitelist).
// Canonical location: isWithinDirectory is defined in src/types/argument-roles.ts.
// hasRoleConditions / ruleRelevantToRole are shared with the list resolver's
// static tool-exposure check (src/pipeline/list-resolution-tools.ts) so both
// use the same rule-relevance semantics as evaluation.
export {
  domainMatchesAllowlist,
  extractAnnotatedPaths,
  collectDistinctRoles,
  isIpAddress,
  isWithinDirectory,
  hasRoleConditions,
  ruleRelevantToRole,
};

/**
 * Checks whether a rule has role-related conditions (roles, paths, or domains).
 * Rules without these conditions are role-agnostic and match any role.
 */
function hasRoleConditions(rule: CompiledRule): boolean {
  return (
    rule.if.roles !== undefined ||
    rule.if.paths !== undefined ||
    rule.if.domains !== undefined ||
    (rule.if.lists !== undefined && rule.if.lists.length > 0)
  );
}

/**
 * Checks whether a rule's role-related conditions include a specific role.
 * For `roles` conditions: the role must be in the list.
 * For `paths` conditions: the role must be in the paths.roles list.
 * For `domains` conditions: the role must be in the domains.roles list.
 */
function ruleRelevantToRole(rule: CompiledRule, role: ArgumentRole): boolean {
  const cond = rule.if;
  if (cond.roles !== undefined && !cond.roles.includes(role)) return false;
  if (cond.paths !== undefined && !cond.paths.roles.includes(role)) return false;
  if (cond.domains !== undefined && !cond.domains.roles.includes(role)) return false;
  if (cond.lists !== undefined && !cond.lists.some((lc) => lc.roles.includes(role))) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Dynamic list expansion (load-time)
// ---------------------------------------------------------------------------

/**
 * Computes the effective values for a named list by combining resolved values,
 * manual additions, and manual removals:
 *   effective = (resolved.values + manualAdditions) - manualRemovals
 */
function getEffectiveListValues(listName: string, lists: DynamicListsFile): string[] {
  // Own entries only: `@constructor` or `@__proto__` must not resolve to an
  // inherited Object.prototype member.
  const list: ResolvedList | undefined = Object.hasOwn(lists.lists, listName) ? lists.lists[listName] : undefined;
  if (!list) {
    // Loading must survive old-policy/new-list interleavings. Allows expand
    // to no values; restrictive conditions are marked conservative below.
    logger.warn(
      `[policy] Dynamic list "@${listName}" referenced in policy but not in dynamic-lists.json; ` +
        `treating as unavailable (restrictive rules remain restrictive). Run "ironcurtain compile-policy" to resolve lists.`,
    );
    return [];
  }

  const removals = new Set(list.manualRemovals);
  return [...new Set([...list.values, ...list.manualAdditions])].filter((v) => !removals.has(v));
}

/** The lists a policy is expanded with when no dynamic-lists.json was loaded: every `@list` is missing. */
const NO_DYNAMIC_LISTS: DynamicListsFile = Object.freeze({ generatedAt: '', lists: Object.freeze({}) });

/**
 * Expands all `@list-name` references in compiled rules with concrete values
 * from the resolved dynamic lists. Called at load time so the evaluation hot
 * path never sees symbolic references. Returns `policy` itself when no rule
 * references a list. Restrictive conditions with missing, empty, legacy or
 * incomplete resolutions retain their applicable roles and other predicates,
 * but cannot use the uncertain list to narrow an escalation or denial.
 */
function expandListReferences(
  policy: CompiledPolicyFile,
  lists: DynamicListsFile,
  incompleteConditions: Set<object>,
): CompiledPolicyFile {
  const uncertain = (entries: readonly string[]): boolean =>
    entries.some((entry) => {
      if (!entry.startsWith('@')) return false;
      const name = entry.slice(1);
      const list = Object.hasOwn(lists.lists, name) ? lists.lists[name] : undefined;
      return (
        list === undefined ||
        list.resolutionState !== 'complete' ||
        list.inputHash === '' ||
        getEffectiveListValues(name, lists).length === 0
      );
    });
  const expandedRules = policy.rules.map((rule) => {
    let expandedRule = rule;
    const restrictive = rule.then === 'escalate' || rule.then === 'deny';

    // Expand @list-name in domains.allowed
    if (rule.if.domains?.allowed.some((e) => e.startsWith('@'))) {
      const ruleDomains = rule.if.domains;
      const expandedAllowed = ruleDomains.allowed.flatMap((entry) =>
        entry.startsWith('@') ? getEffectiveListValues(entry.slice(1), lists) : [entry],
      );
      const expandedDomains = { ...ruleDomains, allowed: expandedAllowed };
      if (restrictive && uncertain(ruleDomains.allowed)) incompleteConditions.add(expandedDomains);
      expandedRule = {
        ...expandedRule,
        if: {
          ...expandedRule.if,
          domains: expandedDomains,
        },
      };
    }

    // Expand @list-name in each lists[] entry
    if (rule.if.lists?.some((lc) => lc.allowed.some((e) => e.startsWith('@')))) {
      const expandedLists = rule.if.lists.map((listCond) => {
        if (!listCond.allowed.some((e) => e.startsWith('@'))) return listCond;
        const expandedAllowed = listCond.allowed.flatMap((entry) =>
          entry.startsWith('@') ? getEffectiveListValues(entry.slice(1), lists) : [entry],
        );
        const expandedCondition = { ...listCond, allowed: expandedAllowed };
        if (restrictive && uncertain(listCond.allowed)) incompleteConditions.add(expandedCondition);
        return expandedCondition;
      });
      expandedRule = {
        ...expandedRule,
        if: { ...expandedRule.if, lists: expandedLists },
      };
    }

    return expandedRule;
  });

  const expanded = expandedRules.some((rule, index) => rule !== policy.rules[index]);
  return expanded ? { ...policy, rules: expandedRules } : policy;
}

/** Sentinel result returned when no rule matches (default-deny). */
const DEFAULT_DENY_RESULT: EvaluationResult = Object.freeze({
  decision: 'deny',
  rule: 'default-deny',
  reason: 'No matching policy rule -- denied by default',
});

/**
 * Structural deny for a path that touches a protected entry. The reason
 * deliberately names neither the requested nor the protected path: echoing
 * the canonical protected spelling would tell an agent exactly which variant
 * to retry with. The audit entry still records the call's arguments.
 */
const PROTECTED_PATH_DENY_RESULT: EvaluationResult = Object.freeze({
  decision: 'deny',
  rule: 'structural-protected-path',
  reason: 'Access to a protected path is forbidden',
});

/**
 * Structural deny for a path argument that could not be canonicalized at all
 * (resolveRealPath threw PathResolutionError). Fail closed: never evaluate
 * the caller's unresolved spelling.
 */
export const UNRESOLVABLE_PATH_DENY_RESULT: EvaluationResult = Object.freeze({
  decision: 'deny',
  rule: 'structural-unresolvable-path',
  reason: 'A path argument could not be resolved to a canonical location',
});

/**
 * Structural deny for a fetch whose destination is the local machine, a
 * local network or a cloud instance-metadata service by name (`localhost`,
 * `*.localhost`, `*.local`, `*.internal`, `metadata.google.internal`, ...),
 * or a metadata IP literal. No compiled rule can allow it: such a fetch
 * reads credentials or unauthenticated local services, never web content.
 */
export const LOCAL_DESTINATION_DENY_RESULT: EvaluationResult = Object.freeze({
  decision: 'deny',
  rule: 'structural-local-destination-deny',
  reason: 'Fetching from a local, private-network or cloud-metadata destination is forbidden',
});

/** Rule name of the read-only workspace deny (see {@link READ_ONLY_WORKSPACE_DENY_RESULT}). */
export const STRUCTURAL_READ_ONLY_WORKSPACE_RULE = 'structural-read-only-workspace';

/**
 * Structural deny for a call that would write, delete or rewrite git history
 * at a path outside the writable directories of a read-only workspace, or
 * change a git repository at all ({@link PolicyEngineOptions.readOnlyWorkspace}).
 * No compiled rule, approval or whitelist pattern can allow it: the agent runs
 * with a read-only workspace by construction, not by the persona's policy.
 * Fixed text, naming no path.
 */
export const READ_ONLY_WORKSPACE_DENY_RESULT: EvaluationResult = Object.freeze({
  decision: 'deny',
  rule: STRUCTURAL_READ_ONLY_WORKSPACE_RULE,
  reason:
    'This agent runs with a read-only workspace: it may create, change or delete files only inside its ' +
    'declared output directories, using the filesystem tools; git operations that change a local repository are ' +
    'refused',
});

/**
 * Path roles that change what they name: every path role but `read-path`
 * (`write-path`, `delete-path`, `write-history`, `delete-history`). Derived
 * from the registry, so a path role added later counts as a change until it
 * is deliberately listed here as a read.
 */
const MUTATION_PATH_ROLES: readonly ArgumentRole[] = getPathRoles().filter((role) => role !== 'read-path');

/**
 * Path roles whose value names a repository the call changes as a whole,
 * on any server: rewriting or deleting history writes the repository's git
 * directory and refs, wherever in its work tree the path points.
 */
const REPOSITORY_CHANGE_ROLES: readonly ArgumentRole[] = ['write-history', 'delete-history'];

/**
 * True when the call changes a git repository rather than only the paths it
 * names, so its path values cannot confine it to a writable directory:
 *
 * - any mutation path role on the git backend. git-mcp-server runs host git
 *   in the directory it is given, and git acts on the repository that
 *   contains that directory: repository discovery from a subdirectory of the
 *   workspace reaches the workspace's own repository (the backend's
 *   discovery ceiling is the workspace's parent, see `gitDiscoveryCeiling`).
 *   `git reset --hard`, `git checkout`, `git stash` or `git commit` run "in"
 *   a writable output directory therefore rewrite the whole work tree, its
 *   index and its history, and `git worktree add` or `git clone` into one
 *   writes the enclosing repository's git directory or fetches from a remote;
 * - a history role on any other server.
 *
 * Judged from the roles of the call's arguments (conditional roles already
 * resolved), whether or not the argument is present. A push (`git_push`, a
 * read of the local repository that changes a remote one) is left to the
 * compiled policy, which governs remote side effects (the shipped policy
 * escalates every push).
 */
function changesRepository(serverName: string, annotation: ToolAnnotation): boolean {
  const changeRoles = isGitBackend(serverName) ? MUTATION_PATH_ROLES : REPOSITORY_CHANGE_ROLES;
  return Object.values(annotation.args).some((roles) => roles.some((role) => changeRoles.includes(role)));
}

/** Options of a {@link PolicyEngine} beyond the policy, annotations and sandbox. */
export interface PolicyEngineOptions {
  /** Trusted overrides can only tighten resource evaluation limits. */
  readonly argumentValueLimits?: Partial<ArgumentValueLimits>;
  /**
   * Confines every change to the given workspace subdirectories. Each value
   * of a mutation path role (every path role but `read-path`) must resolve
   * inside `<allowedDirectory>/<writablePath>` for one of them, or the call
   * is denied structurally ({@link READ_ONLY_WORKSPACE_DENY_RESULT}), before
   * sandbox containment and the compiled rules. A call that changes a git
   * repository (any mutation path role on the git backend, a history role
   * anywhere) is denied wherever its path points: git acts on the repository
   * that contains the path, not on the path alone (see `changesRepository`).
   * Reads are not affected.
   *
   * The writable roots are the canonical sandbox joined with each plain
   * relative path, never the paths' own resolution: a call path is resolved
   * when it is evaluated, so a writable directory that is (or later becomes)
   * a symlink leads elsewhere and is refused rather than followed. A path
   * that is not plain relative is ignored, and without an `allowedDirectory`
   * (or with one that cannot be canonicalized) nothing is writable.
   */
  readonly readOnlyWorkspace?: ReadOnlyWorkspace;
}

/**
 * The directories a read-only workspace may still change: the canonical
 * sandbox joined with each plain relative writable path. None when the
 * sandbox is absent or could not be canonicalized (fail closed).
 */
function readOnlyWorkspaceRoots(
  sandboxRoot: PrecomputedDirectory | undefined,
  readOnlyWorkspace: ReadOnlyWorkspace,
): readonly string[] {
  if (sandboxRoot === undefined || 'error' in sandboxRoot) return [];
  const roots: string[] = [];
  for (const writablePath of readOnlyWorkspace.writablePaths) {
    if (!isPlainRelativePath(writablePath)) continue;
    roots.push(join(sandboxRoot.path, ...writablePath.split('/')));
  }
  return roots;
}

/**
 * Reason given when a matched rule's outcome is not allow, assess, escalate
 * or deny. Fixed text: the outcome itself is not echoed.
 */
const UNRECOGNIZED_DECISION_REASON = 'The matching policy rule has an unrecognized decision -- denied';

/**
 * Converts a matched compiled rule into an EvaluationResult. A rule's
 * `humanOnly` flag is carried only when it escalates (an allow has nothing
 * to delegate). An `assess` rule allows subject to the outbound content
 * assessment (`assessContent`).
 *
 * Fail closed on the outcome: anything other than allow, assess, escalate
 * or deny (`"Escalate"`, `"allw"`, a missing value) becomes a deny under the
 * rule's name. The loaders reject such files (`src/types/policy-schema.ts`);
 * this covers policies built in memory, which never pass through them.
 * Without it the unknown string would reach the tool-call pipeline, which
 * only stops `escalate` and `deny` and forwards everything else like an
 * allow.
 */
function ruleToResult(rule: CompiledRule): EvaluationResult {
  if (!isRuleOutcome(rule.then)) {
    return { decision: 'deny', rule: rule.name, reason: UNRECOGNIZED_DECISION_REASON };
  }
  if (rule.then === 'assess') {
    return { decision: 'allow', rule: rule.name, reason: rule.reason, assessContent: true };
  }
  const result: EvaluationResult = { decision: rule.then, rule: rule.name, reason: rule.reason };
  if (rule.then === 'escalate' && rule.humanOnly === true) result.humanOnly = true;
  return result;
}

/**
 * Logs, once per engine, the rules whose decision `ruleToResult` will turn
 * into a deny, so a malformed in-memory policy is visible before it denies.
 */
function warnOnUnrecognizedDecisions(rules: readonly CompiledRule[]): void {
  const names = rules.filter((rule) => !isRuleOutcome(rule.then)).map((rule) => JSON.stringify(rule.name));
  if (names.length === 0) return;
  logger.warn(
    `[policy] ${names.length} compiled rule(s) have an unrecognized decision and deny every call they match: ` +
      names.join(', '),
  );
}

/**
 * The most restrictive of two per-role or per-path results, with a
 * human-only escalation surviving the choice: when both escalate and either
 * is human-only, the combined escalation is human-only whichever rule is
 * named. `preferNext` breaks a severity tie in favour of `next`. An allow
 * that requires the outbound content assessment outranks a plain allow, so
 * the combined allow still requires it.
 */
function combineResults(current: EvaluationResult, next: EvaluationResult, preferNext: boolean): EvaluationResult {
  const currentSeverity = resultSeverity(current);
  const nextSeverity = resultSeverity(next);
  const chosen = nextSeverity > currentSeverity || (nextSeverity === currentSeverity && preferNext) ? next : current;
  if (chosen.decision === 'escalate' && chosen.humanOnly !== true) {
    const other = chosen === next ? current : next;
    if (other.decision === 'escalate' && other.humanOnly === true) return { ...chosen, humanOnly: true };
  }
  return chosen;
}

/**
 * A trusted directory canonicalized when the engine is built, or the error
 * canonicalizing it raised. The error is rethrown where the directory is
 * used, so a directory that cannot be canonicalized fails the evaluation
 * that needs it (a `PathResolutionError` is a deny), exactly as resolving
 * it at that point would.
 */
type PrecomputedDirectory = { readonly path: string } | { readonly error: Error };

class UnsafePolicyRootError extends Error {}

const UNSAFE_POLICY_ROOT_RESULT: EvaluationResult = Object.freeze({
  decision: 'deny',
  rule: 'structural-unsafe-policy-root',
  reason: 'A workspace policy root resolves outside the workspace; review the policy and workspace layout',
});

const GIT_PROTECTED_REPOSITORY_RESULT: EvaluationResult = Object.freeze({
  decision: 'deny',
  rule: 'structural-git-protected-repository',
  reason:
    'Git repository contains a protected path. Move protected audit/config files outside the repository before using Git tools.',
});

const GIT_CONTEXT_DENY_RESULT: EvaluationResult = Object.freeze({
  decision: 'deny',
  rule: 'structural-git-context-deny',
  reason: 'Git operation needs a tracked working directory. Call git_set_working_dir with an explicit path first.',
});

/** Lexical containment used only to reject a mutable root, never to grant access. */
function namedInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);
}

function precomputeDirectory(directory: string): PrecomputedDirectory {
  try {
    return { path: resolveRealPath(directory) };
  } catch (err) {
    return { error: err instanceof Error ? err : new Error(String(err)) };
  }
}

function precomputedPath(directory: PrecomputedDirectory): string {
  if ('error' in directory) throw directory.error;
  return directory.path;
}

/** Rule name of the task-scope escalation: a call the session's task policy does not cover. */
export const TASK_SCOPE_ESCALATE_RULE = 'task-scope-escalate';

/**
 * Reason of the task-scope escalation. Fixed text (no agent input), so the
 * auto-approver may read it as it is (see `reasonForAutoApprover`).
 */
const TASK_SCOPE_ESCALATE_REASON =
  'Outside the task scope: no rule of the task policy compiled for this session covers it';

/**
 * Intersects the session policy's compiled result for a call with the task
 * scope's result for the same call (undefined when the task scope allows
 * it). The most restrictive decision wins and the task scope can only add a
 * restriction: a session-policy deny stays a deny, a session-policy allow
 * becomes the task scope's escalation (or its deny, when a task rule denies
 * explicitly), and two escalations become one that names the session
 * policy's rule, notes the task scope in its reason, is human-only when
 * either is, and names every role either escalated (none when either side's
 * roles are unknown, so consumers fall back to their most restrictive
 * behaviour).
 */
function intersectWithTaskScope(base: EvaluationResult, scope: EvaluationResult | undefined): EvaluationResult {
  if (scope === undefined || base.decision === 'deny') return base;
  if (scope.decision === 'deny' || base.decision === 'allow') return scope;
  const humanOnly = base.humanOnly === true || scope.humanOnly === true ? { humanOnly: true } : {};
  // The same rule on both sides (the virtual proxy rules both carry) needs
  // no note.
  const note =
    scope.rule === base.rule
      ? undefined
      : scope.rule === TASK_SCOPE_ESCALATE_RULE
        ? 'also outside the task scope'
        : `the task scope also escalates it: ${scope.reason}`;
  const reason = note === undefined ? base.reason : `${base.reason} (${note})`;
  if (base.escalatedRoles === undefined || scope.escalatedRoles === undefined) {
    return { decision: 'escalate', rule: base.rule, reason, ...humanOnly };
  }
  const roles = new Set<ArgumentRole>([...base.escalatedRoles, ...scope.escalatedRoles]);
  return { decision: 'escalate', rule: base.rule, reason, escalatedRoles: [...roles], ...humanOnly };
}

export class PolicyEngine {
  /** Restrictive conditions whose referenced list cannot safely narrow them. */
  private readonly incompleteListConditions = new Set<object>();
  private readonly argumentValueLimits: Partial<ArgumentValueLimits>;
  private annotationMap: Map<string, StoredToolAnnotation>;
  private compiledPolicy: CompiledPolicyFile;
  private protectedPaths: string[];
  private allowedDirectory?: string;
  private serverDomainAllowlists: ReadonlyMap<string, readonly string[]>;
  private trustedServers: ReadonlySet<string>;
  /**
   * The trusted directory operands, canonicalized once when the engine is
   * built: `allowedDirectory` and every compiled rule's `paths.within`, the
   * task scope's rules included (keyed by its spelling in the policy). They
   * come from configuration and the compiled policies, not from the agent,
   * and a policy hot-swap (`ToolCallCoordinator.loadPolicy`) builds a new
   * engine. A directory that does not exist yet keeps resolveRealPath's
   * deepest-ancestor answer; once created as a plain directory it resolves
   * to the same path. Protected entries are deliberately not precomputed
   * (see `protectedEntriesForCall`), and agent-supplied paths are always
   * resolved during the evaluation.
   */
  private readonly sandboxRoot: PrecomputedDirectory | undefined;
  private readonly ruleDirectories: ReadonlyMap<string, PrecomputedDirectory>;
  private readonly unsafeRuleDirectories = new Set<string>();
  /**
   * Rules of the task scope (`--task-scoped`), lists expanded, or undefined
   * when the session has none. See the module comment and
   * `evaluateTaskScope`.
   */
  private readonly taskScopeRules: readonly CompiledRule[] | undefined;
  /**
   * For a read-only workspace (`PolicyEngineOptions.readOnlyWorkspace`), the
   * canonical directories the agent may still change; every change elsewhere
   * is denied. Undefined when the workspace is not read-only.
   */
  private readonly writableRoots: readonly string[] | undefined;
  /**
   * URL resolutions made during the current `evaluate()` call, so the domain
   * gate and every compiled `domains` condition see the same answer (one read
   * of a repository config per call). Undefined between calls.
   */
  private domainChecks: Map<string, DomainCheckTarget> | undefined;
  /**
   * Canonical forms of the paths resolved during the current `evaluate()`
   * call, keyed by spelling: every check of the call (protected paths,
   * sandbox containment, `.git` internals, repository inspection, compiled
   * `paths.within`) sees one resolution of each path, made once. Undefined
   * between calls, so nothing is reused across evaluations.
   */
  private pathResolutions: Map<string, string> | undefined;
  /** The protected entries canonicalized for the current call, on first use. Undefined between calls. */
  private callProtectedEntries: readonly ResolvedProtectedEntry[] | undefined;

  constructor(
    compiledPolicy: CompiledPolicyFile,
    toolAnnotations: StoredToolAnnotationsFile,
    protectedPaths: string[],
    allowedDirectory?: string,
    serverDomainAllowlists?: ReadonlyMap<string, readonly string[]>,
    dynamicLists?: DynamicListsFile,
    trustedServers?: ReadonlySet<string>,
    taskScope?: TaskScopePolicy,
    options: PolicyEngineOptions = {},
  ) {
    this.argumentValueLimits = options.argumentValueLimits ?? {};
    // Always expanded, also when no dynamic-lists.json was loaded: a `@list`
    // entry is a list reference, never a literal, so without lists it allows
    // nothing (an argument spelled "@my-contacts" must not match it).
    const expanded = expandListReferences(
      compiledPolicy,
      dynamicLists ?? NO_DYNAMIC_LISTS,
      this.incompleteListConditions,
    );
    // Outbound channels: a compiled allow that can match a tool carrying
    // outbound content is evaluated as `assess`, also in policies compiled
    // before the compiler emitted it (see outbound-rules.ts). Without the
    // opt-in content assessment an assessed allow is a plain allow.
    const tools = Object.values(toolAnnotations.servers).flatMap((server) => server.tools);
    this.compiledPolicy = { ...expanded, rules: applyOutboundAssessment(expanded.rules, tools) };
    warnOnUnrecognizedDecisions(this.compiledPolicy.rules);
    this.protectedPaths = protectedPaths;
    this.allowedDirectory = allowedDirectory;
    this.serverDomainAllowlists = serverDomainAllowlists ?? new Map();
    this.annotationMap = this.buildAnnotationMap(toolAnnotations);
    this.trustedServers = trustedServers ?? new Set();
    // A task scope's `@list` references expand against its own lists only,
    // exactly as the session policy's do against its lists: always, so a
    // `@list` entry without a lists file allows nothing.
    const taskScopeRules = taskScope
      ? expandListReferences(
          taskScope.compiledPolicy,
          taskScope.dynamicLists ?? NO_DYNAMIC_LISTS,
          this.incompleteListConditions,
        ).rules
      : undefined;
    if (taskScopeRules !== undefined) warnOnUnrecognizedDecisions(taskScopeRules);
    this.taskScopeRules = taskScopeRules;
    this.sandboxRoot = allowedDirectory === undefined ? undefined : precomputeDirectory(allowedDirectory);
    const namedWorkspace = allowedDirectory === undefined ? undefined : resolve(expandTilde(allowedDirectory));
    const workspace = this.sandboxRoot !== undefined && 'path' in this.sandboxRoot ? this.sandboxRoot.path : undefined;
    const ruleDirectories = new Map<string, PrecomputedDirectory>();
    for (const rule of [...this.compiledPolicy.rules, ...(taskScopeRules ?? [])]) {
      const within = rule.if.paths?.within;
      if (within !== undefined && !ruleDirectories.has(within)) {
        const directory = precomputeDirectory(within);
        ruleDirectories.set(within, directory);
        const name = resolve(expandTilde(within));
        if (
          workspace !== undefined &&
          namedWorkspace !== undefined &&
          'path' in directory &&
          // Deny-side folding also catches an alias spelling on a volume that
          // folds case/Unicode. The canonical containment check stays exact.
          (namedInside(foldPathForComparison(name), foldPathForComparison(namedWorkspace)) ||
            namedInside(foldPathForComparison(name), foldPathForComparison(workspace)) ||
            resolvePathLinkChain(within).links.some((link) =>
              namedInside(foldPathForComparison(link), foldPathForComparison(workspace)),
            )) &&
          !namedInside(directory.path, workspace)
        ) {
          this.unsafeRuleDirectories.add(within);
        }
      }
    }
    this.ruleDirectories = ruleDirectories;
    this.writableRoots =
      options.readOnlyWorkspace === undefined
        ? undefined
        : readOnlyWorkspaceRoots(this.sandboxRoot, options.readOnlyWorkspace);
  }

  /** True when this engine intersects the session policy with a task scope. */
  hasTaskScope(): boolean {
    return this.taskScopeRules !== undefined;
  }

  private buildAnnotationMap(annotations: StoredToolAnnotationsFile): Map<string, StoredToolAnnotation> {
    const map = new Map<string, StoredToolAnnotation>();
    for (const [serverName, serverData] of Object.entries(annotations.servers)) {
      for (const tool of serverData.tools) {
        const key = `${serverName}__${tool.toolName}`;
        map.set(key, tool);
      }
    }
    return map;
  }

  /**
   * Returns the resolved annotation for a specific tool call,
   * with conditional role specs evaluated against the call arguments.
   * Returns undefined for unknown tools.
   */
  getAnnotation(serverName: string, toolName: string, callArgs: Record<string, unknown>): ToolAnnotation | undefined {
    const stored = this.annotationMap.get(`${serverName}__${toolName}`);
    if (!stored) return undefined;
    assertArgumentValueBudget(callArgs, stored, this.argumentValueLimits);
    return resolveStoredAnnotation(stored, callArgs);
  }

  /**
   * Returns the stored (unresolved) annotation for a tool.
   * Conditional role specs are not evaluated.
   * Used by pipeline stages that need the raw conditional structure.
   */
  getStoredAnnotation(serverName: string, toolName: string): StoredToolAnnotation | undefined {
    return this.annotationMap.get(`${serverName}__${toolName}`);
  }

  /**
   * Returns true for a trusted server: one that has no annotations and no
   * compiled rules, whose calls are judged per tool by the hardcoded
   * trusted-server policy (`trusted-server-policy.ts`) instead.
   */
  isTrustedServer(serverName: string): boolean {
    return this.trustedServers.has(serverName);
  }

  evaluate(request: ToolCallRequest, context?: PolicyEvaluationContext): EvaluationResult {
    // Trusted servers skip annotations and compiled rules, but not policy: their
    // tools are judged one by one (memory: reads and single-fact writes allow,
    // bulk forgets and large ingests escalate to a human, unknown tools deny).
    if (this.trustedServers.has(request.serverName)) {
      return evaluateTrustedServerCall(request);
    }
    try {
      return this.evaluateUntrusted(request, context);
    } catch (err) {
      if (err instanceof UnsafePolicyRootError) return UNSAFE_POLICY_ROOT_RESULT;
      if (isArgumentBudgetError(err)) return ARGUMENT_BUDGET_DENY_RESULT;
      // A path whose ancestors cannot be canonicalized at all is denied
      // rather than evaluated in the caller's unresolved spelling.
      if (isPathResolutionError(err)) return UNRESOLVABLE_PATH_DENY_RESULT;
      throw err;
    }
  }

  private evaluateUntrusted(request: ToolCallRequest, context?: PolicyEvaluationContext): EvaluationResult {
    // Resolve conditional roles once against the actual tool call arguments.
    // After this point, `annotation` has the standard shape: args: Record<string, ArgumentRole[]>
    const annotation = this.getAnnotation(request.serverName, request.toolName, request.arguments);

    // Make an omitted git remote explicit (`origin`, as the git server does) so
    // the structural domain gate and compiled `domains` conditions evaluate
    // the remote that will actually be used. This only rewrites arguments; the
    // remote is resolved by the structural checks once the call's paths have
    // passed the protected-path check, and only repositories inside the
    // sandbox are read.
    const filledArgs = evaluatedArguments(request.serverName, request.toolName, request.arguments, annotation);

    // A git remote argument that names a local repository (an absolute path,
    // a `~` path, a `file://` URL whatever its host) is a read of that path:
    // the evaluation view gains a synthetic read-path argument holding the
    // path git opens, so the protected-path check, sandbox containment and
    // compiled read-path rules judge it. The original argument keeps its URL
    // role. A local source whose path cannot be established throws
    // PathResolutionError, which evaluate() turns into a deny.
    const view = annotation ? withLocalGitSourceReads(filledArgs, annotation) : { args: filledArgs, annotation };
    const effectiveRequest = view.args === request.arguments ? request : { ...request, arguments: view.args };

    this.domainChecks = new Map();
    this.pathResolutions = new Map();
    try {
      // Structural checks first (protected-path and forbidden-destination
      // denies, sandbox containment, the structural escalations).
      const structural = this.evaluateStructuralInvariants(effectiveRequest, view.annotation, context);
      if (structural.decision) return structural.decision;

      // Compiled rule evaluation (skipping sandbox-resolved roles). It runs
      // even when a structural check escalated: the roles it did not look
      // at (a path outside the sandbox, say) still need their own decision,
      // and a compiled deny must win over the escalation. The domain gate's
      // URL roles are evaluated too (a URL role no rule covers is denied);
      // their resolution stays memoized in `domainChecks`, so compiled
      // `domains` conditions see the gate's answer without another read.
      const compiled = this.evaluateCompiledRules(
        effectiveRequest,
        structural.sandboxResolvedRoles,
        view.annotation,
        this.compiledPolicy.rules,
      );
      // The task scope (if any) only ever adds a restriction to the session
      // policy's result, so a session-policy deny needs no second look.
      let result = compiled;
      if (this.taskScopeRules !== undefined && compiled.decision !== 'deny') {
        const scope = this.evaluateTaskScope(
          effectiveRequest,
          structural.sandboxResolvedRoles,
          view.annotation,
          this.taskScopeRules,
        );
        result = intersectWithTaskScope(compiled, scope);
      }
      for (const escalation of structural.escalations) result = withStructuralEscalation(escalation, result);
      return settleContentAssessment(result, view.annotation);
    } finally {
      this.domainChecks = undefined;
      this.pathResolutions = undefined;
      this.callProtectedEntries = undefined;
    }
  }

  /**
   * The canonical form of a path the call supplies (an argument value, a
   * local repository a remote resolves to), resolved at most once per
   * evaluation: this is the security-relevant resolution and is never
   * skipped, even for arguments the pipeline already canonicalized, since
   * `evaluate()` is also called with raw arguments (the policy verifier,
   * tests).
   */
  private resolvePath(path: string): string {
    const resolutions = this.pathResolutions;
    if (resolutions === undefined) return resolveRealPath(path);
    let resolved = resolutions.get(path);
    if (resolved === undefined) {
      resolved = resolveRealPath(path);
      resolutions.set(path, resolved);
    }
    return resolved;
  }

  /** The canonical sandbox directory, computed when the engine was built. */
  private sandboxRootPath(): string {
    if (this.sandboxRoot === undefined) throw new Error('unreachable: no allowedDirectory to resolve');
    return precomputedPath(this.sandboxRoot);
  }

  /**
   * The canonical form of a compiled rule's `paths.within`, computed when
   * the engine was built. A directory the constructor did not see (a rule
   * object assembled during evaluation) is resolved like a call path.
   */
  private ruleDirectory(within: string): string {
    if (this.unsafeRuleDirectories.has(within)) throw new UnsafePolicyRootError();
    const precomputed = this.ruleDirectories.get(within);
    return precomputed === undefined ? this.resolvePath(within) : precomputedPath(precomputed);
  }

  /**
   * The protected entries, canonicalized once per evaluation and only when
   * the call has a path to check. They are not precomputed with the trusted
   * directories: a protected entry is matched by what it names at the time
   * of the call, so a symlink created later at a protected name (or at a
   * missing ancestor of one) moves the protection to its target instead of
   * leaving the target readable, and a dangling one protects the missing
   * target it leads to (see protected-paths.ts).
   */
  private protectedEntriesForCall(): readonly ResolvedProtectedEntry[] {
    if (this.callProtectedEntries !== undefined) return this.callProtectedEntries;
    const entries = resolveProtectedEntries(this.protectedPaths, (entry) => this.resolvePath(entry));
    if (this.pathResolutions !== undefined) this.callProtectedEntries = entries;
    return entries;
  }

  /** The protected-path decision for a canonical path (see isProtectedResolvedPath). */
  private isProtectedResolved(resolvedPath: string): boolean {
    const sandbox = this.allowedDirectory ? this.sandboxRootPath() : undefined;
    return isProtectedResolvedPath(resolvedPath, this.protectedEntriesForCall(), sandbox);
  }

  /**
   * Resolves a URL-role argument to every destination domain it reaches,
   * memoized for the current evaluation. Named git remotes are read only from
   * repositories inside the sandbox (see `resolveUrlForDomainCheck`).
   */
  private checkUrl(value: string, role: ArgumentRole, args: Record<string, unknown>): DomainCheckTarget {
    const repoPath = typeof args.path === 'string' ? args.path : '';
    const key = `${role}\u0000${repoPath}\u0000${value}`;
    const cached = this.domainChecks?.get(key);
    if (cached !== undefined) return cached;
    const target = resolveUrlForDomainCheck(value, role, args, { allowedDirectory: this.allowedDirectory });
    this.domainChecks?.set(key, target);
    return target;
  }

  /**
   * The untrusted domain gate: escalates when any URL-role argument reaches a
   * destination outside the server's allowlist (`['*']` for a server without
   * one, so names pass and IP literals escalate), or a destination that
   * cannot be verified. A git remote argument that is a local repository
   * path, and nothing else, is left to the read-path evaluation of that path
   * (see withLocalGitSourceReads). Returns undefined when every destination
   * passes.
   *
   * The escalation names every URL role that failed (the reason describes
   * the first failure). It is not a final decision: the caller still runs
   * the compiled rules and combines the two, and a deny among the call's
   * roles wins (see withStructuralEscalation).
   */
  private evaluateDomainGate(request: ToolCallRequest, annotation: ToolAnnotation): EvaluationResult | undefined {
    const allowlist = this.serverDomainAllowlists.get(request.serverName) ?? DEFAULT_DOMAIN_GATE;

    let reason: string | undefined;
    const failedRoles = new Set<ArgumentRole>();
    for (const { value, role } of extractAnnotatedUrls(request.arguments, annotation, getUrlRoles())) {
      const target = this.checkUrl(value, role, request.arguments);
      if (target.status === 'unverifiable' && target.localSource) continue;
      const offList = target.domains.find((domain) => !domainMatchesAllowlist(domain, allowlist));
      let failure: string | undefined;
      if (offList !== undefined) {
        failure = `URL domain ${describeDomainForReason(offList)} is not in the allowlist for server "${request.serverName}"`;
      } else if (target.status === 'unverifiable') {
        const resolvesTo = describeDomainsForReason(target.domains);
        failure =
          `Cannot verify where ${describeUrlArgument(value, role)} connects for server ` +
          `"${request.serverName}": ${target.reason}` +
          (resolvesTo === '' ? '' : ` (resolves to ${resolvesTo})`);
      }
      if (failure === undefined) continue;
      failedRoles.add(role);
      reason ??= failure;
    }
    // Passing only means "not suspicious enough to block structurally". URL
    // roles are NOT marked as resolved; compiled rules still evaluate the
    // operation (e.g. "escalate all git push").
    if (reason === undefined) return undefined;
    return {
      decision: 'escalate',
      rule: STRUCTURAL_DOMAIN_ESCALATE_RULE,
      reason,
      escalatedRoles: [...failedRoles],
    };
  }

  /**
   * True when a git remote argument resolves, through a configured remote or
   * a URL rewrite, to a local repository inside a protected path. A remote
   * argument that is itself a local path is a read-path in the evaluation
   * view (withLocalGitSourceReads) and was checked with the other paths; this
   * covers the paths only the repository or the user's config names. The
   * resolution is memoized, so the domain gate reuses it.
   */
  private remoteReachesProtectedPath(request: ToolCallRequest, annotation: ToolAnnotation): boolean {
    for (const { value, role } of extractAnnotatedUrls(request.arguments, annotation, ['git-remote-url'])) {
      const target = this.checkUrl(value, role, request.arguments);
      if (target.status !== 'unverifiable') continue;
      for (const localPath of target.localPaths ?? []) {
        if (this.isProtectedResolved(this.resolvePath(localPath))) return true;
      }
    }
    return false;
  }

  /**
   * True when a fetch-url argument reaches a local, private-network or
   * cloud-metadata host (see isLocalOrMetadataHost). Such a destination is
   * denied structurally: no allowlist entry and no compiled rule can admit
   * it. The resolution is memoized, so the domain gate reuses it.
   */
  private reachesLocalDestination(request: ToolCallRequest, annotation: ToolAnnotation): boolean {
    for (const { value, role } of extractAnnotatedUrls(request.arguments, annotation, ['fetch-url'])) {
      const target = this.checkUrl(value, role, request.arguments);
      if (target.domains.some((domain) => isLocalOrMetadataHost(domain))) return true;
    }
    return false;
  }

  /**
   * True when the engine confines changes to a read-only workspace and the
   * call would change something outside every writable root: it changes a
   * git repository (see `changesRepository`; git acts on the repository that
   * contains its path, so no path value confines it), or some value of a
   * mutation path role (every path role but `read-path`) resolves outside
   * every writable root. Each value is resolved now, following symlinks, and
   * compared with the canonical roots, so a path that leads out of a writable
   * directory through a symlink, `..` or a swapped component is a change
   * outside it. Values of nested arguments count too (see
   * `extractAnnotatedPaths`).
   */
  private changesOutsideWritableRoots(request: ToolCallRequest, annotation: ToolAnnotation): boolean {
    const roots = this.writableRoots;
    if (roots === undefined) return false;
    if (changesRepository(request.serverName, annotation)) return true;
    for (const value of extractAnnotatedPaths(request.arguments, annotation, MUTATION_PATH_ROLES)) {
      const resolved = this.resolvePath(value);
      if (!roots.some((root) => isWithinResolvedDirectory(resolved, root))) return true;
    }
    return false;
  }

  /**
   * Structural escalation for a write or delete whose path has a `.git`
   * component (see hasGitInternalsSegment), on any server. The content of a
   * `.git` directory, and a gitfile named `.git`, configure host git; sandbox
   * containment does not make writing them safe, so the escalation is
   * recorded even when the role is sandbox-resolved. Reads are unaffected.
   */
  private evaluateGitInternals(request: ToolCallRequest, annotation: ToolAnnotation): EvaluationResult | undefined {
    const roles: ArgumentRole[] = [];
    for (const role of GIT_INTERNALS_ROLES) {
      const paths = extractAnnotatedPaths(request.arguments, annotation, [role]);
      if (paths.some((p) => hasGitInternalsSegment(this.resolvePath(p)))) roles.push(role);
    }
    if (roles.length === 0) return undefined;
    return {
      decision: 'escalate',
      rule: STRUCTURAL_GIT_INTERNALS_ESCALATE,
      reason: GIT_INTERNALS_ESCALATE_REASON,
      escalatedRoles: roles,
    };
  }

  /**
   * Structural escalation for a git call on a repository host git must not
   * run in unseen (see inspectRepositoryForPolicy): every path-role value of
   * the call, local clone sources included, is inspected once. The
   * escalation names every path role whose value was flagged.
   */
  private evaluateGitRepository(request: ToolCallRequest, annotation: ToolAnnotation): EvaluationResult | undefined {
    // This pathless tool reads the backend's stored working directory to
    // collect status/log/tag data. No annotated path reaches inspection, so
    // require a fresh human decision even under an older compiled allow.
    if (request.toolName === 'git_wrapup_instructions') {
      return {
        decision: 'escalate',
        rule: STRUCTURAL_GIT_REPOSITORY_ESCALATE,
        reason: 'Git wrap-up reads the server session repository; human approval is required for each call',
        humanOnly: true,
      };
    }
    const sandboxRoot = this.allowedDirectory === undefined ? undefined : this.sandboxRootPath();
    const inspected = new Map<string, string | undefined>();
    // Paths in one repository share its inspection, which walks the git dir.
    const repositories: RepositoryInspections = new Map();
    const roles: ArgumentRole[] = [];
    let reason: string | undefined;
    for (const role of getPathRoles()) {
      for (const value of extractAnnotatedPaths(request.arguments, annotation, [role])) {
        const canonical = this.resolvePath(value);
        if (!inspected.has(canonical)) {
          inspected.set(canonical, inspectRepositoryForPolicy(canonical, sandboxRoot, repositories));
        }
        const problem = inspected.get(canonical);
        if (problem === undefined) continue;
        reason ??= problem;
        if (!roles.includes(role)) roles.push(role);
      }
    }
    if (reason === undefined) return undefined;
    return { decision: 'escalate', rule: STRUCTURAL_GIT_REPOSITORY_ESCALATE, reason, escalatedRoles: roles };
  }

  /**
   * Git selectors are pathspecs/object expressions, not ordinary filesystem
   * arguments. Refuse the whole repository when it contains a specific
   * protected entry, without normalizing or forwarding synthetic selectors.
   */
  private evaluateGitProtectedRepository(
    request: ToolCallRequest,
    annotation: ToolAnnotation,
    context: PolicyEvaluationContext | undefined,
  ): EvaluationResult | undefined {
    // Clearing state does not inspect a repository and must remain possible.
    if (request.toolName === 'git_clear_working_dir') return undefined;
    const paths = extractAnnotatedPaths(request.arguments, annotation, getPathRoles());
    if (request.toolName === 'git_wrapup_instructions') {
      if (!context?.gitWorkingDirectory || !isAbsolute(expandTilde(context.gitWorkingDirectory)))
        return GIT_CONTEXT_DENY_RESULT;
      paths.push(context.gitWorkingDirectory);
    } else {
      // `path` is the backend's repository selector even in an old/custom
      // annotation that marks it opaque. This admission check must not depend
      // on that classification or rewrite the selector sent to the backend.
      const selected = ownArgument(request.arguments, 'path');
      if (typeof selected === 'string' && selected.trim() !== '' && selected !== '.') {
        assertArgumentValueBudget({ path: selected }, { args: { path: ['read-path'] } }, this.argumentValueLimits);
        let selectedForCheck = expandTilde(selected);
        if (!isAbsolute(selectedForCheck)) {
          if (!context?.gitWorkingDirectory || !isAbsolute(expandTilde(context.gitWorkingDirectory)))
            return GIT_CONTEXT_DENY_RESULT;
          selectedForCheck = resolve(expandTilde(context.gitWorkingDirectory), selectedForCheck);
        }
        for (let index = 0; index < paths.length; index++) {
          if (paths[index] === selected) paths[index] = selectedForCheck;
        }
        if (!paths.includes(selectedForCheck)) paths.push(selectedForCheck);
      } else if (paths.length === 0 && context?.gitWorkingDirectory) {
        paths.push(context.gitWorkingDirectory);
      }
    }
    if (paths.length === 0) return GIT_CONTEXT_DENY_RESULT;
    const sandbox = this.allowedDirectory === undefined ? undefined : this.sandboxRootPath();
    const roots = new Set<string>();
    for (const path of paths) {
      const canonical = this.resolvePath(path);
      const stopAt = sandbox !== undefined && namedInside(canonical, sandbox) ? sandbox : undefined;
      roots.add(findRepoRoot(canonical, stopAt) ?? canonical);
    }
    const entries = this.protectedEntriesForCall();
    for (const root of roots) {
      if (this.isProtectedResolved(root) || containsProtectedResolvedPath(root, entries)) {
        return GIT_PROTECTED_REPOSITORY_RESULT;
      }
    }
    return undefined;
  }

  /**
   * Structural escalation for a call whose argument carrying a role (any
   * role but `none`) holds a value policy cannot evaluate value by value:
   * an object, an array with an element that is not a string or a number, a
   * boolean (see `argumentValues`). Role annotations describe the argument
   * as a whole, so no per-value decision can say what such a structure means
   * to the server: which leaf the server reads as the path, whether a flag
   * beside the addresses widens access (`editors.domainUsersCanEdit` of the
   * gsheets protected-range tools), or how the transport would spell a value
   * the pipeline does not canonicalize.
   *
   * Every string and number inside the value is still extracted as a value
   * of the argument's roles, so the protected-path and forbidden-destination
   * denies and the compiled rules judge each of them; this escalation makes
   * sure what remains never passes on those values alone. It is human-only:
   * the auto-approver and the approval whitelist only see top-level values,
   * so neither may discharge it.
   */
  private evaluateNestedArguments(request: ToolCallRequest, annotation: ToolAnnotation): EvaluationResult | undefined {
    const roles = new Set<ArgumentRole>();
    for (const [argName, argRoles] of Object.entries(annotation.args)) {
      const evaluatedRoles = argRoles.filter((role) => role !== 'none');
      if (evaluatedRoles.length === 0) continue;
      if (!isStructuredValue(ownArgument(request.arguments, argName))) continue;
      for (const role of evaluatedRoles) roles.add(role);
    }
    if (roles.size === 0) return undefined;
    return {
      decision: 'escalate',
      rule: STRUCTURAL_NESTED_ARGUMENT_ESCALATE,
      reason: NESTED_ARGUMENT_ESCALATE_REASON,
      escalatedRoles: [...roles],
      humanOnly: true,
    };
  }

  /**
   * Hardcoded structural invariants.
   *
   * The evaluation order is security-critical and must not be reordered:
   * 1. Protected path check (deny) -- must be first. It runs before sandbox
   *    containment, and its sandbox exemption only covers protected entries
   *    that strictly contain the sandbox, so a protected entry inside the
   *    sandbox (e.g. a workspace's `.env`) is denied, never sandbox-allowed.
   *    A local git clone source is among the paths it checks, and so is a
   *    local repository a git remote resolves to (checked after the others,
   *    since resolving the remote reads the repository config).
   * 2. Forbidden fetch destinations (deny): a fetch-url that names a local,
   *    private-network or cloud-metadata host.
   * 3. Read-only workspace (deny): a write, delete or history rewrite
   *    outside the writable directories, or any change to a git
   *    repository, when the engine has a read-only workspace. Before
   *    sandbox containment, which would allow it.
   * 4. Filesystem sandbox containment for path-category roles (allow/partial)
   * 5. Structural escalations, recorded in `escalations` rather than
   *    returned: the untrusted domain gate for url-category roles, a write
   *    or delete inside `.git`, a git repository whose layout or config
   *    host git must not act on unseen, and a role-bearing argument holding
   *    a nested object or array (human-only). The caller combines them with
   *    the compiled rules, where a deny still wins.
   * 6. Unknown tool denial (deny)
   *
   * Returns a StructuralResult with either a final decision, or the roles
   * resolved by sandbox containment plus the structural escalations.
   */
  private evaluateStructuralInvariants(
    request: ToolCallRequest,
    annotation: ToolAnnotation | undefined,
    context?: PolicyEvaluationContext,
  ): StructuralResult {
    // Protected path check and sandbox containment use path-category roles
    // only (not URL roles). Each path is resolved once for the whole call.
    const pathRoles = getPathRoles();
    const annotatedPaths = annotation ? extractAnnotatedPaths(request.arguments, annotation, pathRoles) : [];
    const resolvedPaths = annotatedPaths.map((p) => this.resolvePath(p));

    // Protected path check -- any match is an immediate deny. Matching is
    // case/Unicode-insensitive and the sandbox exemption is per entry; see
    // protected-paths.ts.
    for (const rp of resolvedPaths) {
      if (this.isProtectedResolved(rp)) {
        return finalDecision(PROTECTED_PATH_DENY_RESULT);
      }
    }
    // Moving/deleting a parent removes or relocates its protected children.
    // Read operands deliberately keep the ordinary equal/inside check above.
    if (annotation) {
      for (const path of extractAnnotatedPaths(request.arguments, annotation, ['delete-path'])) {
        if (containsProtectedResolvedPath(this.resolvePath(path), this.protectedEntriesForCall())) {
          return finalDecision(PROTECTED_PATH_DENY_RESULT);
        }
      }
    }

    // Admission precedes remote/config inspection and all backend effects.
    if (annotation && isGitBackend(request.serverName)) {
      const refused = this.evaluateGitProtectedRepository(request, annotation, context);
      if (refused !== undefined) return finalDecision(refused);
    }

    // A protected repository reached through a git remote's configuration.
    // Resolving the remote reads the repository config, so it runs only once
    // the repository path itself has passed the protected-path check.
    if (annotation && this.remoteReachesProtectedPath(request, annotation)) {
      return finalDecision(PROTECTED_PATH_DENY_RESULT);
    }

    // Forbidden fetch destinations -- a deny no compiled rule can override.
    if (annotation && this.reachesLocalDestination(request, annotation)) {
      return finalDecision(LOCAL_DESTINATION_DENY_RESULT);
    }

    // Read-only workspace -- a change outside the writable directories is a
    // deny no compiled rule can override. It runs before sandbox containment,
    // which would otherwise allow every change inside the sandbox.
    if (annotation && this.changesOutsideWritableRoots(request, annotation)) {
      return finalDecision(READ_ONLY_WORKSPACE_DENY_RESULT);
    }

    // Introspection tool: allow list_allowed_directories from the filesystem
    // server when it has no arguments. Placed after the protected-path check
    // and scoped to server + annotation to prevent a different server's tool
    // with the same name from being auto-allowed.
    if (
      request.toolName === 'list_allowed_directories' &&
      request.serverName === 'filesystem' &&
      annotation &&
      Object.keys(request.arguments).length === 0
    ) {
      return finalDecision({
        decision: 'allow',
        rule: 'structural-introspection-allow',
        reason: 'Introspection tool is always allowed',
      });
    }

    // Filesystem sandbox containment (path-category roles)
    //
    // Only SANDBOX_SAFE_PATH_ROLES (read-path, write-path, delete-path,
    // write-history, delete-history) can be auto-resolved by sandbox containment.
    // The history roles are sandbox-safe by design: inside the sandbox they
    // act on the agent's working repository, whose files the agent can
    // already rewrite or delete. What containment does not make safe is
    // configuration that host git executes: a write or delete inside `.git`
    // (evaluateGitInternals; Docker Agent Mode writes the bind mount without
    // a tool call) and a repository whose layout or config redirects outside
    // the sandbox or runs programs (evaluateGitRepository) are escalated below
    // even when their roles are sandbox-resolved here, and the hardened git
    // backend environment pins the fixed-name keys (git-backend-env.ts).
    const sandboxResolvedRoles = new Set<ArgumentRole>();
    const resolvedSandboxPaths = resolvedPaths;

    if (this.allowedDirectory && resolvedSandboxPaths.length > 0) {
      const isFilesystem = request.serverName === 'filesystem';
      const isGit = request.serverName === 'git';

      // Per-role sandbox resolution: a role is "sandbox-resolved" if every
      // path for that role is within the sandbox, removing it from compiled
      // rule evaluation. Remaining roles (e.g., git-remote-url) still run
      // through compiled rules.
      //
      // Applied to filesystem and git. For git tools with URL roles
      // (e.g., git_clone with write-path + git-remote-url), the path role is
      // sandbox-resolved while the URL role goes to compiled rules independently.
      if ((isFilesystem || isGit) && annotation) {
        const sandboxRoot = this.sandboxRootPath();
        for (const role of pathRoles) {
          if (!SANDBOX_SAFE_PATH_ROLES.has(role)) continue;
          const pathsForRole = extractAnnotatedPaths(request.arguments, annotation, [role]);
          if (
            pathsForRole.length > 0 &&
            pathsForRole.every((p) => isWithinResolvedDirectory(this.resolvePath(p), sandboxRoot))
          ) {
            sandboxResolvedRoles.add(role);
          }
        }
      }
    }

    // Unknown tool denial
    if (!annotation) {
      return finalDecision({
        decision: 'deny',
        rule: 'structural-unknown-tool',
        reason: `Unknown tool: ${request.serverName}/${request.toolName}`,
      });
    }

    // Structural escalations. None is returned as a final decision: the
    // domain gate used to be, which skipped the compiled rules, so a path the
    // policy denies was escalated (and an approval or whitelist pattern
    // covered only the URL). The caller combines each with the compiled-rule
    // result instead, so no role is skipped: a repository path outside every
    // permitted directory is still denied when its remote also fails the
    // gate. The last escalation supplies the rule and reason, so an argument
    // policy cannot evaluate value by value (evaluateNestedArguments, which
    // makes the call human-only) is named ahead of a repository problem,
    // which is named ahead of a `.git` write, which is named ahead of the
    // domain gate.
    //
    // Untrusted domain gate for URL-category roles. It sees the remote that
    // will actually be used: evaluate() has already filled an omitted git
    // remote with `origin`, and named remotes, push URLs and URL rewrites are
    // resolved from the repository config (inside the sandbox only). Every
    // server with `sandbox.network.allowedDomains` in mcp-servers.json
    // (extractServerDomainAllowlists in config/index.ts; git and
    // google-workspace in the shipped config) is gated by its allowlist; any
    // other server with URL roles (fetch, which runs with `sandbox: false`,
    // and custom servers) by the default `['*']`, which passes names and
    // escalates IP literals. Under the shipped compiled policy every git
    // push/pull/fetch/clone escalates regardless of domain.
    const escalations: EvaluationResult[] = [];
    const domainEscalation = this.evaluateDomainGate(request, annotation);
    if (domainEscalation) escalations.push(domainEscalation);
    const gitInternals = this.evaluateGitInternals(request, annotation);
    if (gitInternals) escalations.push(gitInternals);
    if (isGitBackend(request.serverName)) {
      const repository = this.evaluateGitRepository(request, annotation);
      if (repository) escalations.push(repository);
    }
    const nestedArguments = this.evaluateNestedArguments(request, annotation);
    if (nestedArguments) escalations.push(nestedArguments);

    return {
      sandboxResolvedRoles: sandboxResolvedRoles.size > 0 ? sandboxResolvedRoles : NO_ROLES_RESOLVED,
      escalations: escalations.length > 0 ? escalations : NO_ESCALATIONS,
    };
  }

  /**
   * Compiled rule evaluation: evaluate declarative rules from compiled-policy.json.
   *
   * For tools with multiple roles (e.g., edit_file has read-path + write-path),
   * each role is evaluated independently through the rule chain. The most
   * restrictive result across all roles wins (deny > escalate > allow).
   * Roles already resolved by sandbox containment are skipped.
   *
   * For tools with no roles (e.g., list_allowed_directories), the chain is
   * evaluated once without role filtering.
   *
   * `rules` is the session policy's rule chain (the task scope's goes
   * through `evaluateTaskScope`).
   */
  private evaluateCompiledRules(
    request: ToolCallRequest,
    sandboxResolvedRoles: ReadonlySet<ArgumentRole>,
    annotation: ToolAnnotation | undefined,
    rules: readonly CompiledRule[],
  ): EvaluationResult {
    if (!annotation) {
      throw new Error(`Missing annotation for ${request.serverName}/${request.toolName} in compiled rule evaluation`);
    }
    const allRoles = collectDistinctRoles(annotation);

    // Filter out roles already resolved by sandbox containment
    const rolesToEvaluate = allRoles.filter((r) => !sandboxResolvedRoles.has(r));

    // All resource roles were sandbox-resolved → allow
    if (allRoles.length > 0 && rolesToEvaluate.length === 0) {
      return {
        decision: 'allow',
        rule: STRUCTURAL_SANDBOX_ALLOW,
        reason: 'All path roles resolved by sandbox containment',
      };
    }

    if (rolesToEvaluate.length === 0) {
      // No resource roles at all (e.g., list_allowed_directories).
      // Run a plain first-match-wins scan with no role scoping.
      return this.evaluateRulesUnscoped(request, annotation, rules);
    }

    let mostRestrictive: EvaluationResult | undefined;
    const escalatedRoles: ArgumentRole[] = [];
    for (const role of rolesToEvaluate) {
      const result = this.evaluateRulesForRole(request, annotation, role, rules);
      if (result.decision === 'deny') return result;
      if (result.decision === 'escalate') {
        escalatedRoles.push(role);
      }
      // The first result of the highest severity wins; a human-only
      // escalation on any role makes the combined escalation human-only.
      mostRestrictive = mostRestrictive ? combineResults(mostRestrictive, result, false) : result;
    }

    if (!mostRestrictive) {
      throw new Error('unreachable: rolesToEvaluate was non-empty but no result was produced');
    }
    // Attach escalated roles when the final decision is escalate
    if (mostRestrictive.decision === 'escalate' && escalatedRoles.length > 0) {
      return { ...mostRestrictive, escalatedRoles };
    }
    return mostRestrictive;
  }

  /**
   * The task scope's verdict on a call the session policy did not deny:
   * undefined when the task scope allows it, otherwise the escalation (or an
   * explicit task-rule deny) to intersect with the session policy's result.
   *
   * The task rules are evaluated over the same roles as the session policy:
   * roles sandbox containment resolved are allowed (the session's own
   * directory is always in scope), and each remaining role runs through the
   * task rule chain independently (first match wins per role, per path).
   * A role no task rule covers (the default deny) is out of scope: it
   * escalates under `task-scope-escalate` instead of being denied, because
   * the session policy allowed or escalated it and a human may still
   * approve it. A role a task rule escalates escalates under that rule. The
   * escalation names every role the task scope did not allow, so an
   * approval whitelist pattern must cover all of them.
   */
  private evaluateTaskScope(
    request: ToolCallRequest,
    sandboxResolvedRoles: ReadonlySet<ArgumentRole>,
    annotation: ToolAnnotation | undefined,
    rules: readonly CompiledRule[],
  ): EvaluationResult | undefined {
    if (!annotation) {
      throw new Error(`Missing annotation for ${request.serverName}/${request.toolName} in task scope evaluation`);
    }
    const allRoles = collectDistinctRoles(annotation);
    const rolesToEvaluate = allRoles.filter((r) => !sandboxResolvedRoles.has(r));
    if (allRoles.length > 0 && rolesToEvaluate.length === 0) return undefined;

    const outOfScope = (escalatedRoles: readonly ArgumentRole[], humanOnly: boolean): EvaluationResult => ({
      decision: 'escalate',
      rule: TASK_SCOPE_ESCALATE_RULE,
      reason: TASK_SCOPE_ESCALATE_REASON,
      escalatedRoles,
      ...(humanOnly ? { humanOnly: true } : {}),
    });

    if (rolesToEvaluate.length === 0) {
      // No resource roles (an unscoped scan, as for the session policy). An
      // empty `escalatedRoles` means unknown: every consumer then treats the
      // whole call as escalated.
      const result = this.evaluateRulesUnscoped(request, annotation, rules);
      if (result.decision === 'allow') return undefined;
      if (result.decision === 'escalate') return result;
      return result.rule === DEFAULT_DENY_RESULT.rule ? outOfScope([], false) : result;
    }

    const notAllowed: ArgumentRole[] = [];
    let anyOutOfScope = false;
    let ruleEscalation: EvaluationResult | undefined;
    for (const role of rolesToEvaluate) {
      const result = this.evaluateRulesForRole(request, annotation, role, rules);
      if (result.decision === 'allow') continue;
      // An explicit deny rule in the task policy is final (the most
      // restrictive decision wins); only the default deny means out of scope.
      if (result.decision === 'deny' && result.rule !== DEFAULT_DENY_RESULT.rule) return result;
      notAllowed.push(role);
      if (result.decision === 'deny') {
        anyOutOfScope = true;
      } else {
        ruleEscalation = ruleEscalation ? combineResults(ruleEscalation, result, false) : result;
      }
    }
    if (notAllowed.length === 0) return undefined;
    // Out of scope names the escalation (it is what the human must judge);
    // a human-only task rule escalation on any role keeps it human-only.
    if (anyOutOfScope) return outOfScope(notAllowed, ruleEscalation?.humanOnly === true);
    if (!ruleEscalation) {
      throw new Error('unreachable: a role escalated in the task scope without a result');
    }
    return { ...ruleEscalation, escalatedRoles: notAllowed };
  }

  /**
   * Plain first-match-wins rule scan with no role scoping.
   * Used for tools that have no resource roles (e.g., list_allowed_directories).
   */
  private evaluateRulesUnscoped(
    request: ToolCallRequest,
    annotation: ToolAnnotation,
    rules: readonly CompiledRule[],
  ): EvaluationResult {
    for (const rule of rules) {
      if (this.ruleMatches(rule, request, annotation)) {
        return ruleToResult(rule);
      }
    }

    return DEFAULT_DENY_RESULT;
  }

  /**
   * Evaluates the rule chain for a single role.
   *
   * Only rules that are either role-agnostic (no roles/paths conditions)
   * or relevant to the specified role are considered. Path extraction is
   * scoped to the evaluating role so each role can be independently
   * discharged by different rules. First matching rule wins; default deny
   * if none match.
   *
   * For roles with multiple extracted paths, delegates to
   * evaluateRulesForMultiPaths for per-element evaluation.
   */
  private evaluateRulesForRole(
    request: ToolCallRequest,
    annotation: ToolAnnotation,
    evaluatingRole: ArgumentRole,
    rules: readonly CompiledRule[],
  ): EvaluationResult {
    // Per-element evaluation handles single-path and multi-path uniformly.
    // Each extracted path is independently discharged by the first matching
    // rule; the most restrictive decision wins; undischarged paths default-deny.
    const rolePaths = extractAnnotatedPaths(request.arguments, annotation, [evaluatingRole]);
    return this.evaluateRulesForRolePaths(request, annotation, evaluatingRole, rolePaths, rules);
  }

  /**
   * Per-element path evaluation for a role.
   *
   * Each extracted path is independently "discharged" by the first rule
   * whose conditions match it. Rules without path conditions match all
   * remaining paths. The most restrictive decision across all discharged
   * paths wins (deny > escalate > allow). Undischarged paths default-deny.
   *
   * Sandbox containment is applied structurally per-path: for the filesystem
   * server, paths inside the sandbox are auto-discharged with an implicit
   * allow before consulting compiled rules. This keeps the "do NOT emit
   * sandbox `paths.within` rules" compiler invariant intact whether the
   * tool is single-path or multi-path; in the multi-path case it also
   * handles the mixed-directory call (e.g. `read_multiple_files` spanning
   * sandbox + Downloads) that the single-path fast path could not cover.
   *
   * For roles with no extracted paths, falls through to a single linear
   * scan that returns the first matching rule (paths.within is irrelevant
   * when there's nothing to discharge).
   */
  private evaluateRulesForRolePaths(
    request: ToolCallRequest,
    annotation: ToolAnnotation,
    role: ArgumentRole,
    paths: string[],
    rules: readonly CompiledRule[],
  ): EvaluationResult {
    // No paths to discharge: linear scan covers role-agnostic and domain/list
    // rules (first match wins).
    if (paths.length === 0) {
      for (const rule of rules) {
        if (hasRoleConditions(rule) && !ruleRelevantToRole(rule, role)) continue;
        if (this.ruleMatches(rule, request, annotation, role)) return ruleToResult(rule);
      }
      return DEFAULT_DENY_RESULT;
    }

    const remainingPaths = new Set(paths);
    let mostRestrictive: EvaluationResult | undefined;

    // Sandbox containment is structural, not rule-based — the compiler is
    // forbidden from emitting `paths.within: <sandbox>` rules — so we
    // discharge each sandbox-resident path here before consulting compiled
    // rules. Required for mixed-directory calls (e.g. read_multiple_files
    // spanning sandbox + Downloads) where no single rule could match the
    // whole array.
    if (this.allowedDirectory && request.serverName === 'filesystem' && SANDBOX_SAFE_PATH_ROLES.has(role)) {
      const sandboxDir = this.allowedDirectory;
      const sandboxRoot = this.sandboxRootPath();
      let dischargedAny = false;
      for (const p of remainingPaths) {
        if (isWithinResolvedDirectory(this.resolvePath(p), sandboxRoot)) {
          remainingPaths.delete(p);
          dischargedAny = true;
        }
      }
      if (dischargedAny) {
        mostRestrictive = {
          decision: 'allow',
          rule: STRUCTURAL_SANDBOX_ALLOW,
          reason: `Path(s) within the sandbox directory: ${sandboxDir}`,
        };
      }
    }

    for (const rule of rules) {
      if (remainingPaths.size === 0) break;

      // Skip rules not relevant to this role
      if (hasRoleConditions(rule) && !ruleRelevantToRole(rule, role)) continue;

      // Non-path conditions (server, tool, roles) must hold uniformly
      if (!this.ruleMatchesNonPathConditions(rule, request, annotation)) continue;

      // Domain and list conditions apply uniformly across all paths. Check
      // them once via ruleMatches with the path condition stripped — paths
      // are then discharged per-element below.
      if (rule.if.domains !== undefined || rule.if.lists !== undefined) {
        const ruleWithoutPaths: CompiledRule = { ...rule, if: { ...rule.if, paths: undefined } };
        if (!this.ruleMatches(ruleWithoutPaths, request, annotation, role)) continue;
      }

      const cond = rule.if;
      let matched: string[];

      if (cond.paths !== undefined) {
        // Rule has a path condition: discharge only paths within the directory
        const within = this.ruleDirectory(cond.paths.within);
        matched = [];
        for (const p of remainingPaths) {
          if (isWithinResolvedDirectory(this.resolvePath(p), within)) {
            matched.push(p);
          }
        }
        if (matched.length === 0) continue;
      } else {
        // Rule has no path condition: matches all remaining paths
        matched = [...remainingPaths];
      }

      // Discharge matched paths and record decision
      for (const p of matched) remainingPaths.delete(p);

      const result = ruleToResult(rule);
      // Strictly more restrictive always wins. On a severity tie, prefer a
      // compiled rule over the structural sandbox placeholder so audit
      // attribution names the rule that actually authorized this path. A
      // human-only escalation on any path keeps the combined one human-only.
      mostRestrictive = mostRestrictive
        ? combineResults(mostRestrictive, result, mostRestrictive.rule === STRUCTURAL_SANDBOX_ALLOW)
        : result;
    }

    // Any undischarged paths -> default-deny
    if (remainingPaths.size > 0) {
      return DEFAULT_DENY_RESULT;
    }

    if (!mostRestrictive) {
      throw new Error('unreachable: all paths discharged but no result was produced');
    }
    return mostRestrictive;
  }

  /**
   * Checks non-path conditions in a rule's `if` block: roles, server, tool.
   */
  private ruleMatchesNonPathConditions(
    rule: CompiledRule,
    request: ToolCallRequest,
    annotation: ToolAnnotation,
  ): boolean {
    const cond = rule.if;

    if (cond.roles !== undefined) {
      const condRoles = cond.roles;
      const toolHasMatchingRole = Object.values(annotation.args).some((argRoles) =>
        argRoles.some((r) => condRoles.includes(r)),
      );
      if (!toolHasMatchingRole) return false;
    }

    if (cond.server !== undefined && !cond.server.includes(request.serverName)) {
      return false;
    }

    if (cond.tool !== undefined && !cond.tool.includes(request.toolName)) {
      return false;
    }

    return true;
  }

  /**
   * Checks whether all conditions in a rule's `if` block are satisfied.
   *
   * When evaluatingRole is set, path/domain/list extraction is scoped to
   * just that role. This allows a multi-role tool (e.g., move_file with
   * read-path + delete-path on source, write-path on destination) to have
   * each role independently discharged by different rules targeting
   * different directories.
   */
  private ruleMatches(
    rule: CompiledRule,
    request: ToolCallRequest,
    annotation: ToolAnnotation,
    evaluatingRole?: ArgumentRole,
  ): boolean {
    if (!this.ruleMatchesNonPathConditions(rule, request, annotation)) return false;

    // Check paths condition
    const cond = rule.if;
    if (cond.paths !== undefined) {
      const condPaths = cond.paths;
      // When evaluating a specific role, only extract paths for that role
      // (intersected with the rule's declared roles). Otherwise extract all.
      const extractRoles = evaluatingRole ? [evaluatingRole] : condPaths.roles;
      const extracted = extractAnnotatedPaths(request.arguments, annotation, extractRoles);

      // Zero paths extracted = condition not satisfied, rule does not match
      if (extracted.length === 0) return false;

      // Each path is resolved once per evaluation, the rule's directory once
      // per engine; the comparison itself touches no filesystem.
      const within = this.ruleDirectory(condPaths.within);
      const allWithin = extracted.every((p) => isWithinResolvedDirectory(this.resolvePath(p), within));
      if (!allWithin) return false;
    }

    // Check domains condition
    if (cond.domains !== undefined) {
      const condDomains = cond.domains;
      const extractRoles = evaluatingRole ? [evaluatingRole] : condDomains.roles;
      const urlArgs = extractAnnotatedUrls(request.arguments, annotation, extractRoles);

      // Zero URL args extracted = condition not satisfied, rule does not match
      if (urlArgs.length === 0) return false;

      // Every destination of every URL must match; an unverifiable one never does.
      const allMatch =
        this.incompleteListConditions.has(condDomains) ||
        urlArgs.every(({ value, role }) => this.destinationsMatch(value, role, request.arguments, condDomains.allowed));
      if (!allMatch) return false;
    }

    // Check lists conditions
    if (cond.lists !== undefined) {
      for (const listCond of cond.lists) {
        // Scope extraction to the evaluating role only when this list condition
        // targets that role. Otherwise use the condition's own roles — this is
        // necessary for multi-identifier rules (e.g. github-owner + github-repo)
        // where each list condition targets a different role.
        const extractRoles =
          evaluatingRole && listCond.roles.includes(evaluatingRole) ? [evaluatingRole] : listCond.roles;
        if (!this.listConditionMatches(listCond, extractRoles, request, annotation)) return false;
      }
    }

    return true;
  }

  /**
   * True when every value of `roles` matches an entry of the list. A
   * `domains` list on a URL role is matched like a `domains` condition: by
   * every destination the value reaches (`checkUrl`: named git remotes, URL
   * rewrites, push URLs), never by its spelling, so a remote named after an
   * allowed host matches only when it connects there, and a value whose
   * destination cannot be verified matches no entry. Other values are
   * compared as given (`getListMatcher`). No value: no match.
   */
  private listConditionMatches(
    listCond: ListCondition,
    roles: readonly ArgumentRole[],
    request: ToolCallRequest,
    annotation: ToolAnnotation,
  ): boolean {
    const values = extractAnnotatedListValues(request.arguments, annotation, roles);
    if (values.length === 0) return false;
    if (this.incompleteListConditions.has(listCond)) return true;
    const matcher = getListMatcher(listCond.matchType);
    return values.every(({ value, urlRole }) =>
      listCond.matchType === 'domains' && urlRole !== undefined
        ? this.destinationsMatch(value, urlRole, request.arguments, listCond.allowed)
        : listCond.allowed.some((pattern) => matcher(value, pattern)),
    );
  }

  /**
   * True when a URL-role value resolves (see `checkUrl`) and every
   * destination it reaches matches an entry of `allowed`. An unverifiable
   * destination never matches.
   */
  private destinationsMatch(
    value: string,
    role: ArgumentRole,
    args: Record<string, unknown>,
    allowed: readonly string[],
  ): boolean {
    const target = this.checkUrl(value, role, args);
    return (
      target.status === 'resolved' &&
      target.domains.length > 0 &&
      target.domains.every((domain) => domainMatchesAllowlist(domain, allowed))
    );
  }
}
