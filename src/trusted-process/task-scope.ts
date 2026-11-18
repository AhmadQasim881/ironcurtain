/**
 * Loads a session's task scope (`--task-scoped`) for the policy engine.
 *
 * The single runtime reader of task-scope directories: the sandbox and the
 * in-process trusted process both build their coordinator's task scope
 * here from `IronCurtainConfig.taskPolicyDir`. The directory is confined to
 * the trusted roots and canonicalized first, then checked against its
 * record (`checkTaskScopeDir`), and the artifacts are read from that
 * canonical path only, with no fallback to any other policy: a task scope
 * that cannot be read refuses the session instead of silently running it
 * unscoped.
 */

import { loadPersonaPolicyArtifacts } from '../config/index.js';
import { requireTaskScopeDir, TaskScopePolicyError } from '../config/task-scope-policy.js';
import { validatePolicyDir } from '../config/validate-policy-dir.js';
import type { TaskScopePolicy } from './policy-types.js';

/** A loaded task scope plus where it was read from. */
export interface LoadedTaskScope {
  readonly policy: TaskScopePolicy;
  /** Canonical (realpath) directory the scope was read from. */
  readonly policyDir: string;
  /** The task text the scope was compiled from. */
  readonly task: string;
}

/**
 * Reads the task scope published at `taskPolicyDir`.
 *
 * @throws {TaskScopePolicyError} when the directory escapes the trusted
 *   roots, is not a valid task-scope directory, or its policy cannot be read.
 */
export function loadTaskScopePolicy(taskPolicyDir: string): LoadedTaskScope {
  let canonical: string;
  try {
    canonical = validatePolicyDir(taskPolicyDir);
  } catch (err) {
    throw new TaskScopePolicyError(`Task scope rejected: ${err instanceof Error ? err.message : String(err)}`);
  }
  const record = requireTaskScopeDir(canonical);
  let artifacts: ReturnType<typeof loadPersonaPolicyArtifacts>;
  try {
    artifacts = loadPersonaPolicyArtifacts(canonical);
  } catch (err) {
    throw new TaskScopePolicyError(
      `Task scope at ${canonical} cannot be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // The policy actually loaded must be the one the record vouches for (it is
  // read a second time above, after the record check).
  if (artifacts.compiledPolicy.constitutionHash !== record.taskHash) {
    throw new TaskScopePolicyError(`Task scope at ${canonical} changed while it was being loaded`);
  }
  if (!Array.isArray(artifacts.compiledPolicy.rules)) {
    throw new TaskScopePolicyError(`Task scope at ${canonical} has a malformed compiled policy`);
  }
  const policy: TaskScopePolicy = {
    compiledPolicy: artifacts.compiledPolicy,
    ...(artifacts.dynamicLists ? { dynamicLists: artifacts.dynamicLists } : {}),
  };
  return { policy, policyDir: canonical, task: record.task };
}
