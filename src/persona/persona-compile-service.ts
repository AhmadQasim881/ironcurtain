/**
 * src/persona/persona-compile-service.ts
 *
 * The ONE path every persona compile takes. The CLI (`ironcurtain persona
 * compile|create|edit`, persona-command.ts) and the daemon's web UI
 * (`personas.compileStream`, via persona-compile-orchestrator.ts) both call
 * {@link runPersonaCompile}, which:
 *
 *  - holds the persona's cross-process compile lock
 *    (`generated/.compile.lock`), so a CLI compile and a daemon compile of
 *    the same persona never run at once (and never pair one run's
 *    compiled-policy.json with the other's dynamic-lists.json);
 *  - passes the broad-policy validator as the pipeline's `validateCompiled`
 *    hook, judged against the persona's opt-in AS IT IS when the result is
 *    validated (an opt-out that lands during a compile is honoured);
 *  - arms the wall-clock cap (the lock's staleness bound);
 *  - appends one policy-mutation audit record per compile, whether it wrote a
 *    policy, was rejected as too broad, or failed.
 *
 * It is the ONLY runtime invocation site of `compilePersonaPolicy`, reached
 * EXCLUSIVELY via `await import('./compile-persona-policy.js')`
 * (test/persona-compile-paths.test.ts). It carries only type-only pipeline
 * imports; the value edge stays behind the dynamic import + the sanctioned seam
 * (ESLint no-restricted-imports + test/pipeline-import-boundary.test.ts).
 *
 * The lock is also taken by a broad-policy opt-out (persona-service.ts), which
 * may move compiled-policy.json aside: no compile validated under the old
 * opt-in can then write after the opt-out's check.
 *
 * @see docs/designs/web-ui-policy-persona-management.md §4.3, §6, §7
 */

import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { getPersonaGeneratedDir, getPersonaWorkspaceDir, loadPersona } from './resolve.js';
import type { PersonaName } from './types.js';
import {
  BroadPolicyRejectedError,
  findBroadPolicy,
  hasBroadAccess,
  makeBroadPolicyValidator,
  type BroadPolicyContext,
  type BroadPolicyFindings,
} from './broad-policy-validator.js';
import { computeRuleDelta } from './rule-delta.js';
import { policyMutationAuditLog } from './policy-mutation-audit.js';
import { COMPILED_POLICY_FILENAME } from '../config/constitution-hash.js';
import { toDisplayText } from '../terminal/display-sanitize.js';
import { parseCompiledPolicyFile } from '../types/policy-schema.js';
import type { ErrorCode, FailedServerDto, RuleDeltaDto } from '../web-ui/web-ui-types.js';
// Type-only pipeline imports — no runtime edge. The VALUE edge to the pipeline
// lives only behind `await import('./compile-persona-policy.js')` below.
import type { ServerProgressReporter } from '../pipeline/pipeline-shared.js';
import type { CompilePersonaOptions } from './compile-persona-policy.js';
import type { CompiledPolicyFile, CompiledPolicyValidator, DynamicListsFile } from '../pipeline/types.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * An error carrying a typed {@link ErrorCode} (and optional structured data)
 * so callers can react without parsing messages: the WS dispatch maps it to a
 * `ResponseFrame` error, the CLI prints it. The orchestrator re-exports it as
 * `CompileOrchestratorError`.
 */
export class PersonaCompileError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'PersonaCompileError';
  }
}

// ---------------------------------------------------------------------------
// Cross-process compile lock
// ---------------------------------------------------------------------------

/** The lock file, inside the persona's generated dir. */
export const PERSONA_COMPILE_LOCK_FILE = '.compile.lock';

/**
 * Wall-clock cap (ms): a compile is aborted after this long, so a lock older
 * than this belongs to no running compile and is reclaimed.
 */
export const DEFAULT_COMPILE_WALL_CLOCK_CAP_MS = 20 * 60 * 1000;

/** The JSON a lock file holds. */
export interface PersonaCompileLockContent {
  readonly operationId: string;
  readonly startedAt: string;
  readonly pid: number;
}

/** A held compile lock. Whoever acquired it releases it. */
export interface PersonaCompileLock {
  readonly name: PersonaName;
  readonly operationId: string;
  /**
   * Re-stamps `startedAt` with the current time, so the lock's age and the
   * wall-clock cap measure the same run (a compile queued behind the daemon's
   * global gate calls this when it starts). Throws `COMPILE_IN_PROGRESS` when
   * the lock is no longer this holder's.
   */
  refresh(): void;
  /** Removes the lock file if it is still this holder's. Idempotent. */
  release(): void;
}

/** The persona's lock file: `{home}/personas/{name}/generated/.compile.lock`. */
export function getPersonaCompileLockPath(name: PersonaName): string {
  return resolve(getPersonaGeneratedDir(name), PERSONA_COMPILE_LOCK_FILE);
}

function inProgressError(name: PersonaName, holder: PersonaCompileLockContent | null): PersonaCompileError {
  return new PersonaCompileError(
    'COMPILE_IN_PROGRESS',
    `A compile for persona "${name}" is already running.`,
    holder ? { operationId: holder.operationId } : undefined,
  );
}

/**
 * Takes the persona's compile lock for `operationId`, reclaiming a stale one
 * (dead pid, older than `staleAfterMs`, or unparseable).
 *
 * The lock content is written to a private temp file first and published with
 * a hard link (`link` fails with EEXIST when the lock exists), so a contender
 * never sees a lock file that exists but is still empty and mistakes it for a
 * corrupt, reclaimable one.
 *
 * @throws {PersonaCompileError} `COMPILE_IN_PROGRESS` (with the holder's
 *   `operationId` in `data`) when a live compile, or opt-out, holds it.
 */
export function acquirePersonaCompileLock(
  name: PersonaName,
  operationId: string,
  opts: { readonly staleAfterMs?: number } = {},
): PersonaCompileLock {
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_COMPILE_WALL_CLOCK_CAP_MS;
  const lockPath = getPersonaCompileLockPath(name);
  ensureGeneratedDir(name);

  const content = (): PersonaCompileLockContent => ({
    operationId,
    startedAt: new Date().toISOString(),
    pid: process.pid,
  });

  if (!tryPublishLock(lockPath, content())) {
    const existing = readLockAt(lockPath);
    if (existing && !isPersonaCompileLockStale(existing, staleAfterMs)) throw inProgressError(name, existing);
    reclaimLockAt(lockPath, existing);
    if (!tryPublishLock(lockPath, content())) throw inProgressError(name, readLockAt(lockPath));
  }

  let released = false;
  return {
    name,
    operationId,
    refresh(): void {
      const current = readLockAt(lockPath);
      if (released || current?.operationId !== operationId) throw inProgressError(name, current);
      // Replace in place (temp + rename): the path never goes missing, so no
      // contender can take the lock in between.
      const tmp = uniqueSibling(lockPath, 'refresh');
      writeFileSync(tmp, JSON.stringify(content()), { flag: 'wx', mode: 0o600 });
      renameSync(tmp, lockPath);
    },
    release(): void {
      if (released) return;
      released = true;
      const current = readLockAt(lockPath);
      // Reclaimed (only possible past the cap) and re-taken: not ours to remove.
      if (current && current.operationId !== operationId) return;
      unlinkIfExists(lockPath);
    },
  };
}

/** Reads a persona's lock file, or null when it is absent or unparseable. */
export function readPersonaCompileLock(name: PersonaName): PersonaCompileLockContent | null {
  return readLockAt(getPersonaCompileLockPath(name));
}

/** A lock is stale when its pid is dead or it is older than `staleAfterMs`. */
export function isPersonaCompileLockStale(content: PersonaCompileLockContent, staleAfterMs: number): boolean {
  if (!isPidAlive(content.pid)) return true;
  const started = Date.parse(content.startedAt);
  if (Number.isNaN(started)) return true;
  return Date.now() - started > staleAfterMs;
}

/**
 * Removes a lock the caller judged stale from `observed` (null: unparseable).
 * The lock is first moved to a private name and only deleted when what was
 * moved is still the observed lock; a racer's fresh lock moved by mistake is
 * put back.
 */
export function reclaimStalePersonaCompileLock(name: PersonaName, observed: PersonaCompileLockContent | null): void {
  reclaimLockAt(getPersonaCompileLockPath(name), observed);
}

function ensureGeneratedDir(name: PersonaName): void {
  // Not recursive: the persona dir itself must already exist, so a lock
  // attempt never creates a persona skeleton.
  try {
    mkdirSync(getPersonaGeneratedDir(name), { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
}

function uniqueSibling(path: string, tag: string): string {
  return `${path}.${tag}.${process.pid}.${randomUUID()}`;
}

/** Publishes `content` at `lockPath` atomically. False when a lock already exists there. */
function tryPublishLock(lockPath: string, content: PersonaCompileLockContent): boolean {
  const tmp = uniqueSibling(lockPath, 'new');
  writeFileSync(tmp, JSON.stringify(content), { flag: 'wx', mode: 0o600 });
  try {
    linkSync(tmp, lockPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  } finally {
    unlinkIfExists(tmp);
  }
}

function reclaimLockAt(lockPath: string, observed: PersonaCompileLockContent | null): void {
  const captured = uniqueSibling(lockPath, 'reclaim');
  try {
    renameSync(lockPath, captured);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // already gone
    throw err;
  }
  const moved = readLockAt(captured);
  if (!sameLock(moved, observed)) {
    // A racer published a fresh lock between our read and the move: restore
    // it (link fails if yet another lock took the path meanwhile).
    try {
      linkSync(captured, lockPath);
    } catch {
      // The path is taken again; the newest lock stands.
    }
  }
  unlinkIfExists(captured);
}

function sameLock(a: PersonaCompileLockContent | null, b: PersonaCompileLockContent | null): boolean {
  if (a === null || b === null) return a === b;
  return a.operationId === b.operationId && a.pid === b.pid && a.startedAt === b.startedAt;
}

function readLockAt(lockPath: string): PersonaCompileLockContent | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf-8')) as Partial<PersonaCompileLockContent>;
    if (
      typeof parsed.operationId === 'string' &&
      typeof parsed.pid === 'number' &&
      typeof parsed.startedAt === 'string'
    ) {
      return { operationId: parsed.operationId, pid: parsed.pid, startedAt: parsed.startedAt };
    }
    return null;
  } catch {
    return null;
  }
}

function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/** True iff a process with `pid` exists (signal 0 probe). */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH => no such process. EPERM => exists but not ours (still alive).
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// ---------------------------------------------------------------------------
// The compile
// ---------------------------------------------------------------------------

/** The compile implementation; tests inject a fake (no pipeline / LLM). */
export type PersonaCompileImpl = (name: PersonaName, opts: CompilePersonaOptions) => Promise<CompiledPolicyFile>;

export interface RunPersonaCompileOptions {
  /**
   * Whether dynamic-list resolution may connect to live MCP servers. The CLI
   * (local, trusted user) passes true; the WS path passes false, so an
   * MCP-backed list fails with LIST_REQUIRES_MCP.
   */
  readonly allowMcpLists: boolean;
  /**
   * A lock the caller already holds for this persona (the orchestrator takes
   * it synchronously, so a duplicate is refused before it queues). The caller
   * releases it. Absent: the lock is acquired and released here.
   */
  readonly lock?: PersonaCompileLock;
  /** Operation id for the lock, the audit record and the per-op LLM log. Minted when absent. */
  readonly operationId?: string;
  /** Per-server progress reporters (the web UI's event-bus reporter); absent: console output. */
  readonly reporterFactory?: (serverName: string) => ServerProgressReporter;
  /** Suppress the pipeline's narrative stderr; requires `reporterFactory`. */
  readonly quiet?: boolean;
  /** Wall-clock cap and lock staleness bound. Defaults to {@link DEFAULT_COMPILE_WALL_CLOCK_CAP_MS}. */
  readonly wallClockCapMs?: number;
  /** Test seam; defaults to the dynamic-import seam to compile-persona-policy.ts. */
  readonly compileImpl?: PersonaCompileImpl;
}

/** A compile that wrote a policy. */
export interface PersonaCompileOutcome {
  readonly operationId: string;
  readonly policy: CompiledPolicyFile;
  /** Change against the previous compiled policy; absent on a first compile. */
  readonly ruleDelta?: RuleDeltaDto;
  /**
   * Breadth of the written policy, judged with the lists and tool annotations
   * the compile used. Broad access here means the persona was opted in.
   */
  readonly findings: BroadPolicyFindings;
}

/**
 * Compiles a persona's constitution into its policy under the compile lock,
 * the broad-policy validator, the wall-clock cap and the audit log (see the
 * module header). `actor` is recorded in the audit log ('cli', or the WS
 * `remoteAddr#connId`).
 *
 * @throws {PersonaCompileError} `COMPILE_IN_PROGRESS` when another compile
 *   (or an opt-out) holds the lock; nothing is compiled or audited then.
 * @throws {BroadPolicyRejectedError} when the result needs the broad-policy
 *   opt-in the persona does not have; nothing is written.
 * @throws whatever the compile threw; nothing is written.
 */
export async function runPersonaCompile(
  name: PersonaName,
  actor: string,
  opts: RunPersonaCompileOptions,
): Promise<PersonaCompileOutcome> {
  if (opts.lock && opts.lock.name !== name) {
    throw new Error(`The compile lock passed for persona "${name}" belongs to persona "${opts.lock.name}".`);
  }
  loadPersona(name); // a clear "not found" before any lock or compile
  const capMs = opts.wallClockCapMs ?? DEFAULT_COMPILE_WALL_CLOCK_CAP_MS;
  const operationId = opts.lock?.operationId ?? opts.operationId ?? randomUUID();
  const ownedLock =
    opts.lock === undefined ? acquirePersonaCompileLock(name, operationId, { staleAfterMs: capMs }) : undefined;

  try {
    opts.lock?.refresh();
    return await compileUnderLock(name, actor, operationId, capMs, opts);
  } finally {
    ownedLock?.release();
  }
}

async function compileUnderLock(
  name: PersonaName,
  actor: string,
  operationId: string,
  capMs: number,
  opts: RunPersonaCompileOptions,
): Promise<PersonaCompileOutcome> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error('wall-clock cap exceeded')), capMs);
  // Don't keep the process alive solely for the cap timer.
  timer.unref();

  // The workspace dir is the containment authority for path checks.
  const workspaceDir = getPersonaWorkspaceDir(name);
  // Read before the compile overwrites them: the rule delta judges the old
  // rules with the old lists.
  const previousPolicy = readPreviousCompiledPolicy(name);
  const previousLists = readPersonaDynamicLists(name);
  // The pipeline hands the hook the policy it is about to write, with the
  // resolved lists and the tool annotations it was compiled against; keep
  // them so the rule delta and the audit describe the policy with the same
  // inputs the validator saw.
  let attempted: CompiledPolicyFile | undefined;
  let compiledWith: BroadPolicyContext | undefined;
  const validateCompiled: CompiledPolicyValidator = (compiled, dynamicLists, annotations) => {
    attempted = compiled;
    compiledWith = { dynamicLists, annotations };
    // The opt-in is read now, when the result is judged, not when the compile
    // started, and only an explicit `true` counts.
    makeBroadPolicyValidator(workspaceDir, readBroadPolicyOptIn(name))(compiled, dynamicLists, annotations);
  };

  let policy: CompiledPolicyFile;
  try {
    policy = await (opts.compileImpl ?? defaultCompileImpl)(name, {
      ...(opts.reporterFactory ? { reporterFactory: opts.reporterFactory } : {}),
      ...(opts.quiet !== undefined ? { quiet: opts.quiet } : {}),
      signal: abort.signal,
      operationId,
      allowMcpLists: opts.allowMcpLists,
      validateCompiled,
    });
  } catch (err) {
    // Nothing was written: the validator refused the result, or the compile failed.
    const rejected = err instanceof BroadPolicyRejectedError;
    policyMutationAuditLog.append(actor, 'compilePersonaPolicy', name, {
      outcome: rejected ? 'rejected' : 'failed',
      errorCode: classifyPersonaCompileError(err).code,
      ...(attempted ? { constitutionHash: attempted.constitutionHash } : {}),
      ...(rejected ? { broadened: true } : {}),
      operationId,
    });
    throw err;
  } finally {
    clearTimeout(timer);
  }

  // A compile implementation that did not run the hook leaves the lists to be
  // read from what it wrote, and no annotations: the breadth check then counts
  // every allow rule without a value condition as unconstrained.
  const newContext: BroadPolicyContext = compiledWith ?? { dynamicLists: readPersonaDynamicLists(name) };
  // The policy is written, so it is recorded as written before the rule delta
  // is computed. `broadened` describes the written policy (`@list` references
  // resolved), so a first compile of an opted-in persona is recorded as broad
  // too.
  const findings = findBroadPolicy(policy, workspaceDir, newContext);
  policyMutationAuditLog.append(actor, 'compilePersonaPolicy', name, {
    outcome: 'written',
    constitutionHash: policy.constitutionHash,
    ruleCountDelta: policy.rules.length - (previousPolicy?.rules.length ?? 0),
    broadened: hasBroadAccess(findings),
    operationId,
  });
  // ruleDelta is omitted on the first compile (no previous policy to diff).
  // Each side's `@list` wildcards are judged with that side's lists.
  const ruleDelta = previousPolicy
    ? computeRuleDelta(previousPolicy, policy, workspaceDir, { ...newContext, oldDynamicLists: previousLists })
    : undefined;
  return { operationId, policy, ...(ruleDelta ? { ruleDelta } : {}), findings };
}

/** The persona's opt-in as persona.json states it now: only an explicit `true` counts. */
function readBroadPolicyOptIn(name: PersonaName): boolean {
  try {
    return loadPersona(name).allowBroadPolicy === true;
  } catch {
    return false; // unreadable: most restrictive
  }
}

/**
 * The default compile implementation: the dynamic-import seam to the
 * sanctioned pipeline-value module. Keeping it a free function (not a static
 * import at the top of the file) is what keeps the import boundary green.
 */
async function defaultCompileImpl(name: PersonaName, opts: CompilePersonaOptions): Promise<CompiledPolicyFile> {
  const { compilePersonaPolicy } = await import('./compile-persona-policy.js');
  return compilePersonaPolicy(name, opts);
}

/**
 * Reads the persona's current `compiled-policy.json` for the rule delta,
 * schema-validated as sessions load it. Undefined when it is absent or is not
 * a policy sessions would load (the first compile, or a corrupted or
 * hand-edited prior artifact), so the caller omits the delta instead of
 * failing on it after the new policy has been written.
 */
function readPreviousCompiledPolicy(name: PersonaName): CompiledPolicyFile | undefined {
  const path = resolve(getPersonaGeneratedDir(name), COMPILED_POLICY_FILENAME);
  try {
    return parseCompiledPolicyFile(JSON.parse(readFileSync(path, 'utf-8')), path);
  } catch {
    return undefined;
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/**
 * Reads the persona's `dynamic-lists.json` (resolved `@list` values) for the
 * rule delta and the audit record, keeping only well-formed lists, or
 * undefined when it is absent or unparseable. A list that is not there
 * expands to nothing at runtime, so it contributes nothing broad.
 */
function readPersonaDynamicLists(name: PersonaName): DynamicListsFile | undefined {
  const path = resolve(getPersonaGeneratedDir(name), 'dynamic-lists.json');
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const rawLists = (parsed as { lists?: unknown }).lists;
  if (typeof rawLists !== 'object' || rawLists === null) return undefined;
  const lists: DynamicListsFile['lists'] = {};
  for (const [listName, list] of Object.entries(rawLists as Record<string, unknown>)) {
    if (typeof list !== 'object' || list === null) continue;
    const { values, manualAdditions, manualRemovals } = list as Record<string, unknown>;
    if (!isStringArray(values) || !isStringArray(manualAdditions) || !isStringArray(manualRemovals)) continue;
    lists[listName] = { values, manualAdditions, manualRemovals, resolvedAt: '', inputHash: '' };
  }
  return { generatedAt: '', lists };
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/** Every phase a failed server can report (exhaustive over the DTO's union). */
const FAILED_SERVER_PHASES: Record<FailedServerDto['phase'], true> = {
  compiling: true,
  lists: true,
  scenarios: true,
  'repair-scenarios': true,
  verifying: true,
  'repair-compile': true,
  'repair-verify': true,
};

function isFailedServerPhase(phase: string): phase is FailedServerDto['phase'] {
  return Object.hasOwn(FAILED_SERVER_PHASES, phase);
}

/**
 * Reads the `failedServers` carried by a caught ALL_SERVERS_FAILED error,
 * dropping malformed entries (the value is untyped here).
 */
function failedServersOfError(value: unknown): FailedServerDto[] {
  if (!Array.isArray(value)) return [];
  const entries: unknown[] = value;
  const dtos: FailedServerDto[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { serverName, phase, reason } = entry as Record<string, unknown>;
    if (typeof serverName !== 'string' || typeof phase !== 'string' || !isFailedServerPhase(phase)) continue;
    dtos.push({ serverName, phase, reason: typeof reason === 'string' ? reason : '' });
  }
  return dtos;
}

/** Policy-lint findings a POLICY_LINT_FAILED message names; the others are counted. */
const LINT_FINDINGS_SHOWN = 3;

/** Displayed length of each finding named (escaped; a longer one is cut with a marker). */
const LINT_FINDING_MAX_LENGTH = 400;

/**
 * The message for a policy-lint failure (pipeline PolicyLintError): its first
 * {@link LINT_FINDINGS_SHOWN} findings, then how many more there are. The
 * findings quote rule names and values the compiler wrote, so each is shown
 * through toDisplayText (control, bidi and invisible characters as escapes)
 * and cut at {@link LINT_FINDING_MAX_LENGTH}. `errors` is untyped here, and
 * entries that are not strings are dropped.
 */
function describePolicyLintFailure(errors: unknown): string {
  const prefix = 'The compiled policy failed the policy checks, so nothing was written';
  if (!Array.isArray(errors)) return `${prefix}.`;
  const entries: unknown[] = errors;
  const findings = entries.filter((entry): entry is string => typeof entry === 'string');
  if (findings.length === 0) return `${prefix}.`;
  const shown = findings
    .slice(0, LINT_FINDINGS_SHOWN)
    .map((finding) => toDisplayText(finding, { maxLength: LINT_FINDING_MAX_LENGTH }));
  const more = findings.length - shown.length;
  return `${prefix}: ${shown.join('; ')}${more > 0 ? ` (and ${more} more)` : ''}`;
}

/**
 * Classifies a thrown compile error into a typed `{ code, message }` with an
 * operator-safe message. Lock / broad-policy / MCP-list / policy-lint /
 * credential errors carry their codes; everything else maps to INTERNAL_ERROR.
 */
export function classifyPersonaCompileError(err: unknown): { code: ErrorCode; message: string } {
  if (err instanceof PersonaCompileError) {
    return { code: err.code, message: err.message };
  }
  // Broad-policy validator rejection (constitution-injection defense).
  if (err instanceof BroadPolicyRejectedError) {
    return { code: err.code, message: err.message };
  }
  // Discriminant string from the pipeline (McpListsDisallowedError) — detected
  // without importing the thrower's module (layering rule).
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  if (code === 'MCP_LISTS_DISALLOWED') {
    return { code: 'LIST_REQUIRES_MCP', message: 'A dynamic list requires live MCP access, which is disabled.' };
  }
  // The merged policy failed the policy lint (pipeline PolicyLintError, also
  // detected by its code), so nothing was written. Its findings say what to
  // change (for example a broad manual list addition the persona has not
  // opted in to), so the first ones go into the message.
  if (code === 'POLICY_LINT_FAILED') {
    return {
      code: 'POLICY_LINT_FAILED',
      message: describePolicyLintFailure((err as { errors?: unknown }).errors),
    };
  }
  // Every server failed (pipeline AllServersFailedError), so no policy was
  // written. Name the servers and phases; the raw reasons stay in the logs.
  if (code === 'ALL_SERVERS_FAILED') {
    const failed = failedServersOfError((err as { failedServers?: unknown }).failedServers);
    const detail = failed.map((f) => `${f.serverName} (${f.phase})`).join(', ');
    return {
      code: 'INTERNAL_ERROR',
      message: `Persona compilation failed: every server failed to compile${detail ? `: ${detail}` : ''}.`,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  // AI SDK missing-key surfaces as a LoadAPIKeyError; map to CREDENTIALS_MISSING.
  if (err instanceof Error && (err.name === 'LoadAPIKeyError' || /api key/i.test(message))) {
    return { code: 'CREDENTIALS_MISSING', message: 'Missing model credentials on the daemon host.' };
  }
  return { code: 'INTERNAL_ERROR', message: 'Persona compilation failed.' };
}
