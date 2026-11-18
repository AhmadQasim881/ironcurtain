/**
 * src/persona/persona-service.ts
 *
 * Headless persona lifecycle service (Phase 1a).
 *
 * Owns all file-system effects for persona CRUD and lifecycle (clone,
 * rename, the trash). Called by the CLI (persona-command.ts) and the WS
 * dispatch (persona-dispatch.ts). The CLI keeps its @clack prompts / $EDITOR /
 * customizer as arg-gatherers and its own "No changes made" diff; this module
 * performs the writes.
 *
 * ZERO runtime value-imports from src/pipeline — type-only imports only. This is
 * enforced by the Phase-0 ESLint no-restricted-imports rule and
 * test/pipeline-import-boundary.test.ts.
 *
 * The `actor` parameter on the mutating functions is USED as of Phase 1c: each
 * mutation appends a tamper-evident record to the policy-mutation audit log
 * (src/persona/policy-mutation-audit.ts), so CLI / cron / WS callers are all
 * captured at the service layer.
 *
 * Compiles are not here: every compile, CLI or WS, goes through
 * `runPersonaCompile` (persona-compile-service.ts), which holds the compile
 * lock, runs the broad-policy validator and writes the compile's audit record.
 * The operations here that move or remove a persona directory (delete,
 * rename, a forced restore) take the same lock, so they never pull a
 * directory from under a running compile.
 *
 * Personas are read only through `loadPersona` (validated, see
 * persona-definition.ts), and every path is built from the persona's
 * directory name, never from a name read out of persona.json.
 *
 * @see docs/designs/web-ui-policy-persona-management.md §4.1
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteJsonSync, atomicWriteTextSync } from '../util/atomic-write.js';
import { COMPILED_POLICY_FILENAME, hashConstitutionText } from '../config/constitution-hash.js';
import { loadMcpServers } from '../config/mcp-servers-overlay.js';
import { loadUserConfig, PERSONAS_CONFIG_DEFAULTS } from '../config/user-config.js';
import { RESERVED_SERVER_NAMES, SESSION_INJECTED_SERVER_NAMES } from '../types/reserved-servers.js';
import {
  getPersonaDir,
  getPersonaGeneratedDir,
  getPersonaConstitutionPath,
  getPersonaDefinitionPath,
  getPersonaPolicyState,
  getPersonasDir,
  getPersonaSkillsDir,
  getPersonaWorkspaceDir,
  loadPersona,
} from './resolve.js';
import { createPersonaName } from './types.js';
import type { PersonaName, PersonaDefinition, PersonaResourceBudget } from './types.js';
import {
  parsePersonaAgentModelId,
  parsePersonaResourceBudget,
  PersonaOverridesError,
  readPersonaOverrides,
} from './persona-overrides.js';
import { PERSONA_DEFINITION_FILENAME, readPersonaDefinition } from './persona-definition.js';
import {
  getPersonaTrashDir,
  listPersonaTrash,
  listPurgeRemnants,
  personaTrashEntryId,
  purgeRemnantPath,
  selectPersonaTrashEntries,
  trashEntryNotFoundError,
  type PersonaTrashEntry,
} from './persona-trash.js';
import { scanPersonaDirs, scanPersonas, type InvalidPersonaDir } from '../mux/persona-scanner.js';
import { policyMutationAuditLog } from './policy-mutation-audit.js';
import { hasBroadAccess } from './broad-policy-validator.js';
import { inspectCompiledPolicyBreadth } from './policy-breadth-check.js';
import { acquirePersonaCompileLock, PERSONA_COMPILE_LOCK_FILE } from './persona-compile-service.js';
// Type-only imports — no runtime edge to pipeline / web-ui layers.
import type { CompiledPolicyFile } from '../pipeline/types.js';
import type {
  PersonaDetailDto,
  PersonaListDto,
  PersonaEditResultDto,
  PersonaTrashEntryDto,
  PersonaTrashPurgeResultDto,
} from '../web-ui/web-ui-types.js';

// PersonaListDto / PersonaEditResultDto were promoted into web-ui-types.ts in
// Phase 1b (the 1a follow-up) so backend and frontend build against a single
// declaration. Re-export them so existing CLI/test importers of this module are
// unaffected by the move.
export type { PersonaListDto, PersonaEditResultDto } from '../web-ui/web-ui-types.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Error code for a server allowlist that names a server the configuration
 * does not have (the WS dispatch maps it to INVALID_PARAMS).
 */
export const PERSONA_UNKNOWN_SERVERS = 'PERSONA_UNKNOWN_SERVERS';

function personaExistsError(name: PersonaName, hint = ''): Error {
  return Object.assign(new Error(`Persona "${name}" already exists.${hint}`), { code: 'PERSONA_EXISTS' });
}

function personaNotFoundError(name: PersonaName): Error {
  return Object.assign(new Error(`Persona "${name}" not found.`), { code: 'PERSONA_NOT_FOUND' });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface CreatePersonaInput {
  /** Raw slug — branded and path-traversal-checked inside the service. */
  readonly name: string;
  /** Description (trimmed by the service). */
  readonly description: string;
  /**
   * Optional server allowlist. Both a full-set selection and an empty array
   * are normalized to omit the key (CLI "all = undefined" semantics, see
   * persona-command.ts server multiselect normalization). Caller passes the
   * already-normalized subset; the service only treats `[]`/absent as omit.
   * Every name must be a configured MCP server ({@link validatePersonaServers}).
   */
  readonly servers?: readonly string[];
  /**
   * Whether memory is enabled. Absent/true = omit the memory key from
   * persona.json (default-on semantics). false = memory:{enabled:false}.
   */
  readonly memoryEnabled?: boolean;
  /**
   * Constitution text (WITHOUT trailing newline). Absent or '' = empty
   * persona (no compile needed). Written atomically as constitution.md with
   * exactly one trailing newline when non-empty.
   */
  readonly constitution?: string;
}

/**
 * Normalizes constitution text into the on-disk file content. Mirrors the
 * historical CLI convention: non-empty text gets exactly one trailing newline;
 * empty text writes an empty file.
 */
function constitutionFileContent(text: string): string {
  return text ? text + '\n' : '';
}

// ---------------------------------------------------------------------------
// Server allowlist validation
// ---------------------------------------------------------------------------

/**
 * The servers a persona's allowlist may name: every configured MCP server,
 * the package's built-ins (in package order) followed by the servers the
 * user added in `~/.ironcurtain/mcp-servers.json` (in file order). The names
 * reserved for IronCurtain's internal servers (`RESERVED_SERVER_NAMES`, and
 * the session-injected memory server) are never among them: the
 * configuration refuses them, and they are filtered here too. The web UI's
 * server picker offers exactly these names (`personas.listServers`), and
 * {@link validatePersonaServers} accepts exactly these.
 *
 * @throws `MCP_SERVERS_INVALID` when the server configuration is invalid:
 *   no partial list is returned.
 */
export function listPersonaServerNames(): string[] {
  return Object.keys(loadMcpServers().servers).filter(
    (name) => !RESERVED_SERVER_NAMES.has(name) && !SESSION_INJECTED_SERVER_NAMES.has(name),
  );
}

/**
 * Refuses a server allowlist that names a server the configuration does not
 * have ({@link listPersonaServerNames}: the package's servers plus the user's
 * `~/.ironcurtain/mcp-servers.json`). Such a name is a typo, or a server that
 * was never added: it would grant nothing, and the persona would silently
 * run without the server it was meant to have.
 *
 * @throws an error with code {@link PERSONA_UNKNOWN_SERVERS}, or
 *   `MCP_SERVERS_INVALID` when the server configuration itself is invalid.
 */
export function validatePersonaServers(servers: readonly string[]): void {
  if (servers.length === 0) return;
  const known = listPersonaServerNames();
  const knownSet = new Set(known);
  const unknown = [...new Set(servers.filter((server) => !knownSet.has(server)))];
  if (unknown.length === 0) return;
  throw Object.assign(
    new Error(
      `Unknown MCP server${unknown.length === 1 ? '' : 's'} ${unknown.map((s) => JSON.stringify(s)).join(', ')}: ` +
        `a persona can only list configured servers (${known.join(', ')}; see \`ironcurtain mcp list\`).`,
    ),
    { code: PERSONA_UNKNOWN_SERVERS },
  );
}

// ---------------------------------------------------------------------------
// Directory helpers
// ---------------------------------------------------------------------------

/**
 * Where a compiled policy that must no longer be loaded is moved: beside it
 * in `generated/`, under a name nothing loads, kept for inspection (a later
 * move replaces it). A broad-policy opt-out moves a policy that needed the
 * opt-in here; a rename (and a restore under another name) moves the policy
 * compiled for the old workspace path here.
 */
export const REVOKED_POLICY_FILENAME = 'compiled-policy.revoked.json';

/**
 * Builds a whole persona tree atomically: everything is written under
 * `personas/.tmp-<name>-<uuid>/` (generated/, workspace/, persona.json,
 * constitution.md, then whatever `populate` adds), which is renamed to
 * `personas/<name>/` at the end. On any failure the temp dir is removed (no
 * half-persona on disk).
 */
function writePersonaTree(
  name: PersonaName,
  definition: PersonaDefinition,
  constitutionContent: string,
  populate?: (tmpDir: string) => void,
): void {
  const personasDir = getPersonasDir();
  const finalDir = getPersonaDir(name);

  mkdirSync(personasDir, { recursive: true, mode: 0o700 });
  const tmpDir = resolve(personasDir, `.tmp-${name}-${randomUUID()}`);
  mkdirSync(resolve(tmpDir, 'generated'), { recursive: true });
  mkdirSync(resolve(tmpDir, 'workspace'), { recursive: true });

  try {
    atomicWriteJsonSync(resolve(tmpDir, PERSONA_DEFINITION_FILENAME), definition);
    atomicWriteTextSync(resolve(tmpDir, 'constitution.md'), constitutionContent);
    populate?.(tmpDir);
    // Checked again right before the rename: another process may have
    // created the persona meanwhile (a rename onto an empty directory would
    // succeed silently).
    if (existsSync(finalDir)) throw personaExistsError(name);
    // Final atomic rename: tmp → personas/<name>/
    renameSync(tmpDir, finalDir);
  } catch (err) {
    // Roll back — no half-persona.
    rmSync(tmpDir, { recursive: true, force: true });
    throw err;
  }
}

/** Reads a text file, or returns '' when it does not exist. */
function readTextIfPresent(path: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

/**
 * Moves `generated/compiled-policy.json` aside to
 * {@link REVOKED_POLICY_FILENAME}, where nothing loads it. Returns whether
 * there was a policy to move.
 */
function moveCompiledPolicyAside(generatedDir: string): boolean {
  const policyPath = resolve(generatedDir, COMPILED_POLICY_FILENAME);
  if (!existsSync(policyPath)) return false;
  renameSync(policyPath, resolve(generatedDir, REVOKED_POLICY_FILENAME));
  return true;
}

/**
 * Removes this operation's compile lock file from a persona directory that
 * was just moved. The lock lives inside the directory
 * (`generated/.compile.lock`), so it travels with a move, where the holder's
 * `release()` (bound to the old path) can no longer reach it: left in place,
 * it would block compiles of the moved persona until its holder exits or it
 * ages out.
 */
function dropMovedCompileLock(personaDir: string, operationId: string): void {
  const lockPath = resolve(personaDir, 'generated', PERSONA_COMPILE_LOCK_FILE);
  try {
    const content = JSON.parse(readFileSync(lockPath, 'utf-8')) as { operationId?: unknown };
    if (content.operationId === operationId) unlinkSync(lockPath);
  } catch {
    // Gone or unreadable: nothing of ours to remove.
  }
}

/** How a persona directory is re-labelled for a new name (rename, restore under another name). */
interface Relabel {
  /** The definition as it is now (restored if the move fails). */
  readonly original: PersonaDefinition;
  /** The definition under the new name. */
  readonly relabeled: PersonaDefinition;
  /** This operation's compile lock, whose file moves with the directory. */
  readonly lockOperationId?: string;
}

/**
 * The definition of `persona` renamed to `newName`. The memory namespace
 * stays what it was (the old name, unless already set), so the persona's
 * own memory.db keeps serving the memories stored before the rename; it is
 * left out when it equals the new name (the default).
 */
function relabeledDefinition(persona: PersonaDefinition, newName: PersonaName): PersonaDefinition {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Destructure to omit the optional property.
  const { memoryNamespace: _omit, ...rest } = persona;
  const namespace = persona.memoryNamespace ?? persona.name;
  return namespace === newName ? { ...rest, name: newName } : { ...rest, name: newName, memoryNamespace: namespace };
}

/**
 * Moves the persona directory `fromDir` to `personas/<target>/`.
 *
 * Without `relabel` it is one rename. With it, the directory goes through a
 * staging directory under `personas/` (a dot-name no scan lists) where
 * persona.json is rewritten for the new name and the compiled policy is
 * moved aside: it was compiled for the old workspace path, so it would
 * either grant access to a directory that is no longer this persona's (and
 * could become another persona's) or be refused as out-of-workspace. The
 * persona needs a recompile. When any step fails, the steps already taken
 * are undone in reverse.
 *
 * @returns whether a compiled policy was moved aside.
 * @throws code `PERSONA_EXISTS` when `personas/<target>/` exists.
 */
function relocatePersonaDir(fromDir: string, target: PersonaName, relabel?: Relabel): boolean {
  const targetDir = getPersonaDir(target);
  mkdirSync(getPersonasDir(), { recursive: true, mode: 0o700 });
  if (!relabel) {
    if (existsSync(targetDir)) throw personaExistsError(target);
    renameSync(fromDir, targetDir);
    return false;
  }

  const staging = resolve(getPersonasDir(), `.relabel-${target}-${randomUUID()}`);
  renameSync(fromDir, staging);
  const undo: Array<() => void> = [() => renameSync(staging, fromDir)];
  try {
    if (relabel.lockOperationId !== undefined) dropMovedCompileLock(staging, relabel.lockOperationId);
    const generatedDir = resolve(staging, 'generated');
    const policyMovedAside = moveCompiledPolicyAside(generatedDir);
    if (policyMovedAside) {
      undo.push(() =>
        renameSync(resolve(generatedDir, REVOKED_POLICY_FILENAME), resolve(generatedDir, COMPILED_POLICY_FILENAME)),
      );
    }
    const definitionPath = resolve(staging, PERSONA_DEFINITION_FILENAME);
    atomicWriteJsonSync(definitionPath, relabel.relabeled);
    undo.push(() => atomicWriteJsonSync(definitionPath, relabel.original));
    if (existsSync(targetDir)) throw personaExistsError(target);
    renameSync(staging, targetDir);
    return policyMovedAside;
  } catch (err) {
    const failures: string[] = [];
    for (const step of undo.reverse()) {
      try {
        step();
      } catch (undoErr) {
        failures.push(errorMessage(undoErr));
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `${errorMessage(err)}; undoing it failed too (${failures.join('; ')}): the persona's files are in ${staging}`,
        { cause: err },
      );
    }
    throw err;
  }
}

/** How many later milliseconds {@link moveToTrash} tries when an entry id is taken. */
const MAX_TRASH_ID_ATTEMPTS = 1000;

/**
 * Moves a persona directory into the trash under the compile lock (refused
 * with COMPILE_IN_PROGRESS while a compile of the persona runs). Returns the
 * trash entry id.
 *
 * Entry ids have millisecond resolution, and the same name can go to the
 * trash twice within one millisecond (a forced restore right after a soft
 * delete): a taken id is never replaced, the next millisecond is tried
 * instead.
 */
function moveToTrash(name: PersonaName): string {
  const lock = acquirePersonaCompileLock(name, randomUUID());
  try {
    const trashDir = getPersonaTrashDir();
    mkdirSync(trashDir, { recursive: true, mode: 0o700 });
    const now = Date.now();
    for (let attempt = 0; attempt < MAX_TRASH_ID_ATTEMPTS; attempt++) {
      const entryId = personaTrashEntryId(name, new Date(now + attempt));
      const entryDir = resolve(trashDir, entryId);
      if (existsSync(entryDir)) continue;
      try {
        renameSync(getPersonaDir(name), entryDir);
      } catch (err) {
        // Taken by a concurrent move meanwhile (rename refuses a non-empty target).
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOTEMPTY' || code === 'EEXIST') continue;
        throw err;
      }
      dropMovedCompileLock(entryDir, lock.operationId);
      return entryId;
    }
    throw new Error(`No free trash entry id for persona "${name}" in ${trashDir}.`);
  } finally {
    lock.release();
  }
}

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

/**
 * Creates the full persona directory tree atomically.
 *
 * Build order:
 *   1. personas/.tmp-<name>-<uuid>/  + generated/ + workspace/
 *   2. Write persona.json (atomicWriteJsonSync)
 *   3. Write constitution.md (atomicWriteTextSync, default '')
 *   4. renameSync tmp → personas/<name>/
 *
 * On any failure the temp dir is removed (no half-persona on disk).
 * Does NOT compile the policy — compilation remains the CLI's responsibility.
 *
 * @param actor caller identity ('cli' | WS connId). Recorded in the audit log.
 * @throws code `PERSONA_EXISTS`, or {@link PERSONA_UNKNOWN_SERVERS} for a
 *   server that is not configured.
 */
export function createPersona(input: CreatePersonaInput, actor: string): PersonaDetailDto {
  const name = createPersonaName(input.name); // throws on bad slug (path-traversal guard)
  const description = input.description.trim();

  if (existsSync(getPersonaDir(name))) {
    throw personaExistsError(name);
  }

  // Server-allowlist normalization: empty/absent → omit key. The CLI performs
  // the full-set-selection → undefined collapse before calling; here we only
  // need to treat [] the same as absent.
  const servers: readonly string[] | undefined = input.servers && input.servers.length > 0 ? input.servers : undefined;
  if (servers) validatePersonaServers(servers);

  const personaDef: PersonaDefinition = {
    name,
    description,
    createdAt: new Date().toISOString(),
    ...(servers ? { servers } : {}),
    ...(input.memoryEnabled === false ? { memory: { enabled: false } } : {}),
  };

  const content = constitutionFileContent(input.constitution ?? '');
  writePersonaTree(name, personaDef, content);

  policyMutationAuditLog.append(actor, 'createPersona', name, {
    constitutionHash: hashConstitutionText(content),
  });

  return getPersonaDetail(name);
}

/**
 * Writes (or overwrites) a persona's constitution.md atomically and returns
 * whether the compiled policy is now stale.
 *
 * Unified write+stale-detect used by ALL edit paths (customizer, editor,
 * generation). Note: the $EDITOR path writes the file in place first, then the
 * CLI reads it back and calls this; the resulting atomic re-write is idempotent
 * and produces byte-identical content.
 *
 * Stale detection: the pipeline computes constitutionHash as
 * sha256(rawConstitutionFileContent) (compile-persona-policy.ts reads the file
 * verbatim, no trim), and getPersonaPolicyState compares that against the file
 * just written. Missing or unparseable policy → stale:true (conservative).
 * Every later read (list, detail, session resolution) recomputes the same
 * state from disk, so the flag does not depend on this return value.
 *
 * The persona must load (a valid persona.json naming this directory), so an
 * edit never lands in a directory whose definition belongs to another persona.
 *
 * @param actor caller identity. Recorded in the audit log.
 */
export function setPersonaConstitution(name: PersonaName, text: string, actor: string): PersonaEditResultDto {
  if (!existsSync(getPersonaDir(name))) {
    throw personaNotFoundError(name);
  }
  loadPersona(name); // throws PERSONA_NOT_FOUND / PERSONA_INVALID

  const constitutionPath = getPersonaConstitutionPath(name);
  const content = constitutionFileContent(text);
  atomicWriteTextSync(constitutionPath, content);

  policyMutationAuditLog.append(actor, 'setPersonaConstitution', name, {
    constitutionHash: hashConstitutionText(content),
  });

  return { stale: getPersonaPolicyState(name).kind !== 'fresh' };
}

/**
 * Toggles persistent memory for a persona.
 *
 * Lifted verbatim from persona-command.ts (the destructure-omit pattern is
 * required under exactOptionalPropertyTypes):
 *   enable  → DROP the memory key entirely (default-on semantics)
 *   disable → memory: { enabled: false }
 *
 * @param actor caller identity. Recorded in the audit log.
 */
export function setPersonaMemory(name: PersonaName, enabled: boolean, actor: string): void {
  const persona = loadPersona(name); // throws 'not found' if missing
  // Verbatim destructure-omit from persona-command.ts.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Destructure to omit the optional property.
  const { memory: _omit, ...rest } = persona;
  const updated: PersonaDefinition = !enabled ? { ...rest, memory: { enabled: false } } : rest;
  atomicWriteJsonSync(getPersonaDefinitionPath(name), updated);
  policyMutationAuditLog.append(actor, 'setPersonaMemory', name, { enabled });
}

/**
 * Changes for {@link setPersonaOverrides}. A field left undefined is kept;
 * `null` removes the persona's value, so the next layer down applies again
 * (the global model, or the caller's and global limits; see
 * src/session/model-budget-precedence.ts).
 */
export interface PersonaOverridesUpdate {
  /** The persona's agent model ("provider:model-name", bare, or a gateway "name:tag" ID). */
  readonly agentModelId?: string | null;
  /** The persona's complete resource limits; they replace the stored ones. */
  readonly resourceBudget?: PersonaResourceBudget | null;
}

/**
 * Sets or removes a persona's agent model and resource limits. The result is
 * validated exactly as sessions validate it (persona-overrides.ts) before
 * anything is written, including a value the update keeps, so the service
 * never stores overrides that would refuse the persona's sessions. An empty
 * budget is stored as no budget.
 *
 * @throws {PersonaOverridesError} for an invalid model or budget.
 * @throws if the persona does not exist.
 * @param actor caller identity. Recorded in the audit log.
 */
export function setPersonaOverrides(
  name: PersonaName,
  update: PersonaOverridesUpdate,
  actor: string,
): PersonaDefinition {
  const persona = loadPersona(name); // throws 'not found' if missing
  const { agentModelId: keptModel, resourceBudget: keptBudget, ...rest } = persona;

  let agentModelId = keptModel;
  if (update.agentModelId === null) {
    agentModelId = undefined;
  } else if (update.agentModelId !== undefined) {
    const parsed = parsePersonaAgentModelId(update.agentModelId);
    if (!parsed.ok) {
      throw new PersonaOverridesError(name, `Invalid agent model for persona "${name}": ${parsed.problem}.`);
    }
    agentModelId = parsed.value;
  }

  let resourceBudget = keptBudget;
  if (update.resourceBudget === null) {
    resourceBudget = undefined;
  } else if (update.resourceBudget !== undefined) {
    const parsed = parsePersonaResourceBudget(update.resourceBudget);
    if (!parsed.ok) {
      throw new PersonaOverridesError(name, `Invalid resource limits for persona "${name}": ${parsed.problem}.`);
    }
    resourceBudget = Object.keys(parsed.value).length > 0 ? parsed.value : undefined;
  }

  const updated: PersonaDefinition = {
    ...rest,
    ...(agentModelId !== undefined ? { agentModelId } : {}),
    ...(resourceBudget !== undefined ? { resourceBudget } : {}),
  };
  // A kept value was never checked here: refuse to rewrite a malformed one.
  readPersonaOverrides(name, updated);
  atomicWriteJsonSync(getPersonaDefinitionPath(name), updated);
  policyMutationAuditLog.append(actor, 'setPersonaOverrides', name, {
    agentModelId: agentModelId ?? null,
    resourceBudget: resourceBudget === undefined ? null : auditedResourceBudget(resourceBudget),
  });
  return updated;
}

/**
 * A persona's resource limits as the policy-mutation log records them: JSON
 * with the fields in a fixed order. The log's details are flat (the chain
 * verifier refuses nested values), so the limits go in as one string.
 */
function auditedResourceBudget(budget: PersonaResourceBudget): string {
  // A validated budget (parsePersonaResourceBudget) holds no undefined fields.
  const fields = Object.entries(budget).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(Object.fromEntries(fields));
}

/** Options for {@link deletePersona}. */
export interface DeletePersonaOptions {
  /**
   * When true, the persona directory is HARD-removed (rmSync recursive+force),
   * permanently revoking the compiled policy. When false/absent (the DEFAULT),
   * the directory is SOFT-deleted: renamed into a trash dir OUTSIDE
   * getPersonasDir() so it is recoverable and is never listed/resolved.
   */
  readonly force?: boolean;
}

/** What {@link deletePersona} did. */
export interface DeletePersonaResult {
  /** Soft delete: the trash entry the persona was moved to. */
  readonly trashEntry?: string;
}

/**
 * Deletes a persona. SOFT by default (recoverable), HARD when `opts.force`.
 *
 * Soft delete renames the persona directory to
 *   {home}/.persona-trash/<name>-<ISO-ts>/
 * which lives OUTSIDE getPersonasDir(), so scanPersonas / resolvePersona (which
 * only look under personas/) never list or resolve a tombstoned persona. It
 * can be restored ({@link restorePersona}) until it is purged, by hand or by
 * the retention sweep ({@link sweepPersonaTrash}, which callers run after a
 * soft delete). Hard delete (`force: true`) permanently removes the directory
 * (the legacy CLI behavior), revoking the compiled policy.
 *
 * Either way the persona's compile lock is held, so a delete is refused
 * (COMPILE_IN_PROGRESS) while the persona is being compiled. persona.json is
 * not read: a persona whose definition is invalid can still be deleted.
 *
 * @param actor caller identity. Recorded in the audit log.
 */
export function deletePersona(name: PersonaName, actor: string, opts: DeletePersonaOptions = {}): DeletePersonaResult {
  const personaDir = getPersonaDir(name);
  if (!existsSync(personaDir)) {
    throw personaNotFoundError(name);
  }

  if (opts.force) {
    const lock = acquirePersonaCompileLock(name, randomUUID());
    try {
      rmSync(personaDir, { recursive: true, force: true });
    } finally {
      lock.release();
    }
    policyMutationAuditLog.append(actor, 'deletePersona', name, { hardDelete: true });
    return {};
  }

  const trashEntry = moveToTrash(name);
  policyMutationAuditLog.append(actor, 'deletePersona', name, { hardDelete: false, trashEntry });
  return { trashEntry };
}

/**
 * Sets the persona's `allowBroadPolicy` opt-in flag (Phase 1c). This is the ONLY
 * way to set the flag — it is NEVER inferred from the constitution text. When
 * true, the broad-policy validator permits the persona to compile a policy with
 * `allow` rules that have broad wildcard domains/lists (`'*'`, `'*.com'`,
 * `'*.github.io'`), out-of-workspace `paths.within` or unconstrained resource
 * arguments (see broad-policy-validator.ts).
 *
 * Opting out also revokes what the opt-in allowed: the persona's CURRENT
 * compiled policy is checked (with its resolved dynamic lists and the tool
 * annotations in effect, see policy-breadth-check.ts) and, when it grants
 * broad access or cannot be checked, moved aside to
 * {@link REVOKED_POLICY_FILENAME}. The persona then has no compiled policy:
 * `resolvePersona` refuses it (POLICY_MISSING) until a recompile under the
 * narrower opt-in succeeds, and the detail reports `hasPolicy: false`.
 * Sessions that already loaded the policy keep it until they end, and an
 * in-flight workflow fails at its next `cyclePolicy` that loads this persona
 * (a shared-container bundle already running it keeps the loaded policy until
 * it switches persona). The WS dispatch emits `personas.changed` after this
 * returns.
 *
 * The opt-out holds the persona's compile lock (shared with CLI and web-UI
 * compiles), so no compile validated under the old opt-in can write after
 * the check.
 *
 * @param actor caller identity. Recorded in the audit log.
 * @throws {PersonaCompileError} `COMPILE_IN_PROGRESS` when opting out while a
 *   compile of the persona is running; nothing is changed then.
 */
export function setPersonaBroadPolicyOptIn(name: PersonaName, enabled: boolean, actor: string): PersonaDetailDto {
  const persona = loadPersona(name); // throws 'not found' if missing
  // Drop the key when disabling (default-off semantics, exactOptionalPropertyTypes).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Destructure to omit the optional property.
  const { allowBroadPolicy: _omit, ...rest } = persona;
  if (enabled) {
    atomicWriteJsonSync(getPersonaDefinitionPath(name), { ...rest, allowBroadPolicy: true });
    policyMutationAuditLog.append(actor, 'setPersonaBroadPolicyOptIn', name, { enabled, broadened: true });
    return getPersonaDetail(name);
  }

  const lock = acquirePersonaCompileLock(name, randomUUID());
  try {
    atomicWriteJsonSync(getPersonaDefinitionPath(name), rest);
    // The opt-out is in effect from here on, so it is audited even if moving
    // the policy aside fails (resolvePersona still refuses a broad one).
    let policyRevoked = false;
    try {
      policyRevoked = revokeBroadCompiledPolicy(name);
    } finally {
      policyMutationAuditLog.append(actor, 'setPersonaBroadPolicyOptIn', name, {
        enabled,
        broadened: false,
        ...(policyRevoked ? { policyRevoked } : {}),
      });
    }
  } finally {
    lock.release();
  }
  return getPersonaDetail(name);
}

/**
 * Moves the persona's compiled policy aside when it grants broad access, or
 * when that cannot be determined (fail closed: a policy that cannot be read
 * would be refused at load anyway). Returns whether it was moved.
 */
function revokeBroadCompiledPolicy(name: PersonaName): boolean {
  const generatedDir = getPersonaGeneratedDir(name);
  if (!existsSync(resolve(generatedDir, COMPILED_POLICY_FILENAME))) return false;
  let broad: boolean;
  try {
    broad = hasBroadAccess(inspectCompiledPolicyBreadth(generatedDir, getPersonaWorkspaceDir(name)));
  } catch {
    broad = true;
  }
  if (!broad) return false;
  return moveCompiledPolicyAside(generatedDir);
}

// ---------------------------------------------------------------------------
// Clone and rename
// ---------------------------------------------------------------------------

/** Options for {@link clonePersona}. */
export interface ClonePersonaOptions {
  /** The new persona's description (trimmed); absent = the source's. */
  readonly description?: string;
}

/**
 * Creates persona `target` as an independent copy of `source`'s
 * configuration: its constitution.md (verbatim), description, server
 * allowlist, memory setting, agent model and resource limits
 * (`agentModelId`, `resourceBudget`) and skills/ directory. Built atomically
 * like {@link createPersona}. The model and limits are copied as sessions
 * validate them (`readPersonaOverrides`): a malformed one refuses the clone
 * instead of being copied, and none is dropped (the clone would otherwise
 * run without a cost cap the source has).
 *
 * Not copied:
 *  - the compiled policy (generated/): it was compiled for the source's
 *    workspace path, so the clone is compiled anew;
 *  - the workspace and memory.db: the clone starts with an empty workspace
 *    and no memories (and its memory namespace is its own name);
 *  - the broad-policy opt-in: it is set only through the gated opt-in flow
 *    (`setPersonaBroadPolicyOptIn`), never inherited.
 *
 * @param actor caller identity. Recorded in the audit log.
 * @throws code `PERSONA_EXISTS` when `target` exists, `PERSONA_NOT_FOUND` /
 *   `PERSONA_INVALID` when `source` cannot be loaded, and a
 *   {@link PersonaOverridesError} (`PERSONA_OVERRIDES_INVALID`) when its
 *   agent model or resource limits are malformed.
 */
export function clonePersona(
  source: PersonaName,
  target: string,
  actor: string,
  opts: ClonePersonaOptions = {},
): PersonaDetailDto {
  const targetName = createPersonaName(target); // throws on bad slug (path-traversal guard)
  const persona = loadPersona(source);
  if (targetName === source || existsSync(getPersonaDir(targetName))) {
    throw personaExistsError(targetName);
  }
  const { agentModelId, resourceBudget: budget } = readPersonaOverrides(source, persona);
  // An empty budget is no budget, as setPersonaOverrides stores it.
  const resourceBudget = budget !== undefined && Object.keys(budget).length > 0 ? { ...budget } : undefined;

  const constitution = readTextIfPresent(getPersonaConstitutionPath(source));
  const definition: PersonaDefinition = {
    name: targetName,
    description: opts.description !== undefined ? opts.description.trim() : persona.description,
    createdAt: new Date().toISOString(),
    ...(persona.servers ? { servers: [...persona.servers] } : {}),
    ...(persona.memory ? { memory: { enabled: persona.memory.enabled } } : {}),
    ...(agentModelId !== undefined ? { agentModelId } : {}),
    ...(resourceBudget !== undefined ? { resourceBudget } : {}),
  };
  const sourceSkills = getPersonaSkillsDir(source);
  writePersonaTree(targetName, definition, constitution, (tmpDir) => {
    // verbatimSymlinks: a relative link stays relative, so it resolves inside
    // the clone. By default cp rewrites it to an absolute path into the
    // source persona, and the clone's skills would keep reading (and
    // following edits to) the source's files.
    if (existsSync(sourceSkills)) {
      cpSync(sourceSkills, resolve(tmpDir, 'skills'), { recursive: true, verbatimSymlinks: true });
    }
  });

  policyMutationAuditLog.append(actor, 'clonePersona', targetName, {
    source,
    constitutionHash: hashConstitutionText(constitution),
    // The model and limits the clone runs with, recorded as setPersonaOverrides records them.
    ...(agentModelId !== undefined ? { agentModelId } : {}),
    ...(resourceBudget !== undefined ? { resourceBudget: auditedResourceBudget(resourceBudget) } : {}),
  });
  return getPersonaDetail(targetName);
}

/** What {@link renamePersona} did. */
export interface RenamePersonaResult {
  readonly detail: PersonaDetailDto;
  /** The compiled policy was moved aside: the persona must be recompiled. */
  readonly policyMovedAside: boolean;
}

/**
 * Renames persona `name` to `newName`: its directory (constitution,
 * workspace, memory.db, skills) moves to `personas/<newName>/` and
 * persona.json is rewritten for the new name. The compiled policy is moved
 * aside ({@link REVOKED_POLICY_FILENAME}): it was compiled for the old
 * workspace path, so the persona must be recompiled. The memory namespace is
 * kept, so the persona still sees the memories it stored under its old name.
 *
 * Holds the persona's compile lock (refused with COMPILE_IN_PROGRESS while a
 * compile runs). Whatever refers to the persona by its old name (cron jobs,
 * workflow definitions, sessions started before the rename) does not follow
 * it.
 *
 * @param actor caller identity. Recorded in the audit log.
 * @throws code `PERSONA_EXISTS` when `newName` exists, `PERSONA_NOT_FOUND` /
 *   `PERSONA_INVALID` when `name` cannot be loaded.
 */
export function renamePersona(name: PersonaName, newName: string, actor: string): RenamePersonaResult {
  const target = createPersonaName(newName); // throws on bad slug (path-traversal guard)
  loadPersona(name); // a clear PERSONA_NOT_FOUND / PERSONA_INVALID before taking the lock
  if (target === name || existsSync(getPersonaDir(target))) {
    throw personaExistsError(target);
  }

  const lock = acquirePersonaCompileLock(name, randomUUID());
  let policyMovedAside: boolean;
  try {
    // Read again under the lock, so the relabeled definition carries any
    // change made to persona.json before the lock was taken.
    const persona = loadPersona(name);
    policyMovedAside = relocatePersonaDir(getPersonaDir(name), target, {
      original: persona,
      relabeled: relabeledDefinition(persona, target),
      lockOperationId: lock.operationId,
    });
  } finally {
    lock.release();
  }

  policyMutationAuditLog.append(actor, 'renamePersona', target, {
    previousName: name,
    ...(policyMovedAside ? { policyRevoked: true } : {}),
  });
  return { detail: getPersonaDetail(target), policyMovedAside };
}

// ---------------------------------------------------------------------------
// Trash: list, restore, purge, retention
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The configured trash retention in days (`personas.trashRetentionDays`);
 * null keeps entries until they are purged by hand.
 *
 * @throws when the user configuration cannot be read.
 */
export function getPersonaTrashRetentionDays(): number | null {
  const personas = loadUserConfig({ readOnly: true }).personas;
  return personas ? personas.trashRetentionDays : PERSONAS_CONFIG_DEFAULTS.trashRetentionDays;
}

function expiresAt(entry: PersonaTrashEntry, retentionDays: number): Date {
  return new Date(entry.deletedAt.getTime() + retentionDays * DAY_MS);
}

/**
 * Lists the persona trash, newest first, with each entry's expiry under the
 * configured retention (absent when entries are kept until purged by hand,
 * or the configuration cannot be read).
 */
export function listPersonaTrashEntries(): PersonaTrashEntryDto[] {
  let retentionDays: number | null;
  try {
    retentionDays = getPersonaTrashRetentionDays();
  } catch {
    retentionDays = null;
  }
  return listPersonaTrash().map((entry) => ({
    id: entry.id,
    name: entry.name,
    deletedAt: entry.deletedAt.toISOString(),
    ...(entry.description !== undefined ? { description: entry.description } : {}),
    ...(entry.problem !== undefined ? { problem: entry.problem } : {}),
    ...(retentionDays !== null ? { expiresAt: expiresAt(entry, retentionDays).toISOString() } : {}),
  }));
}

/** Options for {@link restorePersona}. */
export interface RestorePersonaOptions {
  /** Restore under this name instead of the one the persona was deleted as. */
  readonly as?: string;
  /**
   * When a persona with the target name exists, move it to the trash first
   * (recoverable) instead of refusing.
   */
  readonly force?: boolean;
}

/** What {@link restorePersona} did. */
export interface RestorePersonaResult {
  readonly detail: PersonaDetailDto;
  /** The trash entry restored. */
  readonly restored: string;
  /** With `force`: the trash entry the persona it replaced was moved to. */
  readonly replaced?: string;
  /** Restored under another name: the compiled policy was moved aside (recompile it). */
  readonly policyMovedAside: boolean;
}

/**
 * Restores a soft-deleted persona from the trash. `ref` is an entry id, or a
 * persona name (its most recently deleted entry).
 *
 * The entry's persona.json is validated first and must name the persona the
 * entry was deleted as. A persona with the target name (the original name,
 * or `opts.as`) is never overwritten: the restore is refused with
 * PERSONA_EXISTS unless `opts.force`, which first moves that persona to the
 * trash (under its compile lock; recoverable, and put back if the restore
 * then fails). Restoring under another name re-labels the persona as a
 * rename does (its compiled policy is moved aside, its memory namespace
 * kept).
 *
 * @param actor caller identity. Recorded in the audit log (and a delete
 *   record for a persona `force` replaced).
 * @throws code `PERSONA_NOT_FOUND` when `ref` selects no entry,
 *   `PERSONA_INVALID` when its persona.json cannot be used, `PERSONA_EXISTS`
 *   on a name collision without `force`.
 */
export function restorePersona(ref: string, actor: string, opts: RestorePersonaOptions = {}): RestorePersonaResult {
  const entry = selectPersonaTrashEntries(ref, listPersonaTrash()).at(0);
  if (!entry) throw trashEntryNotFoundError(ref);
  const target = opts.as !== undefined ? createPersonaName(opts.as) : entry.name;
  // Re-validated now (the entry may have been edited in the trash): it must
  // be a valid definition naming the persona the entry was deleted as.
  const persona = readPersonaDefinition(resolve(entry.path, PERSONA_DEFINITION_FILENAME), entry.name);

  let replaced: string | undefined;
  if (existsSync(getPersonaDir(target))) {
    if (opts.force !== true) {
      throw personaExistsError(
        target,
        ' Restoring over it needs force (the existing persona is moved to the trash first), ' +
          'or restore under another name.',
      );
    }
    replaced = moveToTrash(target);
    policyMutationAuditLog.append(actor, 'deletePersona', target, { hardDelete: false, trashEntry: replaced });
  }

  let policyMovedAside: boolean;
  try {
    policyMovedAside = relocatePersonaDir(
      entry.path,
      target,
      target === entry.name ? undefined : { original: persona, relabeled: relabeledDefinition(persona, target) },
    );
  } catch (err) {
    const stranded = replaced !== undefined ? putBackReplaced(replaced, target, actor) : undefined;
    if (stranded !== undefined) throw new Error(`${errorMessage(err)}; ${stranded}`, { cause: err });
    throw err;
  }

  policyMutationAuditLog.append(actor, 'restorePersona', target, {
    trashEntry: entry.id,
    ...(target !== entry.name ? { previousName: entry.name } : {}),
    ...(replaced !== undefined ? { replacedTrashEntry: replaced } : {}),
    ...(policyMovedAside ? { policyRevoked: true } : {}),
  });
  return {
    detail: getPersonaDetail(target),
    restored: entry.id,
    ...(replaced !== undefined ? { replaced } : {}),
    policyMovedAside,
  };
}

/**
 * A forced restore failed after moving the persona it would replace to the
 * trash: put that persona back (audited as a restore of its entry). Returns
 * undefined when it is back, or, when even that fails, a note that it stays
 * in the trash (restorable) for the caller's error.
 */
function putBackReplaced(entryId: string, name: PersonaName, actor: string): string | undefined {
  try {
    relocatePersonaDir(resolve(getPersonaTrashDir(), entryId), name);
  } catch (err) {
    return `persona "${name}" stays in the trash as ${entryId} (${errorMessage(err)})`;
  }
  policyMutationAuditLog.append(actor, 'restorePersona', name, { trashEntry: entryId });
  return undefined;
}

/** Which trash entries {@link purgePersonaTrash} removes. */
export type PersonaTrashPurgeSelection =
  /** Each ref is an entry id, or a persona name (every entry of that persona). */
  | { readonly kind: 'entries'; readonly refs: readonly string[] }
  /**
   * Entries older than the retention: `retentionDays` when given (null =
   * none), else the configured `personas.trashRetentionDays`.
   */
  | { readonly kind: 'expired'; readonly retentionDays?: number | null; readonly now?: Date }
  | { readonly kind: 'all' };

/**
 * The trash entries a selection names, newest first, without removing
 * anything (the CLI shows them before asking for confirmation).
 *
 * @throws code `PERSONA_NOT_FOUND` when a ref selects no entry, or the
 *   configuration error when an `expired` selection without `retentionDays`
 *   cannot read the retention setting.
 */
export function selectPersonaTrashForPurge(selection: PersonaTrashPurgeSelection): PersonaTrashEntry[] {
  const entries = listPersonaTrash();
  switch (selection.kind) {
    case 'all':
      return entries;
    case 'entries': {
      const selected = new Map<string, PersonaTrashEntry>();
      for (const ref of selection.refs) {
        const matches = selectPersonaTrashEntries(ref, entries);
        if (matches.length === 0) throw trashEntryNotFoundError(ref);
        for (const match of matches) selected.set(match.id, match);
      }
      return [...selected.values()];
    }
    case 'expired': {
      const retentionDays =
        selection.retentionDays !== undefined ? selection.retentionDays : getPersonaTrashRetentionDays();
      if (retentionDays === null) return [];
      const now = (selection.now ?? new Date()).getTime();
      return entries.filter((entry) => expiresAt(entry, retentionDays).getTime() <= now);
    }
  }
}

/** Options for {@link purgePersonaTrash}. */
export interface PurgePersonaTrashOptions {
  /**
   * Remove only these entry ids among the selected ones: the entries a user
   * was shown and confirmed, so an entry that joined the selection after
   * the confirmation (a newer delete, an entry that just expired) is kept.
   */
  readonly only?: readonly string[];
}

/**
 * Purge remnants a purge in this process has taken on (it is deleting them,
 * or about to). A purge that starts while another one in the daemon is still
 * deleting leaves those to it.
 */
const claimedRemnants = new Set<string>();

/** Deletes a claimed purge remnant's files (asynchronously), then releases the claim. */
async function deleteClaimedRemnant(remnant: string): Promise<void> {
  try {
    await rm(remnant, { recursive: true, force: true });
  } finally {
    claimedRemnants.delete(remnant);
  }
}

/**
 * Permanently removes trash entries, workspace and memory.db included.
 *
 * Every selected entry first leaves the trash in one synchronous pass: it is
 * renamed to a purge remnant (`PURGE_REMNANT_PREFIX`, persona-trash.ts),
 * which nothing lists or restores, and gets its audit record. Only then are
 * the files deleted, asynchronously (`fs.promises.rm`), so a large workspace
 * does not block the daemon's event loop. A restore running meanwhile (the
 * daemon serves other requests while it deletes, and the CLI is another
 * process) therefore finds either the whole entry or none of it, never a
 * half-deleted one, and an entry the restore took first is reported in
 * `failed`, not as purged. Files that cannot be deleted (or a purge cut
 * short by the process ending) stay in the remnant, out of the trash, and
 * the next purge deletes them; such an entry is reported in `failed` with
 * the remnant's path.
 *
 * @param actor caller identity. Recorded in the audit log.
 * @throws code `PERSONA_NOT_FOUND` when a ref selects no entry (before
 *   anything is removed), or the configuration error when the retention
 *   setting cannot be read for an `expired` selection without
 *   `retentionDays`.
 */
export async function purgePersonaTrash(
  selection: PersonaTrashPurgeSelection,
  actor: string,
  opts: PurgePersonaTrashOptions = {},
): Promise<PersonaTrashPurgeResultDto> {
  const only = opts.only !== undefined ? new Set(opts.only) : undefined;
  const selected = selectPersonaTrashForPurge(selection).filter((entry) => only === undefined || only.has(entry.id));
  // What earlier purges left (failed deletes, interrupted processes), other
  // than what a purge in this process has already taken on.
  const leftovers = listPurgeRemnants().filter((remnant) => !claimedRemnants.has(remnant));
  for (const remnant of leftovers) claimedRemnants.add(remnant);

  const failed: Array<{ id: string; reason: string }> = [];
  const removing: Array<{ readonly id: string; readonly remnant: string }> = [];
  for (const entry of selected) {
    const remnant = purgeRemnantPath(entry.id);
    try {
      // Only a real directory in the trash: never follow a link elsewhere.
      if (!lstatSync(entry.path).isDirectory()) throw new Error('not a directory');
      renameSync(entry.path, remnant);
    } catch (err) {
      failed.push({ id: entry.id, reason: errorMessage(err) });
      continue;
    }
    claimedRemnants.add(remnant);
    removing.push({ id: entry.id, remnant });
    // The entry is out of the trash for good: recorded now, before its files go.
    policyMutationAuditLog.append(actor, 'purgePersonaTrash', entry.name, {
      trashEntry: entry.id,
      ...(selection.kind === 'expired' ? { expired: true } : {}),
    });
  }

  const purged: string[] = [];
  for (const { id, remnant } of removing) {
    try {
      await deleteClaimedRemnant(remnant);
      purged.push(id);
    } catch (err) {
      failed.push({
        id,
        reason:
          `${errorMessage(err)}. The entry is no longer in the trash; the files that could not be deleted ` +
          `are in ${remnant}, and the next purge deletes them`,
      });
    }
  }
  for (const remnant of leftovers) {
    try {
      await deleteClaimedRemnant(remnant);
    } catch {
      // Still there: the next purge tries again.
    }
  }
  return { purged, failed };
}

/**
 * The retention sweep: purges the trash entries older than the configured
 * `personas.trashRetentionDays` (and, like every purge, what earlier purges
 * could not delete). Callers run it after moving a persona to the trash (a
 * soft delete, a forced restore), so the trash only ever holds entries
 * within the retention window. Housekeeping never fails the operation that
 * triggered it: problems (an unreadable configuration, an entry that cannot
 * be removed) leave the entries for the next sweep, and the result reports
 * what was removed.
 */
export async function sweepPersonaTrash(actor: string): Promise<PersonaTrashPurgeResultDto> {
  try {
    return await purgePersonaTrash({ kind: 'expired' }, actor);
  } catch {
    return { purged: [], failed: [] };
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Returns full detail for a persona, including constitution text, whether
 * the compiled policy exists and whether it is stale. Lifted from
 * persona-dispatch.ts and extended with the `memory` flag
 * (persona.memory?.enabled ?? true), the `allowBroadPolicy` flag
 * (persona.allowBroadPolicy ?? false, Phase 1c) and `stale` (recomputed from
 * disk on every call).
 *
 * @throws if the persona does not exist or its persona.json is invalid.
 */
export function getPersonaDetail(name: PersonaName): PersonaDetailDto {
  const persona = loadPersona(name); // throws if missing or invalid

  let constitution = '';
  const constitutionPath = getPersonaConstitutionPath(name);
  try {
    constitution = readFileSync(constitutionPath, 'utf-8');
  } catch {
    // No constitution yet — return empty.
  }

  const policyPath = resolve(getPersonaGeneratedDir(name), COMPILED_POLICY_FILENAME);
  const policyState = getPersonaPolicyState(name);
  const hasPolicy = policyState.kind !== 'missing';

  let policyRuleCount: number | undefined;
  if (hasPolicy) {
    try {
      const compiled = JSON.parse(readFileSync(policyPath, 'utf-8')) as CompiledPolicyFile;
      policyRuleCount = compiled.rules.length;
    } catch {
      // Ignore parse errors.
    }
  }

  return {
    // The directory name: loadPersona guarantees persona.json agrees with it.
    name,
    description: persona.description,
    createdAt: persona.createdAt,
    constitution,
    servers: persona.servers,
    hasPolicy,
    policyRuleCount,
    ...(policyState.kind === 'stale' ? { stale: policyState.reason } : {}),
    memory: persona.memory?.enabled ?? true,
    allowBroadPolicy: persona.allowBroadPolicy ?? false,
  };
}

/**
 * Lists all personas. Delegates to scanPersonas() (alphabetically sorted).
 * Both the CLI and the WS dispatch call this to prevent drift. `stale` is
 * present only for a compiled policy that no longer matches its constitution.
 * Directories that cannot be loaded are left out (see
 * {@link listInvalidPersonas}).
 */
export function listPersonas(): PersonaListDto[] {
  return scanPersonas().map((p) => ({
    name: p.name,
    description: p.description,
    compiled: p.compiled,
    ...(p.stale ? { stale: p.stale } : {}),
  }));
}

/**
 * Directories under `personas/` with a persona name that cannot be loaded
 * (missing or invalid persona.json, such as a hand-copied persona directory
 * whose persona.json names the original), with the reason.
 */
export function listInvalidPersonas(): InvalidPersonaDir[] {
  return scanPersonaDirs().invalid;
}
