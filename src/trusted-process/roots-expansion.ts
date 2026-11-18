/**
 * Escalation-time MCP roots expansion (security-critical).
 *
 * When an escalated call is approved (by a human, the auto-approver or
 * the session whitelist), the backend MCP server must accept the
 * approved paths or it rejects the forwarded call. For
 * `@modelcontextprotocol/server-filesystem` that means adding MCP roots.
 * A root is a persistent widening of the server's own containment for
 * the rest of the session: the server re-resolves every root URI
 * (`fs.realpath`) on each `notifications/roots/list_changed`, and its
 * relay restarts it under an OS sandbox profile that exposes the new
 * roots (see `roots-confinement.ts`). This module therefore adds only
 * roots that are:
 *
 * - derived from the paths that actually escalated
 *   (`EvaluationResult.escalatedRoles`), never from every path argument;
 * - taken from the canonical path the policy engine evaluated, never
 *   from a fresh resolution of it. After the approval wait every path
 *   argument is canonicalized again (T1); if any no longer resolves to
 *   the evaluated path, the call is denied and nothing is added
 *   ({@link findChangedApprovedPaths});
 * - outside the sandbox/workspace and the IronCurtain home, where the
 *   agent-writable mounts live. A root there would let the agent rename
 *   or replace the directory and redirect the root at any later refresh;
 *   the sandbox root already covers those paths;
 * - not already covered by an existing root, and existing canonical
 *   directories whose names the server reads back unchanged, sent in
 *   the spelling the server reports (the on-disk case on macOS).
 *
 * After each refresh the caller reads the backend's effective allowed
 * directories back ({@link verifyBackendRoots}). They must be a subset of
 * the intended canonical set; anything else means the server resolved a
 * root to something IronCurtain did not approve, and the caller drops
 * the connection (fail closed).
 *
 * This module is not the mitigation for the per-call symlink-swap race
 * between the server's own path validation and its use of the path. That
 * is the server's OS confinement to its roots (`roots-confinement.ts`):
 * the kernel, not a check that runs earlier, decides what the server's
 * open reaches. It is also why only the roots added here, and no other
 * directory, become reachable for the server.
 */

import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CompatibilityCallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ToolAnnotation } from '../pipeline/types.js';
import { getPathRoles, resolveRealPath, type ArgumentRole } from '../types/argument-roles.js';
import { getIronCurtainHome } from '../config/paths.js';
import { ROOTS_REFRESH_TIMEOUT_MS, type ClientState, type McpRoot } from './mcp-client-manager.js';
import { pathForRootUri, resolveApprovedPath, rootDirectoryForCanonicalPath, rootUriForPath } from './policy-roots.js';

/** Rule stamped on a call denied because an approved path resolved differently after the approval wait. */
export const RULE_APPROVED_PATH_CHANGED = 'approved-path-changed';

/** Rule stamped on a call denied because the backend's roots did not match the approved set after a refresh. */
export const RULE_ROOTS_VERIFICATION_FAILED = 'roots-verification-failed';

/** `name` given to roots added after an approved escalation. */
export const ESCALATION_ROOT_NAME = 'escalation-approved';

/** Backend tool that reports the server's effective allowed directories (server-filesystem). */
export const ALLOWED_DIRECTORIES_TOOL = 'list_allowed_directories';

/** First line of the `list_allowed_directories` text result. */
const ALLOWED_DIRECTORIES_HEADER = 'Allowed directories:';

/** Interval between `list_allowed_directories` polls while the backend applies new roots. */
export const ROOTS_VERIFY_POLL_INTERVAL_MS = 25;

// ---------------------------------------------------------------------------
// T0 capture and T1 re-check
// ---------------------------------------------------------------------------

/** A path argument of an escalated call, as it stood when the policy engine evaluated it. */
export interface ApprovedPath {
  /** The argument value exactly as the policy engine evaluated it. */
  readonly value: string;
  /**
   * The canonical absolute path the approval covers. For an absolute
   * value this is the value itself: `prepareToolArgs` canonicalized it
   * before the policy engine evaluated it, so it is the evaluated path
   * even when it no longer resolves to itself. A relative value (never
   * produced by the pipeline) is resolved against the sandbox at T0.
   */
  readonly canonical: string;
  /**
   * The root this path needs, set only for paths of an escalated role
   * that still resolved to `canonical` at T0: the canonical path itself
   * when it was an existing directory, otherwise its parent.
   */
  readonly rootDirectory?: string;
}

export interface CaptureApprovedPathsInput {
  /** Policy arguments (`argsForPolicy`): the values the policy engine evaluated. */
  readonly args: Readonly<Record<string, unknown>>;
  readonly annotation: ToolAnnotation;
  /** Roles whose evaluation escalated. `undefined` means none may yield a root. */
  readonly escalatedRoles: readonly ArgumentRole[] | undefined;
  /** Session sandbox; relative values resolve against it. */
  readonly allowedDirectory: string | undefined;
}

/**
 * Captures every path argument of an escalated call at evaluation time
 * (T0), before any approval wait.
 *
 * Every path argument is recorded so {@link findChangedApprovedPaths}
 * can re-check the whole call after the wait: the approver saw all of
 * them. Only values of an escalated path role carry a `rootDirectory`.
 * When the engine reports no `escalatedRoles`, no value may become a root.
 *
 * The approved form of an absolute value is the value itself, not a
 * fresh resolution of it: the agent can swap a directory component for a
 * symlink between policy evaluation and this capture, and re-resolving
 * here would turn the swapped-in target into an approved root. A value
 * that no longer resolves to itself yields no root, and the T1 check
 * reports it as changed.
 */
export function captureApprovedPaths(input: CaptureApprovedPathsInput): ApprovedPath[] {
  const pathRoles = new Set<ArgumentRole>(getPathRoles());
  const escalatedPathRoles = new Set((input.escalatedRoles ?? []).filter((role) => pathRoles.has(role)));

  // A value can appear under several arguments or roles; it is a root
  // candidate when any of them escalated.
  const candidateByValue = new Map<string, boolean>();
  for (const [argName, roles] of Object.entries(input.annotation.args)) {
    const argPathRoles = roles.filter((role) => pathRoles.has(role));
    if (argPathRoles.length === 0) continue;
    const escalated = argPathRoles.some((role) => escalatedPathRoles.has(role));
    for (const value of stringValues(input.args[argName])) {
      candidateByValue.set(value, escalated || candidateByValue.get(value) === true);
    }
  }

  const captured: ApprovedPath[] = [];
  for (const [value, candidate] of candidateByValue) {
    // A relative value with no sandbox resolves the way the policy
    // engine resolved it, but never yields a root.
    const resolved = resolveApprovedPath(value, input.allowedDirectory);
    const canonical = isAbsolute(value) ? value : (resolved ?? resolveRealPath(value));
    captured.push(
      candidate && resolved === canonical
        ? { value, canonical, rootDirectory: rootDirectoryForCanonicalPath(canonical) }
        : { value, canonical },
    );
  }
  return captured;
}

/**
 * Canonicalizes every captured path again after the approval wait (T1)
 * and returns those that no longer resolve to their approved canonical
 * form, for example because a directory component was replaced by a
 * symlink after policy evaluation or while the approver was deciding. A
 * non-empty result means the call is no longer the one that was
 * approved: the caller denies it and adds no root.
 */
export function findChangedApprovedPaths(
  approvedPaths: readonly ApprovedPath[],
  allowedDirectory: string | undefined,
): ApprovedPath[] {
  return approvedPaths.filter(
    (path) => (resolveApprovedPath(path.value, allowedDirectory) ?? resolveRealPath(path.value)) !== path.canonical,
  );
}

// ---------------------------------------------------------------------------
// Root selection
// ---------------------------------------------------------------------------

export interface SelectRootsInput {
  readonly approvedPaths: readonly ApprovedPath[];
  /** The roots the server currently has (the client's live root list). */
  readonly existingRoots: readonly McpRoot[];
  /** Session sandbox/workspace. */
  readonly allowedDirectory: string | undefined;
}

/**
 * Chooses the canonical directories to add as roots for an approved
 * call, after {@link findChangedApprovedPaths} found no change. Each is
 * returned in the spelling the server will report for it
 * ({@link serverSpelling}). A candidate is skipped when it:
 *
 * - is not an existing directory without a symlink in any component
 *   (checked now, right before the root is sent);
 * - is at or under the sandbox or the IronCurtain home (agent-writable),
 *   in either spelling;
 * - is already covered by an existing root or by another selected root;
 * - has a name the server would rewrite or could not report back.
 */
export function selectRootsToAdd(input: SelectRootsInput): string[] {
  const agentWritable = withServerSpellings(agentWritableDirectories(input.allowedDirectory));
  const covered = withServerSpellings(
    input.existingRoots.map((root) => pathForRootUri(root.uri)).filter((path): path is string => path !== undefined),
  );

  // Shortest first, so a selected ancestor absorbs its descendants.
  const candidates = [
    ...new Set(input.approvedPaths.flatMap((path) => (path.rootDirectory === undefined ? [] : [path.rootDirectory]))),
  ].sort((a, b) => a.length - b.length);

  const selected: string[] = [];
  for (const directory of candidates) {
    const root = serverSpelling(directory);
    if (root === undefined || !isDirectory(directory)) continue;
    const spellings = root === directory ? [root] : [directory, root];
    if (spellings.some((path) => agentWritable.some((dir) => isSameOrWithin(path, dir)))) continue;
    if (spellings.some((path) => covered.some((dir) => isSameOrWithin(path, dir)))) continue;
    if (selected.some((dir) => isSameOrWithin(root, dir))) continue;
    if (!isServerStableRootPath(root)) continue;
    selected.push(root);
  }
  return selected;
}

/**
 * Directories under which no root may ever be added: the sandbox (the
 * Docker workspace mount) and the IronCurtain home, which holds every
 * other agent-writable mount (conversation state, socket directories,
 * workflow dependency caches, persona and job workspaces). Paths there
 * are either covered by the sandbox root or structurally denied.
 */
function agentWritableDirectories(allowedDirectory: string | undefined): string[] {
  const directories = [getIronCurtainHome()];
  if (allowedDirectory !== undefined) directories.push(allowedDirectory);
  return directories.map((directory) => resolveRealPath(directory));
}

/** Lexical containment on canonical absolute paths (no filesystem access). */
function isSameOrWithin(path: string, directory: string): boolean {
  if (path === directory) return true;
  return path.startsWith(directory.endsWith('/') ? directory : `${directory}/`);
}

/**
 * The spelling under which server-filesystem reports `path`, or
 * `undefined` unless `path` exists with no symlink in any component.
 *
 * The server resolves each root with `fs.promises.realpath`, the native
 * realpath(3), which returns the on-disk spelling. `resolveRealPath` uses
 * the native realpath on macOS too, so IronCurtain's canonical paths
 * normally carry that spelling already. A path canonicalized with the JS
 * `realpathSync`, which keeps the caller's spelling of every component
 * that is not a symlink, can still differ from it in case or Unicode
 * normalization on a case-insensitive volume (the macOS default) while
 * naming the same directory. Requiring `realpathSync(path) === path`
 * first means a path that now resolves through a symlink has no server
 * spelling, so a redirected directory never matches.
 */
function serverSpelling(path: string): string | undefined {
  try {
    if (realpathSync(path) !== path) return undefined;
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}

/** `paths` plus the server spelling of each one that has a different one. */
function withServerSpellings(paths: readonly string[]): string[] {
  const all = new Set(paths);
  for (const path of paths) {
    const spelled = serverSpelling(path);
    if (spelled !== undefined) all.add(spelled);
  }
  return [...all];
}

/** True when `path` is a directory itself, not a symlink to one. */
function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * server-filesystem normalizes every root after its realpath: it trims
 * surrounding whitespace and strips a leading or trailing quote
 * (`normalizePath` in its path-utils.js). A directory whose name ends in
 * whitespace or a quote would therefore be installed as a different
 * directory. `list_allowed_directories` is newline-separated, so a name
 * with a control character could not be verified. Such directories are
 * never added.
 */
function isServerStableRootPath(directory: string): boolean {
  if (!isAbsolute(directory) || directory !== directory.trim()) return false;
  for (let i = 0; i < directory.length; i++) {
    const code = directory.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  const last = directory[directory.length - 1];
  return last !== '"' && last !== "'";
}

// ---------------------------------------------------------------------------
// Roots refresh
// ---------------------------------------------------------------------------

/**
 * Outcome of {@link addRootsToClient}:
 * - `added`: the server fetched the updated list (`roots/list`);
 * - `timeout`: the server did not fetch it within the timeout;
 * - `unchanged`: every directory was already a root, nothing was sent;
 * - `failed`: the `roots/list_changed` notification could not be sent.
 */
export type RootsRefreshOutcome = 'added' | 'timeout' | 'unchanged' | 'failed';

/**
 * Appends roots for `directories` to the client's live root list, sends
 * one `notifications/roots/list_changed`, and waits until the server
 * fetches the list or `timeoutMs` elapses (servers that do not implement
 * the Roots protocol never fetch it).
 */
export async function addRootsToClient(
  state: ClientState,
  directories: readonly string[],
  timeoutMs: number = ROOTS_REFRESH_TIMEOUT_MS,
): Promise<RootsRefreshOutcome> {
  const additions: McpRoot[] = [];
  for (const directory of directories) {
    const uri = rootUriForPath(directory);
    if (state.roots.some((root) => root.uri === uri) || additions.some((root) => root.uri === uri)) continue;
    additions.push({ uri, name: ESCALATION_ROOT_NAME });
  }
  if (additions.length === 0) return 'unchanged';
  state.roots.push(...additions);

  let timer: ReturnType<typeof setTimeout> | undefined;
  // Register the acknowledgment slot before notifying: the server can
  // fetch the list while the notification is still being sent.
  const refreshed = new Promise<'added'>((resolve) => {
    state.rootsRefreshed = () => resolve('added');
  });
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      state.rootsRefreshed = undefined;
      resolve('timeout');
    }, timeoutMs);
    timer.unref();
  });

  try {
    await state.client.sendRootsListChanged();
  } catch {
    clearTimeout(timer);
    state.rootsRefreshed = undefined;
    return 'failed';
  }
  const outcome = await Promise.race([refreshed, timedOut]);
  clearTimeout(timer);
  return outcome;
}

// ---------------------------------------------------------------------------
// Backend verification
// ---------------------------------------------------------------------------

/** Client surface needed to read a backend's allowed directories. */
export type AllowedDirectoriesClient = Pick<Client, 'callTool'>;

/**
 * Result of {@link verifyBackendRoots}. Anything but `verified` means the
 * backend's containment is not known to match what was approved, and the
 * caller must drop the connection.
 */
export type BackendRootsVerification =
  | { readonly status: 'verified' }
  /** The backend allows directories outside the intended canonical set. */
  | { readonly status: 'unexpected'; readonly directories: readonly string[] }
  /** The backend did not report the added roots before the timeout. */
  | { readonly status: 'unconfirmed'; readonly missing: readonly string[] }
  /** The allowed directories could not be read or parsed. */
  | { readonly status: 'unreadable'; readonly error: string };

export interface VerifyBackendRootsOptions {
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
}

/**
 * Reads the backend's effective allowed directories after a roots
 * refresh and compares them with the intended canonical set (the
 * client's root list, every entry of which IronCurtain canonicalized).
 *
 * Polls until every added directory appears, so the comparison covers
 * the refresh that carried them. The backend replaces its list
 * atomically, so each reading is either the previous list or the new
 * one, and both must be subsets of the intended set. A directory outside
 * the set means the server resolved a root URI to a different directory
 * (for example through a symlink swapped in after IronCurtain checked
 * it) and fails verification immediately.
 *
 * An intended root also matches under its server spelling (the on-disk
 * case on a case-insensitive volume), but only while it has no symlink
 * in any component, so this never admits a redirected root.
 * `addedDirectories` are already in the server spelling.
 */
export async function verifyBackendRoots(
  client: AllowedDirectoriesClient,
  intendedRoots: readonly McpRoot[],
  addedDirectories: readonly string[],
  options: VerifyBackendRootsOptions = {},
): Promise<BackendRootsVerification> {
  const timeoutMs = options.timeoutMs ?? ROOTS_REFRESH_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? ROOTS_VERIFY_POLL_INTERVAL_MS;
  const intended = new Set(
    withServerSpellings(
      intendedRoots.map((root) => pathForRootUri(root.uri)).filter((path): path is string => path !== undefined),
    ),
  );
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    let listed: string[];
    try {
      listed = await listBackendAllowedDirectories(client, timeoutMs);
    } catch (err) {
      return { status: 'unreadable', error: err instanceof Error ? err.message : String(err) };
    }
    const unexpected = listed.filter((directory) => !intended.has(directory));
    if (unexpected.length > 0) return { status: 'unexpected', directories: unexpected };
    const missing = addedDirectories.filter((directory) => !listed.includes(directory));
    if (missing.length === 0) return { status: 'verified' };
    if (Date.now() >= deadline) return { status: 'unconfirmed', missing };
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

/** Human-readable reason for a failed {@link verifyBackendRoots} result. */
export function describeRootsVerificationFailure(
  verification: Exclude<BackendRootsVerification, { status: 'verified' }>,
): string {
  switch (verification.status) {
    case 'unexpected':
      return `the server allows directories that were never approved: ${verification.directories.join(', ')}`;
    case 'unconfirmed':
      return `the server did not apply the approved roots in time: ${verification.missing.join(', ')}`;
    case 'unreadable':
      return `the server's allowed directories could not be read: ${verification.error}`;
  }
}

/** Calls the backend's `list_allowed_directories` tool and parses the directory list. */
export async function listBackendAllowedDirectories(
  client: AllowedDirectoriesClient,
  timeoutMs: number = ROOTS_REFRESH_TIMEOUT_MS,
): Promise<string[]> {
  const result = await client.callTool(
    { name: ALLOWED_DIRECTORIES_TOOL, arguments: {} },
    CompatibilityCallToolResultSchema,
    { timeout: timeoutMs },
  );
  const text = textOfContent(result.content);
  if (result.isError === true || text === undefined) {
    throw new Error(`${ALLOWED_DIRECTORIES_TOOL} failed: ${text ?? 'no text content'}`);
  }
  return parseAllowedDirectories(text);
}

/**
 * Parses server-filesystem's `list_allowed_directories` text:
 * `Allowed directories:` followed by one directory per line. Throws on
 * any other shape.
 */
export function parseAllowedDirectories(text: string): string[] {
  const [header, ...lines] = text.split('\n');
  if (header.trim() !== ALLOWED_DIRECTORIES_HEADER) {
    throw new Error(`unexpected ${ALLOWED_DIRECTORIES_TOOL} output`);
  }
  return lines.filter((line) => line.length > 0);
}

// ---------------------------------------------------------------------------
// Roots-race detection
// ---------------------------------------------------------------------------

/** server-filesystem's per-file failure inside a successful `read_multiple_files` result. */
const PER_FILE_ACCESS_DENIED = /: Error - Access denied - (?:path|symlink target) outside allowed directories/;

/**
 * True when every resource role of the call is `read-path`, so replaying
 * it cannot change anything.
 */
export function isReadOnlyAnnotation(annotation: ToolAnnotation): boolean {
  const roles = Object.values(annotation.args).flat();
  return roles.includes('read-path') && roles.every((role) => role === 'read-path' || role === 'none');
}

/**
 * True when a backend result looks like the server rejected the call
 * because it had not finished applying newly added roots.
 *
 * Error results are matched on their text. A read-only call can also
 * fail per file inside a successful result: `read_multiple_files`
 * reports `<path>: Error - Access denied - ...` per entry without
 * setting `isError`. Those are matched only for read-only calls, where
 * a retry is harmless even if a file's content happens to contain the
 * same words.
 */
export function isRootsRaceResult(result: Readonly<Record<string, unknown>>, readOnly: boolean): boolean {
  const text = textOfContent(result.content);
  if (text === undefined) return false;
  if (result.isError === true) {
    const lower = text.toLowerCase();
    return lower.includes('access denied') || lower.includes('outside allowed directories');
  }
  return readOnly && PER_FILE_ACCESS_DENIED.test(text);
}

/** Concatenated text of MCP content blocks, or undefined when there is none. */
function textOfContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const texts: string[] = [];
  for (const block of content as unknown[]) {
    if (typeof block !== 'object' || block === null) continue;
    const { type, text } = block as { type?: unknown; text?: unknown };
    if (type === 'text' && typeof text === 'string') texts.push(text);
  }
  return texts.length > 0 ? texts.join('\n') : undefined;
}

/** String values of a path argument (a string or an array of strings). */
function stringValues(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return [];
}
