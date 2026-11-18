/**
 * The per-run copy of a workflow definition (`<runDir>/definition.json`).
 *
 * `start()` writes the validated definition next to the checkpoint so a
 * resume does not depend on the original file still existing, unchanged.
 * The copy carries the same format stamp as the checkpoint
 * (`schemaVersion`, `writerVersion`, see `checkpoint.ts`): a reader refuses a
 * newer format with `WORKFLOW_CHECKPOINT_TOO_NEW` instead of reporting the
 * run as corrupted or silently dropping fields it does not know (an older
 * reader used to strip a newer `settings.resourceBudget` and resume with the
 * looser global limits). The stamp keys are removed before validation, so
 * the definition schema itself never sees them.
 */

import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { readUntrustedRegularFile, writeFileNoFollowAtomic } from '../hardened-fs.js';
import { VERSION } from '../version.js';
import { isWorkflowRunFileTooNewError, readRunFileSchemaVersion } from './checkpoint.js';
import {
  runsCommandsOnHost,
  validateDefinition,
  WorkflowValidationError,
  type ValidateDefinitionOptions,
} from './validate.js';
import type { WorkflowDefinition } from './types.js';
import type { DefinitionLoadResult } from './definition-loader.js';

export const RUN_DEFINITION_FILENAME = 'definition.json';

/**
 * Version of the definition-copy format this build writes and the newest it
 * reads. 1 is the unstamped copy of earlier releases. The definition schema
 * itself is still checked by `validateDefinition` (which rejects unknown
 * settings keys), so a newer writer's fields fail loudly either way.
 */
export const RUN_DEFINITION_SCHEMA_VERSION = 2;

const RUN_DEFINITION_FILE_MODE = 0o600;
const MAX_RUN_DEFINITION_BYTES = 16 * 1024 * 1024;
const STAMP_KEYS: ReadonlySet<string> = new Set(['schemaVersion', 'writerVersion']);

/**
 * Validation allowances for a run's recorded definition when it is only
 * shown or checked (a past run's display, an import, the host-command trust
 * check), never executed as loaded. A run recorded before a validation rule
 * existed (a host deterministic state without `host: true`, two personas in
 * one shared-container scope without `allowMixedPersonas: true`) still loads,
 * so it stays visible and its host commands are still recognised. `resume()`
 * validates without these allowances, so such a run executes only once its
 * definition copy is fixed.
 */
export const RECORDED_DEFINITION_ALLOWANCES: Readonly<ValidateDefinitionOptions> = {
  allowUnacknowledgedHostStates: true,
  allowMixedPersonaScopes: true,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deterministic states of `definition` whose commands run on the host (not in
 * the workflow's container), acknowledged with `host: true` or not. A run
 * that arrives from outside this home needs explicit trust before these run.
 */
export function hostCommandStates(definition: WorkflowDefinition): string[] {
  return Object.entries(definition.states)
    .filter(([, state]) => state.type === 'deterministic' && runsCommandsOnHost(state))
    .map(([stateId]) => stateId);
}

/** Path of the definition copy inside a run directory. */
export function runDefinitionPath(runDir: string): string {
  return resolve(runDir, RUN_DEFINITION_FILENAME);
}

/**
 * Durably and atomically writes `definition` as the run's definition copy
 * (temporary file, fsync, rename, directory fsync), stamped with the format
 * version and the writing IronCurtain version. Like the checkpoint store, it
 * follows a symlinked run directory but never the file name itself.
 */
export function writeRunDefinition(runDir: string, definition: WorkflowDefinition): void {
  const record: Record<string, unknown> = { schemaVersion: RUN_DEFINITION_SCHEMA_VERSION, writerVersion: VERSION };
  for (const [key, value] of Object.entries(definition)) {
    if (!STAMP_KEYS.has(key)) record[key] = value;
  }
  writeFileNoFollowAtomic(
    realpathSync(runDir),
    RUN_DEFINITION_FILENAME,
    JSON.stringify(record, null, 2),
    RUN_DEFINITION_FILE_MODE,
  );
}

/**
 * Reads and parses a run's definition copy (no symlink followed, size
 * bounded), checks its format version and returns the definition without the
 * stamp, ready for `validateDefinition`. Throws `WorkflowRunFileTooNewError`
 * for a newer format and an ordinary error for an unreadable or non-JSON file.
 */
export function readRunDefinitionRaw(path: string): unknown {
  const { bytes } = readUntrustedRegularFile(path, { maxBytes: MAX_RUN_DEFINITION_BYTES });
  const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  if (!isPlainObject(parsed)) return parsed;
  readRunFileSchemaVersion(path, parsed, RUN_DEFINITION_SCHEMA_VERSION);
  const definition: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!STAMP_KEYS.has(key)) definition[key] = value;
  }
  return definition;
}

/** {@link DefinitionLoadResult} plus the refusal of a newer format. */
export type RunDefinitionLoadResult =
  DefinitionLoadResult | { readonly ok: false; readonly kind: 'too_new'; readonly message: string };

/**
 * Reads, version-checks and validates a run's definition copy. Never throws;
 * the result says which step failed, like `loadDefinition`.
 */
export function loadRunDefinition(path: string, options: ValidateDefinitionOptions = {}): RunDefinitionLoadResult {
  let raw: unknown;
  try {
    raw = readRunDefinitionRaw(path);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return isWorkflowRunFileTooNewError(err)
      ? { ok: false, kind: 'too_new', message }
      : { ok: false, kind: 'parse', message };
  }
  try {
    return { ok: true, definition: validateDefinition(raw, options) };
  } catch (err) {
    if (err instanceof WorkflowValidationError) {
      return {
        ok: false,
        kind: 'validate',
        message: `Workflow validation failed: ${err.issues.join('; ')}`,
        issues: err.issues,
      };
    }
    return { ok: false, kind: 'validate', message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The host-command states of the run's own definition copy. A foreign run
 * without that copy is refused by resume; never open a checkpoint-selected
 * original package while deciding whether the run requires explicit trust.
 *
 * Loaded with {@link RECORDED_DEFINITION_ALLOWANCES}, so a rule that resume
 * enforces never hides the host commands from this check.
 */
export function hostCommandStatesForResume(runDir: string): string[] {
  const copyPath = runDefinitionPath(runDir);
  let loaded: RunDefinitionLoadResult | undefined;
  if (existsSync(copyPath)) {
    loaded = loadRunDefinition(copyPath, RECORDED_DEFINITION_ALLOWANCES);
  }
  return loaded?.ok === true ? hostCommandStates(loaded.definition) : [];
}
