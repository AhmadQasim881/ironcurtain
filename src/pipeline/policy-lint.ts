/**
 * Deterministic policy lint: checks compiled rules against the tool
 * annotations and rejects rule shapes that grant more than a constitution
 * should ever get by accident.
 *
 * The compiler is an LLM. A rule can satisfy the schema, the verifier's
 * scenarios and the judge and still allow far too much, so every compile path
 * (global, persona, cron) runs this check:
 *
 *  - after the compiler answers, feeding errors back for a repair turn;
 *  - after the rule set's dynamic lists are resolved (their values count);
 *  - on per-server cache hits (failing rules are recompiled, not served);
 *  - on the merged policy, just before it is written.
 *
 * Errors (allow rules only, except duplicate names; an `assess` rule is an
 * allow subject to the outbound content assessment and is linted as one, see
 * `ruleOutcomeAllows`):
 *  - `duplicate-rule-name`: two rules for the same servers share a name
 *    (point-fix repairs address rules by name).
 *  - `server-wide-allow`: an allow with no tool and no role, path, domain or
 *    list constraint matches every tool of its servers, including tools a
 *    server adds later. A roles filter counts only when every role in it is
 *    a resource role: `none` and other non-resource roles widen it to every
 *    tool with such an argument.
 *  - `condition-role-mismatch`: an allow applies a condition to roles it
 *    cannot constrain: `paths` to a non-path role, `domains` (or a
 *    domain-matched list) to a non-URL role, a list to a path role. The
 *    engine still applies it, and it matches far more than it seems to (a
 *    path's hostname is empty, which `""` and `*` match; an owner name is
 *    resolved as a path under the working directory), so it limits nothing.
 *  - `unconstrained-mutation-allow`: an allow that discharges a write, delete
 *    or history role (write-path, delete-path, write-history,
 *    delete-history) with no `paths.within`. A role-agnostic allow on a tool
 *    with such a role (in any mode of a conditional annotation) is one, and
 *    so is one whose only condition on the role is a domain or list.
 *  - `side-effect-tool-allow`: a tool the MCP server marks as changing state
 *    (`mcpHints`) is allowed for every input by the rules that reach it
 *    first. Hints only ever add this finding; they never exempt a tool.
 *  - `broad-path-allow`: a write/delete/history allow whose `paths.within` is
 *    a home directory or broader (`~`, `/home`, `/Users`, `/`), or contains a
 *    protected path.
 *  - `broad-domain-allow`: `*`, a wildcard over a public suffix (`*.com`,
 *    `*.co.uk`, `*.github.io`) or a multi-tenant cloud domain
 *    (`*.amazonaws.com`; isBroadDomainPattern in types/public-suffix.ts),
 *    including values reached through a `@list`, or a URL role allowed with
 *    no `domains` condition (broader than `*`). An explicit opt-in
 *    (`allowBroadDomains`) accepts these.
 *
 * Warnings: rules whose `paths.within` lies inside a protected path (the
 * engine denies those paths first, so the rule cannot grant them) and
 * filesystem rules inside the sandbox (structurally allowed already).
 *
 * Read access is not linted for breadth: an unconstrained read allow is how a
 * constitution grants "read anywhere" (the shipped read-only constitution
 * does), so rejecting `within: ~` for reads would only push the compiler to
 * the broader form. Protected paths stay denied whatever the rules say.
 *
 * Pure apart from canonicalizing paths (realpath), so the same answers hold
 * wherever it runs.
 */

import { homedir } from 'node:os';
import { hasRoleConditions, ruleRelevantToRole } from '../trusted-process/policy-engine.js';
import { extractDefaultRoles, getRoleDefinition, resolveRealPath, type ArgumentRole } from '../types/argument-roles.js';
import { ruleOutcomeAllows } from '../types/policy-schema.js';
import { isBroadDomainPattern } from '../types/public-suffix.js';
import type { CompiledRule, DynamicListsFile, StoredToolAnnotation } from './types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PolicyLintCode =
  | 'duplicate-rule-name'
  | 'server-wide-allow'
  | 'condition-role-mismatch'
  | 'unconstrained-mutation-allow'
  | 'side-effect-tool-allow'
  | 'broad-path-allow'
  | 'broad-domain-allow'
  | 'protected-path-rule'
  | 'sandbox-path-rule';

export interface PolicyLintFinding {
  readonly code: PolicyLintCode;
  /** Name of the rule the finding is about. */
  readonly rule: string;
  /** One sentence, starting with the quoted rule name. */
  readonly message: string;
}

export interface PolicyLintResult {
  readonly errors: readonly PolicyLintFinding[];
  readonly warnings: readonly PolicyLintFinding[];
}

export interface PolicyLintOptions {
  /** Stored annotations (conditional role specs intact) of the servers the rules cover. */
  readonly annotations: readonly StoredToolAnnotation[];
  /** Resolved dynamic lists: a `@list` entry counts with its effective values. */
  readonly dynamicLists?: DynamicListsFile;
  /** Paths the engine denies structurally. Rules may not contain or target them. */
  readonly protectedPaths: readonly string[];
  /**
   * The sandbox (workspace) directory. Like the engine, the lint exempts it
   * from protected paths that contain it.
   */
  readonly allowedDirectory?: string;
  /**
   * Accept broad domain access in allow rules (`*`, public-suffix wildcards,
   * URL roles without a domains condition). Only an explicit opt-in sets it.
   */
  readonly allowBroadDomains?: boolean;
  /** The user's home directory. Defaults to os.homedir(). */
  readonly homeDir?: string;
}

// ---------------------------------------------------------------------------
// Opt-in directive
// ---------------------------------------------------------------------------

/**
 * The constitution line that opts a policy in to broad domain access. It must
 * stand on a line of its own. Honoured for the global constitution only:
 * persona and cron constitutions can be drafted by an LLM from untrusted
 * content, so personas use their gated `allowBroadPolicy` flag instead.
 */
export const BROAD_DOMAINS_DIRECTIVE = '<!-- ironcurtain: allow-broad-domains -->';

const BROAD_DOMAINS_DIRECTIVE_LINE = /^[ \t]*<!--[ \t]*ironcurtain:[ \t]*allow-broad-domains[ \t]*-->[ \t]*$/m;

/** True when the constitution carries {@link BROAD_DOMAINS_DIRECTIVE} on a line of its own. */
export function constitutionAllowsBroadDomains(constitutionText: string): boolean {
  return BROAD_DOMAINS_DIRECTIVE_LINE.test(constitutionText);
}

// ---------------------------------------------------------------------------
// Tool view
// ---------------------------------------------------------------------------

/** Roles that change local state: allowing them needs a `paths.within`. */
const MUTATION_ROLES: ReadonlySet<ArgumentRole> = new Set([
  'write-path',
  'delete-path',
  'write-history',
  'delete-history',
]);

/** How many items (tools, patterns, paths) a message names before it summarizes the rest. */
const MAX_NAMED_ITEMS = 6;

interface ToolView {
  readonly id: string;
  readonly serverName: string;
  readonly toolName: string;
  /**
   * Per argument, the role sets it can resolve to: a static array, or a
   * conditional spec's default and each `when` clause.
   */
  readonly argOptions: ReadonlyArray<ReadonlyArray<readonly ArgumentRole[]>>;
  /** Every role an argument can carry in any mode. */
  readonly allRoles: ReadonlySet<ArgumentRole>;
  /** The resource-identifier roles among them: the roles the engine evaluates one by one. */
  readonly resourceRoles: readonly ArgumentRole[];
  /** The server marks the tool as changing state (tighten-only). */
  readonly sideEffects: boolean;
}

function toToolView(annotation: StoredToolAnnotation): ToolView {
  const argOptions = Object.values(annotation.args).map((spec) =>
    Array.isArray(spec) ? [spec] : [extractDefaultRoles(spec), ...spec.when.map((clause) => clause.roles)],
  );
  const allRoles = new Set<ArgumentRole>(argOptions.flat(2));
  const hints = annotation.mcpHints;
  return {
    id: `${annotation.serverName}/${annotation.toolName}`,
    serverName: annotation.serverName,
    toolName: annotation.toolName,
    argOptions,
    allRoles,
    resourceRoles: [...allRoles].filter(isResourceRole),
    sideEffects: hints?.readOnlyHint === false || hints?.destructiveHint === true,
  };
}

function isResourceRole(role: ArgumentRole): boolean {
  return getRoleDefinition(role).isResourceIdentifier;
}

function isUrlRole(role: ArgumentRole): boolean {
  return getRoleDefinition(role).category === 'url';
}

function isPathRole(role: ArgumentRole): boolean {
  return getRoleDefinition(role).category === 'path';
}

/** The engine's non-path conditions (server, tool, roles), with roles from every mode. */
function ruleMatchesTool(rule: CompiledRule, tool: ToolView): boolean {
  const cond = rule.if;
  if (cond.server !== undefined && !cond.server.includes(tool.serverName)) return false;
  if (cond.tool !== undefined && !cond.tool.includes(tool.toolName)) return false;
  if (cond.roles !== undefined && !cond.roles.some((role) => tool.allRoles.has(role))) return false;
  return true;
}

/** The tool's resource roles this rule takes part in deciding (the engine's per-role scan). */
function dischargedRoles(rule: CompiledRule, tool: ToolView): ArgumentRole[] {
  if (!hasRoleConditions(rule)) return [...tool.resourceRoles];
  return tool.resourceRoles.filter((role) => ruleRelevantToRole(rule, role));
}

/** Whether the rule checks argument values at all (paths, domains or lists). */
function hasValueConstraint(rule: CompiledRule): boolean {
  const cond = rule.if;
  return cond.paths !== undefined || cond.domains !== undefined || (cond.lists?.length ?? 0) > 0;
}

/** Whether the rule constrains this URL role's destinations (a domains condition or a list on it). */
function constrainsDestination(rule: CompiledRule, role: ArgumentRole): boolean {
  return rule.if.domains !== undefined || (rule.if.lists ?? []).some((list) => list.roles.includes(role));
}

function describeList(items: readonly string[]): string {
  const named = items.slice(0, MAX_NAMED_ITEMS).join(', ');
  return items.length > MAX_NAMED_ITEMS ? `${named} and ${items.length - MAX_NAMED_ITEMS} more` : named;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Canonical form of a path, or undefined when even `/` cannot be resolved. */
function canonical(path: string): string | undefined {
  try {
    return resolveRealPath(path);
  } catch {
    return undefined;
  }
}

function isSameOrInside(path: string, dir: string): boolean {
  if (dir === '/') return path.startsWith('/');
  return path === dir || path.startsWith(dir + '/');
}

function isStrictlyInside(path: string, dir: string): boolean {
  return path !== dir && isSameOrInside(path, dir);
}

/** Directories that hold every user's home directory. */
const HOME_PARENTS = ['/home', '/Users'];

interface PathContext {
  readonly home: string | undefined;
  readonly homeParents: readonly string[];
  readonly protectedPaths: ReadonlyArray<{ readonly given: string; readonly real: string }>;
  readonly sandbox: string | undefined;
}

function buildPathContext(options: PolicyLintOptions): PathContext {
  const homeParents = new Set<string>();
  for (const dir of HOME_PARENTS) {
    homeParents.add(dir);
    const real = canonical(dir);
    if (real !== undefined) homeParents.add(real);
  }
  const protectedPaths: Array<{ given: string; real: string }> = [];
  for (const given of options.protectedPaths) {
    const real = canonical(given);
    if (real !== undefined) protectedPaths.push({ given, real });
  }
  return {
    home: canonical(options.homeDir ?? homedir()),
    homeParents: [...homeParents],
    protectedPaths,
    sandbox: options.allowedDirectory !== undefined ? canonical(options.allowedDirectory) : undefined,
  };
}

/**
 * Why `real` is too broad for a write/delete/history allow, or undefined.
 * A home directory or anything containing one (`/home`, `/Users`, `/`, any
 * user's home under them), or a directory containing a protected path.
 */
function broadPathReason(real: string, ctx: PathContext): string | undefined {
  if (real === '/') return 'covers the whole filesystem';
  if (ctx.home !== undefined && isSameOrInside(ctx.home, real)) return 'covers the entire home directory';
  for (const parent of ctx.homeParents) {
    if (real === parent) return "covers every user's home directory";
    const rest = real.startsWith(parent + '/') ? real.slice(parent.length + 1) : undefined;
    if (rest !== undefined && rest.length > 0 && !rest.includes('/')) return "covers a user's entire home directory";
  }
  const contained = ctx.protectedPaths.filter((p) => isStrictlyInside(p.real, real)).map((p) => p.given);
  if (contained.length > 0) {
    return `contains protected path(s) ${describeList(contained.map(quote))}`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

/**
 * The values of an allowlist as the engine sees them: a `@list` entry
 * contributes its effective values (values + manualAdditions -
 * manualRemovals, as PolicyEngine.getEffectiveListValues); a missing list
 * contributes nothing (the engine treats it as empty).
 */
function expandAllowed(
  allowed: readonly string[],
  lists: DynamicListsFile | undefined,
): Array<{ value: string; via?: string }> {
  const out: Array<{ value: string; via?: string }> = [];
  for (const entry of allowed) {
    if (!entry.startsWith('@')) {
      out.push({ value: entry });
      continue;
    }
    const list = lists?.lists[entry.slice(1)];
    if (!list) continue;
    const removals = new Set(list.manualRemovals);
    for (const value of new Set([...list.values, ...list.manualAdditions])) {
      if (!removals.has(value)) out.push({ value, via: entry });
    }
  }
  return out;
}

/** The broad domain patterns an allow rule grants, as display strings. */
function broadDomainPatterns(rule: CompiledRule, lists: DynamicListsFile | undefined): string[] {
  const allowed: string[] = [...(rule.if.domains?.allowed ?? [])];
  for (const list of rule.if.lists ?? []) {
    if (list.matchType === 'domains') allowed.push(...list.allowed);
  }
  const broad = new Set<string>();
  for (const { value, via } of expandAllowed(allowed, lists)) {
    if (isBroadDomainPattern(value)) broad.add(via ? `${quote(value)} (via ${via})` : quote(value));
  }
  return [...broad];
}

// ---------------------------------------------------------------------------
// Lint
// ---------------------------------------------------------------------------

/**
 * Lints compiled rules. `errors` must be empty before the rules may be used;
 * `warnings` are informational.
 */
export function lintCompiledRules(rules: readonly CompiledRule[], options: PolicyLintOptions): PolicyLintResult {
  const errors: PolicyLintFinding[] = [];
  const warnings: PolicyLintFinding[] = [];
  const tools = options.annotations.map(toToolView);
  const paths = buildPathContext(options);
  const allowBroadDomains = options.allowBroadDomains === true;

  checkDuplicateNames(rules, errors);

  for (const rule of rules) {
    checkPathTargets(rule, paths, warnings);
    // `assess` allows too: the merged policy is linted after the compile
    // pipeline turned outbound-channel allows into `assess` rules.
    if (!ruleOutcomeAllows(rule.then)) continue;

    const matched = tools.filter((tool) => ruleMatchesTool(rule, tool));
    checkServerWideAllow(rule, errors);
    checkConditionRoles(rule, errors);
    checkUnconstrainedMutation(rule, matched, errors);
    checkBroadPath(rule, paths, errors);
    if (!allowBroadDomains) {
      checkUnconstrainedDestinations(rule, matched, errors);
      checkBroadDomainPatterns(rule, options.dynamicLists, errors);
    }
  }

  checkSideEffectTools(rules, tools, errors);
  return { errors, warnings };
}

function checkDuplicateNames(rules: readonly CompiledRule[], errors: PolicyLintFinding[]): void {
  const seen = new Set<string>();
  for (const rule of rules) {
    const scope = JSON.stringify([...(rule.if.server ?? [])].sort());
    const key = `${scope}\u0000${rule.name}`;
    if (!seen.has(key)) {
      seen.add(key);
      continue;
    }
    errors.push({
      code: 'duplicate-rule-name',
      rule: rule.name,
      message:
        `Rule ${quote(rule.name)}: another rule for the same server(s) has this name. ` +
        'Rule names must be unique (repairs address rules by name).',
    });
  }
}

function checkServerWideAllow(rule: CompiledRule, errors: PolicyLintFinding[]): void {
  const cond = rule.if;
  if (cond.tool !== undefined || hasValueConstraint(rule)) return;
  // A roles filter constrains only when every role in it is a resource role.
  // A non-resource role (none, email-address, ...) is never evaluated per
  // role: it only widens the filter to every tool with such an argument, and
  // a tool without resource roles (every Google Workspace tool) is then
  // allowed for every input, whatever resource roles the filter also names.
  const opaque = (cond.roles ?? []).filter((role) => !isResourceRole(role));
  if (cond.roles !== undefined && opaque.length === 0) return;
  const servers = cond.server ? `server(s) ${cond.server.map(quote).join(', ')}` : 'every server';
  const why =
    opaque.length > 0
      ? `its roles filter names ${opaque.join(', ')}, which matches every tool with such an argument`
      : 'it has no role constraint';
  errors.push({
    code: 'server-wide-allow',
    rule: rule.name,
    message:
      `Rule ${quote(rule.name)} allows every tool of ${servers}, including tools added later: it has no "tool" list ` +
      `and no path, domain or list constraint, and ${why}. List the tools the constitution permits.`,
  });
}

/**
 * Conditions on roles they cannot constrain. The engine applies a condition to
 * every role it names, whatever the role's category: `paths.within` resolves
 * the value as a path (an owner name or a URL lands under the process's
 * working directory), a domain match reads it as a URL (a path has the empty
 * hostname, which `""` and `*` match, so such a "domain" condition passes
 * every path), and a list compares raw values (paths are not canonicalized,
 * so a list on a path role bypasses symlink resolution). In an allow rule
 * each of these looks like a constraint and limits nothing it seems to.
 */
function checkConditionRoles(rule: CompiledRule, errors: PolicyLintFinding[]): void {
  const cond = rule.if;
  const problems: string[] = [];
  const nonPath = (cond.paths?.roles ?? []).filter((role) => !isPathRole(role));
  if (nonPath.length > 0) problems.push(`"paths" on ${nonPath.join(', ')} (it applies to filesystem path roles)`);
  const nonUrl = (cond.domains?.roles ?? []).filter((role) => !isUrlRole(role));
  if (nonUrl.length > 0) problems.push(`"domains" on ${nonUrl.join(', ')} (it applies to URL roles)`);
  for (const list of cond.lists ?? []) {
    const wrong = list.roles.filter((role) => isPathRole(role) || (list.matchType === 'domains' && !isUrlRole(role)));
    if (wrong.length > 0) {
      problems.push(
        `a "${list.matchType}" list on ${wrong.join(', ')} (paths are constrained with "paths", domains on URL roles)`,
      );
    }
  }
  if (problems.length === 0) return;
  errors.push({
    code: 'condition-role-mismatch',
    rule: rule.name,
    message:
      `Rule ${quote(rule.name)} applies ${problems.join('; ')}. A condition on a role of another kind still ` +
      'matches (a path has no hostname, so "*" or "" matches every path; an owner name resolves as a path), so it ' +
      'does not limit the allow. Use "paths" for path roles, "domains" for URL roles and "lists" for identifiers ' +
      'and email addresses.',
  });
}

function checkUnconstrainedMutation(
  rule: CompiledRule,
  matched: readonly ToolView[],
  errors: PolicyLintFinding[],
): void {
  // Only paths.within constrains a path. When the rule has a paths condition,
  // every role it discharges is one of paths.roles (ruleRelevantToRole);
  // a domains or lists condition on a path role constrains nothing (see
  // checkConditionRoles), so it does not exempt the rule.
  if (rule.if.paths !== undefined) return;
  const roles = new Set<ArgumentRole>();
  const ids: string[] = [];
  for (const tool of matched) {
    const mutating = dischargedRoles(rule, tool).filter((role) => MUTATION_ROLES.has(role));
    if (mutating.length === 0) continue;
    for (const role of mutating) roles.add(role);
    ids.push(tool.id);
  }
  if (ids.length === 0) return;
  const how = hasRoleConditions(rule) ? 'allows' : 'is a role-agnostic allow, so it allows';
  errors.push({
    code: 'unconstrained-mutation-allow',
    rule: rule.name,
    message:
      `Rule ${quote(rule.name)} ${how} ${[...roles].join(', ')} on ${describeList(ids)} with no paths.within, ` +
      'i.e. anywhere. Allow write, delete or history roles only within a named directory (paths.within) and ' +
      'name the read roles explicitly on multi-mode tools; escalate the rest.',
  });
}

function checkBroadPath(rule: CompiledRule, ctx: PathContext, errors: PolicyLintFinding[]): void {
  const pathCond = rule.if.paths;
  if (!pathCond) return;
  const topRoles = rule.if.roles;
  const mutating = pathCond.roles.filter(
    (role) => MUTATION_ROLES.has(role) && (topRoles === undefined || topRoles.includes(role)),
  );
  if (mutating.length === 0) return;
  const real = canonical(pathCond.within);
  // Fail closed: a directory that cannot be canonicalized cannot be checked.
  const reason = real === undefined ? 'cannot be resolved to a canonical path' : broadPathReason(real, ctx);
  if (reason === undefined) return;
  errors.push({
    code: 'broad-path-allow',
    rule: rule.name,
    message:
      `Rule ${quote(rule.name)} allows ${mutating.join(', ')} within ${quote(pathCond.within)}, which ${reason}. ` +
      'Name the specific directory the constitution permits.',
  });
}

function checkUnconstrainedDestinations(
  rule: CompiledRule,
  matched: readonly ToolView[],
  errors: PolicyLintFinding[],
): void {
  const roles = new Set<ArgumentRole>();
  const ids: string[] = [];
  for (const tool of matched) {
    const open = dischargedRoles(rule, tool).filter((role) => isUrlRole(role) && !constrainsDestination(rule, role));
    if (open.length === 0) continue;
    for (const role of open) roles.add(role);
    ids.push(tool.id);
  }
  if (ids.length === 0) return;
  errors.push({
    code: 'broad-domain-allow',
    rule: rule.name,
    message:
      `Rule ${quote(rule.name)} allows ${[...roles].join(', ')} on ${describeList(ids)} with no domains condition, ` +
      'i.e. every destination (broader than "*"). Name the permitted domains or a dynamic list; broad domain access ' +
      'needs an explicit opt-in.',
  });
}

function checkBroadDomainPatterns(
  rule: CompiledRule,
  lists: DynamicListsFile | undefined,
  errors: PolicyLintFinding[],
): void {
  const broad = broadDomainPatterns(rule, lists);
  if (broad.length === 0) return;
  errors.push({
    code: 'broad-domain-allow',
    rule: rule.name,
    message:
      `Rule ${quote(rule.name)} allows ${describeList(broad)}: "*" and wildcards over a public suffix or a ` +
      'multi-tenant cloud domain (e.g. *.com, *.co.uk, *.github.io, *.amazonaws.com) cover hosts other parties ' +
      'register or control. Name the specific domains; broad domain access needs an explicit opt-in.',
  });
}

/**
 * The first rule that decides `role` (or, for a tool without resource roles,
 * the call) when no value constraint matches: an input outside every
 * paths.within, domain list and identifier list. Mirrors the engine's
 * first-match scan; constrained rules never match such an input.
 */
function firstUnconstrainedRule(
  rules: readonly CompiledRule[],
  tool: ToolView,
  role: ArgumentRole | undefined,
): CompiledRule | undefined {
  for (const rule of rules) {
    if (!ruleMatchesTool(rule, tool)) continue;
    if (role !== undefined && hasRoleConditions(rule) && !ruleRelevantToRole(rule, role)) continue;
    if (hasValueConstraint(rule)) continue;
    return rule;
  }
  return undefined;
}

/**
 * The allow rules that let `tool` through for an input no value constraint
 * matches, or an empty list when no such input is allowed. The engine
 * evaluates each resource role present in the call (most restrictive wins) and
 * scans unscoped when none is present; a conditional annotation lets the
 * caller pick the mode, so each argument may take any of its role sets.
 */
function inputWideAllowRules(rules: readonly CompiledRule[], tool: ToolView): CompiledRule[] {
  const deciders = new Map(tool.resourceRoles.map((role) => [role, firstUnconstrainedRule(rules, tool, role)]));
  const allowedRole = (role: ArgumentRole): boolean => ruleOutcomeAllows(deciders.get(role)?.then);
  const resources = (roles: readonly ArgumentRole[]): ArgumentRole[] => roles.filter(isResourceRole);

  // A mode with at least one resource role, every one of them allowed.
  const passable = tool.argOptions.map((options) => options.filter((roles) => resources(roles).every(allowedRole)));
  if (passable.every((options) => options.length > 0) && passable.some((o) => o.some((r) => resources(r).length > 0))) {
    const used = new Set(passable.flat().flatMap(resources));
    return [...new Set([...used].map((role) => deciders.get(role)))].filter(
      (rule): rule is CompiledRule => rule !== undefined,
    );
  }
  // A mode with no resource role at all: the unscoped scan decides.
  if (tool.argOptions.every((options) => options.some((roles) => resources(roles).length === 0))) {
    const rule = firstUnconstrainedRule(rules, tool, undefined);
    return rule !== undefined && ruleOutcomeAllows(rule.then) ? [rule] : [];
  }
  return [];
}

/**
 * Tools the server marks as changing state must not be allowed for every
 * input. Tools with a write/delete/history role are covered by
 * checkUnconstrainedMutation already (an input-wide allow of the mutating
 * mode fires there), so this pass covers remote mutations: tools whose
 * arguments carry only identifiers or opaque values (GitHub, Google
 * Workspace).
 */
function checkSideEffectTools(rules: readonly CompiledRule[], tools: readonly ToolView[], errors: PolicyLintFinding[]) {
  const byRule = new Map<CompiledRule, string[]>();
  for (const tool of tools) {
    if (!tool.sideEffects || tool.resourceRoles.some((role) => MUTATION_ROLES.has(role))) continue;
    for (const rule of inputWideAllowRules(rules, tool)) {
      const ids = byRule.get(rule) ?? [];
      ids.push(tool.id);
      byRule.set(rule, ids);
    }
  }
  for (const [rule, ids] of byRule) {
    errors.push({
      code: 'side-effect-tool-allow',
      rule: rule.name,
      message:
        `Rule ${quote(rule.name)} allows ${describeList(ids)} for every input, but the MCP server marks ` +
        `${ids.length === 1 ? 'this tool' : 'these tools'} as changing state. Escalate them, or constrain the ` +
        'allow to the permitted owners, repositories or recipients (lists).',
    });
  }
}

function checkPathTargets(rule: CompiledRule, ctx: PathContext, warnings: PolicyLintFinding[]): void {
  const within = rule.if.paths?.within;
  if (within === undefined) return;
  const real = canonical(within);
  if (real === undefined) return;
  const sandbox = ctx.sandbox;
  const overlapsSandbox = sandbox !== undefined && (isSameOrInside(real, sandbox) || isSameOrInside(sandbox, real));

  const target = ctx.protectedPaths.find((p) => isSameOrInside(real, p.real));
  if (target && !overlapsSandbox) {
    warnings.push({
      code: 'protected-path-rule',
      rule: rule.name,
      message:
        `Rule ${quote(rule.name)}: paths.within ${quote(within)} lies in protected path ${quote(target.given)}, ` +
        'which the engine denies before any rule, so this rule cannot grant it.',
    });
  }
  if (sandbox !== undefined && isSameOrInside(real, sandbox) && rule.if.server?.includes('filesystem') === true) {
    warnings.push({
      code: 'sandbox-path-rule',
      rule: rule.name,
      message:
        `Rule ${quote(rule.name)}: paths.within ${quote(within)} is inside the sandbox, where filesystem calls ` +
        'are allowed structurally; the rule is redundant.',
    });
  }
}
