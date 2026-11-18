/**
 * A cron job's task-policy compile that wrote the policy without some
 * servers. Those servers failed to compile (an LLM or network error, invalid
 * rules, verification still failing after every repair: the pipeline lists
 * them in the policy's `failedServers`) and have no rules, so every call the
 * job makes to their tools is denied until a compile succeeds.
 *
 * `add-job`, `edit-job` and `recompile-job` (run here or by the daemon, whose
 * `recompile-job` reply names them) print the same warning and exit with
 * {@link PARTIAL_COMPILE_EXIT_CODE}. A leaf module, so the daemon CLI can
 * report a reply without loading the job commands.
 */

import type { CompiledPolicyFile } from '../pipeline/types.js';
import { toDisplayText } from '../terminal/display-sanitize.js';

/**
 * Exit status of a job command whose compile wrote the policy without some
 * servers (as `persona compile` and `compile-policy`): 0 is a complete
 * compile, 1 a command that wrote no usable policy.
 */
export const PARTIAL_COMPILE_EXIT_CODE = 2;

/** The servers a written policy has no rules for because they failed to compile (empty when none did). */
export function failedServerNames(policy: Pick<CompiledPolicyFile, 'failedServers'>): string[] {
  return (policy.failedServers ?? []).map((failed) => failed.serverName);
}

/** The warning a job command prints for the servers its compile left out (names shown escaped). */
export function describeFailedServers(failedServers: readonly string[]): string {
  return (
    `${failedServers.length} server(s) failed to compile and have no rules, so the job's calls to their tools ` +
    `are denied until a compile succeeds: ${failedServers.map((name) => toDisplayText(name)).join(', ')}.`
  );
}
