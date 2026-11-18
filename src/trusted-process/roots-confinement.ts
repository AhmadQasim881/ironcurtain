/**
 * Roots confinement (security-critical): OS-level confinement of an MCP
 * server to its MCP roots, for servers whose config sets
 * `sandbox.filesystem.confineToRoots` (the filesystem server).
 *
 * Why. `@modelcontextprotocol/server-filesystem` validates a path (realpath,
 * then a containment check against its allowed directories) and then
 * reopens the validated string by name. Every component but the last is
 * re-traversed at use time. An agent that can rename entries of the
 * workspace concurrently (Docker mode: the workspace is bind-mounted
 * read-write and the agent has a shell) can swap a directory for a symlink
 * between the check and the use and make the server read, write or create
 * anything the host user can. No IronCurtain-side re-check closes that
 * window: whatever runs before the server's open, a blind swapper still
 * wins some of the time.
 *
 * What. The server runs under srt (bubblewrap on Linux, Seatbelt on macOS)
 * with a profile derived from its roots:
 *
 * - hidden: the read-containment baseline (IronCurtain home, credential
 *   stores) plus the user's home, the temporary directories and the
 *   per-user runtime directory (`confinementHiddenRegions` in
 *   sandbox-integration.ts, applied by `resolveSandboxConfig`);
 * - exposed, readable and writable: the session sandbox and the server's
 *   current roots ({@link confinedRootDirectories}), except roots that lie
 *   in or contain the IronCurtain home, a credential store or a hidden
 *   region ({@link rootExposureRefusal}); the coordinator refuses
 *   approvals that would need one ({@link RULE_ROOT_NOT_EXPOSABLE});
 * - exposed, read-only: what it needs to run its program
 *   ({@link resolveConfinedLaunch}).
 *
 * The kernel enforces the profile on every open, so a swapped-in symlink
 * that leads out of the roots names a path that is not there (bubblewrap
 * mount view) or not permitted (Seatbelt). Writes outside the roots fail
 * everywhere, because srt's write model is an allow-list.
 *
 * Roots change at runtime (approved escalations add roots), and neither
 * bubblewrap nor Seatbelt can widen a running process's profile. The relay
 * therefore restarts the server with a new profile when the set of
 * directories its roots expose changes ({@link ConfinedBackendSupervisor}).
 *
 * Residual risk: the confinement is per root set. A swap can still redirect
 * a call from one root to another (for example from the workspace into
 * `~/Downloads`, or into a directory the policy lets the agent read but not
 * write without approval). Files outside the hidden regions that the host
 * user can read (system files, other mounts) stay readable, and srt's own
 * scratch directory `/tmp/claude` stays writable for every sandboxed
 * server; nothing else outside the roots is writable.
 */

import { accessSync, constants as fsConstants, lstatSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { ClientState, McpRoot } from './mcp-client-manager.js';
import { pathForRootUri } from './policy-roots.js';
import {
  baselineDenyRead,
  confinementHiddenRegions,
  sandboxRuntimePackageDir,
  type ResolvedSandboxParams,
} from './sandbox-integration.js';

// ---------------------------------------------------------------------------
// Roots
// ---------------------------------------------------------------------------

/** Rule stamped on an approved call whose new root a confined server cannot be given. */
export const RULE_ROOT_NOT_EXPOSABLE = 'root-not-exposable';

/**
 * Why `directory` can never be exposed to a confined server as a root, or
 * `undefined` when it can. Refused are directories that:
 *
 * - lie in the IronCurtain home or a credential store: the read-containment
 *   baseline holds for every sandboxed server, whatever the roots say;
 * - contain the IronCurtain home or a credential store: srt cannot express
 *   "writable, except that part" on macOS, where a read deny inside a write
 *   root does not stop writes and a deny nested in an allowed directory
 *   also hides what is allowed beneath it (the session sandbox under the
 *   IronCurtain home);
 * - contain or are a hidden region (the home directory, a temporary
 *   directory, the runtime directory), which would undo the confinement;
 * - are spelled with `*`, `?`, `[` or `]`: srt reads every allow entry as a
 *   pattern, so `~/Music/Album [Live]` would expose `~/Music/Album L` and
 *   its other matching siblings (readable on Linux, readable and writable
 *   on macOS) and not the directory itself.
 *
 * The rule is the same on every platform. A directory below a hidden region
 * that contains none of the above (`~/Downloads`, `~/projects/x`) is fine.
 */
export function rootExposureRefusal(directory: string): string | undefined {
  const forms = pathForms(directory);
  if (forms.some(isGlob)) {
    return 'its path contains *, ?, [ or ], which the OS sandbox would read as a pattern';
  }
  const baseline = baselineDenyRead();
  if (baseline.some((entry) => forms.some((form) => isAtOrUnderDenyEntry(form, entry)))) {
    return 'it is in the IronCurtain home or a credential store';
  }
  if (baseline.some((entry) => forms.some((form) => denyEntryReachesInto(entry, form)))) {
    return 'it contains the IronCurtain home or a credential store';
  }
  const hidden = confinementHiddenRegions().flatMap(pathForms);
  if (hidden.some((region) => forms.some((form) => isAtOrUnder(region, form)))) {
    return 'it contains the home directory, a temporary directory or the runtime directory';
  }
  return undefined;
}

/**
 * The directories a confined server's profile exposes for its MCP roots:
 * every root that is an existing directory named by its canonical path
 * (no symlink in any component), sorted and de-duplicated. Dropped:
 *
 * - roots that are not well-formed absolute `file:` URIs, do not exist, are
 *   not directories, or no longer resolve to themselves;
 * - roots at or under the session sandbox: the profile exposes the sandbox
 *   already, and a separate entry for a directory the agent can rename
 *   would let it redirect what srt binds there when the server restarts;
 * - roots {@link rootExposureRefusal} refuses.
 *
 * A dropped root is not visible to the server; the coordinator refuses
 * approvals that would need one ({@link RULE_ROOT_NOT_EXPOSABLE}).
 */
export function confinedRootDirectories(roots: readonly McpRoot[], sessionSandboxDir: string): string[] {
  const sandboxForms = pathForms(sessionSandboxDir);
  const directories = new Set<string>();
  for (const root of roots) {
    const path = pathForRootUri(root.uri);
    if (path === undefined || !isAbsolute(path)) continue;
    const directory = resolve(path);
    if (!isCanonicalDirectory(directory)) continue;
    if (sandboxForms.some((sandbox) => isAtOrUnder(directory, sandbox))) continue;
    if (rootExposureRefusal(directory) !== undefined) continue;
    directories.add(directory);
  }
  return [...directories].sort();
}

/** True when two directory lists name the same set (both from {@link confinedRootDirectories}). */
export function sameDirectorySet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((entry) => right.has(entry));
}

/**
 * The srt parameters of a confined server for one launch: its resolved
 * parameters (whose `denyRead` already hides the confinement regions) plus
 * `rootDirectories` in `allowRead` and `allowWrite` and `readPaths` (its
 * program, see {@link resolveConfinedLaunch}) in `allowRead`.
 *
 * Read paths are filtered with {@link isSafeReadPath}; root directories are
 * expected to come from {@link confinedRootDirectories}.
 */
export function confinedSandboxParams(
  params: ResolvedSandboxParams,
  rootDirectories: readonly string[],
  readPaths: readonly string[],
): ResolvedSandboxParams {
  const safeReadPaths = readPaths.filter((path) => isSafeReadPath(path));
  return {
    ...params,
    allowRead: unique([...params.allowRead, ...rootDirectories, ...safeReadPaths]),
    allowWrite: unique([...params.allowWrite, ...rootDirectories]),
  };
}

/**
 * True when re-exposing `path` read-only for a confined server's program is
 * acceptable: an absolute directory that is not a hidden region itself or
 * an ancestor of one (that would re-open all of it), not a per-user data
 * directory or an ancestor of one ({@link userDataDirectories}), not at or
 * under a baseline entry, and not spelled with a glob character (srt would
 * read it as a pattern). A program whose files cannot be exposed this way
 * does not start (fail closed).
 */
export function isSafeReadPath(path: string): boolean {
  if (!isAbsolute(path) || path === sep) return false;
  const normalized = resolve(path);
  if (pathForms(normalized).some(isGlob)) return false;
  const covered = [...confinementHiddenRegions(), ...userDataDirectories()].flatMap(pathForms);
  if (covered.some((region) => isAtOrUnder(region, normalized))) return false;
  return !baselineDenyRead().some((entry) => isAtOrUnderDenyEntry(normalized, entry));
}

/**
 * Per-user directories that hold other applications' data, configuration,
 * state and caches: keyrings, mail, shell histories, tokens. A program never
 * needs one of them, or a directory holding one, re-exposed to run, so
 * {@link isSafeReadPath} refuses both. Without this, a Node.js unpacked into
 * `~/.local` (its prefix for `~/.local/bin/node`) would re-expose all of
 * `~/.local/share` and `~/.local/state`. Directories beneath them
 * (`~/.local/share/fnm/...`, `~/.config/nvm`) can still be exposed.
 *
 * The XDG base directories as set in `env` and their defaults, and macOS's
 * `~/Library`. Absolute and normalized.
 */
function userDataDirectories(env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  const home = homedir();
  const directories = [
    join(home, '.local', 'share'),
    join(home, '.local', 'state'),
    join(home, '.config'),
    join(home, '.cache'),
    join(home, 'Library'),
  ];
  for (const name of ['XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) {
    const value = env[name];
    if (value !== undefined && isAbsolute(value)) directories.push(value);
  }
  return unique(directories.map((directory) => resolve(directory))).filter((directory) => directory !== sep);
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

/** How a confined server is launched, from {@link resolveConfinedLaunch}. */
export interface ConfinedLaunch {
  /**
   * The program: the canonical path of the command when it could be found;
   * for `node`, the Node.js binary the relay itself runs on.
   */
  readonly command: string;
  /** The arguments, with every absolute path that exists in its canonical form. */
  readonly args: readonly string[];
  /**
   * Directories the program needs to read: the installation of the command
   * (for `<prefix>/bin/node`, `<prefix>`, or only `<prefix>/bin` when the
   * prefix is not a {@link isSafeReadPath safe read path}), every
   * `node_modules` directory above a path argument (the package and the
   * dependencies it resolves) or else that argument's directory,
   * sandbox-runtime's own package (srt runs its `apply-seccomp` helper
   * inside the sandbox on Linux) and the directory of the shell srt runs
   * the command with.
   */
  readonly readPaths: readonly string[];
  /**
   * `PATH` for the srt process when the shell it would find is a symlink
   * leading out of a hidden region (a single-user Nix profile in the home
   * directory): the shell's real directory first, so srt runs a shell the
   * sandbox can see. `undefined` when `PATH` needs no change.
   */
  readonly pathEnv?: string;
}

/** The shell srt runs commands with (sandbox-runtime's default `binShell`). */
const SRT_SHELL = 'bash';

/**
 * Resolves how to launch a confined server so that its program is reachable
 * inside a profile that hides the home, temporary and runtime directories:
 * the command is looked up on `PATH` here, not by the shell inside the
 * sandbox, and every path is canonical, so a symlink in a hidden region
 * (`~/.local/bin/node -> /opt/node/bin/node`, a `node_modules` symlink into
 * another checkout) cannot leave the program unreachable. Pure apart from
 * filesystem lookups; never throws.
 *
 * `node` is not looked up at all: it runs as `nodeExecutable`, the Node.js
 * binary the relay itself runs on (`process.execPath`, always the real
 * binary). The `node` a version manager puts on `PATH` is often a shim that
 * cannot run confined: Volta's and mise's link `node` to one dispatcher
 * that picks the tool from the name it was started as (its canonical path
 * names the dispatcher), and asdf's and nodenv's are scripts that read
 * version files in the hidden home directory.
 */
export function resolveConfinedLaunch(
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
  nodeExecutable: string = process.execPath,
): ConfinedLaunch {
  const pathEnv = env.PATH ?? '';
  const readPaths: string[] = [];

  const program = command === 'node' ? findExecutable(nodeExecutable, '') : findExecutable(command, pathEnv);
  const canonicalProgram = program === undefined ? undefined : canonicalPath(program);
  if (canonicalProgram !== undefined) readPaths.push(installationDirectory(canonicalProgram));

  const canonicalArgs = args.map((arg) => {
    if (!isAbsolute(arg)) return arg;
    const canonical = canonicalPath(arg);
    if (canonical === undefined) return arg;
    if (isFile(canonical)) readPaths.push(...packageDirectories(canonical));
    return canonical;
  });

  const srtPackage = sandboxRuntimePackageDir();
  if (srtPackage !== undefined) readPaths.push(srtPackage);

  let launchPathEnv: string | undefined;
  const shell = findExecutable(SRT_SHELL, pathEnv);
  const canonicalShell = shell === undefined ? undefined : canonicalPath(shell);
  if (shell !== undefined && canonicalShell !== undefined) {
    readPaths.push(dirname(canonicalShell));
    if (canonicalShell !== shell && isInHiddenRegion(shell)) {
      launchPathEnv = [dirname(canonicalShell), pathEnv].filter((part) => part !== '').join(delimiter);
    }
  }

  return {
    command: canonicalProgram ?? command,
    args: canonicalArgs,
    readPaths: unique(readPaths),
    ...(launchPathEnv !== undefined ? { pathEnv: launchPathEnv } : {}),
  };
}

/**
 * The directory holding an installed program: `<prefix>` for
 * `<prefix>/bin/<name>`, otherwise the program's own directory. When the
 * prefix is not a {@link isSafeReadPath safe read path} (`~` for a program
 * in `~/bin`, `~/.local` for one in `~/.local/bin`, whose prefix also holds
 * every application's data), only the program's directory.
 */
function installationDirectory(program: string): string {
  const binDir = dirname(program);
  if (basename(binDir) !== 'bin') return binDir;
  const prefix = dirname(binDir);
  return isSafeReadPath(prefix) ? prefix : binDir;
}

/**
 * The directories a script needs: every `node_modules` directory above it,
 * innermost first (Node resolves dependencies by walking up through them),
 * or the script's own directory when there is none.
 */
function packageDirectories(script: string): string[] {
  const found: string[] = [];
  for (let dir = dirname(script); ; dir = dirname(dir)) {
    if (basename(dir) === 'node_modules') found.push(dir);
    if (dirname(dir) === dir) break;
  }
  return found.length > 0 ? found : [dirname(script)];
}

/** `command` as found on `pathEnv` (or the absolute path it already is), when it is an executable file. */
function findExecutable(command: string, pathEnv: string): string | undefined {
  if (command === '') return undefined;
  if (isAbsolute(command)) return isExecutableFile(command) ? command : undefined;
  if (command.includes('/')) return undefined;
  for (const dir of pathEnv.split(delimiter)) {
    // Relative entries would resolve against srt's private working
    // directory, where nothing is installed.
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, command);
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** True when `path` lies in one of the confinement's hidden regions (either spelling). */
function isInHiddenRegion(path: string): boolean {
  const hidden = confinementHiddenRegions().flatMap(pathForms);
  return hidden.some((region) => isAtOrUnder(resolve(path), region));
}

// ---------------------------------------------------------------------------
// Restarts
// ---------------------------------------------------------------------------

/** Starts and stops one confined backend for {@link ConfinedBackendSupervisor}. */
export interface ConfinedBackendLauncher {
  /**
   * Starts the server under a profile exposing `rootDirectories` and returns
   * a connected client for it. Rejects when the server cannot be started.
   */
  launch(serverName: string, rootDirectories: readonly string[]): Promise<ClientState>;
  /**
   * Closes a client and so the srt process and server behind it, after the
   * calls it is still serving have finished (within a bound). Never rejects.
   */
  close(state: ClientState): Promise<void>;
}

/** Outcome of {@link ConfinedBackendSupervisor.applyRoots} for one backend. */
export type ConfinedRootsOutcome =
  /** The exposed directories did not change; the running server was told to re-read its roots. */
  | 'notified'
  /** The server was restarted under a profile for the new roots. */
  | 'restarted'
  /** The restart failed; the server was stopped and its tools now fail. */
  | 'stopped';

/**
 * Keeps each confined backend's OS profile in step with its roots.
 *
 * The relay registers every confined backend it started, with the root
 * directories its profile exposes. When the roots change it calls
 * {@link applyRoots}: a backend whose exposed directories differ is
 * restarted (new srt profile, new server, new client); the relay's client
 * map then points at the new client and the old one is closed. A backend
 * whose restart fails is stopped, never left running under a profile that
 * no longer matches what was approved: its entry is removed from the client
 * map, so calls to it fail, and the coordinator's roots verification fails
 * and drops the connection.
 *
 * Restarts of one backend are serialized; each uses the newest root set.
 * Tool calls wait for a restart in progress ({@link settled}) so they reach
 * the server whose profile matches the roots.
 */
export class ConfinedBackendSupervisor {
  private readonly exposed = new Map<string, readonly string[]>();
  private readonly pending = new Map<string, Promise<ConfinedRootsOutcome>>();
  private closed = false;

  constructor(
    private readonly clientStates: Map<string, ClientState>,
    private readonly launcher: ConfinedBackendLauncher,
    private readonly log: (message: string) => void = () => {},
  ) {}

  /** Records a backend the relay started with a profile exposing `rootDirectories`. */
  register(serverName: string, rootDirectories: readonly string[]): void {
    this.exposed.set(serverName, [...rootDirectories]);
  }

  /** True when `serverName` is a confined backend this supervisor manages. */
  manages(serverName: string): boolean {
    return this.exposed.has(serverName);
  }

  /** The root directories the running backend's profile exposes, if it is managed. */
  exposedRoots(serverName: string): readonly string[] | undefined {
    return this.exposed.get(serverName);
  }

  /**
   * Brings `serverName`'s profile in line with `rootDirectories` (from
   * {@link confinedRootDirectories}): restarts it when they differ from the
   * exposed ones, otherwise sends it `notifications/roots/list_changed` so
   * it re-reads its roots as an unconfined server would.
   */
  applyRoots(serverName: string, rootDirectories: readonly string[]): Promise<ConfinedRootsOutcome> {
    const previous = this.pending.get(serverName) ?? Promise.resolve();
    const next = previous.then(() => this.apply(serverName, rootDirectories));
    this.pending.set(serverName, next);
    void next.then(() => {
      if (this.pending.get(serverName) === next) this.pending.delete(serverName);
    });
    return next;
  }

  /** Resolves once no restart of `serverName` is in progress. Never rejects. */
  async settled(serverName: string): Promise<void> {
    for (;;) {
      const pending = this.pending.get(serverName);
      if (pending === undefined) return;
      await pending;
    }
  }

  /** Stops restarting: a launch that completes afterwards is closed at once. */
  close(): void {
    this.closed = true;
  }

  /** Read through a method: {@link close} can run while a launch is awaited. */
  private isClosed(): boolean {
    return this.closed;
  }

  /** {@link applyRoots} for one root set. Never rejects: an unexpected error stops the backend. */
  private async apply(serverName: string, rootDirectories: readonly string[]): Promise<ConfinedRootsOutcome> {
    try {
      return await this.applyUnguarded(serverName, rootDirectories);
    } catch (err) {
      this.log(`applying roots to "${serverName}" failed, stopping it: ${errorText(err)}`);
      const current = this.clientStates.get(serverName);
      this.exposed.delete(serverName);
      this.clientStates.delete(serverName);
      if (current !== undefined) await this.launcher.close(current).catch(() => undefined);
      return 'stopped';
    }
  }

  private async applyUnguarded(serverName: string, rootDirectories: readonly string[]): Promise<ConfinedRootsOutcome> {
    const current = this.clientStates.get(serverName);
    const exposed = this.exposed.get(serverName);
    if (current === undefined || exposed === undefined || this.closed) return 'stopped';

    if (sameDirectorySet(exposed, rootDirectories)) {
      try {
        await current.client.sendRootsListChanged();
      } catch (err) {
        this.log(`sendRootsListChanged to "${serverName}" failed: ${errorText(err)}`);
      }
      return 'notified';
    }

    this.log(`restarting "${serverName}" with a profile for ${rootDirectories.length} root director(ies)`);
    let replacement: ClientState;
    try {
      replacement = await this.launcher.launch(serverName, rootDirectories);
    } catch (err) {
      this.log(`restart of "${serverName}" failed, stopping it: ${errorText(err)}`);
      this.exposed.delete(serverName);
      if (this.clientStates.get(serverName) === current) this.clientStates.delete(serverName);
      await this.launcher.close(current);
      return 'stopped';
    }

    if (this.isClosed() || this.clientStates.get(serverName) !== current) {
      // Shut down (or stopped) while the new server was starting.
      await this.launcher.close(replacement);
      return 'stopped';
    }
    this.clientStates.set(serverName, replacement);
    this.exposed.set(serverName, [...rootDirectories]);
    // New calls already reach the new server. The old one is closed in the
    // background, so a call it is still serving can finish first (the
    // launcher's close waits for those).
    void this.launcher.close(current);
    return 'restarted';
  }
}

/**
 * How long a backend replaced by a restart may keep serving the calls it
 * already has before it is closed anyway (they then fail).
 */
export const REPLACED_BACKEND_DRAIN_MS = 60_000;

/**
 * Calls in flight per backend client, so that a backend replaced by a
 * restart is closed only after the calls it is still serving have finished
 * (a roots-verification poll answered by the old server must not fail
 * because the new one took over).
 */
export class InFlightCalls {
  private readonly calls = new Map<ClientState, Set<Promise<unknown>>>();

  /** Registers `call` as served by `state` until it settles, and returns it. */
  track<T>(state: ClientState, call: Promise<T>): Promise<T> {
    const calls = this.calls.get(state) ?? new Set<Promise<unknown>>();
    this.calls.set(state, calls);
    calls.add(call);
    const settle = (): void => {
      calls.delete(call);
      if (calls.size === 0 && this.calls.get(state) === calls) this.calls.delete(state);
    };
    call.then(settle, settle);
    return call;
  }

  /** Number of calls `state` is serving. */
  count(state: ClientState): number {
    return this.calls.get(state)?.size ?? 0;
  }

  /** Resolves once every call `state` is serving has settled, or after `timeoutMs`. Never rejects. */
  async drain(state: ClientState, timeoutMs: number = REPLACED_BACKEND_DRAIN_MS): Promise<void> {
    const calls = this.calls.get(state);
    if (calls === undefined || calls.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<void>((resolveTimeout) => {
      timer = setTimeout(resolveTimeout, timeoutMs);
      timer.unref();
    });
    await Promise.race([Promise.allSettled([...calls]).then(() => undefined), timedOut]);
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * True when `path` is an existing directory and its own canonical path:
 * no component is a symlink, so what srt binds for it is what was checked.
 * Roots are canonicalized when they are created; one that no longer
 * resolves to itself is dropped rather than followed.
 */
function isCanonicalDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory() && canonicalPath(path) === path;
  } catch {
    return false;
  }
}

/**
 * The canonical path (native realpath on macOS, which also normalizes letter
 * case and Unicode form the way the server's own realpath does), or
 * `undefined` when `path` does not resolve.
 */
function canonicalPath(path: string): string | undefined {
  try {
    return process.platform === 'darwin' ? realpathSync.native(path) : realpathSync(path);
  } catch {
    return undefined;
  }
}

/** A path's normalized spelling and, when it resolves, its canonical one. */
function pathForms(path: string): string[] {
  const absolute = resolve(path);
  const canonical = canonicalPath(absolute);
  return canonical === undefined || canonical === absolute ? [absolute] : [absolute, canonical];
}

/** True when `child` is `parent` or lies beneath it (both absolute and normalized). */
function isAtOrUnder(child: string, parent: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** True for a deny entry spelled as a glob. */
function isGlob(entry: string): boolean {
  return /[*?[\]]/.test(entry);
}

/** The directory every match of a glob lies beneath (its static prefix). */
function globBase(entry: string): string {
  const firstGlob = entry.search(/[*?[\]]/);
  return entry.slice(0, entry.lastIndexOf(sep, firstGlob)) || sep;
}

/**
 * True when part of what a deny entry covers lies strictly inside
 * `directory`: a literal entry beneath it, or a glob whose matches can lie
 * beneath it.
 */
function denyEntryReachesInto(entry: string, directory: string): boolean {
  if (!isGlob(entry)) return entry !== directory && isAtOrUnder(entry, directory);
  return isAtOrUnder(globBase(entry), directory);
}

/**
 * True when `path` is at or under what a deny entry covers: the entry
 * itself for a literal, a match of the pattern for a glob (`*` and `?`
 * within one path segment). A glob with other metacharacters is treated as
 * covering its whole static base directory, which only ever drops more.
 */
function isAtOrUnderDenyEntry(path: string, entry: string): boolean {
  if (!isGlob(entry)) return isAtOrUnder(path, entry);
  const base = globBase(entry);
  if (/[[\]]/.test(entry)) return isAtOrUnder(path, base);
  const pattern = entry
    .split('')
    .map((char) => (char === '*' ? '[^/]*' : char === '?' ? '[^/]' : char.replace(/[.+^${}()|\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${pattern}(?:/.*)?$`).test(path);
}

function unique(items: readonly string[]): string[] {
  return [...new Set(items)];
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
