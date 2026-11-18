/**
 * Which MCP tools the list resolver describes to its LLM.
 *
 * The resolver reads untrusted data (mail, issues, documents) through MCP
 * tools. Every call it makes is evaluated by the security kernel against the
 * read-only policy (see `proxy-mcp-connections.ts`); that per-call check is
 * the actual control. This module adds least-privilege exposure on top: the
 * LLM is only told about tools that the read-only policy could allow for some
 * arguments and that it can never allow with a URL-category argument (a host
 * of the caller's choosing), so they cannot carry data off the machine.
 * Mutating, unannotated and network-egress tools are never offered.
 *
 * The analysis is static (no argument values), so it mirrors the
 * PolicyEngine's rule walk using the engine's own rule-relevance predicates:
 * rules whose `paths` / `domains` / `lists` conditions depend on argument
 * values "may match", so an allow among them counts as reachable and a
 * non-allow among them does not end the walk.
 */

import { collectDistinctRoles, hasRoleConditions, ruleRelevantToRole } from '../trusted-process/policy-engine.js';
import { getUrlRoles, resolveStoredAnnotation } from '../types/argument-roles.js';
import { ruleOutcomeAllows } from '../types/policy-schema.js';
import { LIST_RESOLUTION_EXCLUDED_SERVERS } from './dynamic-list-types.js';
import type { ArgumentRole, ArgumentRoleSpec, CompiledRule, StoredToolAnnotation, ToolAnnotation } from './types.js';

/**
 * Builds probe argument objects that trigger each conditional role branch of
 * a multi-mode tool (e.g. `git_branch` with `operation: "list"`). The empty
 * probe covers the default roles and `absent` / `falsy` conditions. Each
 * probe sets a single argument, so conditions keyed on the same
 * discriminator resolve consistently across all of the tool's arguments.
 */
function probeArguments(stored: StoredToolAnnotation): Record<string, unknown>[] {
  const probes: Record<string, unknown>[] = [{}];
  for (const spec of Object.values(stored.args)) {
    if (Array.isArray(spec)) continue;
    for (const { condition } of spec.when) {
      if (condition.equals !== undefined) probes.push({ [condition.arg]: condition.equals });
      for (const value of condition.in ?? []) probes.push({ [condition.arg]: value });
      if (condition.is === 'present' || condition.is === 'truthy') probes.push({ [condition.arg]: true });
    }
  }
  return probes;
}

/** True when any argument of the resolved annotation carries one of `roles`. */
function hasAnyRole(annotation: ToolAnnotation, roles: readonly ArgumentRole[]): boolean {
  return Object.values(annotation.args).some((argRoles) => argRoles.some((r) => roles.includes(r)));
}

/** True when a rule's match depends on argument values, not just on the tool. */
function dependsOnArgumentValues(rule: CompiledRule): boolean {
  const cond = rule.if;
  return cond.paths !== undefined || cond.domains !== undefined || (cond.lists !== undefined && cond.lists.length > 0);
}

/**
 * Walks the rule chain the way `PolicyEngine` does (first match wins), either
 * for one resource role or, when `role` is undefined, unscoped (tools without
 * resource roles). Returns true when an allow (or assess) rule is reachable.
 */
function allowIsReachable(
  rules: readonly CompiledRule[],
  serverName: string,
  toolName: string,
  annotation: ToolAnnotation,
  role?: ArgumentRole,
): boolean {
  for (const rule of rules) {
    const cond = rule.if;
    if (role !== undefined && hasRoleConditions(rule) && !ruleRelevantToRole(rule, role)) continue;
    if (cond.server !== undefined && !cond.server.includes(serverName)) continue;
    if (cond.tool !== undefined && !cond.tool.includes(toolName)) continue;
    if (cond.roles !== undefined && !hasAnyRole(annotation, cond.roles)) continue;
    // An `assess` rule allows too (subject to the outbound content
    // assessment, which never denies).
    if (ruleOutcomeAllows(rule.then)) return true;
    // A non-allow rule that matches regardless of argument values ends the
    // walk, exactly as first-match-wins evaluation would.
    if (!dependsOnArgumentValues(rule)) return false;
  }
  return false; // default deny
}

/**
 * Returns true when `rules` could allow some call to the tool. Mirrors
 * PolicyEngine evaluation: each resource role is evaluated independently and
 * the most restrictive result wins, so every resource role must be able to
 * reach an allow; a tool with no resource roles is evaluated unscoped.
 * Conditional (multi-mode) annotations are allowed when any mode is.
 */
export function canPolicyAllowTool(
  rules: readonly CompiledRule[],
  serverName: string,
  toolName: string,
  stored: StoredToolAnnotation,
): boolean {
  return probeArguments(stored).some((probe) => {
    const annotation = resolveStoredAnnotation(stored, probe);
    const roles = collectDistinctRoles(annotation);
    if (roles.length === 0) return allowIsReachable(rules, serverName, toolName, annotation);
    return roles.every((role) => allowIsReachable(rules, serverName, toolName, annotation, role));
  });
}

/** Every role an argument spec assigns in some mode: its static roles, or its default and conditional ones. */
function rolesInAnyMode(spec: ArgumentRoleSpec): readonly ArgumentRole[] {
  return Array.isArray(spec) ? spec : [...spec.default, ...spec.when.flatMap((entry) => entry.roles)];
}

/** The URL-category roles (e.g. `fetch-url`, `git-remote-url`) that any argument of the tool has, in any mode. */
function networkEgressRoles(stored: StoredToolAnnotation): ArgumentRole[] {
  const urlRoles = new Set<ArgumentRole>(getUrlRoles());
  const found = new Set<ArgumentRole>();
  for (const spec of Object.values(stored.args)) {
    for (const role of rolesInAnyMode(spec)) {
      if (urlRoles.has(role)) found.add(role);
    }
  }
  return [...found];
}

/**
 * True when any argument of the tool, in any mode, has a URL-category role
 * (e.g. `fetch-url`, `git-remote-url`): a call in that mode names a host of
 * the caller's choosing, to send data to (`http_fetch`, `git_push`) or to
 * record as a destination (`git_remote` add/set-url).
 */
export function hasNetworkEgressRole(stored: StoredToolAnnotation): boolean {
  return networkEgressRoles(stored).length > 0;
}

/**
 * Returns true when `rules` could allow some call to the tool that carries a
 * URL-category argument, i.e. a call that names a host of the caller's
 * choosing.
 *
 * Each URL role is walked like any resource role. A call in which a URL role
 * cannot reach an allow is never allowed: the most restrictive role wins, URL
 * roles are never resolved by sandbox containment, and the structural domain
 * gate only ever escalates. Which rules apply to a role does not depend on the
 * tool's mode (relevance is by role name, and a `roles` condition naming the
 * role holds wherever the role occurs), so one walk per role covers every
 * mode, including argument combinations the single-argument probes of
 * `canPolicyAllowTool` never build.
 */
export function canPolicyAllowNetworkEgress(
  rules: readonly CompiledRule[],
  serverName: string,
  toolName: string,
  stored: StoredToolAnnotation,
): boolean {
  const roles = networkEgressRoles(stored);
  if (roles.length === 0) return false;
  const allModes: ToolAnnotation = {
    toolName: stored.toolName,
    serverName: stored.serverName,
    comment: stored.comment,
    args: Object.fromEntries(Object.entries(stored.args).map(([name, spec]) => [name, [...rolesInAnyMode(spec)]])),
  };
  return roles.some((role) => allowIsReachable(rules, serverName, toolName, allModes, role));
}

/**
 * Decides whether the list resolver may describe a tool to its LLM: the tool
 * must be annotated, must not belong to a network-egress server, must be
 * allowable by the read-only policy for some arguments, and must never be
 * allowable with a URL-category argument. A multi-mode tool whose
 * URL-carrying modes the policy refuses (git_remote add/set-url) is offered
 * for its other modes; the kernel refuses the rest call by call. `stored` is
 * undefined for tools missing from tool-annotations.json.
 */
export function isListResolutionTool(
  rules: readonly CompiledRule[],
  serverName: string,
  toolName: string,
  stored: StoredToolAnnotation | undefined,
): boolean {
  if (!stored) return false;
  if (LIST_RESOLUTION_EXCLUDED_SERVERS.has(serverName)) return false;
  if (canPolicyAllowNetworkEgress(rules, serverName, toolName, stored)) return false;
  return canPolicyAllowTool(rules, serverName, toolName, stored);
}
