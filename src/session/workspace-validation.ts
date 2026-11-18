/**
 * Workspace path validation for user-selected agent workspaces.
 *
 * Every entry point that lets a user choose the directory an agent works in
 * funnels that choice through validateWorkspacePath(): `start -w`, the mux
 * workspace picker, daemon cron jobs, session resume (`start --resume` and
 * PTY resume), and the workflow entry points (`workflow start|run
 * --workspace`, the `workflows.start` RPC and
 * WorkflowOrchestrator.start()/resume()).
 *
 * The validated directory replaces the session sandbox as the agent's
 * allowedDirectory and, in Docker Agent Mode, is bind-mounted read-write at
 * /workspace. Nothing protects the files inside it: the PolicyEngine exempts
 * the allowedDirectory from its protected-path check, and files reached
 * through the bind mount never pass through the PolicyEngine at all. A
 * workspace must therefore stay clear of IronCurtain's trusted state in BOTH
 * directions:
 *
 * - It must not be, or lie inside, the IronCurtain home (apart from the
 *   managed workspaces in MANAGED_WORKSPACE_PATTERNS), the package
 *   configuration directory, the MCP relays' private scratch root
 *   (`<os.tmpdir()>/ironcurtain-<uid>`, see trusted-process/spawn-cwd.ts), or
 *   any protected path.
 * - It must not be, or contain, the user's home directory (so `/`, `/home`
 *   and `/Users` are rejected too), the IronCurtain home, the user config
 *   file, the package configuration directory (constitution, mcp-servers.json,
 *   compiled policies), the private scratch root (so on Linux `/tmp` is
 *   rejected), or any protected path other than the entries loadConfig()
 *   derives from the process working directory (a relative AUDIT_LOG_PATH,
 *   by default `<cwd>/audit.jsonl`). Those lie inside every `-w .` workspace
 *   by construction, so they are handled where they are produced and read
 *   instead of here. A credential file is never exempt: a `.env` in the
 *   launch directory is protected only when it is the explicit `--env-file`,
 *   and then a workspace containing it is rejected.
 * - A protected entry is checked at its original name and current target,
 *   including missing targets. No workspace may contain any controlling link
 *   on the way to it (resolvePathLinkChain):
 *   otherwise the agent could create the file, or replace the link, through
 *   which the next host run reads the protected name.
 *
 * Containment is decided by file identity, not spelling. Every existing entry
 * on the candidate's canonical path and on each forbidden root's canonical
 * path is compared by (st_dev, st_ino), so a symlink to a forbidden directory,
 * or a case or Unicode variant of it on a case- or normalization-insensitive
 * volume, is caught. An entry that does not exist (or cannot be stat'ed) is
 * compared by its case- and Unicode-folded spelling instead. Both comparisons
 * are deny-side, so a spurious match can only reject. The managed-workspace
 * exemption is an allowlist: it is matched by exact spelling, relative to the
 * directory that matched the IronCurtain home by identity.
 *
 * A directory can also enclose a forbidden root without lying on its
 * canonical path, when the root's volume is reachable a second time under
 * another prefix. macOS does this for every firmlinked location (`/Users`,
 * `/private`, `/usr/local`, `/opt`, ...): the Data volume is also mounted at
 * `/System/Volumes/Data`, so `/System/Volumes/Data`, `/System/Volumes` and
 * `/System` all contain the home directory. The ancestors of such a verified
 * alias count as enclosing the root too (see VOLUME_ALIAS_PREFIXES).
 */

import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { expandTilde, resolvePathLinkChain, resolveRealPath } from '../types/argument-roles.js';
import { getIronCurtainHome, getPackageConfigDir, getUserConfigPath } from '../config/paths.js';
import { getCwdDerivedProtectedPaths } from '../config/index.js';
import { foldPathForDenylist } from '../security/path-fold.js';
import { getPrivateScratchRoot } from '../trusted-process/spawn-cwd.js';

/** How rejections name the MCP relays' private scratch root. */
const SCRATCH_ROOT_DESCRIPTION = "the private scratch directory of IronCurtain's MCP servers";

/**
 * Returns true when `child` is equal to or nested inside `parent`, by plain
 * string comparison of canonical paths. validateWorkspacePath() itself
 * compares by file identity; see the module comment.
 */
export function isEqualOrInside(child: string, parent: string): boolean {
  if (child === parent) return true;
  const prefix = parent === '/' ? '/' : parent + '/';
  return child.startsWith(prefix);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Stable reasons a workspace path is rejected. */
export type WorkspaceValidationErrorCode =
  /** The path is empty, does not exist, or cannot be resolved. */
  | 'WORKSPACE_NOT_FOUND'
  /** The path exists but is not a directory. */
  | 'WORKSPACE_NOT_DIRECTORY'
  /** The directory overlaps the home directory or IronCurtain's trusted state. */
  | 'WORKSPACE_UNSAFE';

/**
 * Raised by validateWorkspacePath(). The `code` discriminant lets callers in
 * other layers map the failure (for example to an RPC `INVALID_PARAMS`
 * error) without relying on `instanceof` across module boundaries.
 */
export class WorkspaceValidationError extends Error {
  constructor(
    readonly code: WorkspaceValidationErrorCode,
    message: string,
    /** Absolute form of the rejected path (canonical once it resolves). */
    readonly path: string,
  ) {
    super(message);
    this.name = 'WorkspaceValidationError';
  }
}

export function isWorkspaceValidationError(err: unknown): err is WorkspaceValidationError {
  if (err instanceof WorkspaceValidationError) return true;
  if (err === null || typeof err !== 'object' || !('code' in err)) return false;
  return (
    err.code === 'WORKSPACE_NOT_FOUND' || err.code === 'WORKSPACE_NOT_DIRECTORY' || err.code === 'WORKSPACE_UNSAFE'
  );
}

// ---------------------------------------------------------------------------
// File identity
// ---------------------------------------------------------------------------

/** Physical identity of an existing filesystem object. */
interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

/** One entry on a canonical path, with its identity when it can be stat'ed. */
interface PathEntry {
  readonly path: string;
  readonly identity: FileIdentity | undefined;
}

function identityOf(path: string): FileIdentity | undefined {
  try {
    const stats = statSync(path, { bigint: true });
    return { dev: stats.dev, ino: stats.ino };
  } catch {
    return undefined;
  }
}

function entryOf(path: string): PathEntry {
  return { path, identity: identityOf(path) };
}

/** The ancestors of the absolute path `path`, innermost first, ending at `/`. */
function ancestorEntries(path: string): PathEntry[] {
  const ancestors: PathEntry[] = [];
  let current = path;
  for (let parent = dirname(current); parent !== current; parent = dirname(current)) {
    ancestors.push(entryOf(parent));
    current = parent;
  }
  return ancestors;
}

function isSameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * Deny-side equality: the same (st_dev, st_ino) when both entries exist,
 * otherwise the same folded spelling.
 */
function isSameEntry(a: PathEntry, b: PathEntry): boolean {
  if (a.identity && b.identity) return isSameIdentity(a.identity, b.identity);
  return foldPathForDenylist(a.path) === foldPathForDenylist(b.path);
}

/** resolveRealPath() with a lexical fallback, so a broken entry still yields a comparable path. */
function canonicalizeBestEffort(rawPath: string): string {
  try {
    return resolveRealPath(rawPath);
  } catch {
    return resolve(expandTilde(rawPath));
  }
}

/** A canonical path together with its ancestors, each with its identity. */
interface PathChain {
  readonly self: PathEntry;
  /** Ancestors of `self`, innermost first. */
  readonly ancestors: readonly PathEntry[];
  /**
   * Further directories that enclose `self` without lying on its canonical
   * path: the ancestors of `self` spelled through a verified volume alias
   * (see VOLUME_ALIAS_PREFIXES). Empty for most paths.
   */
  readonly aliasAncestors: readonly PathEntry[];
}

function chainOf(canonicalPath: string): PathChain {
  return { self: entryOf(canonicalPath), ancestors: ancestorEntries(canonicalPath), aliasAncestors: [] };
}

/**
 * Prefixes under which a whole volume is reachable a second time. On macOS
 * 10.15+ every firmlinked directory of the Data volume (`/Users`, `/private`,
 * `/usr/local`, `/opt`, `/Volumes`, ...) is also reachable below
 * `/System/Volumes/Data`, a path that is not on its canonical chain.
 */
const VOLUME_ALIAS_PREFIXES: readonly string[] = ['/System/Volumes/Data'];

/**
 * The ancestors of `chain.self` spelled through each volume alias that
 * provably reaches the same directory: the alias spelling of the chain's
 * deepest existing entry must have that entry's (st_dev, st_ino). Nothing is
 * added where the alias does not exist (any non-macOS host) or reaches
 * something else, so this can only make the enclosing check reject more.
 */
function volumeAliasAncestors(chain: PathChain): PathEntry[] {
  const anchor = [chain.self, ...chain.ancestors].find((entry) => entry.identity !== undefined && entry.path !== '/');
  if (anchor?.identity === undefined) return [];
  const aliasAncestors: PathEntry[] = [];
  for (const prefix of VOLUME_ALIAS_PREFIXES) {
    if (anchor.path === prefix || anchor.path.startsWith(`${prefix}/`)) continue;
    const aliasIdentity = identityOf(prefix + anchor.path);
    if (aliasIdentity === undefined || !isSameIdentity(aliasIdentity, anchor.identity)) continue;
    aliasAncestors.push(...ancestorEntries(prefix + chain.self.path));
  }
  return aliasAncestors;
}

function forbiddenRoot(rawPath: string): PathChain {
  return forbiddenCanonicalRoot(canonicalizeBestEffort(rawPath));
}

function forbiddenCanonicalRoot(canonicalPath: string): PathChain {
  const chain = chainOf(canonicalPath);
  return { ...chain, aliasAncestors: volumeAliasAncestors(chain) };
}

/**
 * Where `candidate` enters `root`: the innermost entry of the candidate
 * chain (itself or an ancestor) that is `root`, or undefined when the
 * candidate is not inside `root`. Taking the innermost match means a bind
 * mount that re-exposes `root` further down cannot borrow an outer match.
 */
function entryPointInto(candidate: PathChain, root: PathChain): PathEntry | undefined {
  if (isSameEntry(candidate.self, root.self)) return candidate.self;
  return candidate.ancestors.find((entry) => isSameEntry(entry, root.self));
}

/**
 * True when `entry` is `root` itself or one of its ancestors (including the
 * ancestors of a verified volume alias of `root`), i.e. it encloses `root`.
 */
function encloses(entry: PathEntry, root: PathChain): boolean {
  return (
    isSameEntry(entry, root.self) ||
    root.ancestors.some((ancestor) => isSameEntry(ancestor, entry)) ||
    root.aliasAncestors.some((ancestor) => isSameEntry(ancestor, entry))
  );
}

// ---------------------------------------------------------------------------
// Managed workspaces inside the IronCurtain home
// ---------------------------------------------------------------------------

/**
 * Managed directories inside the IronCurtain home that may be used as a
 * workspace, as paths relative to the home:
 *   - personas/{name}/workspace[/...]
 *   - sessions/{id}/sandbox[/...]
 *   - workflow-runs/{id}/workspace[/...]  (a workflow run's default workspace)
 *   - jobs/{id}/workspace[/...]           (a cron job's default workspace,
 *                                           recorded by its sessions for resume)
 * Each sits next to, never above, its owner's trusted state (policies,
 * escalations, job definitions). This is an allowlist, so it is matched by
 * exact spelling and never folded.
 */
const MANAGED_WORKSPACE_PATTERNS: readonly RegExp[] = [
  /^personas\/[^/]+\/workspace(?:\/.*)?$/,
  /^sessions\/[^/]+\/sandbox(?:\/.*)?$/,
  /^workflow-runs\/[^/]+\/workspace(?:\/.*)?$/,
  /^jobs\/[^/]+\/workspace(?:\/.*)?$/,
];

/** The part of `path` below its ancestor-or-self `ancestor`, without a leading slash. */
function pathBelow(path: string, ancestor: string): string {
  if (path === ancestor) return '';
  return path.slice(ancestor === '/' ? 1 : ancestor.length + 1);
}

function isManagedWorkspace(relativeToHome: string): boolean {
  return MANAGED_WORKSPACE_PATTERNS.some((pattern) => pattern.test(relativeToHome));
}

/**
 * Protected entries that loadConfig() derives from the process working
 * directory (see getCwdDerivedProtectedPaths(): a relative AUDIT_LOG_PATH).
 * Every workspace that contains the launch directory (`-w .`) contains them,
 * so only the workspace-contains-entry check skips them. If the working
 * directory cannot be determined (it was deleted), nothing is exempt.
 */
function cwdDerivedProtectedEntries(): ReadonlySet<string> {
  try {
    return new Set(getCwdDerivedProtectedPaths().map(canonicalizeBestEffort));
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validates and canonicalizes a workspace path. See the module comment for
 * the rules.
 *
 * @param rawPath - The user-provided path (may be relative, contain ~, etc.)
 * @param protectedPaths - The list of protected paths from config
 * @returns The canonical absolute path. Callers must use this value, not the
 *   raw input, for everything that follows (allowedDirectory, the Docker
 *   mount, persisted snapshots), so the checked path is the path in use.
 * @throws {WorkspaceValidationError} if the path fails any validation check
 */
export function validateWorkspacePath(rawPath: string, protectedPaths: readonly string[]): string {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw new WorkspaceValidationError('WORKSPACE_NOT_FOUND', 'Workspace path must be a non-empty string', '');
  }
  const absolute = resolve(expandTilde(rawPath));
  let canonical: string;
  try {
    canonical = resolveRealPath(absolute);
  } catch {
    throw new WorkspaceValidationError('WORKSPACE_NOT_FOUND', `Workspace path does not exist: ${absolute}`, absolute);
  }

  // Must exist and be a directory
  let isDirectory: boolean;
  try {
    isDirectory = statSync(canonical).isDirectory();
  } catch {
    throw new WorkspaceValidationError('WORKSPACE_NOT_FOUND', `Workspace path does not exist: ${canonical}`, canonical);
  }
  if (!isDirectory) {
    throw new WorkspaceValidationError(
      'WORKSPACE_NOT_DIRECTORY',
      `Workspace path is not a directory: ${canonical}`,
      canonical,
    );
  }

  const unsafe = (message: string): WorkspaceValidationError =>
    new WorkspaceValidationError('WORKSPACE_UNSAFE', message, canonical);

  if (canonical === '/') {
    throw unsafe('Cannot use root directory as workspace');
  }

  const candidate = chainOf(canonical);

  // The user's home directory may contain workspaces but never be one, and
  // no workspace may contain it (`/home`, `/Users`, a parent of a custom
  // $HOME). The agent would otherwise reach shell rc files, ~/.ssh and every
  // credential store under it.
  const userHome = forbiddenRoot(homedir());
  if (isSameEntry(candidate.self, userHome.self)) {
    throw unsafe('Cannot use home directory as workspace');
  }
  if (encloses(candidate.self, userHome)) {
    throw unsafe(`Workspace path contains the home directory: ${canonical}`);
  }

  // Inside the IronCurtain home only the managed workspaces are allowed;
  // everything else there (config, credentials, policies, escalation IPC,
  // other runs) is trusted state.
  const ironCurtainHome = forbiddenRoot(getIronCurtainHome());
  const homeEntryPoint = entryPointInto(candidate, ironCurtainHome);
  const isManagedInternalPath =
    homeEntryPoint !== undefined && isManagedWorkspace(pathBelow(canonical, homeEntryPoint.path));
  if (homeEntryPoint && !isManagedInternalPath) {
    throw unsafe(`Workspace path is inside the IronCurtain home directory: ${canonical}`);
  }

  // The package configuration directory holds the constitution,
  // mcp-servers.json and the compiled policies the running IronCurtain
  // loads, so it may neither contain nor be contained in a workspace.
  const packageConfigDir = forbiddenRoot(getPackageConfigDir());
  if (entryPointInto(candidate, packageConfigDir)) {
    throw unsafe(`Workspace path is inside the IronCurtain package configuration directory: ${canonical}`);
  }

  // The MCP relays' private scratch root (<os.tmpdir()>/ironcurtain-<uid>)
  // holds their srt settings, the sandboxed servers' working directories and
  // an OAuth server's access-token files, and the launchers started there
  // look for configuration above it. A workspace (`-w /tmp`) would expose all
  // of it, so it may neither contain nor lie inside it.
  const scratchRoot = forbiddenRoot(getPrivateScratchRoot());
  if (entryPointInto(candidate, scratchRoot)) {
    throw unsafe(`Workspace path is inside ${SCRATCH_ROOT_DESCRIPTION}: ${canonical}`);
  }

  const enclosedRoots: ReadonlyArray<readonly [string, PathChain]> = [
    ['the IronCurtain home directory', ironCurtainHome],
    ['the IronCurtain user config file', forbiddenRoot(getUserConfigPath())],
    ['the IronCurtain package configuration directory', packageConfigDir],
    [SCRATCH_ROOT_DESCRIPTION, scratchRoot],
  ];
  for (const [description, root] of enclosedRoots) {
    if (encloses(candidate.self, root)) {
      throw unsafe(`Workspace path contains ${description}: ${root.self.path}`);
    }
  }

  // Protected paths, in both directions. A managed workspace lies inside the
  // IronCurtain home by design, so it is exempt from protected entries that
  // enclose the whole home (the home itself, or an ancestor of it), but not
  // from protected entries nested inside the home. An entry that is, or lies
  // below, any symbolic link is also checked where the link leads:
  // the agent must not be able to create that target. Nor may the workspace
  // hold another link on the way there: the agent could replace it, and so
  // choose where the entry leads.
  const cwdDerived = cwdDerivedProtectedEntries();
  for (const protectedPath of protectedPaths) {
    const entry = canonicalizeBestEffort(protectedPath);
    const isCwdDerived = cwdDerived.has(entry);
    const chain = resolvePathLinkChain(protectedPath);
    for (const rootPath of new Set([entry, resolve(expandTilde(protectedPath)), chain.target])) {
      const root = forbiddenCanonicalRoot(rootPath);
      const described =
        rootPath === entry ? rootPath : `${rootPath} (where ${protectedPath} leads through a symbolic link)`;
      const isHomeWideEntry = encloses(root.self, ironCurtainHome);
      if (entryPointInto(candidate, root) && !(isManagedInternalPath && isHomeWideEntry)) {
        throw unsafe(`Workspace path overlaps with protected path: ${described}`);
      }
      if (!isCwdDerived && encloses(candidate.self, root)) {
        throw unsafe(`Workspace path contains protected path: ${described}`);
      }
    }
    // A link is compared by the directory that holds it: whoever controls
    // that directory can replace the link (stat would follow it instead).
    for (const link of isCwdDerived ? [] : chain.links) {
      if (encloses(candidate.self, forbiddenCanonicalRoot(dirname(link)))) {
        throw unsafe(
          `Workspace path contains ${link}, a symbolic link that protected path ${protectedPath} leads through`,
        );
      }
    }
    // A plain directory traversed before `..` still controls resolution if
    // replaced later. These components are validation metadata only, never
    // broad protected entries such as '/' or the user's whole home.
    for (const component of isCwdDerived ? [] : chain.components) {
      if (encloses(candidate.self, forbiddenCanonicalRoot(component))) {
        throw unsafe(`Workspace path contains ${component}, a traversed component of protected path ${protectedPath}`);
      }
    }
  }

  return canonical;
}
