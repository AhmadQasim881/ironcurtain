/**
 * Load-time provenance check of compiled policies.
 *
 * Session start (`buildSessionConfig`: CLI, daemon, cron, PTY and workflow
 * states) and policy hot-swaps (`loadPersonaPolicyArtifacts`, called by the
 * coordinator) compare the loaded policy's provenance with this IronCurtain
 * and the tool annotations in effect (see src/policy-artifacts/provenance.ts).
 * A stale policy is reported loudly and used (`policy.onStale: "warn"`, the
 * default) or refused (`"refuse"`). `ironcurtain doctor` reports the same
 * assessment.
 */

import { realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import type { CompiledPolicyFile, StoredToolAnnotationsFile } from '../pipeline/types.js';
import {
  assessPolicyProvenance,
  describePolicyStaleReason,
  describeUnscopedRules,
  type PolicyProvenanceAssessment,
} from '../policy-artifacts/provenance.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import { isObjectWithProp } from '../utils/is-plain-object.js';
import { getPackageConfigDir, getUserConfigPath, getUserGeneratedDir } from './paths.js';
import { serverNameForCommand } from './tool-annotations-overlay.js';
import type { PolicyOnStale } from './user-config.js';

/**
 * Discriminant of {@link StalePolicyError}; callers across modules should test
 * `code` (see {@link isStalePolicyRefusal}). Deliberately not `POLICY_STALE`:
 * that is the `ScopedPolicyError` code (src/config/constitution-hash.ts) for a
 * persona or job policy compiled from another constitution, which
 * `--allow-stale-policy` overrides. That flag does not override this refusal,
 * so callers must be able to tell the two apart.
 */
export const POLICY_PROVENANCE_STALE = 'POLICY_PROVENANCE_STALE';

/** Thrown when a stale policy is loaded under `policy.onStale: "refuse"`. */
export class StalePolicyError extends Error {
  readonly code = POLICY_PROVENANCE_STALE;
  readonly policyPath: string;

  constructor(policyPath: string, message: string) {
    super(message);
    this.name = 'StalePolicyError';
    this.policyPath = policyPath;
  }
}

/** True when `err` is a {@link StalePolicyError} (matched by its code, not by class). */
export function isStalePolicyRefusal(err: unknown): boolean {
  return isObjectWithProp(err, 'code') && err.code === POLICY_PROVENANCE_STALE;
}

/** Where a compiled policy comes from, for messages and remediation hints. */
export type PolicySource =
  /** Shipped with IronCurtain (the package's generated or generated-readonly directory). */
  | { readonly kind: 'package' }
  /** The user's global policy (`~/.ironcurtain/generated`). */
  | { readonly kind: 'user' }
  | { readonly kind: 'persona'; readonly name: string }
  | { readonly kind: 'job'; readonly id: string }
  | { readonly kind: 'other' };

/** Who a loaded policy belongs to, when the caller knows it. */
export interface PolicyOwner {
  readonly persona?: string;
  readonly jobId?: string;
}

function canonical(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isSameOrInside(path: string, base: string): boolean {
  const p = canonical(path);
  const b = canonical(base);
  return p === b || p.startsWith(b.endsWith(sep) ? b : b + sep);
}

/**
 * Classifies the directory a compiled-policy.json was read from. The package
 * and global directories are recognized by location (a workflow state on the
 * "global" persona loads the global policy); any other directory belongs to
 * the persona or job named in `owner`, when given.
 */
export function classifyPolicySource(compiledPolicyPath: string, owner: PolicyOwner = {}): PolicySource {
  const dir = dirname(compiledPolicyPath);
  if (isSameOrInside(dir, getPackageConfigDir())) return { kind: 'package' };
  if (canonical(dir) === canonical(getUserGeneratedDir())) return { kind: 'user' };
  if (owner.persona !== undefined) return { kind: 'persona', name: owner.persona };
  if (owner.jobId !== undefined) return { kind: 'job', id: owner.jobId };
  return { kind: 'other' };
}

/** How to rebuild a stale policy from `source` (one sentence). */
export function policyRebuildHint(source: PolicySource, policyDir: string): string {
  switch (source.kind) {
    case 'package':
      // Shipped policies (the default and the read-only one) are compiled
      // against the shipped annotations, so the usual cause is the user's own
      // annotations replacing those. `compile-policy` rebuilds only the main
      // policy; resetting the annotations fixes either.
      return (
        'It is a policy shipped with IronCurtain, compiled against the shipped tool annotations. If your own ' +
        'tool annotations (from `ironcurtain annotate-tools`) replace those, run ' +
        '`ironcurtain annotate-tools --reset` to go back to the shipped ones (or, for the main policy, ' +
        '`ironcurtain compile-policy` to compile one of your own); otherwise reinstall IronCurtain.'
      );
    case 'user':
      return 'Run `ironcurtain compile-policy` to rebuild it.';
    case 'persona':
      return `Run \`ironcurtain persona compile ${serverNameForCommand(source.name)}\` to rebuild it.`;
    case 'job':
      return `Run \`ironcurtain daemon recompile-job ${serverNameForCommand(source.id)}\` to rebuild it.`;
    case 'other':
      return `Recompile it (for example \`ironcurtain compile-policy --output-dir ${toDisplayText(policyDir)}\`).`;
  }
}

export interface PolicyProvenanceCheckOptions {
  /** `policy.onStale` from the user config. Absent means 'warn'. */
  readonly onStale?: PolicyOnStale;
  /** Receives each warning, newline-terminated (default: stderr). */
  readonly report?: (text: string) => void;
  /** Persona or cron job the policy belongs to, for the rebuild hint. */
  readonly owner?: PolicyOwner;
}

/**
 * Assesses `policy` (read from `compiledPolicyPath`) against this IronCurtain
 * and `annotations` (the annotations in effect; omitted, they are not
 * compared). A stale policy is reported through `report` and used, or, with
 * `onStale: 'refuse'`, rejected with {@link StalePolicyError}. Rules without
 * a server condition are reported but never refused on their own.
 */
export function checkPolicyProvenance(
  policy: CompiledPolicyFile,
  compiledPolicyPath: string,
  annotations: StoredToolAnnotationsFile | undefined,
  options: PolicyProvenanceCheckOptions = {},
): PolicyProvenanceAssessment {
  const assessment = assessPolicyProvenance(policy, annotations);
  const report =
    options.report ??
    ((text: string) => {
      process.stderr.write(text);
    });
  const where = toDisplayText(compiledPolicyPath);
  const hint = policyRebuildHint(classifyPolicySource(compiledPolicyPath, options.owner), dirname(compiledPolicyPath));

  if (assessment.staleReasons.length > 0) {
    const reasons = assessment.staleReasons.map(describePolicyStaleReason);
    if (options.onStale === 'refuse') {
      throw new StalePolicyError(
        compiledPolicyPath,
        `Refusing the compiled policy at ${where} because policy.onStale is "refuse": ${reasons.join('; ')}. ${hint}`,
      );
    }
    report(
      `Warning: the compiled policy at ${where} may be stale:\n` +
        reasons.map((reason) => `  - ${reason}\n`).join('') +
        `  ${hint} To refuse stale policies instead of using them, set "policy": { "onStale": "refuse" } ` +
        `in ${toDisplayText(getUserConfigPath())}.\n`,
    );
  }
  const unscoped = describeUnscopedRules(assessment.unscopedRules);
  if (unscoped !== undefined) report(`Warning: the compiled policy at ${where}: ${unscoped}. ${hint}\n`);
  return assessment;
}
