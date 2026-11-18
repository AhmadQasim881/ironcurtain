/**
 * Where a git remote argument really connects, for the policy engine's domain
 * checks and, through the same resolver (`resolveUrlForDomainCheck`), for the
 * approval whitelist and the escalation prompt, which bind and show a remote
 * by its destination. Resolution happens in-process: git is never run in a
 * repository the agent can write, so a planted include (a FIFO, or a chain of
 * nested includes) cannot stall policy evaluation, and repository config is
 * only ever read, never executed.
 *
 * The git MCP server runs `git push|pull|fetch <remote>`, passing `origin`
 * when the remote is omitted. Git looks `<remote>` up among the configured
 * remotes first, whatever the argument looks like, and only otherwise treats
 * it as a URL; every URL then goes through `url.<base>.insteadOf`, and a push
 * goes to `remote.<name>.pushurl` (or a `url.<base>.pushInsteadOf` rewrite)
 * when one is set. This module reproduces those rules from two sources:
 *
 * - The repository's own `.git/config`, read only when the repository path
 *   resolves inside the sandbox. Reads are no-follow, non-blocking and
 *   size-capped, and the file's identity is re-checked after the read, so a
 *   parent directory swapped for a symlink cannot redirect the read outside
 *   the sandbox. Layouts whose effective config git would assemble from
 *   elsewhere are refused rather than emulated: a symlinked `.git`, gitfiles,
 *   `commondir`, per-worktree config, implicit bare repositories, `include` /
 *   `includeIf`, syntax errors, and legacy `remotes/` or `branches/` entries.
 *   A `.git` directory counts only when git itself would accept it (see
 *   isCompleteGitDirectory); otherwise git walks on to an outer repository.
 *   A remote with more than 64 URLs, or more than 1024 URL rewrites in all,
 *   is refused, so the cost of an evaluation stays bounded.
 * - The user's trusted system and global config (`url.*` rewrites and
 *   `remote.*.url`/`pushurl`), read with `git config` from `/` (never inside a
 *   repository) once per environment and cached.
 *
 * Every URL either side of the remote could contact (fetch URLs and push
 * URLs) is returned, so callers require all of them to pass. Repository
 * config that changes where the remote connects (a push URL for it, URL
 * rewrites, proxies, TLS trust overrides, ssh or proxy commands, a remote
 * helper) is still applied, so callers can name the destination, but it is
 * also reported in `overrides` and callers escalate rather than trust this
 * emulation.
 *
 * A remote argument that is not a configured remote and names a local
 * repository (an absolute path, a `~` path or a `file://` URL; see
 * {@link parseLocalGitSource}) is a filesystem read, not a network
 * destination: git clones, fetches and pulls from that directory with the
 * `file` transport. Such a value is returned as the one URL git would use, so
 * the policy engine can evaluate the path it names as a read (protected paths,
 * sandbox containment, compiled read-path rules) instead of judging it as a
 * domain. Git drops the host of a `file://` URL (`file://github.com/srv/repo`
 * reads `/srv/repo`), so the host never counts as a destination.
 *
 * Residual risk: the agent can rewrite an in-sandbox `.git/config` between
 * this evaluation and the git server's own read of it. Conditional includes in
 * the user's global config (`includeIf "gitdir:..."`) are not evaluated.
 */

import {
  accessSync,
  constants as fsConstants,
  lstatSync,
  readlinkSync,
  realpathSync,
  statSync,
  type Stats,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

import {
  readIdentifiedUntrustedRegularFile,
  readUntrustedRegularFile,
  type UntrustedFileIdentity,
} from '../hardened-fs.js';
import {
  classifyGitConfigEntry,
  parseGitConfigBytes,
  readTrustedGitConfigEntries,
  type GitConfigEntry,
  type TrustedGitConfigEntry,
} from '../security/git-hardening.js';
import { resolveRealPath } from '../types/argument-roles.js';

/** The remote the git MCP server pushes to, pulls from and fetches from when none is given. */
export const DEFAULT_GIT_REMOTE = 'origin';

/** The user's trusted (system and global) config entries that decide where a remote connects. */
export interface TrustedGitRemoteConfig {
  /** `remote.*.url`/`pushurl` and `url.*.insteadof`/`pushinsteadof` entries, in the order git reads them. */
  readonly entries: readonly GitConfigEntry[];
}

export interface GitRemoteResolutionOptions {
  /** The sandbox root. Repository config is read only from repositories inside it. */
  readonly allowedDirectory?: string;
  /**
   * Supplies the trusted config snapshot; returns undefined when it cannot be
   * read. Default: a cached `git config` read from `/`. Tests inject one.
   */
  readonly loadTrustedConfig?: () => TrustedGitRemoteConfig | undefined;
}

export type GitRemoteUrlResolution =
  | {
      readonly ok: true;
      /** Every URL git could contact for this remote, fetch and push side, after rewriting. */
      readonly urls: readonly string[];
      /**
       * Repository-config keys (subsections elided, e.g. `remote.*.pushurl`)
       * that change where the remote connects. Non-empty means the caller must
       * not treat the URLs as verified.
       */
      readonly overrides: readonly string[];
    }
  | { readonly ok: false; readonly reason: string };

const MAX_CONFIG_BYTES = 1024 * 1024;
/**
 * Upper bounds on what one resolution examines, so a config of the maximum
 * size cannot make the (synchronous) evaluation slow: every URL is matched
 * against every rewrite prefix. Real remotes have one to three URLs and real
 * configs a handful of rewrites; exceeding either bound is unverifiable.
 */
const MAX_REMOTE_URLS = 64;
const MAX_URL_REWRITE_PREFIXES = 1024;
/** git's validate_headref() reads at most this much of HEAD. */
const MAX_HEAD_BYTES = 255;
const TRUSTED_REMOTE_KEY_PATTERN = '^(remote\\..+\\.(url|pushurl)|url\\..+\\.(insteadof|pushinsteadof))$';
/** How long a failed trusted-config read is remembered before it is retried. */
const TRUSTED_CONFIG_FAILURE_RETRY_MS = 10_000;

type RepositoryContext =
  /** No repository the agent controls could be identified (no path, outside the sandbox, nothing found). */
  | { readonly kind: 'unavailable'; readonly reason: string }
  /** A repository inside the sandbox whose effective config cannot be read faithfully. */
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'found'; readonly gitDir: string; readonly entries: readonly GitConfigEntry[] };

function fail(reason: string): GitRemoteUrlResolution {
  return { ok: false, reason };
}

function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

/** A directory git's `access(X_OK)` check would accept (follows symlinks like git does). */
function isSearchableDirectory(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) return false;
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** git's validate_headref(): a `refs/...` symlink, a `ref: refs/...` symref, or an object id. */
function isValidHead(path: string): boolean {
  const stats = lstatOrUndefined(path);
  if (stats === undefined) return false;
  try {
    if (stats.isSymbolicLink()) return readlinkSync(path).startsWith('refs/');
    if (!stats.isFile()) return false;
    const text = readUntrustedRegularFile(path, { maxBytes: MAX_HEAD_BYTES, oversize: 'truncate' }).bytes.toString(
      'latin1',
    );
    // git's own isspace() (sane_ctype: space, \t, \n, \r; not \v or \f, and not \s).
    // Accepting more than git would make us read a git dir that git skips on its
    // way up to an outer repository with a different remote.
    return /^ref:[ \t\n\r]*refs\//u.test(text) || /^[0-9a-fA-F]{40}/u.test(text);
  } catch {
    return false;
  }
}

/** git's is_git_directory() for a directory without `commondir`: valid HEAD, searchable objects/ and refs/. */
function isCompleteGitDirectory(gitDir: string): boolean {
  return (
    isValidHead(join(gitDir, 'HEAD')) &&
    isSearchableDirectory(join(gitDir, 'objects')) &&
    isSearchableDirectory(join(gitDir, 'refs'))
  );
}

/** True when `path` still resolves to itself and names the file that was read. */
function isSameFileStill(path: string, root: string, identity: UntrustedFileIdentity): boolean {
  try {
    if (realpathSync(path) !== path || !isInside(path, root)) return false;
    const stats = lstatSync(path);
    return stats.dev === identity.dev && stats.ino === identity.ino;
  } catch {
    return false;
  }
}

function readRepositoryConfig(gitDir: string, root: string): RepositoryContext {
  if (lstatOrUndefined(join(gitDir, 'commondir')) !== undefined) {
    return { kind: 'refused', reason: 'the repository is a linked worktree (commondir)' };
  }
  if (lstatOrUndefined(join(gitDir, 'config.worktree')) !== undefined) {
    return { kind: 'refused', reason: 'the repository has per-worktree config' };
  }
  if (!isCompleteGitDirectory(gitDir)) {
    return { kind: 'refused', reason: '.git is not a complete git directory' };
  }
  const configPath = join(gitDir, 'config');
  if (lstatOrUndefined(configPath) === undefined) return { kind: 'found', gitDir, entries: [] };
  let contents;
  try {
    contents = readIdentifiedUntrustedRegularFile(configPath, { maxBytes: MAX_CONFIG_BYTES });
  } catch {
    return { kind: 'refused', reason: 'the repository config is not a regular file of a readable size' };
  }
  if (!isSameFileStill(configPath, root, contents.identity)) {
    return { kind: 'refused', reason: 'the repository config changed while it was read' };
  }
  const parsed = parseGitConfigBytes(contents.bytes);
  if (parsed.syntaxErrorLine !== undefined) {
    return { kind: 'refused', reason: 'the repository config has a syntax error' };
  }
  if (parsed.entries.some((entry) => classifyGitConfigEntry(entry) === 'include')) {
    return { kind: 'refused', reason: 'the repository config uses include or includeIf' };
  }
  return { kind: 'found', gitDir, entries: parsed.entries };
}

/**
 * Find the repository git would use for a command run in `pathArg`, provided
 * it lies inside the sandbox, and read its config. Containment is checked on
 * the symlink-resolved path before anything below it is touched, and repository
 * discovery stops at the sandbox root.
 */
function loadSandboxRepository(pathArg: unknown, allowedDirectory: string | undefined): RepositoryContext {
  if (typeof pathArg !== 'string' || pathArg === '') {
    return { kind: 'unavailable', reason: 'no repository path was given' };
  }
  if (!isAbsolute(pathArg)) return { kind: 'unavailable', reason: 'the repository path is not absolute' };
  if (allowedDirectory === undefined) return { kind: 'unavailable', reason: 'no sandbox directory is configured' };
  let root: string;
  try {
    root = realpathSync(allowedDirectory);
  } catch {
    return { kind: 'unavailable', reason: 'the sandbox directory does not exist' };
  }
  if (!isInside(resolveRealPath(pathArg), root)) {
    return { kind: 'unavailable', reason: 'the repository path is outside the sandbox' };
  }
  let start: string;
  try {
    start = realpathSync(pathArg);
  } catch {
    return { kind: 'unavailable', reason: 'the repository path does not exist' };
  }
  if (!isInside(start, root)) return { kind: 'unavailable', reason: 'the repository path is outside the sandbox' };
  if (!isSearchableDirectory(start)) return { kind: 'unavailable', reason: 'the repository path is not a directory' };

  // Mirror git's discovery (setup.c): at each level `.git` first, then the
  // directory itself as an implicit bare repository, then the parent.
  for (let dir = start; ; dir = dirname(dir)) {
    const dotGit = join(dir, '.git');
    const stats = lstatOrUndefined(dotGit);
    if (stats !== undefined) {
      if (stats.isSymbolicLink()) return { kind: 'refused', reason: '.git is a symbolic link' };
      if (!stats.isDirectory()) return { kind: 'refused', reason: '.git is a gitfile or a special file' };
      return readRepositoryConfig(dotGit, root);
    }
    // Git needs a valid HEAD to treat a directory as a bare repository, so a
    // directory without any HEAD entry can never be one.
    if (lstatOrUndefined(join(dir, 'HEAD')) !== undefined) {
      return { kind: 'refused', reason: 'a directory on the repository path looks like a bare repository' };
    }
    if (dir === root || dirname(dir) === dir) {
      return { kind: 'unavailable', reason: 'no git repository was found inside the sandbox' };
    }
  }
}

// ── Trusted config snapshot ────────────────────────────────────────────

function toConfigEntry(entry: TrustedGitConfigEntry): GitConfigEntry {
  const first = entry.key.indexOf('.');
  const last = entry.key.lastIndexOf('.');
  return {
    section: entry.key.slice(0, first),
    subsection: last > first ? entry.key.slice(first + 1, last) : undefined,
    name: entry.key.slice(last + 1),
    key: entry.key,
    value: entry.value,
    line: 0,
  };
}

let trustedConfigCache:
  { readonly key: string; readonly value: TrustedGitRemoteConfig | undefined; readonly expiresAt: number } | undefined;

/**
 * The trusted snapshot for the current environment. Read once and kept while
 * the variables that select git's config files are unchanged; a failed read is
 * retried after a short delay.
 */
function loadCachedTrustedConfig(): TrustedGitRemoteConfig | undefined {
  const env = process.env;
  const key = JSON.stringify([
    env.HOME,
    env.XDG_CONFIG_HOME,
    env.GIT_CONFIG_GLOBAL,
    env.GIT_CONFIG_SYSTEM,
    env.GIT_CONFIG_NOSYSTEM,
    env.PATH,
  ]);
  const now = Date.now();
  if (trustedConfigCache !== undefined && trustedConfigCache.key === key && now < trustedConfigCache.expiresAt) {
    return trustedConfigCache.value;
  }
  const read = readTrustedGitConfigEntries(TRUSTED_REMOTE_KEY_PATTERN);
  const value = read.ok ? { entries: read.entries.map(toConfigEntry) } : undefined;
  trustedConfigCache = {
    key,
    value,
    expiresAt: read.ok ? Number.POSITIVE_INFINITY : now + TRUSTED_CONFIG_FAILURE_RETRY_MS,
  };
  return value;
}

// ── Remote and URL rules ───────────────────────────────────────────────

interface UrlRewrite {
  readonly base: string;
  readonly prefixes: readonly string[];
}

/** git's rewrite tables: one per `url.<base>`, in order of first appearance. Undefined if an entry has no value. */
function collectRewrites(
  entries: readonly GitConfigEntry[],
  name: 'insteadof' | 'pushinsteadof',
): UrlRewrite[] | undefined {
  const byBase = new Map<string, string[]>();
  for (const entry of entries) {
    if (entry.section !== 'url' || entry.subsection === undefined || entry.name !== name) continue;
    if (entry.value === null) return undefined;
    const prefixes = byBase.get(entry.subsection) ?? [];
    prefixes.push(entry.value);
    byBase.set(entry.subsection, prefixes);
  }
  return [...byBase].map(([base, prefixes]) => ({ base, prefixes }));
}

/** git's alias_url(): the longest matching prefix wins, the earliest on a tie. */
function rewriteUrl(url: string, rewrites: readonly UrlRewrite[]): string | undefined {
  let best: { readonly base: string; readonly length: number } | undefined;
  for (const rewrite of rewrites) {
    for (const prefix of rewrite.prefixes) {
      if (url.startsWith(prefix) && (best === undefined || best.length < prefix.length)) {
        best = { base: rewrite.base, length: prefix.length };
      }
    }
  }
  return best === undefined ? undefined : best.base + url.slice(best.length);
}

/** Whether git treats an unconfigured remote argument as a URL (`scheme://` or scp-like) rather than a path. */
function isUrlShaped(value: string): boolean {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value)) return true;
  const colon = value.indexOf(':');
  if (colon < 0) return false;
  const slash = value.indexOf('/');
  return slash < 0 || slash > colon;
}

/**
 * An absolute or `~` path given where git expects a remote: git reads it over
 * the `file` transport (it does not expand `~` itself; the policy engine
 * expands it the way it expands every path argument). Relative paths are not
 * recognized: they resolve against the git server's own working directory,
 * which the policy cannot know, and stay unverifiable.
 */
function isLocalPathShaped(value: string): boolean {
  return value.startsWith('/') || value === '~' || value.startsWith('~/');
}

/** git's url_decode(): every `%XX` except `%00`, left to right, never re-decoded. */
export function percentDecodeLikeGit(text: string): string {
  return text.replace(/%([0-9A-Fa-f]{2})/gu, (match, hex: string) => {
    const code = Number.parseInt(hex, 16);
    return code === 0 ? match : String.fromCharCode(code);
  });
}

/** Where a local git source argument points, before canonicalization. */
export type LocalGitSource =
  /** A filesystem path (absolute, or `~`-relative as the policy expands it), as git would open it. */
  | { readonly kind: 'path'; readonly path: string }
  /** A local source whose path cannot be established safely; callers deny it. */
  | { readonly kind: 'unresolvable'; readonly reason: string };

// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

/**
 * Recognizes a git remote argument that names a local repository, and returns
 * the filesystem path git would read, or undefined for anything else (network
 * URLs, remote names, relative paths, remote helpers).
 *
 * - An absolute path or a `~` path is returned as is ({@link isLocalPathShaped}).
 * - A `file://` URL (lowercase, as git matches it; `FILE://` goes to a remote
 *   helper) is percent-decoded in full first, as git's url_decode does, and
 *   its host is dropped: git takes the path from the first `/` after the
 *   authority, so `file://github.com/srv/repo` and `file:///srv/repo` both
 *   read `/srv/repo`. A URL with no path (`file://host`) is unresolvable.
 * - A `%00` (the one escape git leaves undecoded) or a control character in
 *   the decoded path makes the source unresolvable: neither belongs in a
 *   repository path, so the call is refused rather than evaluated on a
 *   spelling this parser and git might read differently.
 *
 * The value must be in the spelling git receives: callers apply the
 * `git-remote-url` canonicalization first (`FILE://` becomes `file://`).
 */
export function parseLocalGitSource(value: string): LocalGitSource | undefined {
  if (isLocalPathShaped(value)) return { kind: 'path', path: value };
  if (!value.startsWith('file://')) return undefined;
  const rest = value.slice('file://'.length);
  if (/%00/u.test(rest)) return { kind: 'unresolvable', reason: 'the file URL contains an encoded NUL byte' };
  const decoded = percentDecodeLikeGit(rest);
  const slash = decoded.indexOf('/');
  if (slash < 0) return { kind: 'unresolvable', reason: 'the file URL has no path' };
  const path = decoded.slice(slash);
  if (CONTROL_CHARACTERS.test(path)) {
    return { kind: 'unresolvable', reason: 'the file URL path contains control characters' };
  }
  return { kind: 'path', path };
}

/** git's valid_remote_nick(): names for which legacy `remotes/` and `branches/` files are consulted. */
function isRemoteNickname(value: string): boolean {
  return value !== '' && value !== '.' && value !== '..' && !value.includes('/');
}

function describeKey(entry: GitConfigEntry): string {
  return entry.subsection === undefined ? `${entry.section}.${entry.name}` : `${entry.section}.*.${entry.name}`;
}

/** Repository-config entries that change where `remoteName` connects or how the connection is made. */
function repositoryOverrides(local: readonly GitConfigEntry[], remoteName: string): string[] {
  const found = new Set<string>();
  for (const entry of local) {
    const forThisRemote =
      entry.section === 'remote' &&
      entry.subsection === remoteName &&
      (entry.name === 'pushurl' || entry.name === 'vcs');
    const transportCommand =
      entry.section === 'core' &&
      entry.subsection === undefined &&
      (entry.name === 'sshcommand' || entry.name === 'gitproxy');
    if (forThisRemote || transportCommand || classifyGitConfigEntry(entry) === 'network') {
      found.add(describeKey(entry));
    }
  }
  return [...found];
}

/**
 * Resolve a git remote argument (a remote name or a URL) to every URL git
 * could contact for it, as described in the module comment. `args.path` is
 * the repository path the command runs in.
 *
 * A named remote resolves only from a repository inside the sandbox; anything
 * else (no path, a path outside the sandbox, no repository, a refused layout,
 * an unconfigured name) is `ok: false`, and nothing below an out-of-sandbox
 * path is ever read. A URL argument, or an absolute or `~` path (a local
 * repository git reads over the `file` transport), outside any sandbox
 * repository is taken at face value, subject to the user's trusted rewrites.
 */
export function resolveGitRemoteUrls(
  value: string,
  args: Record<string, unknown>,
  options: GitRemoteResolutionOptions = {},
): GitRemoteUrlResolution {
  if (value === '') return fail('the remote is empty');
  if (CONTROL_CHARACTERS.test(value)) return fail('the remote contains control characters');
  if (value.startsWith('-')) return fail('the remote looks like a command-line option');

  // A value git would take as a URL or a local path when no remote has that
  // name; a remote name must be configured in a readable sandbox repository.
  const standsAlone = isUrlShaped(value) || isLocalPathShaped(value);
  const repository = loadSandboxRepository(args.path, options.allowedDirectory);
  if (repository.kind === 'refused') return fail(repository.reason);
  if (repository.kind === 'unavailable' && !standsAlone) return fail(repository.reason);

  const trusted = (options.loadTrustedConfig ?? loadCachedTrustedConfig)();
  if (trusted === undefined) return fail("the user's git configuration could not be read");
  const local = repository.kind === 'found' ? repository.entries : [];
  const entries = [...trusted.entries, ...local];

  const urls: string[] = [];
  const pushUrls: string[] = [];
  for (const entry of entries) {
    if (entry.section !== 'remote' || entry.subsection !== value) continue;
    if (entry.name !== 'url' && entry.name !== 'pushurl') continue;
    if (entry.value === null) return fail('the remote has a URL entry without a value');
    (entry.name === 'url' ? urls : pushUrls).push(entry.value);
    if (urls.length + pushUrls.length > MAX_REMOTE_URLS) return fail('the remote has too many URLs');
  }
  if (urls.length === 0) {
    // Git uses a remote only when it has a URL; otherwise it consults legacy
    // files and then takes the argument itself as the URL.
    if (repository.kind === 'found' && isRemoteNickname(value)) {
      const legacy = [join(repository.gitDir, 'remotes', value), join(repository.gitDir, 'branches', value)];
      if (legacy.some((path) => lstatOrUndefined(path) !== undefined)) {
        return fail('the repository defines the remote in a legacy remotes/ or branches/ file');
      }
    }
    if (!standsAlone) return fail('the remote is not configured in the repository');
    urls.push(value);
  }

  const insteadOf = collectRewrites(entries, 'insteadof');
  const pushInsteadOf = collectRewrites(entries, 'pushinsteadof');
  if (insteadOf === undefined || pushInsteadOf === undefined) return fail('a URL rewrite has no value');
  const prefixCount = [...insteadOf, ...pushInsteadOf].reduce((sum, rewrite) => sum + rewrite.prefixes.length, 0);
  if (prefixCount > MAX_URL_REWRITE_PREFIXES) return fail('the configuration has too many URL rewrites');

  // The union of both sides: fetches use the first URL, pushes every push URL
  // (or every URL, or its pushInsteadOf rewrite when no push URL is set).
  const destinations = new Set<string>();
  for (const url of urls) {
    destinations.add(rewriteUrl(url, insteadOf) ?? url);
    const pushAlias = rewriteUrl(url, pushInsteadOf);
    if (pushAlias !== undefined) destinations.add(pushAlias);
  }
  for (const url of pushUrls) destinations.add(rewriteUrl(url, insteadOf) ?? url);

  return { ok: true, urls: [...destinations], overrides: repositoryOverrides(local, value) };
}
