/**
 * Fail-closed policy gate for cron jobs.
 *
 * A job runs unattended, so it may only run under the policy compiled from
 * its own constitution. A job without a persona uses its per-job policy in
 * ~/.ironcurtain/jobs/{jobId}/generated/, which must exist and record the
 * hash of the job's current `taskConstitution`. A job with a persona uses the
 * persona's policy, which must match the persona's constitution.md. Nothing
 * here falls back to another policy, and stale policies are never accepted
 * (there is no override for unattended runs).
 *
 * A resumed session restores its policy directory from session metadata
 * instead of passing the daemon's gate; {@link checkJobPolicyDir} lets session
 * creation apply the same check to a job's policy directory reached that way.
 *
 * The hash covers the constitution only, not the workspace the policy was
 * compiled against: a policy that no longer applies because the job's
 * workspace changed is taken out of use with {@link revokeJobPolicy}.
 */

import { realpathSync, renameSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import {
  COMPILED_POLICY_FILENAME,
  checkScopedPolicy,
  isScopedPolicyError,
  type ScopedPolicyState,
} from '../config/constitution-hash.js';
import { getJobGeneratedDir } from '../config/paths.js';
import { resolvePersona } from '../persona/resolve.js';
import { loadJob } from './job-store.js';
import { createJobId, type JobDefinition, type JobId } from './types.js';

/**
 * Result of {@link checkJobPolicy}. `problem` is `stale` when a policy exists
 * but no longer matches its constitution, and `missing` when there is no
 * usable policy at all (including an unknown persona).
 */
export type JobPolicyCheck =
  { readonly ok: true } | { readonly ok: false; readonly problem: 'missing' | 'stale'; readonly message: string };

/**
 * State of a job's own compiled policy (jobs/{id}/generated/) relative to
 * its `taskConstitution`, hashed exactly as `compileTaskPolicy` records it.
 * Meaningless for a job with a persona, whose own policy dir is unused.
 */
export function getJobPolicyState(job: Pick<JobDefinition, 'id' | 'taskConstitution'>): ScopedPolicyState {
  return checkScopedPolicy(getJobGeneratedDir(job.id), job.taskConstitution);
}

/**
 * Where {@link revokeJobPolicy} moves a job's compiled policy: beside it in
 * `generated/`, under a name nothing loads, kept for inspection (a later move
 * replaces it). A persona's revoked policy gets the same name.
 */
export const REVOKED_JOB_POLICY_FILENAME = 'compiled-policy.revoked.json';

/**
 * Takes a job's own compiled policy (jobs/{id}/generated/compiled-policy.json)
 * out of use by moving it to {@link REVOKED_JOB_POLICY_FILENAME}: the job then
 * has no compiled policy, so {@link checkJobPolicy} refuses it until a
 * recompile succeeds. For a policy that no longer applies although it still
 * records the hash of the job's constitution: one compiled against the
 * workspace the job had before (see compileTaskPolicy). Returns whether there
 * was a policy to move.
 */
export function revokeJobPolicy(jobId: JobId): boolean {
  const generatedDir = getJobGeneratedDir(jobId);
  try {
    renameSync(resolve(generatedDir, COMPILED_POLICY_FILENAME), resolve(generatedDir, REVOKED_JOB_POLICY_FILENAME));
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw err;
  }
}

/** The command that recompiles a job's policy. */
function recompileHint(jobId: JobId): string {
  return `ironcurtain daemon recompile-job ${jobId}`;
}

/**
 * Decides whether a job may run now. Returns a message suitable for the
 * error RunRecord and the notification when it may not. Never throws: a
 * definition whose policy cannot even be located (for example an invalid
 * id) has no usable policy either.
 */
export function checkJobPolicy(job: JobDefinition): JobPolicyCheck {
  try {
    return job.persona !== undefined ? checkPersonaPolicy(job.persona) : checkOwnPolicy(job);
  } catch (err) {
    return { ok: false, problem: 'missing', message: err instanceof Error ? err.message : String(err) };
  }
}

/** A persona job runs under the persona's policy, which must be fresh. */
function checkPersonaPolicy(persona: string): JobPolicyCheck {
  try {
    // Never passes allowStalePolicy: unattended runs refuse stale policies.
    resolvePersona(persona);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      problem: isScopedPolicyError(err, 'POLICY_STALE') ? 'stale' : 'missing',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Any other job runs under its own policy, compiled from its taskConstitution. */
function checkOwnPolicy(job: JobDefinition): JobPolicyCheck {
  return describeOwnPolicyState(job.id, getJobPolicyState(job));
}

/** Maps the state of a job's own policy to a {@link JobPolicyCheck} whose message names the fix. */
function describeOwnPolicyState(jobId: JobId, state: ScopedPolicyState): JobPolicyCheck {
  switch (state.kind) {
    case 'fresh':
      return { ok: true };
    case 'missing':
      return {
        ok: false,
        problem: 'missing',
        message: `Job "${jobId}" has no compiled policy. Compile it with: ${recompileHint(jobId)}`,
      };
    case 'stale':
      return {
        ok: false,
        problem: 'stale',
        message:
          `Job "${jobId}" has a stale compiled policy: ${state.detail}. ` +
          `Recompile it with: ${recompileHint(jobId)}`,
      };
  }
}

/**
 * The job whose own policy directory (jobs/{id}/generated/) `policyDir` is,
 * compared by real path, or undefined for any other directory (a persona's,
 * the package's, or one that does not exist).
 */
function findJobOwningPolicyDir(policyDir: string): JobId | undefined {
  try {
    const canonical = realpathSync(policyDir);
    if (basename(canonical) !== 'generated') return undefined;
    const jobId = createJobId(basename(dirname(canonical)));
    return realpathSync(getJobGeneratedDir(jobId)) === canonical ? jobId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Checks a policy directory that reaches a session without passing
 * {@link checkJobPolicy}: a resumed session restores its policyDir from
 * session metadata, so a resumed cron job session would otherwise keep
 * running a policy compiled from an older constitution. When `policyDir` is
 * a job's own policy directory, the result says whether that policy matches
 * the job's CURRENT taskConstitution (a missing job.json counts as stale).
 * Returns undefined for any other directory, such as a persona's.
 *
 * @throws InvalidJobError (code JOB_INVALID) when the job's job.json exists
 *   but is invalid: the current constitution cannot be known, so the resume
 *   is refused, also with an override for a stale policy.
 */
export function checkJobPolicyDir(policyDir: string): (JobPolicyCheck & { readonly jobId: JobId }) | undefined {
  const jobId = findJobOwningPolicyDir(policyDir);
  if (jobId === undefined) return undefined;
  const constitution: unknown = loadJob(jobId)?.taskConstitution;
  const state = checkScopedPolicy(policyDir, typeof constitution === 'string' ? constitution : undefined);
  return { jobId, ...describeOwnPolicyState(jobId, state) };
}
