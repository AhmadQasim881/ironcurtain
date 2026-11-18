/**
 * Outbound channels in compiled policies: allow -> assess.
 *
 * A tool is an outbound channel when one of its arguments carries content
 * that other people or systems read (a message or comment body, a commit
 * message, a fetched URL; see `RoleDefinition.outboundContent`). An `allow`
 * for such a tool lets the content leave unchecked, so every compiled allow
 * that can match an outbound-channel tool becomes an `assess` rule: allowed
 * subject to the opt-in outbound content assessment (assessment.ts). With
 * the assessment off an `assess` rule allows exactly like `allow`, so the
 * conversion never changes a decision on its own.
 *
 * The compiler model is never asked for `assess`: it keeps emitting
 * allow/escalate (its repair rounds and the verifier see those), and the
 * policy pipeline applies {@link applyOutboundAssessment} to every server's
 * rules before they are merged into compiled-policy.json, so the artifact
 * shows which rules are assessed. The PolicyEngine applies it again when it
 * loads a policy, so a policy compiled before `assess` existed (a persona's,
 * a job's, the user's own) is evaluated the same way without a recompile.
 */

import type { CompiledRule, StoredToolAnnotation } from '../pipeline/types.js';
import {
  extractDefaultRoles,
  storedAnnotationCarriesOutboundContent,
  type ArgumentRole,
} from '../types/argument-roles.js';

/**
 * True when `rule` can match a call to `tool`: its server, tool and role
 * conditions admit the tool, judged on every argument's default (most
 * inclusive) roles. Path, domain and list conditions also need an argument
 * with one of their roles to match at all; their values are not considered.
 */
function ruleCanMatchTool(rule: CompiledRule, tool: StoredToolAnnotation): boolean {
  const cond = rule.if;
  if (cond.server !== undefined && !cond.server.includes(tool.serverName)) return false;
  if (cond.tool !== undefined && !cond.tool.includes(tool.toolName)) return false;
  const toolRoles = new Set<ArgumentRole>(Object.values(tool.args).flatMap((spec) => extractDefaultRoles(spec)));
  const hasAny = (roles: readonly ArgumentRole[]): boolean => roles.some((role) => toolRoles.has(role));
  if (cond.roles !== undefined && !hasAny(cond.roles)) return false;
  if (cond.paths !== undefined && !hasAny(cond.paths.roles)) return false;
  if (cond.domains !== undefined && !hasAny(cond.domains.roles)) return false;
  if (cond.lists !== undefined && !cond.lists.every((list) => hasAny(list.roles))) return false;
  return true;
}

/**
 * Returns `rules` with every `allow` rule that can match an outbound-channel
 * tool among `tools` turned into an `assess` rule. Escalate rules, and allow
 * rules that can only match tools without outbound content, are returned
 * as they are. Never mutates its input; idempotent.
 */
export function applyOutboundAssessment(
  rules: readonly CompiledRule[],
  tools: readonly StoredToolAnnotation[],
): CompiledRule[] {
  const outboundTools = tools.filter((tool) => storedAnnotationCarriesOutboundContent(tool));
  return rules.map((rule) => {
    if (rule.then !== 'allow') return rule;
    return outboundTools.some((tool) => ruleCanMatchTool(rule, tool)) ? { ...rule, then: 'assess' } : rule;
  });
}
