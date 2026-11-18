/**
 * Constitution hashing and freshness checks for scoped (per-job and
 * per-persona) compiled policies.
 *
 * A leaf module: runtime code (session, daemon, cron, persona, mux, web UI)
 * uses it to decide whether a compiled policy may be enforced, and the live
 * runtime path must not import `src/pipeline/`. It therefore recomputes the
 * pipeline's `constitutionHash` itself instead of calling the pipeline's
 * `computeHash`.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** File name of the compiled policy inside a policy directory. */
export const COMPILED_POLICY_FILENAME = 'compiled-policy.json';

/**
 * SHA-256 hex digest of a constitution, computed exactly as policy
 * compilation records `constitutionHash`: `PipelineRunner` hashes the raw
 * `constitutionInput` string with a single `hash.update(text)` (UTF-8).
 * Nothing is trimmed or normalized, so any edit, including whitespace,
 * changes the digest.
 *
 * The constitution input is `job.taskConstitution` for a cron job and the
 * verbatim contents of `constitution.md` for a persona.
 */
export function hashConstitutionText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Why a scoped compiled policy can no longer be trusted to implement its
 * inputs:
 * - `constitution`: the policy was not compiled from the current
 *   constitution (the recorded hash differs, is absent or cannot be read,
 *   or the constitution itself is gone).
 * - `engine`: reserved for provenance checks (a policy compiled for another
 *   policy-engine or tool-annotation generation). Nothing produces this
 *   reason today: compiled policies record their provenance, but it is
 *   checked when a policy is loaded (src/config/policy-provenance-check.ts,
 *   governed by `policy.onStale`), not here. Consumers already treat it like
 *   any other stale reason.
 */
export type PolicyStaleReason = 'constitution' | 'engine';

/** State of a scoped policy directory relative to the constitution it must implement. */
export type ScopedPolicyState =
  | { readonly kind: 'missing' }
  | { readonly kind: 'stale'; readonly reason: PolicyStaleReason; readonly detail: string }
  | { readonly kind: 'fresh' };

/**
 * Checks `<policyDir>/compiled-policy.json` against the constitution it must
 * have been compiled from. Pass `constitutionText` as `undefined` when the
 * constitution does not exist.
 *
 * Fails closed: anything that prevents confirming the match (unreadable or
 * malformed policy, no recorded hash, missing constitution) is reported as
 * stale. Only an absent policy file is `missing`.
 */
export function checkScopedPolicy(policyDir: string, constitutionText: string | undefined): ScopedPolicyState {
  let raw: string;
  try {
    raw = readFileSync(resolve(policyDir, COMPILED_POLICY_FILENAME), 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' };
    return stale(`${COMPILED_POLICY_FILENAME} cannot be read (${code ?? 'unknown error'})`);
  }

  let recordedHash: unknown;
  try {
    const parsed: unknown = JSON.parse(raw);
    recordedHash =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { constitutionHash?: unknown }).constitutionHash
        : undefined;
  } catch {
    return stale(`${COMPILED_POLICY_FILENAME} is not valid JSON`);
  }

  if (typeof recordedHash !== 'string' || recordedHash === '') {
    return stale('the compiled policy does not record which constitution it was compiled from');
  }
  if (constitutionText === undefined) {
    return stale('the constitution is missing or unreadable');
  }
  if (hashConstitutionText(constitutionText) !== recordedHash) {
    return stale('the constitution changed after the policy was compiled');
  }
  return { kind: 'fresh' };
}

function stale(detail: string): ScopedPolicyState {
  return { kind: 'stale', reason: 'constitution', detail };
}

/**
 * Error code carried by {@link ScopedPolicyError}. `POLICY_TOO_BROAD`: a
 * persona's compiled policy grants broad access (see the persona broad-policy
 * validator) although the persona has not opted in to broad policies. Unlike
 * `POLICY_STALE`, no caller may accept it.
 */
export type ScopedPolicyErrorCode = 'POLICY_MISSING' | 'POLICY_STALE' | 'POLICY_TOO_BROAD';

/**
 * Thrown when a scoped policy is missing, stale or (for a persona) broader
 * than the persona allows, and the caller did not or could not accept that.
 * Catchers across module boundaries match on `code`, not on `instanceof`.
 */
export class ScopedPolicyError extends Error {
  constructor(
    message: string,
    readonly code: ScopedPolicyErrorCode,
  ) {
    super(message);
    this.name = 'ScopedPolicyError';
  }
}

/** True when `err` carries the given {@link ScopedPolicyError} code (matched structurally). */
export function isScopedPolicyError(err: unknown, code: ScopedPolicyErrorCode): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code;
}
