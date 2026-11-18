/**
 * `ironcurtain doctor` checks for the active compiled policy:
 *
 *   - Policy source: where the policy and the tool annotations in effect come
 *     from (shipped with IronCurtain, or the user's).
 *   - Policy provenance: whether the policy's provenance matches this
 *     IronCurtain and those annotations (src/policy-artifacts/provenance.ts),
 *     the same assessment session start applies.
 *   - Scenario replay: the stored scenarios replayed offline against the
 *     current policy engine, annotations and dynamic lists; a decision that
 *     differs from the one recorded at verification marks the policy stale.
 *   - Policy invariants: the universal handwritten scenarios (writes and
 *     moves out of the sandbox are never allowed) evaluated against the
 *     active policy, whoever compiled it.
 *
 * Everything here is offline and read-only: no LLM, no MCP server, no writes.
 * Like checks.ts, these functions never call process.exit, and they never
 * throw: a damaged policy or scenarios file is reported as a result.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { extractServerDomainAllowlists } from '../config/index.js';
import { classifyPolicySource, policyRebuildHint } from '../config/policy-provenance-check.js';
import { isOverlayEntryInEffect, type ToolAnnotationsOverlayReport } from '../config/tool-annotations-overlay.js';
import type { IronCurtainConfig } from '../config/types.js';
import { getHandwrittenScenarios } from '../pipeline/handwritten-scenarios.js';
import type {
  CompiledPolicyFile,
  DynamicListsFile,
  StoredToolAnnotationsFile,
  TestScenariosFile,
} from '../pipeline/types.js';
import {
  assessPolicyProvenance,
  describePolicyStaleReason,
  describeUnscopedRules,
  quoteArtifactName,
} from '../policy-artifacts/provenance.js';
import {
  findScenarioViolations,
  replayRecordedDecisions,
  type ScenarioDecisionChange,
} from '../policy-artifacts/scenario-replay.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import { PolicyEngine } from '../trusted-process/policy-engine.js';
import { isPlainObject } from '../utils/is-plain-object.js';
import type { CheckResult } from './checks.js';

/** The loaded policy artifacts the checks inspect (from `checkPolicyArtifacts`). */
export interface LoadedPolicyArtifacts {
  readonly compiledPolicy: CompiledPolicyFile;
  readonly compiledPolicyPath: string;
  readonly toolAnnotations: StoredToolAnnotationsFile;
  readonly toolAnnotationsOverlay: ToolAnnotationsOverlayReport;
  readonly dynamicLists: DynamicListsFile | undefined;
}

/** At most this many changed scenarios or violations are listed in a message. */
const MAX_LISTED = 3;

function listed<T>(items: readonly T[], describe: (item: T) => string): string {
  const shown = items.slice(0, MAX_LISTED).map(describe).join('; ');
  return items.length > MAX_LISTED ? `${shown}; and ${items.length - MAX_LISTED} more` : shown;
}

/** How to rebuild the active policy (see `policyRebuildHint`). */
function rebuildHint(loaded: LoadedPolicyArtifacts): string {
  return policyRebuildHint(classifyPolicySource(loaded.compiledPolicyPath), dirname(loaded.compiledPolicyPath));
}

/**
 * Runs one check over artifacts that may be damaged or edited by hand. These
 * are the only doctor checks that read the policy's rules and the stored
 * scenarios, so an exception (rules that are not an array, a rule without
 * `if`, a scenario that is not an object) becomes a `status` result naming
 * the problem instead of ending the doctor run.
 */
function guarded(
  name: string,
  status: 'warn' | 'fail',
  problem: string,
  run: () => CheckResult,
  hint?: () => string,
): CheckResult {
  try {
    return run();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { name, status, message: `${problem}: ${toDisplayText(reason)}`, ...(hint ? { hint: hint() } : {}) };
  }
}

/** Reports where the active policy and the tool annotations in effect come from. */
export function checkPolicySource(loaded: LoadedPolicyArtifacts): CheckResult {
  return guarded('Policy source', 'warn', 'could not be determined', () => describePolicySource(loaded));
}

function describePolicySource(loaded: LoadedPolicyArtifacts): CheckResult {
  const source = classifyPolicySource(loaded.compiledPolicyPath);
  const where = toDisplayText(loaded.compiledPolicyPath);
  const policy =
    source.kind === 'package'
      ? `the policy shipped with IronCurtain (${where})`
      : source.kind === 'user'
        ? `your compiled policy (${where})`
        : `the compiled policy at ${where}`;
  const overlayServers = loaded.toolAnnotationsOverlay.decisions.filter((d) => isOverlayEntryInEffect(d.resolution));
  const annotations =
    overlayServers.length === 0
      ? 'the tool annotations shipped with IronCurtain'
      : `the shipped tool annotations with yours for ${overlayServers.map((d) => quoteArtifactName(d.server)).join(', ')}`;
  return { name: 'Policy source', status: 'ok', message: `${policy}, evaluated with ${annotations}` };
}

/**
 * Reports whether the active policy's provenance matches this IronCurtain and
 * the annotations in effect. Stale is a warning, or a failure when
 * `policy.onStale` is "refuse" (sessions will then not start). A policy that
 * cannot be assessed (malformed rules) fails: sessions cannot load it either.
 */
export function checkPolicyProvenanceStatus(config: IronCurtainConfig, loaded: LoadedPolicyArtifacts): CheckResult {
  return guarded(
    'Policy provenance',
    'fail',
    'the compiled policy is malformed',
    () => assessProvenanceStatus(config, loaded),
    () => rebuildHint(loaded),
  );
}

function assessProvenanceStatus(config: IronCurtainConfig, loaded: LoadedPolicyArtifacts): CheckResult {
  const name = 'Policy provenance';
  const assessment = assessPolicyProvenance(loaded.compiledPolicy, loaded.toolAnnotations);
  const source = classifyPolicySource(loaded.compiledPolicyPath);
  const hint = rebuildHint(loaded);
  const unscoped = describeUnscopedRules(assessment.unscopedRules);

  if (assessment.staleReasons.length > 0) {
    const reasons = assessment.staleReasons.map(describePolicyStaleReason);
    if (unscoped !== undefined) reasons.push(unscoped);
    const refuse = config.userConfig.policy?.onStale === 'refuse';
    return {
      name,
      status: refuse ? 'fail' : 'warn',
      message: `${refuse ? 'stale, so sessions refuse it (policy.onStale is "refuse")' : 'stale'}: ${reasons.join('; ')}`,
      hint,
    };
  }

  const p = assessment.provenance;
  const versions = p
    ? `compiler epoch ${p.policyCompilerEpoch}, engine v${p.engineSemanticsVersion}, verifier v${p.verifierVersion}`
    : '';
  const builtBy =
    source.kind === 'package' || p === undefined
      ? `shipped with IronCurtain (${versions})`
      : `compiled by IronCurtain ${toDisplayText(p.producerVersion)}` +
        `${p.policyModelId !== undefined ? ` with ${toDisplayText(p.policyModelId)}` : ''} (${versions})`;
  if (unscoped !== undefined) {
    return { name, status: 'warn', message: `${builtBy}; ${unscoped}`, hint };
  }
  return {
    name,
    status: 'ok',
    message: `${builtBy}; matches this IronCurtain and the tool annotations in effect`,
  };
}

function engineFor(config: IronCurtainConfig, loaded: LoadedPolicyArtifacts, allowedDirectory: string): PolicyEngine {
  return new PolicyEngine(
    loaded.compiledPolicy,
    loaded.toolAnnotations,
    config.protectedPaths,
    allowedDirectory,
    extractServerDomainAllowlists(config.mcpServers),
    loaded.dynamicLists,
  );
}

/** Reads the test-scenarios.json written with the policy, or explains why it cannot be used. */
function readStoredScenarios(
  loaded: LoadedPolicyArtifacts,
): { readonly file: TestScenariosFile } | { readonly skip: string } {
  const path = resolve(dirname(loaded.compiledPolicyPath), 'test-scenarios.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return { skip: `no readable stored scenarios next to the policy (${toDisplayText(path)})` };
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.scenarios)) {
    return { skip: `${toDisplayText(path)} is not a scenarios file` };
  }
  const file = parsed as unknown as TestScenariosFile;
  if (file.inputHash !== loaded.compiledPolicy.inputHash) {
    return { skip: 'the stored scenarios belong to another compile of the policy' };
  }
  return { file };
}

function describeChange(change: ScenarioDecisionChange): string {
  return (
    `${quoteArtifactName(change.description)} (${quoteArtifactName(`${change.serverName}/${change.toolName}`)}): ` +
    `${change.recorded} -> ${change.actual} (rule ${quoteArtifactName(change.rule)})`
  );
}

/**
 * Replays the stored scenarios of the active policy offline and compares each
 * decision with the one recorded when the rules passed verification. Stored
 * scenarios that cannot be replayed (a damaged file) are a warning: sessions
 * never read them.
 */
export function checkStoredScenarioReplay(config: IronCurtainConfig, loaded: LoadedPolicyArtifacts): CheckResult {
  return guarded(
    'Scenario replay',
    'warn',
    'the stored scenarios could not be replayed',
    () => replayStoredScenarios(config, loaded),
    () => rebuildHint(loaded),
  );
}

function replayStoredScenarios(config: IronCurtainConfig, loaded: LoadedPolicyArtifacts): CheckResult {
  const name = 'Scenario replay';
  const stored = readStoredScenarios(loaded);
  if ('skip' in stored) return { name, status: 'skip', message: stored.skip };
  const replay = stored.file.replay;
  if (replay === undefined) {
    const shipped = classifyPolicySource(loaded.compiledPolicyPath).kind === 'package';
    return {
      name,
      status: 'skip',
      message: shipped
        ? "the shipped policy's stored scenarios record no decisions (IronCurtain's own tests verify it)"
        : 'the stored scenarios record no decisions (written before IronCurtain recorded them)',
    };
  }
  if (typeof replay.allowedDirectory !== 'string') {
    return { name, status: 'warn', message: 'the recorded decisions are malformed' };
  }
  const outcome = replayRecordedDecisions(engineFor(config, loaded, replay.allowedDirectory), stored.file);
  const hint = rebuildHint(loaded);
  switch (outcome.kind) {
    case 'not-recorded':
      return { name, status: 'skip', message: 'the stored scenarios record no decisions' };
    case 'mismatched':
      return { name, status: 'warn', message: 'the recorded decisions do not match the stored scenarios', hint };
    case 'replayed':
      if (outcome.changes.length === 0) {
        return {
          name,
          status: 'ok',
          message: `${outcome.replayed} stored scenario(s) give the decisions recorded when the policy was verified`,
        };
      }
      return {
        name,
        status: 'warn',
        message:
          `stale: ${outcome.changes.length} of ${outcome.replayed} stored scenario(s) now get another decision than ` +
          `when the policy was verified (policy engine, tool annotations or dynamic lists changed): ` +
          listed(outcome.changes, describeChange),
        hint,
      };
  }
}

/**
 * Evaluates the universal handwritten invariants (writes and moves out of the
 * sandbox are never allowed) against the active policy. A policy the engine
 * cannot be built from or evaluate fails: sessions cannot use it either.
 */
export function checkPolicyInvariants(config: IronCurtainConfig, loaded: LoadedPolicyArtifacts): CheckResult {
  return guarded(
    'Policy invariants',
    'fail',
    'the compiled policy could not be evaluated',
    () => evaluateInvariants(config, loaded),
    () => rebuildHint(loaded),
  );
}

function evaluateInvariants(config: IronCurtainConfig, loaded: LoadedPolicyArtifacts): CheckResult {
  const name = 'Policy invariants';
  const scenarios = getHandwrittenScenarios(config.allowedDirectory);
  const violations = findScenarioViolations(engineFor(config, loaded, config.allowedDirectory), scenarios);
  if (violations.length === 0) {
    return { name, status: 'ok', message: `${scenarios.length} universal invariant(s) hold` };
  }
  return {
    name,
    status: 'warn',
    message:
      `the policy breaks ${violations.length} universal invariant(s): ` +
      listed(
        violations,
        (v) => `${quoteArtifactName(v.description)} gets ${v.actual} (rule ${quoteArtifactName(v.rule)})`,
      ),
    hint: rebuildHint(loaded),
  };
}
