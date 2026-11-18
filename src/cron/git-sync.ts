/**
 * Cron git sync: keep a job workspace checked out at the upstream default
 * branch without ever running host git against agent-writable metadata.
 *
 * The job workspace, `.git` included, belongs to the job's agent: it is
 * bind-mounted read-write into the container and is the Code Mode
 * allowedDirectory. Host git honours a repository's own config, hooks,
 * attributes, gitfile and `commondir` redirects and remote URLs, so running
 * it there would be host code execution and would let the agent choose what
 * the daemon fetches. This module instead:
 *
 * 1. keeps a daemon-owned bare mirror (`~/.ironcurtain/jobs/<id>/repo.git`),
 *    outside the workspace and never mounted, and fetches the validated
 *    `job.gitRepo` URL into it with an explicit refspec. It never fetches a
 *    named remote, so no repository config decides where the fetch goes, and
 *    a changed URL re-clones the mirror;
 * 2. computes the discarded changes before fetching: the files that differ
 *    from the commit the workspace was last synced to (recorded in the
 *    mirror), read with `--git-dir=<mirror> --work-tree=<workspace>`, a
 *    temporary index, `--no-ext-diff --no-textconv`, and attributes taken
 *    from that trusted commit rather than the work tree;
 * 3. moves the workspace `.git` (directory, gitfile, symlink or anything
 *    else) out of the workspace without following it, builds a fresh `.git`
 *    from the mirror in a host-private staging directory (IronCurtain writes
 *    its config, refs and index), hard-resets the tracked files with that git
 *    directory, and only then moves it into the workspace, so the agent
 *    keeps a working repository. Its `origin` remote is the job URL without
 *    the credentials a user may embed in it: those stay host-side (the job
 *    definition and the mirror), used only by the sync's own fetch;
 * 4. runs every git command through `runGit` (asynchronous, its own process
 *    group, a per-operation timeout) with `hardenedGitEnv`: no terminal
 *    prompts and no askpass, transports limited to the URL's own scheme, ssh
 *    in batch mode with connect and keepalive timeouts, http low-speed
 *    limits, and no LLM provider credentials in the environment.
 *
 * Host git only ever runs with `--git-dir` naming the mirror or the staging
 * directory, both host-private (`init` and `ls-remote` use no repository at
 * all), from a cwd inside the staging directory. Untracked workspace files
 * (agent artifacts such as `last-run.md`) are preserved; the agent's local
 * git history is not. A user-supplied workspace must be empty the first time
 * it is synced, so a sync never replaces a `.git` or files it did not create.
 *
 * Residual: the filesystem steps assume no agent is running in the workspace
 * during the sync, so callers must not sync a workspace while an agent may
 * be working in it (syncs themselves are serialized below). The daemon's cron
 * runs hold the workspace lock of `src/workflow/run-lock.ts`, which workflow
 * runs take too, from before the sync until their session has ended, so no
 * other job's run or workflow is in the workspace meanwhile; sessions started
 * otherwise (`start --workspace`, mux) take no workspace lock. A concurrently
 * running agent could race git's checkout writes (for example by swapping a
 * directory for a symlink between git's check and its write); it still never
 * controls a git directory host git uses.
 */

import { constants as fsConstants, type Stats } from 'node:fs';
import { copyFile, cp, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm } from 'node:fs/promises';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  hardenedGitEnv,
  readTrustedGitConfigAsync,
  runGit,
  type GitTransportProtocol,
  type RunGitResult,
  type TrustedGitConfig,
} from '../security/git-hardening.js';
import { toDisplayText } from '../terminal/display-sanitize.js';

// ── URI validation ─────────────────────────────────────────────────────

/**
 * Allowlisted git URI schemes, with the one transport each may use. Git's
 * ext:: protocol allows arbitrary command execution and must never be
 * accepted.
 *
 * Accepted forms:
 *   - https://host/repo.git
 *   - http://host/repo.git
 *   - ssh://user@host/repo.git
 *   - git://host/repo.git
 *   - git@host:org/repo.git  (SCP-style shorthand for SSH)
 *   - file:///path/to/repo
 */
const SAFE_URI_PATTERNS: ReadonlyArray<{ readonly pattern: RegExp; readonly protocol: GitTransportProtocol }> = [
  { pattern: /^https:\/\//i, protocol: 'https' },
  { pattern: /^http:\/\//i, protocol: 'http' },
  { pattern: /^ssh:\/\//i, protocol: 'ssh' },
  { pattern: /^git:\/\//i, protocol: 'git' },
  { pattern: /^file:\/\//i, protocol: 'file' },
  { pattern: /^[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+:/, protocol: 'ssh' }, // SCP-style: user@host:path
];

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * Validates a git URI and returns the single transport it may use, which
 * is all the sync's fetch allows (`GIT_ALLOW_PROTOCOL`): `file` only for a
 * `file://` URI, `ssh` for `ssh://` and SCP-style URIs, and so on.
 *
 * @throws {Error} if the URI is empty, contains control characters, starts
 *   with `-`, or uses a disallowed protocol
 */
export function gitUriTransport(uri: string): GitTransportProtocol {
  const trimmed = uri.trim();
  if (!trimmed) {
    throw new Error('Git URI must not be empty');
  }
  if (hasControlCharacter(trimmed)) {
    throw new Error('Git URI must not contain control characters');
  }
  if (trimmed.startsWith('-')) {
    throw new Error('Git URI must not start with "-"');
  }

  const match = SAFE_URI_PATTERNS.find(({ pattern }) => pattern.test(trimmed));
  if (match === undefined) {
    throw new Error(
      `Rejected git URI with disallowed protocol: "${trimmed}". ` +
        `Only https, http, ssh, git, file, and SCP-style (user@host:path) URIs are allowed.`,
    );
  }
  return match.protocol;
}

/**
 * Validates that a git URI uses a safe transport protocol.
 *
 * Rejects dangerous protocols like ext:: which allow arbitrary
 * command execution, and any other unrecognized scheme.
 *
 * @throws {Error} if the URI uses a disallowed protocol
 */
export function validateGitUri(uri: string): void {
  gitUriTransport(uri);
}

// ── Public sync API ────────────────────────────────────────────────────

/** Why a sync failed: a git operation hit its timeout, or anything else. */
export type GitSyncFailureKind = 'sync_timeout' | 'sync_error';

export interface GitSyncSuccess {
  readonly ok: true;
  /** The upstream default branch now checked out. */
  readonly branch: string;
  /** The commit the tracked files were reset to. */
  readonly commit: string;
  /**
   * `git diff --stat` of the tracked-file changes the reset discarded,
   * relative to the commit the previous sync checked out; null when there
   * were none or no previous sync was recorded for this workspace.
   */
  readonly discardedChanges: string | null;
  /** Non-fatal problems worth logging (display-safe text). */
  readonly warnings: readonly string[];
}

export interface GitSyncFailure {
  readonly ok: false;
  readonly kind: GitSyncFailureKind;
  /** Single-line, display-safe description with URL credentials redacted. */
  readonly message: string;
}

export type GitSyncResult = GitSyncSuccess | GitSyncFailure;

export interface GitSyncTimeouts {
  /** `git ls-remote` to find the upstream default branch. */
  readonly remoteQueryMs: number;
  /** The first fetch into a new mirror (the clone). */
  readonly initialFetchMs: number;
  /** A fetch into an existing mirror. */
  readonly fetchMs: number;
  /** Each local step (index, diff, refs, config, checkout). */
  readonly localMs: number;
}

export const DEFAULT_GIT_SYNC_TIMEOUTS: GitSyncTimeouts = {
  remoteQueryMs: 2 * 60_000,
  initialFetchMs: 10 * 60_000,
  fetchMs: 5 * 60_000,
  localMs: 5 * 60_000,
};

export interface GitSyncOptions {
  /** Upstream repository (the job's `gitRepo`); validated here. */
  readonly uri: string;
  /** The job workspace, used as the work tree. */
  readonly workspaceDir: string;
  /**
   * Daemon-owned bare mirror (`getJobRepoMirrorDir`). It and its parent
   * directory, which also holds the staging area, must not be inside the
   * workspace.
   */
  readonly mirrorDir: string;
  /**
   * True for IronCurtain's own job workspace (`~/.ironcurtain/jobs/<id>/workspace`):
   * it is created if missing and may be taken over from an earlier layout.
   * A user-supplied workspace must be empty the first time it is synced, so
   * a sync never replaces a `.git` or files IronCurtain did not put there.
   */
  readonly managedWorkspace: boolean;
  /** Per-operation limits; defaults in {@link DEFAULT_GIT_SYNC_TIMEOUTS}. */
  readonly timeouts?: Partial<GitSyncTimeouts>;
  /** Aborting kills the running git process group and fails the sync. */
  readonly signal?: AbortSignal;
  /** Trusted host environment for git (default `process.env`). */
  readonly baseEnv?: NodeJS.ProcessEnv;
}

/**
 * Syncs `workspaceDir` to the default branch of `uri` (see the module
 * comment). Never throws: failures are returned as `sync_timeout` (a git
 * operation exceeded its limit; the whole process group was killed) or
 * `sync_error`. Concurrent syncs of the same mirror or workspace within
 * this process run one after another.
 */
export async function syncGitRepo(options: GitSyncOptions): Promise<GitSyncResult> {
  let uri: string;
  let protocol: GitTransportProtocol;
  try {
    protocol = gitUriTransport(options.uri);
    uri = options.uri.trim();
  } catch (error) {
    return { ok: false, kind: 'sync_error', message: displayMessage(errorMessage(error)) };
  }

  const progress: SyncProgress = { step: 'preparing the sync' };
  try {
    const paths = await resolveSyncPaths(options);
    return await withSyncLocks([paths.mirrorDir, paths.workspace], () =>
      runSync({
        uri,
        protocol,
        ...paths,
        managedWorkspace: options.managedWorkspace,
        timeouts: resolveTimeouts(options.timeouts),
        signal: options.signal,
        baseEnv: withoutProviderCredentials(options.baseEnv ?? process.env),
        progress,
      }),
    );
  } catch (error) {
    return {
      ok: false,
      kind: isGitTimeout(error) ? 'sync_timeout' : 'sync_error',
      message: displayMessage(`${progress.step}: ${errorMessage(error)}`),
    };
  }
}

// ── Internals ──────────────────────────────────────────────────────────

/** Ref in the mirror recording the commit last checked out into the workspace. */
const SYNCED_REF = 'refs/ironcurtain/synced';
/** Mirror config keys holding the sync state (all trusted: the mirror is daemon-owned). */
const STATE_URL_KEY = 'ironcurtain.url';
const STATE_WORKSPACE_KEY = 'ironcurtain.workspace';
const STATE_BRANCH_KEY = 'ironcurtain.branch';

/** Prefix of the per-sync staging directories created next to the mirror. */
const STAGING_PREFIX = '.git-sync-';
/** Staging directories older than this are leftovers of a crashed sync. */
const STALE_STAGING_MS = 24 * 60 * 60_000;

const SSH_BATCH_OPTIONS = '-o BatchMode=yes -o ConnectTimeout=30 -o ServerAliveInterval=15 -o ServerAliveCountMax=4';

/** Files listed in the discarded-changes summary, and its overall size. */
const MAX_DISCARDED_FILES = 200;
const MAX_DISCARDED_CHARS = 8_000;

/** Never handed to git: LLM provider credentials the daemon holds for its own use. */
const PROVIDER_CREDENTIAL_VARIABLES: ReadonlySet<string> = new Set(['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']);

/** Command-scope settings every sync step uses (on top of `hardenedGitEnv`). */
const SYNC_CONFIG: readonly (readonly [string, string])[] = [
  // Quote unusual path bytes in the discarded-changes summary.
  ['core.quotePath', 'true'],
  // Refuse tree entries that alias `.git` on NTFS/HFS+ work trees.
  ['core.protectNTFS', 'true'],
  ['core.protectHFS', 'true'],
  ['core.sparseCheckout', 'false'],
  ['core.splitIndex', 'false'],
  ['core.untrackedCache', 'false'],
  // Stat-only differences in the freshly built index are not changes.
  ['diff.autoRefreshIndex', 'true'],
  // Never look into (or run git inside) a submodule directory of the workspace.
  ['diff.ignoreSubmodules', 'all'],
  ['submodule.recurse', 'false'],
  ['fetch.recurseSubmodules', 'false'],
];

/** Abort an http transfer that stays below 1000 bytes/s for 60 s. */
const REMOTE_CONFIG: readonly (readonly [string, string])[] = [
  ['http.lowSpeedLimit', '1000'],
  ['http.lowSpeedTime', '60'],
];

type ObjectFormat = 'sha1' | 'sha256';

interface SyncProgress {
  step: string;
}

interface SyncPaths {
  /** Canonical work tree. */
  readonly workspace: string;
  readonly mirrorDir: string;
  /** Canonical parent of the mirror; holds the staging directories. */
  readonly stateDir: string;
}

interface SyncContext extends SyncPaths {
  readonly uri: string;
  readonly protocol: GitTransportProtocol;
  readonly managedWorkspace: boolean;
  readonly timeouts: GitSyncTimeouts;
  readonly signal: AbortSignal | undefined;
  /** The host environment without LLM provider credentials. */
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly progress: SyncProgress;
}

interface MirrorState {
  readonly url: string | undefined;
  readonly workspace: string | undefined;
  readonly branch: string | undefined;
  readonly objectFormat: ObjectFormat;
  /** The last commit checked out into the recorded workspace. */
  readonly synced: string | undefined;
}

interface GitRunOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly allowNonZeroExit?: boolean;
  readonly input?: string;
}

type GitRunner = (args: readonly string[], options?: GitRunOptions) => Promise<RunGitResult>;

function resolveTimeouts(overrides: Partial<GitSyncTimeouts> | undefined): GitSyncTimeouts {
  const pick = (key: keyof GitSyncTimeouts): number => overrides?.[key] ?? DEFAULT_GIT_SYNC_TIMEOUTS[key];
  return {
    remoteQueryMs: pick('remoteQueryMs'),
    initialFetchMs: pick('initialFetchMs'),
    fetchMs: pick('fetchMs'),
    localMs: pick('localMs'),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

function isGitTimeout(error: unknown): boolean {
  return errorCode(error) === 'GIT_TIMEOUT';
}

/** Redact URL userinfo that can carry credentials: all of it for http(s), the password part elsewhere. */
function redactCredentials(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/giu, (_match, scheme: string, userinfo: string) => {
    if (/^https?:\/\/$/iu.test(scheme)) return `${scheme}<redacted>@`;
    const colon = userinfo.indexOf(':');
    return colon < 0 ? `${scheme}${userinfo}@` : `${scheme}${userinfo.slice(0, colon)}:<redacted>@`;
  });
}

/**
 * `uri` as git uses it, trimmed like {@link syncGitRepo} trims it (a job's
 * `gitRepo` is stored as entered, so leading whitespace must not hide the
 * userinfo from the match), without the credentials a user can embed in it,
 * as {@link redactCredentials} hides them for display: an http(s) URL loses
 * its whole userinfo (a token is often the user name), any other URL the
 * password part (an ssh user name names the account; it is not a secret).
 * The userinfo is everything before the last `@` of the authority, which
 * ends at the first `/`, `?` or `#`, so a raw `@` in a password goes too.
 * SCP-style `user@host:path` cannot carry a password and is unchanged.
 *
 * The agent-readable `origin` remote of the workspace `.git` is written with
 * this; only the sync's own fetch into the mirror uses the full URL.
 */
export function stripUrlCredentials(uri: string): string {
  const url = uri.trim();
  const match = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)@/iu.exec(url);
  if (match === null) return url;
  const [prefix, scheme, userinfo] = match;
  const rest = url.slice(prefix.length);
  if (/^https?:\/\/$/iu.test(scheme)) return `${scheme}${rest}`;
  const colon = userinfo.indexOf(':');
  if (colon < 0) return url;
  const user = userinfo.slice(0, colon);
  return user === '' ? `${scheme}${rest}` : `${scheme}${user}@${rest}`;
}

function displayMessage(text: string): string {
  return toDisplayText(redactCredentials(text), { maxLength: 600 });
}

function isEqualOrInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

async function lstatOrUndefined(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

async function resolveSyncPaths(options: GitSyncOptions): Promise<SyncPaths> {
  const requested = resolve(options.workspaceDir);
  if (options.managedWorkspace) await mkdir(requested, { recursive: true });
  const workspace = await realpath(requested);
  if (!(await lstat(workspace)).isDirectory()) throw new Error(`workspace is not a directory: ${workspace}`);

  const mirrorDir = resolve(options.mirrorDir);
  await mkdir(dirname(mirrorDir), { recursive: true, mode: 0o700 });
  const stateDir = await realpath(dirname(mirrorDir));
  const canonicalMirror = join(stateDir, basename(mirrorDir));
  // The mirror and the staging area must stay out of the agent's reach.
  if (isEqualOrInside(stateDir, workspace) || isEqualOrInside(workspace, canonicalMirror)) {
    throw new Error('the repository mirror must be outside the workspace');
  }
  return { workspace, mirrorDir: canonicalMirror, stateDir };
}

/** Serializes syncs per key (mirror and workspace) within this process. */
const syncQueue = new Map<string, Promise<void>>();

async function withSyncLocks<T>(keys: readonly string[], action: () => Promise<T>): Promise<T> {
  const unique = [...new Set(keys)];
  const previous = unique.flatMap((key) => syncQueue.get(key) ?? []);
  let release: () => void = () => {};
  const held = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  // Registered synchronously, so a later caller always waits for this one.
  for (const key of unique) syncQueue.set(key, held);
  try {
    await Promise.all(previous);
    return await action();
  } finally {
    release();
    for (const key of unique) {
      if (syncQueue.get(key) === held) syncQueue.delete(key);
    }
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The ssh command git would use (inherited `GIT_SSH_COMMAND`, then the
 * trusted `core.sshCommand`, then `GIT_SSH`, then `ssh`), with options that
 * make it fail instead of prompting and bound connection setup and stalls.
 */
function batchSshCommand(env: NodeJS.ProcessEnv, trusted: TrustedGitConfig): string {
  let configured: string | undefined;
  for (const entry of trusted.entries) {
    if (entry.key === 'core.sshcommand' && entry.value !== null && entry.value.trim() !== '') configured = entry.value;
  }
  const inherited = env.GIT_SSH_COMMAND?.trim();
  const program = env.GIT_SSH?.trim();
  let base = 'ssh';
  if (inherited !== undefined && inherited !== '') base = inherited;
  else if (configured !== undefined) base = configured.trim();
  else if (program !== undefined && program !== '') base = shellQuote(program);
  return `${base} ${SSH_BATCH_OPTIONS}`;
}

function withoutProviderCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (/_API_KEY$/iu.test(name) || PROVIDER_CREDENTIAL_VARIABLES.has(name.toUpperCase())) continue;
    copy[name] = value;
  }
  return copy;
}

/** Environments for network steps (the URL's transport only) and local steps (no transport at all). */
function buildGitEnvironments(
  ctx: SyncContext,
  trusted: TrustedGitConfig,
): { readonly remote: NodeJS.ProcessEnv; readonly local: NodeJS.ProcessEnv } {
  // Every repository is named with --git-dir; the commands that take none
  // (`init`, `ls-remote`) run in the staging directory, and discovery from
  // there must not climb past the job directory.
  const ceilingDirectories = ctx.stateDir.includes(delimiter) ? [] : [ctx.stateDir];
  const remote = hardenedGitEnv({
    baseEnv: ctx.baseEnv,
    trustedConfig: trusted,
    allowedProtocols: [ctx.protocol],
    ceilingDirectories,
    sshCommand: batchSshCommand(ctx.baseEnv, trusted),
    extraConfig: [...SYNC_CONFIG, ...REMOTE_CONFIG],
  });
  const local = hardenedGitEnv({
    baseEnv: ctx.baseEnv,
    trustedConfig: trusted,
    allowedProtocols: [],
    ceilingDirectories,
    extraConfig: SYNC_CONFIG,
  });
  return { remote, local };
}

/** A branch name safe to place in refs, config keys and messages; git validates the rest. */
function isPlausibleBranchName(name: string): boolean {
  return (
    name !== '' &&
    name.length <= 255 &&
    !name.startsWith('-') &&
    !hasControlCharacter(name) &&
    !/[\s~^:?*[\\]/u.test(name) &&
    !name.includes('..') &&
    !name.includes('@{')
  );
}

function objectFormatOf(objectId: string): ObjectFormat {
  return objectId.length === 64 ? 'sha256' : 'sha1';
}

/** Leftovers of a crashed sync: git temporary objects and any alternates file. */
function isCopyableObjectPath(source: string): boolean {
  const name = basename(source);
  return name !== 'alternates' && !name.startsWith('tmp_') && !name.startsWith('.tmp-');
}

async function runSync(ctx: SyncContext): Promise<GitSyncResult> {
  await removeStaleStaging(ctx.stateDir);
  const staging = await mkdtemp(join(ctx.stateDir, STAGING_PREFIX));
  try {
    return await syncInStaging(ctx, staging);
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

async function removeStaleStaging(stateDir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(stateDir);
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_STAGING_MS;
  for (const name of names) {
    if (!name.startsWith(STAGING_PREFIX)) continue;
    const path = join(stateDir, name);
    const stats = await lstatOrUndefined(path).catch(() => undefined);
    if (stats?.isDirectory() === true && stats.mtimeMs < cutoff) {
      await rm(path, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function syncInStaging(ctx: SyncContext, staging: string): Promise<GitSyncResult> {
  const { uri, workspace, mirrorDir, timeouts, progress } = ctx;
  const displayUri = redactCredentials(uri);
  const warnings: string[] = [];

  progress.step = 'reading the trusted git configuration';
  const trusted = await readTrustedGitConfigAsync({ baseEnv: ctx.baseEnv, signal: ctx.signal });
  const envs = buildGitEnvironments(ctx, trusted);
  const git: GitRunner = (args, options = {}) =>
    runGit(args, {
      cwd: staging,
      env: options.env ?? envs.local,
      timeoutMs: options.timeoutMs ?? timeouts.localMs,
      maxOutputBytes: options.maxOutputBytes ?? 1024 * 1024,
      allowNonZeroExit: options.allowNonZeroExit,
      input: options.input,
      signal: ctx.signal,
    });

  progress.step = 'reading the repository mirror';
  const state = await readMirrorState(mirrorDir, git);
  const owned = state !== undefined && state.workspace === workspace;

  progress.step = 'checking the workspace';
  const workspaceEmpty = (await readdir(workspace)).length === 0;
  if (!owned && !ctx.managedWorkspace && !workspaceEmpty) {
    throw new Error(
      `workspace ${workspace} is not empty and was not populated by IronCurtain's git sync; ` +
        'empty it (move any .git and files elsewhere) or remove the job gitRepo',
    );
  }

  // Before fetching: what differs from the commit the previous sync checked out.
  let baseIndex: string | undefined;
  let discardedChanges: string | null = null;
  if (owned && state.synced !== undefined) {
    progress.step = 'computing the discarded changes';
    const indexFile = join(staging, 'base-index');
    const env = { ...envs.local, GIT_INDEX_FILE: indexFile, GIT_ATTR_SOURCE: state.synced };
    const tree = ['--git-dir', mirrorDir, '--work-tree', workspace];
    try {
      await git([...tree, 'read-tree', state.synced], { env });
      baseIndex = indexFile;
      discardedChanges = await summarizeWorkTreeChanges(git, tree, env, warnings);
    } catch (error) {
      if (ctx.signal?.aborted === true) throw error;
      warnings.push(displayMessage(`could not compute the discarded changes: ${errorMessage(error)}`));
    }
  } else if (!workspaceEmpty) {
    warnings.push(
      'no previous sync is recorded for this workspace: tracked files are reset without a discarded-changes report',
    );
  }

  progress.step = `querying ${displayUri}`;
  const remote = await queryRemoteHead(git, uri, envs.remote, timeouts.remoteQueryMs);
  const objectFormat = remote.objectFormat ?? state?.objectFormat ?? 'sha1';

  // The mirror is reused only for the same URL and object format; otherwise re-cloned.
  const reuseMirror = state !== undefined && state.url === uri && state.objectFormat === objectFormat;
  let fetchDir = mirrorDir;
  if (!reuseMirror) {
    progress.step = 'creating the repository mirror';
    fetchDir = join(staging, 'mirror.git');
    await git(['init', '--bare', '--quiet', '--template=', '--', fetchDir], {
      env: { ...envs.local, GIT_DEFAULT_HASH: objectFormat, GIT_DEFAULT_REF_FORMAT: 'files' },
    });
    await git(['--git-dir', fetchDir, 'config', STATE_URL_KEY, uri]);
  }

  progress.step = `fetching ${displayUri}`;
  await git(
    [
      '--git-dir',
      fetchDir,
      'fetch',
      '--quiet',
      '--prune',
      '--no-tags',
      '--no-recurse-submodules',
      '--',
      uri,
      '+refs/heads/*:refs/heads/*',
      '+refs/tags/*:refs/tags/*',
    ],
    { env: envs.remote, timeoutMs: reuseMirror ? timeouts.fetchMs : timeouts.initialFetchMs },
  );
  if (!reuseMirror) {
    progress.step = 'replacing the repository mirror';
    await rm(mirrorDir, { recursive: true, force: true });
    await rename(fetchDir, mirrorDir);
  }

  progress.step = 'resolving the default branch';
  const candidates = [remote.branch, reuseMirror ? state.branch : undefined, 'main', 'master'];
  let branch: string | undefined;
  let commit: string | undefined;
  for (const candidate of candidates) {
    if (candidate === undefined || !isPlausibleBranchName(candidate)) continue;
    const result = await git(
      ['--git-dir', mirrorDir, 'rev-parse', '--verify', '--quiet', `refs/heads/${candidate}^{commit}`],
      {
        allowNonZeroExit: true,
      },
    );
    const objectId = result.stdout.trim();
    if (result.exitCode === 0 && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(objectId)) {
      branch = candidate;
      commit = objectId;
      break;
    }
  }
  if (branch === undefined || commit === undefined) {
    throw new Error(`${displayUri} has no default branch to check out`);
  }

  // From here on the workspace is modified: record that this mirror owns it.
  progress.step = 'recording the workspace';
  await git(['--git-dir', mirrorDir, 'config', STATE_WORKSPACE_KEY, workspace]);

  progress.step = 'building the workspace repository';
  const stagedGitDir = await buildWorkspaceGitDir(git, ctx, staging, { branch, commit, objectFormat }, envs.local);

  progress.step = 'removing the previous workspace .git';
  await moveAsideWorkspaceGit(workspace, staging);

  progress.step = 'resetting the tracked files';
  // The previous checkout (when known and in the same object format) lets
  // the reset delete files the new commit no longer tracks.
  if (baseIndex !== undefined && state?.objectFormat === objectFormat) {
    await copyFile(baseIndex, join(stagedGitDir, 'index'));
  }
  await git(['--git-dir', stagedGitDir, '--work-tree', workspace, 'read-tree', '--reset', '-u', commit], {
    env: { ...envs.local, GIT_ATTR_SOURCE: commit },
  });

  progress.step = 'installing the workspace .git';
  await installWorkspaceGit(stagedGitDir, workspace);

  progress.step = 'recording the synced commit';
  await git(['--git-dir', mirrorDir, 'update-ref', SYNCED_REF, commit]);
  await git(['--git-dir', mirrorDir, 'config', STATE_BRANCH_KEY, branch]);

  return { ok: true, branch, commit, discardedChanges, warnings };
}

function capSummary(summary: string): string | null {
  if (summary === '') return null;
  return summary.length > MAX_DISCARDED_CHARS ? `${summary.slice(0, MAX_DISCARDED_CHARS)}\n[truncated]` : summary;
}

/**
 * Tracked-file changes in the work tree relative to the index (the previous
 * checkout): `git diff --stat`, or, when that cannot hash a file (a FIFO,
 * socket or unreadable file at a tracked path), the `--name-status` list,
 * which never reads such entries. Drivers are off and attributes come from
 * the caller's trusted `GIT_ATTR_SOURCE`.
 */
async function summarizeWorkTreeChanges(
  git: GitRunner,
  tree: readonly string[],
  env: NodeJS.ProcessEnv,
  warnings: string[],
): Promise<string | null> {
  const diff = [
    ...tree,
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--ignore-submodules=all',
    '--no-renames',
    '--no-color',
  ];
  try {
    const stat = await git([...diff, '--stat', `--stat-count=${MAX_DISCARDED_FILES}`], { env });
    return capSummary(stat.stdout.trim());
  } catch (error) {
    if (isGitTimeout(error) || errorCode(error) === 'GIT_ABORTED') throw error;
    warnings.push(displayMessage(`git diff --stat failed, reporting changed paths only: ${errorMessage(error)}`));
  }
  const names = await git([...diff, '--name-status'], { env });
  const lines = names.stdout.trim().split('\n');
  const listed =
    lines.length > MAX_DISCARDED_FILES
      ? [...lines.slice(0, MAX_DISCARDED_FILES), `... and ${lines.length - MAX_DISCARDED_FILES} more`]
      : lines;
  return capSummary(listed.join('\n').trim());
}

/** Reads the mirror's recorded state; undefined when there is no usable mirror (it is then re-created). */
async function readMirrorState(mirrorDir: string, git: GitRunner): Promise<MirrorState | undefined> {
  const stats = await lstatOrUndefined(mirrorDir);
  if (stats === undefined || !stats.isDirectory()) return undefined;
  const config = await git(
    ['--git-dir', mirrorDir, 'config', '-z', '--get-regexp', '^(ironcurtain\\.|extensions\\.objectformat$)'],
    { allowNonZeroExit: true },
  );
  // Exit 1 (no such key: not a mirror this module created) or any error: unusable, so it is re-created.
  if (config.exitCode !== 0) return undefined;
  const values = new Map<string, string>();
  for (const record of config.stdout.split('\0')) {
    const newline = record.indexOf('\n');
    if (newline > 0) values.set(record.slice(0, newline), record.slice(newline + 1));
  }
  const synced = await git(['--git-dir', mirrorDir, 'rev-parse', '--verify', '--quiet', `${SYNCED_REF}^{commit}`], {
    allowNonZeroExit: true,
  });
  const syncedId = synced.stdout.trim();
  return {
    url: values.get(STATE_URL_KEY),
    workspace: values.get(STATE_WORKSPACE_KEY),
    branch: values.get(STATE_BRANCH_KEY),
    objectFormat: values.get('extensions.objectformat') === 'sha256' ? 'sha256' : 'sha1',
    synced: synced.exitCode === 0 && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(syncedId) ? syncedId : undefined,
  };
}

/** The upstream's default branch (from the `HEAD` symref) and object format, as advertised. */
async function queryRemoteHead(
  git: GitRunner,
  uri: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ readonly branch: string | undefined; readonly objectFormat: ObjectFormat | undefined }> {
  const result = await git(['ls-remote', '--symref', '--', uri, 'HEAD'], { env, timeoutMs, maxOutputBytes: 64 * 1024 });
  let branch: string | undefined;
  let objectFormat: ObjectFormat | undefined;
  for (const line of result.stdout.split('\n')) {
    const symref = /^ref: refs\/heads\/(\S+)\tHEAD$/u.exec(line);
    if (symref !== null) {
      branch = symref[1];
      continue;
    }
    const advertised = /^([0-9a-f]{40}|[0-9a-f]{64})\tHEAD$/u.exec(line);
    if (advertised !== null) objectFormat = objectFormatOf(advertised[1]);
  }
  return { branch, objectFormat };
}

/**
 * Builds the agent's `.git` in the host-private staging directory: a
 * normal non-bare repository holding a copy of the mirror's objects, the
 * upstream branches as `origin/*`, its tags, the checked-out branch and an
 * `origin` remote pointing at the job URL without the credentials it may
 * embed ({@link stripUrlCredentials}): the agent can read everything here.
 * Every byte of it, config included, is written by IronCurtain. Returns its
 * path.
 */
async function buildWorkspaceGitDir(
  git: GitRunner,
  ctx: SyncContext,
  staging: string,
  target: { readonly branch: string; readonly commit: string; readonly objectFormat: ObjectFormat },
  localEnv: NodeJS.ProcessEnv,
): Promise<string> {
  const worktree = join(staging, 'worktree');
  const gitDir = join(worktree, '.git');
  await git(['init', '--quiet', '--template=', '--', worktree], {
    env: { ...localEnv, GIT_DEFAULT_HASH: target.objectFormat, GIT_DEFAULT_REF_FORMAT: 'files' },
  });
  // A copy (reflinked where the filesystem allows), never hard links: the
  // agent can rewrite its own .git, and that must not reach the mirror.
  await cp(join(ctx.mirrorDir, 'objects'), join(gitDir, 'objects'), {
    recursive: true,
    force: true,
    verbatimSymlinks: true,
    mode: fsConstants.COPYFILE_FICLONE,
    filter: isCopyableObjectPath,
  });

  const refs = await git(
    ['--git-dir', ctx.mirrorDir, 'for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads/', 'refs/tags/'],
    { maxOutputBytes: 64 * 1024 * 1024 },
  );
  const updates = [`create refs/heads/${target.branch} ${target.commit}`];
  for (const line of refs.stdout.split('\n')) {
    if (line === '') continue;
    const match = /^([0-9a-f]{40}|[0-9a-f]{64}) refs\/(heads|tags)\/(\S+)$/u.exec(line);
    if (match === null) throw new Error('unexpected ref listing from the repository mirror');
    const [, objectId, kind, name] = match;
    updates.push(`create ${kind === 'heads' ? 'refs/remotes/origin' : 'refs/tags'}/${name} ${objectId}`);
  }
  await git(['--git-dir', gitDir, 'update-ref', '--stdin'], { input: `${updates.join('\n')}\n` });
  await git(['--git-dir', gitDir, 'symbolic-ref', 'HEAD', `refs/heads/${target.branch}`]);
  await git(['--git-dir', gitDir, 'symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${target.branch}`]);
  const settings: readonly (readonly [string, string])[] = [
    ['remote.origin.url', stripUrlCredentials(ctx.uri)],
    ['remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
    [`branch.${target.branch}.remote`, 'origin'],
    [`branch.${target.branch}.merge`, `refs/heads/${target.branch}`],
  ];
  for (const [key, value] of settings) {
    await git(['--git-dir', gitDir, 'config', key, value]);
  }
  return gitDir;
}

/**
 * Takes the workspace `.git` (whatever kind of entry it is) out of the
 * workspace without following it: renamed into the staging directory,
 * which is deleted afterwards, or, on another filesystem, removed in place
 * (`rm` never follows symlinks).
 */
async function moveAsideWorkspaceGit(workspace: string, staging: string): Promise<void> {
  const entry = join(workspace, '.git');
  if ((await lstatOrUndefined(entry)) === undefined) return;
  try {
    await rename(entry, join(staging, 'previous-git'));
    return;
  } catch (error) {
    if (errorCode(error) !== 'EXDEV') throw error;
  }
  await rm(entry, { recursive: true, force: true });
}

/**
 * Moves the staged git directory to `<workspace>/.git`. A rename never
 * writes through an entry at the destination: if something reappeared
 * there, it fails instead. Across filesystems the directory is first copied
 * to a fresh, unpredictably named directory in the workspace.
 */
async function installWorkspaceGit(stagedGitDir: string, workspace: string): Promise<void> {
  const target = join(workspace, '.git');
  try {
    await rename(stagedGitDir, target);
    return;
  } catch (error) {
    if (errorCode(error) !== 'EXDEV') throw error;
  }
  const temporary = await mkdtemp(join(workspace, '.ironcurtain-git-'));
  try {
    const copy = join(temporary, 'git');
    await cp(stagedGitDir, copy, {
      recursive: true,
      force: false,
      errorOnExist: true,
      verbatimSymlinks: true,
      mode: fsConstants.COPYFILE_FICLONE,
    });
    await rename(copy, target);
  } finally {
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}
