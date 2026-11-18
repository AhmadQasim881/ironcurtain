/**
 * Per-server policy artifacts under `<outputDir>/servers/<serverName>/`, and
 * the rules deciding which of them the per-server compile cache may serve.
 *
 * Cache-eligible pair (the only files the cache reads):
 *   compiled-policy.json  Rules that PASSED verification, with `verified: true`
 *                         in the same atomic write as the rules. Written last:
 *                         it is the commit point of a successful compile.
 *   test-scenarios.json   The scenarios those rules were verified against.
 *                         Written first.
 *
 * Inspection copies (never read back by the pipeline):
 *   compiled-policy.unverified.json  Rules persisted right after compilation,
 *                                    after every repair, and when verification
 *                                    fails, with `verified: false`.
 *   test-scenarios.unverified.json   Scenarios of a failed verification.
 *
 * `dynamic-lists.json` (resolved list values, cached per list by their own
 * input hash) is written by list resolution and is not part of the pair. It is
 * ignored for a commit whose rules define no lists.
 *
 * A recompile removes the pair before its first write. An abort, LLM or network
 * error, or crash therefore can never leave newly compiled, unverified rules
 * (or a new policy beside an older scenarios file) where the cache would serve
 * them on the next run. Re-verifying a commit's own rules (its scenario hash or
 * engine version no longer matches) keeps the pair until the new verdict:
 * every later run re-verifies them again until a commit records the new
 * scenario hash and engine version, so they are never served unverified.
 *
 * The commit carries `rulesHash`, a digest of exactly the rules and list
 * definitions that passed. A commit whose rules no longer match it (edited
 * after verification) is not served.
 */

import { resolve } from 'node:path';
import { canonicalDigest } from '../policy-artifacts/canonical-json.js';
import { loadExistingArtifact, removeArtifactIfExists, writeArtifact } from './pipeline-shared.js';
import type {
  CompiledRule,
  ListDefinition,
  ServerCompiledPolicyFile,
  TestScenariosFile,
  VerificationResult,
} from './types.js';

export const SERVER_POLICY_FILE = 'compiled-policy.json';
export const SERVER_SCENARIOS_FILE = 'test-scenarios.json';
export const SERVER_UNVERIFIED_POLICY_FILE = 'compiled-policy.unverified.json';
export const SERVER_UNVERIFIED_SCENARIOS_FILE = 'test-scenarios.unverified.json';

/**
 * A per-server policy before a verification verdict is attached to it. The
 * commit computes `rulesHash` itself, from the rules it writes.
 */
export type ServerPolicyDraft = Omit<ServerCompiledPolicyFile, 'verified' | 'verifiedAt' | 'rulesHash'>;

/**
 * Canonical digest of a commit's rules and list definitions (an absent list
 * array and an empty one digest the same).
 */
export function computeServerRulesHash(
  rules: readonly CompiledRule[],
  listDefinitions: readonly ListDefinition[] | undefined,
): string {
  return canonicalDigest({ rules, listDefinitions: listDefinitions ?? [] });
}

/** The last verified commit found in a server directory. */
export interface VerifiedServerArtifacts {
  readonly policy: ServerCompiledPolicyFile;
  readonly scenarios: TestScenariosFile;
}

/**
 * Returns `<outputDir>/servers/<serverName>`. The server name becomes a single
 * path segment, so a name that could leave `servers/` (a separator, `.`, `..`,
 * NUL or the empty string) is rejected.
 */
export function serverArtifactDir(outputDir: string, serverName: string): string {
  if (serverName === '' || serverName === '.' || serverName === '..' || /[/\\\0]/.test(serverName)) {
    throw new Error(`Invalid server name for an artifact directory: ${JSON.stringify(serverName)}`);
  }
  return resolve(outputDir, 'servers', serverName);
}

/**
 * Loads the verified pair from `serverDir`, or returns undefined when there is
 * no complete verified commit for `serverName`: a missing or unparseable file,
 * a policy without `verified: true` (older versions never wrote the marker, so
 * their files count as unverified), a policy recorded for another server, or
 * rules that do not match the commit's `rulesHash` (commits from before the
 * hash existed have none and count as unverified too).
 *
 * The caller must still compare `policy.inputHash` with the current inputs,
 * and the scenario hash and engine version with the current ones, before
 * serving the rules.
 */
export function loadVerifiedServerArtifacts(
  serverDir: string,
  serverName: string,
): VerifiedServerArtifacts | undefined {
  const policy = loadExistingArtifact<Partial<ServerCompiledPolicyFile>>(serverDir, SERVER_POLICY_FILE);
  if (!policy || policy.verified !== true || policy.serverName !== serverName) return undefined;
  if (typeof policy.inputHash !== 'string' || !Array.isArray(policy.rules)) return undefined;
  if (
    typeof policy.rulesHash !== 'string' ||
    policy.rulesHash !== computeServerRulesHash(policy.rules, policy.listDefinitions)
  ) {
    return undefined;
  }

  const scenarios = loadExistingArtifact<Partial<TestScenariosFile>>(serverDir, SERVER_SCENARIOS_FILE);
  if (!scenarios || typeof scenarios.inputHash !== 'string' || !Array.isArray(scenarios.scenarios)) return undefined;

  return { policy: policy as ServerCompiledPolicyFile, scenarios: scenarios as TestScenariosFile };
}

/**
 * Removes the cache-eligible pair (the policy first, because it is the commit
 * marker) and inspection copies left by an earlier run. Called when a server is
 * about to be recompiled, before anything new is written for it.
 */
export function invalidateServerArtifacts(serverDir: string): void {
  removeArtifactIfExists(serverDir, SERVER_POLICY_FILE);
  removeArtifactIfExists(serverDir, SERVER_SCENARIOS_FILE);
  removeArtifactIfExists(serverDir, SERVER_UNVERIFIED_POLICY_FILE);
  removeArtifactIfExists(serverDir, SERVER_UNVERIFIED_SCENARIOS_FILE);
}

/**
 * Persists rules that have not passed verification (crash recovery and
 * inspection). Always written with `verified: false` under the unverified name,
 * which the cache never reads.
 */
export function writeUnverifiedServerPolicy(serverDir: string, draft: ServerPolicyDraft): void {
  writeArtifact(serverDir, SERVER_UNVERIFIED_POLICY_FILE, {
    ...draft,
    verified: false,
  } satisfies ServerCompiledPolicyFile);
}

/** Persists the scenarios of a failed verification for inspection. Never read by the cache. */
export function writeUnverifiedServerScenarios(serverDir: string, scenarios: TestScenariosFile): void {
  writeArtifact(serverDir, SERVER_UNVERIFIED_SCENARIOS_FILE, scenarios);
}

/**
 * Commits a server's verified result: the scenarios first, then the policy with
 * `verified: true` and the `rulesHash` of its rules in the same atomic write as
 * the rules, then removes the inspection copies. Throws unless
 * `verification.pass` is true, so failed rules can never be committed as
 * verified.
 */
export function commitVerifiedServerArtifacts(
  serverDir: string,
  draft: ServerPolicyDraft,
  scenarios: TestScenariosFile,
  verification: Pick<VerificationResult, 'pass'>,
): void {
  if (!verification.pass) {
    throw new Error(
      `Refusing to commit rules for server "${draft.serverName}" as verified: verification did not pass.`,
    );
  }
  writeArtifact(serverDir, SERVER_SCENARIOS_FILE, scenarios);
  writeArtifact(serverDir, SERVER_POLICY_FILE, {
    ...draft,
    verified: true,
    verifiedAt: new Date().toISOString(),
    rulesHash: computeServerRulesHash(draft.rules, draft.listDefinitions),
  } satisfies ServerCompiledPolicyFile);
  removeArtifactIfExists(serverDir, SERVER_UNVERIFIED_POLICY_FILE);
  removeArtifactIfExists(serverDir, SERVER_UNVERIFIED_SCENARIOS_FILE);
}
