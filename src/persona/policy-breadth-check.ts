/**
 * src/persona/policy-breadth-check.ts
 *
 * LLM-free breadth check of an EXISTING compiled persona policy, judged as the
 * runtime would enforce it: `compiled-policy.json` and `dynamic-lists.json` are
 * read (schema-validated) from the policy dir exactly as sessions load them,
 * the effective tool annotations are the global ones (the user overlay layered
 * over the package's, as sessions and compiles use), and the result is
 * {@link findBroadPolicy} against the persona's workspace dir. The resolved
 * lists matter: a rule that only names `@list` is broad when the list
 * resolves to `*`.
 *
 * Used where a policy on disk, not a fresh compile result, is judged:
 *  - `resolvePersona` refuses a broad policy for a persona that has not opted
 *    in (a policy compiled before the CLI ran the validator, hand-edited
 *    persona or policy files, changed annotations);
 *  - a broad-policy opt-out moves a broad policy aside (persona-service.ts);
 *  - `persona show` reports it.
 *
 * It takes directories rather than a persona name so that resolve.ts can
 * import it without an import cycle.
 */

import { getPackageGeneratedDir, loadPersonaPolicyArtifacts } from '../config/index.js';
import { getUserGeneratedDir } from '../config/paths.js';
import { loadToolAnnotations } from '../config/tool-annotations-overlay.js';
import { findBroadPolicy, type BroadPolicyFindings } from './broad-policy-validator.js';

/**
 * Breadth findings of the compiled policy in `policyDir`.
 *
 * @throws when the policy, its lists or the tool annotations cannot be read
 *   or are malformed (callers fail closed: such a policy cannot be shown to
 *   be narrow, and a session would refuse to load it anyway).
 */
export function inspectCompiledPolicyBreadth(policyDir: string, workspaceDir: string): BroadPolicyFindings {
  const { compiledPolicy, dynamicLists } = loadPersonaPolicyArtifacts(policyDir);
  const annotations = loadToolAnnotations(getUserGeneratedDir(), getPackageGeneratedDir())?.annotations;
  return findBroadPolicy(compiledPolicy, workspaceDir, { dynamicLists, annotations });
}
