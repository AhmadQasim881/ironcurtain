/**
 * src/persona/rule-delta.ts
 *
 * Computes a {@link RuleDeltaDto} between a persona's previous compiled policy
 * and the freshly compiled one (Phase 1c, §7). Surfaced on the `done` event so a
 * reviewer can see, after the fact, exactly how a recompile changed the policy —
 * in particular any broadening that an `allowBroadPolicy` persona was permitted
 * to introduce.
 *
 * The diff is structural, keyed by rule `name` (the compiler's stable rule id):
 *   - `added`    rules present only in the new policy;
 *   - `removed`  rules present only in the old policy;
 *   - `loosened` rules present in both whose access widened: a `deny`/`escalate`
 *                that became `allow` or `assess`, an `assess` that became
 *                `allow`, a rule that gained a broad wildcard
 *                (isBroadDomainPattern: `*`, `*.`, a TLD-level `*.com`), also
 *                one a `@list` reference resolves to when the dynamic lists are
 *                given, or a rule that allows (`allow` or `assess`) and dropped
 *                a `domains`, `paths` or `lists` condition it had.
 * The broadening detail fields (`broadenedDomains`, `outOfWorkspacePaths`,
 * `unconstrainedAllows`, and the informational `escalateBreadth`) reuse
 * {@link findBroadPolicy} on the NEW policy, with the same lists and tool
 * annotations the compile used, so they always describe the resulting
 * policy's broad surface.
 *
 * ZERO runtime value-imports from src/pipeline — `CompiledPolicyFile` is a
 * type-only import.
 */

import { findBroadPolicy, hasBroadAllowance, type BroadPolicyContext } from './broad-policy-validator.js';
import type { RuleDeltaDto } from '../web-ui/web-ui-types.js';
// Type-only — no runtime edge to pipeline.
import type { CompiledPolicyFile, CompiledRule, DynamicListsFile } from '../pipeline/types.js';

/**
 * True iff a rule grants a broad wildcard domain or list allowance, literally
 * or through a `@list` reference that `dynamicLists` resolves to one.
 */
function hasBroadWildcard(rule: CompiledRule, dynamicLists: DynamicListsFile | undefined): boolean {
  if (rule.if.domains && hasBroadAllowance(rule.if.domains.allowed, dynamicLists)) return true;
  return rule.if.lists?.some((l) => hasBroadAllowance(l.allowed, dynamicLists)) === true;
}

/** True iff `newRule` lacks a `domains`, `paths` or `lists` condition that `oldRule` had. */
function droppedValueCondition(oldRule: CompiledRule, newRule: CompiledRule): boolean {
  const hadLists = (oldRule.if.lists?.length ?? 0) > 0;
  const hasLists = (newRule.if.lists?.length ?? 0) > 0;
  return (
    (oldRule.if.domains !== undefined && newRule.if.domains === undefined) ||
    (oldRule.if.paths !== undefined && newRule.if.paths === undefined) ||
    (hadLists && !hasLists)
  );
}

/**
 * How much a rule outcome permits, most permissive first: `allow`, then
 * `assess` (an allow subject to the outbound content assessment), then
 * `escalate` and `deny`. An outcome the engine does not know denies.
 */
function outcomeRestriction(outcome: CompiledRule['then']): number {
  switch (outcome) {
    case 'allow':
      return 0;
    case 'assess':
      return 1;
    case 'escalate':
      return 2;
    default:
      return 3;
  }
}

/**
 * What a delta is computed with besides the two policies: the
 * {@link BroadPolicyContext} the NEW policy was compiled with (its resolved
 * lists and the tool annotations), plus the resolved lists of the OLD policy,
 * so that a wildcard reached through a `@list` counts as gained only when the
 * old rule did not already reach it. Any of them may be absent.
 */
export interface RuleDeltaContext extends BroadPolicyContext {
  readonly oldDynamicLists?: DynamicListsFile;
}

/**
 * Heuristic "loosened" check for a rule present in both policies. A rule is
 * loosened if it now allows what it did not allow as freely before (a
 * `deny`/`escalate` that became `assess` or `allow`, an `assess` that became
 * `allow`), if it newly gained a broad wildcard allowance (each rule judged
 * with its own policy's lists), or if a rule that allows (`allow` or `assess`,
 * an allow subject to the outbound content assessment) lost one of its value
 * conditions.
 */
function isLoosened(oldRule: CompiledRule, newRule: CompiledRule, context: RuleDeltaContext): boolean {
  const newRestriction = outcomeRestriction(newRule.then);
  const allowsNow = newRestriction <= 1;
  const decisionLoosened = allowsNow && newRestriction < outcomeRestriction(oldRule.then);
  const wildcardGained =
    !hasBroadWildcard(oldRule, context.oldDynamicLists) && hasBroadWildcard(newRule, context.dynamicLists);
  const constraintDropped = allowsNow && droppedValueCondition(oldRule, newRule);
  return decisionLoosened || wildcardGained || constraintDropped;
}

/**
 * Computes the structural delta between `oldPolicy` (may be undefined on the
 * first compile) and `newPolicy`. When `oldPolicy` is undefined the caller
 * should omit the delta entirely (there is nothing to diff); this function
 * still returns a well-formed all-added delta for completeness. `context`
 * carries the resolved lists and tool annotations the new policy was compiled
 * with, and the old policy's resolved lists (see {@link RuleDeltaContext}).
 */
export function computeRuleDelta(
  oldPolicy: CompiledPolicyFile | undefined,
  newPolicy: CompiledPolicyFile,
  workspaceDir: string,
  context: RuleDeltaContext = {},
): RuleDeltaDto {
  const oldByName = new Map<string, CompiledRule>();
  for (const r of oldPolicy?.rules ?? []) oldByName.set(r.name, r);
  const newByName = new Map<string, CompiledRule>();
  for (const r of newPolicy.rules) newByName.set(r.name, r);

  let added = 0;
  let removed = 0;
  let loosened = 0;

  for (const [name, newRule] of newByName) {
    const oldRule = oldByName.get(name);
    if (!oldRule) {
      added += 1;
    } else if (isLoosened(oldRule, newRule, context)) {
      loosened += 1;
    }
  }
  for (const name of oldByName.keys()) {
    if (!newByName.has(name)) removed += 1;
  }

  const findings = findBroadPolicy(newPolicy, workspaceDir, {
    dynamicLists: context.dynamicLists,
    annotations: context.annotations,
  });

  return {
    added,
    removed,
    loosened,
    broadenedDomains: findings.broadenedDomains,
    outOfWorkspacePaths: findings.outOfWorkspacePaths,
    unconstrainedAllows: findings.unconstrainedAllows,
    escalateBreadth: findings.escalateBreadth,
  };
}
