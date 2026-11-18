/**
 * Trusted working directories for the MCP processes IronCurtain spawns.
 *
 * A child process inherits its parent's working directory unless told
 * otherwise, and several launchers and servers read code or
 * configuration from it -- most of them also from every directory above
 * it:
 *
 *   - npx / npm exec: the project root is the nearest ancestor with a
 *     `package.json` or `node_modules` (or a further ancestor whose
 *     `package.json` claims it as a workspace); its `.npmrc` (e.g.
 *     `node-options=--require=<file>`) and the packages in its
 *     `node_modules` are used;
 *   - tsx (source mode): the nearest `tsconfig.json` at or above the cwd,
 *     whose `paths` can redirect any import of the process it compiles;
 *   - git: the nearest repository at or above the directory it runs in;
 *   - dotenv: `.env` (git-mcp-server loads it at startup);
 *   - servers that resolve relative tool arguments against
 *     `process.cwd()` (git-mcp-server), while the policy engine resolves
 *     the same relative path against the allowed directory.
 *
 * The directory a user starts IronCurtain from can be agent-writable
 * (`cd project && ironcurtain start -w .`) or an untrusted checkout, so
 * no MCP relay or backend may inherit it. Every spawn names a trusted
 * directory instead:
 *
 *   - {@link getTrustedSpawnCwd}: IronCurtain's own package root. Used for
 *     everything `MCPClientManager` spawns (the session relays; the
 *     in-process `TrustedProcess` test harness), the pipeline's
 *     list-resolution relay, and unsandboxed spawns that only list tools
 *     (annotate-tools, compile-policy, `mcp add` and doctor through
 *     tool-listing-launch.ts; developer discovery uses that same launcher); a server those
 *     tool listings run under srt gets a private directory next to its
 *     srt settings, as with its relay. It is part of the installation, and
 *     under tsx it makes the project's own `tsconfig.json` the one that
 *     applies.
 *   - {@link createServerCwd}: a private, empty per-server directory for
 *     every backend MCP server the relay spawns, so relative tool paths
 *     and cwd-based lookups start in a directory nobody else controls.
 *     Because the lookups above walk up, the directories ABOVE it must be
 *     trusted too. Backends that run without srt (`"sandbox": false`, or
 *     the fallback when srt is unavailable under `"warn"`) therefore get
 *     theirs inside {@link createPrivateRunDir}, under the IronCurtain
 *     home -- never below `os.tmpdir()`, which on Linux is usually the
 *     world-writable `/tmp`, where any local user (or an agent whose
 *     workspace is `/tmp`) could plant a `package.json`, `.npmrc`,
 *     `node_modules` or `tsconfig.json` for them. srt-sandboxed backends
 *     keep theirs next to their srt settings in the relay's scratch
 *     directory (and listed in srt's `allowWrite` and `allowRead`);
 *     whatever they could pick up from `/tmp` runs inside srt.
 *   - {@link ensurePrivateScratchRoot}: the relays' scratch directories
 *     (srt settings, the sandboxed backends' working directories, an OAuth
 *     server's credential files) all live under one per-user directory
 *     below `os.tmpdir()`, created mode 0700 and checked to be owned by
 *     this user. Other users cannot enter it, and every sandboxed server
 *     has it in `denyRead` (sandbox-integration.ts) with only its own
 *     working directory and credential directory re-exposed, so no
 *     sandboxed server reads another server's or another session's files.
 *   - {@link gitCeilingDirectories}: every backend also gets a
 *     `GIT_CEILING_DIRECTORIES` entry for the directory holding its
 *     private directory, so git never adopts a repository above it (for
 *     example `~/.git` or a versioned `~/.ironcurtain`).
 *
 * Leaf module: Node built-ins only.
 */

import { lstatSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * IronCurtain's package root: two levels above this module, i.e. the
 * repository root in source mode (`src/trusted-process/`) and the
 * installed package directory in compiled mode (`dist/trusted-process/`).
 */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Returns the working directory for IronCurtain's own subprocesses (the
 * MCP relays) and for one-shot server spawns that only list tools.
 * Backends that serve tool calls through a relay use
 * {@link createServerCwd} instead.
 *
 * Always an absolute path that does not depend on `process.cwd()`.
 */
export function getTrustedSpawnCwd(): string {
  return PACKAGE_ROOT;
}

/**
 * Throws unless `serverName` is usable as a single path segment. Server
 * names become file names inside the relay's scratch directory, so a
 * name containing a separator or a dot segment could point outside it.
 */
function assertSafeServerName(serverName: string): void {
  if (
    serverName === '' ||
    serverName === '.' ||
    serverName === '..' ||
    serverName.includes('/') ||
    serverName.includes('\\') ||
    serverName.includes('\0')
  ) {
    throw new Error(`Invalid MCP server name for a working directory: ${JSON.stringify(serverName)}`);
  }
}

/**
 * Creates a fresh, private (mode 0700) directory
 * `<ironCurtainHome>/run/mcp-cwd/relay-XXXXXX` for the working
 * directories of the backends one relay runs without srt. The relay
 * removes it on shutdown.
 *
 * Every directory above it is the user's own: the IronCurtain home (a
 * protected path for the policy engine; the only agent-writable places
 * inside it, the managed session, persona, job and workflow-run
 * workspaces that session/workspace-validation.ts admits, are never
 * ancestors of this one) and the directories above that. Nothing a
 * launcher finds by walking up from a backend's cwd can be planted by
 * another user or by the agent. `ironCurtainHome` must be absolute.
 */
export function createPrivateRunDir(ironCurtainHome: string): string {
  if (!isAbsolute(ironCurtainHome)) {
    throw new Error(`IronCurtain home must be an absolute path: ${JSON.stringify(ironCurtainHome)}`);
  }
  const root = join(ironCurtainHome, 'run', 'mcp-cwd');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return mkdtempSync(join(root, 'relay-'));
}

/**
 * The per-user parent of every relay's scratch directory:
 * `<os.tmpdir()>/ironcurtain-<uid>` (the user name where there is no
 * numeric uid). A pure path; {@link ensurePrivateScratchRoot} creates and
 * checks it.
 *
 * Sandboxed servers have it in their srt `denyRead` baseline
 * (sandbox-integration.ts), so the credential files and working
 * directories of other relays stay hidden from them whatever a shared
 * `/tmp` would otherwise show.
 */
export function getPrivateScratchRoot(): string {
  const uid = process.getuid?.();
  const owner = uid === undefined ? userInfo().username.replace(/[^A-Za-z0-9_.-]/g, '_') : String(uid);
  return join(tmpdir(), `ironcurtain-${owner}`);
}

/**
 * Creates {@link getPrivateScratchRoot} with mode 0700 if it does not exist
 * and returns it once it is known to be a directory this user owns that no
 * other user can enter. A shared `os.tmpdir()` (the sticky `/tmp`) lets any
 * local user pre-create or symlink that name, so an entry that is not a
 * directory, belongs to another uid or carries group/other permission bits
 * is refused rather than used (fail closed; the message names the path and
 * the remedy). Where processes have no uid (Windows) only the type check
 * applies.
 */
export function ensurePrivateScratchRoot(): string {
  const root = getPrivateScratchRoot();
  if (!isAbsolute(root)) {
    throw new Error(`The temporary directory must be an absolute path, got ${JSON.stringify(tmpdir())}`);
  }
  try {
    mkdirSync(root, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  // lstat: a symlink planted at this name must not be followed to wherever
  // it points.
  const stats = lstatSync(root);
  if (!stats.isDirectory()) {
    throw new Error(
      `Refusing to use ${root} for MCP server scratch files: it exists but is not a directory. ` +
        'Remove it, or point TMPDIR at a private directory.',
    );
  }
  const uid = process.getuid?.();
  if (uid !== undefined) {
    if (stats.uid !== uid) {
      throw new Error(
        `Refusing to use ${root} for MCP server scratch files: it is owned by uid ${stats.uid}, ` +
          `not the current user (uid ${uid}). Remove it, or point TMPDIR at a private directory.`,
      );
    }
    const mode = stats.mode & 0o777;
    if ((mode & 0o077) !== 0) {
      throw new Error(
        `Refusing to use ${root} for MCP server scratch files: mode 0${mode.toString(8)} lets other users ` +
          `enter it. Run: chmod 700 ${root}`,
      );
    }
  }
  return root;
}

/**
 * Creates (if needed) and returns the private working directory
 * `<parentDir>/<serverName>.cwd` for one backend MCP server.
 *
 * `parentDir` must be a directory only this user can enter. For a
 * backend that runs without srt every directory above it must be trusted
 * too (see the module comment), so the relay passes a
 * {@link createPrivateRunDir} directory; sandboxed backends get theirs in
 * the relay's `mkdtemp` srt settings directory under
 * {@link ensurePrivateScratchRoot}, where anything they could pick up
 * from above runs inside srt. The directory is created with mode 0700
 * and starts empty: no
 * `node_modules`, `.npmrc`, `tsconfig.json` or `.env` for the server's
 * launcher to pick up. Sandboxed servers also get it added to srt's
 * `allowWrite` (which keeps bwrap's ghost dotfiles out of the session
 * sandbox) and `allowRead` (macOS re-allows reads inside a denied region
 * only through `allowRead`).
 */
export function createServerCwd(parentDir: string, serverName: string): string {
  assertSafeServerName(serverName);
  const cwdPath = join(parentDir, `${serverName}.cwd`);
  mkdirSync(cwdPath, { recursive: true, mode: 0o700 });
  return cwdPath;
}

/**
 * Returns the `GIT_CEILING_DIRECTORIES` value for a backend whose working
 * directory is `serverCwd` (from {@link createServerCwd}): the directory
 * holding it, ahead of any `inherited` entries.
 *
 * git then reports a cwd-relative path -- which the policy engine
 * resolved against the allowed directory, not against this cwd -- as
 * "not a git repository" instead of walking up out of the private
 * directory into a repository above it. Inherited entries are merged the
 * way `hardenedGitEnv` (security/git-hardening.ts) merges them: empty
 * entries dropped, duplicates removed.
 */
export function gitCeilingDirectories(serverCwd: string, inherited?: string): string {
  const ceiling = dirname(serverCwd);
  if (!isAbsolute(ceiling) || ceiling.includes(delimiter) || ceiling.includes('\0')) {
    throw new Error(`Git ceiling directory must be absolute and contain no '${delimiter}': ${ceiling}`);
  }
  const inheritedEntries = (inherited ?? '').split(delimiter).filter((entry) => entry !== '');
  return [...new Set([ceiling, ...inheritedEntries])].join(delimiter);
}
