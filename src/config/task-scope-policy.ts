/**
 * Task-scope policy directories (`--task-scoped`).
 *
 * A task scope is a policy compiled from the task text of one session or
 * workflow run. The policy engine intersects it with the session's own
 * policy (global, persona or job): a call runs only when both allow it, a
 * call the task scope does not cover escalates instead of being denied, and
 * otherwise the most restrictive decision wins (see `PolicyEngine`). A task
 * scope can therefore only ever narrow the session policy, never widen it.
 *
 * Compiled task scopes are cached under `{home}/task-policies/{key}/`, where
 * the key hashes everything the compile depends on (see
 * `compileTaskScopePolicy` in `src/cron/compile-task-policy.ts`). A
 * directory holds the merged `compiled-policy.json` (plus
 * `dynamic-lists.json` when the task needs lists) and `task-scope.json`, the
 * record below, which is part of the directory when it is published.
 *
 * A leaf module: the CLI entry points compile task scopes through the
 * sanctioned pipeline seam, while the session layer, the workflow
 * orchestrator and the trusted process only check and read published
 * directories here, so none of them imports the pipeline.
 */

import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { checkScopedPolicy, hashConstitutionText } from './constitution-hash.js';

/** File name of the task-scope record inside a task-scope directory. */
export const TASK_SCOPE_RECORD_FILENAME = 'task-scope.json';

/** Bumped whenever the compile, the cache key or the record changes meaning. */
export const TASK_SCOPE_FORMAT_VERSION = 1;

/** What a task-scope directory records about its compile (`task-scope.json`). */
export interface TaskScopeRecord {
  readonly version: typeof TASK_SCOPE_FORMAT_VERSION;
  /** The cache key, which is also the directory name. */
  readonly key: string;
  /** The task text the policy was compiled from (surrounding whitespace removed). */
  readonly task: string;
  /** SHA-256 of `task`; the compiled policy records the same value as `constitutionHash`. */
  readonly taskHash: string;
  /**
   * The directory the compile was told is structurally allowed: the
   * session's `--workspace`, or a fixed placeholder for a fresh sandbox
   * (whose path does not exist yet when the scope is compiled). Sandbox
   * containment at run time always uses the session's real directory.
   */
  readonly allowedDirectory: string;
  readonly createdAt: string;
  /**
   * False when at least one server failed to compile. Such a scope has no
   * rules for that server, so every call to it escalates; it serves the
   * session it was compiled for but is never reused from the cache.
   */
  readonly complete: boolean;
}

/** Error code carried by {@link TaskScopePolicyError}. */
export type TaskScopePolicyErrorCode = 'TASK_SCOPE_INVALID';

/**
 * Thrown when a task-scope directory cannot be enforced. Catchers across
 * module boundaries match on `code`, not on `instanceof`.
 */
export class TaskScopePolicyError extends Error {
  readonly code: TaskScopePolicyErrorCode = 'TASK_SCOPE_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'TaskScopePolicyError';
  }
}

/** Result of {@link checkTaskScopeDir}. */
export type TaskScopeDirCheck =
  { readonly ok: true; readonly record: TaskScopeRecord } | { readonly ok: false; readonly message: string };

/**
 * Parses a `task-scope.json` value. Returns undefined for anything that is
 * not a record of the current format.
 */
export function parseTaskScopeRecord(value: unknown): TaskScopeRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== TASK_SCOPE_FORMAT_VERSION) return undefined;
  const { key, task, taskHash, allowedDirectory, createdAt, complete } = record;
  if (
    typeof key !== 'string' ||
    typeof task !== 'string' ||
    task.trim() === '' ||
    typeof taskHash !== 'string' ||
    typeof allowedDirectory !== 'string' ||
    typeof createdAt !== 'string' ||
    typeof complete !== 'boolean'
  ) {
    return undefined;
  }
  return { version: TASK_SCOPE_FORMAT_VERSION, key, task, taskHash, allowedDirectory, createdAt, complete };
}

/**
 * Checks that `dir` is a published task-scope directory whose compiled
 * policy implements its recorded task: the record parses, is filed under
 * its own key, hashes its task to the recorded `taskHash`, and
 * `compiled-policy.json` records that same hash. Fails closed: anything
 * unreadable, malformed or inconsistent is reported as a problem.
 *
 * `dir` should already be canonical (`validatePolicyDir`); this check does
 * not confine it.
 */
export function checkTaskScopeDir(dir: string): TaskScopeDirCheck {
  const recordPath = resolve(dir, TASK_SCOPE_RECORD_FILENAME);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(recordPath, 'utf-8'));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      ok: false,
      message:
        code === 'ENOENT' || code === 'ENOTDIR'
          ? `No task scope at ${dir} (${TASK_SCOPE_RECORD_FILENAME} is missing)`
          : `The task scope record ${recordPath} cannot be read`,
    };
  }
  const record = parseTaskScopeRecord(parsed);
  if (record === undefined) {
    return { ok: false, message: `The task scope record ${recordPath} is not valid` };
  }
  if (basename(dir) !== record.key) {
    return { ok: false, message: `The task scope record ${recordPath} belongs to another directory` };
  }
  if (hashConstitutionText(record.task) !== record.taskHash) {
    return { ok: false, message: `The task scope record ${recordPath} does not match its task` };
  }
  const policy = checkScopedPolicy(dir, record.task);
  if (policy.kind === 'missing') {
    return { ok: false, message: `The task scope at ${dir} has no compiled policy` };
  }
  if (policy.kind === 'stale') {
    return { ok: false, message: `The task scope at ${dir} cannot be trusted: ${policy.detail}` };
  }
  return { ok: true, record };
}

/**
 * Like {@link checkTaskScopeDir}, but throws.
 *
 * @throws {TaskScopePolicyError} when the directory cannot be enforced.
 */
export function requireTaskScopeDir(dir: string): TaskScopeRecord {
  const check = checkTaskScopeDir(dir);
  if (!check.ok) throw new TaskScopePolicyError(check.message);
  return check.record;
}
