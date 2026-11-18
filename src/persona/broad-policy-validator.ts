/**
 * src/persona/broad-policy-validator.ts
 *
 * Broad-policy validator (Phase 1c, §7). Passed as the `validateCompiled` hook
 * to `compilePersonaPolicy` by `runPersonaCompile` (persona-compile-service.ts),
 * the path CLI and web-UI compiles share. It runs on the in-memory
 * `CompiledPolicyFile` BEFORE any artifact is written, so a rejection leaves
 * the prior generation's files intact (no partial write). The same findings
 * judge a policy already on disk (policy-breadth-check.ts): `resolvePersona`
 * refuses a broad one for a persona that has not opted in, and opting out
 * moves one aside.
 *
 * It defeats constitution prompt-injection toward an over-permissive policy in a
 * way that is fully LLM-independent: it inspects the COMPILED rules, not the
 * constitution text. A persona may only emit a "broad" policy if it has been
 * explicitly opted in via `setPersonaBroadPolicyOptIn` (the gated
 * `personas.setBroadPolicyOptIn`, or the CLI's `persona compile --allow-broad`)
 * so that `persona.allowBroadPolicy === true`. Otherwise an `allow` rule (or an
 * `assess` rule: an allow subject to the outbound content assessment, which
 * the compile pipeline makes of every allow that can match an outbound
 * channel before this hook runs) is rejected when it has:
 *
 *   - a broad wildcard in `domains.allowed` or `lists[].allowed`, also one that
 *     arrives through a resolved `@list` (see isBroadDomainPattern: `*`, `*.`,
 *     and `*.S` where anyone can register a name under `S`, judged with the
 *     Public Suffix List: `*.com`, `*.co.uk`, `*.github.io`, `*.pages.dev`);
 *   - a `paths.within` that resolves OUTSIDE the persona's workspace dir;
 *   - an unconstrained resource argument. Using the stored tool annotations
 *     the policy was compiled against, every (server, tool) pair the rule can
 *     match is examined, and every role the rule can discharge must be bounded:
 *     URL roles by a `domains` condition, path roles by `paths.within`, and
 *     identifier and email-address roles by a `lists` condition. A rule such as
 *     "allow fetch/http_fetch" with no condition matches every URL, which is
 *     broader than `*` (`*` at least excludes IP literals). Tools without such
 *     roles (web_search, list_allowed_directories) need no condition.
 *
 * `escalate` rules keep a human in the loop on every call, so they are never
 * rejected: a catch-all `escalate` with `domains.allowed: ['*']` is the normal
 * fallthrough. Their breadth (wildcards, out-of-workspace `paths.within`, which
 * also become MCP roots) is still reported as `escalateBreadth`, for the rule
 * delta shown after a compile.
 *
 * Rejection throws {@link BroadPolicyRejectedError}; the orchestrator maps the
 * `code` (`BROAD_POLICY_REJECTED`) onto a terminal `persona.compile.failed`
 * event.
 *
 * ZERO runtime value-imports from src/pipeline: the compiled-policy and
 * annotation shapes are type-only imports. Rule relevance comes from the policy
 * engine's own predicates, so the validator reasons about matching exactly as
 * evaluation does. Path containment uses the live-layer `resolveRealPath`
 * helper (symlink-aware), consistent with the policy engine.
 *
 * @see docs/designs/web-ui-policy-persona-management.md §7
 */

import {
  ARGUMENT_ROLE_REGISTRY,
  getIdentifierRoles,
  getPathRoles,
  getUrlRoles,
  resolveRealPath,
  type ArgumentRole,
} from '../types/argument-roles.js';
import { ruleOutcomeAllows } from '../types/policy-schema.js';
import { isBroadDomainPattern } from '../types/public-suffix.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import { hasRoleConditions, ruleRelevantToRole } from '../trusted-process/policy-engine.js';
import type { ErrorCode } from '../web-ui/web-ui-types.js';
// Type-only — no runtime edge to pipeline.
import type {
  ArgumentRoleSpec,
  CompiledPolicyFile,
  CompiledRule,
  DynamicListsFile,
  StoredToolAnnotation,
  StoredToolAnnotationsFile,
} from '../pipeline/types.js';

export { isBroadDomainPattern };

/** Thrown when a compiled policy is "broad" but the persona is not opted in. */
export class BroadPolicyRejectedError extends Error {
  readonly code: ErrorCode = 'BROAD_POLICY_REJECTED';
  constructor(
    message: string,
    readonly data?: { broadenedDomains: string[]; outOfWorkspacePaths: string[]; unconstrainedAllows: string[] },
  ) {
    super(message);
    this.name = 'BroadPolicyRejectedError';
  }
}

/** Inputs, besides the policy itself, that let the check see what each rule reaches. */
export interface BroadPolicyContext {
  /**
   * Resolved dynamic lists, so a `@list` reference is checked by the values it
   * expands to. Without them only literal patterns are checked.
   */
  readonly dynamicLists?: DynamicListsFile;
  /**
   * The stored tool annotations the policy was compiled against. Without them
   * the check cannot tell which tools a rule reaches, so it fails closed: every
   * `allow` rule without a `domains`, `paths` or `lists` condition counts as
   * unconstrained, even one that only names a tool without resource arguments.
   */
  readonly annotations?: StoredToolAnnotationsFile;
}

/** Findings produced by inspecting a compiled policy for broadening. */
export interface BroadPolicyFindings {
  /**
   * Broad-wildcard entries in an `allow` rule's `domains.allowed` or
   * `lists[].allowed` (the literal pattern, e.g. `*`, `*.com`, `*.github.io`,
   * with ` (via @list)` when it came from a resolved list).
   */
  readonly broadenedDomains: string[];
  /** `allow` rules' `paths.within` values resolving outside the workspace dir. */
  readonly outOfWorkspacePaths: string[];
  /**
   * `allow` rules that leave a resource argument unbounded, one entry per rule
   * and role: `<rule>: <role> on <server>/<tool>, ...`.
   */
  readonly unconstrainedAllows: string[];
  /**
   * Informational: broad wildcards and out-of-workspace `paths.within` on
   * `escalate` rules (`<rule>: <pattern>` / `<rule>: within <path>`). A human
   * approves every such call, so these never cause a rejection.
   */
  readonly escalateBreadth: string[];
}

/**
 * True when the findings (or a rule delta built from them) contain anything
 * that needs the broad-policy opt-in. `escalateBreadth` never does.
 */
export function hasBroadAccess(findings: {
  readonly broadenedDomains: readonly string[];
  readonly outOfWorkspacePaths: readonly string[];
  readonly unconstrainedAllows: readonly string[];
}): boolean {
  return (
    findings.broadenedDomains.length > 0 ||
    findings.outOfWorkspacePaths.length > 0 ||
    findings.unconstrainedAllows.length > 0
  );
}

/** Rule names, list values, paths and tool names are compiler or MCP output; keep them display-safe. */
function display(value: string): string {
  return toDisplayText(value, { maxLength: 200 });
}

/**
 * Expands an `allowed` array (from `domains.allowed` or `lists[].allowed`) into
 * the concrete values to test for breadth. A `@list` reference contributes its
 * EFFECTIVE values (values + manualAdditions − manualRemovals), mirroring
 * `PolicyEngine.getEffectiveListValues` — so a list that RESOLVES to a broad
 * wildcard (e.g. a "major news sites" list containing `*.com`) is caught even
 * though the rule only stores the `@list` symbol and the resolved values live
 * separately in dynamic-lists.json. A missing list contributes nothing: the
 * runtime fails closed (missing `@list` => empty => deny), so there is nothing
 * broad to flag. `via` records the originating `@list` for a clear message.
 */
function expandAllowedForBreadth(
  allowed: readonly string[],
  dynamicLists: DynamicListsFile | undefined,
): { value: string; via?: string }[] {
  const out: { value: string; via?: string }[] = [];
  for (const entry of allowed) {
    if (!entry.startsWith('@')) {
      out.push({ value: entry });
      continue;
    }
    const list = dynamicLists?.lists[entry.slice(1)];
    if (!list) continue;
    const removals = new Set(list.manualRemovals);
    for (const v of new Set([...list.values, ...list.manualAdditions])) {
      if (!removals.has(v)) out.push({ value: v, via: entry });
    }
  }
  return out;
}

/** The broad wildcard patterns a rule allows, literal or through a resolved `@list`. */
function broadPatternsOf(rule: CompiledRule, dynamicLists: DynamicListsFile | undefined): string[] {
  const allowedSets = [rule.if.domains?.allowed ?? [], ...(rule.if.lists ?? []).map((l) => l.allowed)];
  const found: string[] = [];
  for (const allowed of allowedSets) {
    for (const { value, via } of expandAllowedForBreadth(allowed, dynamicLists)) {
      if (isBroadDomainPattern(value)) found.push(via ? `${display(value)} (via ${display(via)})` : display(value));
    }
  }
  return found;
}

/** A rule's `paths.within` (display-safe) when it resolves outside the workspace dir. */
function outOfWorkspacePathOf(rule: CompiledRule, workspaceReal: string): string | undefined {
  const within = rule.if.paths?.within;
  if (within === undefined) return undefined;
  const withinReal = resolveRealPath(within);
  const contained = withinReal === workspaceReal || withinReal.startsWith(workspaceReal + '/');
  return contained ? undefined : display(within);
}

// ---------------------------------------------------------------------------
// Unconstrained resource arguments
// ---------------------------------------------------------------------------

/** The rule condition that bounds the values of a role. */
type Bound = 'domains' | 'paths' | 'lists';

/**
 * The condition each sensitive role needs on an `allow` rule that can
 * discharge it. URL roles are destinations (egress), path roles are local
 * files, identifier roles name the GitHub owner or repository a call acts on,
 * and `email-address` names the recipients of mail, invitations and shares.
 * Every other role (branch names, message bodies, `none`) carries no
 * destination and needs no bound.
 */
const REQUIRED_BOUND: ReadonlyMap<ArgumentRole, Bound> = new Map<ArgumentRole, Bound>([
  ...getUrlRoles().map((role): [ArgumentRole, Bound] => [role, 'domains']),
  ...getPathRoles().map((role): [ArgumentRole, Bound] => [role, 'paths']),
  ...getIdentifierRoles().map((role): [ArgumentRole, Bound] => [role, 'lists']),
  ['email-address', 'lists'],
]);

function isBounded(rule: CompiledRule, role: ArgumentRole, bound: Bound): boolean {
  const cond = rule.if;
  switch (bound) {
    case 'domains':
      return cond.domains?.roles.includes(role) === true;
    case 'paths':
      return cond.paths?.roles.includes(role) === true;
    case 'lists':
      return cond.lists?.some((l) => l.roles.includes(role)) === true;
  }
}

function isResourceRole(role: ArgumentRole): boolean {
  return ARGUMENT_ROLE_REGISTRY.get(role)?.isResourceIdentifier === true;
}

/** The role sets an argument can resolve to: a static spec has one, a conditional spec its default and each `when`. */
function argumentModes(spec: ArgumentRoleSpec): (readonly ArgumentRole[])[] {
  return Array.isArray(spec) ? [spec] : [spec.default, ...spec.when.map((entry) => entry.roles)];
}

/**
 * Every role an annotated tool can carry. A conditional spec contributes its
 * default and all of its `when` roles: a rule must bound a role whenever any
 * call can carry it.
 */
function storedToolRoles(tool: StoredToolAnnotation): Set<ArgumentRole> {
  const roles = new Set<ArgumentRole>();
  for (const spec of Object.values(tool.args)) {
    for (const mode of argumentModes(spec)) for (const role of mode) roles.add(role);
  }
  return roles;
}

/**
 * Whether some call can resolve the tool's annotation to no resource role at
 * all: every argument has a mode without one (so does a tool without
 * arguments). The engine then evaluates that call once, unscoped, and a
 * role-scoped rule takes part through its non-resource roles (a `roles:
 * ['email-address']` rule then matches every recipient). Modes are combined
 * per argument, a superset of the combinations calls can produce.
 */
function mayLackResourceRoles(tool: StoredToolAnnotation): boolean {
  return Object.values(tool.args).every((spec) => argumentModes(spec).some((mode) => !mode.some(isResourceRole)));
}

/**
 * Whether the rule's value conditions can extract anything from a tool with
 * these roles. The engine extracts `paths`/`domains` values for the roles the
 * condition names, and every `lists` entry for its own roles; extracting
 * nothing means the rule does not match. Used only to drop pairs the rule can
 * never match, so it may err towards keeping a pair.
 */
function valueConditionsCanMatch(rule: CompiledRule, roles: ReadonlySet<ArgumentRole>): boolean {
  const cond = rule.if;
  const overlaps = (condRoles: readonly ArgumentRole[]): boolean => condRoles.some((r) => roles.has(r));
  if (cond.paths && !overlaps(cond.paths.roles)) return false;
  if (cond.domains && !overlaps(cond.domains.roles)) return false;
  if (cond.lists && !cond.lists.every((l) => overlaps(l.roles))) return false;
  return true;
}

/**
 * For one `allow` rule, the roles it leaves unbounded, each with the tools
 * (`server/tool`) where that happens.
 *
 * The (server, tool) pairs come from the annotations the way
 * `PolicyEngine.ruleMatchesNonPathConditions` selects them: the `server` and
 * `tool` conditions, and a `roles` condition matching any role of the tool.
 * The engine then evaluates a tool per resource role, and a rule with role
 * conditions takes part only for the roles it is relevant to
 * (`ruleRelevantToRole`); a call whose annotation resolves to no resource role
 * (see {@link mayLackResourceRoles}) is evaluated once, unscoped. `email-address`
 * is not a resource role, so it is checked whenever the rule can take part in
 * the call at all.
 */
function findUnboundedRoles(rule: CompiledRule, annotations: StoredToolAnnotationsFile): Map<ArgumentRole, string[]> {
  const unbounded = new Map<ArgumentRole, string[]>();
  const cond = rule.if;
  const roleScoped = hasRoleConditions(rule);
  for (const [serverName, server] of Object.entries(annotations.servers)) {
    if (cond.server !== undefined && !cond.server.includes(serverName)) continue;
    for (const tool of server.tools) {
      if (cond.tool !== undefined && !cond.tool.includes(tool.toolName)) continue;
      const roles = storedToolRoles(tool);
      if (cond.roles !== undefined && !cond.roles.some((r) => roles.has(r))) continue;
      if (!valueConditionsCanMatch(rule, roles)) continue;

      const takesPart =
        !roleScoped ||
        mayLackResourceRoles(tool) ||
        [...roles].some((r) => isResourceRole(r) && ruleRelevantToRole(rule, r));
      if (!takesPart) continue;

      for (const role of roles) {
        const bound = REQUIRED_BOUND.get(role);
        if (bound === undefined) continue;
        if (isResourceRole(role) && roleScoped && !ruleRelevantToRole(rule, role)) continue;
        if (isBounded(rule, role, bound)) continue;
        const tools = unbounded.get(role) ?? [];
        tools.push(`${serverName}/${tool.toolName}`);
        unbounded.set(role, tools);
      }
    }
  }
  return unbounded;
}

/** Most tools named per finding; the rest are counted. */
const MAX_TOOLS_PER_FINDING = 3;

function describeUnbounded(rule: CompiledRule, role: ArgumentRole, tools: readonly string[]): string {
  const shown = tools.slice(0, MAX_TOOLS_PER_FINDING).map(display).join(', ');
  const more = tools.length > MAX_TOOLS_PER_FINDING ? ` (+${tools.length - MAX_TOOLS_PER_FINDING} more)` : '';
  return `${display(rule.name)}: ${role} on ${shown}${more}`;
}

/** True when a rule bounds argument values at all (some `domains`, `paths` or `lists` condition). */
function hasValueCondition(rule: CompiledRule): boolean {
  return rule.if.domains !== undefined || rule.if.paths !== undefined || (rule.if.lists?.length ?? 0) > 0;
}

/** The unconstrained-argument findings for one `allow` rule. */
function unconstrainedFindingsOf(rule: CompiledRule, annotations: StoredToolAnnotationsFile | undefined): string[] {
  if (annotations === undefined) {
    return hasValueCondition(rule)
      ? []
      : [`${display(rule.name)}: no domains, paths or lists condition (tool annotations unavailable)`];
  }
  return [...findUnboundedRoles(rule, annotations)].map(([role, tools]) => describeUnbounded(rule, role, tools));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * True iff an `allowed` array (`domains.allowed` or `lists[].allowed`) grants a
 * broad wildcard ({@link isBroadDomainPattern}), counting the effective values
 * of any `@list` reference when `dynamicLists` is supplied.
 */
export function hasBroadAllowance(allowed: readonly string[], dynamicLists?: DynamicListsFile): boolean {
  return expandAllowedForBreadth(allowed, dynamicLists).some(({ value }) => isBroadDomainPattern(value));
}

/**
 * Inspects a compiled policy and returns the set of "broad" findings. Pure /
 * side-effect-free so it can also feed the ruleDelta computation. A path is
 * "out of workspace" iff its real-resolved form is neither the workspace dir
 * nor a descendant of it. `allow` and `assess` rules (see `ruleOutcomeAllows`)
 * produce the findings that need the opt-in; `escalate` rules only produce
 * `escalateBreadth`. Supply the
 * {@link BroadPolicyContext} the policy was compiled with: the resolved lists
 * expand `@list` references, and the annotations show which tools and roles
 * each rule reaches.
 */
export function findBroadPolicy(
  policy: CompiledPolicyFile,
  workspaceDir: string,
  context: BroadPolicyContext = {},
): BroadPolicyFindings {
  const broadenedDomains = new Set<string>();
  const outOfWorkspacePaths = new Set<string>();
  const unconstrainedAllows = new Set<string>();
  const escalateBreadth = new Set<string>();

  const workspaceReal = resolveRealPath(workspaceDir);

  for (const rule of policy.rules) {
    const broadPatterns = broadPatternsOf(rule, context.dynamicLists);
    const outsidePath = outOfWorkspacePathOf(rule, workspaceReal);
    if (ruleOutcomeAllows(rule.then)) {
      for (const pattern of broadPatterns) broadenedDomains.add(pattern);
      if (outsidePath !== undefined) outOfWorkspacePaths.add(outsidePath);
      for (const finding of unconstrainedFindingsOf(rule, context.annotations)) unconstrainedAllows.add(finding);
    } else if (rule.then === 'escalate') {
      for (const pattern of broadPatterns) escalateBreadth.add(`${display(rule.name)}: ${pattern}`);
      if (outsidePath !== undefined) escalateBreadth.add(`${display(rule.name)}: within ${outsidePath}`);
    }
  }

  return {
    broadenedDomains: [...broadenedDomains],
    outOfWorkspacePaths: [...outOfWorkspacePaths],
    unconstrainedAllows: [...unconstrainedAllows],
    escalateBreadth: [...escalateBreadth],
  };
}

/** Most entries per category named in a rejection message; `data` carries all of them. */
const MAX_LISTED_PER_CATEGORY = 10;

function listForMessage(entries: readonly string[]): string {
  // Entries are display-safe already (built from display()-ed parts).
  const shown = entries.slice(0, MAX_LISTED_PER_CATEGORY).join('; ');
  const more = entries.length - MAX_LISTED_PER_CATEGORY;
  return more > 0 ? `${shown}; and ${more} more` : shown;
}

/** The categories of broad access, each with its display label, in message order. */
const BROAD_ACCESS_CATEGORIES = [
  ['broadenedDomains', 'broad wildcard domain/list access'],
  ['outOfWorkspacePaths', 'out-of-workspace path(s)'],
  ['unconstrainedAllows', 'allow rule(s) with unconstrained arguments'],
] as const;

/**
 * The broad access in `findings` that needs the opt-in, one entry per
 * non-empty category (`<label>: <entries>`, at most ten entries each). Entries
 * are display-safe. `escalateBreadth` is never listed.
 */
export function describeBroadAccess(findings: {
  readonly broadenedDomains: readonly string[];
  readonly outOfWorkspacePaths: readonly string[];
  readonly unconstrainedAllows: readonly string[];
}): string[] {
  return BROAD_ACCESS_CATEGORIES.filter(([key]) => findings[key].length > 0).map(
    ([key, label]) => `${label}: ${listForMessage(findings[key])}`,
  );
}

/**
 * Builds a `validateCompiled` hook bound to a persona's workspace dir and
 * opt-in flag. When `allowBroadPolicy` is true the hook is a no-op (broadening
 * is permitted); otherwise it throws {@link BroadPolicyRejectedError} on any
 * broad `allow` finding. The pipeline passes the resolved dynamic lists and
 * the stored tool annotations; a caller that omits the annotations gets the
 * fail-closed check described on {@link BroadPolicyContext.annotations}.
 */
export function makeBroadPolicyValidator(
  workspaceDir: string,
  allowBroadPolicy: boolean,
): (policy: CompiledPolicyFile, dynamicLists?: DynamicListsFile, annotations?: StoredToolAnnotationsFile) => void {
  return (
    policy: CompiledPolicyFile,
    dynamicLists?: DynamicListsFile,
    annotations?: StoredToolAnnotationsFile,
  ): void => {
    if (allowBroadPolicy) return;
    const findings = findBroadPolicy(policy, workspaceDir, { dynamicLists, annotations });
    if (!hasBroadAccess(findings)) return;
    throw new BroadPolicyRejectedError(
      `Compiled policy is too broad (${describeBroadAccess(findings).join('; ')}). ` +
        'Enable broad policy for this persona to allow it.',
      {
        broadenedDomains: findings.broadenedDomains,
        outOfWorkspacePaths: findings.outOfWorkspacePaths,
        unconstrainedAllows: findings.unconstrainedAllows,
      },
    );
  };
}
