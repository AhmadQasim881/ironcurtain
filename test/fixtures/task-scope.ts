/**
 * Task-scope (`--task-scoped`) fixtures: published task-scope directories
 * written by hand, as `compileTaskScopePolicy` would publish them, so
 * runtime tests (engine, coordinator, session, workflow) need no compile.
 *
 * The directory lives under the CURRENT `IRONCURTAIN_HOME`
 * (`{home}/task-policies/{key}/`), so set the home before calling.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hashConstitutionText } from '../../src/config/constitution-hash.js';
import { getTaskPolicyDir } from '../../src/config/paths.js';
import {
  TASK_SCOPE_FORMAT_VERSION,
  TASK_SCOPE_RECORD_FILENAME,
  type TaskScopeRecord,
} from '../../src/config/task-scope-policy.js';
import type { CompiledPolicyFile, CompiledRule } from '../../src/pipeline/types.js';

/** A compiled rule in the shape the compiler emits. */
export function scopeRule(
  name: string,
  server: string,
  cond: Partial<CompiledRule['if']>,
  then: CompiledRule['then'] = 'allow',
): CompiledRule {
  return {
    name,
    description: `${name} (task scope)`,
    principle: 'task scope',
    if: { server: [server], ...cond },
    then,
    reason: `${name} reason`,
  };
}

/** The compiled policy of a task scope compiled from `task`. */
export function taskScopePolicy(task: string, rules: CompiledRule[]): CompiledPolicyFile {
  return {
    generatedAt: '2026-01-01T00:00:00.000Z',
    constitutionHash: hashConstitutionText(task),
    inputHash: 'task-scope-fixture',
    rules,
  };
}

/**
 * Writes a published task-scope directory for `task` with `rules` and
 * returns its path. `recordOverrides` lets a test corrupt the record.
 */
export function writeTaskScopeDir(
  task: string,
  rules: CompiledRule[],
  recordOverrides: Partial<Record<keyof TaskScopeRecord, unknown>> = {},
): string {
  const key = hashConstitutionText(`fixture:${task}`);
  const dir = getTaskPolicyDir(key);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'compiled-policy.json'), JSON.stringify(taskScopePolicy(task, rules)));
  const record: Record<string, unknown> = {
    version: TASK_SCOPE_FORMAT_VERSION,
    key,
    task,
    taskHash: hashConstitutionText(task),
    allowedDirectory: '/tmp/task-scope-fixture-workspace',
    createdAt: '2026-01-01T00:00:00.000Z',
    complete: true,
    ...recordOverrides,
  };
  writeFileSync(resolve(dir, TASK_SCOPE_RECORD_FILENAME), JSON.stringify(record));
  return dir;
}
